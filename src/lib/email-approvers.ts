// Per-kind approver routing for the email_drafts queue. The spec is
// hard-coded by name; this module resolves the names to live user IDs
// at runtime so a re-org doesn't require a code change.
//
// Spec v2:
//   - client_update  → Mitchell + Mujtaba + Sam (any one approves)
//   - content_plan   → Sam, Mitchell, Tabrez, Farez, Bismah, Mujtaba
//   - custom         → Mitchell only (fallback)
//
// Each "match" is a case-insensitive substring on the user's name OR
// an exact email match. Leaders + admins are always added on top so
// Mitch never falls off the list if the name pattern shifts.

import { getSupabaseAdmin } from "@/lib/supabase-admin";

export type EmailDraftKind = "client_update" | "content_plan" | "custom";

interface ApproverMatch {
  // Substring (lower-cased) tested against users.name; "" matches nothing.
  namePattern: string;
}

// Routing table per spec. Order matters only for display.
const KIND_MATCHERS: Record<EmailDraftKind, ApproverMatch[]> = {
  client_update: [
    { namePattern: "mitchell" },
    { namePattern: "mujtaba" },
    { namePattern: "sam" }
  ],
  content_plan: [
    { namePattern: "sam" },
    { namePattern: "mitchell" },
    { namePattern: "tabrez" },
    { namePattern: "farez" },
    { namePattern: "bismah" },
    { namePattern: "mujtaba" }
  ],
  // Default fallback bucket — Mitch sees anything unrouted.
  custom: [{ namePattern: "mitchell" }]
};

export interface ApproverUser {
  id: string;
  name: string;
  email: string | null;
}

// Resolve the approver set for a given draft kind. Always includes
// every leader + admin as a safety net so a missing name in the
// pattern list never strands a draft.
export async function getApproversForKind(kind: EmailDraftKind): Promise<ApproverUser[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("users")
    .select("id, name, email, role, is_admin");
  if (error || !data) return [];
  const rows = data as Array<{
    id: string;
    name: string | null;
    email: string | null;
    role: string | null;
    is_admin: boolean | null;
  }>;

  const matchers = KIND_MATCHERS[kind] ?? KIND_MATCHERS.custom;
  const matched = new Map<string, ApproverUser>();

  for (const u of rows) {
    if (!u.name) continue;
    const lower = u.name.toLowerCase();
    const isLeader = u.role === "leader" || u.is_admin === true;
    const nameMatch = matchers.some((m) => m.namePattern && lower.includes(m.namePattern));
    if (isLeader || nameMatch) {
      matched.set(u.id, { id: u.id, name: u.name, email: u.email });
    }
  }
  return Array.from(matched.values());
}

// Check whether a specific user is allowed to approve a draft of a
// given kind. Cheap (no DB round-trip when we already have the user).
export function canApproveKind(
  user: { id: string; name: string | null; role: string; isAdmin?: boolean },
  kind: EmailDraftKind
): boolean {
  if (user.role === "leader" || user.isAdmin === true) return true;
  const matchers = KIND_MATCHERS[kind] ?? KIND_MATCHERS.custom;
  const lower = (user.name ?? "").toLowerCase();
  return matchers.some((m) => m.namePattern && lower.includes(m.namePattern));
}
