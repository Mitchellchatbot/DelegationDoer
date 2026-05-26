import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// POST /api/sod/delete-task
//   body: { id: string }
//
// Companion to /api/sod/create-task. Lets the user delete a task they
// just created from the SOD flow (the X button on a task row). Strict
// guards so this can't be used to nuke arbitrary tasks:
//   - caller must be the task's creator
//   - task must still be untouched (actual_hours === 0) — once anyone
//     has logged time against it the row carries real history and
//     deleting silently would lose data
// Related activity_logs rows are removed first so the FK doesn't
// block the delete.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const body = (await req.json().catch(() => ({}))) as { id?: unknown };
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const { data: task, error: readErr } = await supabase
      .from("tasks")
      .select("id, creator_id, actual_hours")
      .eq("id", id)
      .maybeSingle();
    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
    if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
    if ((task as { creator_id: string }).creator_id !== userId) {
      return NextResponse.json({ error: "only the task creator can delete" }, { status: 403 });
    }
    if (Number((task as { actual_hours: number }).actual_hours ?? 0) > 0) {
      return NextResponse.json(
        { error: "Task has logged time. Open it in /tasks to manage." },
        { status: 409 }
      );
    }

    await supabase.from("activity_logs").delete().eq("task_id", id);
    const { error: delErr } = await supabase.from("tasks").delete().eq("id", id);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}
