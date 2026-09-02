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
import { inDepartment, isTeamTask, isUnclaimedTeamTask } from "@/lib/task-team";

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

// Whether this user must be clocked in (have an open time_entries
// segment) to perform shift-gated actions — task creation and SOD/EOD
// submission. Two groups are exempt:
//   - leaders + stealth admins (managers, not on a personal clock), and
//   - users with clock_enabled = false (salaried/on-call), who have no
//     clock UI at all and so could never satisfy the gate.
export function requiresClockIn(
  u: Pick<User, "role" | "isAdmin" | "clockEnabled"> | null | undefined
): boolean {
  return !!u && !isLeader(u) && u.clockEnabled !== false;
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

// Can `actor` take an unclaimed team task for themselves? This is the
// "divide them amongst ourselves" affordance: anyone in the department the
// task was queued for may claim it.
//
// Deliberately NOT folded into canManageTask. That gate has no
// department-member path on purpose (a worker can't administer a task just
// because a teammate owns it), and claiming is a much narrower act: it only
// ever sets assignee_id to the actor's own id, and only while the task is
// still sitting in the pool. Once claimed, normal canManageTask rules apply.
export function canClaimTask(
  actor: User | null | undefined,
  task:
    | Pick<Task, "assigneeId" | "departmentId" | "status" | "tags">
    | null
    | undefined
): boolean {
  if (!actor || !task) return false;
  if (!isUnclaimedTeamTask(task)) return false;
  if (isLeader(actor)) return true;
  return inDepartment(actor, task.departmentId);
}

// Who may queue work to a whole department instead of a person?
//
// Leaders and department heads only — this mirrors what POST /api/tasks
// actually does. That route defaults an unspecified assignee to the caller
// for anyone failing `isWorker`-style checks, and a scoped delegate's role
// is still "worker", so a delegate choosing "the whole team" would silently
// end up assigned to themselves. Note this is NARROWER than
// canCreateTasksForOthers / canChooseDepartment in auth.ts, both of which
// include delegates.
export function canQueueTaskToTeam(actor: User | null | undefined): boolean {
  if (!actor) return false;
  return isLeader(actor) || isDepartmentHead(actor);
}

// SEO team leads (Bismah, Saifullah, Samir G) can delete tasks in their own
// department, matching what the SEO department head can do. They are NOT
// department heads by role: 20260720000000_seo_org_structure_email_keyed.sql
// deliberately pins every SEO lead to role='worker' so the org chart renders a
// single root, so this grant can't come from `leadsDepartment`.
//
// Curated by EXACT email (stable + collision-free) — mirrors EMAIL_VIEWER_EMAILS
// in lib/email-approvers.ts, which grants this same trio read-only email-approvals
// access. That list is NOT reused here on purpose: email-approvers.ts imports
// getSupabaseAdmin (server-only) and access.ts must stay client-safe for TaskCard.
// The two grants are separate concerns and may legitimately diverge — but if you
// add someone here, consider whether they belong there too.
const SEO_LEAD_DELETER_EMAILS = [
  "bella@scaledai.org",
  "steve@scaledai.org",
  "samir@scaledai.org"
];

function isSeoLeadDeleter(u: Pick<User, "email"> | null | undefined): boolean {
  if (!u?.email) return false;
  return SEO_LEAD_DELETER_EMAILS.includes(u.email.trim().toLowerCase());
}

// Who may change which SEO lead owns a client (the /client-teams board, and
// any teamId edit that touches an SEO bucket). Requested explicitly: Mitch,
// Sam, Tabrez, Farez — nobody else, including other leaders and the SEO leads
// themselves, who can see the split but not rewrite it.
//
// Deliberately NOT expressed as role/isAdmin. That would be a near-miss:
// Sam/Tabrez/Farez happen to be admins today, but so are others, and the ask
// was for these four specifically. Pinning it to identity means the grant
// doesn't silently widen the next time someone is made an admin.
//
// Keyed by EXACT email, like SEO_LEAD_DELETER_EMAILS above. A name list is
// actively dangerous here: "sam" also matches "Samir G" (a different person,
// samir@scaledai.org), which is the same trap SUPER_APPROVER_NAME_PATTERNS in
// lib/email-approvers.ts documents. Farez's login is a gmail address — that's
// correct, not a typo.
//
// To add/remove an editor, change this list and only this list.
const CLIENT_TEAM_EDITOR_EMAILS = [
  "mitchell@scaledai.org",     // Mitchell (leader)
  "sam@scaledai.org",          // Sam
  "tabrez@scaledai.org",       // Tabrez Khan
  "farezomair1996@gmail.com"   // Farez Khan
];

export function canEditClientTeams(u: Pick<User, "email"> | null | undefined): boolean {
  if (!u?.email) return false;
  return CLIENT_TEAM_EDITOR_EMAILS.includes(u.email.trim().toLowerCase());
}

// "Can delete" is deliberately STRICTER than canManageTask. Deletion is
// destructive and outside the normal task lifecycle, so it's restricted to
// admins/leaders (any task), department heads (tasks in a department they
// lead), and the SEO team leads above (SEO tasks only — see
// SEO_LEAD_DELETER_EMAILS). Note this intentionally does NOT grant the assignee
// or creator delete rights the way canManageTask does — a worker can't delete
// tasks just because they own or were assigned one. Soft delete is recoverable
// by admins, so this gate only governs who can initiate a deletion.
export function canDeleteTask(
  actor: User | null | undefined,
  task: Pick<Task, "departmentId"> | null | undefined
): boolean {
  if (!actor || !task) return false;
  if (isLeader(actor)) return true;
  if (leadsDepartment(actor, task.departmentId)) return true;
  if (task.departmentId === "dep_seo" && isSeoLeadDeleter(actor)) return true;
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
  if (actor.departmentIds.includes(departmentId)) return true;
  // Scoped delegates can view the console for the department(s) they manage
  // so they can see the work they assign there.
  return actor.delegateDepartmentIds?.includes(departmentId) ?? false;
}

// Can `actor` see this task at all? Used to gate the detail page and
// every /api/tasks/[id]/* endpoint. Leader-owned (assigned-to-leader or
// created-by-leader) tasks are invisible to non-leaders unless they
// happen to be the assignee themselves.
// WHY a viewer can see a task, not just whether. Callers that gate a WRITE
// need this: "team" means the viewer can only see this task because of the
// team-task escape below, and should therefore be held to a stricter standard
// than someone who could already see it. Everything else predates this
// feature and keeps its existing (permissive) treatment.
export type TaskViewReason = "privileged" | "own" | "open" | "team";

export function taskViewReason(
  actor: User | null | undefined,
  task: Pick<Task, "creatorId" | "assigneeId" | "departmentId" | "tags"> | null | undefined,
  leaderIds: Set<string>
): TaskViewReason | null {
  if (!actor || !task) return null;
  if (isLeader(actor)) return "privileged";
  // The viewer's own work is always visible to themselves, regardless of
  // whether a leader created it.
  if (task.assigneeId === actor.id) return "own";
  if (task.creatorId === actor.id) return "own";
  // Anything touched by a leader (assignee or creator) is hidden from
  // non-leaders...
  const leaderOwned =
    (!!task.assigneeId && leaderIds.has(task.assigneeId)) ||
    (!!task.creatorId && leaderIds.has(task.creatorId));
  if (!leaderOwned) return "open";
  // ...EXCEPT team tasks. Work explicitly queued for a department belongs to
  // that department, so its members see it even when a leader created it.
  // Without this the whole feature is dead on arrival: a task Mitchell (a
  // leader) files for the Software team has no assignee, so neither "own
  // work" escape above fires, and the rule right above hides it from exactly
  // the team it was written for.
  //
  // Deliberately narrow — it needs BOTH the explicit TEAM_TAG marker (a
  // leader/head chose "the whole team"; see lib/task-team.ts for why an
  // unassigned task alone is not enough) AND a department the viewer belongs
  // to or has been delegated. Leader-owned *assigned* work and
  // department-less leader notes stay private exactly as before.
  //
  // Checked only on the leader-owned branch on purpose: a team task nobody
  // privileged touched was already visible as "open", and reporting it as
  // "team" would subject it to a write gate it never had.
  //
  // Note this does NOT require the task to still be unclaimed: once Shaheer
  // claims it, the rest of the Software team keeps seeing it. Stripping
  // visibility on claim would make the task vanish from teammates and from
  // the head's team dashboard mid-meeting, which is when they most need to
  // see who took what.
  if (isTeamTask(task) && inDepartment(actor, task.departmentId)) return "team";
  return null;
}

export function canViewTask(
  actor: User | null | undefined,
  task: Pick<Task, "creatorId" | "assigneeId" | "departmentId" | "tags"> | null | undefined,
  leaderIds: Set<string>
): boolean {
  return taskViewReason(actor, task, leaderIds) !== null;
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
  task: Pick<Task, "creatorId" | "assigneeId" | "departmentId" | "tags"> | null | undefined,
  leaderIds: Set<string>
): boolean {
  if (!actor || !task) return false;
  if (isLeader(actor)) return true;
  // The viewer's own work is always visible to themselves, regardless of
  // department or who created it (mirrors canViewTask).
  if (task.assigneeId === actor.id) return true;
  if (task.creatorId === actor.id) return true;
  // Team tasks — same escape as canViewTask, and it has to be here too or
  // Ask AI answers "nothing" to "what's unclaimed on my team?" while the
  // board shows the work. Note this asserts the same department membership
  // the tail of this function already requires, so it is a short-circuit
  // past the leader-privacy lines rather than new policy.
  if (isTeamTask(task) && inDepartment(actor, task.departmentId)) return true;
  // Leader-owned work (assignee or creator) stays private to leaders.
  if (task.assigneeId && leaderIds.has(task.assigneeId)) return false;
  if (task.creatorId && leaderIds.has(task.creatorId)) return false;
  // Department scoping: the task must live in one of the actor's
  // departments — or a department they've been delegated to manage. No
  // department → outside every team → hidden.
  if (!task.departmentId) return false;
  if (actor.departmentIds.includes(task.departmentId)) return true;
  return actor.delegateDepartmentIds?.includes(task.departmentId) ?? false;
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
  actor:
    | Pick<User, "role" | "isAdmin" | "departmentIds" | "delegateDepartmentIds">
    | null
    | undefined,
  departmentId: string | null | undefined
): boolean {
  if (!actor) return false;
  if (isLeader(actor)) return true;
  if (!departmentId) return false;
  if (actor.departmentIds.includes(departmentId)) return true;
  // Scoped delegates can also create in the department(s) they manage on a
  // head's behalf, even if it isn't their own home department.
  return actor.delegateDepartmentIds?.includes(departmentId) ?? false;
}

// Can `actor` assign a task to `target`? Server-side mirror of
// assignableTargets() in auth.ts (which drives the New-task form's picker):
//   - leaders/admins → anyone,
//   - department heads → anyone whose home is one of their departments (+ self),
//   - workers → themselves + their direct reports (manager_user_id === actor).
// Everyone can always assign to themselves. The /api/tasks route enforces
// this for non-leaders; the widget/form picker is convenience, not the gate.
export function canAssignTaskTo(
  actor:
    | Pick<User, "id" | "role" | "isAdmin" | "departmentIds" | "delegateDepartmentIds">
    | null
    | undefined,
  target: Pick<User, "id" | "departmentIds" | "managerId"> | null | undefined
): boolean {
  if (!actor || !target) return false;
  if (target.id === actor.id) return true; // always allowed to self-assign
  if (isLeader(actor)) return true;
  if (isDepartmentHead(actor)) {
    return target.departmentIds.some((d) => actor.departmentIds.includes(d));
  }
  // Scoped delegates get department-head-style reach, but only WITHIN the
  // department(s) they've been delegated (delegate_department_ids), and
  // without changing their public role. Mirrors the head branch above.
  if (actor.delegateDepartmentIds?.some((d) => target.departmentIds.includes(d))) {
    return true;
  }
  // Workers: only their own direct reports.
  return target.managerId === actor.id;
}
