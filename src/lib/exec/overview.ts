import "server-only";

import { projectsHealth, type ProjectHealth } from "@/lib/exec/analysis/projects";
import { dailyCounts, isAutoArchived, isIncident, isOverdue, upcomingDeadlines, type DailyCount } from "@/lib/exec/analysis/tasks";
import { lastAttentionRefresh, listAttention } from "@/lib/exec/attention";
import type { AttentionItem } from "@/lib/exec/attention-types";
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
// shows what the 10-minute job last stored. Every read is bounded (sources/dd
// pages in 1000s ordered by a unique key; the feed is capped at 20), and the
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
  /** Highest priority first, at most `limit`. */
  items: AttentionItem[];
  limit: number;
  /** When the DD feed was last known to be checked (ISO), or null if never. */
  checkedAt: string | null;
}

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
}

export interface OverviewSections {
  tiles: OverviewSection<OverviewTiles>;
  attention: OverviewSection<OverviewAttention>;
  approvals: OverviewSection<OverviewApprovals>;
  deadlines: OverviewSection<OverviewDeadlines>;
  projects: OverviewSection<OverviewProjects>;
  system: OverviewSection<OverviewSystem>;
}

export interface ExecOverview {
  /** The instant every section was computed for (ISO); the page renders ages from it. */
  generatedAt: string;
  /** The principal's zone. */
  timezone: string;
  sections: OverviewSections;
}

const HOUR_MS = 3_600_000;

const ATTENTION_LIMIT = 20;
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
// kinds (handlers/dd-attention.ts, handlers/purge.ts PURGE_JOB_KIND).
const DD_ATTENTION_JOB = "exec.dd-attention";
export const TRACKED_JOB_KINDS: readonly string[] = [DD_ATTENTION_JOB, "exec.purge"];

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

/**
 * Open tasks plus recent completions, one row per id. The two reads aren't one
 * snapshot, so a task finished between them can come back from both; the
 * open copy is kept.
 */
function mergeTasks(open: readonly DdTask[], completed: readonly DdTask[]): DdTask[] {
  const seen = new Set(open.map((t) => t.id));
  return [...open, ...completed.filter((t) => !seen.has(t.id))];
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

function systemHealth(rows: JobRows, now: Date): OverviewSystem {
  const lastSuccess = lastSuccessByKind(rows);
  const deadByKind = new Map<string, number>();
  for (const job of rows.dead) deadByKind.set(job.kind, (deadByKind.get(job.kind) ?? 0) + 1);

  const nowMs = now.getTime();
  const due = rows.queued.filter((job) => Date.parse(job.at) <= nowMs);
  let oldestDueAt: string | null = null;
  for (const job of due) if (oldestDueAt === null || Date.parse(job.at) < Date.parse(oldestDueAt)) oldestDueAt = job.at;

  const tracked = new Set(TRACKED_JOB_KINDS);
  const others = [...new Set([...lastSuccess.keys(), ...deadByKind.keys(), ...rows.queued.map((job) => job.kind)])]
    .filter((kind) => !tracked.has(kind))
    .sort();
  return {
    kinds: [...TRACKED_JOB_KINDS, ...others].map((kind) => ({
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
  const attentionItems = read("attention items", () => listAttention(principal, { limit: ATTENTION_LIMIT, now }));
  const attentionRefresh = read("attention refresh", () => lastAttentionRefresh(principal, "dd"));
  const jobs = read("jobs", (o) => readJobs(principal, now, o.signal));

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
    const items = need(await attentionItems);
    const refreshedAt = need(await attentionRefresh);
    // A refresh that finds nothing stamps no row, so the item timestamps alone
    // can't say a check ran. The refresh job's last success can; without the
    // job history the feed falls back to its own timestamps (older, never newer).
    const jobsRead = await jobs;
    const lastRun = jobsRead.ok ? (lastSuccessByKind(jobsRead.value).get(DD_ATTENTION_JOB) ?? null) : null;
    return { items, limit: ATTENTION_LIMIT, checkedAt: laterIso(refreshedAt, lastRun) };
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
    const health = projectsHealth(listed, stages, mergeTasks(open, recent), now, {
      waitingSince: new Map(entries.map((e) => [e.taskId, e.enteredAt]))
    });
    return { items: health.slice(0, PROJECT_LIMIT), total: health.length, limit: PROJECT_LIMIT };
  });

  const system = build("system", async (): Promise<OverviewSystem> => systemHealth(need(await jobs), now));

  const [tilesResult, attentionResult, approvalsResult, deadlinesResult, projectsResult, systemResult] = await Promise.all([
    tiles,
    attention,
    approvalsSection,
    deadlines,
    projectsSection,
    system
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
      system: systemResult
    }
  };
}
