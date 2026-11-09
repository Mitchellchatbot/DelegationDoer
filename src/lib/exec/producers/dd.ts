import "server-only";

import { createHash } from "node:crypto";
import {
  completedLate,
  finishedLate,
  isAutoArchived,
  isIncident,
  isOpen,
  isOverdue,
  isOverdueWork,
  isStalled,
  isStalledWork,
  overdueDays,
  PROOF_ACTIONS,
  proofHandedInAt
} from "@/lib/exec/analysis/tasks";
import {
  recurringBasis,
  recurringIncidents,
  recurringSiteAlerts,
  repeatedExtensions,
  type ExtensionRepeats,
  type RecurringGroup
} from "@/lib/exec/analysis/recurring";
import { ATTENTION_LIMITS } from "@/lib/exec/attention";
import type { AttentionCandidate, AttentionCategory, AttentionFact, FactBasis } from "@/lib/exec/attention-types";
import { formatInZone, pluralize } from "@/lib/exec/format";
import { scorePriority, type AttentionKind, type PriorityFactors } from "@/lib/exec/priority";
import { ddClientRef, ddPageRef, ddTaskRef } from "@/lib/exec/refs";
import {
  getPendingApprovals,
  listActivitySince,
  listClients,
  listDepartments,
  listIncidentLogsSince,
  listOpenTasks,
  listSiteHealthAlertsSince,
  listStatusChangeEntries,
  listTaskExtensionsSince,
  listTaskMessagesSince,
  listTaskNotificationsForUser,
  listTasksByIds,
  listTasksCompletedBetween,
  listUsers,
  type DdReadOptions
} from "@/lib/exec/sources/dd";
import type {
  ApprovalBucket,
  ApprovalMechanism,
  DdActivity,
  DdDepartment,
  DdIncidentLog,
  DdSiteHealthAlert,
  DdTask,
  DdTaskExtension,
  DdTaskNotification,
  DdUser,
  TaskPriority,
  TaskStatus
} from "@/lib/exec/sources/dd-types";
import type { ExecPrincipal, SourceRef } from "@/lib/exec/types";
import { isTeamTask } from "@/lib/task-team";

// Needs Attention from DD's own records (plan §2, P2b): deterministic rules,
// recomputed every 10 minutes by handlers/dd-attention.ts and reconciled into
// exec_attention_items by attention.ts.
//
//   overdue_tasks       overdue open work (auto-archived included), one item per
//                       assignee, per department pool, or for work with no owner;
//                       every critical task gets its own item
//   missed_deadlines    2+ late completions in the last 7 days, per assignee; a
//                       proof-reviewed task is judged by when its proof was
//                       submitted, not when the reviewer approved it
//   stalled_tasks       2+ live tasks idle for 7+ days, per assignee
//   pending_approval    one item per approval queue that isn't empty
//   waiting_on_client   tasks waiting on a client for more than 7 days, per client
//   open_incident       each open incident task
//   site_alert          each site with a low-score alert in the last 48 hours
//   unanswered_mention  each task where he was mentioned or notified in the last
//                       14 days and hasn't acted on it since
//   recurring_issue     repeated incidents, site alerts and due-date extensions
//
// One situation, one item. Incident tasks feed only open_incident: they are
// created with due_date = now, so they would also read as overdue from birth
// and as late whenever they're closed. A stalled task that is also overdue,
// waiting on a client or waiting for approval is left to that item, and the
// overdue item says how many of its tasks have gone quiet. An overdue task
// waiting for its proof review has been handed in and only the reviewer can
// move it, so it is left to the proof queue's item, which counts it as past
// due.
//
// Each candidate has a stable fingerprint, so the same situation keeps its row
// across runs, and a state hash that moves only when the situation does: how
// many records, how old the oldest is (in buckets), which records, and their
// status. Never raw timestamps, so a refresh that finds nothing new leaves an
// item he has seen as seen.
//
// Honesty: a fact is a "record" (read from a row) or "derived" (computed here
// by a fixed rule); nothing in P2b is AI-assessed. DD has no dependency model,
// so nothing here says "blocked by": waiting on a client is a status with a
// measured age. recommendedNext comes from fixed templates; it suggests, never
// asserts a fact, blames anyone or decides for him.
//
// Fail closed: every read throws on error (sources/dd.ts), and so does this
// function. syncAttention resolves every live item a sync leaves out, so a
// partial list from a failed read would tell him problems had gone away.

/** Every kind this producer emits, and so the scope its sync resolves within. */
export const DD_ATTENTION_KINDS: readonly AttentionKind[] = Object.freeze([
  "overdue_tasks",
  "missed_deadlines",
  "stalled_tasks",
  "pending_approval",
  "waiting_on_client",
  "open_incident",
  "site_alert",
  "unanswered_mention",
  "recurring_issue"
]);

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const LATE_WINDOW_DAYS = 7;
const MIN_LATE = 2;
const MIN_STALLED = 2;
const WAITING_AFTER_DAYS = 7;
const MENTION_WINDOW_DAYS = 14;
const RECURRING_WINDOW_DAYS = 90;
const SITE_ALERT_WINDOW_HOURS = 48;
// A site whose latest low score is above this is worth knowing about, not stepping in for.
const SITE_FYI_ABOVE = 70;

// Per-record facts kept on one item. The first facts are the summary lines;
// the UI shows the top few, and attention.ts caps facts and refs anyway.
const TASK_FACTS = 8;
const EVENT_FACTS = 5;

// Lowercase labels that read inside a sentence ("... and is in progress").
const STATUS_LABEL: Readonly<Record<TaskStatus, string>> = {
  pending: "pending",
  in_progress: "in progress",
  urgent: "urgent",
  waiting_on_client: "waiting on the client",
  pending_approval: "waiting for approval",
  done: "done",
  rejected: "rejected"
};

const PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = { critical: 0, high: 1, medium: 2, low: 3 };

// ---------------------------------------------------------------------------
// Identity and state
// ---------------------------------------------------------------------------

// Fingerprint keys go into PostgREST filters, and attention.ts refuses
// whitespace, quotes, commas, parentheses and backslashes in them. An id-like
// key (a task or user id, a host) is used as it is. Anything else (a client
// name, an incident's "type|url" key) becomes a readable slug plus a hash of
// the exact key, so "Acme Inc" and "Acme, Inc." stay two situations. Every
// key starts with a letter or digit, so a marker starting with "_" can't
// collide with one.
const PLAIN_KEY = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const NO_CLIENT_KEY = "_none";

function keyPart(key: string): string {
  if (PLAIN_KEY.test(key)) return key;
  const slug = key
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return slug ? `${slug}-${hash}` : hash;
}

/**
 * keyPart, exported for the ddtext fingerprints (P5a C1:
 * dd:ddtext:<kind>:<source_type>:<ddFingerprintKey(source_id)>). No behaviour
 * change: every DD fingerprint key still goes through keyPart.
 */
export function ddFingerprintKey(key: string): string {
  return keyPart(key);
}

/** The unanswered_mention item's fingerprint for a task (P5a C18 checks whether one is live). */
export function ddMentionFingerprint(taskId: string): string {
  return `dd:mention:task:${keyPart(taskId)}`;
}

interface ItemState {
  count: number;
  /** Whole days since the oldest record started the situation; null when unknown. */
  oldestDays: number | null;
  ids: readonly string[];
  status: string;
}

function ageBucket(days: number | null): string {
  if (days === null) return "unknown";
  if (days >= 30) return "30+";
  if (days >= 14) return "14-29";
  if (days >= 7) return "7-13";
  if (days >= 3) return "3-6";
  return "0-2";
}

