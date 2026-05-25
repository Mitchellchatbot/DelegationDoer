import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { approveDraftTask, type ApprovePatch } from "@/lib/draft-approval";

export const dynamic = "force-dynamic";

// POST /api/routing-review/:taskId/approve — promote a draft task to a
// live "pending" task. Accepts an optional ApprovePatch in the body so
// the reviewer can adjust title / description / assignee / dept / due
// date / priority in the same call.
export async function POST(
  req: NextRequest,
  { params }: { params: { taskId: string } }
) {
  const userId = await requireCurrentUserId();
  const body = (await req.json().catch(() => ({}))) as ApprovePatch;
  const result = await approveDraftTask(params.taskId, userId, body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, task: result.task });
}
