// Email-draft approver routing.
//
// Spec v3 (current): the approvers list is:
//   1. any user with role='leader' (Mitch, ...), OR
//   2. any stealth admin (is_admin=true — Shaheer, Mecheal), OR
//   3. three super-approvers by name: Sam, Mujtaba, Farez.
//
// Those people can:
//   - see every queued draft regardless of author
//   - approve / reject / leave feedback / request revision
//
// Stealth admins are included because is_admin grants every other
// leader-equivalent permission across the app (see [[stealth_admin_flag]]
// migration + lib/access.ts:isLeader); the approval gate matches.
//
// Dept-head and content-plan-specific approvers were removed in v3 —
// keeping the API surface intact (callers still pass `kind`) but no
// branches consume it for routing anymore.
//
// The author of a draft can still see (and edit while pending or
// needs_revision) their own draft, but they don't appear in the
// approver list and can't approve/reject/feedback/request-revision.

import { getSupabaseAdmin } from "@/lib/supabase-admin";

export type EmailDraftKind = "client_update" | "content_plan" | "custom" | "auto_reply" | "eod_digest";

export interface ApproverUser {
  id: string;
  name: string;
  email: string | null;
  slack_email?: string | null;
  slack_user_id?: string | null;
}

interface DraftRef {
  author_id: string;
  // kind is unused for routing now, kept on the type so callers don't
  // have to refactor. Slack DM copy still varies by kind.
  kind?: EmailDraftKind;
  // Department this draft is scoped to (client_update drafts split by
  // department). When set, the head of that department becomes an
  // approver IN ADDITION to the universal approver set below. NULL =
  // not department-scoped (legacy: universal approvers only).
  departmentId?: string | null;
}

// Substrings that flag a user as a super-approver. Matched against
// the lowercased name so a rename doesn't require a code change.
// To add/remove a super-approver, change this list and only this list
// — every other check funnels through isApprover() below.
const SUPER_APPROVER_NAME_PATTERNS = ["sam", "mujtaba", "farez"];

function isSuperApproverName(name: string | null | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return SUPER_APPROVER_NAME_PATTERNS.some((p) => lower.includes(p));
}

// Single source of truth for "is this person an approver?" — used by
// canApproveDraft / canApproveAnyDraft and by the GET listing and
// notifications-badges routes (which previously duplicated the name
// list inline). Pass role + name + isAdmin — no DB calls.
//
// Stealth admins (isAdmin=true) count as leader-equivalent everywhere
// else in the app (lib/access.ts:isLeader), so they count here too.
export function isApprover(caller: { name?: string | null; role: string; isAdmin?: boolean }): boolean {
  if (caller.role === "leader") return true;
  if (caller.isAdmin === true) return true;
  if (isSuperApproverName(caller.name)) return true;
  return false;
}

// Fetch every user who's allowed to approve a given draft. Returns
// the universal approver set (role='leader' ∪ stealth admins ∪
// super-approvers) PLUS, when the draft is department-scoped, the
// head(s) of that department. Async because we hit the users table for
// role + is_admin + Slack metadata (and department_members for the
// department head lookup).
export async function getApproversForDraft(draft: DraftRef): Promise<ApproverUser[]> {
  const supabase = getSupabaseAdmin();

  // One round-trip — pull every user, then filter in memory. The
  // users table is small enough (~25 rows) that this is cheaper than
  // two targeted queries. When the draft is department-scoped we also
  // need that department's member ids to single out its head.
  const [{ data }, membersRes] = await Promise.all([
    supabase
      .from("users")
      .select("id, name, email, slack_email, slack_user_id, role, is_admin"),
    draft.departmentId
      ? supabase
          .from("department_members")
          .select("user_id")
          .eq("department_id", draft.departmentId)
      : Promise.resolve({ data: [] as { user_id: string }[] })
  ]);
  const rows = (data ?? []) as Array<{
    id: string;
    name: string | null;
    email: string | null;
    slack_email: string | null;
    slack_user_id: string | null;
    role: string;
    is_admin: boolean | null;
  }>;
  const deptMemberIds = new Set(
    ((membersRes.data ?? []) as { user_id: string }[]).map((m) => m.user_id)
  );

  const merged = new Map<string, ApproverUser>();
  for (const u of rows) {
    if (!u.name) continue;
    // Universal approver, OR the head of this draft's department.
    const isDeptHead =
      !!draft.departmentId && u.role === "department_head" && deptMemberIds.has(u.id);
    if (isApprover({ name: u.name, role: u.role, isAdmin: u.is_admin === true }) || isDeptHead) {
      merged.set(u.id, {
        id: u.id,
        name: u.name,
        email: u.email,
        slack_email: u.slack_email,
        slack_user_id: u.slack_user_id
      });
    }
  }
  return Array.from(merged.values());
}

// Permission check used by approve / reject / feedback /
// request-revision / edit endpoints. The universal approver set always
// passes (leaders / admins / super-approvers oversee every draft). For
// a department-scoped draft, the head of that department also passes —
// so a Website draft can be approved by the Website HoD, an SEO draft by
// the SEO HoD, etc. (kind itself still doesn't factor into routing.)
export async function canApproveDraft(
  caller: { id: string; name?: string | null; role: string; isAdmin?: boolean; departmentIds?: string[] },
  draft: DraftRef
): Promise<boolean> {
  if (isApprover(caller)) return true;
  if (
    draft.departmentId &&
    caller.role === "department_head" &&
    (caller.departmentIds ?? []).includes(draft.departmentId)
  ) {
    return true;
  }
  return false;
}

// "Can this user act on department-scoped drafts they head?" — used by
// the GET listing + badge count to widen visibility beyond the universal
// approver set. Returns the set of department ids the caller heads (empty
// for everyone who isn't a department_head).
export function headedDepartmentIds(caller: { role: string; departmentIds?: string[] }): string[] {
  return caller.role === "department_head" ? (caller.departmentIds ?? []) : [];
}

// "Are you an approver in general?" — used by the sidebar to decide
// whether to render the Approvals nav item at all, and by the GET
// listing to widen visibility beyond just the caller's own drafts.
export function canApproveAnyDraft(caller: { name?: string | null; role: string; isAdmin?: boolean; departmentIds?: string[] }): boolean {
  return isApprover(caller);
}
