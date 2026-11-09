import "server-only";

import { mergeTaskReads } from "@/lib/exec/analysis/project-detail";
import { projectsHealth, type ProjectHealth } from "@/lib/exec/analysis/projects";
import { dailyCounts, isAutoArchived, isIncident, isOverdue, upcomingDeadlines, type DailyCount } from "@/lib/exec/analysis/tasks";
import { lastAttentionRefresh } from "@/lib/exec/attention";
import { listScreenedAttention } from "@/lib/exec/attention-read";
import type { AttentionFeedItem, EmailScreenState } from "@/lib/exec/attention-types";
import { ddtextLastRunAt } from "@/lib/exec/ddtext-store";
import {
  listBucketRows,
  listCommitments,
  listSignalsForMessages,
  listThreadScreenRows,
  listTombstonedThreadIds,
  type BucketRow
} from "@/lib/exec/email-store";
import { countDraftsForSystem, getVoiceProfile, type DraftSystemCounts } from "@/lib/exec/drafts-store";
import { DRAFT_JOB_KINDS } from "@/lib/exec/drafts-types";
import {
  bucketize,
  commitmentView,
  draftsOnFor,
  loadEmailGate,
  pinnedRowMap,
  pinnedRows,
  screenCommitments,
  screenRows,
  signalMessageIds,
  summarizeMail,
  type CommitmentView,
  type EmailGate,
  type MailSummary,
  type ScreeningPolicy
} from "@/lib/exec/email-view";
import { EMAIL_ATTENTION_JOB_KIND, EMAIL_RECONCILE_JOB_KIND, EMAIL_TRIAGE_JOB_KIND } from "@/lib/exec/jobs";
import { DD_ATTENTION_KINDS } from "@/lib/exec/producers/dd";
import { slackSystemSummary } from "@/lib/exec/slack-install";
import type { SlackSystemSummary } from "@/lib/exec/slack-types";
import { listAllReplyArtifacts, loadScreeningPolicy } from "@/lib/exec/sources/mail";
import { getSyncState, parseAccountsState, parseEaTokenState, parseSendTokenState, parseSocketState } from "@/lib/exec/sync-state";
import {
  getPendingApprovals,
  listActivitySince,
  listDepartments,
  listEodNotesForDate,
  listOpenTasks,
  listProjects,
  listProjectStages,
  listStatusChangeEntries,
  listTasksByIds,
  listTasksCompletedBetween,
  listTasksCreatedBetween,
  listTimeEntriesBetween,
  listUsers
} from "@/lib/exec/sources/dd";
import type { ApprovalBucket, DdActivity, DdTask, DdTimeEntry, TaskPriority, TaskStatus } from "@/lib/exec/sources/dd-types";
import { localDateString, startOfLocalDayUtc } from "@/lib/exec/time";
import type { ExecPrincipal } from "@/lib/exec/types";
import { eodToday } from "@/lib/shift";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isTeamTask } from "@/lib/task-team";

// The /executive Overview: everything the page shows, read in one pass when
// the page renders (plan §2 "What Mitchell sees", §10 P2b).
//
// Each section stands alone. A section whose read fails comes back
// { ok: false } and the page says "couldn't load" there: it never shows a
// zero or an empty list for a read that didn't happen, and one failed table
// never takes the rest of the page down. The tiles go one step further: each
// tile carries its own result, so a single failed table blanks only the tiles
// built from it.
//
// Nothing here writes, and nothing runs the attention producers: the feed
// shows what the 10-minute job last stored, read through the one screened
// accessor (attention-read.ts, P5a S3/K8), which withholds email items the
// restricted-sender screen can't clear. Every read is bounded (sources/dd
// pages in 1000s ordered by a unique key; the feed is one page of 20), and the
// whole pass shares one deadline, so a hung query costs its sections, not the
// page.
//
// "Today" is the principal's local day. EOD is the exception: DD's EOD day is
// the America/New_York calendar day (eodToday()), so the EOD tile counts that.

/** A section's data, or the fact that it couldn't be read. */
export type OverviewSection<T> = { ok: true; data: T } | { ok: false; error: "unavailable" };

/** "record": counted straight from stored rows. "derived": computed from rows by a fixed rule. */
export type TileBasis = "record" | "derived";

export interface CountTile {
  count: number;
  basis: TileBasis;
}

export interface CompletedTile extends CountTile {
  /** Completions per local day for the last 7 days, oldest first; the last entry is today. */
  last7Days: DailyCount[];
}

export interface OverdueTile extends CountTile {
  /** How many of them the sweep auto-archived (still open, just off the board). */
  autoArchived: number;
}

export interface HoursTile {
  /** Clocked hours today, to one decimal, each person's overlapping segments counted once. */
  hours: number;
  /** People still clocked in, whose running segments are counted up to now. */
  clockedIn: number;
  basis: TileBasis;
}

export interface OverviewTiles {
  /** The principal's local day the tiles count, "YYYY-MM-DD". */
  localDate: string;
  /** The ET calendar day the EOD tile counts, "YYYY-MM-DD". */
  eodDate: string;
  completedToday: OverviewSection<CompletedTile>;
  createdToday: OverviewSection<CountTile>;
  /** Open tasks past their due date, incident tasks aside (they're due the minute they're reported). */
  openOverdue: OverviewSection<OverdueTile>;
  /** Distinct people with clocked time or task activity today; rows an intake pipeline wrote in someone's name don't count. */
  activePeople: OverviewSection<CountTile>;
  eodSubmitted: OverviewSection<CountTile>;
  hoursLogged: OverviewSection<HoursTile>;
}

