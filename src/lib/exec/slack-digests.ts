import "server-only";

import { enqueueJobs, BULK_STAGGER_SPACING_MS } from "@/lib/exec/jobs";
import { callModel, type CallModelResult } from "@/lib/exec/llm/client";
import { buildExecRequest } from "@/lib/exec/llm/request";
import { messageText } from "@/lib/exec/llm/stream";
import { featureSpentTodayUsd } from "@/lib/exec/llm/usage";
import { loadSettings } from "@/lib/exec/principal";
import { appOrigin, isAllowedLinkUrl } from "@/lib/exec/refs";
import type { DigestCardView } from "@/lib/exec/slack-page";
import { isDdPost } from "@/lib/exec/slack-ingest";
import { boxedWaitMs, isAbort, isRateLimited, isSlackAuthError, openReader, paced, readErrLabel, slackErrorOf } from "@/lib/exec/slack-read";
import { effectiveSlackCapUsd, tsToMs } from "@/lib/exec/slack-read-types";
import type { ReadingInstallation } from "@/lib/exec/slack-read-types";
import { claimDigest, finishDigest, getDigests, listChannelLinks, slackIntelState } from "@/lib/exec/slack-intel-store";
import {
  SLACK_INTEL_JOB_KINDS,
  SLACK_INTEL_LIMITS,
  compareTs,
  slackItemPolicy,
  slackUsePolicy,
  tsOfDate,
  type ChannelRow,
  type DigestStatus,
  type SlackCatchUpCounts,
  type SlackChannelLink,
  type SlackDigestPayload,
  type SlackDigestRow,
  type SlackIntelState,
  type SlackPrivacy,
  type SlackUse
} from "@/lib/exec/slack-intel-types";
import { SLACK_CAP_FEATURES, getDdBotIdentity, listAuthorOptouts, listIntelChannels, readOpenSlackItems } from "@/lib/exec/slack-reading";
import { slackTextToPlain } from "@/lib/exec/slack-text";
import { readHistory, readReplies, type SlackReadMessage } from "@/lib/exec/sources/slack";
import { newNonce } from "@/lib/exec/text/untrusted";
import { localDateString, parseLocalTime, startOfLocalDayUtc, tzOffsetMinutes } from "@/lib/exec/time";
import { DIGEST_SCHEMA_V1, DIGEST_SYSTEM_PROMPT_V1, parseDigestOutput, renderDigestInput, type DigestInputMessage } from "@/lib/exec/triage/slack-digest";
import { BudgetExceededError, type EnqueueJobInput, type ExecPrincipal, type ExecSettings, type SourceRef } from "@/lib/exec/types";

// Per-conversation daily digests (P7b contract §3.6, §3.11.2–3, N19, C6, C12–C15, C22, C23; Area C; server-only):
// build, rebuild, list, the brief's inputs and the catch-up counts. Live reads only here and in slack-search.ts
// (B-P7b-7), through P7a's openReader + paced (class "sweep"); every build re-checks slackUsePolicy(…, "digest")
// before its claim (and again right before the model call) and drops DD posts (isDdPost), other bots and opted-out
// authors before any text is kept.
//
// What a build keeps: the AI's summary and lines (cleaned by triage/slack-digest.ts: no names, no ids, no links, verbatim
// runs over 160 characters cut), the ts of every message the model saw (so a delete of any of them blanks the digest,
// N13) and counts. No message text, excerpt or author id is stored, logged or put in a job payload or result (§0.3 rules
// 4–6): logs carry the channel id, the local date and our codes only.
//
// A build (buildDigest, §3.11.2):
//   1  The intel state (C1) and the channel row through P7a's facade; slackUsePolicy(…, "digest") denies (deny, hub,
//      unclassified, left, unwatched, muted, a 1:1 DM) → not_allowed with no claim and no Slack call. A "today" build of
//      an archived channel is refused too.
//   2  The day's bounds in his zone (dayBounds); "today so far" reads to now and is never full-day (C15).
//   3  RPC 6's claim: fresh / busy / not_found end here; from now on every exit finishes the row.
//   4  The reader, the DD bot's identity (null tolerated: the template arm still holds), the opted-out authors (a read
//      failure → failed, fail closed); history ≤ 5 pages and the replies of ≤ 10 parents of that day, each read through
//      paced(…, "sweep"). A rate refusal → failed (the next plan or rebuild retries it); an auth-class answer → failed and
//      the error is rethrown with its class, so the runner doesn't retry it (paced already started P7a's user check).
//   5  Opted-out authors and every thread they started or replied in dropped uncounted; DD posts counted ddPost; bots, apps, Slack's own records and hidden rows
//      counted bot; external (Slack Connect) authors kept, counted and only ever summarized (N10).
//   6  No message from a person → empty. The Slack sub-cap (C14) over SLACK_CAP_FEATURES; a spend read failure → failed.
//   7  The switch and the channel are re-checked right before the model call (a pause, a revoke or "Don't watch" while
//      the history was read → nothing is sent). One Haiku call; refusal / truncation / invalid output → failed; the
//      daily cap → skipped_cap. RPC 7's finish: deleted_source → a rebuild within 7 days; channel_gone → not_allowed.

const KIND = SLACK_INTEL_JOB_KINDS.digest;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;
/** RPC 6 treats a younger building row as busy. */
const BUILDING_FRESH_MS = 10 * MIN_MS;
/** exec.slack-digest's attempts (§3.11). */
const DIGEST_MAX_ATTEMPTS = 2;
const HISTORY_PAGE_LIMIT = 200;
/** The live reads' time box inside the 120 s job: the limiter may be waited on until it runs out (boxedWaitMs). */
const READ_BOX_MS = 60_000;
const CHANNEL_RE = /^[CGD][A-Z0-9]{2,30}$/;
const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MODES: readonly SlackDigestPayload["mode"][] = ["plan", "today", "rebuild"];
/** P7a's HISTORY_SUBTYPES (slack-ingest.ts) minus bot_message: the subtypes a person's own message carries. */
const PERSON_SUBTYPES: ReadonlySet<string> = new Set(["thread_broadcast", "file_share", "me_message"]);
const SLACK_MENTION = /<@([UW][A-Z0-9]{2,30})(?:\|[^<>]*)?>/g;
const CHANNEL_LABEL_MAX = 80;

