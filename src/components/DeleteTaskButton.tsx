"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Delete-task affordance + confirmation modal. Soft-deletes the task via
// DELETE /api/tasks/[id] (with an optional reason captured for the audit
// trail). Used in two places:
//   - "button" variant → the full pill in the task-detail action cluster.
//   - "icon"   variant → a compact icon button on task cards. Because cards
//     are often wrapped in a <Link>/click handler, the trigger calls
//     stopPropagation + preventDefault so opening the dialog never also
//     navigates or starts a drag.
//
// The dialog is fully controlled (plain trigger button, not Dialog.Trigger)
// so the stopPropagation can run before Radix opens it.
export function DeleteTaskButton({
  taskId,
  taskTitle,
  variant = "button",
  redirectTo,
  onDeleted
}: {
  taskId: string;
  taskTitle: string;
  variant?: "button" | "icon";
  // Where to navigate after a successful delete (e.g. "/tasks" from the
  // detail page, since the row is gone and refresh would 404).
  redirectTo?: string;
  // Optional callback so list surfaces can optimistically drop the card.
  onDeleted?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openDialog(e: React.MouseEvent) {
    // Stop the card's Link navigation / drag from also firing.
    e.preventDefault();
    e.stopPropagation();
    setError(null);
    setReason("");
    setOpen(true);
  }

  async function confirmDelete() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() || undefined })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `Failed (${res.status})`);
      toast.success("Task deleted.");
      setOpen(false);
      if (onDeleted) onDeleted();
      if (redirectTo) {
        router.push(redirectTo);
      } else {
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
      setBusy(false);
    }
  }

  return (
    <>
      {variant === "icon" ? (
        <button
          type="button"
          onClick={openDialog}
          title="Delete task"
          aria-label="Delete task"
          className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-lg text-muted hover:text-rose-600 hover:bg-rose-50 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      ) : (
        <button
          type="button"
          onClick={openDialog}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border border-rose-200 bg-rose-50/60 text-rose-700 hover:bg-rose-100 hover:border-rose-300 transition-colors active:scale-95"
          title="Delete this task"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Delete
        </button>
      )}

      <Dialog.Root open={open} onOpenChange={(v) => { if (!busy) setOpen(v); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/25 backdrop-blur-sm z-40" />
          <Dialog.Content
            onClick={(e) => e.stopPropagation()}
            className="fixed inset-0 z-50 outline-none pointer-events-none flex items-center justify-center px-4 lg:pl-[264px]"
          >
            <div className="pointer-events-auto w-[480px] max-w-[92vw] max-h-[90vh] overflow-y-auto card p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <Dialog.Title className="text-base font-medium">Delete this task?</Dialog.Title>
                  <Dialog.Description className="text-xs text-muted mt-0.5">
                    “{taskTitle}” will be removed from all views. An admin can
                    recover it from <span className="text-ink">Recently deleted</span>.
                    The original email (if any) is not affected.
                  </Dialog.Description>
                </div>
                <Dialog.Close className="btn p-1.5" disabled={busy}><X className="w-3.5 h-3.5" /></Dialog.Close>
              </div>

              <div className="space-y-2">
                <label className="label">Reason (optional)</label>
                <textarea
                  className="input min-h-[72px]"
                  placeholder="e.g. duplicate, spam, created by mistake"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>

              {error && <div className="mt-3 text-sm text-urgent">⚠ {error}</div>}

              <div className="mt-5 flex items-center justify-end gap-2">
                <Dialog.Close className="btn" disabled={busy}>Cancel</Dialog.Close>
                <button
                  type="button"
                  onClick={confirmDelete}
                  disabled={busy}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold",
                    "bg-rose-600 text-white hover:bg-rose-700 transition-colors disabled:opacity-50"
                  )}
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  {busy ? "Deleting…" : "Delete task"}
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
