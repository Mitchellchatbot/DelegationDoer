import "server-only";

import { BRIEF_OPS } from "@/lib/exec/brief-copy";
import { mayDmAt } from "@/lib/exec/brief-ownership";
import { loadBriefOwnership } from "@/lib/exec/brief-ownership-load";
import { catchUpBriefScrubs, type BriefScreen } from "@/lib/exec/brief-screen";
import { briefDmToView, renderBriefDm, renderCheckinsMessage, renderLateNote, type CheckinMessageView } from "@/lib/exec/brief-slack-ui";
import {
  deliveryStep,
  failStaleBuilds,
  getBriefById,
  listCheckinsForBrief,
  listStaleBuilt,
  listStaleDelivering,
  markDmFollowed,
  recordCheckinsMessage,
  recordLateNote
} from "@/lib/exec/brief-store";
import { BRIEF_JOB_KINDS, BRIEF_LIMITS, BRIEF_METADATA_EVENT, briefDeliverKey } from "@/lib/exec/brief-types";
import type { BriefDeliverMode, BriefDeliverPayload, BriefPageOnlyReason, BriefRow, BriefStatus, BriefUnknownReason, CheckinRow, CheckinView } from "@/lib/exec/brief-types";
import { checkinButtonValue, SecretUnavailableError } from "@/lib/exec/crypto";
import { enqueueJob, isJobLive } from "@/lib/exec/jobs";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import { appOrigin } from "@/lib/exec/refs";
import { asSlackApiError, dmPost, dmRead, errLabel } from "@/lib/exec/slack-dm";
import { openActiveInstallation, recordSlackPost } from "@/lib/exec/slack-install";
import type { OpenInstallation, SlackMessageParts } from "@/lib/exec/slack-types";
import { listUsers } from "@/lib/exec/sources/dd";
import { findDmMessageByMetadata, SlackChannelRefusedError } from "@/lib/exec/sources/slack";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";

// P8 delivery (contract §3.13.2, M2, C24, C31-C35, C48; intel-11, intel-13; Area D; server-only): the exactly-once DM of a
// built brief (CAS into delivering, Slack message metadata, a metadata lookup before any second post, never a third), the
// late note after a watchdog fallback, and the stale-row resolution the watchdog and the sweep share (never posts).
//
//   * At most two chat.postMessage calls per brief, ever: every post is counted by RPC 3 BEFORE it is made (post_attempts ≤ 2
//     is a CHECK), and the second one happens only after a metadata lookup answered "not there". An ambiguous outcome after
//     the second post, or a failed lookup, ends in delivery_unknown and an ops alert; nothing is posted again.
//   * The DM is rendered from the row catchUpBriefScrubs re-read after the post-write scrubs, through its screen (C31); a
//     failed screen keeps the brief in DD. The render happens before the CAS (it is pure), so a render failure never counts
//     a post.
//   * Every assistant-bot DM is a P6 ledger row of kind "note" (p8-bindings.md AM-P8-2). P9 F12 (a): a post the metadata
//     lookup proves landed (an ambiguous post, or a stale delivering row) gets its ledger row here, since dmPost threw before
//     it could write one (best-effort: recordSlackPost never throws and logs codes only).
//   * Results and logs carry ids, codes and counts only (§0.3 rule 4).

export type BriefDeliverResult =
  | { skipped: string }
  | { outcome: "delivered" | "delivery_unknown" | "page_only" | "late_posted"; status: BriefStatus | null; reason: string | null;
      postAttempts: number; checkins: "posted" | "none" | "failed" };

/** The Slack codes after which a post may or may not have landed (p8-bindings.md AM-P8-14). */
const AMBIGUOUS_CODES: ReadonlySet<string> = new Set([
  "timeout", "network", "bad_response", "internal_error", "fatal_error", "service_unavailable", "request_timeout"
]);
const HTTP_5XX = /^http_5[0-9][0-9]$/;
const BRIEF_ID = /^eb_[0-9a-f]{32}$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[a-z0-9_]{1,60}$/;
const MODES: readonly BriefDeliverMode[] = ["full", "same_day", "late"];

/** "Own signal" (§3.13): a fresh timeout for one Slack call, never the job's signal after it aborted. */
const ownSignal = (): AbortSignal => AbortSignal.timeout(BRIEF_LIMITS.slackCallMs);

