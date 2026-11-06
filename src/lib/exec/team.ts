import "server-only";

import { PROOF_ACTIONS, STAGE_CLOSE_GUARD_ACTIONS } from "@/lib/exec/analysis/tasks";
import { buildTeamView, teamWindowRange, teamWindows, type TeamInput } from "@/lib/exec/analysis/team";
import { ddTaskRef } from "@/lib/exec/refs";
import {
  listActivitySince,
  listDepartments,
  listEodNotesBetween,
  listOpenTasks,
  listStatusTransitions,
  listTaskExtensionsForTasks,
  listTaskHours,
  listTasksCompletedBetween,
  listTimeEntriesBetween,
  listUsers,
  listUserSchedules
} from "@/lib/exec/sources/dd";
import type { DdActivity, DdStatusTransition, DdTask, DdTaskExtension, DdTaskHours } from "@/lib/exec/sources/dd-types";
import type { ExecPrincipal } from "@/lib/exec/types";
import type { Cell, TeamView, TeamWindow, WorkingNowRow } from "@/lib/exec/view-types";

// The Team tab's service (P5a contract §3.10, A3, C15, C30). One 15 s
// deadline over DD's records, combined with the caller's signal (P5b's tool
// timeouts, coherence-11) and passed to every read; each failed read blanks
// only the cells built from it. P5b's team_progress reads the same service
// with a window (coherence-10). Nothing here reads free text.

const READ_TIMEOUT_MS = 15_000;
const HOUR_MS = 3_600_000;
/** Clock segments: enough to cover "today" in every zone. */
const CLOCK_LOOKBACK_HOURS = 26;

type Settled<T> = Cell<T>;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The service's own deadline, combined with the caller's signal when there is one. */
function deadlineSignal(caller: AbortSignal | undefined): AbortSignal {
  const deadline = AbortSignal.timeout(READ_TIMEOUT_MS);
  if (!caller) return deadline;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([caller, deadline]);
  const controller = new AbortController();
  const abort = (from: AbortSignal) => () => controller.abort(from.reason);
  if (caller.aborted) controller.abort(caller.reason);
  else {
    caller.addEventListener("abort", abort(caller), { once: true });
    deadline.addEventListener("abort", abort(deadline), { once: true });
  }
  return controller.signal;
}

/** Resolves with `work`, or rejects once the signal aborts, whichever comes first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** One read under the deadline. Never rejects: a failure is logged once and reads as { ok: false }. */
function settle<T>(what: string, signal: AbortSignal, run: (opts: { signal: AbortSignal }) => Promise<T>): Promise<Settled<T>> {
  return untilAborted(Promise.resolve().then(() => run({ signal })), signal).then(
    (value): Settled<T> => ({ ok: true, value }),
    (err): Settled<T> => {
      console.error(`[exec-team] ${what} read failed: ${errMessage(err)}`);
      return { ok: false };
    }
  );
}

const FAILED = { ok: false } as const;
const ok = <T>(value: T): Settled<T> => ({ ok: true, value });

function earliest(isos: readonly string[]): string | null {
  let best: string | null = null;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const iso of isos) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms) && ms < bestMs) {
      best = new Date(ms).toISOString();
      bestMs = ms;
    }
  }
  return best;
}

function groupByTask<T extends { taskId: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const list = out.get(r.taskId);
    if (list) list.push(r);
    else out.set(r.taskId, [r]);
  }
  return out;
}

/**
 * The Team tab (A3): per listed person and per department, open work,
 * overdue, stalled, completions (this week, last week and the requested
 * window), capacity load, EOD rate and the 30-day indicators, each with its
 * basis and n. Reads (C15, a-correct-12, C30):
 *   users, schedules, departments, open tasks;
 *   completions from min(last week's start, indicatorsFrom, the window's start) to now;
 *   proof events from the earliest created_at of those completions (never the window start);
 *   for the completed stage tasks, their status transitions and proof_approved rows since their earliest created_at;
 *   extensions of open ∪ completed tasks; hours of open assigned tasks;
 *   clock segments of the last 26 hours; EOD status for the 30 ET days ending yesterday.
 * A caller's aborted signal throws; the deadline blanks what didn't finish.
 */
