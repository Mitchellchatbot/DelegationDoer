import "server-only";

import { getDdBotIdentity } from "@/lib/exec/dd-bot";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import type { SweepVerdict } from "@/lib/exec/slack-ingest";
import {
  boxedWaitMs,
  isAbort,
  isRateLimited,
  isSlackAuthError,
  leaseHolder,
  noteWindow,
  openReader,
  paced,
  readErrLabel,
  slackErrorOf,
  sweepBucket,
  tsPlusSeconds,
  verdictsFor,
  windowContext,
  type WindowContext
} from "@/lib/exec/slack-read";
import {
  deleteChannelRow,
  listAuthorOptouts,
  listStoredTs,
  listSweepTargets,
  listThreads,
  markDeleted,
  purgeConversation,
  saveSweepProgress,
  saveThreadWatermark
} from "@/lib/exec/slack-read-store";
import { bucketFromDedupeKey, isInWorkWindow, sweepBucketDue, type WeeklySchedule } from "@/lib/exec/slack-schedule";
import { SLACK_READ_JOB_KINDS, SLACK_READ_LIMITS, compareTs, msToTs, tsToMs } from "@/lib/exec/slack-read-types";
import type { ChannelRow, ReadingInstallation } from "@/lib/exec/slack-read-types";
import { listUserSchedules } from "@/lib/exec/sources/dd";
import { readHistory, readReplies, type SlackReadMessage } from "@/lib/exec/sources/slack";
import { releaseLease, tryAcquireLease } from "@/lib/exec/sync-state";
import type { ExecPrincipal, JobContext, JobHandler } from "@/lib/exec/types";

// exec.slack-read-sweep (P7a contract §3.11.3, N6, C14-C16; Area D): the
// record. Bulk lane, 180 s, one attempt; every 30 minutes per principal with
// reading on, and on demand (enqueueSlackSweepNow: P8's brief, the owner, the
// end of a discovery).
//
//   * Due rule (C14): an in-window bucket always runs; outside his work window
//     only every 6th bucket (3 h); a forced run always.
//   * Per conversation (never swept first, then the oldest sweep, a DM winning a tie; watched rows and rows he or
//     Slack muted, whose DMs and mentions bypass the mute; the 120 s time box, the limiter waited into its next
//     window while the box lasts): a "normal" pass
//     reads history from the watermark minus 10 minutes (≤ 3 pages); a "deep"
//     pass (first sweep, or the last deep one over 3 h ago) reads the last
//     7 days (≤ 5 pages), compares every parent's latest_reply with its thread
//     watermark (the 7-day lookback) and applies deletion by absence (C16), only
//     on a fully paged window. A tombstone deletes its own ts at once.
//   * The watermark advances only after a fully paged window. No Slack cursor
//     is persisted (pages are followed within the run only).
//   * Errors: a rate limit (ours or Slack's) ends the run "partial";
//     not_in_channel / channel_not_found on a private conversation purges it
//     (lost access); channel_not_found on a public channel purges it and its
//     row; an auth-class error ends the run (rethrown; paced() enqueued the
//     user check).
//   * The outage detector: human messages the events should have delivered
//     (newer than last_event_ts + 10 min, older than 10 min) count as missed;
//     20 or more, the oldest 30 minutes old, raise one rate-limited ops alert
//     (counts only).
// Returns counts and codes only.

const KIND = SLACK_READ_JOB_KINDS.sweep;
const LEASE_TTL_MS = 240_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const OVERLAP_SEC = SLACK_READ_LIMITS.overlapMs / 1000;
const REPLY_MAX_PAGES = SLACK_READ_LIMITS.normalMaxPages;
const MISSED_GRACE_MS = 10 * 60_000;
const PRIVATE_TYPES: ReadonlySet<string> = new Set(["group", "im", "mpim"]);

export type SlackReadSweepResult =
  | { skipped: string }
  | { conversations: number; candidates: number; anchors: number; stamped: number; deleted: number; missed: number; partial: boolean;
      purged: number };

interface Totals { conversations: number; candidates: number; anchors: number; stamped: number; deleted: number; missed: number;
  purged: number; oldestMissedMs: number | null }

function parsePayload(raw: unknown): { reason?: "brief" | "owner" | "discover" } | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = (raw as Record<string, unknown>).reason;
  if (r === undefined) return {};
  return r === "brief" || r === "owner" || r === "discover" ? { reason: r } : null;
}

