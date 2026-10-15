import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getUserById } from "@/lib/server-data";
import { requireCurrentUserId } from "@/lib/session";
import { reviewFbProof, isFbProofer } from "@/lib/fb-proof";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/tasks/bulk-approve — approve several submitted FB tasks at once.
//   body: { taskIds: string[] }
//
// Every task goes through the same reviewFbProof() the single-task route uses,
// so the rules can't drift: FB task, pending submission, never your own work.
// Each task is reported on individually — one task the caller may not approve
// skips rather than failing the batch, and the response says which and why.
export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await requireCurrentUserId();
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const me = await getUserById(userId);
  if (!isFbProofer(me)) {
    return NextResponse.json({ error: "Only a Facebook manager can approve tasks" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const taskIds: string[] = Array.isArray(body?.taskIds)
    ? Array.from(new Set(body.taskIds.filter((v: unknown): v is string => typeof v === "string")))
    : [];
  if (taskIds.length === 0) {
    return NextResponse.json({ error: "taskIds must be a non-empty array" }, { status: 400 });
  }
  if (taskIds.length > 100) {
    return NextResponse.json({ error: "Approve at most 100 tasks at a time" }, { status: 400 });
  }

  // One read for the whole batch; reviewFbProof takes the department rather
  // than re-reading the task per id.
  const { data: rows, error } = await getSupabaseAdmin()
    .from("tasks")
    .select("id, title, department_id, status, deleted_at")
    .in("id", taskIds);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const byId = new Map((rows ?? []).map((r) => [r.id as string, r]));

  const approved: string[] = [];
  const skipped: { taskId: string; title: string | null; reason: string }[] = [];

  for (const id of taskIds) {
    const t = byId.get(id);
    if (!t || t.deleted_at) {
      skipped.push({ taskId: id, title: null, reason: "task not found" });
      continue;
    }
    if (t.status !== "pending_approval") {
      skipped.push({ taskId: id, title: (t.title as string) ?? null, reason: "not waiting for approval" });
      continue;
    }
    const result = await reviewFbProof({
      taskId: id,
      viewerId: userId,
      isProofer: true,
      departmentId: (t.department_id as string | null) ?? null,
      action: "approve"
    });
    if (result.ok) approved.push(id);
    else skipped.push({ taskId: id, title: (t.title as string) ?? null, reason: result.error });
  }

  return NextResponse.json({ ok: true, approved: approved.length, approvedIds: approved, skipped });
}