/** appOrigin() + "/executive/brief". */
export function briefHref(): string {
  return `${appOrigin()}/executive/brief`;
}

/** The job payload, checked (references only, §0.3 rule 5); null when malformed. */
export function parseDeliverPayload(raw: unknown): BriefDeliverPayload | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.brief_id !== "string" || !BRIEF_ID.test(p.brief_id)) return null;
  if (typeof p.local_date !== "string" || !LOCAL_DATE.test(p.local_date)) return null;
  if (typeof p.rev !== "number" || !Number.isSafeInteger(p.rev) || p.rev < 1 || p.rev > 10_000) return null;
  if (typeof p.mode !== "string" || !(MODES as readonly string[]).includes(p.mode)) return null;
  return { brief_id: p.brief_id, local_date: p.local_date, rev: p.rev, mode: p.mode as BriefDeliverMode };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Slack's "ts" for an instant (seconds, six decimals). */
function tsOf(ms: number): string {
  return `${Math.max(0, Math.floor(ms / 1000))}.000000`;
}

const codeOf = (err: unknown): string => {
  const label = errLabel(err);
  return CODE.test(label) ? label.toLowerCase() : "error";
};

type PostOutcome =
  | { kind: "ok"; ts: string }
  | { kind: "ambiguous"; code: string }
  | { kind: "clear"; code: string }
  | { kind: "rate"; retryAfterMs: number };

/** M2 / C35: what one failed post proves. A refused channel or a clear Slack error: nothing posted. A rate limit: nothing
 *  posted. A timeout, a transport failure, a 5xx or Slack's own transient codes: it may have landed. Anything unknown is
 *  treated as ambiguous (a duplicate DM is worse than a missing one, which the watchdog covers). */
function classifyPostError(err: unknown): PostOutcome {
  if (err instanceof SlackChannelRefusedError || (err instanceof Error && err.name === "SlackChannelRefusedError")) return { kind: "clear", code: "channel_refused" };
  const e = asSlackApiError(err);
  if (e !== null) {
    if (e.code === "ratelimited") return { kind: "rate", retryAfterMs: typeof e.retryAfterMs === "number" && Number.isFinite(e.retryAfterMs) ? e.retryAfterMs : 30_000 };
    if (AMBIGUOUS_CODES.has(e.code) || HTTP_5XX.test(e.code)) return { kind: "ambiguous", code: CODE.test(e.code) ? e.code : "ambiguous" };
    return { kind: "clear", code: CODE.test(e.code) ? e.code : "slack_error" };
  }
  if (err instanceof NonRetryableError) return { kind: "clear", code: "fatal" };
  return { kind: "ambiguous", code: err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "timeout" : "unknown" };
}

function result(outcome: "delivered" | "delivery_unknown" | "page_only" | "late_posted", status: BriefStatus | null, reason: string | null,
  postAttempts: number, checkins: "posted" | "none" | "failed"): BriefDeliverResult {
  return { outcome, status, reason, postAttempts, checkins };
}

// --- the check-ins message (shared with the sweep and the check-in handlers) -------------------------------

/** The first whitespace-separated word of a DD name. */
function firstWord(name: unknown): string {
  return typeof name === "string" ? (name.trim().split(/\s+/)[0] ?? "").slice(0, 40) : "";
}

/** The renderer's rows: a button value (C6, from the STORED row) only while the row is proposed and unexpired. */
export async function checkinViews(principal: ExecPrincipal, rows: readonly CheckinRow[], now: Date, opts?: { signal?: AbortSignal }):
  Promise<CheckinView[]> {
  const names = new Map<string, string>();
  if (rows.length > 0) {
    try {
      for (const u of await listUsers(principal, { signal: opts?.signal })) names.set(u.id, firstWord(u.name));
    } catch (err) {
      if (opts?.signal?.aborted) throw err;
      console.warn(`[exec-brief] check-in names unavailable (principal ${principal.id}): ${errLabel(err)}`);
    }
  }
  return rows.map((row) => {
    let value: string | null = null;
    if (row.status === "proposed" && Date.parse(row.expiresAt) > now.getTime()) {
      try {
        value = checkinButtonValue({ checkinId: row.id, rev: row.rev, recipientUserId: row.recipientUserId, recipientSlackId: row.recipientSlackId, text: row.text });
      } catch (err) {
        if (!(err instanceof SecretUnavailableError) && !(err instanceof TypeError)) throw err;
        value = null;
      }
    }
    return { id: row.id, firstName: names.get(row.recipientUserId) ?? "", text: row.text, status: row.status, statusReason: row.statusReason,
      sentAt: row.sentAt, value };
  });
}

