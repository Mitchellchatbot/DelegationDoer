import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getUserById, getLeaderIds } from "@/lib/server-data";
import { requireCurrentUserId } from "@/lib/session";
import { canViewTask } from "@/lib/access";

// Fetch (taskId, currentUserId) and authorize the viewer against the
// task's leader-privacy rules. Returns either a NextResponse (which the
// caller should return directly) or the trio of values needed to do the
// work. Centralised so every per-task API route can guard with one line.
export async function loadTaskForViewer(
  taskId: string
): Promise<
  | { ok: true; taskId: string; viewerId: string; isLeader: boolean }
  | { ok: false; response: NextResponse }
> {
  let viewerId: string;
  try {
    viewerId = await requireCurrentUserId();
  } catch {
    return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }

  const supabase = getSupabaseAdmin();
  const [{ data: row }, viewer, leaderIds] = await Promise.all([
    supabase
      .from("tasks")
      .select("creator_id, assignee_id, department_id")
      .eq("id", taskId)
      .maybeSingle(),
    getUserById(viewerId),
    getLeaderIds()
  ]);

  if (!row) {
    return { ok: false, response: NextResponse.json({ error: "not found" }, { status: 404 }) };
  }

  const task = {
    creatorId: (row.creator_id as string) ?? "",
    assigneeId: (row.assignee_id as string | null) ?? null,
    departmentId: (row.department_id as string | null) ?? null
  };

  if (!canViewTask(viewer, task, leaderIds)) {
    // 404 instead of 403 so we don't confirm the task exists.
    return { ok: false, response: NextResponse.json({ error: "not found" }, { status: 404 }) };
  }

  return { ok: true, taskId, viewerId, isLeader: viewer?.role === "leader" || viewer?.isAdmin === true };
}
