import "server-only";

import { addDaysToYmd, eodToday } from "@/lib/shift";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type {
  ApprovalBucket,
  ApprovalMechanism,
  ClientHealthLabel,
  DdActivity,
  DdClient,
  DdDepartment,
  DdEodNote,
  DdIncidentLog,
  DdProject,
  DdProjectStage,
  DdSiteHealthAlert,
  DdStatusEntry,
  DdTask,
  DdTaskExtension,
  DdTaskMessage,
  DdTaskNotification,
  DdTimeEntry,
  DdUser,
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
async function checkinBucket(etToday: string, signal: AbortSignal | undefined): Promise<ApprovalBucket> {
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
 *   checkins       pending messages on today's (ET) daily brief
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
    checkinBucket(etToday, signal)
  ]);
}
