import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// GET /api/support-notifications
//   Returns the current user's recent customer-support notifications, newest
//   first. Non-support users simply have no rows (fan-out only writes for
//   support-visible users), so this safely returns an empty payload for every
//   widget that polls it — no extra 403 gate needed. Mirrors
//   /api/email-notifications.
//
// Query params:
//   ?limit=N   — cap rows (max 50)
//   ?since=ms  — only rows newer than this epoch ms.

export interface SupportNotificationRow {
  id: string;
  conversationId: string;
  messageId: string;
  contactName: string | null;
  phone: string | null;
  preview: string | null;
  category: string | null;
  receivedAt: string;
  seenAt: string | null;
}

interface Row {
  id: string;
  conversation_id: string;
  message_id: string;
  contact_name: string | null;
  phone: string | null;
  preview: string | null;
  category: string | null;
  received_at: string;
  seen_at: string | null;
}

function rowTo(r: Row): SupportNotificationRow {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    contactName: r.contact_name,
    phone: r.phone,
    preview: r.preview,
    category: r.category,
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

    const supabase = getSupabaseAdmin();
    let q = supabase
      .from("support_notifications")
      .select("id, conversation_id, message_id, contact_name, phone, preview, category, received_at, seen_at")
      .eq("user_id", userId)
      .order("received_at", { ascending: false })
      .limit(limit);
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
