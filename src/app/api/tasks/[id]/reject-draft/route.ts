import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { rejectDraftTask } from "@/lib/draft-approval";

export const dynamic = "force-dynamic";

// POST /api/tasks/:id/reject-draft — deletes a draft. Permission +
// row-fetch live in rejectDraftTask().
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await requireCurrentUserId();
  const result = await rejectDraftTask(params.id, userId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true });
}
