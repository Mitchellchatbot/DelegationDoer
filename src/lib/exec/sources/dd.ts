import "server-only";

import { addressMatches, type RestrictedSenderRule } from "@/lib/restricted-senders";
import { addDaysToYmd, eodToday } from "@/lib/shift";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { DEFAULT_TIMEZONE, isValidTimeZone } from "@/lib/exec/principal";
import { isExecEnabled } from "@/lib/exec/access";
import { checkinApprovalSource } from "@/lib/exec/brief-ownership-load";
import type {
  ApprovalBucket,
  ApprovalItem,
  ApprovalItemList,
  ApprovalMechanism,
  ClientHealthLabel,
  DdActivity,
  DdClient,
  DdClientMatchSignals,
  DdClientMeeting,
  DdDepartment,
  DdEodNote,
  DdEodSlackAnchor,
  DdIncidentLog,
  DdProject,
  DdProjectStage,
  DdProjectTask,
  DdSatisfactionSignal,
  DdSiteHealthAlert,
  DdStatusEntry,
  DdStatusTransition,
  DdTask,
  DdTaskExtension,
  DdTaskHours,
  DdTaskMessage,
  DdTaskNotification,
  DdTaskThreadLink,
  DdTimeEntry,
  DdUpdateReply,
  DdUser,
  DdUserSchedule,
  ProjectStageStatus,
  TaskNotificationKind,
  TaskPriority,
  TaskStatus,
  TouchpointLabel,
  UserRole
} from "@/lib/exec/sources/dd-types";
import type { ExecPrincipal } from "@/lib/exec/types";

// Company-wide reads of DD's own tables for the assistant (plan §3 "DD data").
//
// The scope comes from the principal, never from his role (plan §2 rule 3).
// Every read takes the ExecPrincipal a trusted path minted, reads through the
// service role and makes no per-task visibility check (no canViewTask). The
// principal is otherwise unused here.
//
// Rules every read follows:
//   - Fail closed. A Supabase error throws DdReadError, naming the table. An
//     empty list or a zero always means "none", never "couldn't read": the
//     page would otherwise tell Mitchell there is no overdue work when the
//     truth is that the read failed.
//   - Bounded. Lists come in pages of 1000, ordered by a unique key, with a
//     ceiling of 50 pages. PostgREST caps a response at 1000 rows, and DD's own
//     fetchAllRows pages with no ORDER BY, so its pages can overlap or leave
//     rows out. Offset pages can still miss a row that changes mid-read; the
//     next refresh picks it up.
//   - Explicit columns only, and no free text exec doesn't use: no task
//     descriptions, comment or message bodies, notes, EOD text, or the
//     plaintext Slack and Google tokens on users. Two reads have to touch
//     text and keep none of it: listStatusChangeEntries parses
//     activity_logs.detail and hands back timestamps, and the check-in count
//     reads daily_briefings.messages (each carries its draft) and hands back
//     a number.
//   - Every query carries opts.signal, so a job's timeout cancels it.

export interface DdReadOptions {
  signal?: AbortSignal;
}

/** A DD read failed. Callers show "couldn't load", never an empty result. */
export class DdReadError extends Error {
  readonly table: string;
  constructor(table: string, message: string) {
    super(`DD read failed (${table}): ${message}`);
    this.name = "DdReadError";
    this.table = table;
  }
}

const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
// Ids per .in() filter: they travel in the query string, and a few hundred
// keeps the URL well clear of proxy limits.
const IN_CHUNK = 200;
// Unreviewed EODs older than a week are history, not a decision waiting on
// anyone. Yesterday's still count: they are reviewed the next morning.
const EOD_REVIEW_WINDOW_DAYS = 7;

// ---------------------------------------------------------------------------
// Query plumbing
// ---------------------------------------------------------------------------

const HEAD_COUNT = { count: "exact", head: true } as const;

// Every read starts here. The table is a plain string, so every builder has
// the same type and a predicate is an ordinary function over it.
function from(table: string, columns: string, options?: typeof HEAD_COUNT) {
  return getSupabaseAdmin().from(table).select(columns, options);
}

type Query = ReturnType<typeof from>;
type Predicate = (query: Query) => Query;

interface PageOptions extends DdReadOptions {
  /** Columns that are unique together. Default ["id"]. */
  orderBy?: readonly string[];
}

/** Every row of a query, page by page, in a stable order. Throws past MAX_PAGES. */
async function pageAll<Row>(table: string, build: () => Query, opts: PageOptions = {}): Promise<Row[]> {
  const orderBy = opts.orderBy ?? ["id"];
  const rows: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let query = build();
    for (const column of orderBy) query = query.order(column, { ascending: true });
    query = query.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (opts.signal) query = query.abortSignal(opts.signal);
    const { data, error } = await query;
    if (error) throw new DdReadError(table, error.message);
    if (!Array.isArray(data)) throw new DdReadError(table, "the response carried no rows");
    for (const row of data) rows.push(row as Row);
    if (data.length < PAGE_SIZE) return rows;
  }
  throw new DdReadError(table, `too many rows (more than ${MAX_PAGES * PAGE_SIZE})`);
}

/** pageAll once per chunk of the (deduplicated) ids. No ids, no query. */
async function pageAllByIds<Row>(
  table: string,
  ids: readonly string[],
  build: (chunk: readonly string[]) => Query,
  opts: PageOptions
): Promise<Row[]> {
  const out: Row[] = [];
  for (const chunk of chunked(uniqueIds(ids))) {
    for (const row of await pageAll<Row>(table, () => build(chunk), opts)) out.push(row);
  }
  return out;
}

/** The whole window, or pageAllByIds when an id filter is given (an empty one matches nothing). */
function pageAllOptionalIds<Row>(
  table: string,
  ids: readonly string[] | undefined,
  build: (chunk: readonly string[] | null) => Query,
  opts: PageOptions
): Promise<Row[]> {
  return ids === undefined ? pageAll<Row>(table, () => build(null), opts) : pageAllByIds<Row>(table, ids, build, opts);
}

async function countRows(table: string, query: Query, signal?: AbortSignal): Promise<number> {
  const { count, error } = await (signal ? query.abortSignal(signal) : query);
  if (error) throw new DdReadError(table, error.message);
  if (typeof count !== "number") throw new DdReadError(table, "the response carried no count");
  return count;
}

/** The smallest value of `column` among the rows `build` selects, or null when there are none. */
async function oldestValue(table: string, column: string, build: () => Query, signal?: AbortSignal): Promise<string | null> {
  let query = build().order(column, { ascending: true }).limit(1);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw new DdReadError(table, error.message);
  if (!Array.isArray(data)) throw new DdReadError(table, "the response carried no rows");
  const first: unknown = data[0];
  const value = typeof first === "object" && first !== null ? (first as Record<string, unknown>)[column] : undefined;
  return typeof value === "string" ? value : null;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
}

function chunked<T>(items: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

// The type already demands a principal. This catches the one way around it
// the boundary test can't see (an `any`), so no read runs without the grant a
// principal stands for.
function requirePrincipal(principal: ExecPrincipal): void {
  if (!principal || typeof principal.id !== "string" || principal.id.length === 0) {
    throw new TypeError("sources/dd: an ExecPrincipal is required");
  }
}

// Timestamps are canonicalised before they reach a filter. One of them lands
// inside an or() expression, where a stray comma or parenthesis would change
// the filter itself.
function isoParam(name: string, value: string): string {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) throw new TypeError(`sources/dd: ${name} must be an ISO timestamp`);
  return new Date(ms).toISOString();
}

/** A half-open [start, end) window. Canonical ISO strings compare correctly as text. */
function windowParams(fromIso: string, toIso: string): { start: string; end: string } {
  const start = isoParam("fromIso", fromIso);
  const end = isoParam("toIso", toIso);
  if (start > end) throw new TypeError("sources/dd: fromIso is after toIso");
  return { start, end };
}

// A calendar date that exists: V8 quietly rolls "2026-02-30" over to March 2,
// so the date has to survive a round trip unchanged.
function ymdParam(name: string, value: string): string {
  const ms = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new TypeError(`sources/dd: ${name} must be a YYYY-MM-DD date`);
  }
  return value;
}

const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const TASK_COLS =
  "id,title,status,priority,tags,department_id,assignee_id,creator_id,project_id,stage_id,client_name," +
  "due_date,created_at,completed_at,last_activity_at,archived_at,archived_by,is_draft,deleted_at,estimated_hours";

interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string[] | null;
  department_id: string | null;
  assignee_id: string | null;
  creator_id: string;
  project_id: string | null;
  stage_id: string | null;
  client_name: string | null;
  due_date: string | null;
  created_at: string;
  completed_at: string | null;
  last_activity_at: string;
  archived_at: string | null;
  archived_by: string | null;
  is_draft: boolean;
  deleted_at: string | null;
  estimated_hours: number | string;
}

function taskFromRow(r: TaskRow): DdTask {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    priority: r.priority,
    tags: Array.isArray(r.tags) ? r.tags : [],
    departmentId: r.department_id ?? null,
    assigneeId: r.assignee_id ?? null,
    creatorId: r.creator_id,
    projectId: r.project_id ?? null,
    stageId: r.stage_id ?? null,
    clientName: r.client_name ?? null,
    dueDate: r.due_date ?? null,
    createdAt: r.created_at,
    completedAt: r.completed_at ?? null,
    lastActivityAt: r.last_activity_at,
    archivedAt: r.archived_at ?? null,
    archivedBy: r.archived_by ?? null,
    isDraft: r.is_draft === true,
    deletedAt: r.deleted_at ?? null,
    estimatedHours: Number(r.estimated_hours)
  };
}

/**
 * THE "open task" predicate on the SQL side. isOpen() in analysis/tasks.ts is
 * its in-memory twin; change them together. Not a draft, not deleted, not done
 * or rejected, and either live or auto-archived. The sweep archives overdue
 * work nobody finished (archived_by NULL), so that stays open; a task a person
 * shelved (archived_by set) is parked, not open (p2b-schema §0.2-3, §6).
 */
const whereOpenTask: Predicate = (q) =>
  q.eq("is_draft", false).is("deleted_at", null).not("status", "in", "(done,rejected)").or("archived_at.is.null,archived_by.is.null");

/** Every open task, auto-archived ones included (see whereOpenTask). */
export async function listOpenTasks(principal: ExecPrincipal, opts: DdReadOptions = {}): Promise<DdTask[]> {
  requirePrincipal(principal);
  const rows = await pageAll<TaskRow>("tasks", () => whereOpenTask(from("tasks", TASK_COLS)), opts);
  return rows.map(taskFromRow);
}