export async function getTeamView(
  principal: ExecPrincipal,
  opts: { now?: Date; window?: TeamWindow; signal?: AbortSignal } = {}
): Promise<TeamView> {
  const now = opts.now ?? new Date();
  const window = opts.window ?? "this_week";
  const tz = principal.timezone;
  const windows = teamWindows(now, tz);
  const range = teamWindowRange(window, now, tz);
  const signal = deadlineSignal(opts.signal);
  const read = <T>(what: string, run: (o: { signal: AbortSignal }) => Promise<T>) => settle(what, signal, run);

  const completedFrom = new Date(
    Math.min(Date.parse(windows.lastWeekStart), Date.parse(windows.indicatorsFrom), range.from.getTime())
  ).toISOString();

  const users = read("users", (o) => listUsers(principal, o));
  const schedules = read("user schedules", (o) => listUserSchedules(principal, o));
  const departments = read("departments", (o) => listDepartments(principal, o));
  const openTasks = read("open tasks", (o) => listOpenTasks(principal, o));
  const completed = read("completed tasks", (o) => listTasksCompletedBetween(principal, completedFrom, now.toISOString(), o));
  const timeEntries = read("time entries", (o) =>
    listTimeEntriesBetween(principal, new Date(now.getTime() - CLOCK_LOOKBACK_HOURS * HOUR_MS).toISOString(), now.toISOString(), o)
  );
  const eodNotes = read("eod notes", (o) => listEodNotesBetween(principal, windows.eodFromYmd, windows.eodToYmd, o));

  const proofEvents = completed.then(async (c): Promise<Settled<Map<string, DdActivity[]>>> => {
    if (!c.ok) return FAILED;
    const since = earliest(c.value.map((t) => t.createdAt));
    if (since === null) return ok(new Map());
    const rows = await read("proof events", (o) =>
      listActivitySince(principal, since, { taskIds: c.value.map((t) => t.id), actions: PROOF_ACTIONS }, o)
    );
    return rows.ok ? ok(groupByTask(rows.value)) : FAILED;
  });

  const stageTasks = completed.then((c) => (c.ok ? c.value.filter((t) => t.stageId != null) : null));
  const stageSince = stageTasks.then((tasks) => (tasks === null ? null : earliest(tasks.map((t) => t.createdAt))));
  const stageTransitions = Promise.all([stageTasks, stageSince]).then(async ([tasks, since]): Promise<Settled<DdStatusTransition[]>> => {
    if (tasks === null) return FAILED;
    if (since === null) return ok([]);
    return read("stage transitions", (o) => listStatusTransitions(principal, tasks.map((t) => t.id), since, o));
  });
  const stageApprovals = Promise.all([stageTasks, stageSince]).then(async ([tasks, since]): Promise<Settled<DdActivity[]>> => {
    if (tasks === null) return FAILED;
    if (since === null) return ok([]);
    return read("stage approvals", (o) => listActivitySince(principal, since, { taskIds: tasks.map((t) => t.id), actions: STAGE_CLOSE_GUARD_ACTIONS }, o));
  });

  const extensions = Promise.all([openTasks, completed]).then(async ([o, c]): Promise<Settled<Map<string, DdTaskExtension[]>>> => {
    if (!o.ok || !c.ok) return FAILED;
    const ids = [...new Set([...o.value, ...c.value].map((t) => t.id))];
    if (ids.length === 0) return ok(new Map());
    const rows = await read("task extensions", (r) => listTaskExtensionsForTasks(principal, ids, r));
    return rows.ok ? ok(groupByTask(rows.value)) : FAILED;
  });

  const hours = openTasks.then(async (o): Promise<Settled<Map<string, DdTaskHours>>> => {
    if (!o.ok) return FAILED;
    const ids = o.value.filter((t) => t.assigneeId !== null).map((t) => t.id);
    if (ids.length === 0) return ok(new Map());
    const rows = await read("task hours", (r) => listTaskHours(principal, ids, r));
    return rows.ok ? ok(new Map(rows.value.map((h) => [h.taskId, h]))) : FAILED;
  });

  const [u, s, d, o, c, p, st, sa, x, h, t, e] = await Promise.all([
    users,
    schedules,
    departments,
    openTasks,
    completed,
    proofEvents,
    stageTransitions,
    stageApprovals,
    extensions,
    hours,
    timeEntries,
    eodNotes
  ]);
  opts.signal?.throwIfAborted();

  const generatedAt = now.toISOString();
  if (!u.ok || !s.ok || !d.ok) {
    // Without the roster nothing can be attributed to anyone.
    const unavailable = { ok: false, error: "unavailable" } as const;
    return {
      generatedAt,
      timezone: tz,
      windows,
      window: { key: window, fromIso: range.from.toISOString(), toIso: range.to.toISOString() },
      people: unavailable,
      departments: unavailable,
      unowned: unavailable
    };
  }
  const input: TeamInput = {
    users: u.value,
    schedules: s.value,
    departments: d.value,
    openTasks: o,
    completed: c,
    proofEvents: p,
    stageTransitions: st,
    stageApprovals: sa,
    extensions: x,
    hours: h,
    timeEntries: t,
    eodNotes: e
  };
  return { generatedAt, timezone: tz, ...buildTeamView(input, now, tz, window) };
}

