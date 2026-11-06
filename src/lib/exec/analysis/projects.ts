import { isOpen, isOverdue, isStalledWork } from "@/lib/exec/analysis/tasks";
import type { DdProject, DdProjectStage, DdTask } from "@/lib/exec/sources/dd-types";
import { isTeamTask } from "@/lib/task-team";

// Derived project health (plan §2 analysis/projects.ts). Pure.
//
// A DD project has no status, owner or due date (p2b-schema §2.10), so its
// health is worked out from its tasks and stages by the fixed rules below, and
// every rule that fired is listed as a reason. It is a derived signal, shown
// labelled as one, never a stored fact. DD has no dependency model either, so
// nothing here claims a task is blocked; "waiting on client" and a stuck stage
// are the signals there are.

export type ProjectHealthStatus = "on_track" | "at_risk" | "off_track" | "no_data";

export interface ProjectHealth {
  projectId: string;
  name: string;
  status: ProjectHealthStatus;
  /** Every rule that fired, most severe first. Empty when on track. */
  reasons: string[];
  stageProgress: { done: number; total: number };
  /** Every open task, the undispatched ones included. */
  openTasks: number;
  /**
   * Open stage placeholders the project flow hasn't handed out yet (see
   * isUndispatched). They are part of openTasks but not work in flight, so
   * the share rules leave them out.
   */
  undispatchedTasks: number;
  overdueTasks: number;
  /**
   * Active tasks idle for 7+ days by the feed's own rule (isStalledWork in
   * analysis/tasks.ts): not counting overdue work, incidents, or tasks waiting
   * on the client or on a proof review, which each have their own signal.
   */
  stalledTasks: number;
  waitingOnClient: number;
  /** Latest known activity on the project's tasks and stages; null when none is known. */
  lastActivityAt: string | null;
  basis: "derived";
}

export interface ProjectHealthOptions {
  /**
   * taskId → when the task entered waiting_on_client (listStatusChangeEntries
   * in sources/dd.ts). A task missing here is aged from lastActivityAt, which
   * is a lower bound on its time waiting.
   */
  waitingSince?: ReadonlyMap<string, string>;
}

const DAY_MS = 86_400_000;

// off_track
const OVERDUE_SHARE_OFF_TRACK = 0.3;
const MIN_OVERDUE_OFF_TRACK = 2;
const INACTIVE_DAYS_OFF_TRACK = 14;
// at_risk
const STALLED_SHARE_AT_RISK = 0.2;
const WAITING_DAYS_AT_RISK = 14;

const STATUS_RANK: Record<ProjectHealthStatus, number> = { off_track: 0, at_risk: 1, on_track: 2, no_data: 3 };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const percent = (part: number, whole: number) => Math.round((part / whole) * 100);

/** Work that exists, whatever its state: drafts, deleted rows and rejected drafts are not project work. */
function isProjectWork(t: DdTask): boolean {
  return !t.isDraft && t.deletedAt == null && t.status !== "rejected";
}

/**
 * A stage placeholder the flow engine hasn't dispatched yet: unassigned, not
 * queued to a team, inside a stage. Template projects create every stage's
 * tasks up front, so these sit untouched by design until their stage opens.
 * Counting them as stalled would flag every project with future stages, and
 * counting them in a share would water it down.
 */
function isUndispatched(t: DdTask): boolean {
  return t.assigneeId == null && t.stageId != null && !isTeamTask(t);
}

/**
 * The most recent activity on the project. The sweep stamps last_activity_at
 * on the rows it archives, so an archived task contributes only its real
 * completion time. Stage note edits and status flips count too.
 */
function projectActivityAt(tasks: readonly DdTask[], stages: readonly DdProjectStage[]): string | null {
  const candidates = [...tasks.map((t) => (t.archivedAt == null ? t.lastActivityAt : t.completedAt)), ...stages.map((s) => s.updatedAt)];
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const iso of candidates) {
    const ms = iso == null ? Number.NaN : Date.parse(iso);
    if (Number.isFinite(ms) && ms > latestMs) {
      latest = iso;
      latestMs = ms;
    }
  }
  return latest;
}