const maxTs = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : compareTs(a, b) >= 0 ? a : b);

function newestOf(messages: readonly SlackReadMessage[]): string | null {
  let out: string | null = null;
  for (const m of messages) out = maxTs(out, m.ts);
  return out;
}

/** A human message (not a bot's, not a DD post, not a tombstone, not noise): what an event should have delivered. */
function isHumanVerdict(v: SweepVerdict | undefined): boolean {
  if (!v) return false;
  if (v.role === "from_him" || v.role === "candidate") return true;
  return v.role === "ignore" && (v.reason === "not_addressed" || v.reason === "muted" || v.reason === "opted_out");
}

async function pagedRead(read: (cursor: string | null) => Promise<{ messages: SlackReadMessage[]; hasMore: boolean; nextCursor: string | null; isLimited: boolean }>,
  maxPages: number): Promise<{ messages: SlackReadMessage[]; fullyPaged: boolean }> {
  const messages: SlackReadMessage[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const r = await read(cursor);
    messages.push(...r.messages);
    if (!r.hasMore) return { messages, fullyPaged: !r.isLimited };
    if (r.nextCursor === null || r.nextCursor === "") return { messages, fullyPaged: false };
    cursor = r.nextCursor;
  }
  return { messages, fullyPaged: false };
}

/** C16: stored rows of a fully paged window the window no longer holds. Slack's `oldest` is exclusive, so that ts is kept. */
async function absent(principal: ExecPrincipal, ch: ChannelRow, q: { oldest: string; latest: string; threadTs: string | null },
  fetched: ReadonlySet<string>): Promise<string[]> {
  const stored = await listStoredTs(principal, ch.channelId, q);
  return stored.filter((ts) => compareTs(ts, q.oldest) > 0 && !fetched.has(ts));
}

