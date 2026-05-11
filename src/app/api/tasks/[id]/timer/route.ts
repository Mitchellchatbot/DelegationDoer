import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { closeOpenSegment, openSegment } from "@/lib/time-tracking";

export const dynamic = "force-dynamic";

// POST /api/tasks/[id]/timer — body: { action: "start" | "stop" }.
//
// "start" closes any open segment (whether task or generic) and opens a new
// one tied to this task. If the user wasn't clocked in, this also clocks
// them in (bumps presence to "available").
//
// "stop" closes the active task segment and opens a generic segment so the
// shift continues uninterrupted. If the open segment isn't on this task (or
// nothing is open), it's a no-op — clients shouldn't see this in normal
// flow but the endpoint stays idempotent.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json().catch(() => ({}));
    const action = body?.action === "stop" ? "stop" : "start";
    const supabase = getSupabaseAdmin();

    const { data: task } = await supabase
      .from("tasks")
      .select("id, title, status, assignee_id")
      .eq("id", params.id)
      .maybeSingle();
    if (!task) {
      return NextResponse.json({ error: "task not found" }, { status: 404 });
    }

    if (action === "start") {
      // If we're already running this task, no-op.
      const { data: open } = await supabase
        .from("time_entries")
        .select("id, started_at, task_id")
        .eq("user_id", userId)
        .is("ended_at", null)
        .maybeSingle();
      if (open && open.task_id === params.id) {
        return NextResponse.json({
          ok: true,
          open: { id: open.id, startedAt: open.started_at, taskId: params.id },
          alreadyRunning: true
        });
      }

      const wasClockedIn = Boolean(open);
      await closeOpenSegment(userId);
      const seg = await openSegment(userId, params.id, null);

      if (!wasClockedIn) {
        await supabase
          .from("users")
          .update({ presence: "available", presence_updated_at: new Date().toISOString() })
          .eq("id", userId);
      }

      // Starting the timer is also the user's declaration that they're
      // actively working this task — flip pending → in_progress so the
      // board, my-tasks, and team views all reflect reality without an
      // extra click. Don't override urgent/waiting_on_client/done.
      let statusFlipped = false;
      if (task.status === "pending") {
        await supabase
          .from("tasks")
          .update({ status: "in_progress", last_activity_at: new Date().toISOString() })
          .eq("id", params.id);
        await supabase.from("activity_logs").insert({
          id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
          task_id: params.id,
          user_id: userId,
          action: "status_change",
          detail: "pending → in_progress (timer started)"
        });
        statusFlipped = true;
      }

      return NextResponse.json({
        ok: true,
        open: { id: seg.id, startedAt: seg.startedAt, taskId: params.id },
        autoClockedIn: !wasClockedIn,
        statusFlipped,
        newStatus: statusFlipped ? "in_progress" : task.status
      });
    }

    // action === "stop"
    const { data: open } = await supabase
      .from("time_entries")
      .select("id, task_id")
      .eq("user_id", userId)
      .is("ended_at", null)
      .maybeSingle();
    if (!open) {
      return NextResponse.json({ ok: true, open: null, noop: true });
    }
    if (open.task_id !== params.id) {
      // Different task is active — don't silently swap; client should call
      // start on the right task instead.
      return NextResponse.json({
        ok: true,
        open: { id: open.id, startedAt: null, taskId: open.task_id ?? null },
        wrongTask: true
      });
    }

    await closeOpenSegment(userId);
    // Reopen a generic segment so the shift keeps ticking. (User can clock
    // out separately if they want to actually end their shift.)
    const generic = await openSegment(userId, null, null);
    return NextResponse.json({
      ok: true,
      open: { id: generic.id, startedAt: generic.startedAt, taskId: null }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
