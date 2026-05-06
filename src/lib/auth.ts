import type { User } from "./types";
import { users } from "./mock-data";

export const ROLE_LABELS: Record<User["role"], string> = {
  ceo: "CEO",
  department_head: "Department Head",
  worker: "Worker"
};

export function isCEO(u: User | null | undefined): boolean {
  return !!u && u.role === "ceo";
}
export function isHead(u: User | null | undefined): boolean {
  return !!u && u.role === "department_head";
}

// Who is `actor` allowed to assign tasks to?
//   CEO -> anyone in the org (the previous "only department heads" rule was
//          too restrictive — CEO often needs to push work past a head when
//          things are on fire, or assign across teams).
//   Department head -> anyone whose home is one of their departments (workers
//                       and other heads), plus themselves.
//   Worker -> only themselves.
// Anyone can always self-assign regardless of role.
export function assignableTargets(actor: User, pool: User[] = users): User[] {
  let candidates: User[];
  if (actor.role === "ceo") {
    candidates = pool.slice();
  } else if (actor.role === "department_head") {
    candidates = pool.filter((u) =>
      u.id === actor.id || u.departmentIds.some((d) => actor.departmentIds.includes(d))
    );
  } else {
    candidates = [actor];
  }
  return candidates.some((u) => u.id === actor.id) ? candidates : [actor, ...candidates];
}

export function canCreateTasksForOthers(actor: User): boolean {
  return actor.role === "ceo" || actor.role === "department_head";
}

export function canManagePeople(actor: User): boolean {
  return actor.role === "ceo";
}

export function canAddDepartments(actor: User): boolean {
  return actor.role === "ceo";
}
