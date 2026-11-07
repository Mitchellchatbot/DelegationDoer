import { describe, expect, it } from "vitest";
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
import { bannerForHttp, bannerText, chatReducer, initialChatState, liveText, type ChatAction, type ChatViewState } from "@/lib/exec/chat/reducer";
import type { ChatSseEvent } from "@/lib/exec/chat/view-types";
import { answer, chatState, CLIENT_TURN_ID, CONVERSATION_ID, done, hello, NOW_MS, proposal, userMessage } from "../__tests__/chat-ui-fixtures";

// P5b contract §5 tests 96 and 115 (Area E; §3.19.3, C50, AM19): every reducer
// action, the HTTP mapping, and the client turn id kept across a network
// error or a 5xx so a retry re-POSTs the same id.

const run = (state: ChatViewState, ...actions: ChatAction[]) => actions.reduce(chatReducer, state);
const send = (question = "Which projects are falling behind?", clientTurnId = CLIENT_TURN_ID): ChatAction => ({ type: "send", clientTurnId, question, nowMs: NOW_MS });
const ev = (event: Extract<ChatAction, { type: "event" }>["event"], nowMs = NOW_MS + 100): ChatAction => ({ type: "event", event, nowMs });
const httpError = (status: number, error: string | null = null, extra: Partial<Extract<ChatAction, { type: "http_error" }>> = {}): ChatAction => ({
  type: "http_error",
  status,
  error,
  retryAfterSec: null,
  ...extra
});
const CONTEXT = { kind: "attention" as const, id: "ea_" + "b".repeat(32), label: "Overdue renewal" };

