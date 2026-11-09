import "server-only";

import { createHash } from "node:crypto";

import { withOwnSignal } from "@/lib/exec/agent/signal";
import { redactChatMessage } from "@/lib/exec/chat-store";
import { enqueueJob } from "@/lib/exec/jobs";
import { enqueueDigestRebuilds } from "@/lib/exec/slack-digests";
import { SLACK_REDACTED_TEXT, SLACK_UNCHECKED_TEXT } from "@/lib/exec/slack-intel-copy";
import {
  blankAllDigests,
  blankDigests,
  forgetSlackIntelChannels,
  getDigests,
  listOrphanSlackChannels,
  recheckSlackRpc,
  redactSlackRpc
} from "@/lib/exec/slack-intel-store";
import {
  SLACK_INTEL_JOB_KINDS,
  SLACK_INTEL_LIMITS,
  compareTs,
  localDateOfTs,
  slackDigestKey,
  slackMessageKey,
  tsOfDate,
  type SlackDigestRow,
  type SlackIntelSweepPayload
} from "@/lib/exec/slack-intel-types";
import { getSlackReadingState, listAuthorOptouts, listPurgeLog } from "@/lib/exec/slack-reading";
import { getSyncState, putSyncState } from "@/lib/exec/sync-state";
import type { ExecPrincipal } from "@/lib/exec/types";

// Chat redaction for Slack (P7b contract §3.9, N13, N15, C27, C32, C33; Area D; server-only): redaction by message key,
// digest key, channel or all (RPC 10, which hands each hit to P5b's exec_chat_redact_message, so P5b's redaction rules and
// P6's redacted_at follow-up apply unchanged), the post-finish recheck (RPC 11, fail closed), the sweep kick, and the
// deletion follow-ups the sweep runs over P7a's purge outbox (listPurgeLog, an id cursor in exec_sync_state
// "slack-intel" / "purge-log"). There is no purge hook: P7a's purges run inside its SQL and append to the outbox.
//
// followSlackPurges, one pass (§3.11.4 steps 2-5):
//   2  the outbox after the cursor, in batches of 500 until fewer remain or the time box ends: `message` rows blank the
//      digests whose source_ts hold the ts (the ts's local date ± 1 day) and give their message keys and the digest keys
//      of that (channel, day) to the redaction; `conversation` rows (every reason but rekey: a re-key's placeholder purge
//      names the new id, whose rows the re-key just moved there) forget the channel's digests and deny/hub tags (RPC 14)
//      and redact by channel; a `reading` row redacts every Slack-consulting answer. Then the rebuilds of the removed days
//      (≤ 7 days back, channels not forgotten), and only then the cursor moves. A throw anywhere leaves it where it was:
//      the job retries and every step is idempotent.
//      Fixer correctness-2 / correctness-3 / security-4: the digest keys don't come only from what RPC 8 blanked (a retry,
//      a second sweep, a same-generation "today" or plan rebuild that already dropped the ts, or RPC 7's deleted_source
//      finish leave nothing to blank, yet answers that consulted the earlier version still hold its key). They come from
//      the (channel, day) rows themselves, read after the blank: every generation 0..rebuilds of each row whose window
//      could have held the ts. Fail closed: an answer that consulted a later, clean version of that day is redacted too.
//      The rebuilds are queued for every stale row of those days (the blank's, an earlier attempt's, a deleted_source
//      finish's), deduplicated by their generation.
//      Fixer correctness-1: an outbox id is allocated at insert, not at commit, so a lower id can commit after a higher
//      one. The stored cursor never passes a row younger than OUTBOX_SETTLE_MS (it can still have an uncommitted lower
//      neighbour); rows past the cursor that were already followed are kept in `done` and skipped, never followed twice.
//   3  the scan arm (what the 7-day outbox no longer holds): RPC 14 with p_scan and RPC 12's lost channels → redact.
//   4  the author opt-outs (C33): a new member (the fingerprint moved and the set didn't shrink) blanks every digest,
//      rebuilds the last 7 days, redacts every Slack answer; a shrinking set only stores the new fingerprint.
//   5  the backstop: P7a's view revoked or bot_not_connected → redact all (P7a's `error` redacts nothing).
// Counts and a boolean only; logs carry the principal id and codes. Never a key list, a ts or a channel name.