/** Tasks completed in [fromIso, toIso), archived ones included (archiving doesn't undo the work). */
export async function listTasksCompletedBetween(
  principal: ExecPrincipal,
  fromIso: string,
  toIso: string,
  opts: DdReadOptions = {}
): Promise<DdTask[]> {
  requirePrincipal(principal);
  const { start, end } = windowParams(fromIso, toIso);
  const rows = await pageAll<TaskRow>(
    "tasks",
    () =>
      from("tasks", TASK_COLS)
        .eq("status", "done")
        .gte("completed_at", start)
        .lt("completed_at", end)
        .eq("is_draft", false)
        .is("deleted_at", null),
    opts
  );
  return rows.map(taskFromRow);
}

/**
 * Tasks created in [fromIso, toIso). Approving an AI draft keeps its original
 * created_at, so a draft approved today counts on the day it was drafted. A
 * rejected draft keeps it too, with is_draft cleared, but it never became a
 * task, so it is left out (p2b-helpers §4).
 */
export async function listTasksCreatedBetween(
  principal: ExecPrincipal,
  fromIso: string,
  toIso: string,
  opts: DdReadOptions = {}
): Promise<DdTask[]> {
  requirePrincipal(principal);
  const { start, end } = windowParams(fromIso, toIso);
  const rows = await pageAll<TaskRow>(
    "tasks",
    () =>
      from("tasks", TASK_COLS)
        .gte("created_at", start)
        .lt("created_at", end)
        .eq("is_draft", false)
        .is("deleted_at", null)
        .neq("status", "rejected"),
    opts
  );
  return rows.map(taskFromRow);
}

/** The tasks with these ids, whatever their state (drafts and deleted rows included; check the flags). */
export async function listTasksByIds(principal: ExecPrincipal, ids: readonly string[], opts: DdReadOptions = {}): Promise<DdTask[]> {
  requirePrincipal(principal);
  const rows = await pageAllByIds<TaskRow>("tasks", ids, (chunk) => from("tasks", TASK_COLS).in("id", chunk), opts);
  return rows.map(taskFromRow);
}

/**
 * How many open tasks (whereOpenTask) are past due at `nowIso`, incident
 * tasks left out: one is due the minute it's reported, so it isn't late work
 * (isIncident in analysis/tasks.ts, the twin of this tag filter). The same
 * count as the Overview's open-overdue tile.
 */
export async function countOpenOverdueTasks(principal: ExecPrincipal, nowIso: string, opts: DdReadOptions = {}): Promise<number> {
  requirePrincipal(principal);
  const now = isoParam("nowIso", nowIso);
  // tasks.tags is NOT NULL, so the negated containment never drops a row for a NULL.
  const query = whereOpenTask(from("tasks", "id", HEAD_COUNT)).lt("due_date", now).not("tags", "cs", "{incident}");
  return countRows("tasks", query, opts.signal);
}

// ---------------------------------------------------------------------------
// People and org
// ---------------------------------------------------------------------------

// users also holds plaintext Slack and Google tokens: never select("*") here.
const USER_COLS = "id,name,email,role,is_admin,work_timezone,manager_user_id";

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  is_admin: boolean | null;
  work_timezone: string | null;
  manager_user_id: string | null;
}

interface MembershipRow {
  user_id: string;
  department_id: string;
}

/** Every user, with departmentIds primary-first: (created_at, department_id), like userDepartmentIds in server-data.ts. */
export async function listUsers(principal: ExecPrincipal, opts: DdReadOptions = {}): Promise<DdUser[]> {
  requirePrincipal(principal);
  const [users, memberships] = await Promise.all([
    pageAll<UserRow>("users", () => from("users", USER_COLS), opts),
    // Backfilled memberships share their department's created_at, so user_id
    // completes a unique order for paging. Per user it keeps the primary first.
    pageAll<MembershipRow>("department_members", () => from("department_members", "user_id,department_id"), {
      ...opts,
      orderBy: ["created_at", "department_id", "user_id"]
    })
  ]);
  const departmentsByUser = new Map<string, string[]>();
  for (const m of memberships) {
    const list = departmentsByUser.get(m.user_id);
    if (list) list.push(m.department_id);
    else departmentsByUser.set(m.user_id, [m.department_id]);
  }
  return users.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    isAdmin: r.is_admin === true,
    workTimezone: r.work_timezone ?? null,
    managerUserId: r.manager_user_id ?? null,
    departmentIds: departmentsByUser.get(r.id) ?? []
  }));
}

interface DepartmentRow {
  id: string;
  name: string;
  head_user_id: string | null;
}

export async function listDepartments(principal: ExecPrincipal, opts: DdReadOptions = {}): Promise<DdDepartment[]> {
  requirePrincipal(principal);
  const rows = await pageAll<DepartmentRow>("departments", () => from("departments", "id,name,head_user_id"), opts);
  return rows.map((r) => ({ id: r.id, name: r.name, headUserId: r.head_user_id ?? null }));
}

// ---------------------------------------------------------------------------
// Projects and clients
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: string;
  name: string;
  department_id: string | null;
  created_at: string;
}

export async function listProjects(principal: ExecPrincipal, opts: DdReadOptions = {}): Promise<DdProject[]> {
  requirePrincipal(principal);
  const rows = await pageAll<ProjectRow>("projects", () => from("projects", "id,name,department_id,created_at"), opts);
  return rows.map((r) => ({ id: r.id, name: r.name, departmentId: r.department_id ?? null, createdAt: r.created_at }));
}

interface StageRow {
  id: string;
  project_id: string;
  position: number | string;
  name: string;
  kind: string | null;
  status: ProjectStageStatus;
  updated_at: string;
}

/** Stages of the given projects, or of every project when `projectIds` is omitted. */
export async function listProjectStages(
  principal: ExecPrincipal,
  projectIds?: readonly string[],
  opts: DdReadOptions = {}
): Promise<DdProjectStage[]> {
  requirePrincipal(principal);
  const rows = await pageAllOptionalIds<StageRow>(
    "project_stages",
    projectIds,
    (chunk) => {
      const query = from("project_stages", "id,project_id,position,name,kind,status,updated_at");
      return chunk ? query.in("project_id", chunk) : query;
    },
    opts
  );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    position: Number(r.position),
    name: r.name,
    kind: r.kind ?? "custom",
    status: r.status,
    updatedAt: r.updated_at
  }));
}

// Notes, summaries and the last outbound subject are left out: they are
// client text, and nothing in P2b shows them.
const CLIENT_COLS =
  "id,name,status,health_score,health_label,health_sample_size,health_computed_at,health_override_label," +
  "health_override_by,health_override_at,touchpoint_override_label,touchpoint_override_by,touchpoint_override_at," +
  "last_outbound_email_at_external,touchpoint_synced_at";

interface ClientRow {
  id: string;
  name: string;
  status: string | null;
  health_score: number | string | null;
  health_label: ClientHealthLabel | null;
  health_sample_size: number | string | null;
  health_computed_at: string | null;
  health_override_label: ClientHealthLabel | null;
  health_override_by: string | null;
  health_override_at: string | null;
  touchpoint_override_label: TouchpointLabel | null;
  touchpoint_override_by: string | null;
  touchpoint_override_at: string | null;
  last_outbound_email_at_external: string | null;
  touchpoint_synced_at: string | null;
}

export async function listClients(principal: ExecPrincipal, opts: DdReadOptions = {}): Promise<DdClient[]> {
  requirePrincipal(principal);
  const rows = await pageAll<ClientRow>("clients", () => from("clients", CLIENT_COLS), opts);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    // Matches getClients(): the column is free text that nothing writes.
    status: r.status ?? "active",
    healthScore: numOrNull(r.health_score),
    healthLabel: r.health_label ?? null,
    healthSampleSize: numOrNull(r.health_sample_size),
    healthComputedAt: r.health_computed_at ?? null,
    healthOverrideLabel: r.health_override_label ?? null,
    healthOverrideBy: r.health_override_by ?? null,
    healthOverrideAt: r.health_override_at ?? null,
    touchpointOverrideLabel: r.touchpoint_override_label ?? null,
    touchpointOverrideBy: r.touchpoint_override_by ?? null,
    touchpointOverrideAt: r.touchpoint_override_at ?? null,
    lastOutboundEmailAtExternal: r.last_outbound_email_at_external ?? null,
    touchpointSyncedAt: r.touchpoint_synced_at ?? null
  }));
}

// ---------------------------------------------------------------------------
// Task timelines
// ---------------------------------------------------------------------------

interface ActivityRow {
  id: string;
  task_id: string;
  user_id: string;
  action: string;
  created_at: string;
}

/**
 * activity_logs rows since `sinceIso`, without their detail text. Narrow with
 * any of taskIds, userId and actions; an empty list in either matches nothing.
 * With no taskIds this scans the whole window (activity_logs is indexed on
 * task_id only).
 */
export async function listActivitySince(
  principal: ExecPrincipal,
  sinceIso: string,
  filter: { taskIds?: readonly string[]; userId?: string; actions?: readonly string[] },
  opts: DdReadOptions = {}
): Promise<DdActivity[]> {
  requirePrincipal(principal);
  const since = isoParam("sinceIso", sinceIso);
  const { taskIds, userId, actions } = filter;
  if (actions !== undefined && actions.length === 0) return [];
  const rows = await pageAllOptionalIds<ActivityRow>(
    "activity_logs",
    taskIds,
    (chunk) => {
      let query = from("activity_logs", "id,task_id,user_id,action,created_at").gte("created_at", since);
      if (chunk) query = query.in("task_id", chunk);
      if (userId !== undefined) query = query.eq("user_id", userId);
      if (actions !== undefined) query = query.in("action", actions);
      return query;
    },
    opts
  );
  return rows.map((r) => ({ id: r.id, taskId: r.task_id, userId: r.user_id, action: r.action, createdAt: r.created_at }));
}

interface StatusLogRow {
  task_id: string;
  detail: string | null;
  created_at: string;
}

// The first line of a status_change detail is "{from} → {to}" (the arrow is
// U+2192), with " (timer started)" appended when the timer flipped it. A
// comment that came with the change follows on the next lines (p2b-schema §2.5).
const STATUS_TRANSITION = /^\s*([a-z_]+)\s*→\s*([a-z_]+)/;

function transitionTarget(detail: string | null): string | null {
  if (typeof detail !== "string") return null;
  const match = STATUS_TRANSITION.exec(detail.split("\n", 1)[0]);
  return match ? match[2] : null;
}

/**
 * When each task last entered `toStatus`, from its status_change logs. There
 * is no status-entered column, so this is the only read of activity_logs.detail
 * in exec: the first line is parsed and the text, including any comment after
 * it, never leaves this function. Tasks with no matching log are absent; the
 * caller falls back to lastActivityAt, which is a lower bound on the time in
 * that status.
 */
