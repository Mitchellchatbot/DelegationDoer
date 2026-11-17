import { Loader2, TriangleAlert } from "lucide-react";
import { fillP10, SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import type { ReplyBlocker } from "@/lib/exec/slack-p10-types";
import { cn } from "@/lib/utils";
import { ackText, dialogState, REPLY_UI_COPY, type ReplyBanner } from "./reply-logic";

// The send dialog's body (P10 contract §3.5.13, C34, C48, C59; v1.1 product-6, -20; Area D). Props only, server-renderable:
// the exact stored text read-only (what posts, character for character), where it goes, one checkbox per blocker the review
// named (every one before the first Send), the "something changed" line after a needs_ack, and Send. Placeholders are a hard
// stop: their line and no Send. Every string is React text (no HTML from content), and the draft text never sits in an
// attribute.

const COPY = SLACK_P10_COPY.replies;
const TONE: Readonly<Record<ReplyBanner["tone"], string>> = {
  progress: "border-indigo-200 bg-indigo-50 text-indigo-900",
  ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warn: "border-amber-200 bg-amber-50 text-amber-900",
  danger: "border-rose-200 bg-rose-50 text-rose-800",
  muted: "border-slate-200 bg-white text-slate-700"
};

export type ReplySendPhase = "loading" | "ready" | "sending" | "done" | "error";

export function ReplySendContent({
  text,
  place,
  inThread,
  phase,
  blockers,
  changed,
  acks,
  placeholders,
  banner,
  isTop,
  onToggleAck,
  onSend,
  onCancel
}: {
  /** The stored text, exactly as it will post. */
  text: string;
  place: string;
  inThread: boolean;
  phase: ReplySendPhase;
  /** Every blocker the review (and any later needs_ack) named. */
  blockers: readonly ReplyBlocker[];
  /** The blockers a needs_ack answer added since the review (v1.1 product-6). */
  changed: readonly ReplyBlocker[];
  acks: readonly ReplyBlocker[];
  /** The placeholders the text holds (the hard stop's list). */
  placeholders: readonly string[];
  banner: ReplyBanner | null;
  isTop: boolean;
  onToggleAck: (b: ReplyBlocker) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  const state = dialogState(blockers, acks);
  const busy = phase === "sending";
  const body = fillP10(COPY.sendBody, { place, thread: inThread ? COPY.thread : "" });
  return (
    <div data-reply-send={phase} className="space-y-3">
      <p className="text-[12.5px] text-slate-700">{body}</p>
      <pre data-reply-send-text className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 font-sans text-[13px] leading-relaxed text-ink">
        {text}
      </pre>
      {phase === "loading" && (
        <p role="status" data-reply-send-loading className="inline-flex items-center gap-2 text-[12.5px] text-slate-600">
          <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
          {REPLY_UI_COPY.checking}
        </p>
      )}
      {phase !== "loading" && state.hardStop && (
        <p role="alert" data-reply-send-placeholders className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2 text-[12.5px] text-rose-800">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{fillP10(COPY.placeholders, { list: placeholders.length > 0 ? placeholders.join(", ") : "[…]" })}</span>
        </p>
      )}
      {phase !== "loading" && changed.length > 0 && (
        <p role="alert" data-reply-send-changed className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-[12.5px] text-amber-900">
          {fillP10(COPY.changedSinceReview, { list: changed.map((b) => COPY.cardDdReasons[b]).join(", ") })}
        </p>
      )}
      {phase !== "loading" && !state.hardStop && state.ackable.length > 0 && (
        <fieldset data-reply-send-acks className="space-y-1.5 rounded-xl border border-amber-200 bg-amber-50/60 px-3.5 py-3">
          <legend className="px-1 text-[12px] font-semibold text-amber-900">{COPY.sendAcksTitle}</legend>
          {state.ackable.map((b) => (
            <label key={b} data-reply-ack={b} className="flex min-h-10 items-start gap-2 text-[12.5px] text-slate-800 sm:min-h-0">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300"
                checked={acks.includes(b)}
                disabled={busy || !isTop}
                onChange={() => onToggleAck(b)}
              />
              <span>{ackText(b)}</span>
            </label>
          ))}
        </fieldset>
      )}
      {banner !== null && (
        <p role={banner.role} data-reply-send-banner className={cn("rounded-xl border px-3.5 py-2 text-[12.5px]", TONE[banner.tone])}>
          {banner.text}
        </p>
      )}
      {isTop ? (
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button
            type="button"
            data-reply-send-cancel
            disabled={busy}
            onClick={onCancel}
            className="min-h-10 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-slate-50 disabled:opacity-60 sm:min-h-0"
          >
            {COPY.cancel}
          </button>
          {phase !== "done" && !state.hardStop && (
            <button
              type="button"
              data-reply-send-confirm
              disabled={busy || phase !== "ready" || !state.ready}
              onClick={onSend}
              className="min-h-10 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-[12.5px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 sm:min-h-0"
            >
              {busy ? COPY.sending : COPY.sendConfirm}
            </button>
          )}
        </div>
      ) : (
        <p className="text-[12px] text-slate-600">{COPY.framed}</p>
      )}
    </div>
  );
}