type BuildOutcome = "built" | "empty" | "skipped_cap" | "failed" | "fresh" | "busy" | "not_allowed" | "lost" | "deleted_source";
/** buildDigest's answer: the frozen { outcome, costUsd } plus counts and a code for the job's result (additive). */
export interface DigestBuildResult { outcome: BuildOutcome; costUsd: number | null; humanCount?: number; partial?: boolean; fullDay?: boolean; code?: string }

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "error");

function validPayload(p: unknown): p is SlackDigestPayload {
  if (typeof p !== "object" || p === null || Array.isArray(p)) return false;
  const x = p as Record<string, unknown>;
  return typeof x.channel_id === "string" && CHANNEL_RE.test(x.channel_id) && typeof x.local_date === "string" && validDate(x.local_date)
    && typeof x.mode === "string" && (MODES as readonly string[]).includes(x.mode);
}

function validDate(d: string): boolean {
  const m = LOCAL_DATE_RE.exec(d);
  if (!m) return false;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return t.getUTCFullYear() === Number(m[1]) && t.getUTCMonth() === Number(m[2]) - 1 && t.getUTCDate() === Number(m[3]);
}

/** "YYYY-MM-DD" plus n days (calendar arithmetic; no zone involved). */
function addDays(localDate: string, n: number): string {
  const m = LOCAL_DATE_RE.exec(localDate) as RegExpExecArray;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n)).toISOString().slice(0, 10);
}

/** His local date before `now`'s: one millisecond before today's local midnight (DST-correct, unlike now − 24 h). */
function yesterdayOf(now: Date, tz: string): string {
  return localDateString(new Date(startOfLocalDayUtc(now, tz).getTime() - 1), tz);
}

// ---------------------------------------------------------------------------
// Day bounds
// ---------------------------------------------------------------------------

/** The day bounds in principal.timezone as ts strings (DST-correct through startOfLocalDayUtc): fromTs = local midnight,
 *  toTs = the next local midnight (the day's end; a 23- or 25-hour day across a DST change), endsAt = that instant.
 *  Throws TypeError on a malformed date or one that doesn't exist in tz. */
export function dayBounds(localDate: string, tz: string): { fromTs: string; toTs: string; endsAt: Date } {
  if (typeof localDate !== "string" || !validDate(localDate)) throw new TypeError("dayBounds: malformed local date");
  const m = LOCAL_DATE_RE.exec(localDate) as RegExpExecArray;
  let probe = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  // Noon UTC is that local date in every zone from UTC−11 to UTC+11; the two steps cover the zones beyond.
  for (let i = 0; i < 2; i++) {
    const at = localDateString(probe, tz);
    if (at === localDate) break;
    probe = new Date(probe.getTime() + (at < localDate ? 12 : -12) * HOUR_MS);
  }
  if (localDateString(probe, tz) !== localDate) throw new TypeError("dayBounds: the date doesn't exist in the zone");
  const start = startOfLocalDayUtc(probe, tz);
  // A local day is 23 to 25 hours long, so 26 hours on is always inside the next one.
  const end = startOfLocalDayUtc(new Date(start.getTime() + 26 * HOUR_MS), tz);
  return { fromTs: tsOfDate(start), toTs: tsOfDate(end), endsAt: end };
}

// ---------------------------------------------------------------------------
// Labels and refs
// ---------------------------------------------------------------------------

/** A conversation's label for the page and the tool: "#name" for a named channel, else its kind. Never logged. */
function channelLabelOf(ch: Pick<ChannelRow, "convType" | "name">): string {
  const raw = typeof ch.name === "string" ? ch.name.replace(/[^A-Za-z0-9._-]/g, "").slice(0, CHANNEL_LABEL_MAX - 1) : "";
  if ((ch.convType === "channel" || ch.convType === "group") && raw.length > 0) return `#${raw}`;
  if (ch.convType === "mpim") return "Group DM";
  if (ch.convType === "im") return "Direct message";
  return ch.convType === "group" ? "Private channel" : "Channel";
}

/** The kind of conversation the model is told it reads (never its name). */
function conversationKind(ch: Pick<ChannelRow, "convType">): string {
  if (ch.convType === "mpim") return "a Slack group DM";
  if (ch.convType === "group") return "a private Slack channel";
  return "a Slack channel";
}

/** §3.6's digest ref (additive export for the tool and the brief): the DD page of that day, anchored at the channel's card.
 *  `isPrivate` fails closed: only an explicit false is public. */
export function slackDigestRef(row: Pick<SlackDigestRow, "channelId" | "localDate">, label: string, isPrivate: boolean): SourceRef {
  const url = `${appOrigin()}/executive/slack?date=${encodeURIComponent(row.localDate)}#ch-${encodeURIComponent(row.channelId)}`;
  const text = `Digest: ${typeof label === "string" && label.trim() !== "" ? label.trim() : "Slack conversation"}, ${row.localDate}`;
  return {
    system: "slack",
    id: `${row.channelId}:d:${row.localDate}`,
    url: isAllowedLinkUrl(url) ? new URL(url).href : null,
    label: text.length > 200 ? text.slice(0, 200) : text,
    class: isPrivate === false ? "public" : "private"
  };
}

// ---------------------------------------------------------------------------
// The build (§3.11.2)
// ---------------------------------------------------------------------------

type Counts = SlackDigestRow["counts"];
type FinishInput = Parameters<typeof finishDigest>[1];

/** A person's own message: an author, no bot / app marker, not hidden, and no subtype but a person's (P7a's set). */
function isPersonMessage(m: SlackReadMessage): boolean {
  return m.user !== null && m.botId === null && !m.botProfile && m.appId === null && !m.hidden && (m.subtype === null || PERSON_SUBTYPES.has(m.subtype));
}