/** The check-ins message of a brief as it should look now (renderCheckinsMessage over the stored rows). */
export async function checkinsMessageParts(principal: ExecPrincipal, briefId: string, opts: { tz: string; now: Date;
  paused: CheckinMessageView["paused"]; signal?: AbortSignal; override?: { id: string; status: CheckinRow["status"] } }): Promise<SlackMessageParts | null> {
  const rows = await listCheckinsForBrief(principal, briefId, { signal: opts.signal });
  if (rows.length === 0) return null;
  const shown = opts.override ? rows.map((r) => (r.id === opts.override?.id ? { ...r, status: opts.override.status } : r)) : rows;
  return renderCheckinsMessage({ rows: await checkinViews(principal, shown, opts.now, { signal: opts.signal }), paused: opts.paused, tz: opts.tz });
}

/** C11, step 8: the separate check-ins message after the brief (or the late note), when the brief has proposed check-ins. */
async function postCheckinsMessage(principal: ExecPrincipal, inst: OpenInstallation, row: BriefRow, now: Date, checkinsEnabled: boolean):
  Promise<"posted" | "none" | "failed"> {
  try {
    const rows = await listCheckinsForBrief(principal, row.id);
    if (!rows.some((r) => r.status === "proposed")) return "none";
    const views = await checkinViews(principal, rows, now);
    const parts = renderCheckinsMessage({ rows: views, paused: checkinsEnabled ? null : "disabled", tz: row.tz });
    const { ts } = await dmPost(principal, inst, null, parts, { kind: "note" }, { signal: ownSignal() });
    if (!(await recordCheckinsMessage(row.id, ts))) console.warn(`[exec-brief] check-ins message ts not recorded (brief ${row.id})`);
    return "posted";
  } catch (err) {
    console.warn(`[exec-brief] check-ins message not posted (brief ${row.id}): ${codeOf(err)}`);
    return "failed";
  }
}

// --- the metadata lookup (step 9) ------------------------------------------------------------------------

/** found / absent / failed: one conversations.history lookup for this brief's metadata in his DM (unmetered, ≤ 2 per brief). */
async function lookupBriefMessage(inst: OpenInstallation, row: Pick<BriefRow, "id">, startedAtMs: number):
  Promise<{ found: true; ts: string } | { found: false } | { failed: true }> {
  try {
    const hit = await dmRead(inst, (target) => findDmMessageByMetadata(target, {
      channel: inst.row.dmChannelId,
      oldest: tsOf(startedAtMs - BRIEF_LIMITS.metadataLookbackMs),
      eventType: BRIEF_METADATA_EVENT,
      match: { brief_id: row.id }
    }, { signal: ownSignal() }));
    return hit === null ? { found: false } : { found: true, ts: hit.ts };
  } catch (err) {
    console.warn(`[exec-brief] delivery lookup failed (brief ${row.id}): ${codeOf(err)}`);
    return { failed: true };
  }
}

async function markUnknown(principal: ExecPrincipal, row: Pick<BriefRow, "id" | "localDate">, reason: BriefUnknownReason): Promise<boolean> {
  const moved = await deliveryStep(row.id, { from: ["delivering"], to: "delivery_unknown", countPost: false, reason });
  if (moved) {
    await notifyOps({ key: BRIEF_OPS.deliveryUnknown.key(principal.id), title: BRIEF_OPS.deliveryUnknown.title, detail: `brief ${row.id}, ${row.localDate}: ${reason}` });
  }
  return moved;
}

async function markDelivered(row: Pick<BriefRow, "id">, inst: OpenInstallation, ts: string): Promise<boolean> {
  const moved = await deliveryStep(row.id, { from: ["delivering"], to: "delivered", countPost: false, channel: inst.row.dmChannelId, ts });
  if (!moved) console.warn(`[exec-brief] delivered step refused (brief ${row.id})`);
  return moved;
}

/** P9 F12 (a): the ledger row (P6 C43, kind "note") of a brief DM the metadata lookup found: the post's own write never ran (dmPost
 *  threw first). Written whatever the CAS then answers (the DM is in Slack either way), so the DM purge deletes it at chat retention
 *  and RPC 7 v2 keeps its brief's refs while it is there. Never throws (recordSlackPost logs ids and codes on a failure). */
