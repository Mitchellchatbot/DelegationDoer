import { STUCK_STAGE_REASON, type ProjectHealth } from "@/lib/exec/analysis/projects";
import { closedWithStage } from "@/lib/exec/analysis/tasks";
import { pluralize } from "@/lib/exec/format";
import { ddProjectRef, ddTaskRef } from "@/lib/exec/refs";
import type { DdActivity, DdProject, DdProjectStage, DdProjectTask, DdStatusTransition, DdTask } from "@/lib/exec/sources/dd-types";
import type { DerivedBlocker, DerivedClient, ProjectUpdateEvent, StuckSignal } from "@/lib/exec/view-types";
import { isTeamTask } from "@/lib/task-team";

// Project detail analysis (P5a contract §3.9.3, A4, C16, C30, K25). Pure: no
// I/O, `now` passed in. DD has no dependency model, so nothing here says a
// task is "blocked by" another: stuck batches and long waits are what the
// records show, and they are labelled derived.

export const MIN_NAMED_CLIENT_TASKS = 3;
/** K25: the derived client holds at least 60% of the live tasks that name a client. */
const DERIVED_CLIENT_SHARE = 0.6;
/** C16: stage tasks created this close to the project are its template, folded into "project created". */
const TEMPLATE_FOLD_MS = 60_000;
/** A transition this close to a completion is what completed the task (C16, C30). */
const COMPLETION_COVER_MS = 2 * 60_000;
const MAX_EVENTS = 60;
const DAY_MS = 86_400_000;
/** A task waiting on the client this long is listed as a derived blocker. */
const WAITING_BLOCKER_DAYS = 7;

const toMs = (iso: string | null | undefined) => (typeof iso === "string" ? Date.parse(iso) : Number.NaN);
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Not a draft, not deleted, not a rejected draft: the project's real work. */
function isLive(t: DdTask): boolean {
  return !t.isDraft && t.deletedAt == null && t.status !== "rejected";
}

/**
 * Can't finish (a-correct-17): not done, and deleted, rejected or still a
 * draft. DD's flow judges a batch by status alone (project-flow.ts), so a
 * deleted task that is done counts as done.
 */
function unfinishableReason(t: DdProjectTask): "deleted" | "rejected" | "draft" | null {
  if (t.status === "done") return null;
  if (t.deletedAt != null) return "deleted";
  if (t.status === "rejected") return "rejected";
  if (t.isDraft) return "draft";
  return null;
}

/**
 * A stage's tasks in DD's batches (project-flow.ts loadStageTasks and
 * bucketByGroup): sorted by parallel_group (null last) then stage_position
 * (null as 0), then grouped by consecutive parallel_group. Every state is
 * included, as the flow reads them. The current batch is the first one that
 * isn't all done.
 */
export function stageBatches(stageTasks: readonly DdProjectTask[]): { groups: DdProjectTask[][]; current: number } {
  const sorted = [...stageTasks].sort((a, b) => {
    const ag = a.parallelGroup ?? Number.MAX_SAFE_INTEGER;
    const bg = b.parallelGroup ?? Number.MAX_SAFE_INTEGER;
    return ag - bg || (a.stagePosition ?? 0) - (b.stagePosition ?? 0) || byId(a.id, b.id);
  });
  const groups: DdProjectTask[][] = [];
  for (const t of sorted) {
    const last = groups[groups.length - 1];
    if (last && last[0].parallelGroup === t.parallelGroup) last.push(t);
    else groups.push([t]);
  }
  return { groups, current: groups.findIndex((g) => !g.every((t) => t.status === "done")) };
}

/**
 * Stuck-batch signals of one active stage (C16): the current batch holds a
 * task that can't finish, or an unassigned not-done task beside assigned
 * siblings (the flow hands a batch out only while nobody in it is assigned,
 * so it would never reach that task; a team-queued one can still be claimed
 * and is counted as such). Inactive stages give nothing.
 */
