// Per-user inbox drafts (inline replies + new-message compose). Backed by the
// `inbox_drafts` table — DD-owned, keyed by the DD user. We deliberately do
// NOT call missiveclone's /api/drafts (it keys on the single shared
// service-token user, which would collide across DD's many users). Sending
// still goes through the missive client; this only holds the unsent copy.
//
// All queries are scoped `.eq("user_id", userId)`, so a caller can only ever
// touch their own drafts. The drafts-folder list additionally intersects with
// the caller's visible inbox accounts (visibleAccountIdsFor) so a draft on an
// inbox they've since lost access to doesn't surface.

import { createHash } from "crypto";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { sanitizeMediaUrls } from "@/lib/media";
import type { TaskMedia } from "@/lib/types";

export interface InboxDraft {
  id: string;
  userId: string;
  accountId: string | null;
  threadId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  bodyText: string;
  bodyHtml: string | null;
  attachments: TaskMedia[];
  createdAt: string;
  updatedAt: string;
}

interface DraftRow {
  id: string;
  user_id: string;
  account_id: string | null;
  thread_id: string | null;
  to_addrs: string[] | null;
  cc_addrs: string[] | null;
  bcc_addrs: string[] | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  attachments: unknown;
  created_at: string;
  updated_at: string;
}

function rowToDraft(r: DraftRow): InboxDraft {
  return {
    id: r.id,
    userId: r.user_id,
    accountId: r.account_id,
    threadId: r.thread_id,
    to: r.to_addrs ?? [],
    cc: r.cc_addrs ?? [],
    bcc: r.bcc_addrs ?? [],
    subject: r.subject,
    bodyText: r.body_text ?? "",
    bodyHtml: r.body_html,
    attachments: sanitizeMediaUrls(r.attachments),
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

// Reply drafts are one-per-(user, thread). We derive a deterministic id from
// that pair so the autosave upsert (onConflict: "id") is idempotent and
// race-safe — concurrent autosaves resolve to the same row instead of
// churning the id or duplicating. Compose drafts (no thread) carry a
// client-generated id instead.
function replyDraftId(userId: string, threadId: string): string {
  return "dr_" + createHash("sha1").update(`${userId}:${threadId}`).digest("hex").slice(0, 24);
}

export interface UpsertDraftInput {
  userId: string;
  // Required for compose drafts (thread_id null); ignored for reply drafts,
  // which derive a deterministic id from (userId, threadId).
  id?: string;
  accountId: string | null;
  threadId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  bodyText: string;
  bodyHtml?: string | null;
  attachments?: TaskMedia[];
}

// Mirrors missiveclone's "empty body deletes" rule. Body and attachments are
// always what make a draft worth keeping. For COMPOSE drafts a subject or
// recipient list also counts (the user typed those). For REPLY drafts the
// recipient + subject are auto-derived from the thread, so they don't count —
// an empty body means an empty reply that shouldn't linger in the folder.
function isEmptyDraft(input: UpsertDraftInput): boolean {
  const hasBody =
    input.bodyText.trim().length > 0 ||
    (input.bodyHtml ?? "").replace(/<br\/?>/g, "").trim().length > 0;
  const hasAttachments = (input.attachments ?? []).length > 0;
  if (hasBody || hasAttachments) return false;

  const isReply = typeof input.threadId === "string" && input.threadId.length > 0;
  if (isReply) return true;

  const hasSubject = (input.subject ?? "").trim().length > 0;
  const hasRecipients = input.to.length > 0 || input.cc.length > 0 || input.bcc.length > 0;
  return !hasSubject && !hasRecipients;
}

// List the caller's drafts, newest first. `visibleAccountIds` is the result of
// visibleAccountIdsFor: `null` = leader/admin (no filter); otherwise we keep
// only drafts whose account the caller can still see (plus account-less
// compose drafts, which are always the owner's to keep).
export async function listDraftsForUser(
  userId: string,
  visibleAccountIds: Set<string> | null
): Promise<InboxDraft[]> {
  const { data } = await getSupabaseAdmin()
    .from("inbox_drafts")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  const drafts = (data ?? []).map((r) => rowToDraft(r as DraftRow));
  if (visibleAccountIds === null) return drafts;
  return drafts.filter((d) => d.accountId === null || visibleAccountIds.has(d.accountId));
}

export async function getDraftById(userId: string, id: string): Promise<InboxDraft | null> {
  const { data } = await getSupabaseAdmin()
    .from("inbox_drafts")
    .select("*")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  return data ? rowToDraft(data as DraftRow) : null;
}

export async function getReplyDraft(userId: string, threadId: string): Promise<InboxDraft | null> {
  const { data } = await getSupabaseAdmin()
    .from("inbox_drafts")
    .select("*")
    .eq("user_id", userId)
    .eq("thread_id", threadId)
    .maybeSingle();
  return data ? rowToDraft(data as DraftRow) : null;
}

// Insert-or-update a draft (autosave). Returns the saved draft, or `null` when
// the draft was empty and therefore deleted instead.
export async function upsertDraft(input: UpsertDraftInput): Promise<InboxDraft | null> {
  const isReply = typeof input.threadId === "string" && input.threadId.length > 0;
  const id = isReply ? replyDraftId(input.userId, input.threadId as string) : input.id;
  if (!id) throw new Error("compose draft requires an id");

  if (isEmptyDraft(input)) {
    await getSupabaseAdmin()
      .from("inbox_drafts")
      .delete()
      .eq("user_id", input.userId)
      .eq("id", id);
    return null;
  }

  const row = {
    id,
    user_id: input.userId,
    account_id: input.accountId,
    thread_id: isReply ? input.threadId : null,
    to_addrs: input.to,
    cc_addrs: input.cc,
    bcc_addrs: input.bcc,
    subject: input.subject,
    body_text: input.bodyText,
    body_html: input.bodyHtml ?? null,
    attachments: input.attachments ?? []
  };
  const { data, error } = await getSupabaseAdmin()
    .from("inbox_drafts")
    .upsert(row, { onConflict: "id" })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return rowToDraft(data as DraftRow);
}

export async function deleteDraftById(userId: string, id: string): Promise<void> {
  await getSupabaseAdmin().from("inbox_drafts").delete().eq("user_id", userId).eq("id", id);
}

export async function deleteReplyDraft(userId: string, threadId: string): Promise<void> {
  await getSupabaseAdmin().from("inbox_drafts").delete().eq("user_id", userId).eq("thread_id", threadId);
}