export async function listStatusChangeEntries(
  principal: ExecPrincipal,
  taskIds: readonly string[],
  toStatus: TaskStatus,
  opts: DdReadOptions = {}
): Promise<DdStatusEntry[]> {
  requirePrincipal(principal);
  const rows = await pageAllByIds<StatusLogRow>(
    "activity_logs",
    taskIds,
    (chunk) => from("activity_logs", "task_id,detail,created_at").eq("action", "status_change").in("task_id", chunk),
    opts
  );
  const latest = new Map<string, { at: string; ms: number }>();
  for (const row of rows) {
    if (transitionTarget(row.detail) !== toStatus) continue;
    const ms = Date.parse(row.created_at);
    if (!Number.isFinite(ms)) continue;
    const seen = latest.get(row.task_id);
    if (!seen || ms > seen.ms) latest.set(row.task_id, { at: row.created_at, ms });
  }
  return [...latest.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([taskId, entry]) => ({ taskId, enteredAt: entry.at }));
}

interface MessageRow {
  id: string;
  task_id: string;
  user_id: string | null;
  created_at: string;
}

/** Legacy task_messages since `sinceIso`, without bodies. An empty taskIds list matches nothing. */
export async function listTaskMessagesSince(
  principal: ExecPrincipal,
  sinceIso: string,
  filter: { taskIds?: readonly string[]; userId?: string },
  opts: DdReadOptions = {}
): Promise<DdTaskMessage[]> {
  requirePrincipal(principal);
  const since = isoParam("sinceIso", sinceIso);
  const { taskIds, userId } = filter;
  const rows = await pageAllOptionalIds<MessageRow>(
    "task_messages",
    taskIds,
    (chunk) => {
      let query = from("task_messages", "id,task_id,user_id,created_at").gte("created_at", since);
      if (chunk) query = query.in("task_id", chunk);
      if (userId !== undefined) query = query.eq("user_id", userId);
      return query;
    },
    opts
  );
  return rows.map((r) => ({ id: r.id, taskId: r.task_id, userId: r.user_id ?? null, createdAt: r.created_at }));
}

interface NotificationRow {
  id: string;
  user_id: string;
  task_id: string;
  kind: TaskNotificationKind;
  from_user_id: string | null;
  created_at: string;
}

/** Notifications addressed to `userId` since `sinceIso`, of the given kinds, without their notes. */
export async function listTaskNotificationsForUser(
  principal: ExecPrincipal,
  userId: string,
  sinceIso: string,
  kinds: readonly TaskNotificationKind[],
  opts: DdReadOptions = {}
): Promise<DdTaskNotification[]> {
  requirePrincipal(principal);
  const since = isoParam("sinceIso", sinceIso);
  if (kinds.length === 0) return [];
  const rows = await pageAll<NotificationRow>(
    "task_notifications",
    () =>
      from("task_notifications", "id,user_id,task_id,kind,from_user_id,created_at")
        .eq("user_id", userId)
        .gte("created_at", since)
        .in("kind", kinds),
    opts
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    taskId: r.task_id,
    kind: r.kind,
    actorId: r.from_user_id ?? null,
    createdAt: r.created_at
  }));
}

interface ExtensionRow {
  id: string;
  task_id: string;
  user_id: string;
  previous_due_date: string | null;
  new_due_date: string;
  created_at: string;
}

/** Due-date extensions filed since `sinceIso`, without reasons. Off-boarding deletes a user's rows. */
export async function listTaskExtensionsSince(principal: ExecPrincipal, sinceIso: string, opts: DdReadOptions = {}): Promise<DdTaskExtension[]> {
  requirePrincipal(principal);
  const since = isoParam("sinceIso", sinceIso);
  const rows = await pageAll<ExtensionRow>(
    "task_extensions",
    () => from("task_extensions", "id,task_id,user_id,previous_due_date,new_due_date,created_at").gte("created_at", since),
    opts
  );
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    userId: r.user_id,
    previousDueDate: r.previous_due_date ?? null,
    newDueDate: r.new_due_date,
    createdAt: r.created_at
  }));
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

interface IncidentRow {
  id: string;
  issue_type: string;
  affected_url: string | null;
  created_at: string;
}

/** Incidents logged since `sinceIso`, without descriptions. Open or not comes from the incident task, not this table. */
export async function listIncidentLogsSince(principal: ExecPrincipal, sinceIso: string, opts: DdReadOptions = {}): Promise<DdIncidentLog[]> {
  requirePrincipal(principal);
  const since = isoParam("sinceIso", sinceIso);
  const rows = await pageAll<IncidentRow>(
    "incident_logs",
    () => from("incident_logs", "id,issue_type,affected_url,created_at").gte("created_at", since),
    opts
  );
  return rows.map((r) => ({ id: r.id, issueType: r.issue_type, affectedUrl: r.affected_url ?? null, createdAt: r.created_at }));
}

interface SiteAlertRow {
  id: string;
  website: string;
  domain: string | null;
  site_score: number | string;
  threshold: number | string;
  priority: string | null;
  task_id: string | null;
  skipped_reason: string | null;
  created_at: string;
}

/**
 * Low site-score alerts since `sinceIso`. The table also logs healthy scans
 * (skipped_reason 'above-threshold'); those are left out. The filter keeps
 * NULL explicitly because `skipped_reason <> 'above-threshold'` is NULL, not
 * true, on the alerts that did open a task.
 */
export async function listSiteHealthAlertsSince(
  principal: ExecPrincipal,
  sinceIso: string,
  opts: DdReadOptions = {}
): Promise<DdSiteHealthAlert[]> {
  requirePrincipal(principal);
  const since = isoParam("sinceIso", sinceIso);
  const rows = await pageAll<SiteAlertRow>(
    "site_health_alerts",
    () =>
      from("site_health_alerts", "id,website,domain,site_score,threshold,priority,task_id,skipped_reason,created_at")
        .gte("created_at", since)
        .or("skipped_reason.is.null,skipped_reason.neq.above-threshold"),
    opts
  );
  return rows.map((r) => ({
    id: r.id,
    website: r.website,
    domain: r.domain ?? null,
    score: Number(r.site_score),
    threshold: Number(r.threshold),
    priority: r.priority === "high" || r.priority === "medium" ? r.priority : null,
    taskId: r.task_id ?? null,
    skippedReason: r.skipped_reason ?? null,
    createdAt: r.created_at
  }));
}

interface TimeEntryRow {
  id: string;
  user_id: string;
  task_id: string | null;
  started_at: string;
  ended_at: string | null;
}

/**
 * Clock segments overlapping [fromIso, toIso): started before the end, and
 * either still running or finished at or after the start. Callers clip each
 * one to the window.
 */
export async function listTimeEntriesBetween(
  principal: ExecPrincipal,
  fromIso: string,
  toIso: string,
  opts: DdReadOptions = {}
): Promise<DdTimeEntry[]> {
  requirePrincipal(principal);
  const { start, end } = windowParams(fromIso, toIso);
  const rows = await pageAll<TimeEntryRow>(
    "time_entries",
    () => from("time_entries", "id,user_id,task_id,started_at,ended_at").lt("started_at", end).or(`ended_at.is.null,ended_at.gte.${start}`),
    opts
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    taskId: r.task_id ?? null,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? null
  }));
}

interface EodNoteRow {
  user_id: string;
  note_date: string;
  submitted_at: string | null;
  reviewed_at: string | null;
}

/** EOD status (never text) for one ET calendar day, e.g. eodToday() from shift.ts. */
export async function listEodNotesForDate(principal: ExecPrincipal, etDate: string, opts: DdReadOptions = {}): Promise<DdEodNote[]> {
  requirePrincipal(principal);
  const date = ymdParam("etDate", etDate);
  const rows = await pageAll<EodNoteRow>(
    "eod_notes",
    () => from("eod_notes", "user_id,note_date,submitted_at,reviewed_at").eq("note_date", date),
    opts
  );
  return rows.map((r) => ({
    userId: r.user_id,
    noteDate: r.note_date,
    submittedAt: r.submitted_at ?? null,
    reviewedAt: r.reviewed_at ?? null
  }));
}

// ---------------------------------------------------------------------------
// Approvals: the six mechanisms of p2b-schema §5
// ---------------------------------------------------------------------------

/** count (head) + the oldest pending row's `sinceColumn`, under one predicate. */
async function approvalBucket(
  mechanism: ApprovalMechanism,
  table: string,
  sinceColumn: string,
  where: Predicate,
  signal: AbortSignal | undefined
): Promise<ApprovalBucket> {
  const [count, oldest] = await Promise.all([
    countRows(table, where(from(table, "id", HEAD_COUNT)), signal),
    oldestValue(table, sinceColumn, () => where(from(table, sinceColumn)), signal)
  ]);
  // The two reads aren't one snapshot; a zero count never carries an age.
  return { mechanism, count, oldestAt: count > 0 ? oldest : null };
}

// A proof is pending while its task sits in pending_approval: fb_proof's own
// review_status can go stale when a PATCH moves the task on. How long it has
// waited is fb_proof.submitted_at (resubmitting overwrites it); the task's
// created_at would count the days before the work was even done.
async function fbProofBucket(signal: AbortSignal | undefined): Promise<ApprovalBucket> {
  const pending = await pageAll<{ id: string }>(
    "tasks",
    () => from("tasks", "id").eq("status", "pending_approval").is("deleted_at", null),
    { signal }
  );
  let oldest: string | null = null;
  for (const chunk of chunked(pending.map((t) => t.id))) {
    const value = await oldestValue("fb_proof", "submitted_at", () => from("fb_proof", "submitted_at").in("task_id", chunk), signal);
    if (value !== null && (oldest === null || Date.parse(value) < Date.parse(oldest))) oldest = value;
  }
  return { mechanism: "fb_proofs", count: pending.length, oldestAt: pending.length > 0 ? oldest : null };
}

// An email draft waits on an approver from when it was last submitted. Sent
// back for revision, it waits on its author (needs_revision) until the
// resubmit route flips it back to pending. That route keeps created_at and
// logs a 'resubmitted' event, so each pending draft waits from its latest
// resubmission, else its creation; created_at alone would count the
// author's days as the approver's. Only ids and timestamps are read, never a
// draft's body or an event's note.
async function emailDraftBucket(signal: AbortSignal | undefined): Promise<ApprovalBucket> {
  const pending = await pageAll<{ id: string; created_at: string }>(
    "email_drafts",
    () => from("email_drafts", "id,created_at").eq("status", "pending").is("dismissed_at", null),
    { signal }
  );
  const waitingSince = new Map(pending.map((d) => [d.id, d.created_at]));
  for (const chunk of chunked(pending.map((d) => d.id))) {
    const resubmits = await pageAll<{ draft_id: string; created_at: string }>(
      "email_draft_events",
      () => from("email_draft_events", "draft_id,created_at").eq("type", "resubmitted").in("draft_id", chunk),
      { signal }
    );
    for (const e of resubmits) {
      const since = waitingSince.get(e.draft_id);
      if (since !== undefined && Date.parse(e.created_at) > Date.parse(since)) waitingSince.set(e.draft_id, e.created_at);
    }
  }
  let oldest: string | null = null;
  for (const since of waitingSince.values()) {
    if (oldest === null || Date.parse(since) < Date.parse(oldest)) oldest = since;
  }
  return { mechanism: "email_drafts", count: pending.length, oldestAt: oldest };
}

