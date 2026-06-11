// Role-scoped inbox visibility.
//
//   Leader         -> every inbox in the workspace, regardless of assignment.
//   Dept head   -> any inbox assigned to anyone in their department(s)
//                  (including themselves).
//   Worker      -> only inboxes assigned directly to them.
//
// Returns the set of missive_account_ids the actor is allowed to read.
// Always intersect with the actually-existing accounts from missive
// before serving — assignments could reference deleted accounts.

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { listAccounts } from "@/lib/missive-client";
import type { User } from "@/lib/types";

export interface InboxAssignment {
  id: string;
  userId: string;
  missiveAccountId: string;
  inboxEmail: string;
  inboxLabel: string | null;
  assignedBy: string | null;
  createdAt: string;
}

interface AssignmentRow {
  id: string;
  user_id: string;
  missive_account_id: string;
  inbox_email: string;
  inbox_label: string | null;
  assigned_by: string | null;
  created_at: string;
}

function rowToAssignment(r: AssignmentRow): InboxAssignment {
  return {
    id: r.id,
    userId: r.user_id,
    missiveAccountId: r.missive_account_id,
    inboxEmail: r.inbox_email,
    inboxLabel: r.inbox_label,
    assignedBy: r.assigned_by,
    createdAt: r.created_at
  };
}

export async function getAllAssignments(): Promise<InboxAssignment[]> {
  const { data } = await getSupabaseAdmin()
    .from("inbox_assignments")
    .select("*")
    .order("created_at", { ascending: false });
  return (data ?? []).map((r) => rowToAssignment(r as AssignmentRow));
}

export async function getAssignmentsForUser(userId: string): Promise<InboxAssignment[]> {
  const { data } = await getSupabaseAdmin()
    .from("inbox_assignments")
    .select("*")
    .eq("user_id", userId);
  return (data ?? []).map((r) => rowToAssignment(r as AssignmentRow));
}

// Private inboxes ("the boss's container"): account_id -> owner_user_id.
// A private inbox drops out of the default "leaders/admins see everything"
// rule — it's visible ONLY to the people explicitly ASSIGNED to it (via
// inbox_assignments), plus the owner who manages the flag. Everyone else,
// other admins included, is excluded. So assigning someone to a private
// inbox is how you grant them access to it.
// Best-effort: a missing table (migration not applied) yields an empty
// map, i.e. nothing is private.
export async function getPrivateInboxOwners(): Promise<Map<string, string | null>> {
  const { data, error } = await getSupabaseAdmin()
    .from("inbox_privacy")
    .select("missive_account_id, owner_user_id");
  const map = new Map<string, string | null>();
  if (error) {
    if (!/inbox_privacy/.test(error.message)) {
      console.error("[inbox-access] private-inbox lookup failed", error);
    }
    return map;
  }
  for (const r of (data ?? []) as { missive_account_id: string; owner_user_id: string | null }[]) {
    map.set(r.missive_account_id, r.owner_user_id);
  }
  return map;
}

// Set or clear an inbox's private flag. Passing ownerUserId marks it
// private (visible only to that user); passing null clears it (back to
// role-based visibility). Leader/admin gating is enforced at the API.
export async function setInboxPrivacy(
  accountId: string,
  ownerUserId: string | null,
  byUserId: string
): Promise<void> {
  const supabase = getSupabaseAdmin();
  if (ownerUserId === null) {
    await supabase.from("inbox_privacy").delete().eq("missive_account_id", accountId);
    return;
  }
  await supabase
    .from("inbox_privacy")
    .upsert(
      {
        missive_account_id: accountId,
        owner_user_id: ownerUserId,
        created_by: byUserId,
        updated_at: new Date().toISOString()
      },
      { onConflict: "missive_account_id" }
    );
}

// The set of account ids `actor` is barred from seeing: private inboxes
// the actor is neither assigned to nor the owner of. `assignedIds` is the
// actor's DIRECT inbox_assignments (assignment is what grants access to a
// private inbox — not role, and not a manager seeing a report's inboxes).
function privateExclusionsFor(
  actor: User,
  privateOwners: Map<string, string | null>,
  assignedIds: Set<string>
): Set<string> {
  const excluded = new Set<string>();
  for (const [accountId, ownerId] of privateOwners) {
    const allowed = ownerId === actor.id || assignedIds.has(accountId);
    if (!allowed) excluded.add(accountId);
  }
  return excluded;
}