function tsCompare(a: string, b: string): number | null {
  try {
    return compareTs(a, b);
  } catch {
    return null;
  }
}

/** The build of one channel-day (§3.11.2's steps 2–11). Never throws for Slack, model or policy outcomes, with one exception:
 *  an auth-class Slack answer (or a reading token our key can't open) finishes the row failed and is rethrown with its
 *  errorClass, so the job runner doesn't retry it. A store failure or the job's abort is rethrown after a best-effort
 *  failed finish. */
export async function buildDigest(principal: ExecPrincipal, settings: ExecSettings, payload: SlackDigestPayload, opts: { signal: AbortSignal; now: Date }):
  Promise<DigestBuildResult> {
  const signal = opts?.signal;
  const now = opts?.now;
  if (!validPayload(payload) || !(now instanceof Date) || !Number.isFinite(now.getTime())) return { outcome: "not_allowed", costUsd: null, code: "bad_payload" };
  const channelId = payload.channel_id;
  const localDate = payload.local_date;
  const mode = payload.mode;
  const tz = principal.timezone;

  // 1. The state and the channel row (no claim, no Slack call when the policy denies).
  const state = await slackIntelState(principal, settings, { signal });
  if (state !== "ok") return { outcome: "not_allowed", costUsd: null, code: state };
  const ch = (await listIntelChannels(principal, { channelIds: [channelId], signal })).find((c) => c.channelId === channelId) ?? null;
  const policy = slackUsePolicy(state, ch, "digest");
  if (!policy.allowed || ch === null) return { outcome: "not_allowed", costUsd: null, code: policy.allowed ? "unclassified" : policy.reason };
  const channel: ChannelRow = ch;
  if (mode === "today" && channel.isArchived) return { outcome: "not_allowed", costUsd: null, code: "archived" };
  const privacy = policy.privacy;
  if (privacy === "dm") return { outcome: "not_allowed", costUsd: null, code: "dm" };

  // 2. The day's bounds.
  let bounds: { fromTs: string; toTs: string; endsAt: Date };
  try {
    bounds = dayBounds(localDate, tz);
  } catch {
    return { outcome: "not_allowed", costUsd: null, code: "bad_date" };
  }
  const startsMs = tsToMs(bounds.fromTs);
  if (now.getTime() < startsMs) return { outcome: "not_allowed", costUsd: null, code: "future" };
  const fullDay = now.getTime() >= bounds.endsAt.getTime();
  const toTs = fullDay ? bounds.toTs : tsOfDate(now);
  const retentionDays = Number.isFinite(settings.retentionDaysSlack) && settings.retentionDaysSlack > 0 ? settings.retentionDaysSlack : 90;
  const expiresAt = new Date(bounds.endsAt.getTime() + retentionDays * DAY_MS);
  if (expiresAt.getTime() <= now.getTime()) return { outcome: "not_allowed", costUsd: null, code: "expired" };

  // 3. The claim.
  const claim = await claimDigest(principal, { channelId, localDate, tz, fromTs: bounds.fromTs, toTs, expiresAt: expiresAt.toISOString(), mode });
  if (claim.outcome === "fresh") return { outcome: "fresh", costUsd: null };
  if (claim.outcome === "busy") return { outcome: "busy", costUsd: null };
  if (claim.outcome !== "claimed") return { outcome: "not_allowed", costUsd: null, code: "not_found" };

  const counts: Counts = { human: 0, bot: 0, ddPost: 0, external: 0, threads: 0 };
  let partial = false;
  let costUsd: number | null = null;
  let model: string | null = null;
  let finished = false;
  const finish = async (status: FinishInput["status"], extra: Partial<FinishInput>, code?: string): Promise<DigestBuildResult> => {
    finished = true;
    const r = await finishDigest(principal, {
      id: claim.id, status, summary: null, highlights: [], decisions: [], openQuestions: [], sourceTs: [], counts, privacy, partial, fullDay,
      injectionSuspected: false, model, costUsd, ...extra
    });
    const base = { costUsd, humanCount: counts.human, partial, fullDay };
    if (code !== undefined) console.warn(`[exec-slack-intel] digest ${channelId} ${localDate}: ${status} (${code})`);
    if (r === "lost") return { outcome: "lost", ...base };
    if (r === "channel_gone") return { outcome: "not_allowed", ...base, code: "channel_gone" };
    if (r === "deleted_source") {
      try {
        await enqueueDigestRebuilds(principal, [{ channelId, localDate, rebuilds: claim.rebuilds + 1 }], now, { max: 1 });
      } catch (err) {
        console.warn(`[exec-slack-intel] digest ${channelId} ${localDate}: rebuild not queued (${errName(err)})`);
      }
      return { outcome: "deleted_source", ...base };
    }
    return { outcome: status, ...base, ...(code !== undefined ? { code } : {}) };
  };

  try {
    return await buildClaimed();
  } catch (err) {
    if (!finished) {
      try {
        await finish("failed", {}, isAbort(err, signal) ? "aborted" : isSlackAuthError(err) ? "auth" : errName(err));
      } catch {
        // The row stays building; RPC 6 reclaims it after 10 minutes and the purge fails it after 30.
      }
    }
    throw err;
  }

  async function buildClaimed(): Promise<DigestBuildResult> {
    // 4. The reader, the DD bot, the opt-outs.
    const ri: ReadingInstallation | null = await openReader(principal, undefined, { signal });
    if (ri === null) return finish("failed", {}, "no_reader");
    const reader = ri;
    const teamId = reader.row.teamId;
    let ddBot: { userId: string | null; appId: string | null } = { userId: null, appId: null };
    try {
      const id = await getDdBotIdentity(teamId, { signal });
      if (id) ddBot = { userId: id.userId, appId: id.appId };
    } catch (err) {
      if (isAbort(err, signal)) throw err;
    }
    let optedOut: ReadonlySet<string>;
    try {
      optedOut = new Set(await listAuthorOptouts(principal));
    } catch (err) {
      if (isAbort(err, signal)) throw err;
      return finish("failed", {}, "optouts_unavailable");
    }

    // History and threads, each read through the limiter (class "sweep").
    const startedMs = Date.now();
    const fetched: SlackReadMessage[] = [];
    try {
      let cursor: string | null = null;
      for (let page = 0; ; page++) {
        const r = await paced(reader, "conversations.history", "sweep",
          () => readHistory(reader.target, { channel: channelId, oldest: bounds.fromTs, latest: toTs, inclusive: true, limit: HISTORY_PAGE_LIMIT, cursor }, { signal }),
          { signal, maxWaitMs: boxedWaitMs(startedMs, READ_BOX_MS) });
        fetched.push(...r.messages);
        if (!r.hasMore) break;
        if (page + 1 >= SLACK_INTEL_LIMITS.digestHistoryPages || !r.nextCursor) {
          partial = true;
          break;
        }
        cursor = r.nextCursor;
      }
      // An opted-out author's thread is dropped whole below, so its replies are never read.
      const parents = fetched
        .filter((m) => m.replyCount > 0 && (m.threadTs === null || m.threadTs === m.ts) && inDay(m.ts) && !(m.user !== null && optedOut.has(m.user)))
        .sort((a, b) => tsCompare(b.ts, a.ts) ?? 0)
        .slice(0, SLACK_INTEL_LIMITS.digestThreadReads);
      for (const parent of parents) {
        try {
          const r = await paced(reader, "conversations.replies", "sweep",
            () => readReplies(reader.target, { channel: channelId, ts: parent.ts, oldest: bounds.fromTs, latest: toTs, inclusive: true, limit: HISTORY_PAGE_LIMIT }, { signal }),
            { signal, maxWaitMs: boxedWaitMs(startedMs, READ_BOX_MS) });
          fetched.push(...r.messages);
          counts.threads += 1;
          if (r.hasMore) partial = true;
        } catch (err) {
          // A thread whose root was deleted meanwhile is simply not part of the day.
          if (slackErrorOf(err)?.code === "thread_not_found") continue;
          throw err;
        }
      }
    } catch (err) {
      if (isAbort(err, signal) || isSlackAuthError(err)) throw err;
      return finish("failed", {}, isRateLimited(err) ? "rate_limited" : readErrLabel(err));
    }

    // 5. Before any text is kept: opted-out authors, DD posts, bots; external authors kept and counted.
    // §0.3 rule 14 (fixer correctness-5): P7a's per-author purge deletes every thread rooted at or holding an opted-out
    // author's message (others' replies may describe their words), so every message of such a thread is dropped too,
    // uncounted: the thread roots their messages (or a reply to their message) name.
    const tainted = new Set<string>();
    for (const m of fetched) {
      if (m.user !== null && optedOut.has(m.user)) tainted.add(m.threadTs ?? m.ts);
      if (m.threadTs !== null && m.parentUserId !== null && optedOut.has(m.parentUserId)) tainted.add(m.threadTs);
    }
    const extConversation = channel.class === "external" || channel.isExtShared || channel.extEver;
    const seen = new Set<string>();
    const people: SlackReadMessage[] = [];
    for (const m of fetched) {
      if (seen.has(m.ts) || !inDay(m.ts)) continue;
      seen.add(m.ts);
      if ((m.user !== null && optedOut.has(m.user)) || tainted.has(m.threadTs ?? m.ts)) continue;
      if (isDdPost(m, ddBot)) {
        counts.ddPost += 1;
        continue;
      }
      if (!isPersonMessage(m)) {
        counts.bot += 1;
        continue;
      }
      const external = m.userTeam !== null ? m.userTeam !== teamId : extConversation;
      if (external) counts.external += 1;
      else counts.human += 1;
      people.push(m);
    }

    // 6. Nothing from a person → empty; then the Slack sub-cap (C14).
    if (people.length === 0) return finish("empty", {});
    let spent: number;
    try {
      spent = await featureSpentTodayUsd(principal.id, tz, SLACK_CAP_FEATURES, now, { signal });
    } catch (err) {
      if (isAbort(err, signal)) throw err;
      return finish("failed", {}, "spend_unavailable");
    }
    if (!Number.isFinite(spent)) return finish("failed", {}, "spend_unavailable");
    if (spent >= effectiveSlackCapUsd(settings)) return finish("skipped_cap", {});

    // Pseudonyms by first appearance (him = YOU), mentions mapped to them before the text is made plain.
    people.sort((a, b) => tsCompare(a.ts, b.ts) ?? 0);
    const him = reader.row.userId;
    const pseudonyms = new Map<string, string>();
    const pseudonym = (userId: string): string => {
      if (userId === him) return "YOU";
      let p = pseudonyms.get(userId);
      if (p === undefined) {
        p = `A${pseudonyms.size + 1}`;
        pseudonyms.set(userId, p);
      }
      return p;
    };
    for (const m of people) pseudonym(m.user as string);
    const messages: DigestInputMessage[] = people.map((m) => ({
      ts: m.ts,
      threadTs: m.threadTs,
      author: pseudonym(m.user as string),
      text: slackTextToPlain((m.text ?? "").replace(SLACK_MENTION, (_whole, id: string) => `@${pseudonym(id)}`)),
      isReply: m.threadTs !== null && m.threadTs !== m.ts
    }));

    // 7. The switch and the channel again, right before anything is sent.
    const freshSettings = await loadSettings(principal.id);
    const stateNow = await slackIntelState(principal, freshSettings, { signal });
    const chNow = (await listIntelChannels(principal, { channelIds: [channelId], signal })).find((c) => c.channelId === channelId) ?? null;
    const recheck = slackUsePolicy(stateNow, chNow, "digest");
    if (!recheck.allowed) {
      const done = await finish("failed", {}, "policy_changed");
      return done.outcome === "failed" ? { ...done, outcome: "not_allowed", code: "policy_changed" } : done;
    }

    const rendered = renderDigestInput({
      channelLabel: conversationKind(channel), privacy, localDate, messages, counts: { bot: counts.bot, ddPost: counts.ddPost, external: counts.external },
      nonce: newNonce(), tz
    });
    partial = partial || rendered.partial;
    const corpus = messages.map((m) => m.text);
    const request = buildExecRequest({
      feature: "digest",
      system: [{ type: "text", text: DIGEST_SYSTEM_PROMPT_V1 }],
      messages: [{ role: "user", content: [{ type: "text", text: rendered.text }] }],
      // A private copy per request: nothing downstream can touch the frozen original.
      outputSchema: structuredClone(DIGEST_SCHEMA_V1) as Record<string, unknown>
    });
    model = request.model;
    let result: CallModelResult;
    try {
      result = await callModel({ principal, feature: "digest", request, signal });
    } catch (err) {
      if (err instanceof BudgetExceededError) return finish("skipped_cap", {}, "budget");
      if (isAbort(err, signal)) throw err;
      return finish("failed", {}, errName(err));
    }
    costUsd = Number.isFinite(result.costUsd) && result.costUsd >= 0 ? result.costUsd : null;
    if (result.refused) return finish("failed", {}, "refused");
    if (result.truncated) return finish("failed", {}, "truncated");
    const parsed = parseDigestOutput(messageText(result.message), rendered, corpus);
    if (!parsed.ok) return finish("failed", {}, parsed.reason);
    if (parsed.injectionSuspected) console.info(`[exec-slack-intel] digest ${channelId} ${localDate}: injection_suspected=1`);
    return finish("built", {
      summary: parsed.summary, highlights: parsed.highlights, decisions: parsed.decisions, openQuestions: parsed.openQuestions,
      sourceTs: rendered.indexToTs, injectionSuspected: parsed.injectionSuspected
    });
  }

  /** In the claimed window: [fromTs, toTs] and before the day's end (a message at the next midnight is tomorrow's). */
  function inDay(ts: string): boolean {
    const a = tsCompare(ts, bounds.fromTs);
    const b = tsCompare(ts, toTs);
    const c = tsCompare(ts, bounds.toTs);
    return a !== null && b !== null && c !== null && a >= 0 && b <= 0 && c < 0;
  }
}

