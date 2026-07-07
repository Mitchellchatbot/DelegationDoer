import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// GET /api/email-notifications
//   Returns the current user's recent email notifications. Default
//   limit 20 — enough to fill the home card with a "See all" button if
//   we ever build a full page later. Newest first.
//
// Query params:
//   ?limit=N   — cap rows (max 50)
//   ?since=ms  — only rows newer than this epoch ms. Used by the SSE
//                consumer to refetch just what landed while it was
//                listening.

export interface EmailNotificationRow {
  id: string;
  accountId: string;
  threadId: string;
  messageId: string | null;
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  preview: string | null;
  receivedAt: string;
  seenAt: string | null;
}

interface Row {
  id: string;
  missive_account_id: string;
  thread_id: string;
  message_id: string | null;
  subject: string | null;
  from_name: string | null;
  from_email: string | null;
  preview: string | null;
  received_at: string;
  seen_at: string | null;
}

function rowTo(r: Row): EmailNotificationRow {
  return {
    id: r.id,
    accountId: r.missive_account_id,
    threadId: r.thread_id,
    messageId: r.message_id,
    subject: r.subject,
    fromName: r.from_name,
    fromEmail: r.from_email,
    preview: r.preview,
    receivedAt: r.received_at,
    seenAt: r.seen_at
  };
}

export async function GET(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const url = new URL(req.url);
    const rawLimit = Number(url.searchParams.get("limit") ?? "20");
    const limit = Math.min(50, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 20));
    const sinceMs = Number(url.searchParams.get("since") ?? "");
    const unseenOnly = url.searchParams.get("unseenOnly") === "1";

    const supabase = getSupabaseAdmin();
    let q = supabase
      .from("email_notifications")
      .select("id, missive_account_id, thread_id, message_id, subject, from_name, from_email, preview, received_at, seen_at")
      .eq("user_id", userId);
    // Widget passes unseenOnly=1 so still-unseen emails older than the newest
    // `limit` rows aren't stranded outside the window (uses the partial index
    // email_notifications_user_unseen_idx). Home card omits it (wants seen+unseen).
    if (unseenOnly) q = q.is("seen_at", null);
    q = q.order("received_at", { ascending: false }).limit(limit);
    if (Number.isFinite(sinceMs) && sinceMs > 0) {
      q = q.gt("received_at", new Date(sinceMs).toISOString());
    }

    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = ((data ?? []) as Row[]).map(rowTo);
    const unseen = rows.filter((r) => r.seenAt === null).length;
    return NextResponse.json({ notifications: rows, unseen });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