export interface OverviewAttention {
  /** Highest priority first (then newest first, C5), screened, at most `limit`; each with its CAS version (C3). */
  items: AttentionFeedItem[];
  limit: number;
  /**
   * When the feed was last known to be checked (ISO), or null if never: the
   * DD pass's time (its own kinds' stamps or its job's last success, never the
   * DD text job's stamps, a-correct-16), or while email is on the older of it
   * and the email pass's.
   */
  checkedAt: string | null;
  /**
   * Email items were left out because the restricted-sender check couldn't
   * run (settings, rules or thread rows unreadable): emailScreen ===
   * "unavailable", kept for P3's card. They are hidden, not shown unchecked;
   * the card says so.
   */
  emailUnchecked: boolean;
  /** P4 (Y9): assistant drafting is on, so email items offer "Draft reply". Absent while it isn't. */
  draftsEnabled?: boolean;
  /** More active items exist than the card shows (P5a). */
  hasMore: boolean;
  /** Email items the restricted-sender screen withheld on this read: restricted, gone, no row, unparseable, unscreenable (P5a). */
  hiddenEmail: number;
  /** "none": no email item was examined; "unavailable": the screen couldn't run, so email items were withheld (C7). */
  emailScreen: EmailScreenState;
  /** When DD text triage last ran, while it is switched on (a-correct-16); null otherwise or when that can't be read. */
  ddtextCheckedAt: string | null;
  /**
   * Review ui-5: present (false) only when the settings read shows the P5a
   * migration isn't applied (ddtextSchemaReady false), so exec_attention_feedback
   * doesn't exist and rows offer no feedback controls. Absent: offer them.
   */
  feedbackAvailable?: false;
}

/** The card's freshness lines, as the full feed page shows them too (§3.13.1). */
export interface AttentionFreshness {
  checkedAt: string | null;
  ddtextCheckedAt: string | null;
}

/** The Email tab's bucket counts, after the restricted-sender screen. */
export interface OverviewEmailCounts {
  reply: number;
  urgent: number;
  important: number;
  waiting: number;
  filtered: number;
  /** Threads asking him for a decision, still awaiting his reply (AI-assessed). */
  decisionAsks: number;
}

export interface OverviewEmailCommitments {
  /** Open commitments due within `days` (overdue ones included), overdue first, at most `limit`. */
  items: CommitmentView[];
  total: number;
  days: number;
  limit: number;
}

/**
 * Email on the Overview (P3). "off" and "no_pin" read no email table at all.
 * When on, each part stands alone, like the Overview's sections.
 */
export type OverviewEmail =
  | { state: "off" }
  | { state: "no_pin" }
  | {
      state: "on";
      counts: OverviewSection<OverviewEmailCounts>;
      /** Tombstones plus stored rows the screen dropped. */
      restricted: OverviewSection<number>;
      commitments: OverviewSection<OverviewEmailCommitments>;
      /** Mail sync health for the System card. */
      mail: OverviewSection<MailSummary>;
    };

export interface OverviewApprovals {
  /** All six mechanisms in display order, zero counts included. */
  buckets: ApprovalBucket[];
  total: number;
}

/** Who holds a task: a person, a department's team pool, nobody, or an id no row matches. */
export type DeadlineOwner = { kind: "person"; name: string } | { kind: "team"; name: string } | { kind: "unassigned" } | { kind: "unknown" };

export interface DeadlineRow {
  taskId: string;
  title: string;
  dueDate: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  clientName: string | null;
  owner: DeadlineOwner;
}

export interface OverviewDeadlines {
  /** Soonest first, at most `limit`. */
  items: DeadlineRow[];
  /** Every open task due in the window, not just the ones listed. */
  total: number;
  days: number;
  limit: number;
}

export interface OverviewProjects {
  /** Worst first, at most `limit`. */
  items: ProjectHealth[];
  /** Projects with open tasks, not just the ones listed. */
  total: number;
  limit: number;
}

export interface JobKindHealth {
  kind: string;
  /** Latest success within the look-back, or null when there was none. */
  lastSuccessAt: string | null;
  /** Runs of this kind that died (no more retries) in the last 24 hours. */
  dead24h: number;
}

export interface OverviewSystem {
  /** The tracked kinds first, then any other kind seen, alphabetically. */
  kinds: JobKindHealth[];
  /** How far back lastSuccessAt looks. */
  successLookbackHours: number;
  dead24h: number;
  queued: number;
  /** Queued jobs whose run time has come; the rest wait for a retry or a later slot. */
  due: number;
  /** run_after of the due job that has waited longest, or null when none is due. */
  oldestDueAt: string | null;
  /**
   * P4 (Y7): the assistant drafts' health. Absent before the drafts schema
   * exists; null when the settings couldn't be read (the card says so).
   */
  drafts?: OverviewDraftsSystem | null;
  /**
   * P6 (contract §3.15.3): the Slack app's state, one row on the card. Absent
   * before the P6 schema exists (it needs P5b's, so nothing is read while
   * chat isn't installed); null when it couldn't be read (the card says so).
   */
  slack?: SlackSystemSummary | null;
}

/** A token's last self-check as the System card shows it. reason "not_checked": no verdict stored yet. */
export interface OverviewTokenVerdict {
  ok: boolean;
  reason: string | null;
  checkedAt: string | null;
  expiresAt: string | null;
}

/**
 * Y7. Each part fails on its own (PX12): a null token verdict, count or voice
 * row is "couldn't load", never a zero. TRACKED_JOB_KINDS doesn't list the
 * reconcile or voice jobs (they run only while a row is due, or weekly), so
 * their health shows here instead: `reconcile.overdueSince` is the oldest
 * check still due; the "Draft checks" row is amber once that is more than
 * 15 minutes old with no reconcile success since.
 */
export interface OverviewDraftsSystem {
  installed: boolean;
  draftsEnabled: boolean;
  sendEnabled: boolean;
  voiceEnabled: boolean;
  eaToken: OverviewTokenVerdict | null;
  sendToken: OverviewTokenVerdict | null;
  cl2: { ready: boolean | null; send: "off" | "all" | "some" | null };
  counts: DraftSystemCounts | null;
  reconcile: { lastSucceededAt: string | null; overdueSince: string | null } | null;
  /** null = the voice profile couldn't be read (additive: the frozen shape had no "couldn't load"). */
  voice: { status: "ready" | "insufficient" | "failed" | null; builtAt: string | null; lastAttemptAt: string | null; lastAttemptError: string | null } | null;
}

export interface OverviewSections {
  tiles: OverviewSection<OverviewTiles>;
  attention: OverviewSection<OverviewAttention>;
  approvals: OverviewSection<OverviewApprovals>;
  deadlines: OverviewSection<OverviewDeadlines>;
  projects: OverviewSection<OverviewProjects>;
  system: OverviewSection<OverviewSystem>;
  email: OverviewSection<OverviewEmail>;
}

export interface ExecOverview {
  /** The instant every section was computed for (ISO); the page renders ages from it. */
  generatedAt: string;
  /** The principal's zone. */
  timezone: string;
  sections: OverviewSections;
}

const HOUR_MS = 3_600_000;

