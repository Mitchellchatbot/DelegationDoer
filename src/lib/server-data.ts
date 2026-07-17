// Server-only DB-backed counterparts to the helpers in src/lib/mock-data.ts.
// Backend (API routes, server components) should call these instead of
// reading from mock-data — that file is being kept around for the UI pages
// that haven't been ported yet, but is no longer the source of truth on the
// server.

import { cache } from "@/lib/safe-cache";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { Department, Task, User } from "@/lib/types";

// Row shapes mirror the snake_case columns in the migrations.
interface UserRow {
  id: string;
  name: string;
  email: string;
  role: User["role"];
  daily_capacity: number;
  throughput: Record<string, number>;
  skills: string[];
  avatar_url: string | null;
  is_admin?: boolean;
  work_timezone?: string | null;
  weekly_schedule?: Record<string, unknown> | null;
  manager_user_id?: string | null;
  secondary_manager_user_id?: string | null;
  delegate_department_ids?: string[] | null;
  email_notifications_onboarded?: boolean;
  daily_prompts_enabled?: boolean;
  daily_prompts_required?: boolean;
  clock_enabled?: boolean;
}
interface DepartmentRow {
  id: string;
  name: string;
  description: string | null;
  task_types: string[];
}
interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: Task["status"];
  priority: Task["priority"];
  estimated_hours: number;
  actual_hours: number;
  actual_hours_override: number | null;
  tags: string[];
  department_id: string | null;
  assignee_id: string | null;
  creator_id: string;
  project_id: string | null;
  due_date: string | null;
  inactive_flag: boolean;
  last_activity_at: string;
  created_at: string;
  blocks_task_ids: string[];
  client_name: string | null;
  website: string | null;
  client_email: string | null;
  client_folder_url: string | null;
  staging_server: string | null;
  markup_link: string | null;
  hosting_access: string | null;
  missive_thread_url: string | null;
  custom: Record<string, unknown> | null;
  deleted_at: string | null;
  deleted_by: string | null;
  completed_at: string | null;
  archived_at: string | null;
  archived_by: string | null;
}

async function userDepartmentIds(userId: string): Promise<string[]> {
  const { data } = await getSupabaseAdmin()
    .from("department_members")
    .select("department_id")
    .eq("user_id", userId);
  return (data ?? []).map((r: { department_id: string }) => r.department_id);
}

function userFromRow(row: UserRow, departmentIds: string[]): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    departmentIds,
    skills: row.skills,
    dailyCapacity: Number(row.daily_capacity),
    throughput: row.throughput ?? {},
    avatarUrl: row.avatar_url ?? undefined,
    isAdmin: row.is_admin === true,
    workTimezone: row.work_timezone ?? null,
    weeklySchedule: (row.weekly_schedule as User["weeklySchedule"]) ?? {},
    managerId: row.manager_user_id ?? null,
    secondaryManagerId: row.secondary_manager_user_id ?? null,
    delegateDepartmentIds: row.delegate_department_ids ?? [],
    emailNotificationsOnboarded: row.email_notifications_onboarded === true,
    // Defaults true at the DB level; we surface the explicit value so a
    // false in the row turns the SOD/EOD prompts off on /home + widget.
    dailyPromptsEnabled: row.daily_prompts_enabled !== false,
    // Defaults false; true force-opts a privileged account back into the
    // SOD/EOD ritual despite the leader/admin role exemption.
    dailyPromptsRequired: row.daily_prompts_required === true,
    // Defaults true at the DB level; a false here means the user doesn't
    // punch a clock (salaried/on-call) and is exempt from clock-in gates.
    clockEnabled: row.clock_enabled !== false
  };
}

function departmentFromRow(row: DepartmentRow): Department {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    taskTypes: row.task_types
  };
}

