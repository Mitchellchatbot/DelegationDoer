"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { ClientUpdateComposer } from "@/components/ClientUpdateComposer";

// Pop-over wrapper for the Client Update composer, used on the
// /approvals page so an approver can act on a recommendation without
// navigating away. Same composer component the client detail page
// renders — just framed in a backdrop+card with a close button.
//
// Closes on backdrop click, the X button, or Esc. Also closes when
// the composer's submit succeeds (via onSubmitted), so the user lands
// back on the recommendations card with the list refreshed.

interface LockedClient {
  id: string;
  name: string;
  contactEmails: string[];
}

interface Props {
  open: boolean;
  lockedClient: LockedClient | null;
  presetDays?: number;
  onClose: () => void;
  // Optional — fires after a successful submit. The card uses this to
  // re-fetch the recommendations so the just-drafted client's row
  // disappears (or updates).
  onSubmitted?: () => void;
}

export function EodDigestComposerModal({
  open, lockedClient, presetDays, onClose, onSubmitted
}: Props) {
  // Esc closes the modal — matches the other modal patterns in the
  // app (EmailNotificationsOnboardingModal etc.).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lock body scroll while the modal is open so the long composer
  // can scroll inside the card without dragging the approvals page
  // behind it.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open || !lockedClient) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8 bg-black/40 backdrop-blur-sm overflow-y-auto anim-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Compose client update for ${lockedClient.name}`}
    >
      <div
        className="relative w-full max-w-3xl bg-white rounded-2xl shadow-2xl my-auto anim-fade-in-up"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100 sticky top-0 bg-white rounded-t-2xl z-10">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-emerald-700">
              Client update composer
            </div>
            <div className="text-[15px] font-bold text-ink truncate">
              {lockedClient.name}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white border border-slate-200 hover:bg-slate-50 text-ink/65 hover:text-ink grid place-items-center transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="p-4">
          <ClientUpdateComposer
            lockedClient={lockedClient}
            presetDays={presetDays}
            onSubmitted={() => {
              onSubmitted?.();
              onClose();
            }}
          />
        </div>
      </div>
    </div>
  );
}
