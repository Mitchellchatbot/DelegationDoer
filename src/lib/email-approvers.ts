// Per-author-department approver routing for the email_drafts queue.
//
// Spec v2.6 (current): Mitchell + Mujtaba + Sam are "super approvers"
// who can see + proof + send every queued email regardless of author.
// Hasan keeps the original dept-scoped role — he only sees drafts
// from people in dep_software. Everyone else (workers, stealth admins)
// only sees their own drafts.
//
// Routing rules:
//   1. role='leader' → see all (Mitch always)
//   2. name matches mujtaba / sam (case-insensitive substring) → see all
//   3. role='department_head' AND own dept overlaps author's dept → see
//   4. otherwise → only own drafts
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
  slack_email?: string | null;
  slack_user_id?: string | null;
}

interface DraftRef {
  author_id: string;
  // kind is unused for routing now but kept on the type so callers
  // don't have to refactor. The DM copy still varies by kind.
  kind?: EmailDraftKind;
}

// Fetch every user who's allowed to approve a given draft. Always
// includes leaders (Mitch) and the super-approver name list (Mujtaba,
// Sam — they see everything). Department-head approvers are the
// union of dept_heads in every department the author belongs to.
export async function getApproversForDraft(draft: DraftRef): Promise<ApproverUser[]> {
  const supabase = getSupabaseAdmin();

  const [authorMembershipRes, leadersRes, allNamedRes] = await Promise.all([
    supabase.from("department_members").select("department_id").eq("user_id", draft.author_id),
    supabase.from("users").select("id, name, email, slack_email, slack_user_id").eq("role", "leader"),
    // Pull every user once so we can pluck super-approvers by name.
    // Cheap (~25 rows) — saves a second targeted query.
    supabase.from("users").select("id, name, email, slack_email, slack_user_id")
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
        .select("id, name, email, slack_email, slack_user_id, role")
        .in("id", headIds)
        .eq("role", "department_head");
      deptHeads = ((heads ?? []) as Array<{
        id: string;
        name: string | null;
        email: string | null;
        slack_email: string | null;
        slack_user_id: string | null;
      }>)
        .filter((u) => !!u.name)
        .map((u) => ({
          id: u.id,
          name: u.name as string,
          email: u.email,
          slack_email: u.slack_email,
          slack_user_id: u.slack_user_id
        }));
    }
  }

  const merged = new Map<string, ApproverUser>();
  for (const u of (leadersRes.data ?? []) as Array<{
    id: string;
    name: string | null;
    email: string | null;
    slack_email: string | null;
    slack_user_id: string | null;
  }>) {
    if (u.name) {
      merged.set(u.id, {
        id: u.id,
        name: u.name,
        email: u.email,
        slack_email: u.slack_email,
        slack_user_id: u.slack_user_id
      });
    }
  }
  for (const u of (allNamedRes.data ?? []) as Array<{
    id: string;
    name: string | null;
    email: string | null;
    slack_email: string | null;
    slack_user_id: string | null;
  }>) {
    if (u.name && isSuperApproverName(u.name)) {
      merged.set(u.id, {
        id: u.id,
        name: u.name,
        email: u.email,
        slack_email: u.slack_email,
        slack_user_id: u.slack_user_id
      });
    }
  }
  for (const u of deptHeads) merged.set(u.id, u);
  return Array.from(merged.values());
}

// Substrings that flag a user as a super-approver (sees every queued
// draft, can approve regardless of author dept). Matched against the
// lowercased name so re-orgs don't require a code change.
const SUPER_APPROVER_NAME_PATTERNS = ["mitchell", "mujtaba", "sam"];

function isSuperApproverName(name: string | null | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return SUPER_APPROVER_NAME_PATTERNS.some((p) => lower.includes(p));
}

// Sync permission check used by approve/reject endpoints. Re-uses
// the same routing as getApproversForDraft but stops early once a
// match is found.
export async function canApproveDraft(
  caller: { id: string; name?: string | null; role: string; departmentIds?: string[] },
  draft: DraftRef
): Promise<boolean> {
  if (caller.role === "leader") return true;
  if (isSuperApproverName(caller.name)) return true;
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
export function canApproveAnyDraft(caller: { name?: string | null; role: string; departmentIds?: string[] }): boolean {
  if (caller.role === "leader") return true;
  if (isSuperApproverName(caller.name)) return true;
  if (caller.role === "department_head" && (caller.departmentIds ?? []).length > 0) return true;
  return false;
}
