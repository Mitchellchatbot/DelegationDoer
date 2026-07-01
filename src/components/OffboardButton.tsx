"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { UserMinus, Loader2, X, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Per-row "Off-board" affordance for the Leader Console's People tab.
// Hard-deletes the teammate and their login via DELETE /api/users/[id]
// (leader/admin-only server-side). This is irreversible and high blast
// radius, so — unlike the softer per-row actions — the confirm button
// stays disabled until the admin types the person's name.
//
// Modelled on DeleteTaskButton: a fully controlled Radix dialog (plain
// trigger, not Dialog.Trigger) with busy/error state and an onOffboarded
// callback so the list can optimistically drop the row.
export function OffboardButton({
  userId,
  userName,
  userEmail,
  onOffboarded
}: {
  userId: string;
  userName: string;
  userEmail: string;
  // Called after a successful off-board so the People table can remove
  // the row without a full refetch.
  onOffboarded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Case/space-insensitive so "  ada lovelace " still matches "Ada Lovelace".
  const matches =
    confirmText.trim().toLowerCase() === userName.trim().toLowerCase();

  function openDialog() {
    setError(null);
    setConfirmText("");
    setOpen(true);
  }

  async function confirmOffboard() {
    if (busy || !matches) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(userId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `Failed (${res.status})`);
      if (data?.authDeleteError) {
        // The app account is gone, but their auth login lingered. Warn so
        // the admin can clean it up in the Supabase dashboard if needed.
        toast.warning(
          `${userName} removed, but their login couldn't be revoked — ${data.authDeleteError}`
        );
      } else {
        toast.success(`${userName} has been off-boarded.`);
      }
      setOpen(false);
      onOffboarded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "off-board failed");
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        title={`Off-board ${userName}`}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border border-rose-200 bg-rose-50/60 text-rose-700 hover:bg-rose-100 hover:border-rose-300 transition-colors active:scale-95"
      >
        <UserMinus className="w-3 h-3" />
        Off-board
      </button>

      <Dialog.Root open={open} onOpenChange={(v) => { if (!busy) setOpen(v); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/25 backdrop-blur-sm z-40" />
          <Dialog.Content className="fixed inset-0 z-50 outline-none pointer-events-none flex items-center justify-center px-4 lg:pl-[264px]">
            <div className="pointer-events-auto w-[480px] max-w-[92vw] max-h-[90vh] overflow-y-auto card p-5">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-start gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-rose-100 text-rose-600 grid place-items-center shrink-0">
                    <AlertTriangle className="w-4 h-4" />
                  </div>
                  <div>
                    <Dialog.Title className="text-base font-medium">
                      Off-board {userName}?
                    </Dialog.Title>
                    <Dialog.Description className="text-xs text-muted mt-0.5">
                      This permanently removes <span className="text-ink">{userEmail}</span> and
                      their login from the app. Tasks they authored are reassigned to you;
                      their assignments, memberships and history are cleared.
                      <span className="text-rose-600 font-medium"> This can&apos;t be undone.</span>
                    </Dialog.Description>
                  </div>
                </div>
                <Dialog.Close className="btn p-1.5" disabled={busy}><X className="w-3.5 h-3.5" /></Dialog.Close>
              </div>

              <div className="space-y-2">
                <label className="label">
                  Type <span className="font-semibold text-ink">{userName}</span> to confirm
                </label>
                <input
                  className="input"
                  placeholder={userName}
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter" && matches) confirmOffboard(); }}
                />
              </div>

              {error && <div className="mt-3 text-sm text-urgent">⚠ {error}</div>}

              <div className="mt-5 flex items-center justify-end gap-2">
                <Dialog.Close className="btn" disabled={busy}>Cancel</Dialog.Close>
                <button
                  type="button"
                  onClick={confirmOffboard}
                  disabled={busy || !matches}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold",
                    "bg-rose-600 text-white hover:bg-rose-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  )}
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserMinus className="w-3.5 h-3.5" />}
                  {busy ? "Off-boarding…" : "Off-board"}
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
