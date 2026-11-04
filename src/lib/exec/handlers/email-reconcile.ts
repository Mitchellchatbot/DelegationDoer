import "server-only";

import {
  applyThreadProposal,
  getEmailThread,
  listStaleThreads,
  upsertEmailSignals
} from "@/lib/exec/email-store";
import { toMs } from "@/lib/exec/email-state";
import { EMAIL_BACKFILL_DAYS, FEED_SETTLE_MS, type EmailSignalInput, type ExecEmailThread } from "@/lib/exec/email-types";
import {
  EMAIL_RECONCILE_JOB_KIND,
  EMAIL_RECONCILE_MAX_ATTEMPTS,
  EMAIL_TRIAGE_JOB_KIND,
  describeErrorSafe,
  enqueueBulkTriage,
  enqueueJobs,
  kickAttention,
  listDeadJobs,
  parseTriagePayload,
  reconKey,
  retriageKey,
  triageJob,
  type BulkTriageItem,
  type DeadJobCursor
} from "@/lib/exec/jobs";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import {
  checkPinnedAccounts,
  feedRowScreenHashes,
  listPrincipalMessagesFeed,
  listPrincipalThreadsSince,
  loadScreeningPolicy,
  pinnedAccounts,
  screenFeedRow,
  usableAccounts,
  type FeedRow
} from "@/lib/exec/sources/mail";
import {
  casSyncState,
  getSyncState,
  initialReconState,
  parseReconState,
  putSyncState,
  type MailAccountStatus,
  type ReconState
} from "@/lib/exec/sync-state";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import { localDateString, startOfLocalDayUtc } from "@/lib/exec/time";
import { TRIAGE_VERSION } from "@/lib/exec/triage/email";
import { NonRetryableError, type ExecPrincipal, type ExecSettings, type JobContext, type JobHandler } from "@/lib/exec/types";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";

// exec.email-reconcile: the backstop that finds every message of his the
// event path missed (contract §3.11, L10, L20, L23 as amended by v3.1 A3/A7
// and the round-4 findings). Every 5 minutes on the bulk lane, per pinned
// mailbox, it walks the clone in one of two modes and enqueues triage for
// what isn't covered yet:
//
//   feed (CL1 clones): two keyset passes over GET /api/messages. "created"
//     sees each new message once; "changed" sees every message whose Outlook
//     signals moved. Both write the per-message signals table (A3) and screen
//     every row against the restricted-sender rules (amendments-3): a row
//     from a ruled address tombstones its thread at once, its signals are not
//     stored, and the thread is re-triaged on the interactive lane. The
//     changed pass also re-triages a thread whose stored facts a Junk ↔
//     Inbox move made wrong (data-2). Then a thread pass over the thread
//     list (list mode's window, stored content rows only) catches threads of
//     his that moved in someone else's mailbox, which his feed never shows
//     (security-1).
//   list (older clones): windows of the thread list by last_message_at, with
//     an overlap that keeps late-arriving mail (L10, §3.11 step 3).
//
// Then the sweeps: budget deferrals from before today (his local day), rows
// last attempted under an older TRIAGE_VERSION, and dead triage jobs (each
// retried once).
//
// Positions persist after every page by compare-and-set, so an interrupted
// run resumes where it stopped and two overlapping runs can't move a cursor
// backwards. A page whose bulk work the cap turned away (jobs.ts) is not
// passed: the next run reads it again, and the dedupe keys make that free.
//
// Reconcile decides usability itself from a fresh account check, so a
// problem recorded earlier never stops the check that would clear it.
// Logs and the job result carry ids, counts and codes only.

export const EMAIL_RECONCILE_TIMEOUT_MS = 240_000;
const RECONCILE_EVERY_MINUTES = 5;
const CLONE_TIMEOUT_MS = 30_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const BACKFILL_MS = EMAIL_BACKFILL_DAYS * DAY_MS;
/** Stop starting new pages after this much of the run (the timeout is 240 s). */
const RUN_BUDGET_MS = 180_000;
const FEED_PAGE_LIMIT = 100;
const MAX_FEED_PAGES = 10;
const LIST_PAGE_LIMIT = 100;
const MAX_LIST_PAGES = 10;
const SWEEP_LIMIT = 50;
/** Thread-row reads in flight at once. */
const ROW_READ_CONCURRENCY = 8;
/** Recent mail (by sent time) outside the backfill goes to the interactive lane (L10). */
export const INTERACTIVE_AGE_MS = 2 * HOUR_MS;
/**
 * At most this many interactive triage jobs per run (L10's per-run bound).
 * Bulk work has its own cap (jobs.ts); recent mail past this one goes the
 * bulk way too, so an outage's worth of new mail can't flood the
 * interactive lane. A restricted row's re-triage is always interactive.
 */
export const MAX_INTERACTIVE_PER_RUN = 200;
/** A group is covered when the stored read started this long after its newest message was ingested (CL1's settle horizon). */
export const COVER_MARGIN_MS = FEED_SETTLE_MS;
/** List mode: a new window starts this far before min(hwm, last sync) ... */
export const LIST_OVERLAP_MS = 20 * MINUTE_MS;
/** ... and once a day this far. */
export const DEEP_WINDOW_MS = 48 * HOUR_MS;
const DEEP_EVERY_MS = DAY_MS;
/** Dead jobs are read only once they have been dead this long (listDeadJobs' finishedBefore). */
const DEAD_SETTLE_MS = MINUTE_MS;