/** The tail of the stuck-stage reason; analysis/project-detail.ts lists that reason as a derived blocker. */
export const STUCK_STAGE_REASON = "is still locked although every stage before it is done";

/**
 * The stage the flow is stuck at, if any: the first stage that isn't done is
 * still locked although every stage before it is done. The engine opens the
 * next stage as the last one finishes, so this means nothing will move on its
 * own. A project whose first stage is locked has no earlier stages and isn't
 * reported.
 */
function stuckStage(stages: readonly DdProjectStage[]): DdProjectStage | null {
  const ordered = [...stages].sort((a, b) => a.position - b.position);
  const index = ordered.findIndex((s) => s.status !== "done");
  if (index <= 0) return null;
  return ordered[index].status === "locked" ? ordered[index] : null;
}

/**
 * Health of one project from its stages and tasks (rows of other projects are
 * ignored, so the full lists can be passed). Rules, in order:
 *   no_data    no tasks at all
 *   off_track  overdue ≥ 30% of active tasks (at least 2 overdue); any overdue
 *              critical task; no activity for 14 days while tasks are open
 *   at_risk    any overdue task; stalled ≥ 20% of active tasks (isStalledWork,
 *              the feed's rule: overdue work, incidents and tasks waiting on
 *              the client or on a proof review aren't stalled); a task
 *              waiting on the client more than 14 days; a stage stuck locked
 *   on_track   none of the above
 * "Active" is open work that has been handed out: every open task except the
 * stage placeholders the flow hasn't dispatched yet. A template project
 * creates all of its stages' tasks up front, so measured against every open
 * task its future-stage placeholders would water the shares down, and a
 * project whose dispatched work had all gone idle could still read on track.
 * The status is the first group with a rule that fired; reasons list every
 * rule that fired, across both groups.
 */
