"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, X, Loader2, ArrowRight, Mail } from "lucide-react";
import { toast } from "sonner";
import { NewTaskForm, type NewTaskInitialValues } from "./NewTaskForm";

// "Create task from this thread" — now a two-step flow:
//   1. POST /api/email-intake/classify → AI-drafts title, description,
//      tags, suggested assignee. NO task created yet.
//   2. Open the NewTaskForm in a dialog, pre-populated with that draft
//      so the human can sanity-check (right assignee? right priority?
//      anything missing from the description?) before clicking Create.
//
// User can edit any field. Submitting the form goes through the normal
// POST /api/tasks — no email-intake bypass, no auto-creation.
export function CreateTaskFromThreadButton({
  accountId, threadId
}: { accountId: string; threadId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<NewTaskInitialValues | null>(null);
  const [routedNote, setRoutedNote] = useState<string | null>(null);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);

  async function startReview() {
    setBusy(true);
    setRoutedNote(null);
    try {
      const res = await fetch("/api/email-intake/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, threadId })
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "couldn't classify thread");
        return;
      }
      setDraft({
        title: data.title,
        description: data.description,
        priority: data.priority,
        tags: data.tags,
        departmentId: data.departmentId ?? undefined,
        assigneeId: data.suggestedAssigneeId ?? undefined,
        clientEmail: data.fromEmail ?? undefined,
        missiveThreadUrl: data.missiveThreadUrl ?? undefined
      });
      setRoutedNote(data.suggestedAssigneeReason || null);
      setOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  function onCreated(taskId: string) {
    setCreatedTaskId(taskId);
    setOpen(false);
    toast.success("Task created");
    router.refresh();
  }

  if (createdTaskId) {
    return (
      <a
        href={`/tasks/${createdTaskId}`}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift"
        style={{ background: "linear-gradient(135deg, #16a34a 0%, #22c55e 100%)" }}
      >
        Open task <ArrowRight className="w-3.5 h-3.5" />
      </a>
    );
  }

  return (
    <>
      <button
        onClick={startReview}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-white/80 border border-border text-ink/80 hover:text-accent hover:border-accent/40 transition-all hover:-translate-y-0.5 shadow-sm disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0"
      >
        {busy ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Sparkles className="w-3.5 h-3.5" />
        )}
        {busy ? "Reading thread…" : "Create task from this thread"}
      </button>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/60 z-40" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-0 z-50 outline-none pointer-events-none flex items-center justify-center px-4 lg:pl-[264px]"
          >
            <div className="pointer-events-auto w-[720px] max-w-[94vw] max-h-[90vh] overflow-y-auto card p-5">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-accent/15 border border-accent/30 grid place-items-center text-accent">
                    <Mail className="w-4 h-4" />
                  </div>
                  <div>
                    <Dialog.Title className="text-base font-medium">
                      Review the draft
                    </Dialog.Title>
                    <Dialog.Description className="text-xs text-muted">
                      We pre-filled this from the email. Sharpen the description, double-check the assignee, then create.
                    </Dialog.Description>
                  </div>
                </div>
                <Dialog.Close className="btn p-1.5"><X className="w-3.5 h-3.5" /></Dialog.Close>
              </div>

              {routedNote && (
                <div className="mb-3 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2 text-[12px] text-ink/80 inline-flex items-start gap-2">
                  <Sparkles className="w-3.5 h-3.5 text-accent shrink-0 mt-0.5" />
                  <span>
                    <span className="font-medium">Auto-route hint:</span>{" "}
                    {routedNote}. Change the assignee below if you disagree.
                  </span>
                </div>
              )}

              {draft && (
                <NewTaskForm
                  initialValues={draft}
                  onCreated={onCreated}
                  onCancel={() => setOpen(false)}
                  hideCancel
                />
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