async function sweepOne(principal: ExecPrincipal, ri: ReadingInstallation, ch: ChannelRow, base: Omit<WindowContext, "hePosted">,
  now: Date, signal: AbortSignal, totals: Totals, waitMs: () => number): Promise<void> {
  const nowMs = now.getTime();
  const deepAt = ch.deepSweptAt !== null ? Date.parse(ch.deepSweptAt) : Number.NaN;
  const deep = ch.histWatermarkTs === null || !Number.isFinite(deepAt) || nowMs - deepAt > SLACK_READ_LIMITS.deepEveryMs;
  const floor = msToTs(nowMs - SLACK_READ_LIMITS.lookbackDays * DAY_MS);
  const fromMark = ch.histWatermarkTs !== null ? tsPlusSeconds(ch.histWatermarkTs, -OVERLAP_SEC) : null;
  const oldest = deep || fromMark === null ? floor : compareTs(fromMark, floor) >= 0 ? fromMark : floor;
  const channel = ch.channelId;

  const history = await pagedRead(
    (cursor) => paced(ri, "conversations.history", "sweep", () => readHistory(ri.target, { channel, oldest, limit: SLACK_READ_LIMITS.pageLimit, cursor }, { signal }),
      { signal, maxWaitMs: waitMs() }),
    deep ? SLACK_READ_LIMITS.deepMaxPages : SLACK_READ_LIMITS.normalMaxPages
  );
  const top = history.messages.filter((m) => m.threadTs === null || m.threadTs === m.ts);
  const parents = top.filter((m) => m.replyCount > 0 && m.latestReply !== null);
  const roots = [...new Set([...parents.map((m) => m.ts), ...history.messages.map((m) => m.threadTs).filter((t): t is string => t !== null)])];
  const threads = roots.length > 0 ? await listThreads(principal, channel, roots) : [];
  const byRoot = new Map(threads.map((t) => [t.threadTs, t]));
  const w: WindowContext = { ...base, hePosted: new Set(threads.filter((t) => t.hePostedTs !== null).map((t) => t.threadTs)) };
  const q = { lane: "bulk" as const, bucket: sweepBucket(now), now };

  const add = (c: { candidates: number; anchors: number; stamped: number; deleted: number }) => {
    totals.candidates += c.candidates;
    totals.anchors += c.anchors;
    totals.stamped += c.stamped;
    totals.deleted += c.deleted;
  };
  const seenAll: SlackReadMessage[] = [...history.messages];
  add(await noteWindow(principal, channel, history.messages, w, q));

  // Threads: every parent whose latest reply passed its thread watermark (in a deep pass, every parent of the 7 days).
  for (const parent of parents) {
    const stored = byRoot.get(parent.ts);
    const mark = stored?.replyWatermarkTs ?? null;
    if (compareTs(parent.latestReply as string, mark ?? parent.ts) <= 0) continue;
    let replies: { messages: SlackReadMessage[]; fullyPaged: boolean };
    try {
      replies = await pagedRead(
        (cursor) => paced(ri, "conversations.replies", "sweep",
          () => readReplies(ri.target, { channel, ts: parent.ts, ...(mark !== null ? { oldest: mark } : {}), limit: SLACK_READ_LIMITS.pageLimit, cursor }, { signal }),
          { signal, maxWaitMs: waitMs() }),
        REPLY_MAX_PAGES
      );
    } catch (err) {
      // The thread is gone (thread_not_found): skip it; never an empty, fully paged window (no absence delete from it).
      if (slackErrorOf(err)?.code === "thread_not_found") continue;
      throw err;
    }
    const own = replies.messages.filter((m) => m.ts !== parent.ts);
    seenAll.push(...own);
    add(await noteWindow(principal, channel, own, w, q));
    const newest = newestOf(own);
    const watermark = replies.fullyPaged ? (maxTs(newest, parent.latestReply) as string) : (newest ?? mark ?? parent.ts);
    await saveThreadWatermark(principal, channel, parent.ts, { replyWatermarkTs: watermark, latestReplySeenTs: parent.latestReply as string });
    if (deep && replies.fullyPaged) {
      const gone = await absent(principal, ch, { oldest: mark ?? parent.ts, latest: newest ?? (parent.latestReply as string), threadTs: parent.ts },
        new Set(own.map((m) => m.ts)));
      if (gone.length > 0) {
        await markDeleted(principal, channel, gone, "absent");
        totals.deleted += gone.length;
      }
    }
  }

  // C16: absence, only on a deep, fully paged window.
  const newestTop = newestOf(history.messages);
  if (deep && history.fullyPaged) {
    const gone = await absent(principal, ch, { oldest, latest: newestTop ?? msToTs(nowMs), threadTs: null }, new Set(history.messages.map((m) => m.ts)));
    if (gone.length > 0) {
      await markDeleted(principal, channel, gone, "absent");
      totals.deleted += gone.length;
    }
  }

  // The outage detector: member conversations only, never a hub, only once an event has been seen there.
  if (ch.isMember && ch.class !== "hub" && ch.lastEventTs !== null) {
    const after = tsPlusSeconds(ch.lastEventTs, OVERLAP_SEC);
    const verdicts = verdictsFor(seenAll, w);
    for (const m of seenAll) {
      if (after === null || !isHumanVerdict(verdicts.get(m.ts))) continue;
      const ms = tsToMs(m.ts);
      if (compareTs(m.ts, after) > 0 && nowMs - ms > MISSED_GRACE_MS) {
        totals.missed += 1;
        totals.oldestMissedMs = totals.oldestMissedMs === null ? ms : Math.min(totals.oldestMissedMs, ms);
      }
    }
  }

  await saveSweepProgress(principal, channel, {
    histWatermarkTs: history.fullyPaged ? maxTs(newestTop, ch.histWatermarkTs) : ch.histWatermarkTs,
    deep,
    sweptAt: now.toISOString(),
    lastActivityTs: maxTs(newestOf(seenAll), ch.lastActivityTs)
  });
}

