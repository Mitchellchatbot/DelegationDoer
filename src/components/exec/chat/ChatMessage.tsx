import { Lightbulb, Loader2, RotateCcw } from "lucide-react";
import type { ChatContextKind } from "@/lib/exec/agent/types";
import {
  FAILED_TEXT,
  RECOMMENDATION_LABEL,
  RECOMMENDATION_SUB,
  REDACTED_TEXT,
  REFUSED_TEXT,
  SOURCES_LABEL,
  STILL_WORKING_SR,
  STOPPED_LABEL,
  TRY_AGAIN_BUTTON,
  UNCHECKED_TEXT,
  stillWorkingText
} from "@/lib/exec/chat/copy";
import { markersForDisplay } from "@/lib/exec/chat/markers";
import type { ChatMessageView, DisplaySource, ProposalView } from "@/lib/exec/chat/view-types";
import type { SourceRef } from "@/lib/exec/types";
import { cn } from "@/lib/utils";
import { SafeMarkdown } from "../SafeMarkdown";
import { SourceLinks } from "../SourceLinks";
import { DraftCard } from "./DraftCard";
import { ProposalCard } from "./ProposalCard";

// One chat message (P5b contract §3.19.5-§3.19.6; B3, C8, C9). Pure.
//
// His question is plain text. An answer is model text, so it only ever goes
// through SafeMarkdown with links="none" (no link, no image, no raw HTML),
// and its "[rN]" markers are shown as "[n]" plain text: n numbers the
// sources in the order they were first cited, and the numbered chips below
// are the only links an answer has (SourceLinks re-checks every url). A
// marker that names no source is dropped. The recommendations sit under
// their own "Recommendation" label. A redacted answer shows the stored
// notice and no chips; its cards stay (their own state says "Removed").

const CONTEXT_KIND_LABEL: Readonly<Record<ChatContextKind, string>> = {
  attention: "About a Needs Attention item",
  project: "About a project",
  client: "About a client",
  thread: "About an email thread"
};

/** The numbered source chips: each label prefixed "[n] ", the url left for SourceLinks to check. */
export function numberedSourceRefs(sources: readonly DisplaySource[]): SourceRef[] {
  return [...sources].sort((a, b) => a.n - b.n).map((s) => ({ ...s.source, label: `[${s.n}] ${s.source.label}` }));
}

/** ref → its display number, for markersForDisplay. */
export function sourceNumbering(sources: readonly DisplaySource[]): Map<string, number> {
  return new Map(sources.map((s) => [s.ref, s.n]));
}

/** The text a redacted answer shows: the stored notice (REDACTED_TEXT or UNCHECKED_TEXT), never anything else. */
export function redactedText(text: string): string {
  return text === UNCHECKED_TEXT ? UNCHECKED_TEXT : REDACTED_TEXT;
}

export function UserBubble({ text, contextKind, muted = false }: { text: string; contextKind?: ChatContextKind | null; muted?: boolean }) {
  return (
    <div data-chat-message="user" className="flex min-w-0 flex-col items-end gap-0.5">
      {contextKind && <span className="px-1 text-[10.5px] font-medium text-muted">{CONTEXT_KIND_LABEL[contextKind]}</span>}
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed [overflow-wrap:anywhere]",
          muted ? "border border-indigo-200 bg-indigo-50 text-indigo-950" : "bg-indigo-600 text-white"
        )}
      >
        {text}
      </div>
    </div>
  );
}

function Sources({ sources }: { sources: readonly DisplaySource[] }) {
  if (sources.length === 0) return null;
  const refs = numberedSourceRefs(sources);
  return (
    <div data-chat-sources className="space-y-1 pt-1">
      <p className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">{SOURCES_LABEL}</p>
      <SourceLinks refs={refs} max={refs.length} />
    </div>
  );
}

function Recommendation({ text, numbering }: { text: string; numbering: ReadonlyMap<string, number> }) {
  return (
    <div data-chat-recommendation className="rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide text-indigo-700">
          <Lightbulb className="h-3 w-3" aria-hidden />
          {RECOMMENDATION_LABEL}
        </span>
        <span className="text-[11px] text-indigo-900/70">{RECOMMENDATION_SUB}</span>
      </div>
      <SafeMarkdown content={markersForDisplay(text, numbering)} links="none" className="mt-1 text-indigo-950" />
    </div>
  );
}

export function ChatMessage({
  message,
  nowIso,
  tz,
  isTop,
  onTryAgain,
  onProposal
}: {
  message: ChatMessageView;
  /** The page's time (ISO): proposal expiry and a stored running answer's age. */
  nowIso: string;
  tz: string | null;
  isTop: boolean;
  /** A finished failed answer: ask the same question again as a NEW question (C50). */
  onTryAgain?: () => void;
  onProposal?: (p: ProposalView) => void;
}) {
  if (message.role === "user") return <UserBubble text={message.text} contextKind={message.contextKind} />;

  const numbering = sourceNumbering(message.sources);
  const cards = message.cards.length > 0 && (
    <div className="space-y-2 pt-1">
      {message.cards.map((card) =>
        card.kind === "task_proposal" ? (
          <ProposalCard key={`p:${card.proposal.id}`} proposal={card.proposal} nowIso={nowIso} tz={tz} isTop={isTop} onProposal={onProposal} />
        ) : (
          <DraftCard key={`d:${card.draftId}`} card={card} />
        )
      )}
    </div>
  );

  let body: JSX.Element;
  if (message.redacted) {
    body = <p className="text-[12.5px] italic text-slate-600">{redactedText(message.text)}</p>;
  } else if (message.status === "refused") {
    body = <p className="text-[13px] text-slate-700">{REFUSED_TEXT}</p>;
  } else if (message.status === "failed") {
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[13px] text-slate-700">{FAILED_TEXT}</p>
        {isTop && onTryAgain && (
          <button
            type="button"
            data-try-again="answer"
            onClick={onTryAgain}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-semibold text-slate-700 hover:border-slate-300 hover:text-ink"
          >
            <RotateCcw className="h-3 w-3" aria-hidden />
            {TRY_AGAIN_BUTTON}
          </button>
        )}
      </div>
    );
  } else if (message.status === "running") {
    const seconds = (Date.parse(nowIso) - Date.parse(message.createdAt)) / 1000;
    body = (
      <p className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" aria-hidden />
        {/* ui-4: the counter ticks every second; a screen reader gets the static line instead. */}
        <span aria-hidden>{stillWorkingText(Number.isFinite(seconds) ? seconds : 0)}</span>
        <span className="sr-only">{STILL_WORKING_SR}</span>
      </p>
    );
  } else {
    // complete, capped (its note is part of the stored text) and aborted.
    const text = markersForDisplay(message.text, numbering);
    body = (
      <div className="space-y-2">
        {text.trim() !== "" && <SafeMarkdown content={text} links="none" />}
        {message.status === "aborted" && (
          <p data-chat-stopped className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {STOPPED_LABEL}
          </p>
        )}
        {message.recommendations.trim() !== "" && <Recommendation text={message.recommendations} numbering={numbering} />}
        <Sources sources={message.sources} />
      </div>
    );
  }

  return (
    <div data-chat-message="assistant" data-chat-status={message.redacted ? "redacted" : message.status} className="min-w-0 space-y-2 rounded-2xl border border-slate-200/70 bg-white px-3.5 py-3">
      {body}
      {cards}
    </div>
  );
}
