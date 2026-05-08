import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

// POST /api/kudos — send a kudos.
// Body: { toUserId: string, message: string, emoji?: string }
//
// Self-kudos are rejected (you can't 👏 yourself). The recipient sees
// it on their desktop widget on the next poll.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json();
    const toUserId = typeof body.toUserId === "string" ? body.toUserId : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const emoji = typeof body.emoji === "string" && body.emoji.length <= 8
      ? body.emoji
      : "👏";

    if (!toUserId) return NextResponse.json({ error: "toUserId required" }, { status: 400 });
    // Self-kudos are allowed (handy for testing the widget end-to-end and
    // for the occasional pat on the back).
    if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });
    if (message.length > 280) return NextResponse.json({ error: "message too long (max 280)" }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const id = `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const { data, error } = await supabase
      .from("kudos")
      .insert({
        id,
        from_user_id: userId,
        to_user_id: toUserId,
        message,
        emoji
      })
      .select("id, message, emoji, created_at, from_user_id, to_user_id")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ kudos: data });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