const L = SLACK_INTEL_LIMITS;
const SOURCE = "slack-intel" as const;
const MIN_MS = 60_000;
/** Fixer correctness-1: how long an outbox row is held back from the cursor (P7a's purges are single short transactions). */
const OUTBOX_SETTLE_MS = 15 * MIN_MS;
/** The followed-but-not-yet-passed outbox ids kept in the cursor (above it, a pass follows them once). */
const OUTBOX_DONE_MAX = 2_000;
const RECHECK_MS = 10_000;
const SWEEP_MAX_ATTEMPTS = 3;
const CHANNEL = /^[CGD][A-Z0-9]{2,30}$/;
const TS = /^[0-9]{1,12}\.[0-9]{1,8}$/;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const FP = /^[0-9a-f]{12}$/;

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "error");
const logId = (id: unknown): string => (typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "unknown");

/** Redact by keys/channels/all, in chunks of 500 keys (C27's text). Returns the count. Throws on a store error. */
export async function redactChatForSlack(principal: ExecPrincipal, input: { messageKeys: readonly string[]; digestKeys: readonly string[];
  channelIds: readonly string[]; all: boolean }, opts?: { signal?: AbortSignal }): Promise<number> {
  const messageKeys = [...new Set(Array.isArray(input?.messageKeys) ? input.messageKeys : [])];
  const digestKeys = [...new Set(Array.isArray(input?.digestKeys) ? input.digestKeys : [])];
  const channelIds = [...new Set(Array.isArray(input?.channelIds) ? input.channelIds : [])];
  const all = input?.all === true;
  if (!all && messageKeys.length + digestKeys.length + channelIds.length === 0) return 0;
  // The store chunks at 500 keys + channels per RPC 10 call (its guard) and drops malformed keys.
  return redactSlackRpc(principal, { messageKeys, digestKeys, channelIds, all, text: SLACK_REDACTED_TEXT }, opts?.signal ? { signal: opts.signal } : {});
}

/** After the finish write (turn.ts, own 10 s controller): RPC 11; a failure is retried once; a second failure redacts THIS message only
 *  with SLACK_UNCHECKED_TEXT through P5b's redactChatMessage (fail closed, P5b C21 (4)). */
export async function recheckSlackAnswer(principal: ExecPrincipal, messageId: string): Promise<"clean" | "redacted" | "unchecked"> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Never the request's or the turn's signal: a Stop must not skip the check of what was stored.
      const redacted = await withOwnSignal(RECHECK_MS, (signal) => recheckSlackRpc(principal, messageId, SLACK_REDACTED_TEXT, { signal }));
      return redacted ? "redacted" : "clean";
    } catch (err) {
      console.warn(`[exec-slack-intel] post-finish recheck failed message=${logId(messageId)} (${errName(err)})`);
    }
  }
  try {
    await withOwnSignal(RECHECK_MS, (signal) => redactChatMessage(principal, messageId, SLACK_UNCHECKED_TEXT, { signal }));
  } catch (err) {
    console.warn(`[exec-slack-intel] unchecked redaction write failed message=${logId(messageId)} (${errName(err)})`);
  }
  await kickSlackIntelSweep(principal.id, "finish_recheck");
  return "unchecked";
}

/** Enqueue exec.slack-intel-sweep now (bulk, dedupe slkintel:<p>:<reason>:m<epochMinute>). Never throws. Called after a recheck
 *  failure; there is no purge hook (C32: the sweep follows P7a's purge outbox). */
export async function kickSlackIntelSweep(principalId: string, reason: SlackIntelSweepPayload["reason"]): Promise<void> {
  try {
    if (typeof principalId !== "string" || principalId.length === 0) return;
    const why: SlackIntelSweepPayload["reason"] = reason === "finish_recheck" ? "finish_recheck" : "schedule";
    const minute = Math.floor(Date.now() / MIN_MS);
    const payload: SlackIntelSweepPayload = { reason: why };
    await enqueueJob({
      kind: SLACK_INTEL_JOB_KINDS.sweep,
      lane: "bulk",
      principalId,
      payload: { ...payload },
      dedupeKey: `slkintel:${principalId}:${why}:m${minute}`,
      maxAttempts: SWEEP_MAX_ATTEMPTS
    });
  } catch (err) {
    console.warn(`[exec-slack-intel] sweep kick failed principal=${logId(principalId)} (${errName(err)})`);
  }
}