async function recordFoundPost(principal: ExecPrincipal, inst: OpenInstallation, ts: string): Promise<void> {
  await recordSlackPost(principal, { installationId: inst.row.id, channelId: inst.row.dmChannelId, ts, threadTs: null, kind: "note", messageId: null,
    refId: null });
}

async function enqueueLate(principal: ExecPrincipal, row: Pick<BriefRow, "id" | "localDate" | "rev">): Promise<void> {
  try {
    await enqueueJob({
      kind: BRIEF_JOB_KINDS.deliver,
      lane: "interactive",
      principalId: principal.id,
      payload: { brief_id: row.id, local_date: row.localDate, rev: row.rev, mode: "late" },
      dedupeKey: briefDeliverKey(principal.id, row.localDate, row.rev, "late"),
      maxAttempts: 1
    });
  } catch (err) {
    console.warn(`[exec-brief] late note not enqueued (brief ${row.id}): ${codeOf(err)}`);
  }
}

// --- full / same_day -------------------------------------------------------------------------------------

async function toPageOnly(row: Pick<BriefRow, "id">, from: "built" | "page_only" | "delivering", reason: BriefPageOnlyReason, errorCode?: string): Promise<boolean> {
  return deliveryStep(row.id, { from: [from], to: "page_only", countPost: false, reason, ...(errorCode !== undefined ? { errorCode } : {}) });
}

async function deliverFull(principal: ExecPrincipal, payload: BriefDeliverPayload, signal: AbortSignal): Promise<BriefDeliverResult> {
  const mode = payload.mode;
  const from: "built" | "page_only" = mode === "full" ? "built" : "page_only";
  const now = new Date();
  // 1.
  let row = await getBriefById(principal, payload.brief_id, { signal });
  if (row === null || row.localDate !== payload.local_date) return { skipped: "not_found" };
  // 2.
  const settings = await loadSettings(principal.id);
  const own = await loadBriefOwnership(principal, settings, row.localDate, now, { signal });
  if (own.verdict.owner !== "exec") {
    if (mode === "same_day") return { skipped: "not_owned" };
    const moved = await toPageOnly(row, "built", "ownership_lapsed");
    return moved ? result("page_only", "page_only", "ownership_lapsed", row.postAttempts, "none") : { skipped: "not_won" };
  }
  // 3.
  if (!mayDmAt(now, row.localDate, new Date(row.scheduledAt), row.tz)) {
    if (mode === "same_day") return { skipped: "after_cutoff" };
    const moved = await toPageOnly(row, "built", "after_cutoff");
    if (moved) {
      await notifyOps({ key: BRIEF_OPS.late.key(principal.id), title: BRIEF_OPS.late.title, detail: `brief ${row.id}, ${row.localDate}: after_cutoff` });
    }
    return moved ? result("page_only", "page_only", "after_cutoff", row.postAttempts, "none") : { skipped: "not_won" };
  }
  // 4.
  let inst: OpenInstallation | null;
  try {
    inst = await openActiveInstallation(principal, { signal });
  } catch (err) {
    if (!(err instanceof SecretUnavailableError)) throw err;
    const moved = await toPageOnly(row, from, "delivery_failed", "token_unavailable");
    return moved ? result("page_only", "page_only", "delivery_failed", row.postAttempts, "none") : { skipped: "not_won" };
  }
  if (inst === null) {
    const moved = await toPageOnly(row, from, "no_installation");
    return moved ? result("page_only", "page_only", "no_installation", row.postAttempts, "none") : { skipped: "not_won" };
  }
  // 4b. The post-write catch-up and the render-time screen (intel-13, C31): never a post on a failed screen.
  let screen: BriefScreen;
  try {
    const c = await catchUpBriefScrubs(principal, settings, row.id, { now, signal: ownSignal() });
    if (!c.ok) {
      if (c.reason === "not_found") return { skipped: "not_found" };
      throw new Error("screen_unavailable");
    }
    row = c.row;
    screen = c.screen;
  } catch (err) {
    if (signal.aborted) throw err;
    if (mode === "same_day") return { skipped: "screen_unavailable" };
    const moved = await toPageOnly(row, "built", "screen_unavailable");
    return moved ? result("page_only", "page_only", "screen_unavailable", row.postAttempts, "none") : { skipped: "not_won" };
  }
  // 6 (before the CAS: pure, so a render failure never counts a post).
  if (row.content === null) {
    const moved = await toPageOnly(row, from, "delivery_failed", "no_content");
    return moved ? result("page_only", "page_only", "delivery_failed", row.postAttempts, "none") : { skipped: "not_won" };
  }
  let parts: SlackMessageParts;
  try {
    parts = renderBriefDm(briefDmToView(row.content, { tz: row.tz, briefHref: briefHref(), screen }));
  } catch (err) {
    await toPageOnly(row, from, "delivery_failed", "dm_over_budget");
    console.error(`[exec-brief] brief DM over budget (brief ${row.id}): ${errLabel(err)}`);
    throw new NonRetryableError("dm_over_budget");
  }
  // 5. The CAS (RPC 3 counts the post before it is made).
  const startMs = Date.now();
  if (!(await deliveryStep(row.id, { from: [from], to: "delivering", countPost: true }))) {
    const fresh = await getBriefById(principal, row.id, { signal });
    if (mode === "full" && fresh !== null && fresh.status === "built" && fresh.fallbackSentAt !== null) {
      // C34 / C48 (intel-11): the watchdog claimed while this job waited; RPC 3 refuses delivering after a fallback.
      if (await toPageOnly(fresh, "built", "after_fallback")) await enqueueLate(principal, fresh);
      return { skipped: "after_fallback" };
    }
    return { skipped: "not_won" };
  }
  const started = await getBriefById(principal, row.id).catch(() => null);
  const startedAtMs = started !== null && started.deliveryStartedAt !== null && Number.isFinite(Date.parse(started.deliveryStartedAt))
    ? Date.parse(started.deliveryStartedAt) : startMs;
  return postLoop(principal, inst, row, parts, startedAtMs, settings.checkinsEnabled, signal, now);
}

