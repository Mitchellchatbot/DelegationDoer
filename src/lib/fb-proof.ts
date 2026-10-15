import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isFbProofer } from "@/lib/access";

export { isFbProofer };

// The Facebook proof-of-work submission for a task (see fb_proof table).
export interface FbProof {
  photoUrl: string | null;
  workDone: string | null;
  testDone: boolean;
  submittedBy: string | null;
  submittedAt: string;
  reviewStatus: "pending" | "approved" | "sent_back";
  reviewedBy: string | null;
  reviewNotes: string | null;
  reviewedAt: string | null;
}

export async function getFbProof(taskId: string): Promise<FbProof | null> {
  const { data } = await getSupabaseAdmin()
    .from("fb_proof")
    .select("photo_url, work_done, test_done, submitted_by, submitted_at, review_status, reviewed_by, review_notes, reviewed_at")
    .eq("task_id", taskId)
    .maybeSingle();
  if (!data) return null;
  return {
    photoUrl: data.photo_url ?? null,
    workDone: data.work_done ?? null,
    testDone: !!data.test_done,
    submittedBy: data.submitted_by ?? null,
    submittedAt: data.submitted_at,
    reviewStatus: (data.review_status ?? "pending") as FbProof["reviewStatus"],
    reviewedBy: data.reviewed_by ?? null,
    reviewNotes: data.review_notes ?? null,
    reviewedAt: data.reviewed_at ?? null
  };
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export type ReviewAction = "approve" | "send_back";

export type ReviewOutcome =
  | { ok: true; status: "done" | "in_progress" }
  | { ok: false; status: number; error: string };

// Approve (→ Done) or send back (→ In progress) one submitted FB task.
//
// Shared by the single-task route and the board's bulk approve, so the rules
// live in exactly one place: the task must be a Facebook task with a pending
// submission, the reviewer must be an FB department head or a leader, and
// nobody approves their own work.
//
// `viewer` is passed in rather than re-read per task — bulk approve resolves
// it once for the whole batch.
export async function reviewFbProof(args: {
  taskId: string;
  viewerId: string;
  isProofer: boolean;
  departmentId: string | null;
  action: ReviewAction;
  notes?: string;
}): Promise<ReviewOutcome> {
  const { taskId, viewerId, isProofer, departmentId, action } = args;
  const notes = (args.notes ?? "").trim();

  if (departmentId !== "dep_facebook") {
    return { ok: false, status: 400, error: "not a Facebook task" };
  }
  if (!isProofer) {
    return { ok: false, status: 403, error: "Only a Facebook manager can approve tasks" };
  }
  if (action === "send_back" && !notes) {
    return { ok: false, status: 400, error: "Add a note so they know what to fix" };
  }

  const supabase = getSupabaseAdmin();
  const { data: proof } = await supabase
    .from("fb_proof").select("submitted_by, review_status").eq("task_id", taskId).maybeSingle();
  if (!proof) return { ok: false, status: 404, error: "No submission to review" };
  if (proof.submitted_by === viewerId) {
    return { ok: false, status: 403, error: "You can't approve your own submission" };
  }

  const now = new Date().toISOString();
  const taskStatus = action === "approve" ? "done" : "in_progress";
  const taskUpdate: Record<string, unknown> = { status: taskStatus, last_activity_at: now };
  if (action === "approve") taskUpdate.completed_at = now;

  const { error: tErr } = await supabase.from("tasks").update(taskUpdate).eq("id", taskId);
  if (tErr) return { ok: false, status: 500, error: tErr.message };

  const { error: pErr } = await supabase.from("fb_proof").update({
    review_status: action === "approve" ? "approved" : "sent_back",
    reviewed_by: viewerId,
    review_notes: notes || null,
    reviewed_at: now,
    updated_at: now
  }).eq("task_id", taskId);
  if (pErr) return { ok: false, status: 500, error: pErr.message };

  await supabase.from("activity_logs").insert({
    id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    task_id: taskId,
    user_id: viewerId,
    action: action === "approve" ? "proof_approved" : "proof_sent_back",
    detail: action === "approve" ? "Approved — marked Done" : `Sent back: ${notes}`
  }).select("id").maybeSingle();

  return { ok: true, status: taskStatus };
}
