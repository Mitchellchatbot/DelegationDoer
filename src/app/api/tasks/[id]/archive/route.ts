import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getUserById } from "@/lib/server-data";
import { loadTaskForViewer } from "@/lib/task-access";
import { canManageTask } from "@/lib/access";

export const dynamic = "force-dynamic";

// POST /api/tasks/[id]/archive — manually archive a single task.
//
// Archiving is a non-destructive UPDATE (stamps archived_at/archived_by): the
// task drops off the active board/mine/search lists but keeps every field —
// status, assignee, client, deadline, history, completion date — and stays
// visible on the Archived view. It is NOT a delete and is fully reversible via
// /unarchive. Permission mirrors "can manage this task" (assignee, creator,
// department head, leader/admin) — gentler than delete because it's reversible
// and loses no data.
//
// Intended for finished work, but we don't hard-block non-done tasks: a leader
// may want to shelve something early. If a done task somehow lacks a
// completion date we stamp one now so the Archived view can show "completed".
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const access = await loadTaskForViewer(params.id);
    if (!access.ok) return access.response;
    const userId = access.viewerId;
    const supabase = getSupabaseAdmin();

    const { data: before, error: beErr } = await supabase
      .from("tasks")
      .select("id, status, department_id, creator_id, assignee_id, archived_at, completed_at")
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
      return NextResponse.json({ error: "You don't have permission to archive this task" }, { status: 403 });
    }

    // Already archived → idempotent success.
    if (before.archived_at) {
      return NextResponse.json({ ok: true, alreadyArchived: true });
    }

    const now = new Date().toISOString();
    const update: Record<string, unknown> = {
      archived_at: now,
      archived_by: userId,
      last_activity_at: now
    };
    // Backfill a completion date if a done task is missing one (so the
    // Archived view always has a "completed" timestamp to show).
    if (before.status === "done" && !before.completed_at) {
      update.completed_at = now;
    }

    const { error: upErr } = await supabase
      .from("tasks")
      .update(update)
      .eq("id", params.id);
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    await supabase.from("activity_logs").insert({
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      task_id: params.id,
      user_id: userId,
      action: "archived",
      detail: "Task archived"
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