/** Steps 7-11: post, classify, recover through the metadata lookup; at most two posts, ever. */
async function postLoop(principal: ExecPrincipal, inst: OpenInstallation, row: BriefRow, parts: SlackMessageParts, startedAtMs: number,
  checkinsEnabled: boolean, signal: AbortSignal, now: Date): Promise<BriefDeliverResult> {
  const metadata = { event_type: BRIEF_METADATA_EVENT, event_payload: { brief_id: row.id, rev: row.rev } };
  const post = async (): Promise<PostOutcome> => {
    try {
      const { ts } = await dmPost(principal, inst, null, parts, { kind: "note" }, { signal: ownSignal(), metadata });
      return { kind: "ok", ts };
    } catch (err) {
      return classifyPostError(err);
    }
  };
  let counted = row.postAttempts + 1;
  /** found: the ts came from the metadata lookup (P9 F12 (a): its ledger row is written here). */
  const delivered = async (ts: string, found = false): Promise<BriefDeliverResult> => {
    if (found) await recordFoundPost(principal, inst, ts);
    const moved = await markDelivered(row, inst, ts);
    // P8 fixer security-4: the DM was rendered from this row, after its catch-up's scrubs; those are already in the DM, so they
    // need no C15 follow-up. Only a scrub later than the render (a newer scrubbed_at) replaces the DM.
    if (moved && row.scrubbedAt !== null) {
      try {
        await markDmFollowed(row.id, row.scrubbedAt);
      } catch (err) {
        console.warn(`[exec-brief] rendered scrub not recorded (brief ${row.id}): ${codeOf(err)}`);
      }
    }
    const checkins = moved ? await postCheckinsMessage(principal, inst, row, now, checkinsEnabled) : "none";
    return result("delivered", moved ? "delivered" : null, null, counted, checkins);
  };
  const unknown = async (reason: BriefUnknownReason): Promise<BriefDeliverResult> => {
    const moved = await markUnknown(principal, row, reason);
    // P9 fixer correctness-1 (as `delivered` above, P8 fixer security-4): any copy of this DM that did land was rendered from
    // this row, after its catch-up's scrubs, so those scrubs need no F12 (b) follow-up; a later scrub (a newer scrubbed_at)
    // still gets one. resolveDelivering is different: its row's scrub may postdate the render, so it records nothing.
    if (moved && row.scrubbedAt !== null) {
      try {
        await markDmFollowed(row.id, row.scrubbedAt);
      } catch (err) {
        console.warn(`[exec-brief] rendered scrub not recorded (brief ${row.id}): ${codeOf(err)}`);
      }
    }
    return result("delivery_unknown", moved ? "delivery_unknown" : null, reason, counted, "none");
  };
  const pageOnly = async (reason: BriefPageOnlyReason, code: string): Promise<BriefDeliverResult> => {
    const moved = await toPageOnly(row, "delivering", reason, code);
    return result("page_only", moved ? "page_only" : null, reason, counted, "none");
  };
  /** One more counted post, only while RPC 3 allows it (false when post_attempts is already 2). */
  const countAnother = async (): Promise<boolean> => {
    if (counted >= BRIEF_LIMITS.maxPostAttempts) return false;
    const ok = await deliveryStep(row.id, { from: ["delivering"], to: "delivering", countPost: true });
    if (ok) counted += 1;
    return ok;
  };

  let outcome = await post();
  for (;;) {
    if (outcome.kind === "ok") return delivered(outcome.ts);
    if (outcome.kind === "clear") return pageOnly("delivery_failed", outcome.code);
    if (outcome.kind === "rate") {
      // C35: nothing was posted. One retry after Retry-After when it is short and a post is still allowed.
      if (outcome.retryAfterMs <= BRIEF_LIMITS.rateLimitedRetryMaxMs && counted < BRIEF_LIMITS.maxPostAttempts) {
        await wait(outcome.retryAfterMs, signal);
        if (!(await countAnother())) return pageOnly("rate_limited", "ratelimited");
        outcome = await post();
        continue;
      }
      return pageOnly("rate_limited", "ratelimited");
    }
    // Ambiguous: wait, then look for the message before anything else (M2).
    await wait(BRIEF_LIMITS.ambiguityRecheckDelayMs, signal);
    const hit = await lookupBriefMessage(inst, row, startedAtMs);
    if ("failed" in hit) return unknown("lookup_failed");
    if (hit.found) return delivered(hit.ts, true);
    // Proven absent: one more post, only if RPC 3 still counts one (never a third).
    if (!(await countAnother())) return unknown("ambiguous_twice");
    outcome = await post();
    if (outcome.kind === "ambiguous") {
      await wait(BRIEF_LIMITS.ambiguityRecheckDelayMs, signal);
      const again = await lookupBriefMessage(inst, row, startedAtMs);
      if ("found" in again && again.found) return delivered(again.ts, true);
      return unknown("failed" in again ? "lookup_failed" : "ambiguous_twice");
    }
  }
}

