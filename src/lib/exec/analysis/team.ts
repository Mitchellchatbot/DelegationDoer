import { userCapacity } from "@/lib/capacity";
import {
  finishedLate,
  isAutoArchived,
  isIncident,
  isOpen,
  isOverdue,
  isOverdueWork,
  isStalledWork,
  proofHandedInAt,
  closedWithStage
} from "@/lib/exec/analysis/tasks";
import { ddPageRef, ddTaskRef } from "@/lib/exec/refs";
import type {
  DdActivity,
  DdDepartment,
  DdEodNote,
  DdStatusTransition,
  DdTask,
  DdTaskExtension,
  DdTaskHours,
  DdTimeEntry,
  DdUser,
  DdUserSchedule
} from "@/lib/exec/sources/dd-types";
import { startOfLocalDayUtc, tzOffsetMinutes, zonedParts } from "@/lib/exec/time";
import type {
  CapacityValue,
  Cell,
  CompletedValue,
  CountsValue,
  EodValue,
  MedianValue,
  RateValue,
  Section,
  TeamDepartmentRow,
  TeamPersonRow,
  TeamView,
  TeamWindow,
  TeamWindows,
  UnownedWork,
  WindowCompleted
} from "@/lib/exec/view-types";
import { addDaysToYmd, eodDayRange, eodToday } from "@/lib/shift";
import { isTeamTask } from "@/lib/task-team";
import type { Task, User } from "@/lib/types";
import { dayKeyInTz, hoursForDay, safeTimezone } from "@/lib/work-hours";

// Team analysis (P5a contract §3.9.2, A3, C15, C27, C30). Pure: no I/O, and
// `now` is passed in (capacityValue alone reads the clock, through DD's own
// capacity.ts). Workload and flow per person and per department, each figure
// with its sample size; no composite score, no ranking, no crown. A cell
// whose input couldn't be read is { ok: false }, never a zero.

export const MIN_RATE_SAMPLE = 5;

const HOUR_MS = 3_600_000;
const EOD_ZONE = "America/New_York";
/** Indicators cover the last 30 local days, today included (C15). */
const INDICATOR_DAYS = 30;
/** EOD: the 30 ET days ending yesterday (today's may not be due yet). */
const EOD_DAYS = 30;
const ORPHAN_SAMPLES = 5;

const toMs = (iso: string | null | undefined) => (typeof iso === "string" ? Date.parse(iso) : Number.NaN);
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function rateOf(x: number, n: number): RateValue {
  return { x, n, rate: n > 0 ? x / n : null, tooFew: n < MIN_RATE_SAMPLE };
}

export function medianOf(values: readonly number[]): MedianValue {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  const medianHours = n === 0 ? null : n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { n, medianHours, tooFew: n < MIN_RATE_SAMPLE };
}

/** isLeader (access.ts): a leader or a stealth admin. */
function isLeaderUser(u: Pick<DdUser, "role" | "isAdmin">): boolean {
  return u.role === "leader" || u.isAdmin === true;
}

/** `required || (!isLeader && enabled !== false)`; isLeader = role leader || isAdmin (DD's SOD/EOD ritual gate). */
export function isRitualExpected(
  u: Pick<DdUser, "role" | "isAdmin">,
  s: Pick<DdUserSchedule, "dailyPromptsEnabled" | "dailyPromptsRequired">
): boolean {
  return s.dailyPromptsRequired === true || (!isLeaderUser(u) && s.dailyPromptsEnabled !== false);
}

/** ISO weekday (1 Monday … 7 Sunday) of a calendar date, as pure date math. */
function weekdayOfYmd(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** 12:00 New York time on an ET calendar date (two passes, DST-safe). */
function noonEt(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d, 12, 0, 0);
  const pass1 = naive - tzOffsetMinutes(new Date(naive), EOD_ZONE) * 60_000;
  return new Date(naive - tzOffsetMinutes(new Date(pass1), EOD_ZONE) * 60_000);
}

