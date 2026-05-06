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

// Who is `actor` allowed to assign tickets to?
//   CEO -> any department head, plus self
//   Department head -> workers in any department they lead, plus self
//   Worker -> only themselves
// Anyone can always self-assign regardless of role.
export function assignableTargets(actor: User): User[] {
  let pool: User[];
  if (actor.role === "ceo") {
    pool = users.filter((u) => u.role === "department_head");
  } else if (actor.role === "department_head") {
    pool = users.filter(
      (u) => u.role === "worker" && u.departmentIds.some((d) => actor.departmentIds.includes(d))
    );
  } else {
    pool = [actor];
  }
  // Always allow self-assignment, deduped.
  return pool.some((u) => u.id === actor.id) ? pool : [actor, ...pool];
}

export function canCreateTicketsForOthers(actor: User): boolean {
  return actor.role === "ceo" || actor.role === "department_head";
}

export function canManagePeople(actor: User): boolean {
  return actor.role === "ceo";
}

export function canAddDepartments(actor: User): boolean {
  return actor.role === "ceo";
}