// --- late (C34) ----------------------------------------------------------------------------------------------

async function deliverLate(principal: ExecPrincipal, payload: BriefDeliverPayload, signal: AbortSignal): Promise<BriefDeliverResult> {
  const now = new Date();
  const row = await getBriefById(principal, payload.brief_id, { signal });
  if (row === null || row.localDate !== payload.local_date) return { skipped: "not_found" };
  if (row.fallbackSentAt === null) return { skipped: "no_fallback" };
  if (row.lateNoteTs !== null) return { skipped: "already" };
  const settings = await loadSettings(principal.id);
  const own = await loadBriefOwnership(principal, settings, row.localDate, now, { signal });
  if (own.verdict.owner !== "exec") return { skipped: "not_owned" };
  if (!mayDmAt(now, row.localDate, new Date(row.scheduledAt), row.tz)) return { skipped: "after_cutoff" };
  let inst: OpenInstallation | null;
  try {
    inst = await openActiveInstallation(principal, { signal });
  } catch (err) {
    if (!(err instanceof SecretUnavailableError)) throw err;
    return { skipped: "token_unavailable" };
  }
  if (inst === null) return { skipped: "no_installation" };
  let ts: string;
  try {
    // No metadata recovery: a duplicate one-liner is harmless, and this one is never retried.
    ({ ts } = await dmPost(principal, inst, null, renderLateNote(briefHref()), { kind: "note" }, { signal: ownSignal() }));
  } catch (err) {
    console.warn(`[exec-brief] late note not posted (brief ${row.id}): ${codeOf(err)}`);
    return { skipped: "late_not_posted" };
  }
  if (!(await recordLateNote(row.id, ts))) console.warn(`[exec-brief] late note ts not recorded (brief ${row.id})`);
  const checkins = await postCheckinsMessage(principal, inst, { ...row, lateNoteTs: ts }, now, settings.checkinsEnabled);
  return result("late_posted", row.status, null, row.postAttempts, checkins);
}

