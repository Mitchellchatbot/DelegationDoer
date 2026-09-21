"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type Mode = "task" | "checklist";

// Deletes a Facebook client onboarding. Two strengths:
//   - "task" (default): soft-deletes the backing task. Gone from every view,
//     recoverable from Recently deleted — checklist and chat come back with it.
//   - "checklist": keeps the task, permanently erases the checklist progress.
// Which options show depends on the viewer's rights (canDeleteTask vs
// canManageTask); the routes enforce the same gates.
export function DeleteFbOnboardingButton({
  taskId, provider, canDeleteTask, canRemoveChecklist, variant = "button"
}: {
  taskId: string;
  provider: string;
  canDeleteTask: boolean;
  canRemoveChecklist: boolean;
  // "icon" sits on the list cards, which are links — the trigger stops the
  // click so opening the dialog never also navigates.
  variant?: "button" | "icon";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(canDeleteTask ? "task" : "checklist");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canDeleteTask && !canRemoveChecklist) return null;

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = mode === "task"
        ? await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "Facebook onboarding deleted" })
          })
        : await fetch(`/api/tasks/${encodeURIComponent(taskId)}/fb-onboarding`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `Failed (${res.status})`);
      toast.success(mode === "task" ? "Onboarding deleted" : "Checklist removed");
      setOpen(false);
      setBusy(false);
      router.push("/fb-onboarding");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete failed");
      setBusy(false);
    }
  }

  const options: { id: Mode; title: string; body: string; allowed: boolean }[] = [
    {
      id: "task",
      title: "Delete the onboarding and its task",
      body: "Removed from every view. A leader can restore it from Recently deleted — checklist and notes included.",
      allowed: canDeleteTask
    },
    {
      id: "checklist",
      title: "Remove the checklist only",
      body: "The task and its notes stay. All checklist progress is erased permanently.",
      allowed: canRemoveChecklist
    }
  ];

  return (
    <>
      {variant === "icon" ? (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setError(null); setOpen(true); }}
          title="Delete onboarding"
          aria-label="Delete onboarding"
          className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-muted hover:text-rose-600 hover:bg-rose-50 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => { setError(null); setOpen(true); }}
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border border-rose-200 bg-rose-50/60 text-rose-700 hover:bg-rose-100 hover:border-rose-300 transition-colors active:scale-95"
        >
          <Trash2 className="w-3.5 h-3.5" /> Delete
        </button>
      )}

      <Dialog.Root open={open} onOpenChange={(v) => { if (!busy) setOpen(v); }}>
        <Dialog.Portal>
          {/* Portal events still bubble through the React tree to the card's
              <Link>, so every click inside the dialog is stopped here. */}
          <Dialog.Overlay onClick={(e) => e.stopPropagation()} className="fixed inset-0 bg-black/25 backdrop-blur-sm z-40" />
          <Dialog.Content
            onClick={(e) => e.stopPropagation()}
            className="fixed inset-0 z-50 outline-none pointer-events-none flex items-center justify-center px-4 lg:pl-[264px]">
            <div className="pointer-events-auto w-[480px] max-w-[92vw] card p-5">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <Dialog.Title className="text-base font-medium">Delete {provider || "this"} onboarding?</Dialog.Title>
                  <Dialog.Description className="text-xs text-muted mt-0.5">Choose how much to remove.</Dialog.Description>
                </div>
                <Dialog.Close className="btn p-1.5" disabled={busy}><X className="w-3.5 h-3.5" /></Dialog.Close>
              </div>

              <div className="space-y-2">
                {options.filter((o) => o.allowed).map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => setMode(o.id)}
                    className={cn(
                      "w-full text-left rounded-xl border p-3 transition-colors",
                      mode === o.id ? "border-rose-300 bg-rose-50/60" : "border-border hover:bg-surface2"
                    )}
                  >
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className={cn("w-3.5 h-3.5 rounded-full border-2 shrink-0", mode === o.id ? "border-rose-600 bg-rose-600 ring-2 ring-inset ring-white" : "border-slate-300")} />
                      {o.title}
                    </div>
                    <div className="text-xs text-muted mt-1 pl-[22px]">{o.body}</div>
                  </button>
                ))}
              </div>

              {error && <div className="mt-3 text-sm text-urgent">⚠ {error}</div>}

              <div className="mt-5 flex items-center justify-end gap-2">
                <Dialog.Close className="btn" disabled={busy}>Cancel</Dialog.Close>
                <button type="button" onClick={confirm} disabled={busy} className="btn-danger">
                  {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {mode === "task" ? "Delete onboarding" : "Remove checklist"}
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