interface BriefingRow {
  id: string;
  created_at: string;
  messages: unknown;
}

// Check-in messages from today's brief (ET day, like the brief itself) that
// still have their Send button. Older briefs' buttons work too but aren't
// live, so they don't count. Each message carries its draft text; only the
// status is read, and only the count leaves here.
//
// P8 (M14, C46, §3.21.2): when the assistant's morning brief owns today (the
// M1 verdict "exec", from brief-ownership-load's fresh reads), the bucket
// counts the assistant's proposed, unexpired check-ins of today's brief
// (brief zone) instead, with source "exec"; otherwise the legacy count above.
// The legacy bucket carries no source key (its shape, and so its attention
// item's state, stay exactly P2b's). With EXEC_ENABLED off the verdict is
// always legacy (M1 row 1), so nothing of the brief's is read. A failed
// ownership or count read throws, as every approvals read does (no silent
// zero, UI18).
async function checkinBucket(principal: ExecPrincipal, now: Date, etToday: string, signal: AbortSignal | undefined): Promise<ApprovalBucket> {
  if (isExecEnabled()) {
    const src = await checkinApprovalSource(principal, now, { signal });
    if (src.source === "exec") return { mechanism: "checkins", count: src.count, oldestAt: src.oldestAt, source: "exec" };
  }
  return legacyCheckinBucket(etToday, signal);
}

async function legacyCheckinBucket(etToday: string, signal: AbortSignal | undefined): Promise<ApprovalBucket> {
  const rows = await pageAll<BriefingRow>(
    "daily_briefings",
    () => from("daily_briefings", "id,created_at,messages").eq("brief_date", etToday),
    { signal }
  );
  let count = 0;
  let oldest: string | null = null;
  for (const row of rows) {
    if (!Array.isArray(row.messages)) throw new DdReadError("daily_briefings", `messages on ${row.id} is not a list`);
    const pending = row.messages.filter(
      (m) => typeof m === "object" && m !== null && (m as { status?: unknown }).status === "pending"
    ).length;
    if (pending === 0) continue;
    count += pending;
    if (oldest === null || Date.parse(row.created_at) < Date.parse(oldest)) oldest = row.created_at;
  }
  return { mechanism: "checkins", count, oldestAt: oldest };
}

/**
 * Everything waiting on an approval, one bucket per mechanism in display
 * order, with the predicates of p2b-schema §5:
 *   draft_tasks    tasks.is_draft, not deleted
 *   fb_proofs      tasks in pending_approval, not deleted (see fbProofBucket)
 *   email_drafts   status 'pending' and not dismissed (needs_revision waits on
 *                  the author; see emailDraftBucket)
 *   unrouted_mail  routing_decisions needing review with no task yet
 *   eod_reviews    submitted, not reviewed, from the last 7 ET days
 *   checkins       pending messages on today's (ET) daily brief; P8 (M14): the
 *                  assistant's proposed check-ins while its brief owns today
 * oldestAt is when the oldest one started waiting. Any failed read throws:
 * a bucket that silently read zero would hide a decision.
 */
export async function getPendingApprovals(principal: ExecPrincipal, now: Date, opts: DdReadOptions = {}): Promise<ApprovalBucket[]> {
  requirePrincipal(principal);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("sources/dd: now must be a valid Date");
  const { signal } = opts;
  const etToday = eodToday(now);
  const eodWindowStart = addDaysToYmd(etToday, -(EOD_REVIEW_WINDOW_DAYS - 1));
  return Promise.all([
    approvalBucket("draft_tasks", "tasks", "created_at", (q) => q.eq("is_draft", true).is("deleted_at", null), signal),
    fbProofBucket(signal),
    emailDraftBucket(signal),
    approvalBucket("unrouted_mail", "routing_decisions", "created_at", (q) => q.eq("needs_review", true).is("task_id", null), signal),
    approvalBucket(
      "eod_reviews",
      "eod_notes",
      "submitted_at",
      (q) => q.not("submitted_at", "is", null).is("reviewed_at", null).gte("note_date", eodWindowStart),
      signal
    ),
    checkinBucket(principal, now, etToday, signal)
  ]);
}

// ---------------------------------------------------------------------------
// Email correlation and the email producers (P3, contract §3.12)
// ---------------------------------------------------------------------------

const MATCH_COLS = "id,name,status,website,websites,contact_emails,priority";

interface MatchRow {
  id: string;
  name: string;
  status: string | null;
  website: string | null;
  websites: string[] | null;
  contact_emails: string[] | null;
  priority: string | null;
}

const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Every client's match signals: exact contact addresses and website hosts
 * (L14). DD's own loadClientMatcher reads the same columns unpaged, unordered
 * and without an error check (an outage there reads as "no clients"); this
 * read pages by id and throws instead. Inactive clients come back too, so the
 * matcher can say why it skipped one; it keeps status null or "active".
 */
export async function listClientMatchSignals(principal: ExecPrincipal, opts: DdReadOptions = {}): Promise<DdClientMatchSignals[]> {
  requirePrincipal(principal);
  const rows = await pageAll<MatchRow>("clients", () => from("clients", MATCH_COLS), opts);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: typeof r.status === "string" ? r.status : null,
    website: typeof r.website === "string" ? r.website : null,
    websites: stringList(r.websites),
    contactEmails: stringList(r.contact_emails),
    priority: typeof r.priority === "string" ? r.priority : null
  }));
}

// satisfaction-scoring stores a reply it couldn't parse as a 75 with this
// reason. It is no reading at all, and would pull every median toward
// "steady", so it is never a signal (L13).
const NO_SCORE_REASON = "(model returned no score)";
// The reason column is never selected (it is model text about the client's
// mail); it is only compared, here, inside the filter. The value is quoted
// because PostgREST reserves the parentheses in a logic tree.
const SCORED_REASON_FILTER = `reason.is.null,reason.neq."${NO_SCORE_REASON}"`;
// email_satisfaction_scores has no id column: (message_id, client_id) is its key.
const SATISFACTION_ORDER = ["message_id", "client_id"] as const;

interface SatisfactionRow {
  client_id: string | null;
  satisfaction_score: number | string | null;
  delivered_at: string | null;
  scored_at: string | null;
  from_address: string | null;
  thread_id: string | null;
}

function isoOrNull(v: unknown): string | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
}

/**
 * Inbound satisfaction scores delivered since `sinceIso`, reduced to numbers
 * (L13), company-wide: client, score, delivered and scored times.
 *
 * Screened here, before anything leaves: a row whose sender matches one of
 * `rules` (the strict, applicable restricted-sender rules) or whose thread is
 * one of his tombstones is dropped, and so is a row with no sender to screen.
 * The sender and thread id are read for that and never returned; the subject
 * and the model's reason are never read. Unparseable scores ("(model returned
 * no score)") are left out. Throws DdReadError on a failed read.
 */
export async function listSatisfactionSignals(
  principal: ExecPrincipal,
  sinceIso: string,
  screen: { rules: readonly RestrictedSenderRule[]; tombstonedThreadIds: ReadonlySet<string> | readonly string[] },
  opts: DdReadOptions = {}
): Promise<DdSatisfactionSignal[]> {
  requirePrincipal(principal);
  const since = isoParam("sinceIso", sinceIso);
  if (!screen || !Array.isArray(screen.rules)) throw new TypeError("sources/dd: listSatisfactionSignals needs the restricted-sender rules");
  const rules = [...screen.rules];
  const tombstones = new Set(screen.tombstonedThreadIds);
  const rows = await pageAll<SatisfactionRow>(
    "email_satisfaction_scores",
    () =>
      from("email_satisfaction_scores", "client_id,satisfaction_score,delivered_at,scored_at,from_address,thread_id")
        .eq("direction", "inbound")
        .gte("delivered_at", since)
        .or(SCORED_REASON_FILTER),
    { ...opts, orderBy: SATISFACTION_ORDER }
  );
  const out: DdSatisfactionSignal[] = [];
  for (const r of rows) {
    const score = numOrNull(r.satisfaction_score);
    const deliveredAt = isoOrNull(r.delivered_at);
    const scoredAt = isoOrNull(r.scored_at);
    if (typeof r.client_id !== "string" || !r.client_id || score === null || !Number.isFinite(score) || !deliveredAt || !scoredAt) continue;
    // Fail closed: a row we can't screen is a row we don't use.
    if (typeof r.from_address !== "string" || !r.from_address.includes("@")) continue;
    if (typeof r.thread_id !== "string" || !r.thread_id || tombstones.has(r.thread_id)) continue;
    if (addressMatches(r.from_address, rules) !== null) continue;
    out.push({ clientId: r.client_id, score, deliveredAt, scoredAt });
  }
  return out;
}

const DAY_MS = 86_400_000;
const LATEST_SCORED_LOOKBACK_DAYS = 30;

/**
 * When each client's newest usable inbound score was taken (max scored_at),
 * among rows scored in the last `lookbackDays` (default 30): the freshness
 * gate of the satisfaction producer (an item only for clients scored in the
 * last 3 days) and the Email tab's "fresh for N of M" line. A client with no
 * score in the lookback is absent. Numbers and times only; nothing is
 * screened because nothing about the mail leaves. Throws on a failed read.
 */
export async function latestScoredInboundByClient(
  principal: ExecPrincipal,
  opts: DdReadOptions & { now?: Date; lookbackDays?: number } = {}
): Promise<Map<string, string>> {
  requirePrincipal(principal);
  const now = opts.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("sources/dd: now must be a valid Date");
  const days = opts.lookbackDays ?? LATEST_SCORED_LOOKBACK_DAYS;
  if (!Number.isFinite(days) || days <= 0 || days > 3_650) throw new TypeError("sources/dd: lookbackDays must be 1-3650");
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();
  const rows = await pageAll<{ client_id: string | null; scored_at: string | null }>(
    "email_satisfaction_scores",
    () =>
      from("email_satisfaction_scores", "client_id,scored_at").eq("direction", "inbound").gte("scored_at", since).or(SCORED_REASON_FILTER),
    { signal: opts.signal, orderBy: SATISFACTION_ORDER }
  );
  const newest = new Map<string, { iso: string; ms: number }>();
  for (const r of rows) {
    const ms = typeof r.scored_at === "string" ? Date.parse(r.scored_at) : Number.NaN;
    if (typeof r.client_id !== "string" || !r.client_id || !Number.isFinite(ms)) continue;
    const seen = newest.get(r.client_id);
    if (!seen || ms > seen.ms) newest.set(r.client_id, { iso: r.scored_at as string, ms });
  }
  return new Map([...newest].map(([clientId, v]) => [clientId, v.iso]));
}

