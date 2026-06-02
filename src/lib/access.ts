// Centralized authorization helpers. Pages and API routes call these
// instead of open-coding role checks so we have one place to evolve
// the access model (e.g. when we add department-scoped department-head
// powers, or per-resource ACLs).
//
// Conventions:
//   - "is...": pure role membership predicates (no resource context).
//   - "can...": resource-aware predicates that take the actor + the
//     resource shape they're trying to touch.
//   - Everything is server-side safe (no client-only refs); some
//     helpers also work client-side via the same shape.

import type { Task, User } from "@/lib/types";

// Stealth admin: a user whose public role is anything (typically
// worker) but who has been flagged in the DB as having leader-level
// authority. Surfaced here so every permission gate in the app can
// treat them as a leader without the UI having to know.
export function isAdmin(u: Pick<User, "isAdmin"> | null | undefined): boolean {
  return !!u && u.isAdmin === true;
}

// "Leader for permission purposes." Returns true for both real
// leaders and stealth admins. UI code that wants to render the role
// label / crown should check `u.role === "leader"` directly instead.
export function isLeader(u: Pick<User, "role" | "isAdmin"> | null | undefined): boolean {
  return !!u && (u.role === "leader" || u.isAdmin === true);
}

export function isDepartmentHead(u: Pick<User, "role"> | null | undefined): boolean {
  return !!u && u.role === "department_head";
}

export function isWorker(u: Pick<User, "role"> | null | undefined): boolean {
  return !!u && u.role === "worker";
}

// Department head — but only for the departments they're a member of.
// Heads can lead multiple departments; workers are members but not
// heads. The shape we care about is just (role, departmentIds).
export function leadsDepartment(
  u: Pick<User, "role" | "departmentIds"> | null | undefined,
  departmentId: string | null | undefined
): boolean {
  if (!u || !departmentId) return false;
  if (!isDepartmentHead(u)) return false;
  return u.departmentIds.includes(departmentId);
}

// "Can manage" = can act on the resource at administrative level
// (create / edit settings / close / reassign).

export function canManageTask(
  actor: User | null | undefined,
  task: Pick<Task, "creatorId" | "assigneeId" | "departmentId"> | null | undefined
): boolean {
  if (!actor || !task) return false;
  if (isLeader(actor)) return true;
  if (leadsDepartment(actor, task.departmentId)) return true;
  if (actor.id === task.assigneeId) return true;
  if (actor.id === task.creatorId) return true;
  return false;
}

// "Can delete" is deliberately STRICTER than canManageTask. Deletion is
// destructive and outside the normal task lifecycle, so it's restricted to
// admins/leaders (any task) and department heads (tasks in a department they
// lead). Note this intentionally does NOT grant the assignee or creator
// delete rights the way canManageTask does — a worker can't delete tasks
// just because they own or were assigned one. Soft delete is recoverable by
// admins, so this gate only governs who can initiate a deletion.
export function canDeleteTask(
  actor: User | null | undefined,
  task: Pick<Task, "departmentId"> | null | undefined
): boolean {
  if (!actor || !task) return false;
  if (isLeader(actor)) return true;
  if (leadsDepartment(actor, task.departmentId)) return true;
  return false;
}

export function canManageProject(
  actor: User | null | undefined,
  project: { departmentId: string | null } | null | undefined
): boolean {
  if (!actor || !project) return false;
  if (isLeader(actor)) return true;
  if (leadsDepartment(actor, project.departmentId)) return true;
  return false;
}

// View access for the department-scoped consoles (SEO console, Website
// console, Software console — to be built). The leader sees all;
// department heads and workers see consoles for their own department(s).
export function canViewDepartmentConsole(
  actor: User | null | undefined,
  departmentId: string | null | undefined
): boolean {
  if (!actor || !departmentId) return false;
  if (isLeader(actor)) return true;
  return actor.departmentIds.includes(departmentId);
}

// Can `actor` see this task at all? Used to gate the detail page and
// every /api/tasks/[id]/* endpoint. Leader-owned (assigned-to-leader or
// created-by-leader) tasks are invisible to non-leaders unless they
// happen to be the assignee themselves.
export function canViewTask(
  actor: User | null | undefined,
  task: Pick<Task, "creatorId" | "assigneeId" | "departmentId"> | null | undefined,
  leaderIds: Set<string>
): boolean {
  if (!actor || !task) return false;
  if (isLeader(actor)) return true;
  // The viewer's own work is always visible to themselves, regardless of
  // whether a leader created it.
  if (task.assigneeId === actor.id) return true;
  if (task.creatorId === actor.id) return true;
  // Anything touched by a leader (assignee or creator) is hidden from
  // non-leaders.
  if (task.assigneeId && leaderIds.has(task.assigneeId)) return false;
  if (task.creatorId && leaderIds.has(task.creatorId)) return false;
  return true;
}

