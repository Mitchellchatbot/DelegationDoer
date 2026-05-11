import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { recomputeTaskActualHours } from "@/lib/time-tracking";

export const dynamic = "force-dynamic";

// PATCH /api/clock/entries/[id] — edit a single segment. Body shape (all
// optional): { startedAt, endedAt, taskId, note }. taskId = null clears
// task attribution. We refresh the actuals of any task that was on the
// segment before *or* after the edit, since both can shift.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json();
    const supabase = getSupabaseAdmin();

    const { data: before } = await supabase
      .from("time_entries")
      .select("id, user_id, task_id, started_at, ended_at")
      .eq("id", params.id)
      .maybeSingle();
    if (!before) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (before.user_id !== userId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const update: Record<string, unknown> = {};
    if (typeof body.startedAt === "string") {
      const d = new Date(body.startedAt);
      if (!Number.isNaN(d.getTime())) update.started_at = d.toISOString();
    }
    if (body.endedAt === null) update.ended_at = null;
    else if (typeof body.endedAt === "string") {
      const d = new Date(body.endedAt);
      if (!Number.isNaN(d.getTime())) update.ended_at = d.toISOString();
    }
    if (body.taskId === null) update.task_id = null;
    else if (typeof body.taskId === "string" && body.taskId.length > 0) {
      update.task_id = body.taskId;
    }
    if (body.note === null) update.note = null;
    else if (typeof body.note === "string") update.note = body.note.trim() || null;

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ ok: true, entry: before });
    }

    const { error } = await supabase
      .from("time_entries")
      .update(update)
      .eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const affected = new Set<string>();
    if (before.task_id) affected.add(before.task_id as string);
    const newTaskId = "task_id" in update ? (update.task_id as string | null) : (before.task_id as string | null);
    if (newTaskId) affected.add(newTaskId);
    for (const tid of affected) {
      await recomputeTaskActualHours(tid);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// DELETE /api/clock/entries/[id] — drop a stray segment (e.g. an accidental
// double clock-in). Refresh attributed task's actuals after.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    const { data: before } = await supabase
      .from("time_entries")
      .select("id, user_id, task_id")
      .eq("id", params.id)
      .maybeSingle();
    if (!before) return NextResponse.json({ ok: true });
    if (before.user_id !== userId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const { error } = await supabase.from("time_entries").delete().eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (before.task_id) await recomputeTaskActualHours(before.task_id as string);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
