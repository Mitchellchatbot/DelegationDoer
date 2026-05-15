import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// PUT /api/departments/[id]/task-channel — { taskChannelId: string | null }.
// Leader-only. Updates the channel that receives new-task announcements
// for this department (e.g. Website team → #website-to-do). Distinct
// from /slack which targets the EOD digest channel.
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me || !(me.role === "leader" || me.isAdmin)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const body = await req.json();
    let value: string | null = null;
    if (typeof body.taskChannelId === "string") {
      const trimmed = body.taskChannelId.trim();
      value = trimmed || null;
    }
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("departments")
      .update({ task_channel_id: value })
      .eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, taskChannelId: value });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