/**
 * ET weekdays (Mon-Fri) in [fromYmd, toYmd] whose ET day ends after the
 * user's createdAt (eodDayRange), minus the explicit days off (C27,
 * a-correct-7): with a non-empty schedule.weeklySchedule, a date is dropped
 * when hoursForDay({ dayKey: dayKeyInTz(<12:00 ET of that date>,
 * safeTimezone(tz, "America/New_York")), dailyCapacity, weeklySchedule }) is
 * 0, as DD's own ritual skips an explicit day off. An empty schedule keeps
 * every weekday. Leave and holidays aren't recorded in DD, so they count.
 */
export function expectedEodDays(
  createdAt: string,
  fromYmd: string,
  toYmd: string,
  schedule: Pick<DdUserSchedule, "weeklySchedule" | "dailyCapacity">,
  tz: string | null
): string[] {
  const created = toMs(createdAt);
  const explicit = Object.keys(schedule.weeklySchedule ?? {}).length > 0;
  const zone = safeTimezone(tz, EOD_ZONE);
  const out: string[] = [];
  // Bounded: a window is at most a few months of days.
  for (let ymd = fromYmd, guard = 0; ymd <= toYmd && guard < 400; ymd = addDaysToYmd(ymd, 1), guard += 1) {
    if (weekdayOfYmd(ymd) > 5) continue;
    // Created after this ET day ended: not expected yet.
    if (Number.isFinite(created) && !(toMs(eodDayRange(ymd).endIso) > created)) continue;
    if (explicit) {
      const hours = hoursForDay({
        dayKey: dayKeyInTz(noonEt(ymd), zone),
        dailyCapacity: schedule.dailyCapacity,
        weeklySchedule: schedule.weeklySchedule
      });
      if (hours === 0) continue;
    }
    out.push(ymd);
  }
  return out;
}

/**
 * EOD submitted ÷ expected ET days (A3, C27): the numerator counts only
 * expected days; a submission on another day (a weekend, a scheduled day
 * off) is footnoted as otherDaysSubmitted.
 */
export function eodValue(u: DdUser, s: DdUserSchedule, notes: readonly DdEodNote[], fromYmd: string, toYmd: string): EodValue {
  if (!isRitualExpected(u, s)) return { kind: "not_expected" };
  const expected = new Set(expectedEodDays(s.createdAt, fromYmd, toYmd, s, u.workTimezone));
  const submitted = new Set(
    notes
      .filter((n) => n.userId === u.id && n.submittedAt !== null && n.noteDate >= fromYmd && n.noteDate <= toYmd)
      .map((n) => n.noteDate)
  );
  let onExpected = 0;
  let other = 0;
  for (const day of submitted) {
    if (expected.has(day)) onExpected += 1;
    else other += 1;
  }
  return { kind: "rate", otherDaysSubmitted: other, ...rateOf(onExpected, expected.size) };
}

/** Counted in the indicators: done, not a stage task, not an incident. */
function indicatorTask(t: DdTask): boolean {
  return t.status === "done" && t.completedAt != null && t.stageId == null && !isIncident(t);
}

/**
 * On-time rate, proof-aware (finishedLate judged at the hand-in, so a proof
 * handed in before its due date and approved after it is on time). Stage
 * tasks, incidents and tasks without a due date are left out. proofEvents
 * must come from a read starting at the earliest createdAt of `completed`
 * (C15, a-correct-12).
 */
export function onTimeValue(completed: readonly DdTask[], proofEvents: ReadonlyMap<string, readonly DdActivity[]>): RateValue {
  let onTime = 0;
  let late = 0;
  for (const t of completed) {
    if (!indicatorTask(t) || t.dueDate == null) continue;
    if (finishedLate(t, proofHandedInAt(t.completedAt, proofEvents.get(t.id) ?? []))) late += 1;
    else onTime += 1;
  }
  return rateOf(onTime, onTime + late);
}

/**
 * Median hours from created_at to the proof hand-in when there is one, else
 * completed_at. Stage tasks, incidents and negative spans are left out. An
 * approved intake draft keeps its draft's created_at, so its cycle includes
 * the approval wait (documented, a-correct-12).
 */
