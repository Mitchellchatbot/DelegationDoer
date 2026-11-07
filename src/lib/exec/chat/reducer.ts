import type { ChatContextKind } from "@/lib/exec/agent/types";
import type { CardView, ChatDonePayload, ChatMessageView, ChatSseEvent, ProposalView } from "@/lib/exec/chat/view-types";
import {
  BANNER_BUSY,
  BANNER_BUSY_PRINCIPAL,
  BANNER_CHAT_OFF,
  BANNER_CONTEXT_CHECK_FAILED,
  BANNER_CONTEXT_UNAVAILABLE,
  BANNER_LOST,
  BANNER_NOT_SAVED,
  BANNER_RATE_LIMITED,
  BANNER_SEND_FAILED,
  BANNER_UNAVAILABLE
} from "@/lib/exec/chat/copy";
import { stripMarkers } from "@/lib/exec/chat/markers";

// The chat UI's state (P5b contract §3.19.3; Area E): one conversation, the
// turn in flight and the banner, driven by the SSE events the route sends and
// by what the container (ExecChat) saw over HTTP. Pure and client-safe
// (boundary B4): it imports only chat/** and types.
//
// The server is authoritative: `done` replaces the live turn with the stored
// answer, and `recovered` replaces the whole transcript with what the GET
// returned. C50 (b-agent-12): `pending` is the question the server may
// already have started. It is kept across a network error or a 5xx, so
// "Try again" re-POSTs the SAME client turn id (the server answers with the
// stored turn, or says it is still running, and never runs it twice); `done`
// and any 4xx clear it, and only a new question mints a new id.

export interface ToolLine {
  callId: string;
  round: number;
  label: string;
  state: "running" | "done" | "error" | "skipped";
}

export interface LiveTurn {
  clientTurnId: string;
  question: string;
  phase: "connecting" | "streaming";
  rounds: Record<number, string>;
  tools: ToolLine[];
  retracted: boolean;
  startedAtMs: number;
  lastEventAtMs: number;
}

/** AM19: context_unavailable carries the route's reason (additive), so check_failed gets its own line. */
export type ChatBanner =
  | { kind: "rate_limited"; retryAfterSec: number | null }
  | { kind: "busy" }
  | { kind: "chat_off" }
  | { kind: "context_unavailable"; reason?: "gone" | "check_failed" }
  | { kind: "lost" }
  | { kind: "send_failed" }
  | { kind: "not_saved" }
  | { kind: "unavailable" }
  | { kind: "busy_principal" };

/** What the next question is about: server-resolved and screened (page) or picked on this page (rail, drawer). */
export interface ChatContextChip {
  kind: ChatContextKind;
  id: string;
  label: string;
}

export interface ChatViewState {
  conversationId: string | null;
  title: string | null;
  messages: ChatMessageView[];
  live: LiveTurn | null;
  banner: ChatBanner | null;
  context: ChatContextChip | null;
  /** C50 (b-agent-12): the turn the server may already have started; kept until `done` or a 4xx. */
  pending: { clientTurnId: string; conversationId: string | null; question: string; context: ChatViewState["context"] } | null;
}

export type ChatAction =
  | { type: "send"; clientTurnId: string; question: string; nowMs: number }
  | { type: "retry"; nowMs: number }
  | { type: "event"; event: ChatSseEvent; nowMs: number }
  | {
      type: "http_error";
      status: number;
      error: string | null;
      retryAfterSec: number | null;
      /** 409 context_unavailable's reason (AM19); optional and ignored for every other answer. */
      reason?: "gone" | "check_failed" | null;
    }
  | { type: "stream_lost" }
  | { type: "recovered"; messages: ChatMessageView[] }
  | { type: "stopped"; nowMs?: number }
  | { type: "clear_context" }
  | { type: "set_context"; context: ChatViewState["context"] }
  | { type: "new_conversation" }
  | { type: "proposal"; proposal: ProposalView };

/** The state a chat opens with: a stored conversation (the page's ?c=), or an empty one. */
export function initialChatState(init: {
  conversation?: { id: string; title: string } | null;
  messages?: readonly ChatMessageView[];
  context?: ChatContextChip | null;
}): ChatViewState {
  return {
    conversationId: init.conversation?.id ?? null,
    title: init.conversation?.title ?? null,
    messages: [...(init.messages ?? [])],
    live: null,
    banner: null,
    context: init.context ?? null,
    pending: null
  };
}

/** The banner's exact sentence (§3.19.5). */
export function bannerText(banner: ChatBanner): string {
  switch (banner.kind) {
    case "rate_limited":
      return BANNER_RATE_LIMITED;
    case "busy":
      return BANNER_BUSY;
    case "busy_principal":
      return BANNER_BUSY_PRINCIPAL;
    case "chat_off":
      return BANNER_CHAT_OFF;
    case "context_unavailable":
      return banner.reason === "check_failed" ? BANNER_CONTEXT_CHECK_FAILED : BANNER_CONTEXT_UNAVAILABLE;
    case "lost":
      return BANNER_LOST;
    case "send_failed":
      return BANNER_SEND_FAILED;
    case "not_saved":
      return BANNER_NOT_SAVED;
    case "unavailable":
      return BANNER_UNAVAILABLE;
  }
}

