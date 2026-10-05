import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

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
