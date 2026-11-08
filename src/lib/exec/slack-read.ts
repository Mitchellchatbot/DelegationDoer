import "server-only";

import { SecretUnavailableError } from "@/lib/exec/crypto";
import { getDdBotIdentity } from "@/lib/exec/dd-bot";
import { enqueueJob } from "@/lib/exec/jobs";
import { loadSettings } from "@/lib/exec/principal";
import { leadSlugsFrom, type ClassifierContext } from "@/lib/exec/slack-classes";
import { ddOutboundChannelId } from "@/lib/exec/slack-config";
import { sweepVerdict, type SweepVerdict } from "@/lib/exec/slack-ingest";
import { clearUserTokenError, enqueueUserCheck, openReadingInstallation, recordUserTokenError } from "@/lib/exec/slack-install";
import { noteSlackRateLimited, SlackRateBudgetError, takeSlackBudget } from "@/lib/exec/slack-rate";
import { markDeleted, noteFromHim, noteMessages, setAcknowledged } from "@/lib/exec/slack-read-store";
import { SLACK_READ_JOB_KINDS, SLACK_READ_LIMITS } from "@/lib/exec/slack-read-types";
import type {
  ChannelRow,
  ConvType,
  FromHimRow,
  MeteredMethod,
  NoteRow,
  RateClass,
  ReadingInstallation
} from "@/lib/exec/slack-read-types";
import { getClientEmailChannelId, listClients, listDdBotDmChannelIds, listFbLeadChannels } from "@/lib/exec/sources/dd";
import { SlackApiError, type SlackReadMessage } from "@/lib/exec/sources/slack";
import { NonRetryableError, type EnqueueJobInput, type ExecPrincipal, type JobLane } from "@/lib/exec/types";

// P7a job glue (P7a contract §3.11.0; Area D; server-only): opening the
// reader, paced reads through the limiter, the user-token auth handling (P6's
// recordSlackError + enqueueRevokeCheck pattern, mirrored), the classifier
// context and the sweep / attention enqueues. The opened ReadTarget is never
// spread, stringified or put in an object literal outside this file
// (B-P7a-7): callers hand `ri.target` straight to a sources/slack.ts read.
//
//   * Every metered Slack read goes through paced(): the limiter first (a
//     refusal throws SlackRateBudgetError, a store error throws; no
//     unmetered call), then the read. A `ratelimited` answer blocks the
//     method for every P7a class; an auth-class answer records the user
//     half's health and, for the four dead-token codes, enqueues the user
//     check (C25). The first success after a recorded error clears it.
//   * noteWindow() is the one place a fetched window becomes rows: the
//     sweep and the classify catch-up both call it, so both apply the same
//     sweepVerdict, the same tombstone rule (C16) and the same order (marks,
//     candidates and anchors, then his messages, then his reactions).
//   * Logs carry ids, ts values, counts and codes only (§0.3 rule 4).

/** C25: the auth codes that mean the user token itself is dead (the user check confirms with auth.test). */
const DEAD_TOKEN_CODES: ReadonlySet<string> = new Set(["invalid_auth", "token_revoked", "account_inactive", "not_authed"]);
/** A ratelimited answer that carries no Retry-After blocks the method this long. */
const DEFAULT_RETRY_AFTER_MS = 30_000;
const MIN_MS = 60_000;

/** Reading halves whose recorded error this process already cleared (a job clears at most once per opened object). */
const cleared = new WeakSet<ReadingInstallation>();

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A SlackApiError from this module copy or another (duck-typed on its frozen shape). */
export function slackErrorOf(err: unknown): SlackApiError | null {
  if (err instanceof SlackApiError) return err;
  if (typeof err !== "object" || err === null) return null;
  const e = err as { name?: unknown; code?: unknown; errorClass?: unknown; method?: unknown };
  return e.name === "SlackApiError" && typeof e.code === "string" && typeof e.errorClass === "string" && typeof e.method === "string"
    ? (err as SlackApiError)
    : null;
}

/** True for the limiter's refusal or Slack's own rate limit (an HTTP 429 or ok:false ratelimited). */
export function isRateLimited(err: unknown): boolean {
  if (err instanceof SlackRateBudgetError || (err instanceof Error && err.name === "SlackRateBudgetError")) return true;
  const e = slackErrorOf(err);
  return e !== null && (e.code === "ratelimited" || e.status === 429);
}

/** True for a SlackApiError of class "auth" (the user token or its grant is bad). */
export function isSlackAuthError(err: unknown): boolean {
  return slackErrorOf(err)?.errorClass === "auth";
}