export function cycleValue(completed: readonly DdTask[], proofEvents: ReadonlyMap<string, readonly DdActivity[]>): MedianValue {
  const hours: number[] = [];
  for (const t of completed) {
    if (!indicatorTask(t)) continue;
    const end = proofHandedInAt(t.completedAt, proofEvents.get(t.id) ?? []) ?? t.completedAt;
    const span = (toMs(end) - toMs(t.createdAt)) / HOUR_MS;
    if (Number.isFinite(span) && span >= 0) hours.push(span);
  }
  return medianOf(hours);
}

/**
 * C15 (a-correct-13). Of the tasks given (the caller's population: a
 * person's open tasks and completions in the window, by current assignee)
 * with a due date, not incidents, minus each task whose extension rows all
 * have previousDueDate null (its only deadline was set through "Extend"),
 * the share with at least one extension row that replaced a real deadline.
 */
export function extensionValue(tasks: readonly DdTask[], extensionsByTask: ReadonlyMap<string, readonly DdTaskExtension[]>): RateValue {
  let extended = 0;
  let n = 0;
  const seen = new Set<string>();
  for (const t of tasks) {
    if (seen.has(t.id) || t.dueDate == null || isIncident(t)) continue;
    seen.add(t.id);
    const rows = extensionsByTask.get(t.id) ?? [];
    const real = rows.filter((r) => r.previousDueDate !== null).length;
    if (rows.length > 0 && real === 0) continue;
    n += 1;
    if (real > 0) extended += 1;
  }
  return rateOf(extended, n);
}

/** Local midnight `days` local days before the local day holding `from` (DST-safe: stepped by calendar day). */
function localDaysBack(from: Date, days: number, tz: string): Date {
  let day = startOfLocalDayUtc(from, tz);
  for (let back = 0; back < days; back += 1) day = startOfLocalDayUtc(new Date(day.getTime() - 1), tz);
  return day;
}

/** Monday 00:00 local (his zone) of the week holding `now`, and the Monday before, stepped by local days. */
export function weekWindows(now: Date, tz: string): { thisWeekStart: Date; lastWeekStart: Date } {
  const thisWeekStart = localDaysBack(now, zonedParts(now, tz).weekday - 1, tz);
  return { thisWeekStart, lastWeekStart: localDaysBack(thisWeekStart, 7, tz) };
}

/**
 * The [from, to) instants of a TeamWindow in his zone (coherence-10):
 * this_week and last_week as weekWindows; last_7_days = the 7 local days
 * ending today (from 00:00 six days ago); last_30_days = indicatorsFrom (the
 * 30 local days ending today). Every window but last_week ends at `now`.
 */
export function teamWindowRange(window: TeamWindow, now: Date, tz: string): { from: Date; to: Date } {
  switch (window) {
    case "this_week":
      return { from: weekWindows(now, tz).thisWeekStart, to: now };
    case "last_week": {
      const w = weekWindows(now, tz);
      return { from: w.lastWeekStart, to: w.thisWeekStart };
    }
    case "last_7_days":
      return { from: localDaysBack(now, 6, tz), to: now };
    case "last_30_days":
      return { from: localDaysBack(now, INDICATOR_DAYS - 1, tz), to: now };
    default:
      throw new TypeError("analysis/team: unknown window");
  }
}

interface Span {
  start: number;
  end: number;
}

/**
 * Each person's clocked ms in [fromMsFor(userId), toMs], overlapping
 * segments merged (a double clock-in is still one person's hour). A running
 * segment (no end) counts up to toMs and marks the person running.
 */
export function clockedMsByUser(
  entries: readonly DdTimeEntry[],
  fromMsFor: (userId: string) => number,
  toMs: number
): Map<string, { ms: number; running: boolean }> {
  const spans = new Map<string, Span[]>();
  const running = new Set<string>();
  for (const e of entries) {
    if (e.endedAt === null) running.add(e.userId);
    const start = Math.max(Date.parse(e.startedAt), fromMsFor(e.userId));
    const end = Math.min(e.endedAt === null ? toMs : Date.parse(e.endedAt), toMs);
    // NaN from an unreadable timestamp fails this test too.
    if (!(end > start)) continue;
    const list = spans.get(e.userId);
    if (list) list.push({ start, end });
    else spans.set(e.userId, [{ start, end }]);
  }
  const out = new Map<string, { ms: number; running: boolean }>();
  for (const userId of running) out.set(userId, { ms: 0, running: true });
  for (const [userId, list] of spans) {
    list.sort((a, b) => a.start - b.start);
    let total = 0;
    let current = list[0];
    for (const span of list.slice(1)) {
      if (span.start <= current.end) current = { start: current.start, end: Math.max(current.end, span.end) };
      else {
        total += current.end - current.start;
        current = span;
      }
    }
    total += current.end - current.start;
    out.set(userId, { ms: total, running: running.has(userId) });
  }
  return out;
}