// Returns the set of missive_account_ids the actor can read. `null` means
// "all accounts" (Leader scope) — caller should not filter further.
//
// Three sources of visibility get unioned:
//   1. Direct inbox_assignments for the user (and for department heads,
//      every member of their department).
//   2. Membership in any inbox_space — grants visibility to every
//      account in that space.
//   3. Leader role short-circuits to "all".
export async function visibleAccountIdsFor(
  actor: User
): Promise<Set<string> | null> {
  // Private inboxes are visible only to people assigned to them (plus the
  // owner) — including for leaders/admins. Computed up front so it applies
  // on every branch. Only fetch the actor's assignments when privacy is
  // actually in play, to keep the common (nothing-private) path cheap.
  const privateOwners = await getPrivateInboxOwners();
  const assignedIds = new Set<string>();
  if (privateOwners.size > 0) {
    for (const a of await getAssignmentsForUser(actor.id)) assignedIds.add(a.missiveAccountId);
  }
  const excluded = privateExclusionsFor(actor, privateOwners, assignedIds);

  if (actor.role === "leader" || actor.isAdmin) {
    // Fast path preserved: with no private inboxes to hide from this
    // actor, leaders/admins still get "all" (null). Only when a private
    // inbox is in play do we enumerate accounts to return "all minus the
    // private ones" as a concrete set.
    if (excluded.size === 0) return null;
    const accounts = await listAccounts().catch(() => []);
    const all = new Set(accounts.map((a) => a.id));
    for (const id of excluded) all.delete(id);
    return all;
  }

  const supabase = getSupabaseAdmin();
  const visible = new Set<string>();

  if (actor.role === "department_head") {
    // Pull everyone in the actor's department(s), then their assignments.
    const { data: deptMembers } = await supabase
      .from("department_members")
      .select("user_id")
      .in("department_id", actor.departmentIds);
    const memberIds = new Set<string>([
      actor.id,
      ...(deptMembers ?? []).map((m: { user_id: string }) => m.user_id)
    ]);

    const { data: rows } = await supabase
      .from("inbox_assignments")
      .select("missive_account_id")
      .in("user_id", Array.from(memberIds));
    for (const r of (rows ?? []) as { missive_account_id: string }[]) {
      visible.add(r.missive_account_id);
    }
  } else {
    // Worker: only own direct assignments.
    const own = await getAssignmentsForUser(actor.id);
    for (const a of own) visible.add(a.missiveAccountId);
  }

  // Space-granted visibility: every account in any space the actor
  // belongs to. Best-effort — schema may not exist yet on older
  // deploys, so swallow the error and fall back to direct-assignment
  // results.
  try {
    const { data: spaceMemberships } = await supabase
      .from("inbox_space_members")
      .select("space_id")
      .eq("user_id", actor.id);
    const spaceIds = (spaceMemberships ?? []).map(
      (r: { space_id: string }) => r.space_id
    );
    if (spaceIds.length > 0) {
      const { data: accts } = await supabase
        .from("inbox_space_accounts")
        .select("account_id")
        .in("space_id", spaceIds);
      for (const r of (accts ?? []) as { account_id: string }[]) {
        visible.add(r.account_id);
      }
    }
  } catch {
    /* space tables absent on older deploys — ignore */
  }

  // A private inbox is never visible to a non-owner, even if a stale
  // assignment or space membership would otherwise grant it.
  for (const id of excluded) visible.delete(id);

  return visible;
}

export function canManageAssignments(actor: User): boolean {
  return actor.role === "leader" || actor.isAdmin === true;
}

// Idempotently mirror Missive's "this user owns this email account"
// relationships into DD's inbox_assignments table. Run once on the
// manage page so the graph reflects what's already wired up in Missive.
//
// Mapping: missive account.user_id → missive team-member email → DD user
// (matched by `users.email` lower-case). If we can't map an owner to a
// DD user, we skip that account silently — adding access will still be
// possible by drawing a string in the UI.
export async function syncMissiveOwnership(
  accounts: { id: string; email: string; display_name: string | null; user_id: string | null }[],
  teamMembers: { id: string; email: string }[]
): Promise<{ created: number }> {
  const missiveUserEmail = new Map(teamMembers.map((m) => [m.id, m.email.toLowerCase()]));

  // Resolve emails to DD user ids.
  const emails = Array.from(new Set(
    accounts
      .map((a) => (a.user_id ? missiveUserEmail.get(a.user_id) : null))
      .filter((e): e is string => Boolean(e))
  ));
  if (emails.length === 0) return { created: 0 };

  const supabase = getSupabaseAdmin();
  const { data: ddUsers } = await supabase
    .from("users")
    .select("id, email")
    .in("email", emails);
  const emailToDdUser = new Map((ddUsers ?? []).map((u: { id: string; email: string }) => [u.email.toLowerCase(), u.id]));

  const rows: Record<string, unknown>[] = [];
  for (const a of accounts) {
    const ownerEmail = a.user_id ? missiveUserEmail.get(a.user_id) : null;
    const ddUserId = ownerEmail ? emailToDdUser.get(ownerEmail) : null;
    if (!ddUserId) continue;
    rows.push({
      id: `ia_sync_${a.id.slice(0, 8)}_${ddUserId}`,
      user_id: ddUserId,
      missive_account_id: a.id,
      inbox_email: a.email,
      inbox_label: a.display_name,
      assigned_by: null
    });
  }

  if (rows.length === 0) return { created: 0 };

  // Upsert by (user_id, missive_account_id) so re-running is a no-op when
  // the link already exists.
  const { error } = await supabase
    .from("inbox_assignments")
    .upsert(rows, { onConflict: "user_id,missive_account_id", ignoreDuplicates: true });
  if (error) {
    // Don't fail page render — log and move on.
    console.warn("[inbox-access] syncMissiveOwnership upsert failed:", error.message);
  }
  return { created: rows.length };
}