/** A name for a log line: the Slack code, else the error's class name (never a message). */
export function readErrLabel(err: unknown): string {
  const code = slackErrorOf(err)?.code ?? null;
  if (code !== null && /^[a-z0-9_]{1,64}$/.test(code)) return code;
  if (err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name)) return err.name;
  return "error";
}

/** The job's abort (its timeout or a lost lease): never swallowed by a per-item catch. */
export function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

// ---------------------------------------------------------------------------
// Opening the reader
// ---------------------------------------------------------------------------

/** The reader for a job: settings.slackReadingSchemaReady, openReadingInstallation(principal, id?), reading_state discovering|ready.
 *  Returns null (and the caller returns { skipped }) when any is missing. */
export async function openReader(principal: ExecPrincipal, installationId?: string, opts?: { signal?: AbortSignal }): Promise<ReadingInstallation | null> {
  const settings = await loadSettings(principal.id);
  if (!settings.slackReadingSchemaReady) return null;
  let ri: ReadingInstallation | null;
  try {
    ri = await openReadingInstallation(principal, installationId, opts?.signal ? { signal: opts.signal } : undefined);
  } catch (err) {
    // Our own key can't open the user token: not Slack's revocation (the runner raises the auth alert, nothing is revoked).
    if (err instanceof SecretUnavailableError) throw new NonRetryableError("slack reading token unavailable", "auth");
    throw err;
  }
  if (!ri) return null;
  if (ri.reading.state !== "discovering" && ri.reading.state !== "ready") return null;
  return ri;
}

// ---------------------------------------------------------------------------
// Paced reads
// ---------------------------------------------------------------------------

/** Every metered read goes through here: takeSlackBudget(teamId, method, cls), then the sources/slack.ts call. On a SlackApiError:
 *  ratelimited → noteSlackRateLimited and rethrow; auth class → recordUserTokenError + (invalid_auth|token_revoked|account_inactive|
 *  not_authed) enqueueUserCheck, rethrow; success after an error state → clearUserTokenError. opts.maxWaitMs (additive) lets a
 *  bulk pass with a time box wait into the limiter's next window (takeSlackBudget's maxWaitMs) instead of ending at the first
 *  per-minute refusal. */
export async function paced<T>(ri: ReadingInstallation, method: MeteredMethod, cls: RateClass, call: () => Promise<T>,
  opts?: { signal?: AbortSignal; maxWaitMs?: number }): Promise<T> {
  const teamId = ri.row.teamId;
  const budget: { signal?: AbortSignal; maxWaitMs?: number } = {};
  if (opts?.signal) budget.signal = opts.signal;
  if (typeof opts?.maxWaitMs === "number" && Number.isFinite(opts.maxWaitMs) && opts.maxWaitMs >= 0) budget.maxWaitMs = opts.maxWaitMs;
  await takeSlackBudget(teamId, method, cls, Object.keys(budget).length > 0 ? budget : undefined);
  let result: T;
  try {
    result = await call();
  } catch (err) {
    const e = slackErrorOf(err);
    if (e) {
      if (e.code === "ratelimited" || e.status === 429) {
        const wait = typeof e.retryAfterMs === "number" && Number.isFinite(e.retryAfterMs) && e.retryAfterMs > 0 ? e.retryAfterMs : DEFAULT_RETRY_AFTER_MS;
        await noteSlackRateLimited(teamId, method, wait);
      } else if (e.errorClass === "auth") {
        await recordUserTokenError(ri.row.id, e.code);
        if (DEAD_TOKEN_CODES.has(e.code)) await enqueueUserCheck(ri.row.id, new Date());
      }
    }
    throw err;
  }
  if (ri.reading.lastErrorCode !== null && !cleared.has(ri)) {
    cleared.add(ri);
    await clearUserTokenError(ri.row.id);
  }
  return result;
}

/** A time-boxed pass's limiter wait (correctness-2 / -7): up to one full window (60 s, plus a second of slack), never past
 *  the box. 0 once the box is spent, so a refusal then ends the pass as before. */
export function boxedWaitMs(startedMs: number, boxMs: number, nowMs: number = Date.now()): number {
  const left = boxMs - (nowMs - startedMs);
  return Number.isFinite(left) ? Math.max(0, Math.min(MIN_MS + 1_000, Math.floor(left))) : 0;
}

// ---------------------------------------------------------------------------
// The classifier context
// ---------------------------------------------------------------------------

