"use client";

import Link from "next/link";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { MessageSquarePlus, SquareArrowOutUpRight } from "lucide-react";
import type { ChatContextKind } from "@/lib/exec/agent/types";
import { CHAT_TEXT_MAX, OPEN_IN_CHAT_LINK } from "@/lib/exec/chat/copy";
import { chatReducer, initialChatState, isFinalHttpStatus, type ChatContextChip, type ChatViewState } from "@/lib/exec/chat/reducer";
import type { ChatMessageView, ChatSseEvent, ProposalView } from "@/lib/exec/chat/view-types";
import { focusLost, type Focusable } from "@/lib/exec/ui/focus";
import { cn } from "@/lib/utils";
import { useIsTopWindow } from "../drafts/frame-guard";
import { ChatComposer, normalizeQuestion } from "./ChatComposer";
import { ChatTranscriptView } from "./ChatTranscriptView";
import { newClientTurnId, pollUntilSettled, postChatTurn, type ChatPostBody } from "./transport";

// The chat (P5b contract §3.19.2-§3.19.4, §3.19.8; B5, B9, C33, C34, C50,
// C55): the reducer's state, the POST that streams a turn, Stop, recovery,
// and on the Overview rail the Ask AI link interception. Every view is
// ChatTranscriptView's; this file only wires it.
//
// Streaming: events are queued and handed to the reducer once per animation
// frame (text deltas), or at once with everything queued before them (any
// other event), so a fast stream repaints at most once a frame and order is
// kept. Stop aborts the fetch: the server persists what was streamed as
// "aborted" (it never needs the request's signal for that, C55), and the
// view keeps it at once, then takes the stored row from the GET. A stream
// that ends without done shows "lost" and polls the GET every 3 s for up to
// 2 min; a network error or a 5xx keeps the question pending, so Try again
// re-sends the SAME client turn id (C50) and the server answers with the
// stored turn rather than running it twice.
//
// Nothing is logged here (boundary B3): no question, answer or label ever
// reaches the console.

export interface ExecChatProps {
  variant: "rail" | "page" | "drawer";
  initialConversation: { id: string; title: string } | null;
  initialMessages: ChatMessageView[];
  /** Server-resolved and screened (page), or the client the drawer was opened on. */
  initialContext: { kind: ChatContextKind; id: string; label: string } | null;
  starters: readonly string[];
  /** null in the drawer: no times are shown. */
  tz: string | null;
  nowIso: string | null;
  /** The Overview rail (C33): a plain click on a feed row's Ask AI asks here instead of navigating. */
  interceptAskAiLinks?: boolean;
  /**
   * ui-10: whether any tool can read his mailbox (email installed, on, and a pinned mailbox). When false the empty
   * state doesn't claim the mailbox. Omitted: true (the claim P5b shipped with).
   */
  emailOn?: boolean;
}

/** The newest assistant message's turn when that message is still running (a reload mid-answer, a second tab). */
export function runningTurnOf(messages: readonly ChatMessageView[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    return m.status === "running" ? m.turnId : null;
  }
  return null;
}

/** How long a stored running answer is watched: the server reads one older than 600 s as failed (stale). */
export const RUNNING_WATCH_MAX_MS = 660_000;

/** ui-3: the stored answer to watch (poll quietly until it settles), or null: none running, a turn is live, or no id. */
export function runningWatch(state: Pick<ChatViewState, "live" | "conversationId" | "messages">): { conversationId: string; turnId: string } | null {
  if (state.live !== null || state.conversationId === null) return null;
  const turnId = runningTurnOf(state.messages);
  return turnId === null ? null : { conversationId: state.conversationId, turnId };
}

/**
 * ui-3, C50: a 409 turn_in_progress means the server is still writing a turn of this conversation (this very one on a
 * retry, or one another tab asked): poll it, quietly for a new question. null for any other answer, or with no id.
 */
export function busyRecovery(
  outcome: { kind: string; status?: number; error?: string | null; conversationId?: string | null },
  body: Pick<ChatPostBody, "conversationId">,
  wasRetry: boolean
): { conversationId: string; quiet: boolean } | null {
  if (outcome.kind !== "http_error" || outcome.status !== 409 || outcome.error !== "turn_in_progress") return null;
  const conversationId = outcome.conversationId ?? body.conversationId;
  return conversationId ? { conversationId, quiet: !wasRetry } : null;
}

/** ui-3: "Open in Chat" (rail, drawer) once there is a conversation with answers, and never while one streams. */
export function openInChatShown(variant: ExecChatProps["variant"], state: Pick<ChatViewState, "live" | "conversationId" | "messages">): boolean {
  return (variant === "rail" || variant === "drawer") && state.conversationId !== null && state.messages.length > 0 && state.live === null;
}