// One page of the screened feed. The accessor refills what the
// restricted-sender screen takes out (or every email item while email is
// off), so the card isn't left short of DD items that rank below them.
const ATTENTION_LIMIT = 20;
const EMAIL_COMMITMENT_DAYS = 7;
const EMAIL_COMMITMENT_LIMIT = 6;
const DEADLINE_DAYS = 7;
const DEADLINE_LIMIT = 10;
const PROJECT_LIMIT = 8;
const SPARKLINE_DAYS = 7;
// Completions are read for this many local days, not just the sparkline's 7.
// Project health dates a project's last activity from its tasks, and a
// finished task is activity: with open tasks alone, a project that closed a
// task yesterday would read "no activity for 20 days" and go off track. Every
// finish inside the 14-day rule is seen, so the rule fires correctly, and the
// day count it prints is exact up to 30 days.
const COMPLETION_LOOKBACK_DAYS = 30;
const SUCCESS_LOOKBACK_HOURS = 48;
const DEAD_LOOKBACK_HOURS = 24;
// One budget for the whole pass. A read still running then fails, and only
// the sections built from it say "couldn't load".
const READ_TIMEOUT_MS = 15_000;

const JOB_PAGE_SIZE = 1_000;
const JOB_MAX_PAGES = 20;

// Job kinds the System card always lists, so one that stops running shows as
// "no success" instead of quietly disappearing. They match the handlers'
// kinds (handlers/dd-attention.ts, handlers/purge.ts PURGE_JOB_KIND,
// handlers/ddtext-triage.ts DDTEXT_JOB_KIND). The DD text job runs whether
// or not triage is on (off, it deletes its own data), so it is always listed.
const DD_ATTENTION_JOB = "exec.dd-attention";
const DDTEXT_JOB = "exec.ddtext-triage";
export const TRACKED_JOB_KINDS: readonly string[] = [DD_ATTENTION_JOB, "exec.purge", DDTEXT_JOB];
// Listed too while email is on (P3): its triage, reconcile and attention jobs.
export const EMAIL_TRACKED_JOB_KINDS: readonly string[] = [EMAIL_TRIAGE_JOB_KIND, EMAIL_RECONCILE_JOB_KIND, EMAIL_ATTENTION_JOB_KIND];

// The principal id goes into a PostgREST or() filter, where a comma or a
// parenthesis would change the filter; ids are "ep_" plus hex.
const SAFE_FILTER_ID = /^[A-Za-z0-9_-]{1,128}$/;

const UNAVAILABLE = { ok: false, error: "unavailable" } as const;

type Settled<T> = { ok: true; value: T } | { ok: false };

// Thrown by need() when a section's input failed. That read already logged
// its error, so build() doesn't log it again.
const INPUT_FAILED = Symbol("overview input failed");

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolves with `work`, or rejects with the signal's reason once it aborts, whichever comes first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Run one read under the shared deadline. Never rejects: a failure is logged
 * once, here, and every section that needs the read sees { ok: false }.
 */
function settle<T>(what: string, signal: AbortSignal, run: (opts: { signal: AbortSignal }) => Promise<T>): Promise<Settled<T>> {
  return untilAborted(Promise.resolve().then(() => run({ signal })), signal).then(
    (value): Settled<T> => ({ ok: true, value }),
    (err): Settled<T> => {
      console.error(`[exec-overview] ${what} read failed: ${errMessage(err)}`);
      return { ok: false };
    }
  );
}

function need<T>(read: Settled<T>): T {
  if (!read.ok) throw INPUT_FAILED;
  return read.value;
}