interface ContextBase {
  at: number;
  installationId: string;
  ddBotUserId: string | null;
  ddBotDmChannelIds: ReadonlySet<string>;
  fbLeadChannelIds: ReadonlySet<string>;
  fbLeadNames: ReadonlySet<string>;
  leadSlugs: readonly string[];
  outboundChannelId: string | null;
  clientEmailChannelId: string | null;
}

const CONTEXT_KEY = "__ddExecSlackClassifierContext" as const;
type GlobalWithContext = typeof globalThis & { [CONTEXT_KEY]?: Map<string, ContextBase> };

function contextCache(): Map<string, ContextBase> {
  const g = globalThis as GlobalWithContext;
  g[CONTEXT_KEY] ??= new Map();
  return g[CONTEXT_KEY];
}

/** Drop the cached DD half of a principal's classifier context (discovery re-reads the deny lists every run). */
export function invalidateClassifierContext(principalId: string): void {
  contextCache().delete(principalId);
}

async function loadContextBase(principal: ExecPrincipal, ri: ReadingInstallation, signal?: AbortSignal): Promise<ContextBase> {
  const opts = signal ? { signal } : {};
  // Any DD read failing throws: never classify against a partial deny list (N1, DI02).
  const [fb, clients, clientEmail, ddBotDms] = await Promise.all([
    listFbLeadChannels(principal, opts),
    listClients(principal, opts),
    getClientEmailChannelId(principal, opts),
    listDdBotDmChannelIds(principal, opts)
  ]);
  // C28: the DD bot's identity is best-effort; the bot set and daily_briefings still deny its DM.
  let ddBotUserId: string | null = null;
  try {
    ddBotUserId = (await getDdBotIdentity(ri.row.teamId, opts))?.userId ?? null;
  } catch (err) {
    console.warn(`[exec-slack] DD bot identity unavailable for ${ri.row.id} (${readErrLabel(err)})`);
  }
  const fbNames = fb.map((r) => r.name).filter((n): n is string => typeof n === "string" && n.length > 0);
  return {
    at: Date.now(),
    installationId: ri.row.id,
    ddBotUserId,
    ddBotDmChannelIds: new Set(ddBotDms),
    fbLeadChannelIds: new Set(fb.map((r) => r.channelId).filter((c): c is string => typeof c === "string")),
    fbLeadNames: new Set(fbNames.map((n) => n.toLowerCase())),
    leadSlugs: leadSlugsFrom({ clientNames: clients.map((c) => c.name).filter((n) => typeof n === "string"), fbLeadNames: fbNames }),
    outboundChannelId: ddOutboundChannelId(),
    clientEmailChannelId: clientEmail
  };
}

/** The classifier context (§3.5), cached per principal for classifierContextTtlMs; any DD read failure throws (no partial context). */
export async function classifierContext(principal: ExecPrincipal, ri: ReadingInstallation, opts: { botUserIds: ReadonlySet<string> | null;
  slackMutedIds: ReadonlySet<string> | null; signal?: AbortSignal }): Promise<ClassifierContext> {
  const cache = contextCache();
  let base = cache.get(principal.id);
  if (!base || base.installationId !== ri.row.id || Date.now() - base.at > SLACK_READ_LIMITS.classifierContextTtlMs || Date.now() < base.at) {
    base = await loadContextBase(principal, ri, opts.signal);
    cache.set(principal.id, base);
  }
  return {
    principalSlackUserId: ri.row.userId,
    assistantDmChannelId: ri.row.dmChannelId,
    assistantBotUserId: ri.row.botUserId,
    ddBotUserId: base.ddBotUserId,
    ddBotDmChannelIds: base.ddBotDmChannelIds,
    botUserIds: opts.botUserIds,
    fbLeadChannelIds: base.fbLeadChannelIds,
    fbLeadNames: base.fbLeadNames,
    leadSlugs: base.leadSlugs,
    outboundChannelId: base.outboundChannelId,
    clientEmailChannelId: base.clientEmailChannelId,
    grantedTypes: grantedTypes(ri.reading.scopes),
    slackMutedIds: opts.slackMutedIds
  };
}

export function grantedTypes(scopes: readonly string[]): Set<ConvType> {   // channel ⇐ channels:read+history; group ⇐ groups:*; im ⇐ im:read+history; mpim ⇐ mpim:*
  const has = new Set(Array.isArray(scopes) ? scopes : []);
  const out = new Set<ConvType>();
  if (has.has("channels:read") && has.has("channels:history")) out.add("channel");
  if (has.has("groups:read") && has.has("groups:history")) out.add("group");
  if (has.has("im:read") && has.has("im:history")) out.add("im");
  if (has.has("mpim:read") && has.has("mpim:history")) out.add("mpim");
  return out;
}

