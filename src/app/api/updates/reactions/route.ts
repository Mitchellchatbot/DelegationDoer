import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// POST /api/updates/reactions
//   body: { targetType: string, targetId: string, emoji: string }
//
// Toggles a reaction. If the (target, user, emoji) row already exists,
// it's deleted. Otherwise inserted. The unique constraint on the table
// means double-click can't ever create a duplicate, even if optimistic
// UI mis-fires.
//
// Returns { state: "added" | "removed" } so the client can revert if
// the call lost a race with another tab.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json().catch(() => ({}));

    const targetType = typeof body.targetType === "string" ? body.targetType.trim() : "";
    const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
    const emoji = typeof body.emoji === "string" ? body.emoji.trim() : "";

    if (!targetType) return NextResponse.json({ error: "targetType required" }, { status: 400 });
    if (!targetId) return NextResponse.json({ error: "targetId required" }, { status: 400 });
    if (!emoji || emoji.length > 16) {
      return NextResponse.json({ error: "emoji required (max 16 chars)" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

    // Check if the user already reacted with this emoji on this target.
    const { data: existing } = await supabase
      .from("update_reactions")
      .select("id")
      .eq("target_type", targetType)
      .eq("target_id", targetId)
      .eq("user_id", userId)
      .eq("emoji", emoji)
      .maybeSingle();

    if (existing?.id) {
      const { error } = await supabase
        .from("update_reactions")
        .delete()
        .eq("id", existing.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ state: "removed" });
    }

    const id = `rx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const { error } = await supabase.from("update_reactions").insert({
      id,
      target_type: targetType,
      target_id: targetId,
      user_id: userId,
      emoji
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ state: "added", id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
