"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { confirmFocusStep } from "@/lib/exec/ui/focus";
import { SETTINGS_COPY, resetVoice, voiceResetDoneText } from "@/lib/exec/ui/settings-api";
import { useIsTopWindow } from "../drafts/frame-guard";

// "Reset voice profile" (P5a contract §3.13.2, C20, K12): deletes the
// learned writing style after a confirm; P4's weekly job builds a new one.
// Top-level only (P4's useIsTopWindow: a framed page renders nothing here,
// S2). Hidden until P4's table exists; disabled while there is no profile.
// After a reset the page re-reads on the server, so the voice card shows it.
// P9 F34 (the confirmFocusStep pattern, P8 fixer ui-11): the confirm replaces the focused button, so focus goes to its
// question as it opens; on Cancel, Escape or an answer, back to the Reset button, or (gone, e.g. no profile left) the
// status line, if focus was lost with it. Escape closes the confirm unless a reset is in flight.

/** P9 F34: Escape closes the confirm, unless a reset is in flight; no other key does. */
export function voiceConfirmKeyAction(key: string, pending: boolean): "close" | null {
  return key === "Escape" && !pending ? "close" : null;
}

export function VoiceResetButton({
  installed,
  hasProfile,
  rebuilds = true,
  initialConfirm = false
}: {
  installed: boolean;
  hasProfile: boolean;
  /** Review ui-6: P4's weekly job can rebuild the profile (the switch, drafts and email on). Default true. */
  rebuilds?: boolean;
  /** Opens the confirm on first render (static renders: tests and screenshots). The page never passes it. */
  initialConfirm?: boolean;
}) {
  const isTop = useIsTopWindow();
  const router = useRouter();
  const [confirming, setConfirming] = useState(initialConfirm);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [cleared, setCleared] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const questionRef = useRef<HTMLParagraphElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const wasConfirming = useRef(confirming);
  useEffect(() => {
    const step = confirmFocusStep(wasConfirming.current, confirming);
    wasConfirming.current = confirming;
    if (step === "open") questionRef.current?.focus();
    else if (step === "close") {
      // The trigger, unless it is disabled now (the profile is gone): then the status line, which says what happened.
      if (triggerRef.current && !triggerRef.current.disabled) triggerRef.current.focus();
      else statusRef.current?.focus();
    }
  }, [confirming]);

  if (!isTop || !installed) return null;
  const profile = hasProfile && !cleared;

  async function reset() {
    if (pending) return;
    setPending(true);
    const result = await resetVoice();
    setPending(false);
    setConfirming(false);
    if (result.kind === "reset") {
      setCleared(true);
      setMessage({ tone: "ok", text: voiceResetDoneText(rebuilds) });
      router.refresh();
    } else {
      setMessage({ tone: "error", text: result.message });
    }
  }

  return (
    <div data-voice-reset className="space-y-2">
      {!confirming && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            ref={triggerRef}
            type="button"
            data-voice-reset-trigger
            onClick={() => {
              setMessage(null);
              setConfirming(true);
            }}
            disabled={!profile || pending}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            Reset voice profile
          </button>
          {!profile && !message && <span className="text-[12px] text-muted">{SETTINGS_COPY.voiceNoProfile}</span>}
        </div>
      )}
      {confirming && (
        <div
          role="group"
          aria-label="Reset voice profile"
          data-voice-confirm
          onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
            if (voiceConfirmKeyAction(e.key, pending) === "close") {
              e.preventDefault();
              setConfirming(false);
            }
          }}
          className="space-y-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3"
        >
          <p ref={questionRef} tabIndex={-1} data-voice-question className="text-[12.5px] leading-relaxed text-rose-950 outline-none">
            {SETTINGS_COPY.voiceConfirm}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-voice-confirm-reset
              onClick={() => void reset()}
              disabled={pending}
              className="inline-flex min-h-10 items-center rounded-lg bg-rose-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
            >
              {pending ? "Resetting…" : "Reset"}
            </button>
            <button
              type="button"
              data-voice-confirm-cancel
              onClick={() => setConfirming(false)}
              disabled={pending}
              className="inline-flex min-h-10 items-center rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-slate-700 hover:border-slate-300 disabled:opacity-50 sm:min-h-0"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <p ref={statusRef} tabIndex={-1} aria-live="polite" role="status" data-voice-status className={message?.tone === "error" ? "text-[12px] text-rose-700 outline-none" : "text-[12px] text-emerald-700 outline-none"}>
        {message?.text ?? ""}
      </p>
    </div>
  );
}