// ---------------------------------------------------------------------------
// The run's shared context and counters
// ---------------------------------------------------------------------------

export interface ReconcileSummary {
  skipped?: string;
  accounts: number;
  problems: number;
  feedPages: number;
  listPages: number;
  signalsWritten: number;
  enqueued: number;
  /** Bulk work the cap turned away this run (the cursor stayed in front of it). */
  blocked: number;
  tombstoned: number;
  /** Store refusals caught per row (programming errors, logged with ids). */
  refusals: number;
  /** Cursor writes another run won (this run stopped for that mailbox). */
  conflicts: number;
  budgetRetries: number;
  versionRetries: number;
  deadRetries: number;
}

function emptySummary(): ReconcileSummary {
  return {
    accounts: 0,
    problems: 0,
    feedPages: 0,
    listPages: 0,
    signalsWritten: 0,
    enqueued: 0,
    blocked: 0,
    tombstoned: 0,
    refusals: 0,
    conflicts: 0,
    budgetRetries: 0,
    versionRetries: 0,
    deadRetries: 0
  };
}

interface Run {
  principal: ExecPrincipal;
  settings: ExecSettings;
  signal: AbortSignal;
  startedAt: number;
  rules: readonly RestrictedSenderRule[];
  policyHash: string;
  problems: ReadonlySet<string>;
  tally: ReconcileSummary;
  /** Interactive enqueues this run may still make (MAX_INTERACTIVE_PER_RUN). */
  interactiveLeft: number;
  /** Threads a feed pass already handed to triage this run (the thread pass skips them). */
  queued: Set<string>;
}

const overBudget = (run: Run) => Date.now() - run.startedAt > RUN_BUDGET_MS;

/** The lane for recent work: interactive while the run's interactive budget lasts, then bulk. */
function recentLane(run: Run): "interactive" | "bulk" {
  if (run.interactiveLeft <= 0) return "bulk";
  run.interactiveLeft -= 1;
  return "interactive";
}

/**
 * A page that wrote signals or a tombstone kicks the attention pass (bulk;
 * coherence-7), so an archive or a flag reaches Needs Attention at the next
 * minute boundary rather than the next 10-minute pass. The kick's key is per
 * minute, so the pages of one run share one pass.
 */
const kick = (run: Run) => kickAttention(run.principal, "bulk");
const iso = (ms: number) => new Date(ms).toISOString();

/** A store refusal (NonRetryableError) for one row is logged and skipped; anything else throws (L6). */
async function perRow<T>(run: Run, what: string, ids: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof NonRetryableError)) throw err;
    run.tally.refusals += 1;
    console.error(`[exec-email-reconcile] ${run.principal.id}: ${what} refused for ${ids}; continuing: ${describeErrorSafe(err)}`);
    return null;
  }
}