/** ui-3: the views' clock: the live tick while one runs (so "Still working… Ns" counts up), else the page's time. */
export function viewNowIso(ticking: boolean, tickMs: number, pageNowIso: string | null): string {
  return ticking || !pageNowIso ? new Date(tickMs).toISOString() : pageNowIso;
}

/** ui-5: focus the composer when the control that had focus unmounted (Send ↔ Stop, a starter, Try again). */
export function restoreComposerFocus(doc: { activeElement: unknown; body: unknown } | null | undefined, composer: Focusable | null | undefined): boolean {
  if (!doc || !composer || !focusLost(doc.activeElement, doc.body)) return false;
  composer.focus({ preventScroll: true });
  return true;
}

export const EXEC_CHAT_COPY = {
  newConversation: "New conversation",
  askAiFallbackLabel: "this Needs Attention item"
} as const;

const ATTENTION_ID = /^ea_[0-9a-f]{32}$/;
const CHAT_PAGE = "/executive/chat";
export const chatPageHref = (conversationId: string | null) => (conversationId ? `${CHAT_PAGE}?c=${encodeURIComponent(conversationId)}` : CHAT_PAGE);

/** What a click on the page means for the rail: the context to ask about, or null to let it navigate (C33). */
export interface AskAiClickLike {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  target: unknown;
}

interface ElementLike {
  closest(selector: string): ElementLike | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): { textContent: string | null } | null;
}

const isElementLike = (v: unknown): v is ElementLike =>
  typeof v === "object" && v !== null && typeof (v as ElementLike).closest === "function" && typeof (v as ElementLike).getAttribute === "function";

/**
 * A plain left click (no modifier) on a feed row's `a[data-exec-ask-ai]`:
 * the attention item it names, labelled with the row's title as the page
 * shows it. Anything else (a modified or middle click, another link, a click
 * something else already handled) is null, and the link navigates as usual.
 */
export function askAiClickContext(e: AskAiClickLike): ChatContextChip | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  if (!isElementLike(e.target)) return null;
  const link = e.target.closest("a[data-exec-ask-ai]");
  if (!link) return null;
  const id = link.getAttribute("data-exec-ask-ai");
  if (typeof id !== "string" || !ATTENTION_ID.test(id)) return null;
  const row = link.closest("[data-feed-row]");
  const title = row?.querySelector("h3")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  return { kind: "attention", id, label: title !== "" ? title : EXEC_CHAT_COPY.askAiFallbackLabel };
}

const VARIANT_SCROLL: Readonly<Record<ExecChatProps["variant"], string>> = {
  rail: "max-h-[30rem] overflow-y-auto",
  page: "min-h-[16rem] max-h-[calc(100vh-17rem)] overflow-y-auto",
  drawer: "min-h-0 flex-1 overflow-y-auto"
};

