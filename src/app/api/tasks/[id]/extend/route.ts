import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

// POST /api/tasks/[id]/extend
// Body: { hours: number, reason?: string }
// Self-extends the task's due_date by `hours`. Tracked in task_extensions
// so dept heads and the Leader can see how often / how much a task has slipped.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const { hours, reason } = await req.json();
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0 || h > 24 * 30) {
      return NextResponse.json({ error: "hours must be between 0 and 720 (30 days)" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const { data: task, error: te } = await supabase
      .from("tasks")
      .select("id, due_date")
      .eq("id", params.id)
      .maybeSingle();
    if (te) return NextResponse.json({ error: te.message }, { status: 500 });
    if (!task) return NextResponse.json({ error: "task not found" }, { status: 404 });

    const now = new Date();
    const baseTime = task.due_date ? new Date(task.due_date) : now;
    // If the original due date is already in the past, extend from "now" so we
    // don't end up with a still-overdue date. Otherwise extend from due date.
    const fromTime = baseTime.getTime() < now.getTime() ? now : baseTime;
    const newDue = new Date(fromTime.getTime() + h * 36e5);
    const cleanReason = (reason ?? "").trim() || null;

    const { error: ue } = await supabase
      .from("tasks")
      .update({ due_date: newDue.toISOString(), last_activity_at: now.toISOString() })
      .eq("id", params.id);
    if (ue) return NextResponse.json({ error: ue.message }, { status: 500 });

    const extensionId = `ext_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const { data: extension, error: ee } = await supabase
      .from("task_extensions")
      .insert({
        id: extensionId,
        task_id: params.id,
        user_id: userId,
        previous_due_date: task.due_date,
        new_due_date: newDue.toISOString(),
        hours_added: h,
        reason: cleanReason
      })
      .select()
      .single();
    if (ee) return NextResponse.json({ error: ee.message }, { status: 500 });

    await supabase.from("activity_logs").insert({
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      task_id: params.id,
      user_id: userId,
      action: "extended",
      detail: `+${h}h${cleanReason ? ` — ${cleanReason}` : ""}`
    });

    return NextResponse.json({ extension });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
