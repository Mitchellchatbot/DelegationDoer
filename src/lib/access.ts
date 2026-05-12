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

export function isCeo(u: Pick<User, "role"> | null | undefined): boolean {
  return !!u && u.role === "ceo";
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
  if (isCeo(actor)) return true;
  if (leadsDepartment(actor, task.departmentId)) return true;
  if (actor.id === task.assigneeId) return true;
  if (actor.id === task.creatorId) return true;
  return false;
}

export function canManageProject(
  actor: User | null | undefined,
  project: { departmentId: string | null } | null | undefined
): boolean {
  if (!actor || !project) return false;
  if (isCeo(actor)) return true;
  if (leadsDepartment(actor, project.departmentId)) return true;
  return false;
}

// View access for the department-scoped consoles (SEO console, Website
// console, Software console — to be built). CEO sees all; department
// heads and workers see consoles for their own department(s).
export function canViewDepartmentConsole(
  actor: User | null | undefined,
  departmentId: string | null | undefined
): boolean {
  if (!actor || !departmentId) return false;
  if (isCeo(actor)) return true;
  return actor.departmentIds.includes(departmentId);
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

// Project creation is gated to CEO + any department head (head can
// only create projects within their own department; the route still
// enforces departmentId membership for non-CEO callers).
export function canCreateProject(actor: User | null | undefined): boolean {
  if (!actor) return false;
  return isCeo(actor) || isDepartmentHead(actor);
}