/**
 * §3.19.3: the banner for an HTTP answer to the POST. 429 rate_limited;
 * 409 turn_in_progress busy, too_many_running busy_principal,
 * context_unavailable (with its reason); 403 chat_off; 401/404 unavailable;
 * anything else (a network error is status 0, every 5xx, a 400, a 403
 * forbidden, a 413) send_failed.
 */
export function bannerForHttp(status: number, error: string | null, retryAfterSec: number | null, reason?: "gone" | "check_failed" | null): ChatBanner {
  if (status === 429) return { kind: "rate_limited", retryAfterSec: retryAfterSec !== null && Number.isFinite(retryAfterSec) && retryAfterSec >= 0 ? retryAfterSec : null };
  if (status === 409 && error === "turn_in_progress") return { kind: "busy" };
  if (status === 409 && error === "too_many_running") return { kind: "busy_principal" };
  if (status === 409 && error === "context_unavailable") {
    return reason === "check_failed" || reason === "gone" ? { kind: "context_unavailable", reason } : { kind: "context_unavailable" };
  }
  if (status === 403 && error === "chat_off") return { kind: "chat_off" };
  if (status === 401 || status === 404) return { kind: "unavailable" };
  return { kind: "send_failed" };
}

/** A 4xx answered the question for good (pending cleared); a network error (0) or a 5xx may not have (pending kept, C50). */
export function isFinalHttpStatus(status: number): boolean {
  return status >= 400 && status < 500;
}

/**
 * The live turn as the view shows it: a round's text moves to the working
 * notes once that round has a tool line; the rest is the answer so far.
 * Markers are hidden while streaming (§3.13.4: validation happens at done).
 */
export function liveText(live: Pick<LiveTurn, "rounds" | "tools">): { notes: { round: number; text: string }[]; current: string } {
  const toolRounds = new Set(live.tools.map((t) => t.round));
  const rounds = Object.keys(live.rounds)
    .map(Number)
    .filter((r) => Number.isFinite(r))
    .sort((a, b) => a - b);
  const notes: { round: number; text: string }[] = [];
  let current = "";
  for (const r of rounds) {
    const text = stripMarkers(live.rounds[r] ?? "");
    if (toolRounds.has(r)) {
      if (text.trim() !== "") notes.push({ round: r, text });
    } else {
      current += text;
    }
  }
  return { notes, current };
}

function newLive(clientTurnId: string, question: string, nowMs: number): LiveTurn {
  return { clientTurnId, question, phase: "connecting", rounds: {}, tools: [], retracted: false, startedAtMs: nowMs, lastEventAtMs: nowMs };
}

const isoAt = (ms: number) => new Date(Number.isFinite(ms) ? ms : 0).toISOString();

/** The question as a transcript row, until a reload brings the stored one. */
function localUserMessage(clientTurnId: string, turnId: string, question: string, kind: ChatContextKind | null, nowMs: number): ChatMessageView {
  return {
    id: `local-${clientTurnId}-question`,
    turnId,
    role: "user",
    status: "complete",
    statusReason: null,
    text: question,
    recommendations: "",
    sources: [],
    cards: [],
    createdAt: isoAt(nowMs),
    finishedAt: null,
    redacted: false,
    contextKind: kind
  };
}

function assistantMessageFrom(done: ChatDonePayload, nowMs: number): ChatMessageView {
  return {
    id: done.messageId,
    turnId: done.turnId,
    role: "assistant",
    status: done.status,
    statusReason: done.statusReason,
    text: done.answer,
    recommendations: done.recommendations,
    sources: [...done.sources],
    cards: [...done.cards],
    createdAt: isoAt(nowMs),
    finishedAt: isoAt(nowMs),
    redacted: false,
    contextKind: null
  };
}

function upsertTool(tools: readonly ToolLine[], line: ToolLine): ToolLine[] {
  const at = tools.findIndex((t) => t.callId === line.callId);
  if (at < 0) return [...tools, line];
  const next = [...tools];
  next[at] = line;
  return next;
}

function withProposal(cards: readonly CardView[], proposal: ProposalView): CardView[] | null {
  let changed = false;
  const next = cards.map((c) => {
    if (c.kind === "task_proposal" && c.proposal.id === proposal.id) {
      changed = true;
      return { kind: "task_proposal" as const, proposal };
    }
    return c;
  });
  return changed ? next : null;
}

