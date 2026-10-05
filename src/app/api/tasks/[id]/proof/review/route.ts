import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { loadTaskForViewer } from "@/lib/task-access";
import { isLeader } from "@/lib/access";

export const dynamic = "force-dynamic";
const FB_DEPT = "dep_facebook";

// POST { action: 'approve' | 'send_back', notes? } — a Facebook manager proofs a
// submitted FB task. Approve → Done. Send back → In progress with a note.
// Only an FB department_head (or a leader) may review, and never their own work.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const access = await loadTaskForViewer(params.id);
  if (!access.ok) return access.response;
  if (access.task.departmentId !== FB_DEPT) {
    return NextResponse.json({ error: "not a Facebook task" }, { status: 400 });
  }
  const v = access.viewer;
  const isProofer = !!v && ((v.departmentIds ?? []).includes(FB_DEPT) && v.role === "department_head" || isLeader(v));
  if (!isProofer) {
    return NextResponse.json({ error: "Only a Facebook manager can approve tasks" }, { status: 403 });
  }

  const supabase = getSupabaseAdmin();
  const { data: proof } = await supabase
    .from("fb_proof").select("submitted_by, review_status").eq("task_id", params.id).maybeSingle();
  if (!proof) return NextResponse.json({ error: "No submission to review" }, { status: 404 });
  if (proof.submitted_by === access.viewerId) {
    return NextResponse.json({ error: "You can't approve your own submission" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const action = body.action === "approve" ? "approve" : body.action === "send_back" ? "send_back" : "";
  if (!action) return NextResponse.json({ error: "action must be approve or send_back" }, { status: 400 });
  const notes = typeof body.notes === "string" ? body.notes.trim() : "";
  if (action === "send_back" && !notes) {
    return NextResponse.json({ error: "Add a note so they know what to fix" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const taskStatus = action === "approve" ? "done" : "in_progress";
  const taskUpdate: Record<string, unknown> = { status: taskStatus, last_activity_at: now };
  if (action === "approve") taskUpdate.completed_at = now;

  const { error: tErr } = await supabase.from("tasks").update(taskUpdate).eq("id", params.id);
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });

  const { error: pErr } = await supabase.from("fb_proof").update({
    review_status: action === "approve" ? "approved" : "sent_back",
    reviewed_by: access.viewerId,
    review_notes: notes || null,
    reviewed_at: now,
    updated_at: now
  }).eq("task_id", params.id);
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });

  await supabase.from("activity_logs").insert({
    id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    task_id: params.id,
    user_id: access.viewerId,
    action: action === "approve" ? "proof_approved" : "proof_sent_back",
    detail: action === "approve" ? "Approved — marked Done" : `Sent back: ${notes}`
  }).select("id").maybeSingle();

  return NextResponse.json({ ok: true, status: taskStatus });
}
