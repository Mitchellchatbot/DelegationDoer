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
  if (actor.role === "leader" || actor.isAdmin) return null;

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
