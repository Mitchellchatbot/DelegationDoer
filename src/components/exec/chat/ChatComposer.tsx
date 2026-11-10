"use client";

import { forwardRef, type KeyboardEvent } from "react";
import { ArrowUp, Square } from "lucide-react";
import { CHAT_TEXT_MAX, COMPOSER_COUNTER_FROM, COMPOSER_PLACEHOLDER, FRAMED_TEXT, SEND_BUTTON, STOP_BUTTON, composerCounterText } from "@/lib/exec/chat/copy";
import { cn } from "@/lib/utils";

// The question box (P5b contract §3.19.5): a textarea, the "{n}/4,000"
// counter past 3,500 characters, Send (disabled when empty or over 4,000)
// and, while an answer is being written, Stop in its place. Enter sends,
// Shift+Enter starts a new line. Framed (P4's frame guard false), there is no
// box at all, only "Open DD directly to act on this."

/** The question as the route will see it: CRLF as LF, trimmed (§3.16.1). */
export function normalizeQuestion(text: string): string {
  return String(text ?? "").replace(/\r\n?/g, "\n").trim();
}

/** Whether Send is enabled for this text. */
export function canSendQuestion(text: string): boolean {
  const n = normalizeQuestion(text).length;
  return n > 0 && n <= CHAT_TEXT_MAX;
}

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** An answer is being written: Stop replaces Send. */
  live: boolean;
  isTop: boolean;
  className?: string;
}

export const ChatComposer = forwardRef<HTMLTextAreaElement, ChatComposerProps>(function ChatComposer({ value, onChange, onSend, onStop, live, isTop, className }, ref) {
  if (!isTop) {
    return (
      <p data-framed-note className={cn("rounded-lg bg-slate-50 px-3 py-2 text-[12px] text-muted", className)}>
        {FRAMED_TEXT}
      </p>
    );
  }
  const length = normalizeQuestion(value).length;
  const over = length > CHAT_TEXT_MAX;
  const sendable = canSendQuestion(value) && !live;
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (sendable) onSend();
  };
  return (
    <div data-chat-composer className={cn("min-w-0", className)}>
      <div className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-soft focus-within:border-indigo-300 focus-within:ring-2 focus-within:ring-indigo-100">
        <textarea
          ref={ref}
          rows={2}
          value={value}
          placeholder={COMPOSER_PLACEHOLDER}
          aria-label={COMPOSER_PLACEHOLDER}
          aria-invalid={over || undefined}
          onChange={(e) => onChange(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          className="max-h-48 min-h-[44px] min-w-0 flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-ink placeholder:text-slate-400 focus:outline-none"
        />
        {live ? (
          <button
            type="button"
            data-chat-stop
            onClick={onStop}
            className="inline-flex min-h-10 shrink-0 items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-slate-700 hover:border-slate-300 hover:text-ink sm:min-h-0"
          >
            <Square className="h-3 w-3 fill-current" aria-hidden />
            {STOP_BUTTON}
          </button>
        ) : (
          <button
            type="button"
            data-chat-send
            disabled={!sendable}
            onClick={onSend}
            className="inline-flex min-h-10 shrink-0 items-center gap-1 rounded-xl bg-indigo-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
          >
            <ArrowUp className="h-3.5 w-3.5" aria-hidden />
            {SEND_BUTTON}
          </button>
        )}
      </div>
      {length > COMPOSER_COUNTER_FROM && (
        <p data-chat-counter className={cn("mt-1 text-right text-[11px] tabular-nums", over ? "font-semibold text-rose-700" : "text-muted")}>
          {composerCounterText(length)}
        </p>
      )}
    </div>
  );
});
