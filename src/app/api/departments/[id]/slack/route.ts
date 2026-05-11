import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// PUT /api/departments/[id]/slack — { slackChannelId: string | null }.
// CEO-only. Updates the per-department channel target used by the
// EOD report sender. Pass null/"" to clear.
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me || me.role !== "ceo") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const body = await req.json();
    let value: string | null = null;
    if (typeof body.slackChannelId === "string") {
      const trimmed = body.slackChannelId.trim();
      value = trimmed || null;
    }
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("departments")
      .update({ slack_channel_id: value })
      .eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, slackChannelId: value });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
