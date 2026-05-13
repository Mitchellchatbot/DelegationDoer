import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { syncUserStatusToSlack } from "@/lib/slack-status-sync";

export const dynamic = "force-dynamic";

// PATCH /api/users/me/emoji — set the current user's status emoji.
// Body: { emoji: string | null }. Pass null to clear.
//
// Cheap validation: trim + length cap at 8 chars (DB also enforces). We
// don't whitelist the actual content because emoji codepoints + ZWJ
// sequences are too varied to enumerate.
export async function PATCH(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json();
    const raw = body.emoji;
    let emoji: string | null = null;
    if (raw !== null && raw !== undefined) {
      if (typeof raw !== "string") {
        return NextResponse.json({ error: "emoji must be string or null" }, { status: 400 });
      }
      const trimmed = raw.trim();
      if (trimmed.length > 8) {
        return NextResponse.json({ error: "emoji too long" }, { status: 400 });
      }
      emoji = trimmed || null;
    }
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("users")
      .update({ status_emoji: emoji })
      .eq("id", userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    void syncUserStatusToSlack(userId);
    return NextResponse.json({ ok: true, emoji });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
