import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getUserById } from "@/lib/server-data";
import { requireCurrentUserId } from "@/lib/session";
import { isLeader } from "@/lib/access";
import { syncTaskToCalendar } from "@/lib/task-calendar-sync";

export const dynamic = "force-dynamic";

// POST /api/tasks/bulk-delete — soft-delete multiple tasks at once.
//   body: { taskIds: string[], reason?: string }
//
// Admin/leader only (the spec scopes bulk delete to admins). Each task is
// soft-deleted, snapshotted into task_deletions, and logged. Same email-safe
// guarantees as the single delete.
export async function POST(req: NextRequest) {
  try {
    let userId: string;
    try {
      userId = await requireCurrentUserId();
    } catch {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const me = await getUserById(userId);
    if (!isLeader(me)) {
      return NextResponse.json({ error: "Only admins can bulk-delete tasks" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const taskIds: string[] = Array.isArray(body?.taskIds)
      ? body.taskIds.filter((v: unknown): v is string => typeof v === "string")
      : [];
    if (taskIds.length === 0) {
      return NextResponse.json({ error: "taskIds must be a non-empty array" }, { status: 400 });
    }
    const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim() : null;

    const supabase = getSupabaseAdmin();

    // Snapshot the rows that are actually live (skip ones already deleted).
    const { data: rows, error: fetchErr } = await supabase
      .from("tasks")
      .select("*")
      .in("id", taskIds)
      .is("deleted_at", null);
    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });

    const live = rows ?? [];
    const liveIds = live.map((r) => r.id as string);
    if (liveIds.length === 0) {
      return NextResponse.json({ ok: true, deleted: 0 });
    }

    const now = new Date().toISOString();
    const { error: delErr } = await supabase
      .from("tasks")
      .update({ deleted_at: now, deleted_by: userId, last_activity_at: now })
      .in("id", liveIds);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

    // Audit + timeline entries for each task (best-effort).
    const auditRows = live.map((r) => ({
      id: `td_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
      task_id: r.id as string,
      task_title: (r.title as string) ?? "(untitled)",
      deleted_by: userId,
      reason,
      task_snapshot: r
    }));
    const activityRows = liveIds.map((id) => ({
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
      task_id: id,
      user_id: userId,
      action: "deleted",
      detail: reason ? `Task deleted (bulk)\n${reason}` : "Task deleted (bulk)"
    }));
    await supabase.from("task_deletions").insert(auditRows);
    await supabase.from("activity_logs").insert(activityRows);

    // Calendar cleanup per task (fire-and-forget).
    for (const id of liveIds) void syncTaskToCalendar(id);

    return NextResponse.json({ ok: true, deleted: liveIds.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