const byName = (a: { name: string; userId: string }, b: { name: string; userId: string }) =>
  a.name.localeCompare(b.name) || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);

/**
 * Who is working right now (P5b's team_progress "working_now"): everyone
 * clocked in (a running segment) or holding in-progress work, with the
 * in-progress tasks soonest due first. Records only. Any failed read throws.
 */
export async function getWorkingNow(
  principal: ExecPrincipal,
  opts: { now?: Date; signal?: AbortSignal } = {}
): Promise<{ generatedAt: string; rows: WorkingNowRow[] }> {
  const now = opts.now ?? new Date();
  const signal = deadlineSignal(opts.signal);
  const from = new Date(now.getTime() - CLOCK_LOOKBACK_HOURS * HOUR_MS).toISOString();
  const [users, open, entries] = await Promise.all([
    untilAborted(listUsers(principal, { signal }), signal),
    untilAborted(listOpenTasks(principal, { signal }), signal),
    untilAborted(listTimeEntriesBetween(principal, from, now.toISOString(), { signal }), signal)
  ]);

  const running = new Map<string, { startedAt: string; taskId: string | null; ms: number }>();
  for (const e of entries) {
    if (e.endedAt !== null) continue;
    const ms = Date.parse(e.startedAt);
    if (!Number.isFinite(ms) || ms > now.getTime()) continue;
    const seen = running.get(e.userId);
    // The latest running segment is the one the person is on.
    if (!seen || ms > seen.ms) running.set(e.userId, { startedAt: e.startedAt, taskId: e.taskId, ms });
  }
  const inProgress = new Map<string, DdTask[]>();
  for (const t of open) {
    if (t.status !== "in_progress" || t.assigneeId === null) continue;
    const list = inProgress.get(t.assigneeId);
    if (list) list.push(t);
    else inProgress.set(t.assigneeId, [t]);
  }
  const dueMs = (t: DdTask) => (t.dueDate === null ? Number.POSITIVE_INFINITY : Date.parse(t.dueDate));

  const rows: WorkingNowRow[] = [];
  for (const u of users) {
    const clock = running.get(u.id);
    const tasks = inProgress.get(u.id) ?? [];
    if (!clock && tasks.length === 0) continue;
    rows.push({
      userId: u.id,
      name: u.name,
      primaryDepartmentId: u.departmentIds[0] ?? null,
      clockedInSince: clock?.startedAt ?? null,
      clockTaskId: clock?.taskId ?? null,
      inProgress: [...tasks]
        .sort((a, b) => dueMs(a) - dueMs(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((t) => ({ taskId: t.id, title: t.title, dueDate: t.dueDate, ref: ddTaskRef(t) }))
    });
  }
  return { generatedAt: now.toISOString(), rows: rows.sort(byName) };
}
