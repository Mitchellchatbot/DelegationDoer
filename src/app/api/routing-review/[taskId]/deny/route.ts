import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { rejectDraftTask } from "@/lib/draft-approval";

export const dynamic = "force-dynamic";

// POST /api/routing-review/:taskId/deny — soft-delete a draft task
// (status → 'rejected'). Optional `reason` in the body gets appended
// to the activity_logs row.
export async function POST(
  req: NextRequest,
  { params }: { params: { taskId: string } }
) {
  const userId = await requireCurrentUserId();
  const body = (await req.json().catch(() => ({}))) as { reason?: string };
  const result = await rejectDraftTask(params.taskId, userId, {
    reason: body?.reason
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true });
}
