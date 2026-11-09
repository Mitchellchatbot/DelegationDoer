"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { SETTINGS_COPY, resetVoice, voiceResetDoneText } from "@/lib/exec/ui/settings-api";
import { useIsTopWindow } from "../drafts/frame-guard";

// "Reset voice profile" (P5a contract §3.13.2, C20, K12): deletes the
// learned writing style after a confirm; P4's weekly job builds a new one.
// Top-level only (P4's useIsTopWindow: a framed page renders nothing here,
// S2). Hidden until P4's table exists; disabled while there is no profile.
// After a reset the page re-reads on the server, so the voice card shows it.

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
            type="button"
            onClick={() => {
              setMessage(null);
              setConfirming(true);
            }}
            disabled={!profile || pending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            Reset voice profile
          </button>
          {!profile && !message && <span className="text-[12px] text-muted">{SETTINGS_COPY.voiceNoProfile}</span>}
        </div>
      )}
      {confirming && (
        <div role="group" aria-label="Reset voice profile" data-voice-confirm className="space-y-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3">
          <p className="text-[12.5px] leading-relaxed text-rose-950">{SETTINGS_COPY.voiceConfirm}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void reset()}
              disabled={pending}
              className="rounded-lg bg-rose-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? "Resetting…" : "Reset"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-slate-700 hover:border-slate-300 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <p aria-live="polite" role="status" className={message?.tone === "error" ? "text-[12px] text-rose-700" : "text-[12px] text-emerald-700"}>
        {message?.text ?? ""}
      </p>
    </div>
  );
}