export function stuckBatchSignals(
  stage: DdProjectStage,
  stageTasks: readonly DdProjectTask[]
): { signals: StuckSignal[]; currentGroup: number | null; queuedBehind: number } {
  if (stage.status !== "active") return { signals: [], currentGroup: null, queuedBehind: 0 };
  const { groups, current } = stageBatches(stageTasks.filter((t) => t.stageId === stage.id));
  if (current < 0) return { signals: [], currentGroup: null, queuedBehind: 0 };
  const batch = groups[current];
  const queuedBehind = groups.slice(current + 1).reduce((n, g) => n + g.filter((t) => t.status !== "done").length, 0);
  const signals: StuckSignal[] = [];

  const unfinishable = batch.flatMap((t) => {
    const reason = unfinishableReason(t);
    return reason === null ? [] : [{ taskId: t.id, reason }];
  });
  if (unfinishable.length > 0) {
    signals.push({ kind: "unfinishable_task_in_batch", stageId: stage.id, stageName: stage.name, tasks: unfinishable });
  }

  const live = batch.filter((t) => unfinishableReason(t) === null);
  if (live.some((t) => t.assigneeId !== null)) {
    const unassigned = live.filter((t) => t.assigneeId === null && t.status !== "done");
    if (unassigned.length > 0) {
      signals.push({
        kind: "unassigned_task_in_batch",
        stageId: stage.id,
        stageName: stage.name,
        taskIds: unassigned.map((t) => t.id),
        teamQueued: unassigned.filter((t) => isTeamTask(t)).length
      });
    }
  }
  return { signals, currentGroup: batch[0].parallelGroup, queuedBehind };
}

/**
 * K25 (a-correct-3). The project's client, derived from its tasks: over the
 * live tasks that name a client (a non-empty trimmed client_name), at least
 * MIN_NAMED_CLIENT_TASKS of them, the most common exact trimmed name when it
 * holds at least 60% of them and matches a client (`clientIdByName` keyed by
 * trimmed client name). DD's template stage tasks name no client, so they
 * neither count for nor dilute the share. null otherwise.
 */
