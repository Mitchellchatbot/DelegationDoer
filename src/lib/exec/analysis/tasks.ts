import { localDateString } from "@/lib/exec/time";
import type { DdActivity, DdTask, TaskPriority } from "@/lib/exec/sources/dd-types";
import { addDaysToYmd } from "@/lib/shift";
import { isTeamTask } from "@/lib/task-team";

// Task predicates and aggregates for every exec surface (plan §2,
// analysis/tasks.ts). Pure: no I/O, and `now` is always passed in.
//
// DD has no shared "real task" predicate. Each home-data helper filters
// drafts, deletions, archives and rejections its own way (p2b-helpers §0.1),
// so exec analysis uses only the predicates below and never home-data counts.
// Two numbers on the page can't then disagree about what "open" means.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const PRIORITY_RANK: Record<TaskPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

type OpenFields = Pick<DdTask, "isDraft" | "deletedAt" | "status" | "archivedAt" | "archivedBy">;

/** Epoch ms, or NaN for a missing or unreadable timestamp (every comparison with NaN is false). */
function toMs(iso: string | null | undefined): number {
  return typeof iso === "string" ? Date.parse(iso) : Number.NaN;
}

/**
 * Not a draft, not deleted, not done or rejected, and either live or
 * auto-archived (the sweep shelves overdue work nobody finished; a task a
 * person archived is parked). The in-memory twin of whereOpenTask in
 * sources/dd.ts; change them together.
 */
export function isOpen(t: OpenFields): boolean {
  return (
    !t.isDraft &&
    t.deletedAt == null &&
    t.status !== "done" &&
    t.status !== "rejected" &&
    (t.archivedAt == null || t.archivedBy == null)
  );
}

export function isOverdue(t: OpenFields & Pick<DdTask, "dueDate">, now: Date): boolean {
  return isOpen(t) && t.dueDate != null && toMs(t.dueDate) < now.getTime();
}

/** Whole days past due, floored; 0 when it isn't past due or has no due date. */
export function overdueDays(t: Pick<DdTask, "dueDate">, now: Date): number {
  const due = toMs(t.dueDate);
  if (!Number.isFinite(due)) return 0;
  return Math.max(0, Math.floor((now.getTime() - due) / DAY_MS));
}

/**
 * Open, not archived, and untouched for more than `days` days. Archived rows
 * are left out because the auto-archive sweep stamps last_activity_at when it
 * runs, so their idle time can't be read.
 */
export function isStalled(t: OpenFields & Pick<DdTask, "lastActivityAt">, now: Date, days = 7): boolean {
  return isOpen(t) && t.archivedAt == null && toMs(t.lastActivityAt) < now.getTime() - days * DAY_MS;
}

/** Archived by the sweep (archived_by NULL), not shelved by a person. */
export function isAutoArchived(t: Pick<DdTask, "archivedAt" | "archivedBy">): boolean {
  return t.archivedAt != null && t.archivedBy == null;
}

const INCIDENT_TAG = "incident";

/**
 * An incident's own task (src/app/api/incidents/route.ts tags it "incident").
 * The route sets its due_date to the moment the incident was reported, so the
 * date is a timestamp, not a deadline: the task reads as overdue from birth
 * and as late whenever it's closed. Overdue and late-work counts leave these
 * out, and open incidents are their own signal.
 */
export function isIncident(t: Pick<DdTask, "tags">): boolean {
  return t.tags.includes(INCIDENT_TAG);
}

/**
 * Finished after its due date. Incident tasks are created with due_date = now,
 * so every completed incident counts as late (see isIncident). A task that
 * went through a proof review was marked done when the reviewer approved it;
 * finishedLate judges it by when the work was handed in.
 */
export function completedLate(t: Pick<DdTask, "status" | "completedAt" | "dueDate">): boolean {
  return t.status === "done" && t.completedAt != null && t.dueDate != null && toMs(t.completedAt) > toMs(t.dueDate);
}

/**
 * The activity_logs actions of a Facebook proof review: the hand-in
 * (submit-proof) and a send-back (reviewFbProof in src/lib/fb-proof.ts).
 */
export const PROOF_ACTIONS: readonly string[] = Object.freeze(["submitted_for_approval", "proof_sent_back"]);

/**
 * When the work on a completed task was handed in for a proof review, or
 * null when its completion is its finish. An approval stamps completed_at
 * with the reviewer's click, however long the proof waited, so the review's
 * time isn't the assignee's. `events` are the task's activity rows (action and
 * time only); the latest proof action at or before completedAt decides: a
 * submission means the work was handed in then and the completion approved
 * it; a send-back means it was finished later, some other way (marked done
 * from the board).
 */
export function proofHandedInAt(completedAt: string | null, events: readonly Pick<DdActivity, "action" | "createdAt">[]): string | null {
  const done = toMs(completedAt);
  let latest: { at: number; action: string; iso: string } | null = null;
  for (const e of events) {
    const at = toMs(e.createdAt);
    // NaN (an unreadable time, or no completion) never passes.
    if (!(at <= done) || !PROOF_ACTIONS.includes(e.action)) continue;
    // A send-back always follows its submission; on an exact tie, it wins.
    if (latest === null || at > latest.at || (at === latest.at && e.action === "proof_sent_back")) latest = { at, action: e.action, iso: e.createdAt };
  }
  return latest?.action === "submitted_for_approval" ? latest.iso : null;
}

/**
 * completedLate, judged by when the work was handed in (proofHandedInAt) for
 * a task that went through a proof review: approved after its due date but
 * handed in before it, it wasn't late.
 */
