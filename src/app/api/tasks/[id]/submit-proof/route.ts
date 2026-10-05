import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { loadTaskForViewer } from "@/lib/task-access";

export const dynamic = "force-dynamic";
const FB_DEPT = "dep_facebook";

// POST { photoUrl, workDone, testDone } — a Facebook-team member submits a
// completed FB task for manager approval. Requires a photo of the finished work
// and a note of what was done; records whether a test was run. Moves the task to
// 'pending_approval' (NOT done) until a manager proofs it.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const access = await loadTaskForViewer(params.id);
  if (!access.ok) return access.response;
  if (access.task.departmentId !== FB_DEPT) {
    return NextResponse.json({ error: "not a Facebook task" }, { status: 400 });
  }
  const isFbMember = (access.viewer?.departmentIds ?? []).includes(FB_DEPT);
  if (!isFbMember) {
    return NextResponse.json({ error: "Only the Facebook team submits proof" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const photoUrl = typeof body.photoUrl === "string" ? body.photoUrl.trim() : "";
  const workDone = typeof body.workDone === "string" ? body.workDone.trim() : "";
  const testDone = body.testDone === true;
  if (!photoUrl) return NextResponse.json({ error: "A photo of the completed work is required" }, { status: 400 });
  if (!workDone) return NextResponse.json({ error: "Describe what you did" }, { status: 400 });

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  const { error: pErr } = await supabase.from("fb_proof").upsert({
    task_id: params.id,
    photo_url: photoUrl,
    work_done: workDone,
    test_done: testDone,
    submitted_by: access.viewerId,
    submitted_at: now,
    review_status: "pending",
    reviewed_by: null,
    review_notes: null,
    reviewed_at: null,
    updated_at: now
  }, { onConflict: "task_id" });
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });

  const { error: tErr } = await supabase
    .from("tasks")
    .update({ status: "pending_approval", last_activity_at: now })
    .eq("id", params.id);
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });

  // Keep the proof photo in the task's media gallery + timeline too.
  await supabase.from("activity_logs").insert({
    id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    task_id: params.id,
    user_id: access.viewerId,
    action: "submitted_for_approval",
    detail: testDone ? "Submitted for approval · test done" : "Submitted for approval · no test",
    image_url: photoUrl
  }).select("id").maybeSingle();

  return NextResponse.json({ ok: true });
}