function taskFromRow(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? "",
    status: row.status,
    priority: row.priority,
    estimatedHours: Number(row.estimated_hours),
    // Override wins: if a user pinned actuals manually (off-clock work
    // etc.) that value is the truth; otherwise use the time_entries-
    // derived denorm in actual_hours.
    actualHours:
      row.actual_hours_override !== null && row.actual_hours_override !== undefined
        ? Number(row.actual_hours_override)
        : Number(row.actual_hours),
    actualHoursOverride:
      row.actual_hours_override !== null && row.actual_hours_override !== undefined
        ? Number(row.actual_hours_override)
        : null,
    tags: row.tags,
    departmentId: row.department_id,
    assigneeId: row.assignee_id,
    creatorId: row.creator_id,
    projectId: row.project_id,
    dueDate: row.due_date,
    inactiveFlag: row.inactive_flag,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    blocksTaskIds: row.blocks_task_ids,
    clientName: row.client_name,
    website: row.website,
    clientEmail: row.client_email,
    clientFolderUrl: row.client_folder_url,
    stagingServer: row.staging_server,
    markupLink: row.markup_link,
    hostingAccess: row.hosting_access,
    missiveThreadUrl: row.missive_thread_url,
    custom: row.custom ?? {},
    deletedAt: row.deleted_at ?? null,
    deletedBy: row.deleted_by ?? null,
    completedAt: row.completed_at ?? null,
    archivedAt: row.archived_at ?? null,
    archivedBy: row.archived_by ?? null
  };
}

// Wrapped in React.cache so the layout + a child page asking for the same
// user only hit Supabase once per request.
export const getUserById = cache(_getUserById);

// Cached set of leader user ids — used by access checks that need to
// hide leader-touched tasks from non-leader viewers. Once per request.
export const getLeaderIds = cache(async function _getLeaderIds(): Promise<Set<string>> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("users").select("id").eq("role", "leader");
  return new Set((data ?? []).map((u: { id: string }) => u.id));
});

async function _getUserById(id: string | null | undefined): Promise<User | null> {
  if (!id) return null;
  const supabase = getSupabaseAdmin();
  const { data: row } = await supabase
    .from("users")
    .select("id,name,email,role,daily_capacity,throughput,skills,avatar_url,is_admin,work_timezone,weekly_schedule,manager_user_id,secondary_manager_user_id,delegate_department_ids,email_notifications_onboarded,daily_prompts_enabled,daily_prompts_required,clock_enabled")
    .eq("id", id)
    .maybeSingle();
  if (!row) return null;
  const departmentIds = await userDepartmentIds(id);
  return userFromRow(row as UserRow, departmentIds);
}

export const getDepartments = cache(_getDepartments);

async function _getDepartments(): Promise<Department[]> {
  const { data } = await getSupabaseAdmin()
    .from("departments")
    .select("id,name,description,task_types")
    .order("name");
  return (data ?? []).map((r) => departmentFromRow(r as DepartmentRow));
}

export async function getDepartmentById(id: string | null | undefined): Promise<Department | null> {
  if (!id) return null;
  const { data } = await getSupabaseAdmin()
    .from("departments")
    .select("id,name,description,task_types")
    .eq("id", id)
    .maybeSingle();
  return data ? departmentFromRow(data as DepartmentRow) : null;
}

const TICKET_COLS =
  "id,title,description,status,priority,estimated_hours,actual_hours,actual_hours_override,tags," +
  "department_id,assignee_id,creator_id,project_id,due_date,inactive_flag," +
  "last_activity_at,created_at,blocks_task_ids,client_name,website," +
  "client_email,client_folder_url,staging_server,markup_link,hosting_access," +
  "missive_thread_url,custom,deleted_at,deleted_by,completed_at,archived_at,archived_by";