/** The stored rows of these threads (null = none), at most ROW_READ_CONCURRENCY reads at once. */
async function storedRows(run: Run, threadIds: readonly string[]): Promise<Map<string, ExecEmailThread | null>> {
  const ids = [...new Set(threadIds)];
  const out = new Map<string, ExecEmailThread | null>();
  for (let i = 0; i < ids.length; i += ROW_READ_CONCURRENCY) {
    const batch = ids.slice(i, i + ROW_READ_CONCURRENCY);
    const rows = await Promise.all(batch.map((id) => getEmailThread(run.principal, id, { signal: run.signal })));
    batch.forEach((id, j) => out.set(id, rows[j]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The recon cursor (mail/recon:<accountId>), compare-and-set per page
// ---------------------------------------------------------------------------

interface ReconHandle {
  key: string;
  state: ReconState;
  rev: number;
}

function freshReconState(nowMs: number): ReconState {
  return { ...initialReconState(), backfill: { from: iso(nowMs - BACKFILL_MS), startedAt: iso(nowMs), enqueuedAt: null } };
}

async function openRecon(run: Run, accountId: string): Promise<ReconHandle> {
  const key = `recon:${accountId}`;
  const cur = await getSyncState(run.principal, "mail", key, parseReconState, { signal: run.signal });
  if (cur) {
    // A row that predates its backfill marker gets one now.
    if (cur.value.backfill !== null) return { key, state: cur.value, rev: cur.rev };
    const handle = { key, state: cur.value, rev: cur.rev };
    if (await saveRecon(run, handle, { ...cur.value, backfill: freshReconState(Date.now()).backfill })) return handle;
    throw new Error(`mail/${key} changed while its backfill marker was set`);
  }
  // No row, or one that doesn't parse: start over (a replacing write), then read it back for its rev.
  await putSyncState(run.principal, "mail", key, freshReconState(Date.now()), { signal: run.signal });
  const again = await getSyncState(run.principal, "mail", key, parseReconState, { signal: run.signal });
  if (!again) throw new Error(`mail/${key} could not be initialized`);
  return { key, state: again.value, rev: again.rev };
}

/** Write `next` if nobody else wrote since we read; false = another run is ahead, stop here. */
async function saveRecon(run: Run, h: ReconHandle, next: ReconState): Promise<boolean> {
  const ok = await casSyncState(run.principal, "mail", h.key, h.rev, next, { signal: run.signal });
  if (!ok) {
    run.tally.conflicts += 1;
    return false;
  }
  h.state = next;
  h.rev += 1;
  return true;
}

// ---------------------------------------------------------------------------
// Feed mode (CL1)
// ---------------------------------------------------------------------------

/** A feed row as the signals table stores it (coherence-7 mapping; times ms → ISO). */
export function signalOf(row: FeedRow): EmailSignalInput {
  return {
    messageId: row.messageId,
    threadId: row.threadId,
    accountId: row.accountId,
    direction: row.direction,
    // Graph's flag status: "flagged" is flagged; "notflagged" and "complete" are not.
    flagged: row.flagStatus === null ? null : row.flagStatus === "flagged",
    importance: row.importance,
    unread: row.isRead === null ? null : !row.isRead,
    removedAt: row.removedAtMs === null ? null : iso(row.removedAtMs),
    webLink: row.webLink,
    signalsAt: iso(row.signalsAtMs)
  };
}

export type CreatedGroupDecision =
  | { action: "skip"; why: "covered" | "too_old" | "junk_only" }
  | { action: "enqueue"; lane: "interactive" | "bulk"; reason: "reconcile" | "backfill"; messageId: string };

/**
 * One created-pass group (the rows of one thread on one page, in feed order):
 *   covered   the stored read started at least COVER_MARGIN_MS after the
 *             group's newest ingest (it saw them all), in any state;
 *   junk_only / too_old  no row yet and nothing to pick up (not counted);
 *   otherwise enqueue, keyed on the group's newest row: interactive when its
 *   newest mail was sent within INTERACTIVE_AGE_MS and isn't part of the
 *   backfill, else bulk.
 */
export function createdGroupDecision(
  group: readonly FeedRow[],
  stored: Pick<ExecEmailThread, "snapshotReadStartedAt"> | null,
  ctx: { nowMs: number; backfillStartedAtMs: number | null }
): CreatedGroupDecision {
  const newest = group[group.length - 1];
  const maxCreated = Math.max(...group.map((r) => r.createdAtMs));
  if (stored !== null) {
    const readStarted = toMs(stored.snapshotReadStartedAt);
    if (readStarted !== null && readStarted >= maxCreated + COVER_MARGIN_MS) return { action: "skip", why: "covered" };
  }
  const live = group.filter((r) => !r.isJunk);
  if (stored === null) {
    if (live.length === 0) return { action: "skip", why: "junk_only" };
    const sent = live.map((r) => r.sentAtMs).filter((v): v is number => v !== null);
    if (sent.length > 0 && Math.max(...sent) < ctx.nowMs - BACKFILL_MS) return { action: "skip", why: "too_old" };
  }
  const sentList = (live.length > 0 ? live : group).map((r) => r.sentAtMs).filter((v): v is number => v !== null);
  const newestSent = sentList.length > 0 ? Math.max(...sentList) : null;
  const backfill = ctx.backfillStartedAtMs !== null && maxCreated < ctx.backfillStartedAtMs;
  const recent = newestSent !== null && ctx.nowMs - newestSent <= INTERACTIVE_AGE_MS;
  return { action: "enqueue", lane: recent && !backfill ? "interactive" : "bulk", reason: backfill ? "backfill" : "reconcile", messageId: newest.messageId };
}

/**
 * The changed pass enqueues a message only when a later change made it worth
 * triaging and its thread still has no row: inbound, not junk, not removed,
 * sent within the window, and changed well after it was ingested (a Junk →
 * Inbox rescue, say). Rows that only appear because they are new are the
 * created pass's, and so is everything while the backfill is still running.
 */
export function changedRowWanted(row: FeedRow, stored: ExecEmailThread | null, ctx: { nowMs: number; backfillDone: boolean }): boolean {
  return (
    ctx.backfillDone &&
    stored === null &&
    row.direction === "inbound" &&
    !row.isJunk &&
    row.removedAtMs === null &&
    row.sentAtMs !== null &&
    row.sentAtMs >= ctx.nowMs - BACKFILL_MS &&
    row.signalsAtMs > row.createdAtMs + COVER_MARGIN_MS
  );
}

/**
 * A message his stored facts read in the wrong folder (data-2): rescued from
 * Junk after the thread was triaged without it (triage leaves junk out, so
 * the facts' newest inbound is older than it), or moved to Junk while the
 * facts still count it as the newest inbound. Either way the row's answered
 * state and assessment are wrong until the thread is read again, and nothing
 * else re-reads it: the hook hears only new mail, the created pass saw this
 * message once, while it was in its first folder, and list mode keys on
 * last_message_at, which a move doesn't change. Only a move made well after
 * ingest counts (the arrival is the created pass's), only inbound mail that is
 * still in his folders, and only on a live row: a thread without one is
 * changedRowWanted's, and a tombstone or a gone row shows nothing to correct.
 */
export function folderMoveWanted(row: FeedRow, stored: Pick<ExecEmailThread, "state" | "lastInboundAt" | "newestInboundMessageId"> | null): boolean {
  if (stored === null || stored.state === "restricted_hidden" || stored.state === "gone") return false;
  if (row.direction !== "inbound" || row.removedAtMs !== null || !(row.signalsAtMs > row.createdAtMs + COVER_MARGIN_MS)) return false;
  if (row.isJunk) return stored.newestInboundMessageId === row.messageId;
  return (row.sentAtMs ?? 0) > (toMs(stored.lastInboundAt) ?? 0);
}

/** The key of a folder move's re-triage: one job per message and direction of move (a different disc from the created pass's). */
export const folderMoveKey = (principalId: string, row: Pick<FeedRow, "threadId" | "messageId" | "isJunk">): string =>
  reconKey(principalId, row.threadId, `${row.messageId}.${row.isJunk ? "j" : "i"}`);

interface PageWork {
  interactive: BulkTriageItem[];
  bulk: BulkTriageItem[];
}

/** Enqueue a page's work; false when the cap turned some bulk work away (the page is not done). */
async function enqueuePage(run: Run, work: PageWork): Promise<boolean> {
  const { principal } = run;
  for (const item of [...work.interactive, ...work.bulk]) run.queued.add(item.threadId);
  if (work.interactive.length > 0) {
    const r = await enqueueJobs(work.interactive.map((item) => triageJob({ ...item, principalId: principal.id, lane: "interactive" })), { signal: run.signal });
    run.tally.enqueued += r.enqueued;
  }
  if (work.bulk.length === 0) return true;
  const r = await enqueueBulkTriage(principal, work.bulk, new Date(), { signal: run.signal });
  run.tally.enqueued += r.enqueued;
  run.tally.blocked += r.blocked;
  return r.blocked === 0;
}

/**
 * The parts both feed passes share for one page: the restricted screen of
 * every row (amendments-3), the signals upsert (A3), and the flag re-triage
 * (addenda §1.3). Returns the rows that weren't restricted and the stored rows.
 */
async function screenAndSignal(
  run: Run,
  rows: readonly FeedRow[],
  opts: { order: "created" | "changed"; settledThroughMs: number | null },
  work: PageWork
): Promise<{ clean: FeedRow[]; stored: Map<string, ExecEmailThread | null> }> {
  const { principal } = run;
  const stored = await storedRows(run, rows.map((r) => r.threadId));

  // Restricted rows: tombstone the thread's content row now, keep its signals out, re-triage it interactively.
  const restricted = new Map<string, FeedRow[]>();
  const clean: FeedRow[] = [];
  for (const row of rows) {
    if (screenFeedRow(row, run.rules).verdict === "restricted") {
      const list = restricted.get(row.threadId) ?? [];
      list.push(row);
      restricted.set(row.threadId, list);
    } else {
      clean.push(row);
    }
  }
  for (const [threadId, hits] of restricted) {
    const row = stored.get(threadId) ?? null;
    if (row !== null && row.state !== "restricted_hidden") {
      const merged = new Set<string>();
      let truncated = false;
      for (const hit of hits) {
        const h = feedRowScreenHashes(hit);
        h.hashes.forEach((x) => merged.add(x));
        truncated ||= h.truncated;
      }
      const r = await perRow(run, "tombstone", `thread ${threadId}`, () =>
        applyThreadProposal(
          principal,
          run.settings,
          threadId,
          { kind: "tombstone", snapshot: null, hashes: [...merged].sort(), truncated, policyHash: run.policyHash },
          { now: new Date(), retentionDays: run.settings.retentionDaysEmail },
          { signal: run.signal }
        )
      );
      if (r?.result === "tombstoned") {
        run.tally.tombstoned += 1;
        await kick(run);
      }
    }
    const newest = hits[hits.length - 1];
    work.interactive.push({ threadId, reason: "reconcile", dedupeKey: reconKey(principal.id, threadId, newest.messageId), messageId: newest.messageId, accountId: newest.accountId });
  }

  // Signals. The created pass stores a row's signals only once its stamp is
  // settled (amendments-5): an unsettled stamp could be overtaken by an
  // earlier-stamped commit that the strictly monotonic upsert would then
  // refuse. The changed pass only ever serves settled stamps.
  const storable = opts.order === "created" ? clean.filter((r) => opts.settledThroughMs !== null && r.signalsAtMs <= opts.settledThroughMs) : clean;
  if (storable.length > 0) {
    const written = await perRow(run, "signals upsert", `${storable.length} rows`, () =>
      upsertEmailSignals(principal, storable.map(signalOf), { signal: run.signal })
    );
    if (written !== null && written > 0) {
      run.tally.signalsWritten += written;
      await kick(run);
    }
  }

  // A flag on the anchor of a filtered thread re-triages it: L7 never filters a flagged thread.
  for (const r of storable) {
    if (r.flagStatus !== "flagged") continue;
    const row = stored.get(r.threadId) ?? null;
    if (row === null || row.state !== "filtered") continue;
    const anchor = row.newestInboundMessageId ?? row.newestMessageId;
    if (anchor !== r.messageId) continue;
    work.bulk.push({ threadId: r.threadId, reason: "flag", dedupeKey: retriageKey(principal.id, r.threadId, "flag", r.messageId), messageId: r.messageId, accountId: r.accountId });
  }
  return { clean, stored };
}

type PassEnd = "done" | "more" | "blocked" | "unsupported" | "conflict";

async function createdPass(run: Run, h: ReconHandle, accountId: string): Promise<PassEnd> {
  const { principal } = run;
  for (let pages = 0; pages < MAX_FEED_PAGES; pages += 1) {
    if (overBudget(run)) return "more";
    run.signal.throwIfAborted();
    const st = h.state;
    const page = await listPrincipalMessagesFeed(principal, accountId, {
      order: "created",
      cursor: st.created.cursor,
      sinceIso: st.created.cursor ? null : (st.created.since ?? feedStart(st)),
      limit: FEED_PAGE_LIMIT,
      signal: run.signal,
      timeoutMs: CLONE_TIMEOUT_MS
    });
    if (!page.supported) return "unsupported";
    run.tally.feedPages += 1;

    const work: PageWork = { interactive: [], bulk: [] };
    const { clean, stored } = await screenAndSignal(run, page.rows, { order: "created", settledThroughMs: page.settledThroughMs }, work);
    const groups = new Map<string, FeedRow[]>();
    for (const row of clean) {
      // A thread with a restricted row on this page is re-triaged interactively already.
      if (work.interactive.some((w) => w.threadId === row.threadId)) continue;
      const list = groups.get(row.threadId) ?? [];
      list.push(row);
      groups.set(row.threadId, list);
    }
    const nowMs = Date.now();
    const backfillStartedAtMs = st.backfill && st.backfill.enqueuedAt === null ? toMs(st.backfill.startedAt) : null;
    for (const [threadId, group] of groups) {
      const d = createdGroupDecision(group, stored.get(threadId) ?? null, { nowMs, backfillStartedAtMs });
      if (d.action === "skip") continue;
      const item: BulkTriageItem = { threadId, reason: d.reason, dedupeKey: reconKey(principal.id, threadId, d.messageId), messageId: d.messageId, accountId };
      (d.lane === "interactive" && recentLane(run) === "interactive" ? work.interactive : work.bulk).push(item);
    }
    // The cursor moves only past a page whose work is all queued (coherence-12).
    if (!(await enqueuePage(run, work))) return "blocked";

    const next: ReconState = { ...h.state, created: { cursor: page.nextCursor, since: st.created.since ?? feedStart(st) } };
    if (!page.hasMore && next.backfill && next.backfill.enqueuedAt === null) next.backfill = { ...next.backfill, enqueuedAt: iso(Date.now()) };
    if (!(await saveRecon(run, h, next))) return "conflict";
    if (!page.hasMore) return "done";
  }
  return "more";
}

async function changedPass(run: Run, h: ReconHandle, accountId: string): Promise<PassEnd> {
  const { principal } = run;
  for (let pages = 0; pages < MAX_FEED_PAGES; pages += 1) {
    if (overBudget(run)) return "more";
    run.signal.throwIfAborted();
    const st = h.state;
    const page = await listPrincipalMessagesFeed(principal, accountId, {
      order: "changed",
      cursor: st.changed.cursor,
      sinceIso: st.changed.cursor ? null : (st.changed.since ?? feedStart(st)),
      limit: FEED_PAGE_LIMIT,
      signal: run.signal,
      timeoutMs: CLONE_TIMEOUT_MS
    });
    if (!page.supported) return "unsupported";
    run.tally.feedPages += 1;

    const work: PageWork = { interactive: [], bulk: [] };
    const { clean, stored } = await screenAndSignal(run, page.rows, { order: "changed", settledThroughMs: page.settledThroughMs }, work);
    const nowMs = Date.now();
    const backfillDone = st.backfill !== null && st.backfill.enqueuedAt !== null;
    const queued = new Set(work.interactive.map((w) => w.threadId));
    for (const row of clean) {
      if (queued.has(row.threadId)) continue;
      const s = stored.get(row.threadId) ?? null;
      if (changedRowWanted(row, s, { nowMs, backfillDone })) {
        work.bulk.push({ threadId: row.threadId, reason: "reconcile", dedupeKey: reconKey(principal.id, row.threadId, row.messageId), messageId: row.messageId, accountId });
      } else if (folderMoveWanted(row, s) && !work.bulk.some((w) => w.threadId === row.threadId)) {
        // data-2: a Junk ↔ Inbox move the row's facts don't reflect yet. One
        // job per thread and page: it re-reads the whole thread.
        work.bulk.push({ threadId: row.threadId, reason: "reconcile", dedupeKey: folderMoveKey(principal.id, row), messageId: row.messageId, accountId });
      }
    }
    if (!(await enqueuePage(run, work))) return "blocked";
    if (!(await saveRecon(run, h, { ...h.state, changed: { cursor: page.nextCursor, since: st.changed.since ?? feedStart(st) } }))) return "conflict";
    if (!page.hasMore) return "done";
  }
  return "more";
}

/**
 * Where a feed pass starts without a cursor: the backfill start, but never
 * more than the backfill window ago (a list-mode principal whose clone gains
 * CL1 later doesn't rescan months of mail).
 */
function feedStart(st: ReconState): string {
  const floor = Date.now() - BACKFILL_MS;
  const from = st.backfill ? toMs(st.backfill.from) : null;
  return iso(from === null ? floor : Math.max(from, floor));
}

// ---------------------------------------------------------------------------
// List mode (pre-CL1 clones)
// ---------------------------------------------------------------------------

/**
 * A new list window: from min(hwm, the clone's last sync) minus 20 minutes,
 * or minus 48 hours once a day, or the backfill start on the first window;
 * to now. The clone's last sync time is kept with it: the window may only
 * vouch for mail the clone had when it started.
 */
export function startListWindow(st: ReconState, account: Pick<MailAccountStatus, "lastSyncedAt"> | null, nowMs: number): ReconState["list"] {
  const hwm = toMs(st.list.hwm);
  const lastSynced = toMs(account?.lastSyncedAt ?? null);
  let fromMs: number;
  let lastDeepAt = st.list.lastDeepAt;
  if (hwm === null) {
    fromMs = (st.backfill ? toMs(st.backfill.from) : null) ?? nowMs - BACKFILL_MS;
  } else {
    const base = lastSynced === null ? hwm : Math.min(hwm, lastSynced);
    const lastDeep = toMs(lastDeepAt);
    const deep = lastDeep === null || nowMs - lastDeep >= DEEP_EVERY_MS;
    fromMs = base - (deep ? DEEP_WINDOW_MS : LIST_OVERLAP_MS);
    if (deep) lastDeepAt = iso(nowMs);
  }
  return {
    hwm: st.list.hwm,
    windowFrom: iso(fromMs),
    windowTo: iso(nowMs),
    lastSyncedAtAtStart: account?.lastSyncedAt ?? null,
    offset: 0,
    lastDeepAt,
    pass: "normal"
  };
}

/** The window is done: its high-water mark is the earlier of its end and the clone's last sync at its start. */
export function finishListWindow(list: ReconState["list"]): ReconState["list"] {
  const to = toMs(list.windowTo);
  const synced = toMs(list.lastSyncedAtAtStart);
  const hwmMs = to === null ? synced : synced === null ? to : Math.min(to, synced);
  return { hwm: hwmMs === null ? list.hwm : iso(hwmMs), windowFrom: null, windowTo: null, lastSyncedAtAtStart: null, offset: 0, lastDeepAt: list.lastDeepAt, pass: "normal" };
}

/**
 * Which threads a list pass hands to triage:
 *   "all"   list mode (pre-CL1 clones): the list is how new mail is found at all.
 *   "rows"  the thread pass a feed-mode run makes too (security-1): only
 *           threads with a stored row that still shows content (not a
 *           tombstone, not gone) and that no feed pass queued this run. The
 *           feed reads his mailboxes only, so a message that reached one of
 *           his threads in someone else's mailbox alone (a client replying to
 *           a delegate, CC'ing a restricted sender) is seen only here: the
 *           thread's last_message_at moved past what the row's read saw, and
 *           triage's live screen, over every message of the thread, decides.
 */
type ListScope = "all" | "rows";

async function listMode(run: Run, h: ReconHandle, accountId: string, account: MailAccountStatus | null, scope: ListScope): Promise<PassEnd> {
  const { principal } = run;
  if (h.state.list.windowFrom === null) {
    if (!(await saveRecon(run, h, { ...h.state, list: startListWindow(h.state, account, Date.now()) }))) return "conflict";
  }
  for (let pages = 0; pages < MAX_LIST_PAGES; pages += 1) {
    if (overBudget(run)) return "more";
    run.signal.throwIfAborted();
    const st = h.state;
    const list = st.list;
    const page = await listPrincipalThreadsSince(principal, accountId, {
      afterIso: list.windowFrom as string,
      limit: LIST_PAGE_LIMIT,
      offset: list.offset,
      snoozed: list.pass === "snoozed",
      signal: run.signal,
      timeoutMs: CLONE_TIMEOUT_MS
    });
    run.tally.listPages += 1;

    const stored = await storedRows(run, page.threads.map((t) => t.threadId));
    const firstWindow = list.hwm === null;
    const nowMs = Date.now();
    const work: PageWork = { interactive: [], bulk: [] };
    for (const t of page.threads) {
      const last = toMs(t.lastMessageAt);
      if (last === null) continue;
      const row = stored.get(t.threadId) ?? null;
      if (scope === "rows" && (row === null || row.state === "restricted_hidden" || row.state === "gone" || run.queued.has(t.threadId))) continue;
      // Same clock, same scope: the stored read already included a message at least this new (mechanisms-7).
      const maxSent = row === null ? null : toMs(row.snapshotMaxSentAt);
      if (maxSent !== null && maxSent >= last) continue;
      const backfill = scope === "all" && firstWindow;
      const item: BulkTriageItem = { threadId: t.threadId, reason: backfill ? "backfill" : "reconcile", dedupeKey: reconKey(principal.id, t.threadId, last), accountId };
      (!backfill && nowMs - last <= INTERACTIVE_AGE_MS && recentLane(run) === "interactive" ? work.interactive : work.bulk).push(item);
    }
    if (!(await enqueuePage(run, work))) return "blocked";

    let next: ReconState;
    if (page.hasMore) {
      // A one-row overlap: a thread that moved up one place between pages is read twice, never skipped.
      next = { ...st, list: { ...list, offset: list.offset + Math.max(1, page.threads.length - 1) } };
    } else if (list.pass === "normal") {
      next = { ...st, list: { ...list, pass: "snoozed", offset: 0 } };
    } else {
      next = { ...st, list: finishListWindow(list) };
      // In feed mode the created pass owns the backfill marker.
      if (scope === "all" && next.backfill && next.backfill.enqueuedAt === null) next.backfill = { ...next.backfill, enqueuedAt: iso(Date.now()) };
    }
    if (!(await saveRecon(run, h, next))) return "conflict";
    if (!page.hasMore && list.pass === "snoozed") return "done";
  }
  return "more";
}

// ---------------------------------------------------------------------------
// One mailbox
// ---------------------------------------------------------------------------

async function reconcileAccount(run: Run, accountId: string, account: MailAccountStatus | null): Promise<void> {
  const h = await openRecon(run, accountId);
  // The feed is tried every run (missive-client caches a pre-CL1 answer for
  // 10 minutes), so a clone that gains CL1 is picked up without a deploy.
  const created = await createdPass(run, h, accountId);
  if (created === "conflict") return;
  if (created === "unsupported") {
    if (h.state.mode !== "list" && !(await saveRecon(run, h, { ...h.state, mode: "list" }))) return;
    await listMode(run, h, accountId, account, "all");
    return;
  }
  if (h.state.mode !== "feed" && !(await saveRecon(run, h, { ...h.state, mode: "feed" }))) return;
  if (overBudget(run)) return;
  const changed = await changedPass(run, h, accountId);
  if (changed === "conflict" || changed === "unsupported" || overBudget(run)) return;
  // The thread pass (security-1): the feed shows only his own mailbox's
  // messages; a thread of his that moved in someone else's mailbox is found
  // by its last_message_at, with list mode's window and cursor.
  await listMode(run, h, accountId, account, "rows");
}

// ---------------------------------------------------------------------------
// Sweeps (§3.11 step 4; L20 keys)
// ---------------------------------------------------------------------------

/** The thread id up to which a sweep is done: just before the first item the cap turned away. */
function cursorAfter<T>(rows: readonly T[], keyOf: (row: T) => string | null, blockedKeys: readonly string[], fallback: T | undefined): T | undefined {
  if (blockedKeys.length === 0) return rows[rows.length - 1] ?? fallback;
  const firstBlocked = rows.findIndex((r) => {
    const k = keyOf(r);
    return k !== null && blockedKeys.includes(k);
  });
  return firstBlocked > 0 ? rows[firstBlocked - 1] : fallback;
}

async function sweeps(run: Run): Promise<void> {
  const { principal } = run;
  const now = new Date();
  const usable = (accountId: string) => !run.problems.has(accountId);

  // Budget: deferred (or last attempted into the cap) before his local day began; once per local day.
  if (overBudget(run)) return;
  const localDate = localDateString(now, principal.timezone);
  const budgetRows = await listStaleThreads(
    principal,
    { kind: "deferred_budget", before: startOfLocalDayUtc(now, principal.timezone).toISOString(), limit: SWEEP_LIMIT },
    { signal: run.signal }
  );
  const budget = await enqueueBulkTriage(
    principal,
    budgetRows
      .filter((r) => usable(r.accountId))
      .map((r) => ({ threadId: r.threadId, accountId: r.accountId, reason: "budget_retry" as const, dedupeKey: retriageKey(principal.id, r.threadId, "budget", localDate) })),
    now,
    { signal: run.signal }
  );
  run.tally.budgetRetries += budget.enqueued;
  run.tally.blocked += budget.blocked;

  // The sweep cursors live on the first pinned mailbox's recon row (they are per principal).
  if (overBudget(run)) return;
  const h = await openRecon(run, pinnedAccounts(principal)[0]);

  // Version: triaged rows last attempted under another TRIAGE_VERSION, keyset by thread id.
  const versionRows = await listStaleThreads(principal, { kind: "version", afterThreadId: h.state.versionCursor, limit: SWEEP_LIMIT }, { signal: run.signal });
  const versionKey = (r: { threadId: string; accountId: string }) =>
    usable(r.accountId) ? retriageKey(principal.id, r.threadId, "version", TRIAGE_VERSION) : null;
  const version = await enqueueBulkTriage(
    principal,
    versionRows.flatMap((r) => {
      const key = versionKey(r);
      return key === null ? [] : [{ threadId: r.threadId, accountId: r.accountId, reason: "version" as const, dedupeKey: key }];
    }),
    now,
    { signal: run.signal }
  );
  run.tally.versionRetries += version.enqueued;
  run.tally.blocked += version.blocked;
  const lastVersion = cursorAfter(versionRows, versionKey, version.blockedKeys, undefined);
  // A short batch reached the end: the next run starts the list again.
  const versionCursor =
    version.blocked === 0 && versionRows.length < SWEEP_LIMIT ? null : (lastVersion?.threadId ?? h.state.versionCursor);
  if (versionCursor !== h.state.versionCursor && !(await saveRecon(run, h, { ...h.state, versionCursor }))) return;

  // Dead letters: each dead triage job once, oldest death first (addenda §1.2).
  if (overBudget(run)) return;
  const dead = await listDeadJobs(
    {
      principalId: principal.id,
      kind: EMAIL_TRIAGE_JOB_KIND,
      after: h.state.deadCursor,
      limit: SWEEP_LIMIT,
      finishedBefore: new Date(now.getTime() - DEAD_SETTLE_MS)
    },
    { signal: run.signal }
  );
  const deadItems = dead.jobs.map((job) => {
    const p = parseTriagePayload(job.payload);
    if (!p || (p.accountId !== undefined && !usable(p.accountId))) return { job, item: null };
    const item: BulkTriageItem = {
      threadId: p.threadId,
      reason: "dead_letter",
      dedupeKey: retriageKey(principal.id, p.threadId, "dead", job.id),
      originalJobId: job.id,
      ...(p.messageId !== undefined ? { messageId: p.messageId } : {}),
      ...(p.accountId !== undefined ? { accountId: p.accountId } : {})
    };
    return { job, item };
  });
  const retried = await enqueueBulkTriage(
    principal,
    deadItems.flatMap((d) => (d.item ? [d.item] : [])),
    now,
    { signal: run.signal }
  );
  run.tally.deadRetries += retried.enqueued;
  run.tally.blocked += retried.blocked;
  let deadCursor: DeadJobCursor | null;
  if (retried.blocked === 0) {
    deadCursor = dead.next ?? h.state.deadCursor;
  } else {
    const last = cursorAfter(deadItems, (d) => d.item?.dedupeKey ?? null, retried.blockedKeys, undefined);
    deadCursor = last ? { finishedAt: last.job.finishedAt, id: last.job.id } : h.state.deadCursor;
  }
  if (!sameCursor(deadCursor, h.state.deadCursor)) await saveRecon(run, h, { ...h.state, deadCursor });
}

const sameCursor = (a: DeadJobCursor | null, b: DeadJobCursor | null) => (a === null || b === null ? a === b : a.id === b.id && a.finishedAt === b.finishedAt);

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

async function runReconcile(ctx: JobContext): Promise<ReconcileSummary> {
  const { principal, signal, job } = ctx;
  if (!principal) throw new NonRetryableError(`${EMAIL_RECONCILE_JOB_KIND}: job ${job.id} has no principal`);
  const tally = emptySummary();

  // Gate (L1). The schedule's own gate already checked these; the settings may have changed since.
  const settings = await loadSettings(principal.id);
  if (!settings.emailSchemaReady) return { ...tally, skipped: "not_installed" };
  if (!settings.emailEnabled) return { ...tally, skipped: "email_off" };
  if (pinnedAccounts(principal).length === 0) return { ...tally, skipped: "no_pin" };

  // 1. Accounts, checked fresh: this decides usability for the run and for
  // every other email path until the next check (mail/accounts).
  const checked = await checkPinnedAccounts(principal, { signal, timeoutMs: CLONE_TIMEOUT_MS });
  await putSyncState(principal, "mail", "accounts", { checkedAt: new Date().toISOString(), accounts: checked.accounts, problems: checked.problems }, { signal });
  tally.accounts = checked.accounts.length;
  tally.problems = checked.problems.length;
  for (const p of checked.problems) {
    await notifyOps({
      key: `email-account-problem:${principal.id}:${p.accountId}`,
      title: "a pinned mailbox can't be used",
      detail: `principal ${principal.id}, account ${p.accountId}: ${p.reason}`
    });
  }
  const problems = new Set(checked.problems.map((p) => p.accountId));

  // The rules every feed row is screened against (strict: a failed read throws).
  const policy = await loadScreeningPolicy(principal, { signal });
  const run: Run = {
    principal,
    settings,
    signal,
    startedAt: Date.now(),
    rules: policy.rules,
    policyHash: policy.hash,
    problems,
    tally,
    interactiveLeft: MAX_INTERACTIVE_PER_RUN,
    queued: new Set()
  };

  for (const accountId of usableAccounts(principal, problems)) {
    if (overBudget(run)) break;
    await reconcileAccount(run, accountId, checked.accounts.find((a) => a.id === accountId) ?? null);
  }
  await sweeps(run);
  return tally;
}

export const emailReconcileJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: EMAIL_RECONCILE_JOB_KIND,
  lane: "bulk",
  timeoutMs: EMAIL_RECONCILE_TIMEOUT_MS,
  run: (ctx) => runReconcile(ctx)
});

/**
 * Every 5 minutes on the bulk lane (§3.11), only for a principal whose email
 * is installed and switched on: before that there is nothing to reconcile.
 * Three attempts (L6); a failed run is overtaken by the next one anyway.
 */
export const emailReconcileScheduledWork: ScheduledWork = Object.freeze<ScheduledWork>({
  kind: EMAIL_RECONCILE_JOB_KIND,
  lane: "bulk",
  cadence: { kind: "interval", minutes: RECONCILE_EVERY_MINUTES },
  enabled: (s) => s.emailEnabled && s.emailSchemaReady,
  maxAttempts: EMAIL_RECONCILE_MAX_ATTEMPTS
});