export function ExecChat(props: ExecChatProps) {
  const { variant, starters, tz, interceptAskAiLinks = false, emailOn = true } = props;
  const isTop = useIsTopWindow();
  const [state, dispatch] = useReducer(chatReducer, props, (p: ExecChatProps): ChatViewState =>
    initialChatState({ conversation: p.initialConversation, messages: p.initialMessages, context: p.initialContext })
  );
  const [draft, setDraft] = useState("");
  // The live clock: the page's time until a turn starts, then ticks once a second while one runs.
  const [tickMs, setTickMs] = useState<number>(() => {
    const at = props.nowIso ? Date.parse(props.nowIso) : NaN;
    return Number.isFinite(at) ? at : Date.now();
  });

  const stateRef = useRef(state);
  stateRef.current = state;
  const requestRef = useRef<AbortController | null>(null);
  const recoveryRef = useRef<AbortController | null>(null);
  const stoppedRef = useRef(false);
  const turnIdRef = useRef<string | null>(null);
  const queueRef = useRef<ChatSseEvent[]>([]);
  const frameRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const live = state.live !== null;
  // ui-3: a stored answer still running (opened mid-answer, or written by another tab) is watched until it settles.
  const watch = runningWatch(state);
  const runningTurnId = watch?.turnId ?? null;
  const ticking = live || runningTurnId !== null;

  useEffect(() => {
    if (!ticking) return;
    setTickMs(Date.now());
    const t = setInterval(() => setTickMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  // ui-5: the drawer opens with the composer focused (the legacy drawer's own input isn't rendered when routed).
  useEffect(() => {
    if (variant === "drawer") composerRef.current?.focus({ preventScroll: true });
  }, [variant]);

  /** ui-5: once the control that had focus is gone (Send ↔ Stop, a starter, Try again), the composer takes it. */
  const keepFocus = useCallback(() => {
    const run = () => restoreComposerFocus(typeof document === "undefined" ? null : document, composerRef.current);
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else run();
  }, []);

  useEffect(
    () => () => {
      requestRef.current?.abort();
      recoveryRef.current?.abort();
      if (frameRef.current !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameRef.current);
    },
    []
  );

  const flush = useCallback(() => {
    if (frameRef.current !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    const events = queueRef.current;
    queueRef.current = [];
    const nowMs = Date.now();
    for (const event of events) dispatch({ type: "event", event, nowMs });
  }, []);

  const enqueue = useCallback(
    (event: ChatSseEvent) => {
      if (event.event === "hello") turnIdRef.current = event.data.turnId;
      queueRef.current.push(event);
      if (event.event === "text" && typeof requestAnimationFrame === "function") {
        if (frameRef.current === null) frameRef.current = requestAnimationFrame(() => flush());
        return;
      }
      flush();
    },
    [flush]
  );

  const recover = useCallback(async (conversationId: string, turnId: string | null, quiet: boolean, maxMs?: number) => {
    recoveryRef.current?.abort();
    const ctrl = new AbortController();
    recoveryRef.current = ctrl;
    const outcome = await pollUntilSettled(conversationId, turnId, maxMs !== undefined ? { signal: ctrl.signal, maxMs } : { signal: ctrl.signal });
    if (recoveryRef.current !== ctrl) return;
    recoveryRef.current = null;
    if (outcome.kind === "settled") dispatch({ type: "recovered", messages: outcome.messages });
    else if (quiet || outcome.kind === "aborted") return;
    else if (outcome.kind === "gone") dispatch({ type: "http_error", status: 404, error: "not_found", retryAfterSec: null });
    else dispatch({ type: "http_error", status: 0, error: null, retryAfterSec: null });
  }, []);

  const run = useCallback(
    async (body: ChatPostBody, wasRetry: boolean) => {
      recoveryRef.current?.abort();
      recoveryRef.current = null;
      const ctrl = new AbortController();
      requestRef.current = ctrl;
      stoppedRef.current = false;
      turnIdRef.current = null;
      const outcome = await postChatTurn(body, { signal: ctrl.signal, onEvent: enqueue });
      flush();
      if (requestRef.current === ctrl) requestRef.current = null;
      if (stoppedRef.current || outcome.kind === "aborted") return;
      if (outcome.kind === "network_error") {
        dispatch({ type: "http_error", status: 0, error: null, retryAfterSec: null });
        return;
      }
      if (outcome.kind === "http_error") {
        dispatch({ type: "http_error", status: outcome.status, error: outcome.error, retryAfterSec: outcome.retryAfterSec, reason: outcome.reason });
        // The server is still writing a turn of this conversation: this very one on a retry (C50), or one another
        // tab asked (ui-3). Wait for it, so the banner clears and the answer appears; quietly for a new question.
        const busy = busyRecovery(outcome, body, wasRetry);
        if (busy) void recover(busy.conversationId, null, busy.quiet);
        if (isFinalHttpStatus(outcome.status) && !wasRetry) {
          // Refused for good: give him his question back to send again.
          setDraft((d) => (d.trim() === "" ? body.text : d));
        }
        return;
      }
      if (outcome.sawDone || outcome.sawError) return;
      if (outcome.sawHello && outcome.conversationId) {
        dispatch({ type: "stream_lost" });
        void recover(outcome.conversationId, outcome.turnId, false);
        return;
      }
      dispatch({ type: "http_error", status: 0, error: null, retryAfterSec: null });
    },
    [enqueue, flush, recover]
  );

  const send = useCallback(
    (text: string) => {
      const s = stateRef.current;
      const question = normalizeQuestion(text);
      if (s.live || question === "" || question.length > CHAT_TEXT_MAX) return;
      const clientTurnId = newClientTurnId();
      const body: ChatPostBody = {
        conversationId: s.conversationId,
        clientTurnId,
        text: question,
        context: s.context ? { kind: s.context.kind, id: s.context.id } : null
      };
      dispatch({ type: "send", clientTurnId, question, nowMs: Date.now() });
      setDraft("");
      keepFocus();
      void run(body, false);
    },
    [run, keepFocus]
  );

  const retry = useCallback(() => {
    const s = stateRef.current;
    const p = s.pending;
    if (s.live || !p) return;
    const body: ChatPostBody = {
      conversationId: p.conversationId,
      clientTurnId: p.clientTurnId,
      text: p.question,
      context: p.context ? { kind: p.context.kind, id: p.context.id } : null
    };
    dispatch({ type: "retry", nowMs: Date.now() });
    keepFocus();
    void run(body, true);
  }, [run, keepFocus]);

  const stop = useCallback(() => {
    const s = stateRef.current;
    if (!s.live) return;
    stoppedRef.current = true;
    const conversationId = s.pending?.conversationId ?? s.conversationId;
    const turnId = turnIdRef.current;
    requestRef.current?.abort();
    requestRef.current = null;
    flush();
    dispatch({ type: "stopped", nowMs: Date.now() });
    keepFocus();
    if (conversationId) void recover(conversationId, turnId, true);
  }, [flush, recover, keepFocus]);

  // ui-3: a stored answer still running is polled (quietly) until it settles, and the clock ticks meanwhile. Nothing
  // starts while a turn of this view is live or another recovery is already polling.
  const watchConversation = watch?.conversationId ?? null;
  useEffect(() => {
    if (runningTurnId === null || watchConversation === null || recoveryRef.current !== null) return;
    void recover(watchConversation, runningTurnId, true, RUNNING_WATCH_MAX_MS);
  }, [runningTurnId, watchConversation, recover]);

  const newConversation = useCallback(() => {
    if (stateRef.current.live) return;
    recoveryRef.current?.abort();
    recoveryRef.current = null;
    dispatch({ type: "new_conversation" });
  }, []);

  const onProposal = useCallback((proposal: ProposalView) => dispatch({ type: "proposal", proposal }), []);

  // C33: on the Overview the rail answers a feed row's Ask AI itself.
  useEffect(() => {
    if (!interceptAskAiLinks || !isTop || typeof document === "undefined") return;
    const onClick = (e: MouseEvent) => {
      const context = askAiClickContext(e);
      if (!context) return;
      e.preventDefault();
      dispatch({ type: "set_context", context });
      const box = composerRef.current;
      if (box) {
        box.focus({ preventScroll: true });
        box.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [interceptAskAiLinks, isTop]);

  // The page keeps ?c= in step with the conversation, so a reload reopens it.
  const shownConversation = useRef<string | null>(props.initialConversation?.id ?? null);
  useEffect(() => {
    if (variant !== "page" || typeof window === "undefined") return;
    if (state.conversationId === shownConversation.current) return;
    shownConversation.current = state.conversationId;
    try {
      // null, not history.state: Next's app router then syncs its own URL (memory next-replacestate-na-gotcha).
      window.history.replaceState(null, "", chatPageHref(state.conversationId));
    } catch {
      // A browser that refuses replaceState just keeps the old URL.
    }
  }, [variant, state.conversationId]);

  // Follow the conversation as it grows, unless he has scrolled up to read.
  const nearBottom = useRef(true);
  const lastRound = state.live ? Object.values(state.live.rounds).join("").length + state.live.tools.length : -1;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight;
  }, [state.messages.length, lastRound, state.banner]);

  // While the clock ticks (a live turn, a stored answer still running) the views get its time, so "Still working… Ns"
  // counts up instead of staying at the page's time (ui-3).
  const nowIso = viewNowIso(ticking, tickMs, props.nowIso);
  const hasAnswers = state.messages.length > 0;
  // ui-3: leaving mid-answer unmounts the chat, which aborts the POST: the link waits for the answer.
  const openInChat = openInChatShown(variant, state);

  return (
    <div data-exec-chat={variant} className={cn("flex min-w-0 flex-col gap-3", variant === "drawer" && "min-h-0 flex-1 gap-0")}>
      {variant === "page" && state.title && (
        <h2 data-chat-title className="break-words text-[15px] font-semibold text-ink [overflow-wrap:anywhere]">
          {state.title}
        </h2>
      )}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className={cn("min-w-0", VARIANT_SCROLL[variant], variant === "drawer" && "p-4")}
      >
        <ChatTranscriptView
          state={state}
          starters={starters}
          tz={tz}
          nowIso={nowIso}
          nowMs={tickMs}
          isTop={isTop}
          emailOn={emailOn}
          onStarter={send}
          onRetry={retry}
          onTryAgain={send}
          onClearContext={() => dispatch({ type: "clear_context" })}
          onProposal={onProposal}
        />
      </div>
      <div className={cn("min-w-0 space-y-2", variant === "drawer" && "border-t border-slate-200/60 p-3")}>
        <ChatComposer ref={composerRef} value={draft} onChange={setDraft} onSend={() => send(draft)} onStop={stop} live={live} isTop={isTop} />
        {(hasAnswers || openInChat) && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
            {isTop && hasAnswers && !live ? (
              <button type="button" data-new-conversation onClick={newConversation} className="inline-flex items-center gap-1 font-semibold text-slate-600 hover:text-ink">
                <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden />
                {EXEC_CHAT_COPY.newConversation}
              </button>
            ) : (
              <span />
            )}
            {openInChat && (
              <Link href={chatPageHref(state.conversationId)} prefetch={false} data-open-in-chat className="inline-flex items-center gap-1 font-semibold text-indigo-700 hover:text-indigo-900">
                {OPEN_IN_CHAT_LINK}
                <SquareArrowOutUpRight className="h-3 w-3" aria-hidden />
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
