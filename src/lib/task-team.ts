// "Team tasks" — work handed to a whole department instead of a person, so
// the team divides it amongst themselves. Mitchell's ask: "instead of
// delegating out individual tasks, what if I delegate that out to software
// team and then you guys could divide them amongst urself when we meet?"
//
// THE MARKER IS A RESERVED TAG, NOT A COLUMN.
//
// (department_id set + assignee_id null) on its own is NOT the signal. Two
// existing classes of live row already look exactly like that:
//   - every project stage task, inserted assignee_id: null and left that way
//     until its batch dispatches (api/projects/route.ts, project-flow.ts), and
//   - rejected AI drafts, which keep department_id with is_draft = false and
//     assignee_id null (lib/draft-approval.ts).
// Both would flood the team pool. So a team task is one somebody explicitly
// queued for a department.
//
// Why a tag rather than a real column:
//   - `tags` is already in TICKET_COLS and on the Task type. `stage_id` and
//     `is_draft` are NOT (see server-data.ts), so a discriminator built on
//     those can't be read client-side without extra plumbing.
//   - The "auto-" prefix is an existing system-tag namespace that the skill
//     extractor already filters out (api/tasks/[id]/route.ts), so auto-team
//     inherits that for free and never earns anyone skill points.
//   - DD migrations are applied BY HAND — merging a PR runs nothing. Adding a
//     column to TICKET_COLS before the migration lands would make
//     select(TICKET_COLS) fail and 500 every task list in the app. A tag
//     deploys atomically with the code and reverts cleanly.
// Normalising this into an `assigned_to_department` column later is a safe
// follow-up: backfill from the tag.
//
// The tag is DURABLE — claiming does not strip it. Claimability is the
// separate `!assigneeId` condition (isUnclaimedTeamTask). If the tag were
// stripped on claim, the task would vanish from the rest of the team's view
// the instant someone took it — mid-meeting, which is exactly when the team
// is dividing the work up and needs to see who took what.
//
// Client-safe: no server imports, so components can use it too.

import type { Task, User } from "@/lib/types";

// Namespaced under "auto-" so the skill extractor in
// api/tasks/[id]/route.ts skips it alongside the other routing/system tags.
export const TEAM_TAG = "auto-team";

type TeamTaskShape = Pick<Task, "departmentId" | "tags">;
type ClaimableShape = TeamTaskShape & Pick<Task, "assigneeId" | "status">;

// Was this task deliberately queued for a department? Stays true after
// someone claims it — see the durability note above.
export function isTeamTask(t: TeamTaskShape | null | undefined): boolean {
  if (!t) return false;
  if (!t.departmentId) return false;
  return (t.tags ?? []).includes(TEAM_TAG);
}

// Still sitting in the pool: nobody has taken it and it isn't finished.
export function isUnclaimedTeamTask(t: ClaimableShape | null | undefined): boolean {
  if (!t || !isTeamTask(t)) return false;
  return !t.assigneeId && t.status !== "done";
}

// Membership union used by every department-scoped gate: a user's own
// departments plus any they've been delegated to manage. Mirrors the union
// canCreateTaskInDepartment already applies in access.ts — kept here so
// task-team.ts stays the single place that answers "is this my team's work".
export function inDepartment(
  actor: Pick<User, "departmentIds" | "delegateDepartmentIds"> | null | undefined,
  departmentId: string | null | undefined
): boolean {
  if (!actor || !departmentId) return false;
  if (actor.departmentIds.includes(departmentId)) return true;
  return actor.delegateDepartmentIds?.includes(departmentId) ?? false;
}

// Strip the marker from a client-supplied tag array. The server owns this
// tag: a client must not be able to publish a task to a team (or quietly
// pull one out of the pool) by editing tags.
export function stripTeamTag(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.filter((t): t is string => typeof t === "string" && t !== TEAM_TAG);
}