/** sha256 (16 hex characters) of what makes the situation worth seeing again. */
function stateHash(state: ItemState): string {
  const ids = [...new Set(state.ids)].sort();
  const canonical = JSON.stringify([state.count, ageBucket(state.oldestDays), ids, state.status]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface Ctx {
  principal: ExecPrincipal;
  now: Date;
  nowMs: number;
  users: ReadonlyMap<string, DdUser>;
  departments: ReadonlyMap<string, DdDepartment>;
}

/** Epoch ms, or NaN for a missing or unreadable timestamp (every comparison with NaN is false). */
function ms(iso: string | null | undefined): number {
  return typeof iso === "string" ? Date.parse(iso) : Number.NaN;
}

/** The earliest of these timestamps, as given; null when none is readable. */
function earliestOf(isos: readonly (string | null)[]): string | null {
  let best: string | null = null;
  for (const iso of isos) {
    if (Number.isFinite(ms(iso)) && (best === null || ms(iso) < ms(best))) best = iso;
  }
  return best;
}

/** Whole days from `iso` to now, floored and never negative; null when the timestamp is unreadable. */
function daysSince(ctx: Ctx, iso: string | null | undefined): number | null {
  const at = ms(iso);
  return Number.isFinite(at) ? Math.max(0, Math.floor((ctx.nowMs - at) / DAY_MS)) : null;
}

function span(days: number | null): string {
  if (days === null) return "an unknown time";
  return days === 0 ? "less than a day" : pluralize(days, "day");
}

function ago(days: number | null): string {
  return days === null ? "at an unknown time" : `${span(days)} ago`;
}

/** A calendar date in his zone ("Nov 4"; the year is added outside the current one). */
function day(ctx: Ctx, iso: string | null): string {
  return formatInZone(iso, ctx.principal.timezone, "date", ctx.now);
}

/** An instant in his zone ("Nov 4, 8:02 AM EST"). */
function moment(ctx: Ctx, iso: string | null): string {
  return formatInZone(iso, ctx.principal.timezone, "datetime", ctx.now);
}

function isMe(ctx: Ctx, userId: string | null): boolean {
  return userId !== null && userId === ctx.principal.userId;
}

function personName(ctx: Ctx, userId: string): string {
  return ctx.users.get(userId)?.name ?? `user ${userId}`;
}

function departmentName(ctx: Ctx, departmentId: string): string {
  return ctx.departments.get(departmentId)?.name ?? `department ${departmentId}`;
}

function statusText(status: TaskStatus): string {
  return Object.hasOwn(STATUS_LABEL, status) ? STATUS_LABEL[status] : String(status);
}

function hasClient(t: Pick<DdTask, "clientName">): boolean {
  return typeof t.clientName === "string" && t.clientName.trim() !== "";
}

/** The highest task priority among `tasks`; undefined when there are none. */
function topPriority(tasks: readonly Pick<DdTask, "priority">[]): TaskPriority | undefined {
  let best: TaskPriority | undefined;
  for (const t of tasks) {
    if (!Object.hasOwn(PRIORITY_RANK, t.priority)) continue;
    if (best === undefined || PRIORITY_RANK[t.priority] < PRIORITY_RANK[best]) best = t.priority;
  }
  return best;
}

function statusSet(tasks: readonly Pick<DdTask, "status">[]): string {
  return [...new Set(tasks.map((t) => t.status))].sort().join(",");
}

/** Oldest first by the given timestamp; unreadable ones last; ties by id. */
function byTime<T extends { id: string }>(at: (item: T) => string | null): (a: T, b: T) => number {
  return (a, b) => {
    const x = ms(at(a));
    const y = ms(at(b));
    if (x !== y) {
      if (!Number.isFinite(x)) return 1;
      if (!Number.isFinite(y)) return -1;
      return x - y;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

function newestFirst<T extends { id: string }>(items: readonly T[], at: (item: T) => string | null): T[] {
  return [...items].sort(byTime(at)).reverse();
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string | null): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) continue;
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function unique(ids: readonly (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

function fact(text: string, basis: FactBasis, refs: SourceRef[] = []): AttentionFact {
  return { text, basis, refs };
}

function taskFacts(tasks: readonly DdTask[], line: (t: DdTask) => string): AttentionFact[] {
  return tasks.slice(0, TASK_FACTS).map((t) => fact(line(t), "record", [ddTaskRef(t)]));
}

interface Spec {
  fingerprint: string;
  kind: AttentionKind;
  category: AttentionCategory;
  title: string;
  whatHappened: string;
  whyItMatters: string;
  recommendedNext: string;
  facts: AttentionFact[];
  refs: SourceRef[];
  factors: Omit<PriorityFactors, "kind">;
  state: ItemState;
  occurredAt: string | null;
}

function candidate(spec: Spec): AttentionCandidate {
  const seen = new Set<string>();
  const refs = spec.refs.filter((r) => {
    const key = `${r.system}:${r.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    fingerprint: spec.fingerprint,
    source: "dd",
    kind: spec.kind,
    category: spec.category,
    title: spec.title,
    whatHappened: spec.whatHappened,
    whyItMatters: spec.whyItMatters,
    recommendedNext: spec.recommendedNext,
    facts: spec.facts.slice(0, ATTENTION_LIMITS.facts),
    refs: refs.slice(0, ATTENTION_LIMITS.refs),
    priority: scorePriority({ ...spec.factors, kind: spec.kind }),
    stateHash: stateHash(spec.state),
    occurredAt: spec.occurredAt
  };
}

// ---------------------------------------------------------------------------
// overdue_tasks
// ---------------------------------------------------------------------------

type Owner = { kind: "assignee"; userId: string } | { kind: "team"; departmentId: string } | { kind: "none" };

function ownerOf(t: DdTask): Owner {
  if (t.assigneeId) return { kind: "assignee", userId: t.assigneeId };
  // Unassigned work queued to a department. Any other unassigned task (an
  // off-boarded user's leftovers, a task created without an assignee) has no
  // owner at all.
  if (t.departmentId && isTeamTask(t)) return { kind: "team", departmentId: t.departmentId };
  return { kind: "none" };
}

function ownerKey(owner: Owner): string {
  if (owner.kind === "assignee") return `assignee:${keyPart(owner.userId)}`;
  if (owner.kind === "team") return `team:${keyPart(owner.departmentId)}`;
  return "unassigned";
}

function ownerCategory(ctx: Ctx, owner: Owner): AttentionCategory {
  if (owner.kind === "assignee") return isMe(ctx, owner.userId) ? "my_action" : "delegated";
  // A pool is delegated to its department. Work nobody owns needs someone to step in.
  return owner.kind === "team" ? "delegated" : "intervene";
}

function ownerSentence(ctx: Ctx, owner: Owner, n: number): string {
  const one = n === 1;
  switch (owner.kind) {
    case "assignee":
      return `${one ? "It's" : "They're"} assigned to ${isMe(ctx, owner.userId) ? "you" : personName(ctx, owner.userId)}.`;
    case "team":
      return one
        ? `It's in the ${departmentName(ctx, owner.departmentId)} team pool and nobody has claimed it.`
        : `They're in the ${departmentName(ctx, owner.departmentId)} team pool and nobody has claimed them.`;
    case "none":
      return one ? "It has no assignee." : "None of them has an assignee.";
  }
}

function overdueTitle(ctx: Ctx, owner: Owner, tasks: readonly DdTask[]): string {
  const n = tasks.length;
  const first = tasks[0].title;
  switch (owner.kind) {
    case "assignee":
      if (isMe(ctx, owner.userId)) return n === 1 ? `Your task is overdue: ${first}` : `You have ${n} overdue tasks`;
      return n === 1 ? `Overdue: ${first} (${personName(ctx, owner.userId)})` : `${n} overdue tasks for ${personName(ctx, owner.userId)}`;
    case "team": {
      const dept = departmentName(ctx, owner.departmentId);
      return n === 1 ? `Overdue in the ${dept} team pool: ${first}` : `${n} overdue tasks in the ${dept} team pool`;
    }
    case "none":
      return n === 1 ? `Overdue with no owner: ${first}` : `${n} overdue tasks with no owner`;
  }
}

function overdueNext(ctx: Ctx, owner: Owner, n: number): string {
  const one = n === 1;
  const them = one ? "it" : "them";
  switch (owner.kind) {
    case "assignee":
      if (isMe(ctx, owner.userId)) return one ? "Set a new due date, or hand it off." : "Set new due dates, or hand some of these off.";
      return `Ask ${personName(ctx, owner.userId)} for a new date, or decide whether to reassign.`;
    case "team": {
      const dept = departmentName(ctx, owner.departmentId);
      const head = ctx.departments.get(owner.departmentId)?.headUserId ?? null;
      if (head !== null && !isMe(ctx, head)) {
        return `Ask ${personName(ctx, head)} (${dept} head) to get ${them} claimed, or assign ${them} directly.`;
      }
      return `Ask the ${dept} team to claim ${them}, or assign ${them} directly.`;
    }
    case "none":
      return one
        ? "Pick an owner for it, or close it if it's no longer needed."
        : "Pick owners for these, or close the ones that are no longer needed.";
  }
}

/** Summary lines first, then one record line per task (most overdue first). */
function overdueFacts(ctx: Ctx, tasks: readonly DdTask[]): AttentionFact[] {
  const n = tasks.length;
  const late = overdueDays(tasks[0], ctx.now);
  const facts = [fact(n === 1 ? `Past due by ${span(late)}.` : `${n} tasks past due; the oldest by ${span(late)}.`, "derived")];
  const archived = tasks.filter(isAutoArchived).length;
  if (archived > 0) {
    const one = archived === 1;
    const text =
      n === 1
        ? "DD's overdue sweep archived it, but it isn't done."
        : `${archived} of them ${one ? "was" : "were"} archived by DD's overdue sweep but ${one ? "isn't" : "aren't"} done.`;
    facts.push(fact(text, "derived"));
  }
  const idle = tasks.filter((t) => isStalled(t, ctx.now)).length;
  if (idle > 0) {
    const text = n === 1 ? "No activity on it for 7+ days." : `${idle} of them ${idle === 1 ? "has" : "have"} had no activity for 7+ days.`;
    facts.push(fact(text, "derived"));
  }
  const waiting = tasks.filter((t) => t.status === "waiting_on_client").length;
  if (n > 1 && waiting > 0) facts.push(fact(`${waiting} of them ${waiting === 1 ? "is" : "are"} waiting on the client.`, "derived"));
  return [...facts, ...taskFacts(tasks, (t) => `"${t.title}": due ${day(ctx, t.dueDate)}, ${statusText(t.status)}.`)];
}

function overdueState(tasks: readonly DdTask[], ctx: Ctx): ItemState {
  return { count: tasks.length, oldestDays: overdueDays(tasks[0], ctx.now), ids: tasks.map((t) => t.id), status: statusSet(tasks) };
}

function overdueGroup(ctx: Ctx, owner: Owner, tasks: readonly DdTask[]): AttentionCandidate {
  const n = tasks.length;
  const oldest = tasks[0];
  const late = overdueDays(oldest, ctx.now);
  const due = `${day(ctx, oldest.dueDate)} (${ago(late)})`;
  const lead =
    n === 1
      ? `"${oldest.title}" was due ${due} and is ${statusText(oldest.status)}.`
      : `${n} open tasks are past their due date. The oldest, "${oldest.title}", was due ${due}.`;
  return candidate({
    fingerprint: `dd:overdue:${ownerKey(owner)}`,
    kind: "overdue_tasks",
    category: ownerCategory(ctx, owner),
    title: overdueTitle(ctx, owner, tasks),
    whatHappened: `${lead} ${ownerSentence(ctx, owner, n)}`,
    whyItMatters: "Work past its due date can hold up client commitments, and it gets harder to recover the longer it sits.",
    recommendedNext: overdueNext(ctx, owner, n),
    facts: overdueFacts(ctx, tasks),
    refs: tasks.map((t) => ddTaskRef(t)),
    factors: {
      overdueDays: late,
      count: n,
      taskPriority: topPriority(tasks),
      clientFacing: tasks.some(hasClient),
      aboutPrincipal: owner.kind === "assignee" && isMe(ctx, owner.userId)
    },
    state: overdueState(tasks, ctx),
    occurredAt: oldest.dueDate
  });
}

function criticalOverdue(ctx: Ctx, t: DdTask): AttentionCandidate {
  const owner = ownerOf(t);
  const late = overdueDays(t, ctx.now);
  const recommendedNext =
    owner.kind === "assignee"
      ? isMe(ctx, owner.userId)
        ? "Finish it or hand it off, and set a new date if it needs one."
        : `Check with ${personName(ctx, owner.userId)} on what it needs to finish, or reassign it.`
      : overdueNext(ctx, owner, 1);
  return candidate({
    fingerprint: `dd:overdue:task:${keyPart(t.id)}`,
    kind: "overdue_tasks",
    category: ownerCategory(ctx, owner),
    title: `Critical task overdue: ${t.title}`,
    whatHappened:
      `"${t.title}" is marked critical and was due ${day(ctx, t.dueDate)} (${ago(late)}). ` +
      `It is ${statusText(t.status)}. ${ownerSentence(ctx, owner, 1)}`,
    whyItMatters: "Critical is DD's highest task priority, and this one is already past its due date.",
    recommendedNext,
    facts: overdueFacts(ctx, [t]),
    refs: [ddTaskRef(t)],
    factors: {
      overdueDays: late,
      taskPriority: "critical",
      clientFacing: hasClient(t),
      aboutPrincipal: owner.kind === "assignee" && isMe(ctx, owner.userId)
    },
    state: overdueState([t], ctx),
    occurredAt: t.dueDate
  });
}

// Overdue work its owner can still move (isOverdueWork, analysis/tasks.ts). A
// task waiting for its proof review has been handed in, and only the reviewer
// can move it, so it is left to the proof queue's approval item, which counts
// it as past due (pastDueProofs).
function overdueCandidates(ctx: Ctx, openTasks: readonly DdTask[]): AttentionCandidate[] {
  const overdue = openTasks.filter((t) => isOverdueWork(t, ctx.now)).sort(byTime((t) => t.dueDate));
  const critical = overdue.filter((t) => t.priority === "critical").map((t) => criticalOverdue(ctx, t));
  const groups = groupBy(
    overdue.filter((t) => t.priority !== "critical"),
    (t) => ownerKey(ownerOf(t))
  ).map(([, tasks]) => overdueGroup(ctx, ownerOf(tasks[0]), tasks));
  return [...groups, ...critical];
}

// ---------------------------------------------------------------------------
// missed_deadlines
// ---------------------------------------------------------------------------

/**
 * Completions past their due date that the rule looks at: someone's, and not
 * an incident's. Whether each was really late waits on its proof events.
 */
function lateCompletions(completed: readonly DdTask[]): DdTask[] {
  return completed.filter((t) => completedLate(t) && t.assigneeId !== null && !isIncident(t));
}

function lateCandidates(ctx: Ctx, late: readonly DdTask[], proofEvents: readonly DdActivity[]): AttentionCandidate[] {
  // Judged by when the work was handed in: approving a proof stamps
  // completed_at with the reviewer's click, so a proof handed in on time and
  // approved after the due date isn't the assignee's late finish.
  const eventsByTask = new Map(groupBy(proofEvents, (e) => e.taskId));
  const handedIn = new Map<string, string>();
  const finishedLateTasks = late.filter((t) => {
    const at = proofHandedInAt(t.completedAt, eventsByTask.get(t.id) ?? []);
    if (at !== null) handedIn.set(t.id, at);
    return finishedLate(t, at);
  });
  return groupBy(finishedLateTasks, (t) => t.assigneeId)
    .filter(([, tasks]) => tasks.length >= MIN_LATE)
    .map(([userId, group]) => {
      const tasks = newestFirst(group, (t) => t.completedAt);
      const n = tasks.length;
      const latest = tasks[0];
      const mine = isMe(ctx, userId);
      const who = mine ? "You" : personName(ctx, userId);
      // A reviewed task left here was handed in after its due date too, but it
      // was marked done by its reviewer, so the item says what the record says.
      const reviewed = tasks.filter((t) => handedIn.has(t.id)).length;
      const whose = mine ? "your" : `${personName(ctx, userId)}'s`;
      const summary = `${n} of ${whose} tasks were marked done after their due dates in the last ${LATE_WINDOW_DAYS} days`;
      const finishLine = (t: DdTask): string => {
        const submitted = handedIn.get(t.id);
        return submitted === undefined
          ? `was due ${day(ctx, t.dueDate)} and done ${day(ctx, t.completedAt)}`
          : `was due ${day(ctx, t.dueDate)}; its proof was submitted ${day(ctx, submitted)} and approved ${day(ctx, t.completedAt)}`;
      };
      const latestLine = `The latest, "${latest.title}", ${finishLine(latest)}.`;
      return candidate({
        fingerprint: `dd:late:assignee:${keyPart(userId)}`,
        kind: "missed_deadlines",
        category: "fyi",
        title: reviewed > 0 ? summary : `${who} finished ${n} tasks late in the last ${LATE_WINDOW_DAYS} days`,
        whatHappened:
          reviewed > 0
            ? `${summary}. ${reviewed} went through a proof review, and ` +
              `${reviewed === 1 ? "its proof was" : "each proof was"} submitted after the due date. ${latestLine}`
            : `${who} completed ${n} tasks after their due dates in the last ${LATE_WINDOW_DAYS} days. ${latestLine}`,
        whyItMatters: "A run of late finishes can mean the deadlines are too tight or the workload is too high.",
        recommendedNext: mine
          ? "Look at whether your deadlines or your workload need adjusting."
          : `Check in with ${personName(ctx, userId)} on workload and whether the deadlines are realistic.`,
        facts: [
          fact(`${n} late completions in the last ${LATE_WINDOW_DAYS} days.`, "derived"),
          ...(reviewed > 0 ? [fact("A proof-reviewed task is judged by when its proof was submitted, not when it was approved.", "derived")] : []),
          ...taskFacts(tasks, (t) => {
            const submitted = handedIn.get(t.id);
            return submitted === undefined
              ? `"${t.title}": due ${day(ctx, t.dueDate)}, completed ${day(ctx, t.completedAt)}.`
              : `"${t.title}": due ${day(ctx, t.dueDate)}, proof submitted ${day(ctx, submitted)}, approved ${day(ctx, t.completedAt)}.`;
          })
        ],
        refs: tasks.map((t) => ddTaskRef(t)),
        factors: { count: n, taskPriority: topPriority(tasks), clientFacing: tasks.some(hasClient), aboutPrincipal: mine },
        state: { count: n, oldestDays: daysSince(ctx, tasks[n - 1].completedAt), ids: tasks.map((t) => t.id), status: "done" },
        occurredAt: latest.completedAt
      });
    });
}

// ---------------------------------------------------------------------------
// stalled_tasks
// ---------------------------------------------------------------------------

function stalledCandidates(ctx: Ctx, openTasks: readonly DdTask[]): AttentionCandidate[] {
  // The one stalled rule (isStalledWork, analysis/tasks.ts), on assigned work.
  const stalled = openTasks.filter((t) => t.assigneeId !== null && isStalledWork(t, ctx.now));
  return groupBy(stalled, (t) => t.assigneeId)
    .filter(([, tasks]) => tasks.length >= MIN_STALLED)
    .map(([userId, group]) => {
      const tasks = [...group].sort(byTime((t) => t.lastActivityAt));
      const n = tasks.length;
      const quietest = tasks[0];
      const idle = daysSince(ctx, quietest.lastActivityAt);
      const mine = isMe(ctx, userId);
      const name = personName(ctx, userId);
      return candidate({
        fingerprint: `dd:stalled:assignee:${keyPart(userId)}`,
        kind: "stalled_tasks",
        category: mine ? "my_action" : "delegated",
        title: mine ? `${n} of your tasks have had no activity for 7+ days` : `${name} has ${n} tasks with no activity for 7+ days`,
        whatHappened:
          `${mine ? "You have" : `${name} has`} ${n} open tasks with no recorded activity in over 7 days. ` +
          `The quietest, "${quietest.title}", was last touched ${day(ctx, quietest.lastActivityAt)} (${ago(idle)}).`,
        whyItMatters: "Work that goes quiet for a week often needs a decision, an answer or a new owner before it moves again.",
        recommendedNext: mine
          ? "Decide which of these to move forward, hand off or close."
          : `Ask ${name} whether these are still on track, or decide whether to reassign or close them.`,
        facts: [
          fact(`${n} tasks idle for 7+ days; the quietest for ${span(idle)}.`, "derived"),
          ...taskFacts(tasks, (t) => `"${t.title}": last activity ${day(ctx, t.lastActivityAt)}, ${statusText(t.status)}.`)
        ],
        refs: tasks.map((t) => ddTaskRef(t)),
        factors: { count: n, taskPriority: topPriority(tasks), clientFacing: tasks.some(hasClient), aboutPrincipal: mine },
        state: { count: n, oldestDays: idle, ids: tasks.map((t) => t.id), status: statusSet(tasks) },
        occurredAt: quietest.lastActivityAt
      });
    });
}

// ---------------------------------------------------------------------------
// pending_approval
// ---------------------------------------------------------------------------

interface ApprovalCopy {
  /** Singular and plural nouns for the waiting items. */
  one: string;
  many: string;
  title: (n: number) => string;
  /** The opening of whatHappened. */
  what: (n: number) => string;
  why: string;
  next: string;
  /** Where in DD the queue is worked. Built per run: the origin comes from the environment. */
  pages: () => SourceRef[];
  /** Check-ins are messages that go out as him. */
  aboutPrincipal?: boolean;
}

const isAre = (n: number) => (n === 1 ? "is" : "are");
const hasHave = (n: number) => (n === 1 ? "has" : "have");

// The pages are the ones that handle each queue (src/app/(main)): the
// Approvals tabs (approvals/page.tsx), the board's status filter
// (tasks/(views)/board/page.tsx) and the EOD history (eod/history). Check-ins
// are sent from the daily brief in Slack; no DD page shows them.
const APPROVALS: Readonly<Record<ApprovalMechanism, ApprovalCopy>> = {
  draft_tasks: {
    one: "AI-drafted task",
    many: "AI-drafted tasks",
    title: (n) => `${pluralize(n, "AI-drafted task")} waiting for approval`,
    what: (n) => `${pluralize(n, "AI-drafted task")} from email intake or meetings ${isAre(n)} waiting for approval.`,
    why: "Drafted tasks don't reach anyone's queue until someone approves them.",
    next: "Review them on the Approvals page (Routing and Meetings tabs), or ask a department head to.",
    pages: () => [ddPageRef("/approvals?tab=routing", "Approvals: Routing"), ddPageRef("/approvals?tab=meetings", "Approvals: Meetings")]
  },
  fb_proofs: {
    one: "Facebook proof",
    many: "Facebook proofs",
    title: (n) => `${pluralize(n, "Facebook proof")} waiting for review`,
    what: (n) => `${pluralize(n, "Facebook task")} ${isAre(n)} waiting for ${n === 1 ? "its" : "their"} proof to be reviewed.`,
    why: "The Facebook work isn't marked done until its proof is approved.",
    next: "Review the proofs on the task board, or ask the Facebook department head to.",
    pages: () => [ddPageRef("/tasks/board?status=pending_approval&groupBy=status", "Task board: waiting for approval")]
  },
  email_drafts: {
    one: "email draft",
    many: "email drafts",
    title: (n) => `${pluralize(n, "email draft")} waiting for approval`,
    what: (n) => `${pluralize(n, "email draft")} ${isAre(n)} waiting for approval.`,
    why: "These client emails aren't sent until someone approves them.",
    next: "Review them on the Approvals page, or ask an approver to.",
    pages: () => [ddPageRef("/approvals?tab=emails", "Approvals: Emails")]
  },
  unrouted_mail: {
    one: "intake email",
    many: "intake emails",
    title: (n) => `${pluralize(n, "intake email")} ${n === 1 ? "needs" : "need"} routing`,
    what: (n) =>
      `${pluralize(n, "intake email")} couldn't be routed automatically and ${isAre(n)} waiting for someone to route ${n === 1 ? "it" : "them"}.`,
    why: "These emails haven't become tasks yet, and some may be client requests nobody has picked up.",
    next: "Route them on the Approvals page, or clear the ones that aren't work.",
    pages: () => [ddPageRef("/approvals?tab=routing", "Approvals: Routing")]
  },
  eod_reviews: {
    one: "EOD report",
    many: "EOD reports",
    title: (n) => `${pluralize(n, "EOD report")} waiting for review`,
    what: (n) => `${pluralize(n, "EOD report")} from the last 7 days ${hasHave(n)} been submitted but not marked reviewed.`,
    why: "Unreviewed EOD reports can hide blockers people raised.",
    next: "Mark them reviewed in EOD history, or ask department heads to.",
    pages: () => [ddPageRef("/eod/history", "EOD history")]
  },
  checkins: {
    one: "check-in",
    many: "check-ins",
    title: (n) => `${pluralize(n, "check-in")} from today's brief not sent yet`,
    what: (n) => `${pluralize(n, "check-in message")} on today's daily brief ${hasHave(n)}n't been sent. They're sent from the brief in Slack.`,
    why: "Check-ins go out as you, and only when someone clicks Send.",
    next: "Send or rewrite them from today's daily brief in Slack.",
    pages: () => [],
    aboutPrincipal: true
  }
};

/**
 * Tasks waiting for their proof review that are past their due date, most
 * overdue first. overdue_tasks leaves them out (isOverdueWork), so the proof
 * queue's item carries them: what they wait on is the review.
 */
function pastDueProofs(ctx: Ctx, openTasks: readonly DdTask[]): DdTask[] {
  return openTasks.filter((t) => t.status === "pending_approval" && isOverdue(t, ctx.now)).sort(byTime((t) => t.dueDate));
}

function approvalCandidates(ctx: Ctx, buckets: readonly ApprovalBucket[], openTasks: readonly DdTask[]): AttentionCandidate[] {
  return buckets
    .filter((b) => b.count > 0 && Object.hasOwn(APPROVALS, b.mechanism))
    .map((b) => {
      const copy = APPROVALS[b.mechanism];
      const waited = daysSince(ctx, b.oldestAt);
      const oldest = waited === null ? "" : ` The oldest has waited ${span(waited)} (since ${day(ctx, b.oldestAt)}).`;
      const facts = [fact(`${pluralize(b.count, copy.one, copy.many)} pending.`, "record")];
      if (waited !== null) facts.push(fact(`Oldest waiting ${span(waited)} (since ${day(ctx, b.oldestAt)}).`, "derived"));
      const pastDue = b.mechanism === "fb_proofs" ? pastDueProofs(ctx, openTasks) : [];
      const late = pastDue.length > 0 ? overdueDays(pastDue[0], ctx.now) : 0;
      if (pastDue.length > 0) {
        facts.push(
          fact(
            pastDue.length === 1
              ? `1 waiting proof is for a task past its due date, by ${span(late)}.`
              : `${pastDue.length} waiting proofs are for tasks past their due dates; the most overdue by ${span(late)}.`,
            "derived"
          )
        );
      }
      return candidate({
        fingerprint: `dd:approval:${b.mechanism}`,
        kind: "pending_approval",
        category: "approval",
        title: copy.title(b.count),
        whatHappened: `${copy.what(b.count)}${oldest}`,
        whyItMatters: copy.why,
        recommendedNext: copy.next,
        facts,
        refs: copy.pages(),
        factors: {
          ageDays: waited ?? undefined,
          count: b.count,
          aboutPrincipal: copy.aboutPrincipal === true,
          // Past-due work held by the review scores as it would on its owner's overdue item.
          ...(pastDue.length > 0 ? { overdueDays: late, taskPriority: topPriority(pastDue), clientFacing: pastDue.some(hasClient) } : {})
        },
        // A proof passing its task's due date while it waits is a change worth seeing again.
        state: { count: b.count, oldestDays: waited, ids: pastDue.map((t) => t.id), status: "pending" },
        occurredAt: b.oldestAt
      });
    });
}

// ---------------------------------------------------------------------------
// waiting_on_client
// ---------------------------------------------------------------------------

interface Wait {
  task: DdTask;
  /** When it entered waiting_on_client, or its last activity when no status change was logged. */
  since: string;
  /** No logged status change: the wait is at least `days`. */
  lowerBound: boolean;
  days: number;
}

function waitLine(ctx: Ctx, w: Wait): string {
  return w.lowerBound
    ? `"${w.task.title}": waiting at least ${span(w.days)} (no status change logged; last activity ${day(ctx, w.since)}).`
    : `"${w.task.title}": waiting ${span(w.days)} (since ${day(ctx, w.since)}).`;
}

/** "Sam Lee", "Sam Lee and Ana Ruiz", "Sam Lee, Ana Ruiz and others"; null when nobody else is assigned. */
function assigneeNames(ctx: Ctx, tasks: readonly DdTask[]): string | null {
  const others = unique(tasks.map((t) => t.assigneeId)).filter((id) => !isMe(ctx, id));
  if (others.length === 0) return null;
  const names = others.slice(0, 2).map((id) => personName(ctx, id));
  if (others.length > 2) return `${names.join(", ")} and others`;
  return names.join(" and ");
}

function waitingCandidates(
  ctx: Ctx,
  openTasks: readonly DdTask[],
  enteredAt: ReadonlyMap<string, string>,
  clientIdByName: ReadonlyMap<string, string>
): AttentionCandidate[] {
  const waits: Wait[] = [];
  for (const task of openTasks) {
    if (task.status !== "waiting_on_client") continue;
    const entered = enteredAt.get(task.id);
    const since = entered ?? task.lastActivityAt;
    const waitedMs = ctx.nowMs - ms(since);
    if (!(waitedMs > WAITING_AFTER_DAYS * DAY_MS)) continue;
    waits.push({ task, since, lowerBound: entered === undefined, days: Math.floor(waitedMs / DAY_MS) });
  }
  // "" groups the tasks with no client: a trimmed client name is never empty.
  return groupBy(waits, (w) => w.task.clientName?.trim() ?? "").map(([key, group]) => {
    const client = key === "" ? null : key;
    const list = [...group].sort((a, b) => b.days - a.days || (a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0));
    const tasks = list.map((w) => w.task);
    const n = list.length;
    const longest = list[0];
    const atLeast = longest.lowerBound ? "at least " : "";
    const owners = assigneeNames(ctx, tasks);
    const mineOnly = owners === null && tasks.some((t) => isMe(ctx, t.assigneeId));
    const whom = client ?? "the client";

    const whatHappened =
      n === 1
        ? `"${longest.task.title}" has been waiting on ${whom} for ${atLeast}${span(longest.days)}. ` +
          (longest.task.assigneeId
            ? `It's assigned to ${isMe(ctx, longest.task.assigneeId) ? "you" : personName(ctx, longest.task.assigneeId)}.`
            : "It has no assignee.")
        : `${n} open tasks ${client ? `for ${client}` : "with no client set"} have been waiting on the client for more than ` +
          `${WAITING_AFTER_DAYS} days, the longest for ${atLeast}${span(longest.days)}.` +
          (list.some((w) => w.lowerBound)
            ? " Where no status change was logged, the wait is counted from the task's last activity, so it's at least that long."
            : "");
    const recommendedNext = owners
      ? `Ask ${owners} to follow up with ${whom}, or decide whether to pause the work.`
      : mineOnly
        ? `Follow up with ${whom}, or decide whether to pause the work.`
        : `Decide who should follow up with ${whom}.`;
    const clientId = client === null ? undefined : clientIdByName.get(client);
    const clientRefs = clientId === undefined ? [] : [ddClientRef({ id: clientId, name: client })];

    return candidate({
      fingerprint: `dd:waiting:client:${client === null ? NO_CLIENT_KEY : keyPart(client)}`,
      kind: "waiting_on_client",
      category: "delegated",
      title:
        n === 1
          ? `Waiting on ${whom} for ${atLeast}${span(longest.days)}: ${longest.task.title}`
          : `${n} tasks waiting on ${client ?? "a client"} for over a week`,
      whatHappened,
      whyItMatters: "Work parked on a client this long usually needs a nudge, and the wait can push out delivery dates.",
      recommendedNext,
      facts: [
        ...(n > 1
          ? [fact(`${n} tasks waiting more than ${WAITING_AFTER_DAYS} days; the longest ${atLeast}${span(longest.days)}.`, "derived")]
          : []),
        ...list.slice(0, TASK_FACTS).map((w) => fact(waitLine(ctx, w), "derived", [ddTaskRef(w.task)]))
      ],
      refs: [...clientRefs, ...tasks.map((t) => ddTaskRef(t))],
      factors: { ageDays: longest.days, count: n, taskPriority: topPriority(tasks), clientFacing: client !== null },
      state: { count: n, oldestDays: longest.days, ids: tasks.map((t) => t.id), status: "waiting_on_client" },
      occurredAt: longest.since
    });
  });
}

// ---------------------------------------------------------------------------
// open_incident
// ---------------------------------------------------------------------------

function incidentCandidates(ctx: Ctx, openTasks: readonly DdTask[]): AttentionCandidate[] {
  return openTasks
    .filter(isIncident)
    .sort(byTime((t) => t.createdAt))
    .map((t) => {
      // The incident route titles its task "[Incident] {type} — {url}".
      const name = t.title.replace(/^\s*\[incident\]\s*/i, "") || t.title;
      const opened = daysSince(ctx, t.createdAt);
      const mine = isMe(ctx, t.assigneeId);
      const assignee = t.assigneeId === null ? null : mine ? "you" : personName(ctx, t.assigneeId);
      const facts = [
        fact(`Opened ${moment(ctx, t.createdAt)}.`, "record", [ddTaskRef(t)]),
        fact(`Status: ${statusText(t.status)}; priority: ${t.priority}.`, "record"),
        fact(assignee === null ? "No assignee." : `Assigned to ${assignee}.`, "record")
      ];
      if (isAutoArchived(t)) facts.push(fact("DD's overdue sweep archived it, but it isn't done.", "derived"));
      return candidate({
        fingerprint: `dd:incident:task:${keyPart(t.id)}`,
        kind: "open_incident",
        category: "intervene",
        title: `Open incident: ${name}`,
        whatHappened:
          `An incident task was opened ${day(ctx, t.createdAt)} (${ago(opened)}) and is still ${statusText(t.status)}. ` +
          (assignee === null ? "It has no assignee." : `It's assigned to ${assignee}.`),
        whyItMatters: "An incident is a reported problem with a site or service, and until its task is closed the problem may still be live.",
        recommendedNext: mine
          ? "Update the task with where the fix stands, or hand it off."
          : t.assigneeId !== null
            ? `Check with ${personName(ctx, t.assigneeId)} on the fix, or reassign it if it's stuck.`
            : "Assign someone to handle it.",
        facts,
        refs: [ddTaskRef(t)],
        // Incident tasks are due the moment they're opened, so overdue days
        // here are days open.
        factors: { overdueDays: overdueDays(t, ctx.now), taskPriority: t.priority, clientFacing: hasClient(t), aboutPrincipal: mine },
        state: { count: 1, oldestDays: opened, ids: [t.id], status: t.status },
        occurredAt: t.createdAt
      });
    });
}

// ---------------------------------------------------------------------------
// site_alert
// ---------------------------------------------------------------------------

// The same site key as recurringSiteAlerts in analysis/recurring.ts: the
// stored domain, else the website's host, lowercased, without scheme, "www.",
// path, port or trailing dot. A site alerting now and the same site's
// recurring pattern then name the same host.
function hostOf(value: string | null): string {
  if (!value) return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/#.*$/, "")
    .replace(/\?.*$/, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "")
    .split("/")[0]
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

function siteKey(alert: Pick<DdSiteHealthAlert, "domain" | "website">): string {
  return hostOf(alert.domain) || hostOf(alert.website);
}

function alertTaskRef(alert: DdSiteHealthAlert, openById: ReadonlyMap<string, DdTask>): SourceRef[] {
  if (alert.taskId === null) return [];
  return [ddTaskRef({ id: alert.taskId, title: openById.get(alert.taskId)?.title ?? null })];
}

function siteCandidates(ctx: Ctx, alerts: readonly DdSiteHealthAlert[], openById: ReadonlyMap<string, DdTask>): AttentionCandidate[] {
  const cutoff = ctx.nowMs - SITE_ALERT_WINDOW_HOURS * HOUR_MS;
  const recent = alerts.filter((a) => ms(a.createdAt) >= cutoff);
  return groupBy(recent, (a) => siteKey(a) || null).map(([site, group]) => {
    const list = newestFirst(group, (a) => a.createdAt);
    const n = list.length;
    const latest = list[0];
    const fyi = latest.score > SITE_FYI_ABOVE;
    const task = latest.taskId === null ? undefined : openById.get(latest.taskId);
    const assigneeId = task?.assigneeId ?? null;

    let taskSentence: string;
    let recommendedNext: string;
    if (task) {
      const owner = assigneeId === null ? "" : ` and assigned to ${isMe(ctx, assigneeId) ? "you" : personName(ctx, assigneeId)}`;
      taskSentence = `Its investigation task is open${owner}.`;
      recommendedNext =
        assigneeId === null
          ? "Assign the investigation task to someone."
          : isMe(ctx, assigneeId)
            ? "Work the investigation task, or hand it off."
            : `Make sure ${personName(ctx, assigneeId)} has what they need to fix it.`;
    } else if (latest.taskId !== null) {
      taskSentence = "Its investigation task is no longer open.";
      recommendedNext = "Check that the next scan confirms the fix.";
    } else {
      taskSentence =
        latest.skippedReason === "no-assignee"
          ? "No task was opened because there was no one to assign it to."
          : "No investigation task is linked to it.";
      recommendedNext = "Assign someone to investigate the site.";
    }

    return candidate({
      fingerprint: `dd:site:${keyPart(site)}`,
      kind: "site_alert",
      category: fyi ? "fyi" : "intervene",
      title: `Low site score: ${site} (${latest.score})`,
      whatHappened:
        `${site} scored ${latest.score} against a threshold of ${latest.threshold} on ${moment(ctx, latest.createdAt)}.` +
        (n > 1 ? ` That's ${n} low-score alerts in the last ${SITE_ALERT_WINDOW_HOURS} hours.` : "") +
        ` ${taskSentence}`,
      whyItMatters: fyi
        ? `The latest score is above ${SITE_FYI_ABOVE}, so it's less urgent, but the site is still below its alert threshold.`
        : "A low site score can mean slow pages, errors or broken elements that visitors notice.",
      recommendedNext,
      facts: list.slice(0, EVENT_FACTS).map((a) =>
        fact(
          `Scored ${a.score} (threshold ${a.threshold}) on ${moment(ctx, a.createdAt)}` +
            (a.taskId === null && a.skippedReason === "no-assignee" ? "; no task opened (no one to assign)." : "."),
          "record",
          alertTaskRef(a, openById)
        )
      ),
      refs: list.flatMap((a) => alertTaskRef(a, openById)),
      factors: { count: n, severity: latest.priority ?? undefined },
      state: { count: n, oldestDays: daysSince(ctx, list[n - 1].createdAt), ids: list.map((a) => a.id), status: fyi ? "fyi" : "intervene" },
      occurredAt: latest.createdAt
    });
  });
}

// ---------------------------------------------------------------------------
// unanswered_mention
// ---------------------------------------------------------------------------

/**
 * When he last did anything on each of these tasks (any activity_logs action
 * or task_messages row), from the earliest notification on. A notification is
 * answered once he has acted on its task after it arrived. Only logged
 * actions count: an edit through the task form (title, description,
 * priority, due date) writes no row, so the items say "no comment, status
 * change or other action", never "not updated".
 */
async function latestResponses(
  principal: ExecPrincipal,
  notes: readonly DdTaskNotification[],
  read: DdReadOptions
): Promise<Map<string, number>> {
  const latest = new Map<string, number>();
  let earliest = Number.POSITIVE_INFINITY;
  // An unreadable timestamp (NaN) never wins the comparison, so it can't hide the others.
  for (const n of notes) {
    const at = ms(n.createdAt);
    if (at < earliest) earliest = at;
  }
  if (!Number.isFinite(earliest)) return latest;
  const since = new Date(earliest).toISOString();
  const filter = { taskIds: unique(notes.map((n) => n.taskId)), userId: principal.userId };
  const [activity, messages] = await Promise.all([
    listActivitySince(principal, since, filter, read),
    listTaskMessagesSince(principal, since, filter, read)
  ]);
  for (const row of [...activity, ...messages]) {
    const at = ms(row.createdAt);
    if (!Number.isFinite(at)) continue;
    const seen = latest.get(row.taskId);
    if (seen === undefined || at > seen) latest.set(row.taskId, at);
  }
  return latest;
}

function noteVerb(kind: DdTaskNotification["kind"]): string {
  return kind === "mention" ? "mentioned you" : "notified you";
}

// What latestResponses can see, and no more.
const NO_RESPONSE = "DD shows no comment, status change or other action from you on the task since.";

function mentionCandidates(
  ctx: Ctx,
  notes: readonly DdTaskNotification[],
  responses: ReadonlyMap<string, number>,
  tasksById: ReadonlyMap<string, DdTask>
): AttentionCandidate[] {
  const unanswered = notes.filter((n) => {
    const answeredAt = responses.get(n.taskId);
    return answeredAt === undefined || !(answeredAt > ms(n.createdAt));
  });
  const out: AttentionCandidate[] = [];
  for (const [taskId, group] of groupBy(unanswered, (n) => n.taskId)) {
    const task = tasksById.get(taskId);
    // A deleted task's thread is gone; a missing one was deleted since the read.
    if (!task || task.deletedAt !== null) continue;
    const list = [...group].sort(byTime((n) => n.createdAt));
    const n = list.length;
    const oldest = list[0];
    const newest = list[n - 1];
    const waited = daysSince(ctx, oldest.createdAt);
    const actor = newest.actorId === null ? null : personName(ctx, newest.actorId);
    const on = newest.kind === "mention" ? "on" : "about";

    out.push(
      candidate({
        fingerprint: ddMentionFingerprint(task.id),
        kind: "unanswered_mention",
        category: "my_action",
        title:
          n > 1
            ? `${n} unanswered mentions on "${task.title}"`
            : actor
              ? `${actor} ${noteVerb(newest.kind)} ${on} "${task.title}"`
              : `You were ${newest.kind === "mention" ? "mentioned" : "notified"} ${on} "${task.title}"`,
        whatHappened:
          n > 1
            ? `You were mentioned or notified ${n} times on this task since ${day(ctx, oldest.createdAt)}, most recently ` +
              `${actor ? `by ${actor} ` : ""}${ago(daysSince(ctx, newest.createdAt))}. ${NO_RESPONSE}`
            : `${actor ?? "Someone"} ${noteVerb(newest.kind)} ${ago(waited)} (${moment(ctx, newest.createdAt)}). ${NO_RESPONSE}`,
        whyItMatters: "People usually mention you when they need your input or a decision.",
        recommendedNext: actor
          ? `Reply on the task, or tell ${actor} who should handle it.`
          : "Reply on the task, or point it to whoever should handle it.",
        facts: [
          fact(`No comment, status change or other logged action from you on this task since ${moment(ctx, oldest.createdAt)}.`, "derived"),
          ...newestFirst(list, (x) => x.createdAt)
            .slice(0, EVENT_FACTS)
            .map((x) =>
              fact(
                x.actorId === null
                  ? `${x.kind === "mention" ? "Mentioned" : "Notified"} ${moment(ctx, x.createdAt)} (no sender recorded).`
                  : `${personName(ctx, x.actorId)} ${noteVerb(x.kind)} ${moment(ctx, x.createdAt)}.`,
                "record",
                [ddTaskRef(task)]
              )
            )
        ],
        refs: [ddTaskRef(task)],
        factors: {
          ageDays: waited ?? undefined,
          count: n,
          taskPriority: task.priority,
          clientFacing: hasClient(task),
          aboutPrincipal: true
        },
        state: { count: n, oldestDays: waited, ids: list.map((x) => x.id), status: task.status },
        occurredAt: oldest.createdAt
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// recurring_issue
// ---------------------------------------------------------------------------

/**
 * A recurring pattern's state is the rows its rule matched on, and only
 * those: rows outside the rule's window can come and go (an old one aging out
 * of the 90-day read) while the pattern stands still.
 */
function recurringState(ctx: Ctx, rows: { count: number; firstAt: string | null; ids: readonly string[] }, status: string): ItemState {
  return { count: rows.count, oldestDays: daysSince(ctx, rows.firstAt), ids: rows.ids, status };
}

function incidentRecurrence(ctx: Ctx, g: RecurringGroup, logsById: ReadonlyMap<string, DdIncidentLog>): AttentionCandidate {
  const page = ddPageRef("/updates/incidents", "Incident log");
  const logs = newestFirst(
    g.ids.map((id) => logsById.get(id)).filter((log): log is DdIncidentLog => log !== undefined),
    (log) => log.createdAt
  );
  return candidate({
    fingerprint: `dd:recurring:incident:${keyPart(g.key)}`,
    kind: "recurring_issue",
    category: "intervene",
    title: `Recurring incident: ${g.label}`,
    whatHappened: `${pluralize(g.count30, "report")} in the last 30 days (${g.count90} in 90), the latest on ${day(ctx, g.lastAt)}.`,
    whyItMatters: "When the same problem keeps coming back, the underlying cause usually hasn't been fixed.",
    recommendedNext: "Ask whoever looks after this site for a root-cause fix rather than another one-off repair.",
    facts: [
      fact(`${g.count30} in the last 30 days, ${g.count90} in the last 90.`, "derived"),
      ...logs.slice(0, EVENT_FACTS).map((log) => fact(`Reported ${moment(ctx, log.createdAt)}.`, "record", [page]))
    ],
    refs: [page],
    factors: { count: g.count90 },
    state: recurringState(ctx, recurringBasis(g), "recurring"),
    occurredAt: g.lastAt
  });
}

function siteRecurrence(
  ctx: Ctx,
  g: RecurringGroup,
  alertsById: ReadonlyMap<string, DdSiteHealthAlert>,
  openById: ReadonlyMap<string, DdTask>
): AttentionCandidate {
  const alerts = newestFirst(
    g.ids.map((id) => alertsById.get(id)).filter((a): a is DdSiteHealthAlert => a !== undefined),
    (a) => a.createdAt
  );
  return candidate({
    fingerprint: `dd:recurring:site:${keyPart(g.key)}`,
    kind: "recurring_issue",
    category: "intervene",
    title: `Recurring low site scores: ${g.label}`,
    whatHappened:
      `${g.label} had ${pluralize(g.count30, "low-score alert")} in the last 30 days (${g.count90} in 90), ` +
      `the latest on ${day(ctx, g.lastAt)}.`,
    whyItMatters: "Each alert opens its own task, so a site that keeps dropping can look like several small fixes instead of one problem.",
    recommendedNext: "Ask the website team to look for one root cause across these alerts.",
    facts: [
      fact(`${g.count30} alerts in the last 30 days, ${g.count90} in the last 90.`, "derived"),
      ...alerts.slice(0, EVENT_FACTS).map((a) => fact(`Scored ${a.score} on ${moment(ctx, a.createdAt)}.`, "record", alertTaskRef(a, openById)))
    ],
    refs: alerts.flatMap((a) => alertTaskRef(a, openById)),
    factors: { count: g.count90 },
    state: recurringState(ctx, recurringBasis(g), "recurring"),
    occurredAt: g.lastAt
  });
}

/** "moved from Oct 21 to Oct 28 on Oct 20", or "set to Oct 28 on Oct 20" when the task had no due date. */
function extensionChange(ctx: Ctx, e: DdTaskExtension): string {
  return e.previousDueDate === null
    ? `set to ${day(ctx, e.newDueDate)} on ${day(ctx, e.createdAt)}`
    : `moved from ${day(ctx, e.previousDueDate)} to ${day(ctx, e.newDueDate)} on ${day(ctx, e.createdAt)}`;
}

function taskExtensionRecurrence(
  ctx: Ctx,
  g: RecurringGroup,
  task: DdTask,
  extensions: readonly DdTaskExtension[]
): AttentionCandidate {
  const mine = isMe(ctx, task.assigneeId);
  return candidate({
    fingerprint: `dd:recurring:task-extensions:${keyPart(g.key)}`,
    kind: "recurring_issue",
    category: "intervene",
    title: `Due date pushed ${g.count90} times: ${task.title}`,
    whatHappened:
      `The due date of "${task.title}" was extended ${g.count90} times in the last 90 days, most recently on ${day(ctx, g.lastAt)}. ` +
      (task.assigneeId === null ? "It has no assignee." : `It's assigned to ${mine ? "you" : personName(ctx, task.assigneeId)}.`),
    whyItMatters: "Repeated extensions can mean the scope or the estimate needs a fresh look.",
    recommendedNext: mine
      ? "Settle on a date that will hold, or rescope the task."
      : task.assigneeId !== null
        ? `Ask ${personName(ctx, task.assigneeId)} what has changed, and agree on a date that will hold.`
        : "Pick an owner, and agree on a date that will hold.",
    facts: newestFirst(extensions, (e) => e.createdAt)
      .slice(0, EVENT_FACTS)
      .map((e) => {
        const by = isMe(ctx, e.userId) ? "you" : personName(ctx, e.userId);
        return fact(`Due date ${extensionChange(ctx, e)} by ${by}.`, "record", [ddTaskRef(task)]);
      }),
    refs: [ddTaskRef(task)],
    factors: { count: g.count90, taskPriority: task.priority, clientFacing: hasClient(task), aboutPrincipal: mine },
    // Two in 90 days is the rule here, so the 90 days are the pattern.
    state: recurringState(ctx, { count: g.count90, firstAt: g.firstAt, ids: g.ids }, task.status),
    occurredAt: g.lastAt
  });
}

function personExtensionRecurrence(
  ctx: Ctx,
  g: RecurringGroup,
  extensions: readonly DdTaskExtension[],
  tasksById: ReadonlyMap<string, DdTask>
): AttentionCandidate {
  const mine = isMe(ctx, g.key);
  const who = mine ? "You" : personName(ctx, g.key);
  const refFor = (taskId: string): SourceRef[] => {
    const task = tasksById.get(taskId);
    return task && task.deletedAt === null ? [ddTaskRef(task)] : [];
  };
  const recent = newestFirst(extensions, (e) => e.createdAt);
  return candidate({
    fingerprint: `dd:recurring:user-extensions:${keyPart(g.key)}`,
    kind: "recurring_issue",
    category: "intervene",
    title: `${who} extended ${g.count30} due dates in the last 30 days`,
    whatHappened: `${who} filed ${g.count30} due-date extensions in the last 30 days (${g.count90} in 90), the latest on ${day(ctx, g.lastAt)}.`,
    whyItMatters: "Frequent extensions can mean deadlines are set too tight or the workload is too high.",
    recommendedNext: mine
      ? "Look at whether your deadlines or your workload need adjusting."
      : `Check in with ${personName(ctx, g.key)} on workload and how deadlines are being set.`,
    facts: recent.slice(0, EVENT_FACTS).map((e) => {
      const title = tasksById.get(e.taskId)?.title;
      return fact(`${title === undefined ? "A task" : `"${title}"`}: due date ${extensionChange(ctx, e)}.`, "record", refFor(e.taskId));
    }),
    refs: recent.flatMap((e) => refFor(e.taskId)),
    factors: { count: g.count30, aboutPrincipal: mine },
    // Three in the last 30 days is the only rule for a person, so those rows are the pattern.
    state: recurringState(ctx, { count: g.count30, firstAt: g.firstAt30, ids: g.ids30 }, "recurring"),
    occurredAt: g.lastAt
  });
}

function recurringCandidates(
  ctx: Ctx,
  incidentLogs: readonly DdIncidentLog[],
  alerts: readonly DdSiteHealthAlert[],
  extensions: readonly DdTaskExtension[],
  repeats: ExtensionRepeats,
  tasksById: ReadonlyMap<string, DdTask>,
  openById: ReadonlyMap<string, DdTask>
): AttentionCandidate[] {
  const logsById = new Map(incidentLogs.map((log) => [log.id, log]));
  const alertsById = new Map(alerts.map((a) => [a.id, a]));
  const extensionsById = new Map(extensions.map((e) => [e.id, e]));
  const rowsOf = (g: RecurringGroup) => g.ids.map((id) => extensionsById.get(id)).filter((e): e is DdTaskExtension => e !== undefined);

  const out: AttentionCandidate[] = [
    ...recurringIncidents(incidentLogs, ctx.now).map((g) => incidentRecurrence(ctx, g, logsById)),
    ...recurringSiteAlerts(alerts, ctx.now).map((g) => siteRecurrence(ctx, g, alertsById, openById))
  ];
  for (const g of repeats.byTask) {
    // A task that's finished, shelved or deleted has nothing left to fix; the
    // person-level pattern below still counts its extensions.
    const task = tasksById.get(g.key);
    if (task && isOpen(task)) out.push(taskExtensionRecurrence(ctx, g, task, rowsOf(g)));
  }
  for (const g of repeats.byAssignee) out.push(personExtensionRecurrence(ctx, g, rowsOf(g), tasksById));
  return out;
}

// ---------------------------------------------------------------------------
// The producer
// ---------------------------------------------------------------------------

/**
 * Every DD Needs Attention candidate for `principal` at `now`, in
 * DD_ATTENTION_KINDS order. Throws when any read fails (never a partial list)
 * and a TypeError for an invalid `now`.
 *
 * The reads run in rounds so one refresh holds only a handful of database
 * requests at a time (getPendingApprovals alone runs about a dozen); the
 * scheduler runs this every 10 minutes beside the live app.
 */
export async function produceDdAttention(
  principal: ExecPrincipal,
  now: Date,
  opts: { signal?: AbortSignal } = {}
): Promise<AttentionCandidate[]> {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("produceDdAttention: now must be a valid Date");
  const read: DdReadOptions = { signal: opts.signal };
  const nowMs = now.getTime();
  const daysBack = (days: number) => new Date(nowMs - days * DAY_MS).toISOString();

  const [openTasks, users, departments, clients] = await Promise.all([
    listOpenTasks(principal, read),
    listUsers(principal, read),
    listDepartments(principal, read),
    listClients(principal, read)
  ]);
  opts.signal?.throwIfAborted();
  const approvals = await getPendingApprovals(principal, now, read);
  opts.signal?.throwIfAborted();
  const [completed, notifications, extensions, incidentLogs, alerts] = await Promise.all([
    listTasksCompletedBetween(principal, daysBack(LATE_WINDOW_DAYS), now.toISOString(), read),
    listTaskNotificationsForUser(principal, principal.userId, daysBack(MENTION_WINDOW_DAYS), ["mention", "notified"], read),
    listTaskExtensionsSince(principal, daysBack(RECURRING_WINDOW_DAYS), read),
    listIncidentLogsSince(principal, daysBack(RECURRING_WINDOW_DAYS), read),
    listSiteHealthAlertsSince(principal, daysBack(RECURRING_WINDOW_DAYS), read)
  ]);
  opts.signal?.throwIfAborted();

  // He can't owe himself an answer: a notification he sent himself doesn't count.
  const notes = notifications.filter((n) => n.actorId !== principal.userId);
  const waitingIds = openTasks.filter((t) => t.status === "waiting_on_client").map((t) => t.id);
  const late = lateCompletions(completed);
  // A task's activity can't predate the task, so its proof actions are all
  // after the oldest late one's creation.
  const proofSince = earliestOf(late.map((t) => t.createdAt)) ?? daysBack(RECURRING_WINDOW_DAYS);
  const repeats = repeatedExtensions(extensions, now);
  const extensionTask = new Map(extensions.map((e) => [e.id, e.taskId]));
  // Titles and state for tasks outside the open list: mentioned tasks, and
  // tasks in a repeated-extension group, can be in any state.
  const referencedIds = unique([
    ...notes.map((n) => n.taskId),
    ...repeats.byTask.map((g) => g.key),
    ...repeats.byAssignee.flatMap((g) => g.ids.map((id) => extensionTask.get(id)))
  ]);
  const [entries, referenced, responses, proofEvents] = await Promise.all([
    waitingIds.length > 0 ? listStatusChangeEntries(principal, waitingIds, "waiting_on_client", read) : Promise.resolve([]),
    referencedIds.length > 0 ? listTasksByIds(principal, referencedIds, read) : Promise.resolve([]),
    latestResponses(principal, notes, read),
    // When each late one was handed in, if it went through a proof review:
    // its proof actions, read as action and time only.
    late.length > 0
      ? listActivitySince(principal, proofSince, { taskIds: late.map((t) => t.id), actions: PROOF_ACTIONS }, read)
      : Promise.resolve([])
  ]);

  const ctx: Ctx = {
    principal,
    now,
    nowMs,
    users: new Map(users.map((u) => [u.id, u])),
    departments: new Map(departments.map((d) => [d.id, d]))
  };
  const openById = new Map(openTasks.map((t) => [t.id, t]));
  const tasksById = new Map(referenced.map((t) => [t.id, t]));
  const enteredAt = new Map(entries.map((e) => [e.taskId, e.enteredAt]));
  // tasks.client_name is free text equal to clients.name (no FK), compared trimmed.
  const clientIdByName = new Map(clients.map((c) => [c.name.trim(), c.id]));

  return [
    ...overdueCandidates(ctx, openTasks),
    ...lateCandidates(ctx, late, proofEvents),
    ...stalledCandidates(ctx, openTasks),
    ...approvalCandidates(ctx, approvals, openTasks),
    ...waitingCandidates(ctx, openTasks, enteredAt, clientIdByName),
    ...incidentCandidates(ctx, openTasks),
    ...siteCandidates(ctx, alerts, openById),
    ...mentionCandidates(ctx, notes, responses, tasksById),
    ...recurringCandidates(ctx, incidentLogs, alerts, extensions, repeats, tasksById, openById)
  ];
}
