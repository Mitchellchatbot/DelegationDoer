import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getUserById } from "@/lib/server-data";
import { requireCurrentUserId } from "@/lib/session";
import { isLeader } from "@/lib/access";
import { syncTaskToCalendar } from "@/lib/task-calendar-sync";

export const dynamic = "force-dynamic";

// POST /api/tasks/[id]/restore — undo a soft delete.
//
// Recovery is an admin/leader power (matches "recoverable by admins" in the
// spec). Clears deleted_at/deleted_by so the task reappears in normal views.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    let userId: string;
    try {
      userId = await requireCurrentUserId();
    } catch {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const me = await getUserById(userId);
    if (!isLeader(me)) {
      return NextResponse.json({ error: "Only admins can restore deleted tasks" }, { status: 403 });
    }

    const supabase = getSupabaseAdmin();
    const { data: before, error: beErr } = await supabase
      .from("tasks")
      .select("id, deleted_at")
      .eq("id", params.id)
      .maybeSingle();
    if (beErr) return NextResponse.json({ error: beErr.message }, { status: 500 });
    if (!before) return NextResponse.json({ error: "task not found" }, { status: 404 });
    if (!before.deleted_at) return NextResponse.json({ ok: true, alreadyActive: true });

    const now = new Date().toISOString();
    const { error: upErr } = await supabase
      .from("tasks")
      .update({ deleted_at: null, deleted_by: null, last_activity_at: now })
      .eq("id", params.id);
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    await supabase.from("activity_logs").insert({
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      task_id: params.id,
      user_id: userId,
      action: "restored",
      detail: "Task restored from deleted"
    });

    // Re-create the calendar event if the task still wants one.
    void syncTaskToCalendar(params.id);

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