/**
 * DD's User as capacity.ts reads it, without anything exec doesn't hold:
 * skills and throughput empty, the zone as DD has it (capacity.ts reads a
 * null zone as UTC, C15).
 */
export function toCapacityUser(u: DdUser, s: DdUserSchedule): User {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    departmentIds: [...u.departmentIds],
    skills: [],
    dailyCapacity: s.dailyCapacity,
    throughput: {},
    isAdmin: u.isAdmin,
    workTimezone: u.workTimezone,
    weeklySchedule: s.weeklySchedule,
    workHoursStart: s.workHoursStart,
    workHoursEnd: s.workHoursEnd,
    dailyPromptsEnabled: s.dailyPromptsEnabled,
    dailyPromptsRequired: s.dailyPromptsRequired,
    clockEnabled: s.clockEnabled
  };
}

/**
 * DD's Task as capacity.ts reads it. The description is never the real text
 * (exec never reads it); actual hours prefer the override, as DD's mapper
 * does (server-data.ts). A task with no hours row falls back to its own
 * estimate and no actuals.
 */
export function toCapacityTask(t: DdTask, h: DdTaskHours | undefined): Task {
  return {
    id: t.id,
    title: t.title,
    description: "",
    status: t.status,
    priority: t.priority,
    estimatedHours: h?.estimatedHours ?? t.estimatedHours,
    actualHours: h ? (h.actualHoursOverride ?? h.actualHours) : 0,
    actualHoursOverride: h?.actualHoursOverride ?? null,
    tags: [...t.tags],
    departmentId: t.departmentId,
    assigneeId: t.assigneeId,
    creatorId: t.creatorId,
    projectId: t.projectId,
    dueDate: t.dueDate,
    inactiveFlag: false,
    lastActivityAt: t.lastActivityAt,
    createdAt: t.createdAt,
    blocksTaskIds: [],
    clientName: t.clientName,
    deletedAt: t.deletedAt,
    completedAt: t.completedAt,
    archivedAt: t.archivedAt,
    archivedBy: t.archivedBy
  };
}

/**
 * userCapacity (capacity.ts) through the text-free adapters: the person's
 * open, assigned work, auto-archived tasks left out (DD's own capacity bars
 * read getAllTasks(), which drops archived rows; their count is kept). "Off
 * today" when today's scheduled hours (in the person's zone, null → UTC, as
 * capacity.ts) are 0: capacity.ts floors the day at 1 hour, which would read
 * a weekend as 100% booked. todayHours is today's scheduled hours. capacity.ts
 * reads the clock itself.
 */
export function capacityValue(
  user: DdUser,
  schedule: DdUserSchedule,
  openTasks: readonly DdTask[],
  hours: ReadonlyMap<string, DdTaskHours>,
  hoursOnShiftToday: number
): CapacityValue {
  const mine = openTasks.filter((t) => t.assigneeId === user.id && isOpen(t));
  const live = mine.filter((t) => t.archivedAt == null);
  const tasks = live.map((t) => toCapacityTask(t, hours.get(t.id)));
  const todayHours = hoursForDay({
    dayKey: dayKeyInTz(new Date(), user.workTimezone ?? null),
    dailyCapacity: schedule.dailyCapacity,
    weeklySchedule: schedule.weeklySchedule
  });
  if (todayHours === 0) {
    const remaining = tasks
      .filter((t) => t.status !== "done" && t.status !== "waiting_on_client")
      .reduce((sum, t) => sum + Math.max(0, t.estimatedHours - t.actualHours), 0);
    return { kind: "off_today", remainingHours: remaining };
  }
  const info = userCapacity(toCapacityUser(user, schedule), tasks, hoursOnShiftToday);
  return {
    kind: "load",
    usedHours: info.usedHours,
    backlogHours: info.backlogHours,
    pct: info.pct,
    todayHours,
    overSoft: info.overSoft,
    overBuffer: info.overBuffer,
    autoArchivedExcluded: mine.filter(isAutoArchived).length
  };
}

