import { Loader2, MessageSquareText, RotateCcw, TriangleAlert, X } from "lucide-react";
import { neutralizeLinks } from "@/lib/exec/chat/answer";
import {
  ANSWER_FAILED_SR,
  ANSWER_READY_SR,
  ANSWER_STOPPED_SR,
  CHAT_EMPTY_HEADING,
  CHAT_EMPTY_SUB,
  CHAT_EMPTY_SUB_NO_EMAIL,
  CONNECTING_TEXT,
  QUIET_AFTER_MS,
  REFUSED_TEXT,
  STILL_WORKING_SR,
  TRY_AGAIN_BUTTON,
  contextChipText,
  stillWorkingText
} from "@/lib/exec/chat/copy";
import { bannerText, liveText, type ChatBanner, type ChatViewState, type LiveTurn } from "@/lib/exec/chat/reducer";
import type { ChatMessageView, ProposalView } from "@/lib/exec/chat/view-types";
import { cn } from "@/lib/utils";
import { SafeMarkdown } from "../SafeMarkdown";
import { ChatMessage, UserBubble } from "./ChatMessage";
import { ToolProgressList } from "./ToolProgressList";

// The conversation as the view shows it (P5b contract §3.19.1, §3.19.5),
// drawn from a ChatViewState and nothing else, so a fixture renders it
// exactly (tests, screenshots). Pure: every handler comes from ExecChat.
//
// While a turn streams: his question, then each round's working notes (a
// round's text, muted, once that round called tools) with its tool lines,
// then the answer so far. Streamed text has its markers hidden and its link
// syntax neutralized before SafeMarkdown links="none" draws it (§3.13.4); the
// finished answer replaces all of it at done. "Still working… {s}s" appears
// after 10 s without an event (a buffering proxy holds the stream).
//
// Screen readers (ui-4): the streaming answer is aria-busy, not a live region
// (it re-renders every frame and the counter every second, both aria-hidden
// to them); one polite status line says once how the turn settled.

export const CHAT_VIEW_COPY = {
  clearContext: "Clear",
  notesLabel: "Working notes"
} as const;

/** The question each failed answer would ask again (the user message before it). */
function questionBefore(messages: readonly ChatMessageView[], index: number): string | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") return messages[i].text;
  }
  return null;
}

/** ui-4: the one line a screen reader hears when a turn settles ("" while one runs, or before any). */
export function settledAnnouncement(state: Pick<ChatViewState, "messages" | "live">): string {
  if (state.live !== null) return "";
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== "assistant") return "";
  if (last.redacted) return ANSWER_READY_SR;
  switch (last.status) {
    case "complete":
    case "capped":
      return ANSWER_READY_SR;
    case "aborted":
      return ANSWER_STOPPED_SR;
    case "failed":
      return ANSWER_FAILED_SR;
    case "refused":
      return REFUSED_TEXT;
    default:
      return "";
  }
}