const MAX_THREAD_ID = 200;

function threadIdParam(threadId: string): string {
  if (typeof threadId !== "string" || threadId.length === 0 || threadId.length > MAX_THREAD_ID || /[\x00-\x1f\x7f]/.test(threadId)) {
    throw new TypeError("sources/dd: threadId is malformed");
  }
  return threadId;
}

// LIKE's own wildcards, escaped with its default escape character. PostgREST
// also reads "*" as "%", which can only widen the match; the exact suffix is
// re-checked on every row that comes back.
const likeLiteral = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * DD tasks linked to one clone thread (the thread page's "linked tasks"):
 *   - tasks whose missive_thread_url ends with exactly "?thread=<id>" (the
 *     URL email intake writes: missiveThreadUrl, encodeURIComponent'd id);
 *   - the task email_intake_log recorded for the thread.
 * DdTask columns only. Deleted tasks are left out; drafts stay (with isDraft),
 * since an intake draft is the task the thread produced. Newest first.
 * Throws on a failed read.
 */
export async function listTasksForThread(principal: ExecPrincipal, threadId: string, opts: DdReadOptions = {}): Promise<DdTask[]> {
  requirePrincipal(principal);
  const id = threadIdParam(threadId);
  const suffix = `?thread=${encodeURIComponent(id)}`;
  const byUrl = await pageAll<TaskRow & { missive_thread_url: string | null }>(
    "tasks",
    () => from("tasks", `${TASK_COLS},missive_thread_url`).like("missive_thread_url", `%${likeLiteral(suffix)}`),
    opts
  );
  const tasks = new Map<string, DdTask>();
  for (const r of byUrl) {
    if (typeof r.missive_thread_url === "string" && r.missive_thread_url.endsWith(suffix)) tasks.set(r.id, taskFromRow(r));
  }

  const intake = await pageAll<{ thread_id: string; task_id: string | null }>(
    "email_intake_log",
    () => from("email_intake_log", "thread_id,task_id").eq("thread_id", id).not("task_id", "is", null),
    { ...opts, orderBy: ["thread_id"] }
  );
  const missing = uniqueIds(intake.map((r) => r.task_id ?? "")).filter((taskId) => !tasks.has(taskId));
  if (missing.length > 0) {
    for (const t of await listTasksByIds(principal, missing, opts)) tasks.set(t.id, t);
  }

  return [...tasks.values()]
    .filter((t) => t.deletedAt === null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const MAX_MEETINGS = 50;

/**
 * A client's most recent meetings (id, title, when), newest first, at most
 * `limit` (1-50). The transcript, summary and brief are never read. Throws on
 * a failed read.
 */
export async function listClientMeetings(
  principal: ExecPrincipal,
  clientId: string,
  limit: number,
  opts: DdReadOptions = {}
): Promise<DdClientMeeting[]> {
  requirePrincipal(principal);
  if (typeof clientId !== "string" || clientId.length === 0) throw new TypeError("sources/dd: clientId is required");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MEETINGS) throw new TypeError(`sources/dd: limit must be 1-${MAX_MEETINGS}`);
  let query = from("client_meetings", "id,title,meeting_date")
    .eq("client_id", clientId)
    .order("meeting_date", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { data, error } = await query;
  if (error) throw new DdReadError("client_meetings", error.message);
  if (!Array.isArray(data)) throw new DdReadError("client_meetings", "the response carried no rows");
  return (data as unknown as { id: unknown; title: unknown; meeting_date: unknown }[]).map((r) => {
    if (typeof r.id !== "string" || typeof r.meeting_date !== "string") throw new DdReadError("client_meetings", "a row is malformed");
    return { id: r.id, title: typeof r.title === "string" ? r.title : "", meetingAt: r.meeting_date };
  });
}

// ---------------------------------------------------------------------------
// P4 (contract §3.15 Y11; Area C)
// ---------------------------------------------------------------------------

/**
 * The zone CL2 quotes times in (L19): users.work_timezone of principal.userId
 * when isValidTimeZone, else "America/New_York". Cosmetic, so unlike every
 * other read here it fails soft: a read error (or a missing user) gives the
 * default and one log line, never a thrown DdReadError.
 */
export async function getMailTimezone(principal: ExecPrincipal, opts: DdReadOptions = {}): Promise<string> {
  requirePrincipal(principal);
  try {
    let query = from("users", "work_timezone").eq("id", principal.userId).limit(1);
    if (opts.signal) query = query.abortSignal(opts.signal);
    const { data, error } = await query;
    if (error) throw new DdReadError("users", error.message);
    const row = Array.isArray(data) && data.length > 0 ? (data[0] as { work_timezone?: unknown }) : null;
    const tz = row !== null && typeof row.work_timezone === "string" ? row.work_timezone.trim() : null;
    return isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
  } catch (err) {
    console.warn(`[exec-dd] users.work_timezone read failed, using ${DEFAULT_TIMEZONE}: ${err instanceof Error ? err.message : String(err)}`);
    return DEFAULT_TIMEZONE;
  }
}

/**
 * Open tasks (the whereOpenTask predicate) whose client_name equals
 * `clientName` exactly, paged by id, DdTask columns (ids, enums, dates: no
 * description). An empty name reads nothing. Fails closed like every other
 * list here (a DD error throws DdReadError).
 */
export async function listOpenTasksForClient(principal: ExecPrincipal, clientName: string, opts: DdReadOptions = {}): Promise<DdTask[]> {
  requirePrincipal(principal);
  if (typeof clientName !== "string" || clientName.trim() === "") return [];
  const rows = await pageAll<TaskRow>("tasks", () => whereOpenTask(from("tasks", TASK_COLS)).eq("client_name", clientName), opts);
  return rows.map(taskFromRow);
}

// ---------------------------------------------------------------------------
// P5a (contract §3.8). Same rules as every read above: explicit columns,
// paged, ids chunked, fail closed, never free text. listStatusTransitions is
// the second first-line-only parse of activity_logs.detail (A4): the text
// after the "{from} → {to}" line never leaves it. listTaskThreadLinks and
// listPendingApprovalItems are importable only by intake-screen.ts (boundary
// rule 15): their consumers go through the restricted-sender screen there.
// ---------------------------------------------------------------------------

// users also holds plaintext Slack and Google tokens: the schedule read names
// its columns, like USER_COLS.
const SCHEDULE_COLS =
  "id,daily_capacity,weekly_schedule,work_hours_start,work_hours_end,daily_prompts_enabled,daily_prompts_required,clock_enabled,created_at";

interface ScheduleRow {
  id: string;
  daily_capacity: number | string | null;
  weekly_schedule: unknown;
  work_hours_start: string | null;
  work_hours_end: string | null;
  daily_prompts_enabled: boolean | null;
  daily_prompts_required: boolean | null;
  clock_enabled: boolean | null;
  created_at: string;
}

type ScheduleDay = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
const SCHEDULE_DAYS: ReadonlySet<string> = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const SCHEDULE_TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;

/**
 * users.weekly_schedule as DD's editor writes it: day key → { start, end }
 * ("HH:MM") or null. Anything else (not an object, an unknown key, a block
 * without two valid times) is malformed, and a malformed schedule reads as
 * {} ("no explicit schedule": weekdays at daily_capacity), never as a guess.
 */
function weeklyScheduleOf(raw: unknown): DdUserSchedule["weeklySchedule"] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: DdUserSchedule["weeklySchedule"] = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!SCHEDULE_DAYS.has(key)) return {};
    const day = key as ScheduleDay;
    if (value === null) {
      out[day] = null;
      continue;
    }
    if (typeof value !== "object" || Array.isArray(value)) return {};
    const { start, end } = value as { start?: unknown; end?: unknown };
    if (typeof start !== "string" || typeof end !== "string" || !SCHEDULE_TIME.test(start.trim()) || !SCHEDULE_TIME.test(end.trim())) {
      return {};
    }
    out[day] = { start: start.trim(), end: end.trim() };
  }
  return out;
}

/**
 * Every user's schedule and ritual flags (A3): daily capacity, the validated
 * weekly schedule, flat work hours, the SOD/EOD flags and created_at. Never a
 * token column.
 */
export async function listUserSchedules(principal: ExecPrincipal, opts: DdReadOptions = {}): Promise<DdUserSchedule[]> {
  requirePrincipal(principal);
  const rows = await pageAll<ScheduleRow>("users", () => from("users", SCHEDULE_COLS), opts);
  return rows.map((r) => {
    const capacity = Number(r.daily_capacity);
    return {
      userId: r.id,
      dailyCapacity: Number.isFinite(capacity) ? capacity : 0,
      weeklySchedule: weeklyScheduleOf(r.weekly_schedule),
      workHoursStart: typeof r.work_hours_start === "string" ? r.work_hours_start : null,
      workHoursEnd: typeof r.work_hours_end === "string" ? r.work_hours_end : null,
      // The columns are NOT NULL with these defaults; a missing value reads as the default.
      dailyPromptsEnabled: r.daily_prompts_enabled !== false,
      dailyPromptsRequired: r.daily_prompts_required === true,
      clockEnabled: r.clock_enabled !== false,
      createdAt: r.created_at
    };
  });
}

interface TaskHoursRow {
  id: string;
  estimated_hours: number | string | null;
  actual_hours: number | string | null;
  actual_hours_override: number | string | null;
}

/** The hour columns of these tasks (capacity.ts's load math). */
export async function listTaskHours(principal: ExecPrincipal, taskIds: readonly string[], opts: DdReadOptions = {}): Promise<DdTaskHours[]> {
  requirePrincipal(principal);
  const rows = await pageAllByIds<TaskHoursRow>(
    "tasks",
    taskIds,
    (chunk) => from("tasks", "id,estimated_hours,actual_hours,actual_hours_override").in("id", chunk),
    opts
  );
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return rows.map((r) => {
    const override = numOrNull(r.actual_hours_override);
    return {
      taskId: r.id,
      estimatedHours: num(r.estimated_hours),
      actualHours: num(r.actual_hours),
      actualHoursOverride: override !== null && Number.isFinite(override) ? override : null
    };
  });
}

/** EOD status (never text) for the ET dates fromYmd..toYmd inclusive (eod_notes_date_idx). */
export async function listEodNotesBetween(principal: ExecPrincipal, fromYmd: string, toYmd: string, opts: DdReadOptions = {}): Promise<DdEodNote[]> {
  requirePrincipal(principal);
  const first = ymdParam("fromYmd", fromYmd);
  const last = ymdParam("toYmd", toYmd);
  if (first > last) throw new TypeError("sources/dd: fromYmd is after toYmd");
  // (user_id, note_date) is unique.
  const rows = await pageAll<EodNoteRow>(
    "eod_notes",
    () => from("eod_notes", "user_id,note_date,submitted_at,reviewed_at").gte("note_date", first).lte("note_date", last),
    { ...opts, orderBy: ["note_date", "user_id"] }
  );
  return rows.map((r) => ({
    userId: r.user_id,
    noteDate: r.note_date,
    submittedAt: r.submitted_at ?? null,
    reviewedAt: r.reviewed_at ?? null
  }));
}

/** Due-date extensions of these tasks, any age, without reasons (task_extensions(task_id)). */
export async function listTaskExtensionsForTasks(
  principal: ExecPrincipal,
  taskIds: readonly string[],
  opts: DdReadOptions = {}
): Promise<DdTaskExtension[]> {
  requirePrincipal(principal);
  const rows = await pageAllByIds<ExtensionRow>(
    "task_extensions",
    taskIds,
    (chunk) => from("task_extensions", "id,task_id,user_id,previous_due_date,new_due_date,created_at").in("task_id", chunk),
    opts
  );
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    userId: r.user_id,
    previousDueDate: r.previous_due_date ?? null,
    newDueDate: r.new_due_date,
    createdAt: r.created_at
  }));
}