export interface TeamInput {
  users: DdUser[];
  schedules: DdUserSchedule[];
  departments: DdDepartment[];
  openTasks: Cell<DdTask[]>;
  completed: Cell<DdTask[]>;
  proofEvents: Cell<Map<string, DdActivity[]>>;
  /** C30 inputs for the completed stage tasks: their status transitions (since their created_at) and proof_approved rows.
   *  A failed read blanks the completed cells (a completion can't be attributed without it). */
  stageTransitions: Cell<DdStatusTransition[]>;
  stageApprovals: Cell<DdActivity[]>;
  extensions: Cell<Map<string, DdTaskExtension[]>>;
  hours: Cell<Map<string, DdTaskHours>>;
  timeEntries: Cell<DdTimeEntry[]>;
  eodNotes: Cell<DdEodNote[]>;
}

/** The fixed windows of the Team tab (C15). */
export function teamWindows(now: Date, tz: string): TeamWindows {
  const { thisWeekStart, lastWeekStart } = weekWindows(now, tz);
  const eodToYmd = addDaysToYmd(eodToday(now), -1);
  return {
    thisWeekStart: thisWeekStart.toISOString(),
    lastWeekStart: lastWeekStart.toISOString(),
    indicatorsFrom: localDaysBack(now, INDICATOR_DAYS - 1, tz).toISOString(),
    eodFromYmd: addDaysToYmd(eodToYmd, -(EOD_DAYS - 1)),
    eodToYmd
  };
}

const NO_CELL = { ok: false } as const;
const cell = <T>(value: T): Cell<T> => ({ ok: true, value });

function emptyCounts(): CountsValue {
  return {
    open: 0,
    inProgress: 0,
    overdue: 0,
    overdueAutoArchived: 0,
    stalled: 0,
    waitingOnClient: 0,
    pendingApproval: 0,
    pendingApprovalPastDue: 0
  };
}

/** C15 counts over open tasks (the caller's population). */
function countsOf(tasks: readonly DdTask[], now: Date): CountsValue {
  const c = emptyCounts();
  for (const t of tasks) {
    if (!isOpen(t)) continue;
    c.open += 1;
    if (t.status === "in_progress") c.inProgress += 1;
    if (isOverdueWork(t, now)) {
      c.overdue += 1;
      if (isAutoArchived(t)) c.overdueAutoArchived += 1;
    }
    if (isStalledWork(t, now)) c.stalled += 1;
    if (t.status === "waiting_on_client") c.waitingOnClient += 1;
    if (t.status === "pending_approval") {
      c.pendingApproval += 1;
      if (isOverdue(t, now) && !isIncident(t)) c.pendingApprovalPastDue += 1;
    }
  }
  return c;
}

function addCounts(a: CountsValue, b: CountsValue): CountsValue {
  const out = { ...a };
  for (const key of Object.keys(out) as (keyof CountsValue)[]) out[key] += b[key];
  return out;
}

/** Completions in [from, to) not closed with their stage, newest first; and how many were. */
function windowCompleted(tasks: readonly DdTask[], closed: ReadonlySet<string>, from: number, to: number): WindowCompleted {
  const inWindow = tasks.filter((t) => {
    const at = toMs(t.completedAt);
    return at >= from && at < to;
  });
  const counted = inWindow
    .filter((t) => !closed.has(t.id))
    .sort((a, b) => toMs(b.completedAt) - toMs(a.completedAt) || byId(a.id, b.id));
  return { count: counted.length, closedWithStage: inWindow.length - counted.length, taskIds: counted.map((t) => t.id) };
}

interface PersonParts {
  user: DdUser;
  schedule: DdUserSchedule | undefined;
  open: DdTask[];
  /** Completed in [earliest window, now), done, by current assignee. */
  completed: DdTask[];
  row: TeamPersonRow;
}