export function finishedLate(t: Pick<DdTask, "status" | "completedAt" | "dueDate">, handedInAt: string | null): boolean {
  return completedLate(t) && (handedInAt === null || toMs(handedInAt) > toMs(t.dueDate));
}

export interface PersonWorkload {
  /** A users.id, or "team:<departmentId>" for a department's unclaimed pool. */
  userId: string;
  open: number;
  overdue: number;
  dueNext7Days: number;
  stalled: number;
  waitingOnClient: number;
  pendingApproval: number;
}

function emptyWorkload(userId: string): PersonWorkload {
  return { userId, open: 0, overdue: 0, dueNext7Days: 0, stalled: 0, waitingOnClient: 0, pendingApproval: 0 };
}

/**
 * Open work per assignee. Unassigned work queued to a department (the
 * auto-team tag) goes under "team:<departmentId>". Any other unassigned task
 * belongs to nobody yet (a project-stage placeholder waiting for dispatch, an
 * off-boarded user's leftovers) and is left out. An open incident is open
 * work but never overdue work (see isIncident), as on the Overview's tile.
 */
export function workloadByPerson(tasks: readonly DdTask[], now: Date): Map<string, PersonWorkload> {
  const out = new Map<string, PersonWorkload>();
  const nowMs = now.getTime();
  const weekEnd = nowMs + 7 * DAY_MS;
  for (const t of tasks) {
    if (!isOpen(t)) continue;
    const key = t.assigneeId ?? (isTeamTask(t) ? `team:${t.departmentId}` : null);
    if (key === null) continue;
    let w = out.get(key);
    if (!w) {
      w = emptyWorkload(key);
      out.set(key, w);
    }
    w.open += 1;
    if (isOverdue(t, now) && !isIncident(t)) w.overdue += 1;
    const due = toMs(t.dueDate);
    if (due >= nowMs && due < weekEnd) w.dueNext7Days += 1;
    if (isStalled(t, now)) w.stalled += 1;
    if (t.status === "waiting_on_client") w.waitingOnClient += 1;
    if (t.status === "pending_approval") w.pendingApproval += 1;
  }
  return out;
}

export interface CompletionStats {
  completed: number;
  onTime: number;
  late: number;
  noDueDate: number;
  /**
   * Incident tasks. Their due date is the moment the incident was reported
   * (see isIncident), so they are counted here and kept out of onTime, late
   * and noDueDate.
   */
  incidents: number;
  /** onTime / (onTime + late); null when none of them had a due date. */
  onTimeRate: number | null;
  /** Median hours from created_at to completed_at; null when there are none. */
  medianCycleHours: number | null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * On-time and cycle-time figures for completed tasks (anything not done with
 * a completion time is ignored). Incidents are counted on their own, outside
 * the on-time split; their cycle time (report to close) still counts. An
 * approved AI draft keeps its draft's created_at, so its cycle time includes
 * the wait for approval. A completion stamped before its creation can't be a
 * cycle time, so it is counted but kept out of the median.
 */
export function completionStats(completedTasks: readonly DdTask[]): CompletionStats {
  let completed = 0;
  let onTime = 0;
  let late = 0;
  let noDueDate = 0;
  let incidents = 0;
  const cycleHours: number[] = [];
  for (const t of completedTasks) {
    if (t.status !== "done" || t.completedAt == null) continue;
    completed += 1;
    if (isIncident(t)) incidents += 1;
    else if (t.dueDate == null) noDueDate += 1;
    else if (completedLate(t)) late += 1;
    else onTime += 1;
    const hours = (toMs(t.completedAt) - toMs(t.createdAt)) / HOUR_MS;
    if (Number.isFinite(hours) && hours >= 0) cycleHours.push(hours);
  }
  return {
    completed,
    onTime,
    late,
    noDueDate,
    incidents,
    onTimeRate: onTime + late > 0 ? onTime / (onTime + late) : null,
    medianCycleHours: median(cycleHours)
  };
}

/** Open tasks due in [now, now + days), soonest first; on the same instant, critical before high before medium before low. */
export function upcomingDeadlines(tasks: readonly DdTask[], now: Date, days = 7): DdTask[] {
  const start = now.getTime();
  const end = start + days * DAY_MS;
  return tasks
    .filter((t) => {
      if (!isOpen(t)) return false;
      const due = toMs(t.dueDate);
      return due >= start && due < end;
    })
    .sort(
      (a, b) =>
        toMs(a.dueDate) - toMs(b.dueDate) ||
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
}

export interface DailyCount {
  /** Local calendar date in the zone asked for, "YYYY-MM-DD". */
  date: string;
  count: number;
}

/**
 * How many of `isoTimestamps` fall on each of the last `days` local days in
 * `tz` (today included), oldest first, with empty days as 0. Each timestamp is
 * bucketed by its own local date and the days are walked as calendar dates,
 * so a 23- or 25-hour DST day is still exactly one day. Timestamps outside the
 * window, or unreadable, are ignored.
 */
export function dailyCounts(isoTimestamps: readonly (string | null | undefined)[], tz: string, days: number, now: Date): DailyCount[] {
  const n = Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 0;
  if (n === 0) return [];
  const today = localDateString(now, tz);
  const counts = new Map<string, number>();
  for (let back = n - 1; back >= 0; back -= 1) counts.set(addDaysToYmd(today, -back), 0);
  for (const iso of isoTimestamps) {
    const at = toMs(iso);
    if (!Number.isFinite(at)) continue;
    const date = localDateString(new Date(at), tz);
    const count = counts.get(date);
    if (count !== undefined) counts.set(date, count + 1);
  }
  return [...counts].map(([date, count]) => ({ date, count }));
}
