import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getUserById, getLeaderIds } from "@/lib/server-data";
import { requireCurrentUserId } from "@/lib/session";
import { canViewTask } from "@/lib/access";
import type { Task, User } from "@/lib/types";

// The slice of a task this helper reads. Enough to answer canViewTask and
// canClaimTask, so callers that need to gate a write don't have to re-fetch.
export type TaskAccessShape = Pick<
  Task,
  "creatorId" | "assigneeId" | "departmentId" | "tags" | "status"
>;

// Fetch (taskId, currentUserId) and authorize the viewer against the
// task's leader-privacy rules. Returns either a NextResponse (which the
// caller should return directly) or the trio of values needed to do the
// work. Centralised so every per-task API route can guard with one line.
export async function loadTaskForViewer(
  taskId: string
): Promise<
  | {
      ok: true;
      taskId: string;
      viewerId: string;
      isLeader: boolean;
      viewer: User | null;
      task: TaskAccessShape;
    }
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
      // tags + status are here for canViewTask's team-task escape and for
      // canClaimTask — without them every team task 404s on the detail page
      // and the claim route can't gate.
      .select("creator_id, assignee_id, department_id, tags, status")
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
    departmentId: (row.department_id as string | null) ?? null,
    tags: (row.tags as string[] | null) ?? [],
    status: row.status as Task["status"]
  };

  if (!canViewTask(viewer, task, leaderIds)) {
    // 404 instead of 403 so we don't confirm the task exists.
    return { ok: false, response: NextResponse.json({ error: "not found" }, { status: 404 }) };
  }

  return {
    ok: true,
    taskId,
    viewerId,
    isLeader: viewer?.role === "leader" || viewer?.isAdmin === true,
    // Handed back so a caller gating a WRITE (claim, reassign) doesn't have
    // to re-fetch the row or the user. This helper is a read gate; routes
    // that mutate ownership must still apply their own check on top.
    viewer,
    task
  };
}
