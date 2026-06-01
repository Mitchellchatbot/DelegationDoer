import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getUserById } from "@/lib/server-data";
import { loadTaskForViewer } from "@/lib/task-access";
import { canManageTask } from "@/lib/access";

export const dynamic = "force-dynamic";

// POST /api/tasks/[id]/unarchive — bring an archived task back into the active
// views. Clears archived_at/archived_by; the task keeps its status and
// completion date, so a done task returns to the "Done" column (and, if it's
// still older than the window, the next cron run will re-archive it — that's
// intentional; un-archiving is for tasks you want back on the board now).
//
// Same permission as archive (canManageTask). The mirror of the soft-delete
// "restore" flow, but available to managers, not just admins, since archiving
// is non-destructive.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const access = await loadTaskForViewer(params.id);
    if (!access.ok) return access.response;
    const userId = access.viewerId;
    const supabase = getSupabaseAdmin();

    const { data: before, error: beErr } = await supabase
      .from("tasks")
      .select("id, department_id, creator_id, assignee_id, archived_at")
      .eq("id", params.id)
      .maybeSingle();
    if (beErr) return NextResponse.json({ error: beErr.message }, { status: 500 });
    if (!before) return NextResponse.json({ error: "task not found" }, { status: 404 });

    const me = await getUserById(userId);
    if (!canManageTask(me, {
      creatorId: before.creator_id,
      assigneeId: before.assignee_id,
      departmentId: before.department_id ?? null
    })) {
      return NextResponse.json({ error: "You don't have permission to unarchive this task" }, { status: 403 });
    }

    if (!before.archived_at) return NextResponse.json({ ok: true, alreadyActive: true });

    const now = new Date().toISOString();
    const { error: upErr } = await supabase
      .from("tasks")
      .update({ archived_at: null, archived_by: null, last_activity_at: now })
      .eq("id", params.id);
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    await supabase.from("activity_logs").insert({
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      task_id: params.id,
      user_id: userId,
      action: "unarchived",
      detail: "Task unarchived"
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