function EmptyChat({ starters, isTop, emailOn, onStarter }: { starters: readonly string[]; isTop: boolean; emailOn: boolean; onStarter?: (text: string) => void }) {
  return (
    <div data-chat-empty className="space-y-3">
      <div className="rounded-2xl border border-slate-200/70 bg-gradient-to-br from-indigo-50/70 via-white to-white px-4 py-3.5">
        <p className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-ink">
          <MessageSquareText className="h-4 w-4 text-indigo-500" aria-hidden />
          {CHAT_EMPTY_HEADING}
        </p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-slate-600">{emailOn ? CHAT_EMPTY_SUB : CHAT_EMPTY_SUB_NO_EMAIL}</p>
      </div>
      {isTop && onStarter && starters.length > 0 && (
        <div data-chat-starters className="flex flex-wrap gap-1.5">
          {starters.map((s) => (
            <button
              key={s}
              type="button"
              data-starter
              onClick={() => onStarter(s)}
              className="max-w-full rounded-full border border-slate-200 bg-white px-3 py-1.5 text-left text-[12.5px] font-medium text-slate-700 [overflow-wrap:anywhere] hover:border-indigo-300 hover:text-indigo-800"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LiveTurnView({ live, nowMs }: { live: LiveTurn; nowMs: number }) {
  const { notes, current } = liveText(live);
  const rounds = [...new Set([...notes.map((n) => n.round), ...live.tools.map((t) => t.round)])].sort((a, b) => a - b);
  const quiet = nowMs - live.lastEventAtMs >= QUIET_AFTER_MS;
  const shown = neutralizeLinks(current);
  return (
    <div data-chat-live={live.phase} className="space-y-2">
      <UserBubble text={live.question} />
      <div data-chat-message="assistant" data-chat-status="running" aria-busy="true" className="min-w-0 space-y-2 rounded-2xl border border-slate-200/70 bg-white px-3.5 py-3">
        {rounds.map((r) => {
          const note = notes.find((n) => n.round === r);
          const tools = live.tools.filter((t) => t.round === r);
          return (
            <div key={r} data-chat-round={r} className="space-y-1">
              {note && (
                <div data-chat-notes className="border-l-2 border-slate-200 pl-2.5">
                  <span className="sr-only">{CHAT_VIEW_COPY.notesLabel}: </span>
                  <SafeMarkdown content={neutralizeLinks(note.text)} links="none" className="text-[12px] text-slate-500" />
                </div>
              )}
              <ToolProgressList tools={tools} />
            </div>
          );
        })}
        {shown.trim() !== "" && <SafeMarkdown content={shown} links="none" />}
        {live.phase === "connecting" && (
          <p data-chat-connecting className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" aria-hidden />
            {CONNECTING_TEXT}
          </p>
        )}
        {quiet && (
          <p data-chat-quiet className="inline-flex items-center gap-1.5 text-[12px] text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" aria-hidden />
            <span aria-hidden>{stillWorkingText((nowMs - live.startedAtMs) / 1000)}</span>
            <span className="sr-only">{STILL_WORKING_SR}</span>
          </p>
        )}
      </div>
    </div>
  );
}

function Banner({ banner, isTop, onRetry, canRetry }: { banner: ChatBanner; isTop: boolean; onRetry?: () => void; canRetry: boolean }) {
  const tone = banner.kind === "not_saved" || banner.kind === "lost" ? "amber" : banner.kind === "send_failed" || banner.kind === "unavailable" ? "rose" : "amber";
  return (
    <div
      role={banner.kind === "lost" ? "status" : "alert"}
      data-chat-banner={banner.kind}
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-[12.5px]",
        tone === "rose" ? "border-rose-200 bg-rose-50 text-rose-900" : "border-amber-200 bg-amber-50 text-amber-900"
      )}
    >
      {banner.kind === "lost" ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden /> : <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />}
      <span className="min-w-0 flex-1">{bannerText(banner)}</span>
      {banner.kind === "send_failed" && isTop && canRetry && onRetry && (
        <button
          type="button"
          data-try-again="send"
          onClick={onRetry}
          className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-white px-2.5 py-1 text-[12px] font-semibold text-rose-800 hover:border-rose-300"
        >
          <RotateCcw className="h-3 w-3" aria-hidden />
          {TRY_AGAIN_BUTTON}
        </button>
      )}
    </div>
  );
}

export function ContextChip({ label, isTop, onClear }: { label: string; isTop: boolean; onClear?: () => void }) {
  return (
    <div data-context-chip className="inline-flex max-w-full items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 py-0.5 pl-2.5 pr-1 text-[12px] font-medium text-indigo-900">
      <span className="min-w-0 truncate">{contextChipText(label)}</span>
      {isTop && onClear && (
        <button type="button" data-context-clear aria-label={CHAT_VIEW_COPY.clearContext} title={CHAT_VIEW_COPY.clearContext} onClick={onClear} className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-indigo-700 hover:bg-indigo-100">
          <X className="h-3 w-3" aria-hidden />
        </button>
      )}
    </div>
  );
}

export interface ChatTranscriptViewProps {
  state: ChatViewState;
  starters: readonly string[];
  /** The principal's zone; null in the drawer (no times). */
  tz: string | null;
  /** The page's time (ISO): proposal expiry, a stored running answer's age. */
  nowIso: string;
  /** The live clock (ms), for "Still working…". */
  nowMs: number;
  /** P4's frame guard: false hides every action (starters, Try again, Confirm/Dismiss, the chip's ×). */
  isTop: boolean;
  /** ui-10: false when no tool can read his mailbox; the empty state then doesn't claim it. Omitted: true. */
  emailOn?: boolean;
  onStarter?: (text: string) => void;
  /** send_failed's Try again: the SAME client turn id (C50). */
  onRetry?: () => void;
  /** A finished failed answer's Try again: the same text as a NEW question. */
  onTryAgain?: (question: string) => void;
  onClearContext?: () => void;
  onProposal?: (p: ProposalView) => void;
  className?: string;
}

export function ChatTranscriptView({ state, starters, tz, nowIso, nowMs, isTop, emailOn = true, onStarter, onRetry, onTryAgain, onClearContext, onProposal, className }: ChatTranscriptViewProps) {
  const { messages, live, pending, banner, context } = state;
  const empty = messages.length === 0 && live === null && pending === null;
  return (
    <div data-chat-transcript className={cn("min-w-0 space-y-3", className)}>
      <p role="status" data-chat-announce className="sr-only">
        {settledAnnouncement(state)}
      </p>
      {empty && <EmptyChat starters={starters} isTop={isTop} emailOn={emailOn} onStarter={onStarter} />}
      {messages.map((m, i) => {
        const question = m.role === "assistant" && m.status === "failed" && !m.redacted ? questionBefore(messages, i) : null;
        return (
          <ChatMessage
            key={m.id}
            message={m}
            nowIso={nowIso}
            tz={tz}
            isTop={isTop}
            onProposal={onProposal}
            onTryAgain={question !== null && onTryAgain && live === null ? () => onTryAgain(question) : undefined}
          />
        );
      })}
      {live === null && pending !== null && <UserBubble text={pending.question} contextKind={pending.context?.kind ?? null} muted />}
      {live !== null && <LiveTurnView live={live} nowMs={nowMs} />}
      {banner !== null && <Banner banner={banner} isTop={isTop} onRetry={onRetry} canRetry={pending !== null && live === null} />}
      {context !== null && <ContextChip label={context.label} isTop={isTop} onClear={onClearContext} />}
    </div>
  );
}