// Stricter task visibility used by Ask AI. Layers DEPARTMENT SCOPING on
// top of canViewTask's leader-privacy rules: a non-leader only sees tasks
// belonging to one of their own departments — except their own
// assigned/created work, which is always visible to them. Leaders/admins
// see everything.
//
// A task with no department is treated as outside every department, so a
// non-leader only sees it if it's their own work. This is intentionally
// stricter than the rest of the app: /api/tasks GET and global search do
// NOT department-scope task lists (they apply leader-privacy only). The
// AI assistant uses this gate so department-scoped questions ("what's
// overdue for my team?", per-client task counts) can't surface another
// team's work. Pass the same leaderIds set canViewTask expects.
export function canViewTaskScopedToDepartment(
  actor: User | null | undefined,
  task: Pick<Task, "creatorId" | "assigneeId" | "departmentId"> | null | undefined,
  leaderIds: Set<string>
): boolean {
  if (!actor || !task) return false;
  if (isLeader(actor)) return true;
  // The viewer's own work is always visible to themselves, regardless of
  // department or who created it (mirrors canViewTask).
  if (task.assigneeId === actor.id) return true;
  if (task.creatorId === actor.id) return true;
  // Leader-owned work (assignee or creator) stays private to leaders.
  if (task.assigneeId && leaderIds.has(task.assigneeId)) return false;
  if (task.creatorId && leaderIds.has(task.creatorId)) return false;
  // Department scoping: the task must live in one of the actor's
  // departments. No department → outside every team → hidden.
  if (!task.departmentId) return false;
  return actor.departmentIds.includes(task.departmentId);
}

// Notify-teammates affordance: anyone with skin in the task's game
// can broadcast. Keeps the head from being the only one who can rally
// support for a task they're stuck on.
export function canNotifyOnTask(
  actor: User | null | undefined,
  task: Pick<Task, "creatorId" | "assigneeId" | "departmentId"> | null | undefined
): boolean {
  return canManageTask(actor, task);
}

// Project creation is gated to the leader + any department head (the
// head can only create projects within their own department; the route
// still enforces departmentId membership for non-leader callers).
export function canCreateProject(actor: User | null | undefined): boolean {
  if (!actor) return false;
  return isLeader(actor) || isDepartmentHead(actor);
}

// Can `actor` create a task in `departmentId`? Leaders/admins create in
// any department (and may leave it unset for cross-team/unassigned work).
// Everyone else — workers AND department heads — is scoped to the
// department(s) they belong to. A non-leader with no department can't
// create anywhere (the caller surfaces a "no department assigned" error).
// This is the single source of truth the /api/tasks route enforces; the
// NewTaskForm mirrors it in the UI but is NOT trusted on its own.
export function canCreateTaskInDepartment(
  actor: Pick<User, "role" | "isAdmin" | "departmentIds"> | null | undefined,
  departmentId: string | null | undefined
): boolean {
  if (!actor) return false;
  if (isLeader(actor)) return true;
  if (!departmentId) return false;
  return actor.departmentIds.includes(departmentId);
}

// Can `actor` assign a task to `target`? Server-side mirror of
// assignableTargets() in auth.ts (which drives the New-task form's picker):
//   - leaders/admins → anyone,
//   - department heads → anyone whose home is one of their departments (+ self),
//   - workers → themselves + their direct reports (manager_user_id === actor).
// Everyone can always assign to themselves. The /api/tasks route enforces
// this for non-leaders; the widget/form picker is convenience, not the gate.
export function canAssignTaskTo(
  actor: Pick<User, "id" | "role" | "isAdmin" | "departmentIds"> | null | undefined,
  target: Pick<User, "id" | "departmentIds" | "managerId"> | null | undefined
): boolean {
  if (!actor || !target) return false;
  if (target.id === actor.id) return true; // always allowed to self-assign
  if (isLeader(actor)) return true;
  if (isDepartmentHead(actor)) {
    return target.departmentIds.some((d) => actor.departmentIds.includes(d));
  }
  // Workers: only their own direct reports.
  return target.managerId === actor.id;
}