/**
 * Every task of these projects in ANY state: drafts, deleted rows and
 * rejected drafts included (A4 approves the deleted rows: the project flow
 * still waits on them), with their batch columns. Callers check the flags.
 */
export async function listProjectTasksAllStates(
  principal: ExecPrincipal,
  projectIds: readonly string[],
  opts: DdReadOptions = {}
): Promise<DdProjectTask[]> {
  requirePrincipal(principal);
  const rows = await pageAllByIds<TaskRow & { parallel_group: number | string | null; stage_position: number | string | null }>(
    "tasks",
    projectIds,
    (chunk) => from("tasks", `${TASK_COLS},parallel_group,stage_position`).in("project_id", chunk),
    opts
  );
  return rows.map((r) => {
    const group = numOrNull(r.parallel_group);
    const position = numOrNull(r.stage_position);
    return {
      ...taskFromRow(r),
      parallelGroup: group !== null && Number.isFinite(group) ? group : null,
      stagePosition: position !== null && Number.isFinite(position) ? position : null
    };
  });
}

interface TransitionRow {
  id: string;
  task_id: string;
  user_id: string;
  detail: string | null;
  created_at: string;
}

/**
 * The status_change rows of these tasks since `sinceIso`, each reduced to its
 * first line's "{from} → {to}". Like listStatusChangeEntries this reads
 * activity_logs.detail, and the text (any comment after the first line)
 * never leaves the function. A row whose first line doesn't parse is
 * dropped. Oldest first.
 */
