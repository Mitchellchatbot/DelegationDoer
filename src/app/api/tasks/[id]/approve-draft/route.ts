import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { approveDraftTask, type ApprovePatch } from "@/lib/draft-approval";

export const dynamic = "force-dynamic";

// POST /api/tasks/:id/approve-draft
// Optional body: { assigneeId, priority, title, description } —
// lets the approver tweak the AI's proposal before flipping it live.
// All heavy lifting (permission check, update, activity log, Slack DM)
// lives in approveDraftTask().
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await requireCurrentUserId();
  const body = (await req.json().catch(() => ({}))) as ApprovePatch;
  const result = await approveDraftTask(params.id, userId, body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, task: result.task });
}
