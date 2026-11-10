"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { BRIEF_COPY } from "@/lib/exec/brief-copy";
import { confirmFocusStep, focusLost } from "@/lib/exec/ui/focus";
import { regenerateBrief, regenerateMessageFor, type RegenerateResult } from "@/lib/exec/ui/settings-api";
import { useIsTopWindow } from "../drafts/frame-guard";

// Regenerate (P8 contract §3.17.3, M3, C29, C47, C48): builds a new version of today's brief. Page-only: it never sends a
// second DM. A confirm first (regenerateConfirm), then POST { expectedRev } (the rev the page showed). 202 → the queued
// line, and the page re-reads on the server every 10 s for up to 5 minutes, until a new rev comes back (or the same rev
// is offered again after the server showed the build running: it didn't finish, regenerateFailed); 409 busy /
// conflict and 429 → their lines; anything else → regenerateFailed. Top-level only (P4's useIsTopWindow: a framed page
// renders nothing here). The page keeps this mounted while today's row exists, so the polling outlives the server
// re-render that hides the button (the row's regenerate lock makes canRegenerate false while the build runs).

export const REGENERATE_POLL_MS = 10_000;
export const REGENERATE_POLL_MAX_MS = 5 * 60_000;

/**
 * Calls refresh() every intervalMs until maxMs has passed; returns the stop function. Pure apart from the timer
 * functions it is given (tests pass fake ones). P9 F32: when it stops because maxMs passed (never on a stop() call),
 * opts.onGiveUp runs once, so the button can stop waiting instead of saying "Regenerating" forever.
 */
export function startRegeneratePolling(
  refresh: () => void,
  timers: { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (id: unknown) => void; now: () => number } = {
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof globalThis.setInterval>),
    now: () => Date.now()
  },
  opts: { intervalMs?: number; maxMs?: number; onGiveUp?: () => void } = {}
): () => void {
  const started = timers.now();
  const max = opts.maxMs ?? REGENERATE_POLL_MAX_MS;
  let stopped = false;
  const id = timers.setInterval(() => {
    if (stopped) return;
    if (timers.now() - started >= max) {
      stop();
      opts.onGiveUp?.();
      return;
    }
    refresh();
  }, opts.intervalMs ?? REGENERATE_POLL_MS);
  function stop(): void {
    if (stopped) return;
    stopped = true;
    timers.clearInterval(id);
  }
  return stop;
}

/**
 * While a queued regenerate is awaited (waitingFor = the rev it was queued at), what the latest server render says: a
 * newer rev → "done"; the button withheld (the claim's lock, or the build running) → "busy"; the same rev offered again
 * after a busy render → "failed" (the build ended without a new rev); anything else → "wait". Pure.
 */
export function regenerateWaitStep(
  waitingFor: number,
  sawBusy: boolean,
  props: { expectedRev: number | null; canRegenerate: boolean }
): "done" | "busy" | "failed" | "wait" {
  if (props.expectedRev !== null && props.expectedRev > waitingFor) return "done";
  if (!props.canRegenerate) return "busy";
  if (sawBusy && props.expectedRev === waitingFor) return "failed";
  return "wait";
}

type Message = { tone: "ok" | "warn" | "error"; text: string };

function messageOf(r: RegenerateResult): Message {
  return { tone: r.kind === "queued" ? "ok" : r.kind === "failed" ? "error" : "warn", text: regenerateMessageFor(r) };
}