export function projectHealth(
  project: DdProject,
  stages: readonly DdProjectStage[],
  tasks: readonly DdTask[],
  now: Date,
  opts: ProjectHealthOptions = {}
): ProjectHealth {
  const nowMs = now.getTime();
  const work = tasks.filter((t) => t.projectId === project.id && isProjectWork(t));
  const ownStages = stages.filter((s) => s.projectId === project.id);
  const open = work.filter(isOpen);
  const active = open.filter((t) => !isUndispatched(t));
  const overdue = open.filter((t) => isOverdue(t, now));
  // The share's numerator comes from the same population as its denominator.
  // (A placeholder only has a due date if someone set one by hand; it still
  // counts as overdue above.)
  const overdueActive = overdue.filter((t) => !isUndispatched(t));
  // Over all active work, waiting tasks included: they are work in flight,
  // just not idle work.
  const stalled = active.filter((t) => isStalledWork(t, now));
  const waiting = open.filter((t) => t.status === "waiting_on_client");
  const lastActivityAt = projectActivityAt(work, ownStages);

  const base = {
    projectId: project.id,
    name: project.name,
    stageProgress: { done: ownStages.filter((s) => s.status === "done").length, total: ownStages.length },
    openTasks: open.length,
    undispatchedTasks: open.length - active.length,
    overdueTasks: overdue.length,
    stalledTasks: stalled.length,
    waitingOnClient: waiting.length,
    lastActivityAt,
    basis: "derived" as const
  };

  if (work.length === 0) return { ...base, status: "no_data", reasons: ["No tasks in this project yet"] };

  const offTrack: string[] = [];
  // At least two overdue active tasks means active is at least two: no zero division.
  if (overdueActive.length >= MIN_OVERDUE_OFF_TRACK && overdueActive.length / active.length >= OVERDUE_SHARE_OFF_TRACK) {
    offTrack.push(`${overdueActive.length} of ${active.length} active tasks overdue (${percent(overdueActive.length, active.length)}%)`);
  }
  const overdueCritical = overdue.filter((t) => t.priority === "critical").length;
  if (overdueCritical > 0) offTrack.push(`${plural(overdueCritical, "critical task", "critical tasks")} overdue`);
  const lastMs = lastActivityAt == null ? Number.NaN : Date.parse(lastActivityAt);
  // An unknown last activity isn't evidence of inactivity, so it never fires this rule.
  if (open.length > 0 && Number.isFinite(lastMs) && nowMs - lastMs > INACTIVE_DAYS_OFF_TRACK * DAY_MS) {
    offTrack.push(`No activity for ${Math.floor((nowMs - lastMs) / DAY_MS)} days with ${plural(open.length, "open task", "open tasks")}`);
  }

  const atRisk: string[] = [];
  if (overdue.length > 0) atRisk.push(plural(overdue.length, "overdue task", "overdue tasks"));
  if (active.length > 0 && stalled.length / active.length >= STALLED_SHARE_AT_RISK) {
    atRisk.push(`${stalled.length} of ${active.length} active tasks idle over 7 days (${percent(stalled.length, active.length)}%)`);
  }
  let waitingTooLong = 0;
  let longestMs = 0;
  let longestIsLowerBound = false;
  for (const t of waiting) {
    const entered = opts.waitingSince?.get(t.id);
    const sinceMs = Date.parse(entered ?? t.lastActivityAt);
    if (!Number.isFinite(sinceMs) || nowMs - sinceMs <= WAITING_DAYS_AT_RISK * DAY_MS) continue;
    waitingTooLong += 1;
    if (nowMs - sinceMs > longestMs) {
      longestMs = nowMs - sinceMs;
      longestIsLowerBound = entered === undefined;
    }
  }
  if (waitingTooLong > 0) {
    const longest = `${longestIsLowerBound ? "at least " : ""}${Math.floor(longestMs / DAY_MS)} days`;
    atRisk.push(`${plural(waitingTooLong, "task", "tasks")} waiting on the client over ${WAITING_DAYS_AT_RISK} days (longest ${longest})`);
  }
  const stuck = stuckStage(ownStages);
  if (stuck) atRisk.push(`Stage "${stuck.name}" ${STUCK_STAGE_REASON}`);

  const status: ProjectHealthStatus = offTrack.length > 0 ? "off_track" : atRisk.length > 0 ? "at_risk" : "on_track";
  return { ...base, status, reasons: [...offTrack, ...atRisk] };
}

/**
 * projectHealth for many projects at once, worst first: off track, at risk,
 * on track, no data; then more overdue, more stalled, more waiting; then by
 * name and id so the order is stable.
 */
export function projectsHealth(
  projects: readonly DdProject[],
  stages: readonly DdProjectStage[],
  tasks: readonly DdTask[],
  now: Date,
  opts: ProjectHealthOptions = {}
): ProjectHealth[] {
  const stagesByProject = new Map<string, DdProjectStage[]>();
  for (const s of stages) {
    const list = stagesByProject.get(s.projectId);
    if (list) list.push(s);
    else stagesByProject.set(s.projectId, [s]);
  }
  const tasksByProject = new Map<string, DdTask[]>();
  for (const t of tasks) {
    if (t.projectId == null) continue;
    const list = tasksByProject.get(t.projectId);
    if (list) list.push(t);
    else tasksByProject.set(t.projectId, [t]);
  }
  return projects
    .map((p) => projectHealth(p, stagesByProject.get(p.id) ?? [], tasksByProject.get(p.id) ?? [], now, opts))
    .sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        b.overdueTasks - a.overdueTasks ||
        b.stalledTasks - a.stalledTasks ||
        b.waitingOnClient - a.waitingOnClient ||
        a.name.localeCompare(b.name) ||
        (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0)
    );
}
