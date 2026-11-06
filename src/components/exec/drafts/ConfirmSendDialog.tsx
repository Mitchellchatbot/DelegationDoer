"use client";

import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { GenerationFlag, ReviewBlocker, ReviewResult } from "@/lib/exec/drafts-types";
import { ConfirmSendContent } from "./ConfirmSendContent";
import { useIsTopWindow } from "./frame-guard";

// The confirm dialog (P4 contract §3.13.3, L10, L16, C64). A Radix dialog
// portaled into <body>: the app's <main> is a z-10 stacking context, so a
// fixed overlay rendered inside it would sit under the top bar. Overlay
// z-40, content z-50, at most 92vw by 90vh with its own scroll.
//
// Focus starts on Cancel, Enter never sends (the Send button is a plain
// type="button" with no form around it), and the dialog can't be closed
// (Escape, an outside click, Cancel) while the send is in flight. The ticks
// reset whenever a new review opens. Send renders only in a top-level window
// (the frame guard, L16).

export function ConfirmSendDialog({
  open,
  review,
  busy,
  tz,
  nowIso,
  onCancel,
  onSend,
  clientName = null,
  flags = []
}: {
  open: boolean;
  review: ReviewResult;
  busy: boolean;
  tz: string;
  nowIso: string;
  onCancel: () => void;
  onSend: (acks: ReviewBlocker[]) => void;
  /** DD data for the blockers' <client> / <kinds> (additive). */
  clientName?: string | null;
  flags?: readonly GenerationFlag[];
}) {
  const isTop = useIsTopWindow();
  const [acks, setAcks] = useState<ReviewBlocker[]>([]);
  const cancelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // A new review is a new confirmation: nothing stays ticked from the last one.
    setAcks([]);
  }, [review.reviewHash, open]);

  const toggle = (b: ReviewBlocker) => setAcks((cur) => (cur.includes(b) ? cur.filter((x) => x !== b) : [...cur, b]));

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-[2px]" />
        <Dialog.Content
          onOpenAutoFocus={(e) => {
            // Cancel, not Send, holds focus first.
            e.preventDefault();
            cancelRef.current?.querySelector<HTMLButtonElement>('[data-confirm="cancel"]')?.focus();
          }}
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (busy) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (busy) e.preventDefault();
          }}
          onKeyDown={(e) => {
            // No Enter-to-send: Enter on anything but a checkbox does nothing here.
            if (e.key === "Enter" && !(e.target instanceof HTMLInputElement && e.target.type === "checkbox")) e.preventDefault();
          }}
          className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(720px,92vw)] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_24px_72px_-24px_rgba(15,23,42,0.45)] outline-none"
        >
          <Dialog.Title className="text-[15px] font-bold text-ink">Send this email?</Dialog.Title>
          <Dialog.Description className="mt-0.5 text-[12px] text-muted">
            This is the draft exactly as it is in your Outlook Drafts. Check it before you send.
          </Dialog.Description>
          <div ref={cancelRef} className="mt-4">
            <ConfirmSendContent
              review={review}
              acks={acks}
              onToggleAck={toggle}
              isTop={isTop}
              busy={busy}
              nowIso={nowIso}
              tz={tz}
              onCancel={() => {
                if (!busy) onCancel();
              }}
              onSend={() => onSend(acks)}
              clientName={clientName}
              flags={flags}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
