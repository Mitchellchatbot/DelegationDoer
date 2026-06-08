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
// the approver set (role='leader' ∪ stealth admins ∪ super-approvers).
// Async because we hit the users table for role + is_admin + Slack metadata.
export async function getApproversForDraft(_draft: DraftRef): Promise<ApproverUser[]> {
  const supabase = getSupabaseAdmin();

  // One round-trip — pull every user, then filter in memory. The
  // users table is small enough (~25 rows) that this is cheaper than
  // two targeted queries.
  const { data } = await supabase
    .from("users")
    .select("id, name, email, slack_email, slack_user_id, role, is_admin");
  const rows = (data ?? []) as Array<{
    id: string;
    name: string | null;
    email: string | null;
    slack_email: string | null;
    slack_user_id: string | null;
    role: string;
    is_admin: boolean | null;
  }>;

  const merged = new Map<string, ApproverUser>();
  for (const u of rows) {
    if (!u.name) continue;
    if (isApprover({ name: u.name, role: u.role, isAdmin: u.is_admin === true })) {
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

// Sync permission check used by approve / reject / feedback /
// request-revision endpoints. `draft` is accepted for backward
// signature compat but no longer factors in — the approver set is
// kind-agnostic in v3.
export async function canApproveDraft(
  caller: { id: string; name?: string | null; role: string; isAdmin?: boolean; departmentIds?: string[] },
  _draft: DraftRef
): Promise<boolean> {
  return isApprover(caller);
}

// "Are you an approver in general?" — used by the sidebar to decide
// whether to render the Approvals nav item at all, and by the GET
// listing to widen visibility beyond just the caller's own drafts.
export function canApproveAnyDraft(caller: { name?: string | null; role: string; isAdmin?: boolean; departmentIds?: string[] }): boolean {
  return isApprover(caller);
}