describe("chatReducer (test 96)", () => {
  it("initialChatState opens a stored conversation, or an empty one", () => {
    expect(initialChatState({})).toEqual({ conversationId: null, title: null, messages: [], live: null, banner: null, context: null, pending: null });
    const s = initialChatState({ conversation: { id: CONVERSATION_ID, title: "T" }, messages: [userMessage(), answer()], context: CONTEXT });
    expect(s).toMatchObject({ conversationId: CONVERSATION_ID, title: "T", context: CONTEXT });
    expect(s.messages).toHaveLength(2);
  });

  it("send: starts the live turn (connecting), sets pending with the new id, takes the context along", () => {
    const s = run(chatState({ conversationId: CONVERSATION_ID, context: CONTEXT, banner: { kind: "not_saved" } }), send());
    expect(s.live).toMatchObject({ clientTurnId: CLIENT_TURN_ID, question: "Which projects are falling behind?", phase: "connecting", rounds: {}, tools: [], retracted: false, startedAtMs: NOW_MS });
    expect(s.pending).toEqual({ clientTurnId: CLIENT_TURN_ID, conversationId: CONVERSATION_ID, question: "Which projects are falling behind?", context: CONTEXT });
    expect(s.context).toBeNull();
    expect(s.banner).toBeNull();
  });

  it("send while a turn is live does nothing", () => {
    const s = run(chatState(), send());
    expect(chatReducer(s, send("another", "other-id-123"))).toBe(s);
  });

  it("hello sets the conversation id (also on pending) and streaming", () => {
    const s = run(chatState(), send(), ev(hello()));
    expect(s.conversationId).toBe(CONVERSATION_ID);
    expect(s.pending?.conversationId).toBe(CONVERSATION_ID);
    expect(s.live?.phase).toBe("streaming");
    expect(s.live?.lastEventAtMs).toBe(NOW_MS + 100);
  });

  it("text appends to its round; tool upserts by call id; a round with a tool line becomes notes", () => {
    let s = run(chatState(), send(), ev(hello()));
    s = run(
      s,
      ev({ event: "text", data: { round: 1, delta: "Let me check " } }),
      ev({ event: "text", data: { round: 1, delta: "the projects [r2]." } }),
      ev({ event: "tool", data: { round: 1, callId: "c1", name: "project_health", label: "Checking project health", state: "running" } }),
      ev({ event: "tool", data: { round: 1, callId: "c2", name: "search_tasks", label: "Searching tasks", state: "running" } }),
      ev({ event: "tool", data: { round: 1, callId: "c1", name: "project_health", label: "Checking project health", state: "done" } }),
      ev({ event: "text", data: { round: 2, delta: "Two are behind." } })
    );
    expect(s.live?.rounds).toEqual({ 1: "Let me check the projects [r2].", 2: "Two are behind." });
    expect(s.live?.tools).toEqual([
      { callId: "c1", round: 1, label: "Checking project health", state: "done" },
      { callId: "c2", round: 1, label: "Searching tasks", state: "running" }
    ]);
    // Markers are hidden while streaming; round 1 called tools, so its text is a note.
    expect(liveText(s.live!)).toEqual({ notes: [{ round: 1, text: "Let me check the projects ." }], current: "Two are behind." });
  });

  it("retract empties every round and marks the turn retracted", () => {
    const s = run(chatState(), send(), ev(hello()), ev({ event: "text", data: { round: 1, delta: "partial" } }), ev({ event: "retract", data: {} }));
    expect(s.live).toMatchObject({ rounds: {}, retracted: true });
  });

  it("done replaces live with the finished answer (the server's is authoritative), adds the question, clears pending", () => {
    const s = run(chatState(), send(), ev(hello()), ev({ event: "text", data: { round: 1, delta: "streamed text that differs" } }), ev({ event: "done", data: done() }));
    expect(s.live).toBeNull();
    expect(s.pending).toBeNull();
    expect(s.banner).toBeNull();
    expect(s.conversationId).toBe(CONVERSATION_ID);
    expect(s.title).toBe(done().conversationTitle);
    expect(s.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Which projects are falling behind?"],
      ["assistant", "All good [r1]."]
    ]);
    expect(s.messages[1]).toMatchObject({ id: "em_asst_2", turnId: "et_2", status: "complete", sources: done().sources });
  });

  it("done with saved false shows not_saved", () => {
    const s = run(chatState(), send(), ev(hello()), ev({ event: "done", data: done({ saved: false }) }));
    expect(s.banner).toEqual({ kind: "not_saved" });
    expect(bannerText(s.banner!)).toBe(BANNER_NOT_SAVED);
  });

  it("done for a message already shown (a recovery got there first) replaces it instead of adding one", () => {
    const shown = answer({ id: "em_asst_2", status: "running", text: "" });
    const s = run(chatState({ messages: [userMessage(), shown] }), send(), ev(hello()), ev({ event: "done", data: done() }));
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1]).toMatchObject({ id: "em_asst_2", status: "complete", text: "All good [r1]." });
  });

  it("error ends live as send_failed and keeps the question pending (C50)", () => {
    const s = run(chatState(), send(), ev(hello()), ev({ event: "error", data: { code: "internal" } }));
    expect(s.live).toBeNull();
    expect(s.banner).toEqual({ kind: "send_failed" });
    expect(s.pending?.clientTurnId).toBe(CLIENT_TURN_ID);
  });

  it("http_error maps 429, 409 turn_in_progress / too_many_running / context_unavailable, 403 chat_off, 401/404, else send_failed", () => {
    expect(bannerForHttp(429, "rate_limited", 120)).toEqual({ kind: "rate_limited", retryAfterSec: 120 });
    expect(bannerForHttp(429, null, null)).toEqual({ kind: "rate_limited", retryAfterSec: null });
    expect(bannerForHttp(409, "turn_in_progress", null)).toEqual({ kind: "busy" });
    expect(bannerForHttp(409, "too_many_running", null)).toEqual({ kind: "busy_principal" });
    expect(bannerForHttp(409, "context_unavailable", null, "gone")).toEqual({ kind: "context_unavailable", reason: "gone" });
    expect(bannerForHttp(409, "context_unavailable", null, "check_failed")).toEqual({ kind: "context_unavailable", reason: "check_failed" });
    expect(bannerForHttp(409, "context_unavailable", null)).toEqual({ kind: "context_unavailable" });
    expect(bannerForHttp(403, "chat_off", null)).toEqual({ kind: "chat_off" });
    expect(bannerForHttp(401, null, null)).toEqual({ kind: "unavailable" });
    expect(bannerForHttp(404, "not_found", null)).toEqual({ kind: "unavailable" });
    for (const [status, code] of [[0, null], [400, "bad_text"], [403, "forbidden"], [413, "too_large"], [500, "internal"], [503, "unavailable"], [503, "audit_unavailable"], [409, "other"]] as const) {
      expect(bannerForHttp(status, code, null), `${status} ${code}`).toEqual({ kind: "send_failed" });
    }
    // Through the reducer, with the exact copy.
    const at = (a: ChatAction) => bannerText(run(chatState(), send(), a).banner!);
    expect(at(httpError(429, "rate_limited", { retryAfterSec: 60 }))).toBe(BANNER_RATE_LIMITED);
    expect(at(httpError(409, "turn_in_progress"))).toBe(BANNER_BUSY);
    expect(at(httpError(409, "too_many_running"))).toBe(BANNER_BUSY_PRINCIPAL);
    expect(at(httpError(409, "context_unavailable", { reason: "gone" }))).toBe(BANNER_CONTEXT_UNAVAILABLE);
    expect(at(httpError(409, "context_unavailable", { reason: "check_failed" }))).toBe(BANNER_CONTEXT_CHECK_FAILED);
    expect(at(httpError(403, "chat_off"))).toBe(BANNER_CHAT_OFF);
    expect(at(httpError(401))).toBe(BANNER_UNAVAILABLE);
    expect(at(httpError(503, "unavailable"))).toBe(BANNER_SEND_FAILED);
  });

  it("a 4xx puts the context back for the next question, except context_unavailable, which drops it", () => {
    const withContext = chatState({ context: CONTEXT });
    expect(run(withContext, send(), httpError(429, "rate_limited")).context).toEqual(CONTEXT);
    expect(run(withContext, send(), httpError(409, "context_unavailable", { reason: "gone" })).context).toBeNull();
  });

  it("stream_lost shows lost (the streamed text stays); recovered replaces the transcript from the GET", () => {
    let s = run(chatState(), send(), ev(hello()), ev({ event: "text", data: { round: 1, delta: "half" } }), { type: "stream_lost" });
    expect(s.banner).toEqual({ kind: "lost" });
    expect(bannerText(s.banner!)).toBe(BANNER_LOST);
    expect(s.live?.rounds[1]).toBe("half");
    expect(s.pending).not.toBeNull();
    s = chatReducer(s, { type: "recovered", messages: [userMessage(), answer()] });
    expect(s).toMatchObject({ live: null, pending: null, banner: null });
    expect(s.messages.map((m) => m.id)).toEqual(["em_user_1", "em_asst_1"]);
  });

  it("stopped keeps the streamed answer text as an aborted message (markers hidden) and settles the turn", () => {
    const s = run(
      chatState(),
      send(),
      ev(hello()),
      ev({ event: "text", data: { round: 1, delta: "notes" } }),
      ev({ event: "tool", data: { round: 1, callId: "c1", name: "get_overview", label: "Checking the company overview", state: "done" } }),
      ev({ event: "text", data: { round: 2, delta: "Partial answer [r3]" } }),
      { type: "stopped", nowMs: NOW_MS + 500 }
    );
    expect(s.live).toBeNull();
    expect(s.pending).toBeNull();
    expect(s.messages.map((m) => [m.role, m.status, m.text])).toEqual([
      ["user", "complete", "Which projects are falling behind?"],
      ["assistant", "aborted", "Partial answer "]
    ]);
    expect(chatReducer(chatState(), { type: "stopped" })).toEqual(chatState());
  });

  it("clear_context, set_context (which also clears a context banner) and new_conversation", () => {
    const s = chatState({ context: CONTEXT });
    expect(chatReducer(s, { type: "clear_context" }).context).toBeNull();
    const withBanner = chatState({ banner: { kind: "context_unavailable", reason: "gone" } });
    expect(chatReducer(withBanner, { type: "set_context", context: CONTEXT })).toMatchObject({ context: CONTEXT, banner: null });
    expect(chatReducer(chatState({ banner: { kind: "busy" } }), { type: "set_context", context: CONTEXT }).banner).toEqual({ kind: "busy" });
    const full = chatState({ conversationId: CONVERSATION_ID, title: "T", messages: [userMessage(), answer()], banner: { kind: "not_saved" }, context: CONTEXT });
    expect(chatReducer(full, { type: "new_conversation" })).toEqual(initialChatState({}));
    const liveState = run(full, send());
    expect(chatReducer(liveState, { type: "new_conversation" })).toBe(liveState);
  });

  it("proposal replaces that proposal on whichever card holds it", () => {
    const card = { kind: "task_proposal" as const, proposal: proposal() };
    const s = chatState({ messages: [userMessage(), answer({ cards: [card] })] });
    const next = chatReducer(s, { type: "proposal", proposal: proposal({ status: "confirmed", taskHref: "/tasks/t_9" }) });
    expect(next.messages[1].cards[0]).toEqual({ kind: "task_proposal", proposal: proposal({ status: "confirmed", taskHref: "/tasks/t_9" }) });
    expect(chatReducer(s, { type: "proposal", proposal: proposal({ id: "etp_" + "9".repeat(32) }) })).toBe(s);
  });

  it("events with no live turn are ignored (late frames after Stop)", () => {
    const s = chatState({ messages: [userMessage()] });
    const late: ChatSseEvent[] = [hello(), { event: "text", data: { round: 1, delta: "x" } }, { event: "retract", data: {} }, { event: "error", data: { code: "internal" } }];
    for (const e of late) {
      expect(chatReducer(s, ev(e))).toBe(s);
    }
  });
});