export async function getAllTasks(opts?: { includeDrafts?: boolean; includeDeleted?: boolean; includeArchived?: boolean }): Promise<Task[]> {
  let q = getSupabaseAdmin()
    .from("tasks")
    .select(TICKET_COLS);
  if (!opts?.includeDrafts) q = q.eq("is_draft", false);
  // Soft-deleted tasks are hidden from every normal read path. This is the
  // single chokepoint all task lists funnel through, so excluding them here
  // makes them vanish app-wide (board, mine, search, etc.) in one place.
  if (!opts?.includeDeleted) q = q.is("deleted_at", null);
  // Archived tasks are likewise hidden from the active lists by default —
  // same chokepoint, so an archived done task drops off the board, /mine,
  // and search at once. They stay reachable on the Archived view (which
  // passes includeArchived) and remain in analytics (which read tasks
  // directly, not through here) so completion history isn't lost.
  if (!opts?.includeArchived) q = q.is("archived_at", null);
  const { data } = await q;
  return (data ?? []).map((r) => taskFromRow(r as unknown as TaskRow));
}

// Soft-deleted tasks, newest first — for the admin recovery view. Includes
// drafts (a deleted draft is still recoverable) and only returns rows that
// have actually been soft-deleted.
export async function getDeletedTasks(): Promise<Task[]> {
  const { data } = await getSupabaseAdmin()
    .from("tasks")
    .select(TICKET_COLS)
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false });
  return (data ?? []).map((r) => taskFromRow(r as unknown as TaskRow));
}

// Archived tasks, most-recently-archived first — for the Archived view.
// Excludes soft-deleted rows (a deleted task belongs on the Recently-deleted
// view, not here, even if it was archived first) so a task never shows up in
// both places. Drafts are excluded — only real, completed work gets archived.
export async function getArchivedTasks(): Promise<Task[]> {
  const { data } = await getSupabaseAdmin()
    .from("tasks")
    .select(TICKET_COLS)
    .eq("is_draft", false)
    .not("archived_at", "is", null)
    .is("deleted_at", null)
    .order("archived_at", { ascending: false });
  return (data ?? []).map((r) => taskFromRow(r as unknown as TaskRow));
}

// Lightweight users-list, used when components only need to render avatars +
// names (e.g. handoff dropdown, thread author resolution). Skips the
// per-user department-members join.
export async function getAllUsersLight(): Promise<User[]> {
  const { data } = await getSupabaseAdmin()
    .from("users")
    .select("id,name,email,role,daily_capacity,throughput,skills,avatar_url,is_admin,work_timezone,weekly_schedule,manager_user_id,secondary_manager_user_id,delegate_department_ids,email_notifications_onboarded,daily_prompts_enabled,daily_prompts_required,clock_enabled")
    .order("name");
  return (data ?? []).map((r) =>
    userFromRow(r as UserRow, [])
  );
}

// Full users-list with department membership joined in. Used by views
// that need departmentIds for filtering or routing (org chart, Leader
// console). Two queries — users + department_members — joined in memory
// so we don't fan out N+1 lookups. Errors degrade to an empty list
// rather than throwing so a missing table can't 500 the whole page.
export async function getAllUsers(): Promise<User[]> {
  const supabase = getSupabaseAdmin();
  const [usersRes, membersRes] = await Promise.all([
    supabase
      .from("users")
      .select("id,name,email,role,daily_capacity,throughput,skills,avatar_url,is_admin,work_timezone,weekly_schedule,manager_user_id,secondary_manager_user_id,delegate_department_ids,email_notifications_onboarded,daily_prompts_enabled,daily_prompts_required,clock_enabled")
      .order("name"),
    supabase
      .from("department_members")
      .select("user_id, department_id")
  ]);
  if (usersRes.error) {
    console.error("[getAllUsers] users select failed:", usersRes.error.message);
    return [];
  }
  if (membersRes.error) {
    // Members are optional — log + continue with empty membership.
    console.warn("[getAllUsers] department_members select failed:", membersRes.error.message);
  }
  const byUser = new Map<string, string[]>();
  for (const m of (membersRes.data ?? []) as { user_id: string; department_id: string }[]) {
    const arr = byUser.get(m.user_id) ?? [];
    arr.push(m.department_id);
    byUser.set(m.user_id, arr);
  }
  return ((usersRes.data ?? []) as UserRow[]).map((r) =>
    userFromRow(r, byUser.get(r.id) ?? [])
  );
}