export async function listStatusTransitions(
  principal: ExecPrincipal,
  taskIds: readonly string[],
  sinceIso: string,
  opts: DdReadOptions = {}
): Promise<DdStatusTransition[]> {
  requirePrincipal(principal);
  const since = isoParam("sinceIso", sinceIso);
  const rows = await pageAllByIds<TransitionRow>(
    "activity_logs",
    taskIds,
    (chunk) =>
      from("activity_logs", "id,task_id,user_id,detail,created_at").eq("action", "status_change").in("task_id", chunk).gte("created_at", since),
    opts
  );
  const out: DdStatusTransition[] = [];
  for (const row of rows) {
    const match = typeof row.detail === "string" ? STATUS_TRANSITION.exec(row.detail.split("\n", 1)[0]) : null;
    if (!match) continue;
    out.push({ id: row.id, taskId: row.task_id, userId: row.user_id, from: match[1], to: match[2], at: row.created_at });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One user's replies on these EOD notes (target_type 'eod'): ids and times, never the body. */
export async function listUpdateRepliesByUser(
  principal: ExecPrincipal,
  userId: string,
  targetIds: readonly string[],
  opts: DdReadOptions = {}
): Promise<DdUpdateReply[]> {
  requirePrincipal(principal);
  if (typeof userId !== "string" || userId.length === 0) throw new TypeError("sources/dd: userId is required");
  const rows = await pageAllByIds<{ id: string; target_id: string; user_id: string; created_at: string }>(
    "update_replies",
    targetIds,
    (chunk) => from("update_replies", "id,target_id,user_id,created_at").eq("target_type", "eod").eq("user_id", userId).in("target_id", chunk),
    opts
  );
  return rows.map((r) => ({ id: r.id, targetId: r.target_id, userId: r.user_id, createdAt: r.created_at }));
}

const THREAD_URL_MARK = "?thread=";

/** The clone thread id a missive_thread_url names ("…?thread=<encodeURIComponent(id)>"), or null. */
function threadIdOfUrl(url: string | null): string | null {
  if (typeof url !== "string") return null;
  const at = url.lastIndexOf(THREAD_URL_MARK);
  if (at < 0) return null;
  let id: string;
  try {
    id = decodeURIComponent(url.slice(at + THREAD_URL_MARK.length));
  } catch {
    return null;
  }
  // The same shape P3's store accepts; anything else can't be in his store.
  return id.length > 0 && id.length <= MAX_THREAD_ID && !/[\x00-\x1f\x7f]/.test(id) ? id : null;
}

/**
 * C25 (coherence-1, a-correct-2). Each task's links to the mail it came from,
 * both ways P3's listTasksForThread reads them, in the other direction:
 *   - tasks.missive_thread_url naming "?thread=<id>" (the URL email intake and
 *     "Create task from thread" write), and tasks.client_email (the sender
 *     intake records);
 *   - email_intake_log rows with this task_id. That table has no task_id
 *     index, so the read scans it; it is one row per intake thread.
 * No tag filter: a task made from a thread by hand carries the thread and the
 * sender but not the email-intake tag. Tasks with neither a thread nor a
 * client_email are absent. The values are never logged. Importable only by
 * intake-screen.ts (boundary rule 15).
 */
export async function listTaskThreadLinks(
  principal: ExecPrincipal,
  taskIds: readonly string[],
  opts: DdReadOptions = {}
): Promise<DdTaskThreadLink[]> {
  requirePrincipal(principal);
  const ids = uniqueIds(taskIds);
  if (ids.length === 0) return [];
  const linkRows = await pageAllByIds<{ id: string; missive_thread_url: string | null; client_email: string | null }>(
    "tasks",
    ids,
    (chunk) => from("tasks", "id,missive_thread_url,client_email").in("id", chunk),
    opts
  );
  const intake = await pageAllByIds<{ thread_id: string; task_id: string | null }>(
    "email_intake_log",
    ids,
    (chunk) => from("email_intake_log", "thread_id,task_id").in("task_id", chunk),
    { ...opts, orderBy: ["thread_id"] }
  );

  const links = new Map<string, { threads: Set<string>; clientEmail: string | null }>();
  const linkOf = (taskId: string) => {
    let link = links.get(taskId);
    if (!link) {
      link = { threads: new Set(), clientEmail: null };
      links.set(taskId, link);
    }
    return link;
  };
  for (const r of linkRows) {
    const threadId = threadIdOfUrl(r.missive_thread_url);
    const email = typeof r.client_email === "string" && r.client_email.trim() !== "" ? r.client_email.trim() : null;
    if (threadId === null && email === null) continue;
    const link = linkOf(r.id);
    if (threadId !== null) link.threads.add(threadId);
    if (email !== null) link.clientEmail = email;
  }
  for (const r of intake) {
    if (typeof r.task_id !== "string" || typeof r.thread_id !== "string") continue;
    if (r.thread_id.length === 0 || r.thread_id.length > MAX_THREAD_ID || /[\x00-\x1f\x7f]/.test(r.thread_id)) continue;
    linkOf(r.task_id).threads.add(r.thread_id);
  }
  return [...links.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([taskId, link]) => ({ taskId, threadIds: [...link.threads].sort(), clientEmail: link.clientEmail }));
}

const DEFAULT_APPROVAL_ITEMS = 50;
const MAX_APPROVAL_ITEMS = 200;

/** Rows of one mechanism before the limit, each with its sort key. */
type PendingItem = ApprovalItem & { sortMs: number };

function pendingItem(item: ApprovalItem): PendingItem {
  const ms = item.waitingSince === null ? Number.NaN : Date.parse(item.waitingSince);
  return { ...item, sortMs: Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY };
}

// Same predicate as approvalBucket("draft_tasks"). The task's title is DD's own
// record (an intake draft's title is model-written from the mail; the
// consumer screens restricted mail through listScreenedApprovalItems).
async function draftTaskItems(signal: AbortSignal | undefined): Promise<PendingItem[]> {
  const rows = await pageAll<{ id: string; title: string; creator_id: string; created_at: string; department_id: string | null; client_name: string | null }>(
    "tasks",
    () => from("tasks", "id,title,creator_id,created_at,department_id,client_name").eq("is_draft", true).is("deleted_at", null),
    { signal }
  );
  return rows.map((r) =>
    pendingItem({
      mechanism: "draft_tasks",
      id: r.id,
      title: r.title,
      requesterId: r.creator_id ?? null,
      waitingSince: r.created_at,
      waitingSinceIsLowerBound: false,
      approver: { kind: "leaders_or_department_heads", departmentIds: r.department_id ? [r.department_id] : [] },
      taskId: r.id,
      clientName: r.client_name ?? null,
      departmentId: r.department_id ?? null
    })
  );
}

// Same predicate as fbProofBucket: the task sits in pending_approval. The
// proof's submitted_at is when it started waiting (a resubmit overwrites it);
// without an fb_proof row, last_activity_at is a lower bound.
async function fbProofItems(signal: AbortSignal | undefined): Promise<PendingItem[]> {
  const tasks = await pageAll<{ id: string; title: string; assignee_id: string | null; last_activity_at: string; department_id: string | null; client_name: string | null }>(
    "tasks",
    () => from("tasks", "id,title,assignee_id,last_activity_at,department_id,client_name").eq("status", "pending_approval").is("deleted_at", null),
    { signal }
  );
  const proofs = await pageAllByIds<{ task_id: string; submitted_by: string | null; submitted_at: string | null }>(
    "fb_proof",
    tasks.map((t) => t.id),
    (chunk) => from("fb_proof", "task_id,submitted_by,submitted_at").in("task_id", chunk),
    { signal, orderBy: ["task_id"] }
  );
  const proofByTask = new Map(proofs.map((p) => [p.task_id, p]));
  return tasks.map((t) => {
    const proof = proofByTask.get(t.id);
    const submittedBy = proof?.submitted_by ?? null;
    const submittedAt = typeof proof?.submitted_at === "string" ? proof.submitted_at : null;
    return pendingItem({
      mechanism: "fb_proofs",
      id: t.id,
      title: t.title,
      requesterId: submittedBy ?? t.assignee_id ?? null,
      waitingSince: submittedAt ?? t.last_activity_at,
      waitingSinceIsLowerBound: submittedAt === null,
      approver: { kind: "fb_managers_or_leaders", excludeUserId: submittedBy },
      taskId: t.id,
      clientName: t.client_name ?? null,
      departmentId: t.department_id ?? null
    });
  });
}

/**
 * An email draft's client name, or null. DD's email intake writes the
 * SENDER'S ADDRESS into email_drafts.client_name when it couldn't match the
 * sender to a client (src/lib/email-intake.ts, `clientName ?? fromEmail`), so
 * the column is trusted only when the draft is linked to a client row and the
 * name holds no "@" (C19: an approval item never carries a mail address).
 */
function emailDraftClientName(d: { client_id: string | null; client_name: string | null }): string | null {
  if (typeof d.client_id !== "string" || d.client_id === "") return null;
  if (typeof d.client_name !== "string") return null;
  const name = d.client_name.trim();
  return name === "" || name.includes("@") ? null : name;
}

// Same predicate and waiting rule as emailDraftBucket. Never the subject, the
// body or the recipients: the title is a fixed label (C19).
async function emailDraftItems(signal: AbortSignal | undefined): Promise<PendingItem[]> {
  const drafts = await pageAll<{ id: string; author_id: string; client_id: string | null; client_name: string | null; department_id: string | null; created_at: string }>(
    "email_drafts",
    () => from("email_drafts", "id,author_id,client_id,client_name,department_id,created_at").eq("status", "pending").is("dismissed_at", null),
    { signal }
  );
  const waitingSince = new Map(drafts.map((d) => [d.id, d.created_at]));
  for (const chunk of chunked(drafts.map((d) => d.id))) {
    const resubmits = await pageAll<{ draft_id: string; created_at: string }>(
      "email_draft_events",
      () => from("email_draft_events", "draft_id,created_at").eq("type", "resubmitted").in("draft_id", chunk),
      { signal }
    );
    for (const e of resubmits) {
      const since = waitingSince.get(e.draft_id);
      if (since !== undefined && Date.parse(e.created_at) > Date.parse(since)) waitingSince.set(e.draft_id, e.created_at);
    }
  }
  return drafts.map((d) => {
    const client = emailDraftClientName(d);
    return pendingItem({
      mechanism: "email_drafts",
      id: d.id,
      title: client === null ? "Email draft" : `Email draft for ${client}`,
      requesterId: d.author_id ?? null,
      waitingSince: waitingSince.get(d.id) ?? d.created_at,
      waitingSinceIsLowerBound: false,
      approver: { kind: "email_approvers_or_department_head", departmentId: d.department_id ?? null },
      taskId: null,
      clientName: client,
      departmentId: d.department_id ?? null
    });
  });
}

// Same predicate as approvalBucket("unrouted_mail"). Never the classifier
// output, reason or thread: the title is a fixed label (C19).
async function unroutedMailItems(signal: AbortSignal | undefined): Promise<PendingItem[]> {
  const rows = await pageAll<{ id: string; created_at: string }>(
    "routing_decisions",
    () => from("routing_decisions", "id,created_at").eq("needs_review", true).is("task_id", null),
    { signal }
  );
  return rows.map((r) =>
    pendingItem({
      mechanism: "unrouted_mail",
      id: r.id,
      title: "Email waiting to be routed",
      requesterId: null,
      waitingSince: r.created_at,
      waitingSinceIsLowerBound: false,
      approver: { kind: "leaders_or_any_department_head" },
      taskId: null,
      clientName: null,
      departmentId: null
    })
  );
}

// Same predicate as approvalBucket("eod_reviews"). A department head may
// review the EODs of anyone in a department they head (eod/review route), so
// the approver names the author's departments, primary first.
async function eodReviewItems(now: Date, signal: AbortSignal | undefined): Promise<PendingItem[]> {
  const windowStart = addDaysToYmd(eodToday(now), -(EOD_REVIEW_WINDOW_DAYS - 1));
  const notes = await pageAll<{ id: string; user_id: string; note_date: string; submitted_at: string }>(
    "eod_notes",
    () =>
      from("eod_notes", "id,user_id,note_date,submitted_at").not("submitted_at", "is", null).is("reviewed_at", null).gte("note_date", windowStart),
    { signal }
  );
  const memberships = await pageAllByIds<MembershipRow>(
    "department_members",
    notes.map((n) => n.user_id),
    (chunk) => from("department_members", "user_id,department_id").in("user_id", chunk),
    { signal, orderBy: ["created_at", "department_id", "user_id"] }
  );
  const departmentsOf = new Map<string, string[]>();
  for (const m of memberships) {
    const list = departmentsOf.get(m.user_id);
    if (list) list.push(m.department_id);
    else departmentsOf.set(m.user_id, [m.department_id]);
  }
  return notes.map((n) => {
    const departmentIds = departmentsOf.get(n.user_id) ?? [];
    return pendingItem({
      mechanism: "eod_reviews",
      id: n.id,
      title: `EOD for ${n.note_date}`,
      requesterId: n.user_id,
      waitingSince: n.submitted_at,
      waitingSinceIsLowerBound: false,
      approver: { kind: "leaders_or_department_heads", departmentIds },
      taskId: null,
      clientName: null,
      departmentId: departmentIds[0] ?? null
    });
  });
}

/**
 * S5, raw: what waits on one approval mechanism, as items, oldest waiting
 * first (an unknown wait last), at most `limit` (1-200, default 50). `total`
 * counts everything pending under getPendingApprovals' own predicate, so it
 * equals that bucket's count on the same rows. Check-ins stay count-only:
 * each message carries its draft text. Titles are task titles or fixed
 * labels (C19), never mail content. Importable only by intake-screen.ts
 * (boundary rule 15): consumers call listScreenedApprovalItems, which
 * withholds tasks that come from restricted mail.
 */
export async function listPendingApprovalItems(
  principal: ExecPrincipal,
  mechanism: ApprovalMechanism,
  now: Date,
  opts: DdReadOptions & { limit?: number } = {}
): Promise<ApprovalItemList> {
  requirePrincipal(principal);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("sources/dd: now must be a valid Date");
  const limit = opts.limit ?? DEFAULT_APPROVAL_ITEMS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_APPROVAL_ITEMS) {
    throw new TypeError(`sources/dd: limit must be 1-${MAX_APPROVAL_ITEMS}`);
  }
  const { signal } = opts;
  if (mechanism === "checkins") {
    const bucket = await checkinBucket(principal, now, eodToday(now), signal);
    return { mechanism, mode: "count_only", items: [], total: bucket.count, truncated: false };
  }
  let rows: PendingItem[];
  switch (mechanism) {
    case "draft_tasks":
      rows = await draftTaskItems(signal);
      break;
    case "fb_proofs":
      rows = await fbProofItems(signal);
      break;
    case "email_drafts":
      rows = await emailDraftItems(signal);
      break;
    case "unrouted_mail":
      rows = await unroutedMailItems(signal);
      break;
    case "eod_reviews":
      rows = await eodReviewItems(now, signal);
      break;
    default:
      throw new TypeError("sources/dd: unknown approval mechanism");
  }
  rows.sort((a, b) => a.sortMs - b.sortMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const items = rows.slice(0, limit).map(({ sortMs, ...item }) => {
    void sortMs;
    return item;
  });
  return { mechanism, mode: "items", items, total: rows.length, truncated: rows.length > items.length };
}

// ---------------------------------------------------------------------------
// P7a (contract §3.6.4; Area D): the Slack-related DD reads the never-watch
// classifier's context needs. Same rules as above (explicit columns, fail
// closed with DdReadError). The lead-channel names are Slack metadata: they
// never reach an error message or a log line (B-P7a-1), so a failure names
// only the table and the database's own code.
// ---------------------------------------------------------------------------

const SLACK_CHANNEL_ID = /^[CG][A-Z0-9]{2,30}$/;
const SLACK_DM_OR_CHANNEL_ID = /^[CDG][A-Z0-9]{2,30}$/;
const SLACK_CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;
/** The newest daily_briefings rows read for the DD bot's DM ids (the five distinct ones come from these). */
const BRIEFING_ROWS_READ = 200;
const DD_BOT_DM_IDS_MAX = 5;

/** A Supabase error's own code (never its message: a message may quote a value). */
function codeOf(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,20}$/.test(code) ? code : "error";
}

/** RPC exec_slack_fb_lead_channels() (§2.9.1). Any error → DdReadError (discovery aborts). The only exec caller of that function. */
export async function listFbLeadChannels(principal: ExecPrincipal, opts?: DdReadOptions): Promise<{ name: string | null; channelId: string | null }[]> {
  void principal;
  let query = getSupabaseAdmin().rpc("exec_slack_fb_lead_channels");
  if (opts?.signal) query = query.abortSignal(opts.signal);
  const { data, error } = await query;
  if (error) throw new DdReadError("exec_slack_fb_lead_channels", codeOf(error));
  if (!Array.isArray(data)) throw new DdReadError("exec_slack_fb_lead_channels", "the response carried no rows");
  const out: { name: string | null; channelId: string | null }[] = [];
  for (const row of data as unknown[]) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as { name?: unknown; channel_id?: unknown };
    const name = typeof r.name === "string" && SLACK_CHANNEL_NAME.test(r.name) ? r.name : null;
    const channelId = typeof r.channel_id === "string" && SLACK_CHANNEL_ID.test(r.channel_id) ? r.channel_id : null;
    if (name !== null || channelId !== null) out.push({ name, channelId });
  }
  return out;
}
/** workspace_settings: client_email_channel_id where id = 'workspace' (20260814000000_client_email_slack_notifs.sql:12-21). */
export async function getClientEmailChannelId(principal: ExecPrincipal, opts?: DdReadOptions): Promise<string | null> {
  void principal;
  let query = from("workspace_settings", "client_email_channel_id").eq("id", "workspace").limit(1);
  if (opts?.signal) query = query.abortSignal(opts.signal);
  const { data, error } = await query;
  if (error) throw new DdReadError("workspace_settings", codeOf(error));
  if (!Array.isArray(data)) throw new DdReadError("workspace_settings", "the response carried no rows");
  const raw = (data[0] as { client_email_channel_id?: unknown } | undefined)?.client_email_channel_id;
  const id = typeof raw === "string" ? raw.trim() : "";
  return SLACK_CHANNEL_ID.test(id) ? id : null;
}
/** daily_briefings: distinct non-null slack_channel (20260831000000_daily_briefing.sql:20), newest 5 by created_at. */
export async function listDdBotDmChannelIds(principal: ExecPrincipal, opts?: DdReadOptions): Promise<string[]> {
  void principal;
  let query = from("daily_briefings", "slack_channel,created_at")
    .not("slack_channel", "is", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(BRIEFING_ROWS_READ);
  if (opts?.signal) query = query.abortSignal(opts.signal);
  const { data, error } = await query;
  if (error) throw new DdReadError("daily_briefings", codeOf(error));
  if (!Array.isArray(data)) throw new DdReadError("daily_briefings", "the response carried no rows");
  const out: string[] = [];
  for (const row of data as { slack_channel?: unknown }[]) {
    const id = typeof row?.slack_channel === "string" ? row.slack_channel.trim() : "";
    if (!SLACK_DM_OR_CHANNEL_ID.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= DD_BOT_DM_IDS_MAX) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// P7b (§3.13). Stage 0: compile-only stubs with the frozen signatures; Area B writes listEodSlackAnchors, Area E the other
// three, in separate blocks (the integrator merges). All four throw DdReadError with the table name only.
// ---------------------------------------------------------------------------

// (B) The Scaled Team anchors (C4, N18). Exactly these six columns of eod_client_updates and eod_client_checkins: a post's ids,
// its client and where it landed in Slack. Never message or subject (P5b rule 2, B-P7b-5): the correlator needs only to know
// which client a (channel, ts) post named. The two tables share the column list.
const EOD_ANCHOR_COLS = "id,client_id,client_name,slack_channel,slack_ts,sent_at";
const EOD_ANCHOR_ORDER = ["sent_at", "id"] as const;
/** The verdict tables' channel id CHECK (§2.1.2) and a Slack ts (§2.1.3). */
const ANCHOR_CHANNEL_ID = /^[CGD][A-Z0-9]{2,30}$/;
const ANCHOR_TS = /^[0-9]{1,12}\.[0-9]{1,8}$/;

interface EodAnchorRow {
  id: unknown;
  client_id: unknown;
  client_name: unknown;
  slack_channel: unknown;
  slack_ts: unknown;
  sent_at: unknown;
}

/** pageAll's loop with the database's code in the error, never its message (a message may quote a value). */
async function pageAnchors(table: string, build: () => Query, signal: AbortSignal | undefined): Promise<EodAnchorRow[]> {
  const rows: EodAnchorRow[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let query = build();
    for (const column of EOD_ANCHOR_ORDER) query = query.order(column, { ascending: true });
    query = query.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw new DdReadError(table, codeOf(error));
    if (!Array.isArray(data)) throw new DdReadError(table, "the response carried no rows");
    for (const row of data) rows.push(row as unknown as EodAnchorRow);
    if (data.length < PAGE_SIZE) return rows;
  }
  throw new DdReadError(table, `too many rows (more than ${MAX_PAGES * PAGE_SIZE})`);
}

function anchorOf(source: DdEodSlackAnchor["source"], r: EodAnchorRow): DdEodSlackAnchor | null {
  if (typeof r?.id !== "string" || r.id.length === 0) return null;
  if (typeof r.client_name !== "string" || typeof r.slack_channel !== "string" || typeof r.slack_ts !== "string" || typeof r.sent_at !== "string") return null;
  const slackChannel = r.slack_channel.trim();
  const slackTs = r.slack_ts.trim();
  if (!ANCHOR_CHANNEL_ID.test(slackChannel) || !ANCHOR_TS.test(slackTs) || !Number.isFinite(Date.parse(r.sent_at))) return null;
  const clientId = typeof r.client_id === "string" && r.client_id.length > 0 ? r.client_id : null;
  return { source, id: r.id, clientId, clientName: r.client_name, slackChannel, slackTs, sentAt: r.sent_at };
}

/** (B) Scaled Team anchors (C4). Columns exactly: id, client_id, client_name, slack_channel, slack_ts, sent_at from eod_client_updates
 *  and eod_client_checkins where slack_ts is not null and sent_at >= since; paged by (sent_at, id). Never message or subject.
 *  Updates first, then check-ins, each oldest first; a row without a usable channel id or ts is left out. A failed read
 *  throws DdReadError naming the table and the database's code only. */
export async function listEodSlackAnchors(principal: ExecPrincipal, sinceIso: string, opts: DdReadOptions = {}): Promise<DdEodSlackAnchor[]> {
  requirePrincipal(principal);
  const since = isoParam("sinceIso", sinceIso);
  const updates = await pageAnchors(
    "eod_client_updates",
    () => from("eod_client_updates", EOD_ANCHOR_COLS).not("slack_ts", "is", null).not("slack_channel", "is", null).gte("sent_at", since),
    opts.signal
  );
  const checkins = await pageAnchors(
    "eod_client_checkins",
    () => from("eod_client_checkins", EOD_ANCHOR_COLS).not("slack_ts", "is", null).not("slack_channel", "is", null).gte("sent_at", since),
    opts.signal
  );
  const out: DdEodSlackAnchor[] = [];
  for (const r of updates) {
    const a = anchorOf("update", r);
    if (a !== null) out.push(a);
  }
  for (const r of checkins) {
    const a = anchorOf("checkin", r);
    if (a !== null) out.push(a);
  }
  return out;
}

// (E) P7b prepare_client_update and its pack slots (§3.13, N17, C11). Ids, enums, dates and counts only: never
// email_drafts.subject / body_text / body_html / rejection_note, never eod_client_work.worked_on / results (the one
// reader of those is sources/dd-text.ts), never eod_client_updates / eod_client_checkins text (P5b rule 2, B-P7b-5).
// A failed read throws DdReadError naming the table and the database's code only.
const COMPLETED_FOR_CLIENT_MAX = 50;
const CLIENT_UPDATE_EMAIL_KINDS = ["client_update", "eod_digest"] as const;

/** A timestamp column as an ISO instant, or null (anything that doesn't parse reads as null: the value is a hint). */
function instantOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The newest non-null value of one timestamp column among the rows `build` selects (limit 1, newest first), or null. */
async function newestInstant(table: string, column: string, build: () => Query, signal: AbortSignal | undefined): Promise<string | null> {
  let query = build().not(column, "is", null).order(column, { ascending: false }).limit(1);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw new DdReadError(table, codeOf(error));
  if (!Array.isArray(data)) throw new DdReadError(table, "the response carried no rows");
  const first: unknown = data[0];
  return typeof first === "object" && first !== null ? instantOrNull((first as Record<string, unknown>)[column]) : null;
}

/** (E) P2b's task columns (TASK_COLUMNS), completed_at >= since, client_name = clientName (exact), deleted_at is null,
 *  is_draft = false; newest completion first; ≤ 50. Also status = 'done' (as listTasksCompletedBetween): a reopened task
 *  that kept its completed_at is not finished work. An empty name reads nothing. */
export async function listCompletedTasksForClient(principal: ExecPrincipal, clientName: string, sinceIso: string, opts: DdReadOptions = {}): Promise<DdTask[]> {
  requirePrincipal(principal);
  const since = isoParam("sinceIso", sinceIso);
  if (typeof clientName !== "string" || clientName.trim() === "") return [];
  let query = from("tasks", TASK_COLS)
    .eq("client_name", clientName)
    .eq("status", "done")
    .gte("completed_at", since)
    .eq("is_draft", false)
    .is("deleted_at", null)
    .order("completed_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(COMPLETED_FOR_CLIENT_MAX);
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { data, error } = await query;
  if (error) throw new DdReadError("tasks", codeOf(error));
  if (!Array.isArray(data)) throw new DdReadError("tasks", "the response carried no rows");
  return (data as unknown as TaskRow[]).map(taskFromRow);
}

/** (E) email_drafts.sent_at (client_id = id, status = 'sent', kind in ('client_update','eod_digest'), newest, limit 1);
 *  max(eod_client_work.reported_to_client_at) for client_name; max(tasks.reported_to_client_at) for client_name. Timestamps only.
 *  workReportedAt is the later of the two reported_to_client_at values. An empty id or name skips its reads (null). */
export async function getLastClientUpdate(principal: ExecPrincipal, client: { clientId: string; clientName: string }, opts: DdReadOptions = {}):
  Promise<{ teamEmailSentAt: string | null; workReportedAt: string | null }> {
  requirePrincipal(principal);
  const clientId = typeof client?.clientId === "string" ? client.clientId : "";
  const clientName = typeof client?.clientName === "string" ? client.clientName : "";
  const signal = opts.signal;
  const teamEmailSentAt = clientId === ""
    ? null
    : await newestInstant("email_drafts", "sent_at", () =>
      from("email_drafts", "sent_at").eq("client_id", clientId).eq("status", "sent").in("kind", [...CLIENT_UPDATE_EMAIL_KINDS]), signal);
  if (clientName.trim() === "") return { teamEmailSentAt, workReportedAt: null };
  const work = await newestInstant("eod_client_work", "reported_to_client_at", () =>
    from("eod_client_work", "reported_to_client_at").eq("client_name", clientName), signal);
  const tasks = await newestInstant("tasks", "reported_to_client_at", () =>
    from("tasks", "reported_to_client_at").eq("client_name", clientName), signal);
  const workReportedAt = work === null ? tasks : tasks === null ? work : (Date.parse(work) >= Date.parse(tasks) ? work : tasks);
  return { teamEmailSentAt, workReportedAt };
}

/** (E) count of eod_client_work rows (select "id", head count) for client_name with note_date >= sinceDate. Entries the team
 *  discarded (dismissed_at set, DD's own discard) are not work to report and don't count. An empty name counts 0. */
export async function countEodClientWorkForClient(principal: ExecPrincipal, clientName: string, sinceDate: string, opts: DdReadOptions = {}): Promise<number> {
  requirePrincipal(principal);
  const since = ymdParam("sinceDate", sinceDate);
  if (typeof clientName !== "string" || clientName.trim() === "") return 0;
  let query = from("eod_client_work", "id", HEAD_COUNT).eq("client_name", clientName).gte("note_date", since).is("dismissed_at", null);
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { count, error } = await query;
  if (error) throw new DdReadError("eod_client_work", codeOf(error));
  if (typeof count !== "number") throw new DdReadError("eod_client_work", "the response carried no count");
  return count;
}