export function deriveProjectClient(tasks: readonly DdProjectTask[], clientIdByName: ReadonlyMap<string, string>): DerivedClient | null {
  const counts = new Map<string, number>();
  let named = 0;
  for (const t of tasks) {
    if (!isLive(t)) continue;
    const name = typeof t.clientName === "string" ? t.clientName.trim() : "";
    if (name === "") continue;
    named += 1;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (named < MIN_NAMED_CLIENT_TASKS) return null;
  let top: { name: string; count: number } | null = null;
  for (const [name, count] of counts) {
    if (top === null || count > top.count || (count === top.count && name < top.name)) top = { name, count };
  }
  // Integer comparison: 3 of 5 is exactly 60%.
  if (top === null || top.count * 10 < named * DERIVED_CLIENT_SHARE * 10) return null;
  const clientId = clientIdByName.get(top.name);
  if (clientId === undefined) return null;
  return { clientId, clientName: top.name, taskCount: top.count, namedTaskCount: named, share: top.count / named, basis: "derived" };
}

const statusText = (s: string) => s.replace(/_/g, " ");

/**
 * The project's updates feed (C16, C30), newest first, at most 60, in
 * [sinceIso, now]. Events come from records with their own times only: the
 * project's creation (its template stage tasks folded in), each other live
 * task's creation, status changes (first line only), completions no status
 * change explains, and manual stage closes (one per close, no actor: DD
 * records none). Never a stage's updated_at (note edits move it) or a task's
 * last_activity_at (the auto-archive sweep stamps it). Drafts, deleted rows
 * and rejected drafts produce nothing.
 */
export function projectUpdateEvents(input: {
  project: DdProject;
  stages: readonly DdProjectStage[];
  tasks: readonly DdProjectTask[];
  transitions: readonly DdStatusTransition[];
  approvals: readonly Pick<DdActivity, "taskId" | "createdAt">[];
  userNames: ReadonlyMap<string, string>;
  sinceIso: string;
  now: Date;
}): ProjectUpdateEvent[] {
  const { project, stages, transitions, approvals, userNames, now } = input;
  const since = toMs(input.sinceIso);
  const until = now.getTime();
  const inWindow = (ms: number) => Number.isFinite(ms) && ms >= since && ms <= until;
  const tasks = input.tasks.filter((t) => t.projectId === project.id && isLive(t));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const projectRef = ddProjectRef(project);
  const created = toMs(project.createdAt);
  const events: (ProjectUpdateEvent & { ms: number; order: string })[] = [];

  const folded = new Set(
    tasks.filter((t) => t.stageId != null && Math.abs(toMs(t.createdAt) - created) <= TEMPLATE_FOLD_MS).map((t) => t.id)
  );
  if (inWindow(created)) {
    events.push({
      kind: "project_created",
      at: project.createdAt,
      title: `Project "${project.name}" created`,
      detail: folded.size > 0 ? `with ${pluralize(folded.size, "stage task", "stage tasks")}` : "",
      actorName: null,
      ref: projectRef,
      ms: created,
      order: `0:${project.id}`
    });
  }

  for (const t of tasks) {
    if (folded.has(t.id) || !inWindow(toMs(t.createdAt))) continue;
    events.push({
      kind: "task_created",
      at: t.createdAt,
      title: t.title,
      detail: "Task created",
      actorName: userNames.get(t.creatorId) ?? null,
      ref: ddTaskRef(t),
      ms: toMs(t.createdAt),
      order: `1:${t.id}`
    });
  }

  for (const tr of transitions) {
    const t = taskById.get(tr.taskId);
    if (!t || !inWindow(toMs(tr.at))) continue;
    events.push({
      kind: "status_changed",
      at: tr.at,
      title: t.title,
      detail: `${statusText(tr.from)} → ${statusText(tr.to)}`,
      actorName: userNames.get(tr.userId) ?? null,
      ref: ddTaskRef(t),
      ms: toMs(tr.at),
      order: `2:${tr.id}`
    });
  }

  const closed = closedWithStage(
    tasks.filter((t) => t.stageId != null),
    transitions,
    approvals
  );
  const doneTransitions = new Map<string, number[]>();
  for (const tr of transitions) {
    if (tr.to !== "done") continue;
    const list = doneTransitions.get(tr.taskId);
    if (list) list.push(toMs(tr.at));
    else doneTransitions.set(tr.taskId, [toMs(tr.at)]);
  }
  for (const t of tasks) {
    if (t.status !== "done" || closed.has(t.id)) continue;
    const at = toMs(t.completedAt);
    if (!inWindow(at)) continue;
    if ((doneTransitions.get(t.id) ?? []).some((ms) => Math.abs(ms - at) <= COMPLETION_COVER_MS)) continue;
    events.push({
      kind: "task_completed",
      at: t.completedAt as string,
      title: t.title,
      detail: "Completed",
      actorName: null,
      ref: ddTaskRef(t),
      ms: at,
      order: `3:${t.id}`
    });
  }

  // One event per manual close: the tasks of one stage stamped at one instant.
  const closes = new Map<string, DdProjectTask[]>();
  for (const t of tasks) {
    if (!closed.has(t.id)) continue;
    const key = `${t.stageId}|${toMs(t.completedAt)}`;
    const list = closes.get(key);
    if (list) list.push(t);
    else closes.set(key, [t]);
  }
  const stageName = new Map(stages.map((s) => [s.id, s.name]));
  for (const group of closes.values()) {
    const first = group[0];
    const at = toMs(first.completedAt);
    if (!inWindow(at)) continue;
    events.push({
      kind: "stage_closed",
      at: first.completedAt as string,
      title: `Stage "${stageName.get(first.stageId ?? "") ?? "Unnamed stage"}" closed manually`,
      detail: `${pluralize(group.length, "task", "tasks")} marked done`,
      actorName: null,
      ref: projectRef,
      ms: at,
      order: `4:${first.stageId}`
    });
  }

  return events
    // Newest first; on one instant, the later step of a task's life first (completed, changed, created).
    .sort((a, b) => b.ms - a.ms || byId(b.order, a.order))
    .slice(0, MAX_EVENTS)
    .map(({ ms, order, ...event }) => {
      void ms;
      void order;
      return event;
    });
}

const UNFINISHABLE_WORDS: Record<"deleted" | "rejected" | "draft", string> = { deleted: "deleted", rejected: "rejected", draft: "still a draft" };

/**
 * Derived blockers (A4): what the records show is holding the project, never
 * a claim that one task blocks another (DD has no dependency model). The
 * stuck-stage reason of its health, each stuck batch signal, and every task
 * waiting on the client for more than 7 days (its wait a lower bound when the
 * status change wasn't found).
 */
export function derivedBlockers(
  health: ProjectHealth,
  stuck: readonly StuckSignal[],
  waiting: readonly { task: DdTask; since: string; lowerBound: boolean }[],
  now: Date
): DerivedBlocker[] {
  const out: DerivedBlocker[] = [];
  for (const reason of health.reasons) {
    if (reason.endsWith(STUCK_STAGE_REASON)) out.push({ text: `${reason}, so DD won't open it on its own`, basis: "derived", refs: [] });
  }
  for (const s of stuck) {
    if (s.kind === "unfinishable_task_in_batch") {
      const why = [...new Set(s.tasks.map((t) => UNFINISHABLE_WORDS[t.reason]))].join(" or ");
      out.push({
        text:
          `The current batch of stage "${s.stageName}" holds ${pluralize(s.tasks.length, "task", "tasks")} that can't be finished (${why}); ` +
          "DD's flow waits for every task in a batch before it moves on",
        basis: "derived",
        refs: s.tasks.map((t) => ddTaskRef({ id: t.taskId }))
      });
    } else {
      const queued = s.teamQueued > 0 ? ` (${s.teamQueued} queued to a team, which can still claim ${s.teamQueued === 1 ? "it" : "them"})` : "";
      out.push({
        text:
          `The current batch of stage "${s.stageName}" has ${pluralize(s.taskIds.length, "unassigned task", "unassigned tasks")} beside assigned ones${queued}; ` +
          "DD's flow only hands out a batch while nobody in it is assigned",
        basis: "derived",
        refs: s.taskIds.map((id) => ddTaskRef({ id }))
      });
    }
  }
  const nowMs = now.getTime();
  const longWaits = waiting
    .map((w) => ({ ...w, days: Math.floor((nowMs - toMs(w.since)) / DAY_MS) }))
    .filter((w) => Number.isFinite(w.days) && w.days > WAITING_BLOCKER_DAYS)
    .sort((a, b) => b.days - a.days || byId(a.task.id, b.task.id));
  for (const w of longWaits) {
    out.push({
      text: `"${w.task.title}" has waited on the client for ${w.lowerBound ? "at least " : ""}${pluralize(w.days, "day", "days")}`,
      basis: "derived",
      refs: [ddTaskRef(w.task)]
    });
  }
  return out;
}

/**
 * Open tasks plus recent completions, one row per id. The two reads aren't one
 * snapshot, so a task finished between them can come back from both; the
 * open copy is kept. (P2b's overview.ts mergeTasks, moved here unchanged.)
 */
export function mergeTaskReads(open: readonly DdTask[], completed: readonly DdTask[]): DdTask[] {
  const seen = new Set(open.map((t) => t.id));
  return [...open, ...completed.filter((t) => !seen.has(t.id))];
}
