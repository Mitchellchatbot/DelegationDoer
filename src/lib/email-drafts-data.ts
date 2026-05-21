import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { EmailDraftKind } from "@/lib/email-approvers";

export type EmailDraftStatus = "pending" | "approved" | "rejected" | "sent" | "failed";

// Derived virtual status surfaced in the global "Scheduled out" view.
// Real DB status is what's stored; "replied" is computed from the
// missive.messages table on read.
export type EmailDraftDisplayStatus = EmailDraftStatus | "replied";

export interface EmailDraftListItem {
  id: string;
  authorId: string;
  authorName: string;
  clientId: string | null;
  clientName: string;
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  kind: EmailDraftKind;
  status: EmailDraftStatus;
  displayStatus: EmailDraftDisplayStatus;
  approverId: string | null;
  approverName: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  sentAt: string | null;
  scheduledFor: string | null;
  missiveThreadId: string | null;
  createdAt: string;
}

export interface ListFilters {
  clientId?: string;
  status?: EmailDraftStatus;
  kind?: EmailDraftKind;
  limit?: number;
}

// Server-side list — used by the global /emails page and per-client
// email log. Resolves author + approver names and derives the
// "replied" virtual status by peeking at missive.messages for any
// inbound email on the thread after sent_at.
export async function listEmailDrafts(filters: ListFilters = {}): Promise<EmailDraftListItem[]> {
  const supabase = getSupabaseAdmin();
  const limit = Math.min(500, Math.max(1, filters.limit ?? 100));

  const buildQuery = (includeScheduledFor: boolean) => {
    const cols = [
      "id", "author_id", "client_id", "client_name",
      "to_emails", "cc_emails", "subject", "body_text",
      "kind", "status", "approver_id", "approved_at", "rejected_at",
      "sent_at", "missive_thread_id", "created_at"
    ];
    if (includeScheduledFor) cols.push("scheduled_for");
    let q = supabase
      .from("email_drafts")
      .select(cols.join(", "))
      .order("created_at", { ascending: false })
      .limit(limit);
    if (filters.clientId) q = q.eq("client_id", filters.clientId);
    if (filters.status) q = q.eq("status", filters.status);
    if (filters.kind) q = q.eq("kind", filters.kind);
    return q;
  };

  // Try with scheduled_for first; if the migration hasn't been applied
  // yet the column won't exist and Postgres returns 42703. Retry once
  // without it so the page still renders during the transition.
  let result = await buildQuery(true);
  if (result.error && /scheduled_for/.test(result.error.message)) {
    result = await buildQuery(false);
  }
  const { data, error } = result;
  if (error) throw new Error(error.message);
  // Built-string .select() defeats the Supabase types; cast through
  // unknown — the column list is the source of truth at runtime.
  const rows = (data ?? []) as unknown as Array<{
    id: string;
    author_id: string;
    client_id: string | null;
    client_name: string;
    to_emails: string[] | null;
    cc_emails: string[] | null;
    subject: string;
    body_text: string;
    kind: EmailDraftKind;
    status: EmailDraftStatus;
    approver_id: string | null;
    approved_at: string | null;
    rejected_at: string | null;
    sent_at: string | null;
    // Optional — absent on rows fetched via the migration fallback.
    scheduled_for?: string | null;
    missive_thread_id: string | null;
    created_at: string;
  }>;

  if (rows.length === 0) return [];

  // Name lookup for authors + approvers — single round-trip.
  const userIds = Array.from(new Set([
    ...rows.map((r) => r.author_id),
    ...rows.map((r) => r.approver_id).filter((v): v is string => !!v)
  ]));
  const namesById = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: us } = await supabase
      .from("users")
      .select("id, name")
      .in("id", userIds);
    for (const u of (us ?? []) as { id: string; name: string | null }[]) {
      namesById.set(u.id, u.name ?? "—");
    }
  }

  // "Replied" virtual status is intentionally not derived here. The
  // missive data lives behind an HTTP API (missiveclone), so checking
  // every sent thread would N+1 across the whole list. Defer until we
  // can either push inbound-reply hooks back into Supabase or batch
  // the missive calls. For now: sent stays sent.

  return rows.map((r) => {
    const status = r.status;
    const displayStatus: EmailDraftDisplayStatus = status;
    return {
      id: r.id,
      authorId: r.author_id,
      authorName: namesById.get(r.author_id) ?? "—",
      clientId: r.client_id,
      clientName: r.client_name,
      to: r.to_emails ?? [],
      cc: r.cc_emails ?? [],
      subject: r.subject,
      bodyText: r.body_text,
      kind: r.kind,
      status,
      displayStatus,
      approverId: r.approver_id,
      approverName: r.approver_id ? namesById.get(r.approver_id) ?? null : null,
      approvedAt: r.approved_at,
      rejectedAt: r.rejected_at,
      sentAt: r.sent_at,
      scheduledFor: r.scheduled_for ?? null,
      missiveThreadId: r.missive_thread_id,
      createdAt: r.created_at
    };
  });
}

export function statusLabel(s: EmailDraftDisplayStatus): string {
  switch (s) {
    case "pending":  return "In approval";
    case "approved": return "Approved";
    case "rejected": return "Rejected";
    case "sent":     return "Sent";
    case "failed":   return "Failed";
    case "replied":  return "Replied";
  }
}

export function statusTone(s: EmailDraftDisplayStatus): { bg: string; text: string; border: string } {
  switch (s) {
    case "pending":  return { bg: "bg-amber-100",    text: "text-amber-700",   border: "border-amber-200/60" };
    case "approved": return { bg: "bg-blue-100",     text: "text-blue-700",    border: "border-blue-200/60" };
    case "rejected": return { bg: "bg-rose-100",     text: "text-rose-700",    border: "border-rose-200/60" };
    case "sent":     return { bg: "bg-emerald-100",  text: "text-emerald-700", border: "border-emerald-200/60" };
    case "failed":   return { bg: "bg-rose-100",     text: "text-rose-700",    border: "border-rose-200/60" };
    case "replied":  return { bg: "bg-indigo-100",   text: "text-indigo-700",  border: "border-indigo-200/60" };
  }
}

export function kindLabel(k: EmailDraftKind): string {
  switch (k) {
    case "content_plan":  return "Content plan";
    case "client_update": return "Client update";
    case "custom":        return "Custom";
  }
}
