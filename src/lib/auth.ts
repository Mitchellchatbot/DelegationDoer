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

// Outbound surface — Meta/Facebook ads analytics + (future) other paid
// channels. Visibility is limited to a curated set of operators rather
// than role-gated, because growth metrics are sensitive and only a few
// people own the spend story.
//
// Matches against the lowercased display name so a rename in the DB
// doesn't break the gate. Mirrors the same substring-matching pattern
// used by SUPER_APPROVER_NAME_PATTERNS in lib/email-approvers.ts —
// keep the two in sync if the access model evolves.
const OUTBOUND_NAME_PATTERNS = ["mitchell", "hasan", "mujtaba", "henry", "hamza", "sofyan"];

export function canSeeOutbound(u: User | null | undefined): boolean {
  if (!u || !u.name) return false;
  const lower = u.name.toLowerCase();
  return OUTBOUND_NAME_PATTERNS.some((p) => lower.includes(p));
}

// Customer Support inbox (/customer-support) — the inbound-SMS triage surface.
// Scoped to Mujtaba (mike@scaledai.org) plus stealth admins (is_admin), who see
// every surface for support/debugging. Deliberately NARROWER than
// canSeeOutbound: that group is the whole spend-story cohort, not just Mujtaba.
// Matches on email (stable, exact) OR name substring (survives a DB rename),
// mirroring the same belt-and-braces gating used across the app.
export function canSeeCustomerSupport(u: User | null | undefined): boolean {
  if (!u) return false;
  if (u.isAdmin === true) return true;
  if (u.email && u.email.toLowerCase() === "mike@scaledai.org") return true;
  if (u.name && u.name.toLowerCase().includes("mujtaba")) return true;
  return false;
}