async function runSweep(ctx: JobContext): Promise<SlackReadSweepResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const payload = parsePayload(ctx.job.payload);
  if (!payload) return { skipped: "bad_payload" };
  const signal = ctx.signal;
  // 1.
  const settings = await loadSettings(principal.id);
  if (!settings.slackReadingSchemaReady || !settings.slackReadingEnabled) return { skipped: "reading_off" };
  const ri = await openReader(principal, undefined, { signal });
  if (!ri) return { skipped: "not_reading" };
  if (ri.reading.discoveredAt === null) return { skipped: "discovering" };

  // 2. Due (C14).
  const now = new Date();
  const forced = payload.reason !== undefined;
  const bucket = bucketFromDedupeKey(ctx.job.dedupe_key);
  let schedule: WeeklySchedule = {};
  try {
    const mine = (await listUserSchedules(principal, { signal })).find((s) => s.userId === principal.userId);
    schedule = (mine?.weeklySchedule ?? {}) as WeeklySchedule;
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    schedule = {};
  }
  if (!sweepBucketDue(bucket ?? 0, isInWorkWindow(now, principal.timezone, schedule), forced)) return { skipped: "off_window" };

  // 3.
  const holder = leaseHolder(ctx);
  if (!(await tryAcquireLease(principal, "slack-sweep-lease", holder, LEASE_TTL_MS))) return { skipped: "lease" };
  const totals: Totals = { conversations: 0, candidates: 0, anchors: 0, stamped: 0, deleted: 0, missed: 0, purged: 0, oldestMissedMs: null };
  let partial = false;
  try {
    const startedMs = Date.now();
    const targets = await listSweepTargets(principal, SLACK_READ_LIMITS.sweepTargets);
    const optedOut = new Set(await listAuthorOptouts(principal));
    let ddBot = { userId: null as string | null, appId: null as string | null };
    try {
      const id = await getDdBotIdentity(ri.row.teamId, { signal });
      if (id) ddBot = { userId: id.userId, appId: id.appId };
    } catch (err) {
      if (isAbort(err, signal)) throw err;
      console.warn(`[exec-slack] sweep ${ri.row.id}: DD bot identity unavailable (${readErrLabel(err)})`);
    }
    // 4.
    for (const ch of targets) {
      if (Date.now() - startedMs >= SLACK_READ_LIMITS.sweepTimeBoxMs) {
        partial = true;
        break;
      }
      const { hePosted: _unused, ...base } = windowContext(ri, ch, ddBot, optedOut);
      void _unused;
      try {
        // correctness-2: wait into the limiter's next window while the time box lasts (a run no longer ends at the first
        // per-minute refusal after ~30 history calls).
        await sweepOne(principal, ri, ch, base, now, signal, totals, () => boxedWaitMs(startedMs, SLACK_READ_LIMITS.sweepTimeBoxMs));
        totals.conversations += 1;
      } catch (err) {
        if (isAbort(err, signal)) throw err;
        if (isRateLimited(err)) {
          partial = true;
          break;
        }
        if (isSlackAuthError(err)) throw err;
        const code = slackErrorOf(err)?.code ?? null;
        if (PRIVATE_TYPES.has(ch.convType) && (code === "not_in_channel" || code === "channel_not_found")) {
          await purgeConversation(principal, ch.channelId, "lost_access");
          totals.purged += 1;
        } else if (ch.convType === "channel" && code === "channel_not_found") {
          await purgeConversation(principal, ch.channelId, "deleted");
          await deleteChannelRow(principal, ch.channelId);
          totals.purged += 1;
        } else {
          console.warn(`[exec-slack] sweep ${ri.row.id}: conversation ${ch.channelId} not swept (${readErrLabel(err)})`);
        }
      }
    }
    // 5.
    if (totals.missed >= SLACK_READ_LIMITS.outageMissed && totals.oldestMissedMs !== null
      && now.getTime() - totals.oldestMissedMs >= SLACK_READ_LIMITS.outageAgeMs) {
      await notifyOps({
        key: `exec-slack-events-missed:${principal.id}`,
        title: "Executive Assistant: Slack events look stalled",
        detail: `${totals.missed} messages in member conversations were found only by the sweep`
      });
    }
  } finally {
    // 6.
    await releaseLease(principal, "slack-sweep-lease", holder);
  }
  return {
    conversations: totals.conversations,
    candidates: totals.candidates,
    anchors: totals.anchors,
    stamped: totals.stamped,
    deleted: totals.deleted,
    missed: totals.missed,
    partial,
    purged: totals.purged
  };
}

export const SLACK_READ_SWEEP_TIMEOUT_MS = SLACK_READ_LIMITS.sweepTimeoutMs;

export const slackReadSweepJobHandler: JobHandler = {
  kind: KIND,
  lane: "bulk",
  timeoutMs: SLACK_READ_SWEEP_TIMEOUT_MS,
  run: (ctx: JobContext) => runSweep(ctx)
};

/** Every 30 minutes while the schema is installed and reading is on (the due rule runs in the handler, C14). */
export const slackReadSweepScheduledWork: ScheduledWork = {
  kind: KIND,
  lane: "bulk",
  cadence: { kind: "interval", minutes: SLACK_READ_LIMITS.sweepIntervalMin },
  enabled: (s) => s.slackReadingSchemaReady && s.slackReadingEnabled,
  maxAttempts: 1
};