// ---------------------------------------------------------------------------
// Enqueues (C15)
// ---------------------------------------------------------------------------

function digestJob(principal: Pick<ExecPrincipal, "id">, payload: SlackDigestPayload, dedupeKey: string, runAfter: Date): EnqueueJobInput {
  return { kind: KIND, lane: "bulk", principalId: principal.id, payload: { ...payload }, dedupeKey, runAfter, maxAttempts: DIGEST_MAX_ATTEMPTS };
}

/** Enqueue "today so far" builds (C15): ≤ maxChannels channels whose today digest is missing or older than an hour, in the
 *  caller's order (a channel built within the hour is skipped and doesn't count). Returns the ones with a build queued for
 *  this hour: enqueued now (the hour's dedupe key `…:t<epochHour>`; a key already queued this hour inserts nothing) or a
 *  build started under 10 minutes ago. [] = every channel's digest is fresh (the route answers "fresh"). The callers check
 *  the policy first; buildDigest checks it again before it claims. */
export async function requestTodayDigests(principal: ExecPrincipal, channelIds: readonly string[], now: Date, maxChannels: number): Promise<string[]> {
  const max = Number.isSafeInteger(maxChannels) && maxChannels > 0 ? maxChannels : 0;
  const ids = [...new Set((Array.isArray(channelIds) ? channelIds : []).filter((c) => typeof c === "string" && CHANNEL_RE.test(c)))]
    .slice(0, SLACK_INTEL_LIMITS.digestRebuildJobsMax);
  if (max === 0 || ids.length === 0 || !(now instanceof Date) || !Number.isFinite(now.getTime())) return [];
  const today = localDateString(now, principal.timezone);
  const rows = await getDigests(principal, { channelIds: ids, dates: [today] });
  const byChannel = new Map(rows.map((r) => [r.channelId, r]));
  const nowMs = now.getTime();
  const queued: string[] = [];
  const jobs: EnqueueJobInput[] = [];
  const hour = Math.floor(nowMs / HOUR_MS);
  for (const channelId of ids) {
    if (queued.length >= max) break;
    const row = byChannel.get(channelId);
    if (row) {
      const at = Date.parse(row.builtAt ?? row.requestedAt);
      if ((row.status === "built" || row.status === "empty") && Number.isFinite(at) && nowMs - at < SLACK_INTEL_LIMITS.digestTodayMinGapMs) continue;
      if (row.status === "building" && nowMs - Date.parse(row.requestedAt) < BUILDING_FRESH_MS) {
        queued.push(channelId);
        continue;
      }
    }
    jobs.push(digestJob(principal, { channel_id: channelId, local_date: today, mode: "today" }, `slkdig:${principal.id}:${channelId}:${today}:t${hour}`, now));
    queued.push(channelId);
  }
  if (jobs.length > 0) await enqueueJobs(jobs);
  return queued;
}

