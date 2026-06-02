import type { Department, User } from "./types";
import { users } from "./mock-data";

export const ROLE_LABELS: Record<User["role"], string> = {
  leader: "Leader",
  department_head: "Department Head",
  worker: "Worker"
};

export function isLeader(u: User | null | undefined): boolean {
  // Stealth admins (is_admin=true) are leaders for permission purposes
  // even if their public role is something else.
  return !!u && (u.role === "leader" || u.isAdmin === true);
}
export function isHead(u: User | null | undefined): boolean {
  return !!u && u.role === "department_head";
}

// Who is `actor` allowed to assign tasks to?
//   Leader -> anyone in the org (the previous "only department heads" rule
//             was too restrictive — the leader often needs to push work past
//             a head when things are on fire, or assign across teams).
//   Department head -> anyone whose home is one of their departments
//                      (workers and other heads), plus themselves.
//   Worker -> themselves + their direct reports (any user whose managerId
//             points to the actor). This lets team-leads inside a dept
//             (e.g. Bismah → Gul + Komal in the SEO sub-tree) push work
//             down without being promoted to dept_head. Workers with no
//             reports just see themselves.
// Anyone can always self-assign regardless of role.
export function assignableTargets(actor: User, pool: User[] = users): User[] {
  let candidates: User[];
  if (isLeader(actor)) {
    candidates = pool.slice();
  } else if (actor.role === "department_head") {
    candidates = pool.filter((u) =>
      u.id === actor.id || u.departmentIds.some((d) => actor.departmentIds.includes(d))
    );
  } else {
    candidates = pool.filter((u) => u.id === actor.id || u.managerId === actor.id);
  }
  return candidates.some((u) => u.id === actor.id) ? candidates : [actor, ...candidates];
}

export function canCreateTasksForOthers(actor: User): boolean {
  return isLeader(actor) || actor.role === "department_head";
}

// Which departments can `actor` create a task in? Drives the New-task
// form's Department picker. Leaders/admins get the whole org; everyone
// else (workers + department heads) is scoped to their own department(s).
// Mirrors `canCreateTaskInDepartment` in access.ts — keep the two in sync.
export function assignableDepartments(actor: User, pool: Department[]): Department[] {
  if (isLeader(actor)) return pool.slice();
  return pool.filter((d) => actor.departmentIds.includes(d.id));
}

// Can the actor pick a different department, or are they locked to their
// own? Leaders/admins + department heads may change it; workers can't.
export function canChooseDepartment(actor: User): boolean {
  return isLeader(actor) || isHead(actor);
}

export function canManagePeople(actor: User): boolean {
  return isLeader(actor);
}

export function canAddDepartments(actor: User): boolean {
  return isLeader(actor);
}