describe("C50: the client turn id survives a network error or a 5xx (test 115)", () => {
  it("a network error before hello keeps pending { clientTurnId, conversationId } and shows send_failed", () => {
    const s = run(chatState({ conversationId: CONVERSATION_ID }), send(), httpError(0));
    expect(s.live).toBeNull();
    expect(s.banner).toEqual({ kind: "send_failed" });
    expect(s.pending).toEqual({ clientTurnId: CLIENT_TURN_ID, conversationId: CONVERSATION_ID, question: "Which projects are falling behind?", context: null });
  });

  it("Try again (retry) re-POSTs the same id: live starts again with the same clientTurnId and question", () => {
    const failed = run(chatState(), send(), httpError(0));
    const s = chatReducer(failed, { type: "retry", nowMs: NOW_MS + 5_000 });
    expect(s.live).toMatchObject({ clientTurnId: CLIENT_TURN_ID, question: "Which projects are falling behind?", phase: "connecting", startedAtMs: NOW_MS + 5_000 });
    expect(s.pending?.clientTurnId).toBe(CLIENT_TURN_ID);
    expect(s.banner).toBeNull();
    // Nothing to retry without a pending question, or while one is live.
    expect(chatReducer(chatState(), { type: "retry", nowMs: NOW_MS })).toEqual(chatState());
    expect(chatReducer(s, { type: "retry", nowMs: NOW_MS })).toBe(s);
  });

  it("a 5xx keeps it; a 4xx clears it", () => {
    for (const status of [500, 502, 503]) expect(run(chatState(), send(), httpError(status, "unavailable")).pending?.clientTurnId, String(status)).toBe(CLIENT_TURN_ID);
    for (const [status, code] of [[400, "bad_text"], [403, "chat_off"], [404, "not_found"], [409, "turn_in_progress"], [409, "too_many_running"], [429, "rate_limited"]] as const) {
      expect(run(chatState(), send(), httpError(status, code)).pending, `${status} ${code}`).toBeNull();
    }
  });

  it("a new question mints a new id (the caller passes it), replacing the unsent one", () => {
    const failed = run(chatState(), send(), httpError(503, "unavailable"));
    const s = chatReducer(failed, send("A different question", "new-turn-id-0001"));
    expect(s.pending).toMatchObject({ clientTurnId: "new-turn-id-0001", question: "A different question" });
    expect(s.live?.clientTurnId).toBe("new-turn-id-0001");
  });

  it("the retry's hello and replayed done for the pending id settle it", () => {
    const failed = run(chatState(), send(), ev(hello()), ev({ event: "error", data: { code: "internal" } }));
    expect(failed.pending?.clientTurnId).toBe(CLIENT_TURN_ID);
    const s = run(failed, { type: "retry", nowMs: NOW_MS + 1_000 }, ev(hello({ created: false })), ev({ event: "done", data: done({ status: "failed", statusReason: "internal", answer: "x" }) }));
    expect(s.pending).toBeNull();
    expect(s.live).toBeNull();
    expect(s.banner).toBeNull();
    expect(s.messages.map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "failed"]
    ]);
  });
});
