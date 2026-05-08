// Server-only DB-backed counterparts to the helpers in src/lib/mock-data.ts.
// Backend (API routes, server components) should call these instead of
// reading from mock-data — that file is being kept around for the UI pages
// that haven't been ported yet, but is no longer the source of truth on the
// server.

import { cache } from "react";
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
    avatarUrl: row.avatar_url ?? undefined
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
    actualHours: Number(row.actual_hours),
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
    custom: row.custom ?? {}
  };
}

// Wrapped in React.cache so the layout + a child page asking for the same
// user only hit Supabase once per request.
export const getUserById = cache(_getUserById);

async function _getUserById(id: string | null | undefined): Promise<User | null> {
  if (!id) return null;
  const supabase = getSupabaseAdmin();
  const { data: row } = await supabase
    .from("users")
    .select("id,name,email,role,daily_capacity,throughput,skills,avatar_url")
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
  "id,title,description,status,priority,estimated_hours,actual_hours,tags," +
  "department_id,assignee_id,creator_id,project_id,due_date,inactive_flag," +
  "last_activity_at,created_at,blocks_task_ids,client_name,website," +
  "client_email,client_folder_url,staging_server,markup_link,hosting_access," +
  "missive_thread_url,custom";

export async function getAllTasks(): Promise<Task[]> {
  const { data } = await getSupabaseAdmin()
    .from("tasks")
    .select(TICKET_COLS);
  return (data ?? []).map((r) => taskFromRow(r as unknown as TaskRow));
}

// Lightweight users-list, used when components only need to render avatars +
// names (e.g. handoff dropdown, thread author resolution). Skips the
// per-user department-members join.
export async function getAllUsersLight(): Promise<User[]> {
  const { data } = await getSupabaseAdmin()
    .from("users")
    .select("id,name,email,role,daily_capacity,throughput,skills,avatar_url")
    .order("name");
  return (data ?? []).map((r) =>
    userFromRow(r as UserRow, [])
  );
}