function onEvent(state: ChatViewState, event: ChatSseEvent, nowMs: number): ChatViewState {
  const live = state.live;
  switch (event.event) {
    case "hello": {
      if (!live) return state;
      const conversationId = event.data.conversationId;
      return {
        ...state,
        conversationId,
        pending: state.pending ? { ...state.pending, conversationId } : state.pending,
        live: { ...live, phase: "streaming", lastEventAtMs: nowMs }
      };
    }
    case "text": {
      if (!live) return state;
      const { round, delta } = event.data;
      return { ...state, live: { ...live, rounds: { ...live.rounds, [round]: (live.rounds[round] ?? "") + delta }, lastEventAtMs: nowMs } };
    }
    case "tool": {
      if (!live) return state;
      const { callId, round, label, state: toolState } = event.data;
      return { ...state, live: { ...live, tools: upsertTool(live.tools, { callId, round, label, state: toolState }), lastEventAtMs: nowMs } };
    }
    case "retract": {
      if (!live) return state;
      return { ...state, live: { ...live, rounds: {}, retracted: true, lastEventAtMs: nowMs } };
    }
    case "done": {
      const done = event.data;
      const assistant = assistantMessageFrom(done, nowMs);
      const existing = state.messages.findIndex((m) => m.id === done.messageId);
      let messages: ChatMessageView[];
      if (existing >= 0) {
        messages = [...state.messages];
        messages[existing] = { ...assistant, createdAt: state.messages[existing].createdAt };
      } else {
        const question = live?.question ?? state.pending?.question ?? null;
        const clientTurnId = live?.clientTurnId ?? state.pending?.clientTurnId ?? done.turnId;
        const kind = state.pending?.context?.kind ?? null;
        messages = question === null ? [...state.messages, assistant] : [...state.messages, localUserMessage(clientTurnId, done.turnId, question, kind, live?.startedAtMs ?? nowMs), assistant];
      }
      return {
        ...state,
        conversationId: done.conversationId,
        title: done.conversationTitle,
        messages,
        live: null,
        pending: null,
        banner: done.saved ? null : { kind: "not_saved" }
      };
    }
    case "error": {
      // A failure after hello and before done: the server finished the row as
      // failed (best effort). The question stays pending, so Try again asks the
      // server for that stored turn rather than running a new one (C50).
      if (!live) return state;
      return { ...state, live: null, banner: { kind: "send_failed" } };
    }
  }
}

export function chatReducer(state: ChatViewState, action: ChatAction): ChatViewState {
  switch (action.type) {
    case "send": {
      if (state.live) return state;
      const question = action.question;
      return {
        ...state,
        live: newLive(action.clientTurnId, question, action.nowMs),
        banner: null,
        // The context goes with this question; a 4xx that refuses it puts it back.
        context: null,
        pending: { clientTurnId: action.clientTurnId, conversationId: state.conversationId, question, context: state.context }
      };
    }
    case "retry": {
      if (state.live || !state.pending) return state;
      return { ...state, live: newLive(state.pending.clientTurnId, state.pending.question, action.nowMs), banner: null };
    }
    case "event":
      return onEvent(state, action.event, action.nowMs);
    case "http_error": {
      const banner = bannerForHttp(action.status, action.error, action.retryAfterSec, action.reason ?? null);
      if (!isFinalHttpStatus(action.status)) return { ...state, live: null, banner };
      const pending = state.pending;
      const refusedContext = banner.kind === "context_unavailable";
      return {
        ...state,
        live: null,
        pending: null,
        banner,
        context: refusedContext ? null : (state.context ?? pending?.context ?? null)
      };
    }
    case "stream_lost":
      return { ...state, banner: { kind: "lost" } };
    case "recovered":
      return { ...state, messages: [...action.messages], live: null, pending: null, banner: null };
    case "stopped": {
      const live = state.live;
      if (!live) return state;
      const nowMs = action.nowMs ?? live.lastEventAtMs;
      const { current } = liveText(live);
      const kind = state.pending?.context?.kind ?? null;
      const turnId = `local-${live.clientTurnId}`;
      const aborted: ChatMessageView = {
        id: `local-${live.clientTurnId}-stopped`,
        turnId,
        role: "assistant",
        status: "aborted",
        statusReason: "client_abort",
        text: live.retracted ? "" : current,
        recommendations: "",
        sources: [],
        cards: [],
        createdAt: isoAt(nowMs),
        finishedAt: isoAt(nowMs),
        redacted: false,
        contextKind: null
      };
      return {
        ...state,
        messages: [...state.messages, localUserMessage(live.clientTurnId, turnId, live.question, kind, live.startedAtMs), aborted],
        live: null,
        pending: null,
        banner: null
      };
    }
    case "clear_context":
      return state.context === null ? state : { ...state, context: null };
    case "set_context":
      return { ...state, context: action.context, banner: state.banner?.kind === "context_unavailable" ? null : state.banner };
    case "new_conversation":
      if (state.live) return state;
      return { conversationId: null, title: null, messages: [], live: null, banner: null, context: null, pending: null };
    case "proposal": {
      let changed = false;
      const messages = state.messages.map((m) => {
        const cards = withProposal(m.cards, action.proposal);
        if (cards === null) return m;
        changed = true;
        return { ...m, cards };
      });
      return changed ? { ...state, messages } : state;
    }
  }
}