// ---------------------------------------------------------------------------
// The sweep's deletion follow-ups (C32, C33)
// ---------------------------------------------------------------------------

function parsePurgeCursor(raw: unknown): { afterId: number; done: number[] } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = (raw as { afterId?: unknown }).afterId;
  if (!(typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) return null;
  const d = (raw as { done?: unknown }).done;
  const done = Array.isArray(d) ? d.filter((x): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > v) : [];
  return { afterId: v, done };
}

function parseOptoutState(raw: unknown): { fp: string; count: number } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { fp, count } = raw as { fp?: unknown; count?: unknown };
  if (typeof fp !== "string" || !(fp === "" || FP.test(fp)) || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
  return { fp, count };
}

/** "YYYY-MM-DD" ± n days (calendar arithmetic). */
function shiftDate(localDate: string, n: number): string | null {
  const m = YMD.exec(localDate);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n)).toISOString().slice(0, 10);
}

/** The local dates a deleted ts can belong to: its own in his zone ± 1 day (a digest's day is in the zone it was built in). */
function datesAround(ts: string, tz: string): string[] {
  let day: string;
  try {
    day = localDateOfTs(ts, tz);
  } catch {
    return [];
  }
  return [shiftDate(day, -1), day, shiftDate(day, 1)].filter((d): d is string => d !== null);
}

/** The local dates enqueueDigestRebuilds accepts: today and the digestRebuildDays before it, in his zone. */
function rebuildWindow(now: Date, tz: string): string[] {
  const today = localDateIn(tsOfDate(now), tz);
  if (today === null) return [];
  return Array.from({ length: L.digestRebuildDays + 1 }, (_v, i) => shiftDate(today, -i)).filter((d): d is string => d !== null);
}

