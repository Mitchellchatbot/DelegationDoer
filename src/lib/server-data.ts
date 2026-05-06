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
    website: row.website
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
  "last_activity_at,created_at,blocks_task_ids,client_name,website";

export async function getAllTasks(): Promise<Task[]> {
  const { data } = await getSupabaseAdmin()
    .from("tasks")
    .select(TICKET_COLS);
  return (data ?? []).map((r) => taskFromRow(r as unknown as TaskRow));
}
