import { NextRequest, NextResponse } from "next/server";
import { loadTaskForViewer } from "@/lib/task-access";
import { reviewFbProof, isFbProofer, type ReviewAction } from "@/lib/fb-proof";

export const dynamic = "force-dynamic";

// POST { action: 'approve' | 'send_back', notes? } — a Facebook manager proofs a
// submitted FB task. Approve → Done. Send back → In progress with a note.
// Only an FB department_head (or a leader) may review, and never their own work.
// The rules themselves live in reviewFbProof, shared with bulk approve.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const access = await loadTaskForViewer(params.id);
  if (!access.ok) return access.response;

  const body = await req.json().catch(() => ({}));
  const action: ReviewAction | "" =
    body.action === "approve" ? "approve" : body.action === "send_back" ? "send_back" : "";
  if (!action) return NextResponse.json({ error: "action must be approve or send_back" }, { status: 400 });

  const result = await reviewFbProof({
    taskId: params.id,
    viewerId: access.viewerId,
    isProofer: isFbProofer(access.viewer),
    departmentId: access.task.departmentId,
    action,
    notes: typeof body.notes === "string" ? body.notes : ""
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, status: result.status });
}