// ---------------------------------------------------------------------------
// Enqueues
// ---------------------------------------------------------------------------

/** One sweep now (P8 "right before the brief", the owner, the end of a discovery): bulk, one attempt, one per reason and minute. */
export async function enqueueSlackSweepNow(principal: ExecPrincipal, reason: "brief" | "owner" | "discover", now?: Date): Promise<boolean> {
  const at = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  if (reason !== "brief" && reason !== "owner" && reason !== "discover") throw new NonRetryableError("enqueueSlackSweepNow: unknown reason");
  const minute = Math.floor(at.getTime() / MIN_MS);
  const r = await enqueueJob({
    kind: SLACK_READ_JOB_KINDS.sweep,
    lane: "bulk",
    principalId: principal.id,
    payload: { reason },
    dedupeKey: `slack-sweep-now:${principal.id}:${reason}:${minute}`,
    maxAttempts: 1
  });
  return r.enqueued;
}

export function slackAttentionKick(principal: Pick<ExecPrincipal, "id">, now: Date): EnqueueJobInput {   // the §2.9.3 key
  const ms = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(ms)) throw new NonRetryableError("slackAttentionKick: now must be a valid Date");
  const next = Math.floor(ms / MIN_MS) + 1;
  return {
    kind: SLACK_READ_JOB_KINDS.attention,
    lane: "bulk",
    principalId: principal.id,
    payload: { kick: true },
    dedupeKey: `slack-attn:${principal.id}:m${next}`,
    runAfter: new Date(next * MIN_MS + 2_000),
    maxAttempts: 3
  };
}

/** The attention kick, best-effort (the 10-minute pass covers a failure). */
export async function kickSlackAttention(principal: Pick<ExecPrincipal, "id">, now: Date = new Date()): Promise<void> {
  try {
    await enqueueJob(slackAttentionKick(principal, now));
  } catch (err) {
    console.warn(`[exec-slack] attention kick for ${principal.id} not enqueued (${readErrLabel(err)})`);
  }
}

// ---------------------------------------------------------------------------
// Slack ts arithmetic (numeric, never string compare)
// ---------------------------------------------------------------------------

const TS_SHAPE = /^([0-9]{1,12})\.([0-9]{1,8})$/;

/** ts + seconds (whole seconds; the fraction kept exactly as written), floored at 0. null for a malformed ts. */
export function tsPlusSeconds(ts: string, seconds: number): string | null {
  const m = typeof ts === "string" ? TS_SHAPE.exec(ts) : null;
  if (!m || !Number.isInteger(seconds)) return null;
  const sec = Number(m[1]) + seconds;
  return sec < 0 ? `0.${m[2]}` : `${sec}.${m[2]}`;
}

/** The 5-minute bucket of the sweep's note key (C12: "b<5-minute bucket>"). */
export const sweepBucket = (now: Date): string => `b${Math.floor(now.getTime() / 300_000)}`;
/** The interactive receipt minute (C12: "m<receipt epoch-minute>"). */
export const minuteBucket = (now: Date): string => `m${Math.floor(now.getTime() / MIN_MS)}`;

// ---------------------------------------------------------------------------
// A fetched window → rows (the sweep and the classify catch-up)
// ---------------------------------------------------------------------------

/** sweepVerdict's context for one conversation, from its stored channel row (§3.11.3). */
export interface WindowContext {
  conv: ConvType;
  hisId: string;
  teamId: string;
  ddBot: { userId: string | null; appId: string | null };
  isHub: boolean;
  muted: boolean;
  muteSource: ChannelRow["muteSource"];
  extConversation: boolean;
  optedOut: ReadonlySet<string>;
  /** Thread roots he started or posted in (stored he_posted_ts, plus his messages seen in this run). */
  hePosted: Set<string>;
}

export function windowContext(ri: ReadingInstallation, ch: ChannelRow, ddBot: { userId: string | null; appId: string | null },
  optedOut: ReadonlySet<string>, hePosted: Set<string> = new Set()): WindowContext {
  return {
    conv: ch.convType,
    hisId: ri.row.userId,
    teamId: ri.row.teamId,
    ddBot,
    isHub: ch.class === "hub",
    muted: ch.watchState === "muted",
    muteSource: ch.muteSource,
    extConversation: ch.class === "external" || ch.extEver || ch.isExtShared,
    optedOut,
    hePosted
  };
}