export function RegenerateButton({
  expectedRev,
  canRegenerate,
  initialConfirm = false,
  initialResult = null
}: {
  /** The rev of today's brief the page shows; null when there is no row. */
  expectedRev: number | null;
  canRegenerate: boolean;
  /** Static renders only (tests and screenshots): the confirm open, or an answer already shown. The page never passes them. */
  initialConfirm?: boolean;
  initialResult?: RegenerateResult | null;
}) {
  const isTop = useIsTopWindow();
  const router = useRouter();
  const [confirming, setConfirming] = useState(initialConfirm);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<Message | null>(initialResult ? messageOf(initialResult) : null);
  const [waitingFor, setWaitingFor] = useState<number | null>(initialResult?.kind === "queued" ? initialResult.rev : null);
  const stopRef = useRef<(() => void) | null>(null);
  // P8 fixer ui-11: the confirm replaces the focused button (and the answer replaces the confirm). Focus goes to the question as
  // it opens; on Cancel or an answer, back to the Regenerate button, or (gone while the build is queued) the status line.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const questionRef = useRef<HTMLParagraphElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const wasConfirming = useRef(confirming);
  useEffect(() => {
    const step = confirmFocusStep(wasConfirming.current, confirming);
    wasConfirming.current = confirming;
    if (step === "open") questionRef.current?.focus();
    else if (step === "close") {
      if (triggerRef.current) triggerRef.current.focus();
      else if (typeof document !== "undefined" && focusLost(document.activeElement, document.body)) statusRef.current?.focus();
    }
  }, [confirming]);

  // A new rev rendered by the server means the regenerate finished: stop polling and clear the queued line. The same rev
  // offered again after the server showed it busy (its lock gone, no new rev) means the build didn't finish: stop and say so.
  const sawBusyRef = useRef(false);
  useEffect(() => {
    if (waitingFor === null) return;
    const finish = (next: Message | null) => {
      stopRef.current?.();
      stopRef.current = null;
      sawBusyRef.current = false;
      setWaitingFor(null);
      setMessage(next);
    };
    const step = regenerateWaitStep(waitingFor, sawBusyRef.current, { expectedRev, canRegenerate });
    if (step === "done") finish(null);
    else if (step === "busy") sawBusyRef.current = true;
    else if (step === "failed") finish({ tone: "error", text: BRIEF_COPY.regenerateFailed });
  }, [expectedRev, canRegenerate, waitingFor]);

  useEffect(() => () => stopRef.current?.(), []);

  if (!isTop) return null;

  async function regenerate(): Promise<void> {
    if (pending || expectedRev === null) return;
    setPending(true);
    const result = await regenerateBrief(expectedRev);
    setPending(false);
    setConfirming(false);
    setMessage(messageOf(result));
    if (result.kind === "queued") {
      sawBusyRef.current = false;
      setWaitingFor(expectedRev);
      stopRef.current?.();
      // P9 F32: after REGENERATE_POLL_MAX_MS, stop waiting: Regenerate is offered again with regenerateGaveUp's line.
      stopRef.current = startRegeneratePolling(() => router.refresh(), undefined, {
        onGiveUp: () => {
          stopRef.current = null;
          sawBusyRef.current = false;
          setWaitingFor(null);
          setMessage({ tone: "warn", text: BRIEF_COPY.regenerateGaveUp });
        }
      });
    }
  }

  const offer = canRegenerate && expectedRev !== null && waitingFor === null;
  return (
    <div data-regenerate className="flex min-w-0 flex-wrap items-center gap-2">
      {offer && !confirming && (
        <button
          ref={triggerRef}
          type="button"
          data-regenerate-trigger
          onClick={() => {
            setMessage(null);
            setConfirming(true);
          }}
          disabled={pending}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-semibold text-slate-700 shadow-soft hover:border-slate-300 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          {BRIEF_COPY.regenerate}
        </button>
      )}
      {offer && confirming && (
        <div role="group" aria-label={BRIEF_COPY.regenerate} data-regenerate-confirm className="flex max-w-md flex-wrap items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2">
          <p ref={questionRef} tabIndex={-1} data-regenerate-question className="min-w-0 basis-full text-[12px] leading-relaxed text-indigo-950 outline-none">
            {BRIEF_COPY.regenerateConfirm}
          </p>
          <button
            type="button"
            onClick={() => void regenerate()}
            disabled={pending}
            className="inline-flex min-h-10 items-center rounded-lg bg-indigo-600 px-3 py-1 text-[12px] font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
          >
            {BRIEF_COPY.regenerate}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={pending}
            className="inline-flex min-h-10 items-center rounded-lg border border-slate-200 bg-white px-3 py-1 text-[12px] font-semibold text-slate-700 hover:border-slate-300 disabled:opacity-50 sm:min-h-0"
          >
            {BRIEF_COPY.settings.cancel}
          </button>
        </div>
      )}
      <p
        ref={statusRef}
        tabIndex={-1}
        aria-live="polite"
        role="status"
        data-regenerate-message={message?.tone ?? ""}
        className={message === null ? "sr-only" : message.tone === "error" ? "text-[12px] text-rose-700" : message.tone === "warn" ? "text-[12px] text-amber-700" : "text-[12px] text-emerald-700"}
      >
        {message?.text ?? ""}
      </p>
    </div>
  );
}
