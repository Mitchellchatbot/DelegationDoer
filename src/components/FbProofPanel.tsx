"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, ShieldCheck, Undo2 } from "lucide-react";
import { MediaPicker } from "@/components/MediaPicker";
import type { TaskMedia } from "@/lib/types";

// Facebook task proofing panel. For an FB-team member: submit the finished task
// for manager approval (photo + what you did + test done). For a manager: review
// a submitted task and approve (→ Done) or send it back (→ In progress).

export interface FbProofData {
  photoUrl: string | null;
  workDone: string | null;
  testDone: boolean;
  submittedBy: string | null;
  reviewStatus: "pending" | "approved" | "sent_back";
  reviewNotes: string | null;
}

export function FbProofPanel({ taskId, taskStatus, isFbMember, isProofer, viewerId, proof, submitterName }: {
  taskId: string;
  taskStatus: string;
  isFbMember: boolean;
  isProofer: boolean;
  viewerId: string;
  proof: FbProofData | null;
  submitterName: string | null;
}) {
  const router = useRouter();
  const [photo, setPhoto] = useState<TaskMedia[]>([]);
  const [workDone, setWorkDone] = useState("");
  const [testDone, setTestDone] = useState(false);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const awaiting = taskStatus === "pending_approval";
  const sentBack = !awaiting && proof?.reviewStatus === "sent_back";
  const canSubmit = isFbMember && !awaiting && taskStatus !== "done";
  const canReview = awaiting && isProofer && proof?.submittedBy !== viewerId;

  async function submit() {
    const photoUrl = photo[0]?.url;
    if (!photoUrl) { toast.error("Add a photo of the completed work"); return; }
    if (!workDone.trim()) { toast.error("Describe what you did"); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/submit-proof`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photoUrl, workDone: workDone.trim(), testDone })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Failed");
      toast.success("Submitted for manager approval");
      router.refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  async function review(action: "approve" | "send_back") {
    if (action === "send_back" && !notes.trim()) { toast.error("Add a note so they know what to fix"); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/proof/review`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, notes: notes.trim() })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Failed");
      toast.success(action === "approve" ? "Approved — marked Done" : "Sent back for rework");
      router.refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  // Nothing to show: not an FB submitter and nothing awaiting review.
  if (!canSubmit && !awaiting && !(taskStatus === "done" && proof?.reviewStatus === "approved")) return null;

  return (
    <section className="card p-4 border-violet-200 bg-violet-50/40">
      <div className="flex items-center gap-2 mb-3">
        <ShieldCheck className="w-4 h-4 text-violet-600" />
        <div className="text-sm font-medium text-violet-900">Facebook — manager approval</div>
      </div>

      {/* Approved summary */}
      {taskStatus === "done" && proof?.reviewStatus === "approved" && (
        <div className="text-[13px] text-emerald-700 inline-flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4" /> Approved and complete.
        </div>
      )}

      {/* Awaiting review — show the submission */}
      {awaiting && proof && (
        <div className="space-y-3">
          <div className="text-[12px] text-violet-800">Submitted{submitterName ? ` by ${submitterName}` : ""} · waiting for a manager to approve.</div>
          {proof.photoUrl && (
            <a href={proof.photoUrl} target="_blank" rel="noreferrer" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={proof.photoUrl} alt="Proof of completed work" className="max-h-56 rounded-lg border border-slate-200" />
            </a>
          )}
          <div className="text-[13px]"><span className="text-muted">What was done:</span> {proof.workDone}</div>
          <div className="text-[13px]"><span className="text-muted">Test done:</span> {proof.testDone ? "Yes" : "No"}</div>

          {canReview ? (
            <div className="pt-2 border-t border-violet-100 space-y-2">
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Note (required to send back)…"
                className="w-full text-[13px] rounded-lg border border-slate-200 px-2.5 py-1.5 focus:outline-none focus:border-slate-400" rows={2} />
              <div className="flex items-center gap-2">
                <button type="button" disabled={busy} onClick={() => review("approve")} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-white bg-emerald-600 rounded-lg px-3 py-1.5 hover:bg-emerald-700 disabled:opacity-50">
                  <CheckCircle2 className="w-4 h-4" /> Approve → Done
                </button>
                <button type="button" disabled={busy} onClick={() => review("send_back")} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 hover:bg-amber-100 disabled:opacity-50">
                  <Undo2 className="w-4 h-4" /> Send back
                </button>
              </div>
            </div>
          ) : (
            <div className="text-[12px] text-muted pt-1">{proof?.submittedBy === viewerId ? "A manager (Mujtaba or Hasan) will review this." : "Only a Facebook manager can approve."}</div>
          )}
        </div>
      )}

      {/* Submit form (FB member, not yet submitted / sent back for rework) */}
      {canSubmit && (
        <div className="space-y-2.5">
          {sentBack && proof?.reviewNotes && (
            <div className="text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
              Sent back: {proof.reviewNotes}
            </div>
          )}
          <div className="text-[12px] text-violet-800">Finished? Submit for a manager to proof — photo + what you did + whether you tested it.</div>
          <MediaPicker value={photo} onChange={setPhoto} taskId={taskId} label="Add photo of completed work" compact />
          <textarea value={workDone} onChange={(e) => setWorkDone(e.target.value)} placeholder="What did you do?"
            className="w-full text-[13px] rounded-lg border border-slate-200 px-2.5 py-1.5 focus:outline-none focus:border-slate-400" rows={2} />
          <label className="flex items-center gap-2 text-[13px] text-slate-700">
            <input type="checkbox" checked={testDone} onChange={(e) => setTestDone(e.target.checked)} /> I ran a test / verified it works
          </label>
          <button type="button" disabled={busy} onClick={submit} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-white bg-violet-600 rounded-lg px-3 py-1.5 hover:bg-violet-700 disabled:opacity-50">
            <ShieldCheck className="w-4 h-4" /> Submit for approval
          </button>
        </div>
      )}
    </section>
  );
}