/** The person's zone for "today" on the clock, as capacity.ts reads it: the stated zone, else UTC. */
function clockZone(u: DdUser): string {
  return safeTimezone(u.workTimezone, "UTC");
}

/**
 * The Team tab's model (A3, C15, C27, C30), from records only. Listed
 * people: users with a department membership, open assigned work, or a
 * completion in the indicator window; sorted by name. Department rows
 * attribute every person's numbers (completedInWindow included) to the
 * person's primary department only, so nothing is counted twice; people
 * without one go to a "No department" row. `window` (default this_week) sets
 * every completedInWindow. Each failed input blanks only the cells built
 * from it.
 */
export function buildTeamView(input: TeamInput, now: Date, tz: string, window: TeamWindow = "this_week"): Omit<TeamView, "generatedAt" | "timezone"> {
  const windows = teamWindows(now, tz);
  const range = teamWindowRange(window, now, tz);
  const nowMs = now.getTime();
  const thisWeek = toMs(windows.thisWeekStart);
  const lastWeek = toMs(windows.lastWeekStart);
  const indicatorsFrom = toMs(windows.indicatorsFrom);
  const rangeFrom = range.from.getTime();
  // Every window but last_week runs to now, inclusive (the completions read ends at now).
  const windowEnd = window === "last_week" ? range.to.getTime() : nowMs + 1;

  const open = input.openTasks.ok ? input.openTasks.value.filter(isOpen) : null;
  const done = input.completed.ok ? input.completed.value.filter((t) => t.status === "done" && Number.isFinite(toMs(t.completedAt))) : null;
  // C30: a completion can't be attributed without knowing whether its stage closed it.
  const closed =
    done !== null && input.stageTransitions.ok && input.stageApprovals.ok
      ? closedWithStage(
          done.filter((t) => t.stageId != null),
          input.stageTransitions.value,
          input.stageApprovals.value
        )
      : null;
  const schedules = new Map(input.schedules.map((s) => [s.userId, s]));
  const clocked =
    input.timeEntries.ok
      ? clockedMsByUser(
          input.timeEntries.value,
          (userId) => {
            const u = input.users.find((x) => x.id === userId);
            return startOfLocalDayUtc(now, u ? clockZone(u) : "UTC").getTime();
          },
          nowMs
        )
      : null;

  const openBy = new Map<string, DdTask[]>();
  for (const t of open ?? []) {
    if (t.assigneeId === null) continue;
    const list = openBy.get(t.assigneeId);
    if (list) list.push(t);
    else openBy.set(t.assigneeId, [t]);
  }
  const doneBy = new Map<string, DdTask[]>();
  for (const t of done ?? []) {
    if (t.assigneeId === null) continue;
    const list = doneBy.get(t.assigneeId);
    if (list) list.push(t);
    else doneBy.set(t.assigneeId, [t]);
  }

  const inIndicators = (t: DdTask) => {
    const at = toMs(t.completedAt);
    return at >= indicatorsFrom && at < nowMs + 1;
  };

  const listed = input.users.filter(
    (u) => u.departmentIds.length > 0 || (openBy.get(u.id)?.length ?? 0) > 0 || (doneBy.get(u.id) ?? []).some(inIndicators)
  );

  const people: PersonParts[] = listed.map((u) => {
    const schedule = schedules.get(u.id);
    const mineOpen = openBy.get(u.id) ?? [];
    const mineDone = doneBy.get(u.id) ?? [];
    const indicatorDone = mineDone.filter(inIndicators);

    const counts: Cell<CountsValue> = open === null ? NO_CELL : cell(countsOf(mineOpen, now));
    let completed: Cell<CompletedValue> = NO_CELL;
    let completedInWindow: Cell<WindowCompleted> = NO_CELL;
    if (closed !== null) {
      const tw = windowCompleted(mineDone, closed, thisWeek, nowMs + 1);
      const lw = windowCompleted(mineDone, closed, lastWeek, thisWeek);
      completed = cell({ thisWeek: tw.count, lastWeek: lw.count, closedWithStage: { thisWeek: tw.closedWithStage, lastWeek: lw.closedWithStage } });
      completedInWindow = cell(windowCompleted(mineDone, closed, rangeFrom, windowEnd));
    }

    let capacity: Cell<CapacityValue> = NO_CELL;
    if (open !== null && input.hours.ok && schedule) {
      const onShiftMs = clocked?.get(u.id)?.ms ?? 0;
      capacity = cell(capacityValue(u, schedule, mineOpen, input.hours.value, onShiftMs / HOUR_MS));
    }
    const eod: Cell<EodValue> =
      input.eodNotes.ok && schedule ? cell(eodValue(u, schedule, input.eodNotes.value, windows.eodFromYmd, windows.eodToYmd)) : NO_CELL;
    const onTime: Cell<RateValue> = done !== null && input.proofEvents.ok ? cell(onTimeValue(indicatorDone, input.proofEvents.value)) : NO_CELL;
    const cycle: Cell<MedianValue> = done !== null && input.proofEvents.ok ? cell(cycleValue(indicatorDone, input.proofEvents.value)) : NO_CELL;
    const extensions: Cell<RateValue> =
      open !== null && done !== null && input.extensions.ok ? cell(extensionValue([...mineOpen, ...indicatorDone], input.extensions.value)) : NO_CELL;

    return {
      user: u,
      schedule,
      open: mineOpen,
      completed: mineDone,
      row: {
        userId: u.id,
        name: u.name,
        role: u.role,
        isLeader: isLeaderUser(u),
        primaryDepartmentId: u.departmentIds[0] ?? null,
        departmentIds: [...u.departmentIds],
        counts,
        completed,
        completedInWindow,
        capacity,
        eod,
        onTime,
        cycle,
        extensions,
        ref: ddPageRef(`/team/${u.id}`, u.name)
      }
    };
  });
  people.sort((a, b) => a.user.name.localeCompare(b.user.name) || byId(a.user.id, b.user.id));

  // Departments: every department, plus "No department" when someone has none.
  const groups = new Map<string | null, PersonParts[]>();
  for (const d of input.departments) groups.set(d.id, []);
  for (const p of people) {
    const key = p.row.primaryDepartmentId;
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  const departmentById = new Map(input.departments.map((d) => [d.id, d]));
  const departments: TeamDepartmentRow[] = [];
  for (const [departmentId, members] of groups) {
    const dept = departmentId === null ? undefined : departmentById.get(departmentId);
    const name = departmentId === null ? "No department" : (dept?.name ?? "Unknown department");
    const all = <T>(get: (p: PersonParts) => Cell<T>): T[] | null => {
      const out: T[] = [];
      for (const m of members) {
        const c = get(m);
        if (!c.ok) return null;
        out.push(c.value);
      }
      return out;
    };
    const memberCounts = open === null ? null : all((m) => m.row.counts);
    const memberCompleted = all((m) => m.row.completed);
    const memberWindow = all((m) => m.row.completedInWindow);
    const memberCapacity = all((m) => m.row.capacity);
    const memberEod = all((m) => m.row.eod);
    const indicatorDone = members.flatMap((m) => m.completed.filter(inIndicators));

    const pool = departmentId === null ? null : poolOf(open, departmentId, now);
    departments.push({
      departmentId,
      name,
      headUserId: dept?.headUserId ?? null,
      people: members.length,
      counts: memberCounts === null ? NO_CELL : cell(memberCounts.reduce(addCounts, emptyCounts())),
      completed:
        memberCompleted === null
          ? NO_CELL
          : cell(
              memberCompleted.reduce<CompletedValue>(
                (sum, c) => ({
                  thisWeek: sum.thisWeek + c.thisWeek,
                  lastWeek: sum.lastWeek + c.lastWeek,
                  closedWithStage: {
                    thisWeek: sum.closedWithStage.thisWeek + c.closedWithStage.thisWeek,
                    lastWeek: sum.closedWithStage.lastWeek + c.closedWithStage.lastWeek
                  }
                }),
                { thisWeek: 0, lastWeek: 0, closedWithStage: { thisWeek: 0, lastWeek: 0 } }
              )
            ),
      completedInWindow: memberWindow === null ? NO_CELL : cell(sumWindows(memberWindow, done ?? [])),
      capacity:
        memberCapacity === null
          ? NO_CELL
          : cell(
              memberCapacity.reduce(
                (sum, c) =>
                  c.kind === "off_today"
                    ? { ...sum, offToday: sum.offToday + 1 }
                    : {
                        usedHours: sum.usedHours + c.usedHours,
                        backlogHours: sum.backlogHours + c.backlogHours,
                        todayHours: sum.todayHours + c.todayHours,
                        offToday: sum.offToday
                      },
                { usedHours: 0, backlogHours: 0, todayHours: 0, offToday: 0 }
              )
            ),
      eod:
        memberEod === null
          ? NO_CELL
          : cell(
              (() => {
                let x = 0;
                let n = 0;
                for (const e of memberEod) {
                  if (e.kind !== "rate") continue;
                  x += e.x;
                  n += e.n;
                }
                return rateOf(x, n);
              })()
            ),
      onTime: done !== null && input.proofEvents.ok ? cell(onTimeValue(indicatorDone, input.proofEvents.value)) : NO_CELL,
      cycle: done !== null && input.proofEvents.ok ? cell(cycleValue(indicatorDone, input.proofEvents.value)) : NO_CELL,
      extensions:
        open !== null && done !== null && input.extensions.ok
          ? cell(extensionValue([...members.flatMap((m) => m.open), ...indicatorDone], input.extensions.value))
          : NO_CELL,
      pool
    });
  }
  departments.sort((a, b) => {
    // "No department" last; otherwise by name.
    if ((a.departmentId === null) !== (b.departmentId === null)) return a.departmentId === null ? 1 : -1;
    return a.name.localeCompare(b.name) || byId(a.departmentId ?? "", b.departmentId ?? "");
  });

  const unowned: Section<UnownedWork> = open === null ? { ok: false, error: "unavailable" } : { ok: true, data: unownedOf(open) };

  return {
    windows,
    window: { key: window, fromIso: range.from.toISOString(), toIso: range.to.toISOString() },
    people: { ok: true, data: people.map((p) => p.row) },
    departments: { ok: true, data: departments },
    unowned
  };
}

/** The members' window completions summed; task ids newest first by completed_at. */
function sumWindows(parts: readonly WindowCompleted[], done: readonly DdTask[]): WindowCompleted {
  const completedAt = new Map(done.map((t) => [t.id, toMs(t.completedAt)]));
  const taskIds = parts
    .flatMap((p) => p.taskIds)
    .sort((a, b) => (completedAt.get(b) ?? 0) - (completedAt.get(a) ?? 0) || byId(a, b));
  return {
    count: parts.reduce((n, p) => n + p.count, 0),
    closedWithStage: parts.reduce((n, p) => n + p.closedWithStage, 0),
    taskIds
  };
}

/** A department's unclaimed pool (workloadByPerson's team:<id>): open, unassigned, queued to it. null when empty. */
function poolOf(open: readonly DdTask[] | null, departmentId: string, now: Date): Cell<CountsValue> | null {
  if (open === null) return NO_CELL;
  const pool = open.filter((t) => t.assigneeId === null && isTeamTask(t) && t.departmentId === departmentId);
  return pool.length === 0 ? null : cell(countsOf(pool, now));
}

/**
 * Open work nobody holds: stage placeholders the project flow hasn't
 * dispatched yet, and orphans (unassigned, not queued to a team, outside a
 * stage: often an off-boarded person's leftovers). Samples: the newest few.
 */
function unownedOf(open: readonly DdTask[]): UnownedWork {
  const unassigned = open.filter((t) => t.assigneeId === null && !isTeamTask(t));
  const orphans = unassigned
    .filter((t) => t.stageId == null)
    .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt) || byId(a.id, b.id));
  return {
    undispatchedPlaceholders: unassigned.length - orphans.length,
    orphans: orphans.length,
    orphanSamples: orphans.slice(0, ORPHAN_SAMPLES).map((t) => ({ taskId: t.id, title: t.title, ref: ddTaskRef(t) }))
  };
}