/** C33: the first 12 hex of sha256 over the sorted opted-out author ids (never the ids themselves). */
export function optoutFingerprint(ids: readonly string[]): { fp: string; count: number } {
  const sorted = [...new Set(ids.filter((i) => typeof i === "string" && i.length > 0))].sort();
  return { fp: createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex").slice(0, 12), count: sorted.length };
}

type Counts = { logRows: number; digestsBlanked: number; channelsForgotten: number; redacted: number; rebuildsQueued: number; optoutsActed: boolean };
type Blanked = { channelId: string; localDate: string; rebuilds: number };

function tsCmp(a: string, b: string): number | null {
  try {
    return compareTs(a, b);
  } catch {
    return null;
  }
}
function localDateIn(ts: string, tz: string): string | null {
  try {
    return localDateOfTs(ts, tz);
  } catch {
    return null;
  }
}

/** Could any version of this (channel, day) digest have held `ts`? Every version read history only up to the row's current
 *  to_ts (a reclaim only moves it later), so a ts after it never was; else the ts must fall on that day in the zone the row
 *  was claimed in, or in his zone now, or inside the row's [from_ts, to_ts] (a malformed bound fails closed: true). */
function rowCouldHold(row: SlackDigestRow, ts: string, tz: string): boolean {
  const toCmp = tsCmp(ts, row.toTs);
  if (toCmp !== null && toCmp > 0) return false;
  if (localDateIn(ts, row.tz) === row.localDate || localDateIn(ts, tz) === row.localDate) return true;
  const fromCmp = tsCmp(ts, row.fromTs);
  return toCmp === null || fromCmp === null || fromCmp >= 0;
}

/** Every generation's key of a (channel, day) row: 0..rebuilds (the blank's old generation included). */
function generationKeys(row: Pick<SlackDigestRow, "channelId" | "localDate" | "rebuilds">): string[] {
  const top = Number.isSafeInteger(row.rebuilds) && row.rebuilds >= 0 ? Math.min(row.rebuilds, 1000) : 0;
  return Array.from({ length: top + 1 }, (_v, k) => slackDigestKey(row.channelId, row.localDate, k));
}

/** One outbox batch: blank, forget, redact, rebuild. The cursor is the caller's to move, after this returns. */
async function followBatch(principal: ExecPrincipal, rows: Awaited<ReturnType<typeof listPurgeLog>>, counts: Counts, now: Date, signal: AbortSignal): Promise<void> {
  const tz = principal.timezone;
  const messages = new Map<string, Set<string>>();
  const conversations = new Set<string>();
  let all = false;
  for (const r of rows) {
    if (r.scope === "reading") all = true;
    else if (r.scope === "conversation") {
      if (r.reason !== "rekey" && typeof r.channelId === "string" && CHANNEL.test(r.channelId)) conversations.add(r.channelId);
    } else if (r.scope === "message" && typeof r.channelId === "string" && CHANNEL.test(r.channelId) && typeof r.ts === "string" && TS.test(r.ts)) {
      let set = messages.get(r.channelId);
      if (!set) messages.set(r.channelId, (set = new Set()));
      set.add(r.ts);
    }
  }
  const messageKeys: string[] = [];
  const digestKeys = new Set<string>();
  const rebuild = new Map<string, Blanked>();
  for (const [channelId, tsSet] of messages) {
    const ts = [...tsSet];
    for (const t of ts) messageKeys.push(slackMessageKey(channelId, t));
    // A channel forgotten in this batch loses every digest anyway, and its answers are redacted by channel.
    if (conversations.has(channelId)) continue;
    const dates = [...new Set(ts.flatMap((t) => datesAround(t, tz)))];
    if (dates.length === 0) continue;
    const blanked = await blankDigests(principal, channelId, ts, dates);
    counts.digestsBlanked += blanked.length;
    for (const b of blanked) digestKeys.add(slackDigestKey(b.channelId, b.localDate, b.oldRebuilds));
    // The days' rows as they are now, after the blank (raw: the opt-out read guard is for readers, not for the sweep).
    for (const row of await getDigests(principal, { channelIds: [channelId], dates }, { signal, raw: true })) {
      if (row.channelId !== channelId) continue;
      if (ts.some((t) => rowCouldHold(row, t, tz))) for (const k of generationKeys(row)) digestKeys.add(k);
      if (row.status === "stale") rebuild.set(`${row.channelId}:${row.localDate}`, { channelId: row.channelId, localDate: row.localDate, rebuilds: row.rebuilds });
    }
  }
  signal.throwIfAborted();
  if (conversations.size > 0) {
    const forgotten = await forgetSlackIntelChannels(principal, [...conversations], { scan: false, signal });
    counts.channelsForgotten += forgotten.length;
  }
  counts.redacted += await redactChatForSlack(principal, { messageKeys, digestKeys: [...digestKeys], channelIds: [...conversations], all }, { signal });
  const queue = [...rebuild.values()].filter((b) => !conversations.has(b.channelId));
  if (queue.length > 0) counts.rebuildsQueued += await enqueueDigestRebuilds(principal, queue, now, { max: L.digestRebuildJobsMax });
}

/** Fixer correctness-1: the cursor after a pass. Every row read has been followed; the stored afterId passes only rows older
 *  than OUTBOX_SETTLE_MS (and the ids below them), the rest stay in `done`. Past OUTBOX_DONE_MAX held ids, the oldest are let
 *  go (the cursor jumps to them). */
function nextCursor(afterId: number, followed: ReadonlyMap<number, string>, nowMs: number): { afterId: number; done: number[] } {
  let cursor = afterId;
  for (const [id, createdAt] of followed) {
    const at = Date.parse(createdAt);
    if (id > cursor && Number.isFinite(at) && at < nowMs - OUTBOX_SETTLE_MS) cursor = id;
  }
  const done = [...followed.keys()].filter((id) => id > cursor).sort((a, b) => a - b);
  if (done.length > OUTBOX_DONE_MAX) cursor = done[done.length - OUTBOX_DONE_MAX - 1];
  return { afterId: cursor, done: done.filter((id) => id > cursor) };
}

/** C32 + C33: one pass of the deletion follow-ups (§3.11.4 steps 2–5). Returns counts only; throws on a store or redaction error
 *  (the job retries; no cursor moved past an unfinished batch). `deadlineMs` is the time box, a duration from the call
 *  (the sweep passes 60 s): no new outbox batch starts after it. */
export async function followSlackPurges(principal: ExecPrincipal, opts: { now: Date; signal: AbortSignal; deadlineMs: number }):
  Promise<{ logRows: number; digestsBlanked: number; channelsForgotten: number; redacted: number; rebuildsQueued: number; optoutsActed: boolean }> {
  const { now, signal } = opts;
  const started = Date.now();
  const box = Number.isFinite(opts.deadlineMs) && opts.deadlineMs > 0 ? Math.min(opts.deadlineMs, L.sweepTimeBoxMs) : L.sweepTimeBoxMs;
  const counts: Counts = { logRows: 0, digestsBlanked: 0, channelsForgotten: 0, redacted: 0, rebuildsQueued: 0, optoutsActed: false };

  // 2. The outbox (C32).
  const stored = (await getSyncState(principal, SOURCE, "purge-log", parsePurgeCursor, { signal }))?.value ?? { afterId: 0, done: [] };
  let cursor = stored.afterId;
  // Every id above the cursor already followed (the held ones and this pass's), with its created_at ("" = held: not yet passed).
  const followed = new Map<number, string>(stored.done.map((id) => [id, ""]));
  let readAfter = cursor;
  for (;;) {
    signal.throwIfAborted();
    if (Date.now() - started >= box) break;
    const rows = await listPurgeLog(principal, readAfter, L.purgeLogBatch);
    if (rows.length === 0) break;
    const fresh = rows.filter((r) => !followed.has(r.id));
    if (fresh.length > 0) await followBatch(principal, fresh, counts, now, signal);
    for (const r of rows) followed.set(r.id, r.createdAt);
    readAfter = rows.reduce((m, r) => (r.id > m ? r.id : m), readAfter);
    // Only now: the batch's forget and redaction succeeded.
    const next = nextCursor(cursor, followed, now.getTime());
    await putSyncState(principal, SOURCE, "purge-log", next.done.length > 0 ? next : { afterId: next.afterId }, { signal });
    cursor = next.afterId;
    for (const id of [...followed.keys()]) if (id <= cursor) followed.delete(id);
    counts.logRows += fresh.length;
    if (rows.length < L.purgeLogBatch) break;
  }

  // 3. The scan arm: conversations now deny/hub/unclassified or left that still hold digests, and lost consulted channels.
  signal.throwIfAborted();
  const scanned = await forgetSlackIntelChannels(principal, [], { scan: true, signal });
  counts.channelsForgotten += scanned.length;
  const orphans = await listOrphanSlackChannels(principal, 200, { signal });
  const lost = [...new Set([...scanned.map((s) => s.channelId), ...orphans])];
  if (lost.length > 0) counts.redacted += await redactChatForSlack(principal, { messageKeys: [], digestKeys: [], channelIds: lost, all: false }, { signal });

  // 4. Author opt-outs (C33).
  signal.throwIfAborted();
  const { fp, count } = optoutFingerprint(await listAuthorOptouts(principal));
  const previous = (await getSyncState(principal, SOURCE, "optouts", parseOptoutState, { signal }))?.value ?? { fp: "", count: 0 };
  if (fp !== previous.fp) {
    if (count > 0 && count >= previous.count) {
      const all = await blankAllDigests(principal);
      counts.digestsBlanked += all.length;
      const rows = new Map<string, Blanked>(all.map((b) => [`${b.channelId}:${b.localDate}`, { channelId: b.channelId, localDate: b.localDate, rebuilds: b.oldRebuilds + 1 }]));
      // Fixer correctness-2: a retry after the blank finds nothing left to blank, so the rebuilds also come from the stale
      // rows of the rebuild window (deduplicated by their generation).
      for (const r of await getDigests(principal, { dates: rebuildWindow(now, principal.timezone), statuses: ["stale"] }, { signal, raw: true })) {
        rows.set(`${r.channelId}:${r.localDate}`, { channelId: r.channelId, localDate: r.localDate, rebuilds: r.rebuilds });
      }
      // enqueueDigestRebuilds keeps the last 7 days, newest first, ≤ 200.
      if (rows.size > 0) counts.rebuildsQueued += await enqueueDigestRebuilds(principal, [...rows.values()], now, { max: L.digestRebuildJobsMax });
      counts.redacted += await redactChatForSlack(principal, { messageKeys: [], digestKeys: [], channelIds: [], all: true }, { signal });
      counts.optoutsActed = true;
    }
    await putSyncState(principal, SOURCE, "optouts", { fp, count }, { signal });
  }

  // 5. The backstop: the reading half revoked or the bot gone → every Slack answer (RPC 10 skips rows already redacted).
  signal.throwIfAborted();
  const { state } = await getSlackReadingState(principal);
  if (state === "revoked" || state === "bot_not_connected") {
    counts.redacted += await redactChatForSlack(principal, { messageKeys: [], digestKeys: [], channelIds: [], all: true }, { signal });
  }
  return counts;
}
