"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, MessageSquareReply } from "lucide-react";
import type { CardView } from "@/lib/exec/chat/view-types";
import { SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import { slackReplyPageHref } from "@/lib/exec/slack-reply-links";
import { cn } from "@/lib/utils";
import { useIsTopWindow } from "../drafts/frame-guard";
import { ReplyCopyButton } from "../slack/replies/ReplyCopyButton";
import { ReplySendDialog } from "../slack/replies/ReplySendDialog";
import { replyPollIntervalFor, replyStatusBanner, type ReplyBanner, type ReplyPageDraft } from "../slack/replies/reply-logic";

// The chat card for a Slack reply draft (P10 contract §3.5.13, §3.6.1, C50, C51; v1.1 product-20; Area D). Client: it reads
// the draft from DD (GET /api/exec/slack/replies/:id; the chat row never holds the text, CT08), polls every 2 s while it is
// drafting (≤ 3 minutes), and shows the text, Copy, Send as you… (the same dialog, with its review call) and Edit in DD. The
// link is built here from the draft id (slackReplyPageHref), never taken from the payload or from model text. The same live
// regions as the editor: role="status" for drafting / sending / sent, role="alert" for back to draft, unknown and refusals.

const COPY = SLACK_P10_COPY.replies;
const TONE: Readonly<Record<ReplyBanner["tone"], string>> = {
  progress: "text-indigo-900",
  ok: "text-emerald-900",
  warn: "text-amber-900",
  danger: "text-rose-800",
  muted: "text-slate-700"
};

export function SlackReplyCard({ card, tz }: { card: Extract<CardView, { kind: "slack_reply" }>; tz: string }) {
  const isTop = useIsTopWindow();
  const href = slackReplyPageHref(card.draftId);
  const [draft, setDraft] = useState<ReplyPageDraft | null>(null);
  const [failed, setFailed] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const started = useRef<{ status: string; at: number }>({ status: "", at: Date.now() });
  // P10 fixer ui-6: the dialog gives focus back to Send, or to the live regions once the draft left `draft`.
  const sendRef = useRef<HTMLButtonElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/exec/slack/replies/${encodeURIComponent(card.draftId)}`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.status === 200 && body.state === "ok" && body.draft) {
        setDraft(body.draft as ReplyPageDraft);
        setFailed(false);
      } else setFailed(true);
    } catch {
      setFailed(true);
    }
  }, [card.draftId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (draft === null) return;
    if (started.current.status !== draft.status) started.current = { status: draft.status, at: Date.now() };
    const wait = replyPollIntervalFor(draft.status, Date.now() - started.current.at);
    if (wait === null) return;
    const t = setTimeout(() => void load(), wait);
    return () => clearTimeout(t);
  }, [draft, load]);

  const nowIso = new Date().toISOString();
  const banner = draft !== null ? replyStatusBanner(draft, tz, nowIso) : null;
  return (
    <div data-slack-reply-card={card.draftId} className="min-w-0 space-y-1.5 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2.5">
      <p className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
        <MessageSquareReply className="h-3.5 w-3.5 shrink-0 text-indigo-500" aria-hidden />
        {COPY.cardTitle}
      </p>
      {draft !== null && <p data-slack-reply-destination className="text-[12px] text-slate-600">{draft.destination}</p>}
      <div ref={liveRef} tabIndex={-1} data-slack-reply-live className="space-y-1.5 outline-none">
        <p role="status" aria-live="polite" data-slack-reply-status className={cn("text-[12px]", banner !== null && banner.role === "status" ? TONE[banner.tone] : "sr-only")}>
          {draft === null && !failed ? <Loader2 className="mr-1 inline h-3 w-3 motion-safe:animate-spin" aria-hidden /> : null}
          {banner !== null && banner.role === "status" ? banner.text : draft === null && !failed ? COPY.generating : ""}
        </p>
        <p role="alert" data-slack-reply-alert className={cn("text-[12px]", (banner !== null && banner.role === "alert") || failed ? TONE[failed ? "danger" : banner!.tone] : "sr-only")}>
          {failed ? COPY.notFound : banner !== null && banner.role === "alert" ? banner.text : ""}
        </p>
      </div>
      {draft !== null && draft.text !== null && (draft.status === "draft" || draft.status === "sending" || draft.status === "sent" || draft.status === "unknown") && (
        <p data-slack-reply-text className="whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[12.5px] leading-relaxed text-ink">
          {draft.text}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {draft !== null && draft.status === "draft" && draft.text !== null && <ReplyCopyButton text={draft.text} />}
        {isTop && draft !== null && draft.status === "draft" && draft.canSend && (
          <button
            ref={sendRef}
            type="button"
            data-slack-reply-send
            onClick={() => setSendOpen(true)}
            className="inline-flex min-h-10 items-center rounded-lg bg-indigo-600 px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-indigo-700 sm:min-h-0"
          >
            {COPY.send}
          </button>
        )}
        <Link href={href} prefetch={false} data-slack-reply-open className="inline-flex text-[12px] font-semibold text-indigo-700 hover:text-indigo-900">
          {COPY.cardEditInDd}
        </Link>
      </div>
      {draft !== null && draft.status === "draft" && draft.text !== null && (
        <ReplySendDialog
          open={sendOpen}
          draftId={draft.id}
          version={draft.version}
          text={draft.text}
          place={draft.place}
          inThread={draft.inThread}
          placeholders={draft.placeholders}
          tz={tz}
          onClose={() => setSendOpen(false)}
          onAnswer={() => void load()}
          returnFocusRef={sendRef}
          fallbackFocusRef={liveRef}
        />
      )}
    </div>
  );
}
