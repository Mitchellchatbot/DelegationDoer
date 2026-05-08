import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET /api/widget/kudos — unread kudos for the desktop widget. Returns
// each kudos with the sender's name + avatar so the widget can render
// without a second round-trip.
export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("kudos")
      .select("id, message, emoji, created_at, from_user_id")
      .eq("to_user_id", userId)
      .is("acknowledged_at", null)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const senderIds = Array.from(
      new Set((data ?? []).map((k) => k.from_user_id).filter(Boolean) as string[])
    );
    let senders: Record<string, { name: string; avatarUrl: string | null }> = {};
    if (senderIds.length > 0) {
      const { data: us } = await supabase
        .from("users")
        .select("id, name, avatar_url")
        .in("id", senderIds);
      senders = Object.fromEntries(
        (us ?? []).map((u) => [u.id, { name: u.name, avatarUrl: u.avatar_url ?? null }])
      );
    }

    return NextResponse.json({
      kudos: (data ?? []).map((k) => ({
        id: k.id,
        message: k.message,
        emoji: k.emoji ?? "👏",
        createdAt: k.created_at,
        from: k.from_user_id ? senders[k.from_user_id] ?? null : null
      }))
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