/** A section from `compute`, or UNAVAILABLE when an input failed or the computation threw. */
async function build<T>(what: string, compute: () => Promise<T>): Promise<OverviewSection<T>> {
  try {
    return { ok: true, data: await compute() };
  } catch (err) {
    if (err !== INPUT_FAILED) console.error(`[exec-overview] ${what} failed: ${errMessage(err)}`);
    return UNAVAILABLE;
  }
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

interface DayWindows {
  localDate: string;
  todayIso: string;
  tomorrowIso: string;
  completionsFromIso: string;
}

/**
 * The principal's local day as UTC instants. Days are stepped as calendar
 * days through startOfLocalDayUtc, never as 24-hour blocks, so a 23- or
 * 25-hour DST day still starts at local midnight.
 */
function dayWindows(now: Date, tz: string): DayWindows {
  const today = startOfLocalDayUtc(now, tz);
  // Any instant 26 hours after local midnight is inside tomorrow: a local day
  // is 23 to 25 hours long.
  const tomorrow = startOfLocalDayUtc(new Date(today.getTime() + 26 * HOUR_MS), tz);
  let first = today;
  for (let back = 1; back < COMPLETION_LOOKBACK_DAYS; back += 1) {
    first = startOfLocalDayUtc(new Date(first.getTime() - 1), tz);
  }
  return {
    localDate: localDateString(now, tz),
    todayIso: today.toISOString(),
    tomorrowIso: tomorrow.toISOString(),
    completionsFromIso: first.toISOString()
  };
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
}

/**
 * Each person's clocked time inside [fromMs, toMs], with overlapping segments
 * merged: a double clock-in is still one person's hour, not two. A running
 * segment (no end) counts up to toMs, and its person counts as clocked in.
 */
function clockedTime(entries: readonly DdTimeEntry[], fromMs: number, toMs: number) {
  const spansByUser = new Map<string, Span[]>();
  const clockedIn = new Set<string>();
  for (const e of entries) {
    if (e.endedAt === null) clockedIn.add(e.userId);
    const start = Math.max(Date.parse(e.startedAt), fromMs);
    const end = Math.min(e.endedAt === null ? toMs : Date.parse(e.endedAt), toMs);
    // NaN from an unreadable timestamp fails this test too.
    if (!(end > start)) continue;
    const spans = spansByUser.get(e.userId);
    if (spans) spans.push({ start, end });
    else spansByUser.set(e.userId, [{ start, end }]);
  }
  let totalMs = 0;
  for (const spans of spansByUser.values()) {
    spans.sort((a, b) => a.start - b.start);
    let current = spans[0];
    for (const span of spans.slice(1)) {
      if (span.start <= current.end) current = { start: current.start, end: Math.max(current.end, span.end) };
      else {
        totalMs += current.end - current.start;
        current = span;
      }
    }
    totalMs += current.end - current.start;
  }
  return { people: new Set([...spansByUser.keys(), ...clockedIn]), clockedIn, totalMs };
}

const roundHours = (ms: number) => Math.round((ms / HOUR_MS) * 10) / 10;

// Tasks DD's intake pipelines create on their own, around the clock: email
// intake (email-intake.ts), tl;dv meeting intake (tldv-intake.ts) and website
// health alerts (site-alert-routing.ts). Each writes a "created" activity row
// in the routed person's name and makes that person the task's creator.
const INTAKE_TAGS: ReadonlySet<string> = new Set(["email-intake", "tldv-intake", "site-health-alert"]);

/**
 * True for the "created" row an intake pipeline wrote in someone's name: the
 * task carries an intake tag and the row's user is its creator. That person
 * did nothing, so the row isn't activity. A human's row on the same task
 * still counts: approving an intake draft writes "created" as the approver
 * (draft-approval.ts), who isn't the creator. So does a row whose task the
 * read didn't return (deleted since): nothing shows it is intake's.
 */
function isIntakeCreatedRow(row: DdActivity, task: DdTask | undefined): boolean {
  return (
    row.action === "created" && task !== undefined && row.userId === task.creatorId && task.tags.some((tag) => INTAKE_TAGS.has(tag))
  );
}

// ---------------------------------------------------------------------------
// Deadlines and projects
// ---------------------------------------------------------------------------

function ownerOf(t: DdTask, people: ReadonlyMap<string, string>, teams: ReadonlyMap<string, string>): DeadlineOwner {
  if (t.assigneeId !== null) {
    const name = people.get(t.assigneeId);
    return name === undefined ? { kind: "unknown" } : { kind: "person", name };
  }
  // An unassigned task queued to a department sits in that team's pool.
  if (isTeamTask(t) && t.departmentId !== null) {
    const name = teams.get(t.departmentId);
    return name === undefined ? { kind: "unknown" } : { kind: "team", name };
  }
  return { kind: "unassigned" };
}

function deadlineRow(t: DdTask, people: ReadonlyMap<string, string>, teams: ReadonlyMap<string, string>): DeadlineRow {
  return {
    taskId: t.id,
    title: t.title,
    dueDate: t.dueDate,
    priority: t.priority,
    status: t.status,
    clientName: t.clientName,
    owner: ownerOf(t, people, teams)
  };
}

// ---------------------------------------------------------------------------
// System (exec_jobs)
// ---------------------------------------------------------------------------

interface JobStamp {
  kind: string;
  /** finished_at for finished jobs, run_after for queued ones. */
  at: string;
}

interface JobRows {
  succeeded: JobStamp[];
  dead: JobStamp[];
  queued: JobStamp[];
}

function jobsQuery(columns: string) {
  return getSupabaseAdmin().from("exec_jobs").select(columns);
}

type JobsQuery = ReturnType<typeof jobsQuery>;

function jobStamp(row: unknown, column: string): JobStamp {
  const r = typeof row === "object" && row !== null ? (row as Record<string, unknown>) : {};
  const kind = r.kind;
  const at = r[column];
  if (typeof kind !== "string" || kind.length === 0 || typeof at !== "string" || !Number.isFinite(Date.parse(at))) {
    throw new Error("exec_jobs read failed: malformed row");
  }
  return { kind, at };
}

/** Every matching job's kind and `column`, page by page in id order. Throws past the page ceiling. */
async function pageJobs(column: "finished_at" | "run_after", where: (q: JobsQuery) => JobsQuery, signal: AbortSignal): Promise<JobStamp[]> {
  const out: JobStamp[] = [];
  for (let page = 0; page < JOB_MAX_PAGES; page += 1) {
    const from = page * JOB_PAGE_SIZE;
    const { data, error } = await where(jobsQuery(`id,kind,${column}`))
      .order("id", { ascending: true })
      .range(from, from + JOB_PAGE_SIZE - 1)
      .abortSignal(signal);
    if (error) throw new Error(`exec_jobs read failed: ${error.message}`);
    if (!Array.isArray(data)) throw new Error("exec_jobs read failed: no rows array in the response");
    for (const row of data) out.push(jobStamp(row, column));
    if (data.length < JOB_PAGE_SIZE) return out;
  }
  throw new Error(`exec_jobs read failed: more than ${JOB_MAX_PAGES * JOB_PAGE_SIZE} rows`);
}

/**
 * The job rows the System card needs: successes in the look-back, deaths in
 * the last 24 hours, and the queue. Only his jobs and the system's own
 * (principal_id NULL), never another principal's. Kinds, statuses and times
 * only: payloads, results and error text stay in the table.
 */
async function readJobs(principal: ExecPrincipal, now: Date, signal: AbortSignal): Promise<JobRows> {
  if (!SAFE_FILTER_ID.test(principal.id)) throw new Error("exec_jobs read refused: unexpected principal id");
  const scope = `principal_id.eq.${principal.id},principal_id.is.null`;
  const since = (hours: number) => new Date(now.getTime() - hours * HOUR_MS).toISOString();
  const [succeeded, dead, queued] = await Promise.all([
    pageJobs("finished_at", (q) => q.eq("status", "succeeded").gte("finished_at", since(SUCCESS_LOOKBACK_HOURS)).or(scope), signal),
    pageJobs("finished_at", (q) => q.eq("status", "dead").gte("finished_at", since(DEAD_LOOKBACK_HOURS)).or(scope), signal),
    pageJobs("run_after", (q) => q.eq("status", "queued").or(scope), signal)
  ]);
  return { succeeded, dead, queued };
}

/** Each kind's latest success time. */
function lastSuccessByKind(rows: JobRows): Map<string, string> {
  const latest = new Map<string, string>();
  for (const job of rows.succeeded) {
    const seen = latest.get(job.kind);
    if (seen === undefined || Date.parse(job.at) > Date.parse(seen)) latest.set(job.kind, job.at);
  }
  return latest;
}

function systemHealth(rows: JobRows, now: Date, trackedKinds: readonly string[] = TRACKED_JOB_KINDS): OverviewSystem {
  const lastSuccess = lastSuccessByKind(rows);
  const deadByKind = new Map<string, number>();
  for (const job of rows.dead) deadByKind.set(job.kind, (deadByKind.get(job.kind) ?? 0) + 1);

  const nowMs = now.getTime();
  const due = rows.queued.filter((job) => Date.parse(job.at) <= nowMs);
  let oldestDueAt: string | null = null;
  for (const job of due) if (oldestDueAt === null || Date.parse(job.at) < Date.parse(oldestDueAt)) oldestDueAt = job.at;

  const tracked = new Set(trackedKinds);
  const others = [...new Set([...lastSuccess.keys(), ...deadByKind.keys(), ...rows.queued.map((job) => job.kind)])]
    .filter((kind) => !tracked.has(kind))
    .sort();
  return {
    kinds: [...trackedKinds, ...others].map((kind) => ({
      kind,
      lastSuccessAt: lastSuccess.get(kind) ?? null,
      dead24h: deadByKind.get(kind) ?? 0
    })),
    successLookbackHours: SUCCESS_LOOKBACK_HOURS,
    dead24h: rows.dead.length,
    queued: rows.queued.length,
    due: due.length,
    oldestDueAt
  };
}

/** The later of two ISO instants; null only when both are. */
function laterIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** The older of two ISO instants; null (never checked) when either is. */
function olderIso(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  return Date.parse(b) < Date.parse(a) ? b : a;
}

/**
 * When the feed was last known to be checked. The DD pass: the later of the
 * newest last_seen_at among its own kinds (a refresh that finds nothing
 * stamps no row) and its job's last success; never the DD text job's stamps
 * (a-correct-16). While email is on (emailCheckedAt defined), the older of
 * that and the email pass's time, so a stalled pass shows as behind (ui-10).
 */
function feedCheckedAt(ddRefresh: string | null, jobs: Settled<JobRows>, emailCheckedAt: string | null | undefined): string | null {
  const lastRun = jobs.ok ? (lastSuccessByKind(jobs.value).get(DD_ATTENTION_JOB) ?? null) : null;
  const ddCheckedAt = laterIso(ddRefresh, lastRun);
  return emailCheckedAt === undefined ? ddCheckedAt : olderIso(ddCheckedAt, emailCheckedAt);
}

/** The DD freshness read: the newest last_seen_at among the DD producer's own kinds (DD_ATTENTION_KINDS). */
function ddAttentionRefresh(principal: ExecPrincipal): Promise<string | null> {
  return lastAttentionRefresh(principal, "dd", { kinds: DD_ATTENTION_KINDS });
}

/**
 * When DD text triage last ran (ddtext-store's ddtextLastRunAt), while it is
 * switched on; null when it is off, the settings can't be read, or the read
 * fails (the second freshness line just doesn't show).
 */
function ddtextFreshness(principal: ExecPrincipal, read: OverviewRead, gateRead: Promise<Settled<EmailGate>>): Promise<string | null> {
  return gateRead.then(async (gate) => {
    if (!gate.ok || !gate.value.settings.ddtextEnabled) return null;
    const last = await read("ddtext freshness", (o) => ddtextLastRunAt(principal, o));
    return last.ok ? last.value : null;
  });
}

// ---------------------------------------------------------------------------
// The overview
// ---------------------------------------------------------------------------

/**
 * Everything the Overview page shows, for `principal` at `now`. Never throws
 * for a failed read: that section comes back { ok: false }. A missing
 * principal or an invalid `now` is a TypeError, before anything is read.
 */
export async function getOverview(principal: ExecPrincipal, now: Date = new Date()): Promise<ExecOverview> {
  if (!principal || typeof principal.id !== "string" || principal.id.length === 0) {
    throw new TypeError("exec overview: an ExecPrincipal is required");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("exec overview: now must be a valid Date");

  const tz = principal.timezone;
  const nowIso = now.toISOString();
  const day = dayWindows(now, tz);
  const eodDate = eodToday(now);
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
  const read = <T>(what: string, run: (opts: { signal: AbortSignal }) => Promise<T>) => settle(what, signal, run);

  // Every read starts now, once. Sections that share one await the same promise.
  const openTasks = read("open tasks", (o) => listOpenTasks(principal, o));
  const completed = read("completed tasks", (o) => listTasksCompletedBetween(principal, day.completionsFromIso, day.tomorrowIso, o));
  const created = read("created tasks", (o) => listTasksCreatedBetween(principal, day.todayIso, day.tomorrowIso, o));
  const timeEntries = read("time entries", (o) => listTimeEntriesBetween(principal, day.todayIso, nowIso, o));
  const activity = read("activity", (o) => listActivitySince(principal, day.todayIso, {}, o));
  const eodNotes = read("EOD notes", (o) => listEodNotesForDate(principal, eodDate, o));
  const users = read("users", (o) => listUsers(principal, o));
  const departments = read("departments", (o) => listDepartments(principal, o));
  const projects = read("projects", (o) => listProjects(principal, o));
  const approvals = read("approvals", (o) => getPendingApprovals(principal, now, o));
  // The feed: one screened page (S3). Email items are screened inside the
  // accessor against the rules and their threads' rows (K8, A2).
  const attentionPage = read("attention items", (o) => listScreenedAttention(principal, { limit: ATTENTION_LIMIT }, { now, signal: o.signal }));
  const attentionRefresh = read("attention refresh", () => ddAttentionRefresh(principal));
  const jobs = read("jobs", (o) => readJobs(principal, now, o.signal));
  // Email (P3): the gate first; no email table is read unless it says on.
  const emailGate = read("email settings", () => loadEmailGate(principal));
  const email = emailReads(principal, now, read, emailGate);
  const ddtextCheckedAt = ddtextFreshness(principal, read, emailGate);

  const tiles = (async (): Promise<OverviewSection<OverviewTiles>> => {
    const nowMs = now.getTime();
    const todayMs = Date.parse(day.todayIso);
    const [completedToday, createdToday, openOverdue, activePeople, eodSubmitted, hoursLogged] = await Promise.all([
      build("completed today", async (): Promise<CompletedTile> => {
        const last7Days = dailyCounts(need(await completed).map((t) => t.completedAt), tz, SPARKLINE_DAYS, now);
        const today = last7Days[last7Days.length - 1];
        // dailyCounts ends on today; anything else is a bug, never a zero.
        if (today?.date !== day.localDate) throw new Error("the daily series doesn't end on today");
        return { count: today.count, last7Days, basis: "record" };
      }),
      build("created today", async (): Promise<CountTile> => ({ count: need(await created).length, basis: "record" })),
      build("open overdue", async (): Promise<OverdueTile> => {
        // An incident's task is due the minute it's reported (isIncident), so
        // it isn't late work. The feed shows it as an open incident, and the
        // tile counts the past-due work the feed shows: its overdue items,
        // plus the proofs waiting for review past their tasks' due dates,
        // which it lists under that queue's approval item.
        const overdue = need(await openTasks).filter((t) => isOverdue(t, now) && !isIncident(t));
        return { count: overdue.length, autoArchived: overdue.filter(isAutoArchived).length, basis: "derived" };
      }),
      build("active people", async (): Promise<CountTile> => {
        const people = clockedTime(need(await timeEntries), todayMs, nowMs).people;
        const rows = need(await activity);
        // The tasks behind today's "created" rows, to drop the ones intake
        // wrote in someone's name (isIntakeCreatedRow). A failed read fails
        // this tile: counting those rows would overcount, dropping all of
        // them would undercount.
        const createdIds = [...new Set(rows.filter((a) => a.action === "created").map((a) => a.taskId))];
        const createdRowTasks =
          createdIds.length === 0 ? [] : await untilAborted(listTasksByIds(principal, createdIds, { signal }), signal);
        const tasksById = new Map(createdRowTasks.map((t) => [t.id, t]));
        for (const a of rows) if (!isIntakeCreatedRow(a, tasksById.get(a.taskId))) people.add(a.userId);
        return { count: people.size, basis: "derived" };
      }),
      build("EOD submitted", async (): Promise<CountTile> => ({
        count: need(await eodNotes).filter((n) => n.submittedAt !== null).length,
        basis: "record"
      })),
      build("hours logged", async (): Promise<HoursTile> => {
        const clocked = clockedTime(need(await timeEntries), todayMs, nowMs);
        return { hours: roundHours(clocked.totalMs), clockedIn: clocked.clockedIn.size, basis: "derived" };
      })
    ]);
    const all = [completedToday, createdToday, openOverdue, activePeople, eodSubmitted, hoursLogged];
    // With every tile down (the database is unreachable), one banner says so
    // instead of six dashes.
    if (all.every((tile) => !tile.ok)) return UNAVAILABLE;
    return {
      ok: true,
      data: { localDate: day.localDate, eodDate, completedToday, createdToday, openOverdue, activePeople, eodSubmitted, hoursLogged }
    };
  })();

  const attention = build("attention", async (): Promise<OverviewAttention> => {
    // Screened in the accessor (A2): an email item whose thread is now a
    // tombstone, gone, or matched by a current rule is never shown, even in
    // the minutes before the attention pass removes it.
    const page = need(await attentionPage);
    const refreshedAt = need(await attentionRefresh);
    // A refresh that finds nothing stamps no row, so the item timestamps alone
    // can't say a check ran. The refresh job's last success can; without the
    // job history the feed falls back to its own timestamps (older, never newer).
    const jobsRead = await jobs;
    // While email is on, its items share this feed and come from their own
    // pass: the card is only as fresh as the older of the two, so a stalled
    // email pass shows as "may be behind" instead of hiding behind the DD
    // pass's time (ui-10).
    const emailCheckedAt = await email.itemsCheckedAt(jobsRead);
    const gate = await emailGate;
    const draftsEnabled = gate.ok && gate.value.kind === "on" && draftsOnFor(gate.value.settings);
    const feedbackMissing = gate.ok && !gate.value.settings.ddtextSchemaReady;
    return {
      items: page.items.slice(0, ATTENTION_LIMIT),
      limit: ATTENTION_LIMIT,
      checkedAt: feedCheckedAt(refreshedAt, jobsRead, emailCheckedAt),
      emailUnchecked: page.emailScreen === "unavailable",
      hasMore: page.nextCursor !== null,
      hiddenEmail: page.hiddenEmail,
      emailScreen: page.emailScreen,
      ddtextCheckedAt: await ddtextCheckedAt,
      ...(draftsEnabled ? { draftsEnabled: true } : {}),
      ...(feedbackMissing ? { feedbackAvailable: false as const } : {})
    };
  });

  const approvalsSection = build("approvals", async (): Promise<OverviewApprovals> => {
    const buckets = need(await approvals);
    return { buckets, total: buckets.reduce((sum, b) => sum + b.count, 0) };
  });

  const deadlines = build("deadlines", async (): Promise<OverviewDeadlines> => {
    const upcoming = upcomingDeadlines(need(await openTasks), now, DEADLINE_DAYS);
    // Names are only needed for rows; "nothing due" holds without them.
    if (upcoming.length === 0) return { items: [], total: 0, days: DEADLINE_DAYS, limit: DEADLINE_LIMIT };
    const people = new Map(need(await users).map((u) => [u.id, u.name]));
    const teams = new Map(need(await departments).map((d) => [d.id, d.name]));
    return {
      items: upcoming.slice(0, DEADLINE_LIMIT).map((t) => deadlineRow(t, people, teams)),
      total: upcoming.length,
      days: DEADLINE_DAYS,
      limit: DEADLINE_LIMIT
    };
  });

  const projectsSection = build("projects", async (): Promise<OverviewProjects> => {
    const open = need(await openTasks);
    const withOpenWork = new Set(open.flatMap((t) => (t.projectId === null ? [] : [t.projectId])));
    const listed = need(await projects).filter((p) => withOpenWork.has(p.id));
    if (listed.length === 0) return { items: [], total: 0, limit: PROJECT_LIMIT };
    const recent = need(await completed);
    const ids = new Set(listed.map((p) => p.id));
    const waiting = open.filter((t) => t.status === "waiting_on_client" && t.projectId !== null && ids.has(t.projectId)).map((t) => t.id);
    const [stages, entries] = await Promise.all([
      untilAborted(listProjectStages(principal, [...ids], { signal }), signal),
      untilAborted(listStatusChangeEntries(principal, waiting, "waiting_on_client", { signal }), signal)
    ]);
    // Open tasks plus recent completions, one row per id (the open copy kept): analysis/project-detail.ts.
    const health = projectsHealth(listed, stages, mergeTaskReads(open, recent), now, {
      waitingSince: new Map(entries.map((e) => [e.taskId, e.enteredAt]))
    });
    return { items: health.slice(0, PROJECT_LIMIT), total: health.length, limit: PROJECT_LIMIT };
  });

  const draftsSystem = draftsSystemReads(principal, now, read, emailGate, jobs);
  const slackSystem = slackSystemRead(principal, read, emailGate);

  const system = build("system", async (): Promise<OverviewSystem> => {
    const rows = need(await jobs);
    const gate = await emailGate;
    const health = systemHealth(rows, now, gate.ok && gate.value.kind === "on" ? [...TRACKED_JOB_KINDS, ...EMAIL_TRACKED_JOB_KINDS] : TRACKED_JOB_KINDS);
    const drafts = await draftsSystem;
    const slack = await slackSystem;
    return { ...health, ...(drafts === undefined ? {} : { drafts }), ...(slack === undefined ? {} : { slack }) };
  });

  const [tilesResult, attentionResult, approvalsResult, deadlinesResult, projectsResult, systemResult, emailResult] = await Promise.all([
    tiles,
    attention,
    approvalsSection,
    deadlines,
    projectsSection,
    system,
    email.section
  ]);
  return {
    generatedAt: nowIso,
    timezone: tz,
    sections: {
      tiles: tilesResult,
      attention: attentionResult,
      approvals: approvalsResult,
      deadlines: deadlinesResult,
      projects: projectsResult,
      system: systemResult,
      email: emailResult
    }
  };
}

// ---------------------------------------------------------------------------
// Assistant drafts on the System card (P4, Y7)
// ---------------------------------------------------------------------------

function tokenVerdict(read: Settled<{ value: { ok: boolean; reason: string | null; checkedAt: string; expiresAt: string | null } } | null>): OverviewTokenVerdict | null {
  if (!read.ok) return null;
  const v = read.value?.value;
  if (!v) return { ok: false, reason: "not_checked", checkedAt: null, expiresAt: null };
  return { ok: v.ok, reason: v.reason, checkedAt: v.checkedAt, expiresAt: v.expiresAt };
}

/**
 * The System card's drafts rows (Y7): nothing is read before the drafts
 * schema exists (undefined: the card is P3's), and each read fails on its
 * own. Codes, counts and times only: no draft content is read here.
 */
async function draftsSystemReads(
  principal: ExecPrincipal,
  now: Date,
  read: OverviewRead,
  gateRead: Promise<Settled<EmailGate>>,
  jobsRead: Promise<Settled<JobRows>>
): Promise<OverviewDraftsSystem | null | undefined> {
  const gate = await gateRead;
  if (!gate.ok) return null;
  const settings = gate.value.settings;
  if (!settings.draftsSchemaReady) return undefined;
  const [ea, send, counts, voice, jobs] = await Promise.all([
    read("draft token state", (o) => getSyncState(principal, "clone-ea", "ea-token", parseEaTokenState, o)),
    read("send token state", (o) => getSyncState(principal, "clone-ea", "send-token", parseSendTokenState, o)),
    read("draft counts", (o) => countDraftsForSystem(principal, now, o)),
    read("voice profile", (o) => getVoiceProfile(principal, o)),
    jobsRead
  ]);
  const eaState = ea.ok ? (ea.value?.value ?? null) : null;
  const countsValue = counts.ok ? counts.value : null;
  const lastReconcile = jobs.ok ? (lastSuccessByKind(jobs.value).get(DRAFT_JOB_KINDS.reconcile) ?? null) : null;
  const v = voice.ok ? voice.value : undefined;
  return {
    installed: true,
    draftsEnabled: draftsOnFor(settings),
    sendEnabled: draftsOnFor(settings) && settings.sendEnabled,
    voiceEnabled: settings.voiceEnabled,
    eaToken: tokenVerdict(ea),
    sendToken: tokenVerdict(send),
    cl2: { ready: eaState?.cl2Ready ?? null, send: eaState?.cl2Send ?? null },
    counts: countsValue,
    reconcile: countsValue === null ? null : { lastSucceededAt: lastReconcile, overdueSince: countsValue.oldestDueAt },
    voice:
      v === undefined
        ? null
        : v === null
          ? { status: null, builtAt: null, lastAttemptAt: null, lastAttemptError: null }
          : { status: v.status, builtAt: v.status === "ready" ? v.builtAt : null, lastAttemptAt: v.lastAttemptAt, lastAttemptError: v.lastAttemptError }
  };
}

// ---------------------------------------------------------------------------
// Slack on the System card (P6, contract §3.15.3)
// ---------------------------------------------------------------------------

/**
 * The System card's Slack row: undefined (no row) while P5b's chat schema
 * isn't installed (P6's migration requires it, so nothing is read) or once
 * slackSystemSummary says the P6 tables aren't there; null when the settings
 * or the installation read failed (logged once by read()). State, times and
 * an error code only: no token or blob is read here.
 */
async function slackSystemRead(
  principal: ExecPrincipal,
  read: OverviewRead,
  gateRead: Promise<Settled<EmailGate>>
): Promise<SlackSystemSummary | null | undefined> {
  const gate = await gateRead;
  if (!gate.ok) return null;
  if (gate.value.settings.chatSchemaReady !== true) return undefined;
  const summary = await read("slack status", () => slackSystemSummary(principal));
  if (!summary.ok) return null;
  return summary.value ?? undefined;
}

// ---------------------------------------------------------------------------
// Email (P3)
// ---------------------------------------------------------------------------

type OverviewRead = <T>(what: string, run: (opts: { signal: AbortSignal }) => Promise<T>) => Promise<Settled<T>>;

interface OverviewEmailReads {
  /** The email section. */
  section: Promise<OverviewSection<OverviewEmail>>;
  /**
   * When the email attention pass last refreshed the feed's email items
   * (ISO, null = never), or undefined while email is off (its items aren't
   * shown). Rejects (via need) when that read failed.
   */
  itemsCheckedAt: (jobs: Settled<JobRows>) => Promise<string | null | undefined>;
}

const SKIPPED: Settled<never> = { ok: false };

/**
 * The Overview's email reads (contract §3.14, A2, coherence-9), all under
 * the page's deadline. Nothing past exec_settings is read unless the gate
 * says email is on; when it is, each part fails on its own. The feed's email
 * items are screened by the accessor (attention-read.ts, P5a K8), not here.
 */
function emailReads(principal: ExecPrincipal, now: Date, read: OverviewRead, gateRead: Promise<Settled<EmailGate>>): OverviewEmailReads {
  const on = gateRead.then((g) => g.ok && g.value.kind === "on");
  const when = <T>(what: string, run: (opts: { signal: AbortSignal }) => Promise<T>): Promise<Settled<T>> =>
    on.then((yes) => (yes ? read(what, run) : SKIPPED));

  const policy = when("email rules", (o): Promise<ScreeningPolicy> => loadScreeningPolicy(principal, o));
  const rows = when("email threads", (o) => listBucketRows(principal, now, o));
  const artifacts = when("email reply artifacts", (o) => listAllReplyArtifacts(principal, o));
  const tombstones = when("email tombstones", (o) => listTombstonedThreadIds(principal, o));
  const dueBefore = new Date(now.getTime() + EMAIL_COMMITMENT_DAYS * 86_400_000).toISOString();
  const commitments = when("email commitments", (o) => listCommitments(principal, { statuses: ["open"], dueBefore }, o));
  const accounts = when("mail accounts", (o) => getSyncState(principal, "mail", "accounts", parseAccountsState, o));
  const socket = when("mail socket", (o) => getSyncState(principal, "mail", "socket", parseSocketState, o));

  // Only the mailboxes pinned to him now count (ui-3): a row of an account he
  // no longer has pinned would be counted and linked here, and 404 there.
  const screened = Promise.all([policy, rows]).then(([p, r]): Settled<{ kept: BucketRow[]; dropped: number }> =>
    p.ok && r.ok ? { ok: true, value: screenRows(pinnedRows(principal, r.value), p.value) } : SKIPPED
  );
  const signals = screened.then((s) => (s.ok ? read("email signals", (o) => listSignalsForMessages(principal, signalMessageIds(s.value.kept), o)) : SKIPPED));
  const commitmentRows = commitments.then((c) =>
    c.ok
      ? read("email commitment threads", async (o) => pinnedRowMap(principal, await listThreadScreenRows(principal, [...new Set(c.value.map((x) => x.threadId))], o)))
      : SKIPPED
  );
  // How fresh the feed's email items are (ui-10): the email attention pass's own last refresh.
  const refresh = when("email attention refresh", () => lastAttentionRefresh(principal, "email"));

  const section = build("email", async (): Promise<OverviewEmail> => {
    const gate = need(await gateRead);
    if (gate.kind !== "on") return { state: gate.kind };
    const [counts, restricted, due, mail] = await Promise.all([
      build("email counts", async (): Promise<OverviewEmailCounts> => {
        const kept = need(await screened).kept;
        const b = bucketize(kept, need(await signals), need(await artifacts), now);
        return { ...b.counts, decisionAsks: b.decisionAsks };
      }),
      build("email restricted", async (): Promise<number> => need(await tombstones).length + need(await screened).dropped),
      build("email commitments", async (): Promise<OverviewEmailCommitments> => {
        const p = need(await policy);
        const s = await screened;
        const subjects = new Map<string, string | null>(s.ok ? s.value.kept.map((r) => [r.threadId, r.subject]) : []);
        const views = screenCommitments(need(await commitments), need(await commitmentRows), p)
          .kept.map((c) => commitmentView(c, now, subjects, false))
          .sort((a, b) => (a.overdue === b.overdue ? 0 : a.overdue ? -1 : 1));
        return { items: views.slice(0, EMAIL_COMMITMENT_LIMIT), total: views.length, days: EMAIL_COMMITMENT_DAYS, limit: EMAIL_COMMITMENT_LIMIT };
      }),
      build("mail health", async (): Promise<MailSummary> => {
        const a = need(await accounts);
        const s = need(await socket);
        return summarizeMail(a?.value ?? null, s?.value ?? null, gate.pinned, now);
      })
    ]);
    return { state: "on", counts, restricted, commitments: due, mail };
  });

  const itemsCheckedAt = async (jobs: Settled<JobRows>): Promise<string | null | undefined> => {
    const gate = await gateRead;
    if (!gate.ok || gate.value.kind !== "on") return undefined;
    const lastRun = jobs.ok ? (lastSuccessByKind(jobs.value).get(EMAIL_ATTENTION_JOB_KIND) ?? null) : null;
    return laterIso(need(await refresh), lastRun);
  };

  return { section, itemsCheckedAt };
}

// ---------------------------------------------------------------------------
// The feed's freshness for the full feed page (P5a §3.13.1, a-correct-16)
// ---------------------------------------------------------------------------

/**
 * The Needs Attention card's two freshness lines, computed exactly as
 * getOverview computes them (feedCheckedAt, ddtextFreshness), for the full
 * feed page at /executive/attention, so the two surfaces never disagree:
 * checkedAt from the DD producer's own kinds and its job's last success (and
 * the email pass's while email is on); ddtextCheckedAt while DD text triage is
 * on. { ok: false } when the DD refresh or, with email on, the email refresh
 * can't be read (never a wrong time). Never throws for a failed read.
 */
export async function getAttentionFreshness(principal: ExecPrincipal, now: Date = new Date()): Promise<OverviewSection<AttentionFreshness>> {
  if (!principal || typeof principal.id !== "string" || principal.id.length === 0) {
    throw new TypeError("exec attention freshness: an ExecPrincipal is required");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("exec attention freshness: now must be a valid Date");
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
  const read: OverviewRead = (what, run) => settle(what, signal, run);
  const refresh = read("attention refresh", () => ddAttentionRefresh(principal));
  const jobs = read("jobs", (o) => readJobs(principal, now, o.signal));
  const gateRead = read("email settings", () => loadEmailGate(principal));
  const emailRefresh = gateRead.then((g) => (g.ok && g.value.kind === "on" ? read("email attention refresh", () => lastAttentionRefresh(principal, "email")) : SKIPPED));
  const ddtext = ddtextFreshness(principal, read, gateRead);
  return build("attention freshness", async (): Promise<AttentionFreshness> => {
    const ddRefresh = need(await refresh);
    const jobsRead = await jobs;
    const gate = await gateRead;
    // As emailReads' itemsCheckedAt: email counts only while it is on (its items show only then).
    const emailOn = gate.ok && gate.value.kind === "on";
    const lastEmailRun = jobsRead.ok ? (lastSuccessByKind(jobsRead.value).get(EMAIL_ATTENTION_JOB_KIND) ?? null) : null;
    const emailCheckedAt = emailOn ? laterIso(need(await emailRefresh), lastEmailRun) : undefined;
    return { checkedAt: feedCheckedAt(ddRefresh, jobsRead, emailCheckedAt), ddtextCheckedAt: await ddtext };
  });
}
