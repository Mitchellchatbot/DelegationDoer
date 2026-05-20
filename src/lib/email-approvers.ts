// Per-author-department approver routing for the email_drafts queue.
// Mitchell's spec v2.5: "I want just mujtaba, sam, hasan to see
// approvals for their specific department and mitch for everyone."
//
// Translation:
//   - Leaders (Mitch) see every draft regardless of kind or author.
//   - Department heads see only drafts whose AUTHOR sits in a
//     department they head. So Hasan (head of dep_software) sees
//     software-team drafts; Mujtaba (head of dep_web) sees website-
//     team drafts; Sam (head of dep_seo) sees SEO-team drafts.
//   - Everyone else — including stealth admins — sees nothing in
//     the approval queue. Admin status no longer grants approver
//     access; the role is the only gate.
//
// The `kind` field on a draft is preserved (client_update vs
// content_plan vs custom) so Slack DMs can be themed accordingly,
// but routing is purely by author department.

import { getSupabaseAdmin } from "@/lib/supabase-admin";

export type EmailDraftKind = "client_update" | "content_plan" | "custom";

export interface ApproverUser {
  id: string;
  name: string;
  email: string | null;
}

interface DraftRef {
  author_id: string;
  // kind is unused for routing now but kept on the type so callers
  // don't have to refactor. The DM copy still varies by kind.
  kind?: EmailDraftKind;
}

// Fetch every user who's allowed to approve a given draft. Always
// includes leaders so Mitch never falls off the list. Department-head
// approvers are the union of dept_heads in every department the
// draft's author belongs to.
export async function getApproversForDraft(draft: DraftRef): Promise<ApproverUser[]> {
  const supabase = getSupabaseAdmin();

  const [authorMembershipRes, leadersRes] = await Promise.all([
    supabase.from("department_members").select("department_id").eq("user_id", draft.author_id),
    supabase.from("users").select("id, name, email").eq("role", "leader")
  ]);

  const authorDeptIds = Array.from(new Set(
    ((authorMembershipRes.data ?? []) as { department_id: string }[]).map((r) => r.department_id)
  ));

  let deptHeads: ApproverUser[] = [];
  if (authorDeptIds.length > 0) {
    // Two-hop: dept members of those depts → filter to role='department_head'.
    const { data: memberRows } = await supabase
      .from("department_members")
      .select("user_id")
      .in("department_id", authorDeptIds);
    const headIds = Array.from(new Set(
      ((memberRows ?? []) as { user_id: string }[]).map((r) => r.user_id)
    ));
    if (headIds.length > 0) {
      const { data: heads } = await supabase
        .from("users")
        .select("id, name, email, role")
        .in("id", headIds)
        .eq("role", "department_head");
      deptHeads = ((heads ?? []) as Array<{ id: string; name: string | null; email: string | null }>)
        .filter((u) => !!u.name)
        .map((u) => ({ id: u.id, name: u.name as string, email: u.email }));
    }
  }

  const merged = new Map<string, ApproverUser>();
  for (const u of (leadersRes.data ?? []) as Array<{ id: string; name: string | null; email: string | null }>) {
    if (u.name) merged.set(u.id, { id: u.id, name: u.name, email: u.email });
  }
  for (const u of deptHeads) merged.set(u.id, u);
  return Array.from(merged.values());
}

// Sync permission check used by approve/reject endpoints. Re-uses
// the same routing as getApproversForDraft but stops early once a
// match is found.
export async function canApproveDraft(
  caller: { id: string; role: string; departmentIds?: string[] },
  draft: DraftRef
): Promise<boolean> {
  if (caller.role === "leader") return true;
  if (caller.role !== "department_head") return false;
  const callerDepts = new Set(caller.departmentIds ?? []);
  if (callerDepts.size === 0) return false;

  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("department_members")
    .select("department_id")
    .eq("user_id", draft.author_id);
  for (const r of (data ?? []) as { department_id: string }[]) {
    if (callerDepts.has(r.department_id)) return true;
  }
  return false;
}

// Quick "are you an approver in general?" check — used by the sidebar
// to decide whether to render the Approvals nav item at all. Doesn't
// need a draft, just the caller's role + dept memberships. Stealth
// admins explicitly excluded so Shaheer doesn't get pinged.
export function canApproveAnyDraft(caller: { role: string; departmentIds?: string[] }): boolean {
  if (caller.role === "leader") return true;
  if (caller.role === "department_head" && (caller.departmentIds ?? []).length > 0) return true;
  return false;
}