export interface WindowCounts { candidates: number; anchors: number; stamped: number; deleted: number; acknowledged: number; blocked: number }

/** sweepVerdict for every message (his messages in a thread first mark it his, so a later reply there is "his thread"). */
export function verdictsFor(messages: readonly SlackReadMessage[], w: WindowContext): Map<string, SweepVerdict> {
  for (const m of messages) {
    if (m.user === w.hisId && m.threadTs !== null) w.hePosted.add(m.threadTs);
  }
  const out = new Map<string, SweepVerdict>();
  for (const m of messages) {
    out.set(m.ts, sweepVerdict(m, {
      conv: w.conv,
      hisId: w.hisId,
      teamId: w.teamId,
      ddBot: w.ddBot,
      isHub: w.isHub,
      muted: w.muted,
      muteSource: w.muteSource,
      extConversation: w.extConversation,
      optedOut: w.optedOut,
      hePostedInThread: (root) => w.hePosted.has(root)
    }));
  }
  return out;
}

/**
 * The rows one fetched window writes, in order: tombstones marked deleted (C16: only that ts), candidates and anchors
 * noted (their dd_paths, C46), his messages stamped (N9), his reactions acknowledged (C40). References only: ts values,
 * ids, reasons, paths. Returns counts.
 */
export async function noteWindow(principal: ExecPrincipal, channelId: string, messages: readonly SlackReadMessage[], w: WindowContext,
  q: { lane: JobLane; bucket: string; now: Date }): Promise<WindowCounts> {
  const verdicts = verdictsFor(messages, w);
  const deleted: string[] = [];
  const notes: NoteRow[] = [];
  const fromHim: FromHimRow[] = [];
  const acked: string[] = [];
  for (const m of messages) {
    const v = verdicts.get(m.ts);
    if (!v) continue;
    const threadTs = m.threadTs !== null && m.threadTs !== m.ts ? m.threadTs : null;
    if (v.role === "deleted") deleted.push(m.ts);
    else if (v.role === "anchor") notes.push({ ts: m.ts, thread_ts: threadTs, role: "anchor", author: null, author_external: false, reasons: 0, dd_paths: v.ddPaths });
    else if (v.role === "candidate") {
      notes.push({ ts: m.ts, thread_ts: threadTs, role: "candidate", author: m.user, author_external: v.authorExternal, reasons: v.reasons, dd_paths: v.ddPaths });
      if (m.reactedUserIds.includes(w.hisId)) acked.push(m.ts);
    } else if (v.role === "from_him") fromHim.push({ ts: m.ts, thread_ts: threadTs, mentions: v.mentions });
  }
  const counts: WindowCounts = { candidates: 0, anchors: 0, stamped: 0, deleted: 0, acknowledged: 0, blocked: 0 };
  if (deleted.length > 0) {
    await markDeleted(principal, channelId, deleted, "tombstone");
    counts.deleted += deleted.length;
  }
  if (notes.length > 0) {
    const r = await noteMessages(principal, channelId, notes, q.lane, q.bucket);
    counts.candidates += r.candidates;
    counts.anchors += r.anchors;
    counts.blocked += r.blocked;
  }
  if (fromHim.length > 0) counts.stamped += (await noteFromHim(principal, channelId, fromHim)).stamped;
  if (acked.length > 0) counts.acknowledged += await setAcknowledged(principal, channelId, acked, q.now.toISOString());
  return counts;
}

// ---------------------------------------------------------------------------
// Small shared pieces of the P7a handlers
// ---------------------------------------------------------------------------

/** A conversation id (public / private channel, IM). */
export const CHANNEL_ID_RE = /^[CGD][A-Z0-9]{2,30}$/;

/** The lease holder of one run: worker, job and attempt (≤ 200 characters, sync-state's limit). */
export function leaseHolder(ctx: { workerId: string; job: { id: number; attempts: number } }): string {
  const holder = `${ctx.workerId}#${ctx.job.id}.${ctx.job.attempts}`;
  return holder.length <= 200 ? holder : holder.slice(holder.length - 200);
}

/** "YYYYMMDDHH" in UTC (the hourly dedupe keys). */
export const utcHour = (now: Date): string => now.toISOString().slice(0, 13).replace(/[-T]/g, "");

/** Test seam: drop the classifier-context cache. */
export function __resetSlackReadForTests(): void {
  contextCache().clear();
}