/** Enqueue rebuild jobs (mode "rebuild") for blanked or retried (channel, date) pairs within digestRebuildDays of today, newest
 *  first, ≤ max; dedupe `slkdig:<p>:<channel>:<date>:r<rebuilds>` (or `:q<planLocalDate>` for the plan's nightly retry).
 *  Staggered BULK_STAGGER_SPACING_MS apart (the sweep class's budget). Returns how many were newly enqueued. */
export async function enqueueDigestRebuilds(principal: ExecPrincipal, rows: readonly { channelId: string; localDate: string; rebuilds: number }[],
  now: Date, opts: { max: number; planDate?: string }): Promise<number> {
  const max = Number.isSafeInteger(opts?.max) && opts.max > 0 ? Math.min(opts.max, SLACK_INTEL_LIMITS.digestRebuildJobsMax) : 0;
  if (max === 0 || !(now instanceof Date) || !Number.isFinite(now.getTime())) return 0;
  const planDate = opts.planDate;
  if (planDate !== undefined && (typeof planDate !== "string" || !validDate(planDate))) throw new TypeError("enqueueDigestRebuilds: malformed plan date");
  const today = localDateString(now, principal.timezone);
  const oldest = addDays(today, -SLACK_INTEL_LIMITS.digestRebuildDays);
  const seen = new Set<string>();
  const wanted = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r.channelId === "string" && CHANNEL_RE.test(r.channelId) && typeof r.localDate === "string" && validDate(r.localDate)
      && r.localDate >= oldest && r.localDate <= today && Number.isSafeInteger(r.rebuilds) && r.rebuilds >= 0)
    .sort((a, b) => (a.localDate < b.localDate ? 1 : a.localDate > b.localDate ? -1 : a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0))
    .filter((r) => {
      const key = `${r.channelId}:${r.localDate}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, max);
  if (wanted.length === 0) return 0;
  const nowMs = now.getTime();
  const jobs = wanted.map((r, i) => digestJob(principal, { channel_id: r.channelId, local_date: r.localDate, mode: "rebuild" },
    `slkdig:${principal.id}:${r.channelId}:${r.localDate}:${planDate !== undefined ? `q${planDate}` : `r${r.rebuilds}`}`,
    new Date(nowMs + i * BULK_STAGGER_SPACING_MS)));
  return (await enqueueJobs(jobs)).enqueued;
}

/** exec.slack-digest-plan's work (§3.11.3, C15; additive export, the handler's body): yesterday's build for every watched
 *  conversation active since yesterday began (≤ 60, newest activity first, staggered; RPC 6's plan mode also finishes a
 *  "so far" or capped yesterday row), then the nightly retry of the 6 days before it (failed, skipped_cap or not
 *  full-day rows whose channel still passes the policy; ≤ 30, deduped per plan date). Counts only. */
export async function runDigestPlan(principal: ExecPrincipal, state: SlackIntelState, now: Date, opts: { signal?: AbortSignal } = {}):
  Promise<{ eligible: number; planned: number; retried: number }> {
  if (state !== "ok") return { eligible: 0, planned: 0, retried: 0 };
  const tz = principal.timezone;
  const yesterday = yesterdayOf(now, tz);
  const since = dayBounds(yesterday, tz).fromTs;
  const channels = await listIntelChannels(principal, { signal: opts.signal });
  const digestible = new Map(channels.filter((c) => slackUsePolicy(state, c, "digest").allowed).map((c) => [c.channelId, c]));
  const active = [...digestible.values()]
    .filter((c) => c.lastActivityTs !== null && (tsCompare(c.lastActivityTs, since) ?? -1) >= 0)
    .sort((a, b) => (tsCompare(b.lastActivityTs as string, a.lastActivityTs as string) ?? 0) || (a.channelId < b.channelId ? -1 : 1));
  const chosen = active.slice(0, SLACK_INTEL_LIMITS.digestPlanMaxChannels);
  const nowMs = now.getTime();
  const jobs = chosen.map((c, i) => digestJob(principal, { channel_id: c.channelId, local_date: yesterday, mode: "plan" },
    `slkdig:${principal.id}:${c.channelId}:${yesterday}:p0`, new Date(nowMs + i * BULK_STAGGER_SPACING_MS)));
  const planned = jobs.length > 0 ? (await enqueueJobs(jobs, opts.signal ? { signal: opts.signal } : {})).enqueued : 0;

  // The nightly retry (intel-4).
  const dates = Array.from({ length: SLACK_INTEL_LIMITS.digestRebuildDays - 1 }, (_v, i) => addDays(yesterday, -(i + 1)));
  const rows = await getDigests(principal, { dates }, opts.signal ? { signal: opts.signal } : {});
  const retry = rows.filter((r) => digestible.has(r.channelId)
    && (r.status === "failed" || r.status === "skipped_cap" || ((r.status === "built" || r.status === "empty") && !r.fullDay)));
  const retried = retry.length > 0
    ? await enqueueDigestRebuilds(principal, retry.map((r) => ({ channelId: r.channelId, localDate: r.localDate, rebuilds: r.rebuilds })), now,
      { max: SLACK_INTEL_LIMITS.digestRetryJobs, planDate: yesterday })
    : 0;
  return { eligible: active.length, planned, retried };
}

// ---------------------------------------------------------------------------
// Reading digests (the page, the tool, the brief)
// ---------------------------------------------------------------------------

/** Ranking (§3.6): a channel linked to a client at high first, then more messages from people, then the channel id. */
function rank(a: { row: SlackDigestRow | null; channelId: string; high: boolean }, b: { row: SlackDigestRow | null; channelId: string; high: boolean }): number {
  if (a.high !== b.high) return a.high ? -1 : 1;
  const ha = a.row?.counts.human ?? -1;
  const hb = b.row?.counts.human ?? -1;
  if (ha !== hb) return hb - ha;
  return a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0;
}

const highLink = (link: SlackChannelLink | undefined): boolean => link !== undefined && link.matchConfidence === "high" && link.clientId !== null;

/** Digest rows + per-channel status for the page and the tool (§3.12.1, §3.15.2): the conversations slackUsePolicy allows for
 *  `use` (watched ones; never a 1:1 DM), each date's row as a card, and a "not built" card for a conversation with no row
 *  whose latest activity is at or after that day's start (the plan's own eligibility). Newest date first, then §3.6's
 *  ranking, cards with a row before "not built" ones; ≤ limit. Lines carry no permalink in v1. [] unless the state is ok. */
export async function listDigestViews(principal: ExecPrincipal, state: SlackIntelState, q: { dates: readonly string[]; channelIds?: readonly string[];
  use: SlackUse; limit: number }, opts?: { signal?: AbortSignal; now?: Date }): Promise<DigestCardView[]> {
  if (state !== "ok") return [];
  const limit = Number.isSafeInteger(q?.limit) && q.limit > 0 ? q.limit : 0;
  const dates = [...new Set((Array.isArray(q?.dates) ? q.dates : []).filter((d) => typeof d === "string" && validDate(d)))];
  if (limit === 0 || dates.length === 0) return [];
  const signal = opts?.signal;
  const now = opts?.now ?? new Date();
  const tz = principal.timezone;
  const channels = await listIntelChannels(principal, q.channelIds !== undefined ? { channelIds: q.channelIds, signal } : { signal });
  const allowed = new Map<string, { ch: ChannelRow; privacy: SlackPrivacy }>();
  for (const ch of channels) {
    const p = slackUsePolicy(state, ch, q.use);
    if (p.allowed && ch.convType !== "im") allowed.set(ch.channelId, { ch, privacy: p.privacy });
  }
  if (allowed.size === 0) return [];
  const ids = [...allowed.keys()];
  const [rows, links] = await Promise.all([
    getDigests(principal, { channelIds: ids, dates }, { signal }),
    listChannelLinks(principal, { channelIds: ids, signal })
  ]);
  const byKey = new Map(rows.map((r) => [`${r.channelId}:${r.localDate}`, r]));
  const today = localDateString(now, tz);
  const cards: { card: DigestCardView; row: SlackDigestRow | null; channelId: string; high: boolean }[] = [];
  for (const date of dates) {
    let since: string | null = null;
    try {
      since = dayBounds(date, tz).fromTs;
    } catch {
      since = null;
    }
    for (const [channelId, { ch, privacy }] of allowed) {
      const row = byKey.get(`${channelId}:${date}`) ?? null;
      if (row === null && (since === null || ch.lastActivityTs === null || (tsCompare(ch.lastActivityTs, since) ?? -1) < 0)) continue;
      const link = links.get(channelId);
      const high = highLink(link);
      cards.push({ card: cardOf(ch, privacy, date, row, link, today, now, state), row, channelId, high });
    }
  }
  cards.sort((a, b) => {
    if (a.card.date !== b.card.date) return a.card.date < b.card.date ? 1 : -1;
    if ((a.row === null) !== (b.row === null)) return a.row === null ? 1 : -1;
    return rank(a, b);
  });
  return cards.slice(0, limit).map((c) => c.card);
}

function cardOf(ch: ChannelRow, privacy: SlackPrivacy, date: string, row: SlackDigestRow | null, link: SlackChannelLink | undefined, today: string,
  now: Date, state: SlackIntelState): DigestCardView {
  const status: DigestStatus | "not_built" = row === null ? "not_built" : row.status;
  const built = row !== null && row.status === "built";
  const lines = (list: readonly { text: string }[] | undefined) => (built && Array.isArray(list) ? list.map((l) => ({ text: l.text, permalink: null })) : []);
  const nowMs = now.getTime();
  const builtRecently = row !== null && (row.status === "built" || row.status === "empty")
    && nowMs - Date.parse(row.builtAt ?? row.requestedAt) < SLACK_INTEL_LIMITS.digestTodayMinGapMs;
  const buildingNow = row !== null && row.status === "building" && nowMs - Date.parse(row.requestedAt) < BUILDING_FRESH_MS;
  const canBuild = date === today && !ch.isArchived && slackUsePolicy(state, ch, "digest").allowed && !builtRecently && !buildingNow;
  return {
    digestId: row?.id ?? null,
    channelId: ch.channelId,
    channelLabel: channelLabelOf(ch),
    privacy,
    date,
    status,
    summary: built ? row.summary : null,
    highlights: lines(row?.highlights),
    decisions: lines(row?.decisions),
    openQuestions: lines(row?.openQuestions),
    counts: row?.counts ?? null,
    partial: row?.partial === true,
    canBuild,
    clientName: highLink(link) ? (link as SlackChannelLink).clientName : null
  };
}

export interface BriefSlackDigest { digestId: string; channelId: string; channelLabel: string; privacy: SlackPrivacy; localDate: string;
  summary: string; decisions: string[]; openQuestions: string[]; clientId: string | null; ref: SourceRef }

/** C23, for P8. Built digests of localDate, policy "brief" (watched, never finance, never a 1:1 DM), ranked (§3.6), ≤ 6.
 *  [] unless the state is ok. A failed read throws (P8 decides how its section degrades). */
export async function listBriefSlackDigests(principal: ExecPrincipal, q: { localDate: string }, opts?: { signal?: AbortSignal }): Promise<BriefSlackDigest[]> {
  if (typeof q?.localDate !== "string" || !validDate(q.localDate)) return [];
  const signal = opts?.signal;
  const settings = await loadSettings(principal.id);
  const state = await slackIntelState(principal, settings, { signal });
  if (state !== "ok") return [];
  const channels = await listIntelChannels(principal, { signal });
  const allowed = new Map<string, { ch: ChannelRow; privacy: SlackPrivacy }>();
  for (const ch of channels) {
    const p = slackUsePolicy(state, ch, "brief");
    if (p.allowed && ch.convType !== "im") allowed.set(ch.channelId, { ch, privacy: p.privacy });
  }
  if (allowed.size === 0) return [];
  const ids = [...allowed.keys()];
  const [rows, links] = await Promise.all([
    getDigests(principal, { channelIds: ids, dates: [q.localDate], statuses: ["built"] }, { signal }),
    listChannelLinks(principal, { channelIds: ids, signal })
  ]);
  return rows
    .filter((r) => r.status === "built" && r.summary !== null && allowed.has(r.channelId))
    .map((row) => ({ row, channelId: row.channelId, high: highLink(links.get(row.channelId)) }))
    .sort(rank)
    .slice(0, SLACK_INTEL_LIMITS.briefDigests)
    .map(({ row, high }) => {
      const { ch, privacy } = allowed.get(row.channelId) as { ch: ChannelRow; privacy: SlackPrivacy };
      const label = channelLabelOf(ch);
      const link = links.get(row.channelId);
      return {
        digestId: row.id,
        channelId: row.channelId,
        channelLabel: label,
        privacy,
        localDate: row.localDate,
        summary: row.summary as string,
        decisions: row.decisions.map((l) => l.text),
        openQuestions: row.openQuestions.map((l) => l.text),
        clientId: high && link ? link.clientId : null,
        ref: slackDigestRef(row, label, privacy !== "public")
      };
    });
}

// ---------------------------------------------------------------------------
// Catch-up counts (C24, P8 M7)
// ---------------------------------------------------------------------------

/** P9 F30 (additive): the counts, and truncated: true when the read hit its row limit (each count is then a floor, shown
 *  as "N+"); the key is left out otherwise, so a count read below the limit is exactly P7b's shape. */
export interface SlackCatchUpCountsView extends SlackCatchUpCounts {
  truncated?: true;
}

/** Open items to him (C24, P8 M7's counts): P7a's screened open items ({ sinceIso: now − 14 d, limit: 200, surface: "web" }) re-screened by
 *  slackItemPolicy("page"); unanswered = needsResponse ∧ respondedAt null; decisionsPending = kind decision ∧ respondedAt null;
 *  notAssessed = !assessed. Counts above 200 read as 200 ("200+" in the tile). null unless the state is ok. Fixer ui-9: the
 *  items come from P7a's throwing readOpenSlackItems (listOpenSlackItems' read and screen), so a failed read propagates
 *  like the channel read (the caller's section fails soft: "Couldn't load", never zeros; AM-P7b-23's gap closed). `now`
 *  is additive and optional (default: the clock). */
export async function slackCatchUpCounts(principal: ExecPrincipal, state: SlackIntelState, opts?: { signal?: AbortSignal; now?: Date }): Promise<SlackCatchUpCountsView | null> {
  if (state !== "ok") return null;
  const now = opts?.now ?? new Date();
  const { items } = await readOpenSlackItems(principal, {
    sinceIso: new Date(now.getTime() - SLACK_INTEL_LIMITS.catchUpWindowDays * DAY_MS).toISOString(),
    limit: SLACK_INTEL_LIMITS.catchUpReadRows,
    surface: "web"
  });
  // P9 F30: a full page of rows means there may be more than were read (the counts are floors).
  const truncated = items.length >= SLACK_INTEL_LIMITS.catchUpReadRows;
  const counts: SlackCatchUpCounts = { unanswered: 0, decisionsPending: 0, notAssessed: 0 };
  if (items.length === 0) return counts;
  const ids = [...new Set(items.map((i) => i.channelId))];
  const channels = new Map((await listIntelChannels(principal, { channelIds: ids, signal: opts?.signal })).map((c) => [c.channelId, c]));
  for (const item of items) {
    if (!slackItemPolicy(state, channels.get(item.channelId) ?? null, item, "page").allowed) continue;
    if (item.needsResponse && item.respondedAt === null) counts.unanswered += 1;
    if (item.kind === "decision" && item.respondedAt === null) counts.decisionsPending += 1;
    if (!item.assessed) counts.notAssessed += 1;
  }
  const cap = SLACK_INTEL_LIMITS.catchUpReadRows;
  const capped: SlackCatchUpCounts = { unanswered: Math.min(counts.unanswered, cap), decisionsPending: Math.min(counts.decisionsPending, cap), notAssessed: Math.min(counts.notAssessed, cap) };
  return truncated ? { ...capped, truncated: true } : capped;
}

// ---------------------------------------------------------------------------
// since_last_brief (C22)
// ---------------------------------------------------------------------------

type BriefResolver = (p: ExecPrincipal, s: ExecSettings, now: Date) => Promise<Date | null>;
const RESOLVER_KEY = "__ddExecSinceLastBriefResolver" as const;
type GlobalWithResolver = typeof globalThis & { [RESOLVER_KEY]?: BriefResolver | null };

/** The UTC instant of `minutes` past local midnight on localDate in tz (the wall clock; the offset re-read at the guess, as
 *  startOfLocalDayUtc does, so a DST change earlier that day is honoured). */
function wallTimeUtc(localDate: string, minutes: number, tz: string): Date {
  const m = LOCAL_DATE_RE.exec(localDate) as RegExpExecArray;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Math.floor(minutes / 60), minutes % 60);
  let guess = wall - tzOffsetMinutes(new Date(wall), tz) * MIN_MS;
  guess = wall - tzOffsetMinutes(new Date(guess), tz) * MIN_MS;
  return new Date(guess);
}

/** C22: the window start for "since_last_brief": the registered resolver's Date when it gives one (P8: the delivered brief's
 *  time; a resolver that throws, answers null or answers a time after now is ignored), else the most recent
 *  brief_local_time (principal.timezone) at or before now. Async because the resolver is (bindings AM-P7b-16: §3.6 had a
 *  sync return over an async resolver). */
export async function sinceLastBrief(principal: ExecPrincipal, settings: ExecSettings, now: Date): Promise<Date> {
  const resolver = (globalThis as GlobalWithResolver)[RESOLVER_KEY] ?? null;
  if (resolver !== null) {
    try {
      const at = await resolver(principal, settings, now);
      if (at instanceof Date && Number.isFinite(at.getTime()) && at.getTime() <= now.getTime()) return at;
    } catch (err) {
      console.warn(`[exec-slack-intel] since_last_brief resolver failed (${errName(err)}); using the brief time`);
    }
  }
  const tz = principal.timezone;
  const minutes = parseLocalTime(settings.briefLocalTime) ?? parseLocalTime("08:00") ?? 480;
  const today = wallTimeUtc(localDateString(now, tz), minutes, tz);
  if (today.getTime() <= now.getTime()) return today;
  return wallTimeUtc(yesterdayOf(now, tz), minutes, tz);
}

/** P8 registers its resolver (C22); null removes it. Last registration wins. */
export function setSinceLastBriefResolver(fn: ((p: ExecPrincipal, s: ExecSettings, now: Date) => Promise<Date | null>) | null): void {
  if (fn !== null && typeof fn !== "function") throw new TypeError("setSinceLastBriefResolver: fn must be a function or null");
  (globalThis as GlobalWithResolver)[RESOLVER_KEY] = fn;
}