/** exec.brief-deliver's body: modes full / same_day (§3.13.2 steps 1-11) and late (C34). Codes only in the result. */
export async function deliverBrief(principal: ExecPrincipal, payload: BriefDeliverPayload, signal: AbortSignal): Promise<BriefDeliverResult> {
  const p = parseDeliverPayload(payload);
  if (p === null) return { skipped: "bad_payload" };
  return p.mode === "late" ? deliverLate(principal, p, signal) : deliverFull(principal, p, signal);
}

// --- stale rows (shared by the watchdog's step 3 and the sweep's step 4; never posts) ----------------------------

/** A stale 'delivering' row: the step-9 lookup; found → delivered, else delivery_unknown stale_delivering (+ ops). Never a post. */
async function resolveDelivering(principal: ExecPrincipal, row: BriefRow): Promise<void> {
  let inst: OpenInstallation | null = null;
  try {
    inst = await openActiveInstallation(principal);
  } catch (err) {
    console.warn(`[exec-brief] stale delivery: installation unavailable (brief ${row.id}): ${codeOf(err)}`);
  }
  if (inst !== null) {
    const startedMs = row.deliveryStartedAt !== null && Number.isFinite(Date.parse(row.deliveryStartedAt)) ? Date.parse(row.deliveryStartedAt) : Date.parse(row.updatedAt);
    const hit = await lookupBriefMessage(inst, row, Number.isFinite(startedMs) ? startedMs : Date.now());
    if ("found" in hit && hit.found) {
      await recordFoundPost(principal, inst, hit.ts);
      await markDelivered(row, inst, hit.ts);
      return;
    }
  }
  await markUnknown(principal, row, "stale_delivering");
}

/** Shared by the watchdog (step 3) and the sweep (step 4); never posts: stale building → failed (+ ops), stale delivering →
 *  the metadata lookup (delivered / delivery_unknown), stale built with no live full deliver job → page_only (C48). */
export async function resolveStaleRows(principal: ExecPrincipal, now: Date, signal: AbortSignal):
  Promise<{ staleBuild: number; neverBuilt: number; staleDelivering: number; staleBuilt: number }> {
  const nowMs = now.getTime();
  const failed = await failStaleBuilds(principal, now);
  for (const id of failed.staleBuild) {
    await notifyOps({ key: BRIEF_OPS.failed.key(principal.id), title: BRIEF_OPS.failed.title, detail: `brief ${id}: stale_build` });
  }
  signal.throwIfAborted();

  let staleDelivering = 0;
  for (const row of await listStaleDelivering(principal, new Date(nowMs - BRIEF_LIMITS.staleDeliveringMs))) {
    signal.throwIfAborted();
    try {
      await resolveDelivering(principal, row);
      staleDelivering += 1;
    } catch (err) {
      console.warn(`[exec-brief] stale delivery not resolved (brief ${row.id}): ${codeOf(err)}`);
    }
  }

  let staleBuilt = 0;
  for (const row of await listStaleBuilt(principal, new Date(nowMs - BRIEF_LIMITS.staleBuiltMs))) {
    signal.throwIfAborted();
    try {
      // An unknown answer counts as live: a row is never moved on a guess (AM-P8-20).
      const live = await isJobLive(briefDeliverKey(principal.id, row.localDate, row.rev, "full"), { signal }).catch(() => true);
      if (live) continue;
      const reason: BriefPageOnlyReason = row.fallbackSentAt !== null ? "after_fallback" : "delivery_failed";
      if (!(await toPageOnly(row, "built", reason, "stale_built"))) continue;
      staleBuilt += 1;
      if (reason === "after_fallback") {
        await enqueueLate(principal, row);
      } else {
        await notifyOps({ key: BRIEF_OPS.failed.key(principal.id), title: BRIEF_OPS.failed.title, detail: `brief ${row.id}, ${row.localDate}: stale_built` });
      }
    } catch (err) {
      console.warn(`[exec-brief] stale built row not resolved (brief ${row.id}): ${codeOf(err)}`);
    }
  }
  return { staleBuild: failed.staleBuild.length, neverBuilt: failed.neverBuilt.length, staleDelivering, staleBuilt };
}
