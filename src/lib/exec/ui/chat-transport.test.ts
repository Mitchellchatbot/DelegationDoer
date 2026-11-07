import { describe, expect, it, vi } from "vitest";
import {
  CHAT_ENDPOINT,
  fetchConversation,
  newClientTurnId,
  pollUntilSettled,
  postChatTurn,
  postProposalAction,
  turnSettled,
  type ChatPostBody
} from "@/components/exec/chat/transport";
import { chatReducer, initialChatState } from "@/lib/exec/chat/reducer";
import type { ChatSseEvent } from "@/lib/exec/chat/view-types";
import { answer, CLIENT_TURN_ID, CONVERSATION_ID, done, HASH, proposal, userMessage } from "../__tests__/chat-ui-fixtures";

// The browser's HTTP side of chat (Area E, §3.19.4, §3.16): the streamed POST
// read through getReader and createSseParser, the refusals it maps for the
// reducer, recovery polling, and the proposal Confirm / Dismiss answers
// (test 94's 200 / 409 changed / 410 half).

const BODY: ChatPostBody = { conversationId: null, clientTurnId: CLIENT_TURN_ID, text: "Who has overdue tasks?", context: null };
const enc = new TextEncoder();

function streamOf(chunks: (string | Uint8Array)[], opts: { failAfter?: number } = {}): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.failAfter !== undefined && i >= opts.failAfter) {
        controller.error(new TypeError("network reset"));
        return;
      }
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const c = chunks[i++];
      controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
    }
  });
}

const sse = (body: ReadableStream<Uint8Array>) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const frame = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const HELLO = { turnId: "et_2", conversationId: CONVERSATION_ID, messageId: "em_asst_2", created: true };

describe("postChatTurn", () => {
  it("POSTs the body as JSON asking for an event stream, and hands every event on as it arrives", async () => {
    const fetchImpl = vi.fn(async () => sse(streamOf([frame("hello", HELLO), ": ping 1\n\n", frame("text", { round: 1, delta: "Hel" }), frame("text", { round: 1, delta: "lo" }), frame("done", done())])));
    const events: ChatSseEvent[] = [];
    const out = await postChatTurn(BODY, { onEvent: (e) => events.push(e), fetchImpl });
    expect(out).toEqual({ kind: "ended", sawHello: true, sawDone: true, sawError: false, conversationId: CONVERSATION_ID, turnId: "et_2" });
    expect(events.map((e) => e.event)).toEqual(["hello", "text", "text", "done"]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CHAT_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json", Accept: "text/event-stream" });
    expect(JSON.parse(String(init.body))).toEqual(BODY);
  });

  it("decodes a character split across byte chunks (one TextDecoder in stream mode)", async () => {
    const bytes = enc.encode(frame("text", { round: 1, delta: "café ✓" }));
    const at = bytes.indexOf(0xc3) + 1; // inside "é"
    const events: ChatSseEvent[] = [];
    await postChatTurn(BODY, { onEvent: (e) => events.push(e), fetchImpl: async () => sse(streamOf([bytes.slice(0, at), bytes.slice(at)])) });
    expect(events).toEqual([{ event: "text", data: { round: 1, delta: "café ✓" } }]);
  });

  it("a stream that closes without done reports what it saw (hello and its ids)", async () => {
    const out = await postChatTurn(BODY, { onEvent: () => {}, fetchImpl: async () => sse(streamOf([frame("hello", HELLO), frame("text", { round: 1, delta: "x" })])) });
    expect(out).toEqual({ kind: "ended", sawHello: true, sawDone: false, sawError: false, conversationId: CONVERSATION_ID, turnId: "et_2" });
    const reset = await postChatTurn(BODY, { onEvent: () => {}, fetchImpl: async () => sse(streamOf([frame("hello", HELLO)], { failAfter: 1 })) });
    expect(reset).toMatchObject({ kind: "ended", sawHello: true, sawDone: false });
  });

  it("maps a refusal: status, code, the context reason, Retry-After from the body or the header", async () => {
    expect(await postChatTurn(BODY, { onEvent: () => {}, fetchImpl: async () => json(409, { error: "context_unavailable", reason: "check_failed" }) })).toEqual({
      kind: "http_error",
      status: 409,
      error: "context_unavailable",
      reason: "check_failed",
      retryAfterSec: null,
      conversationId: null
    });
    expect(await postChatTurn(BODY, { onEvent: () => {}, fetchImpl: async () => json(429, { error: "rate_limited", retryAfterSeconds: 42 }, { "retry-after": "60" }) })).toMatchObject({
      status: 429,
      retryAfterSec: 42
    });
    expect(await postChatTurn(BODY, { onEvent: () => {}, fetchImpl: async () => json(429, { error: "rate_limited" }, { "retry-after": "60" }) })).toMatchObject({ retryAfterSec: 60 });
    expect(await postChatTurn(BODY, { onEvent: () => {}, fetchImpl: async () => new Response("<html>bad gateway</html>", { status: 502 }) })).toMatchObject({
      kind: "http_error",
      status: 502,
      error: null
    });
    // A 200 that isn't a stream is broken, not a refusal: it keeps the question (5xx-like).
    expect(await postChatTurn(BODY, { onEvent: () => {}, fetchImpl: async () => json(200, { ok: true }) })).toMatchObject({ kind: "http_error", status: 502 });
  });

  it("a fetch that throws is a network error; an aborted one (Stop) is aborted", async () => {
    expect(await postChatTurn(BODY, { onEvent: () => {}, fetchImpl: async () => Promise.reject(new TypeError("fetch failed")) })).toEqual({ kind: "network_error" });
    const ctrl = new AbortController();
    ctrl.abort();
    expect(
      await postChatTurn(BODY, { signal: ctrl.signal, onEvent: () => {}, fetchImpl: async () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })) })
    ).toMatchObject({ kind: "aborted" });
  });

  it("the route's bytes, parsed, drive the reducer to the stored answer", async () => {
    let state = chatReducer(initialChatState({}), { type: "send", clientTurnId: CLIENT_TURN_ID, question: "Who has overdue tasks?", nowMs: 1 });
    await postChatTurn(BODY, {
      onEvent: (event) => (state = chatReducer(state, { type: "event", event, nowMs: 2 })),
      fetchImpl: async () =>
        sse(
          streamOf([
            frame("hello", HELLO),
            frame("tool", { round: 1, callId: "c1", name: "search_tasks", label: "Searching tasks", state: "running" }),
            frame("tool", { round: 1, callId: "c1", name: "search_tasks", label: "Searching tasks", state: "done" }),
            frame("text", { round: 2, delta: "Dana [r1]." }),
            frame("done", done({ answer: "Dana [r1]." }))
          ])
        )
    });
    expect(state.live).toBeNull();
    expect(state.pending).toBeNull();
    expect(state.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Who has overdue tasks?"],
      ["assistant", "Dana [r1]."]
    ]);
  });

  it("newClientTurnId fits the route's pattern and differs each time", () => {
    const a = newClientTurnId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(newClientTurnId()).not.toBe(a);
  });
});

describe("recovery: fetchConversation and pollUntilSettled", () => {
  const view = { id: CONVERSATION_ID, title: "T", createdAt: "x", lastMessageAt: "y", turnCount: 1 };

  it("fetchConversation reads { conversation, messages, hasEarlier }; a refusal is its status, the network 0", async () => {
    const ok = await fetchConversation(CONVERSATION_ID, { fetchImpl: async () => json(200, { conversation: view, messages: [userMessage()], hasEarlier: false }) });
    expect(ok).toEqual({ ok: true, conversation: view, messages: [userMessage()], hasEarlier: false });
    expect(await fetchConversation(CONVERSATION_ID, { fetchImpl: async () => json(404, { error: "not_found" }) })).toEqual({ ok: false, status: 404 });
    expect(await fetchConversation(CONVERSATION_ID, { fetchImpl: async () => Promise.reject(new TypeError("offline")) })).toEqual({ ok: false, status: 0 });
  });

  it("turnSettled: by turn id when known, else no answer running", () => {
    const running = answer({ turnId: "et_2", status: "running" });
    expect(turnSettled([userMessage(), answer(), running], "et_2")).toBe(false);
    expect(turnSettled([userMessage(), answer(), { ...running, status: "aborted" }], "et_2")).toBe(true);
    expect(turnSettled([answer(), running], null)).toBe(false);
    expect(turnSettled([answer()], null)).toBe(true);
  });

  it("polls every interval until the turn isn't running; a failed read waits for the next tick", async () => {
    const replies = [
      json(200, { conversation: view, messages: [answer({ turnId: "et_2", status: "running" })] }),
      json(503, { error: "unavailable" }),
      json(200, { conversation: view, messages: [answer({ turnId: "et_2", status: "complete" })] })
    ];
    const fetchImpl = vi.fn(async () => replies.shift()!);
    const sleep = vi.fn(async () => {});
    const out = await pollUntilSettled(CONVERSATION_ID, "et_2", { fetchImpl, sleep, nowMs: () => 0 });
    expect(out.kind).toBe("settled");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0]).toEqual([3_000, undefined]);
  });

  it("stops at 2 minutes (timeout), on 401/404 (gone) and when aborted", async () => {
    let t = 0;
    const running = async () => json(200, { conversation: view, messages: [answer({ status: "running" })] });
    const timeout = await pollUntilSettled(CONVERSATION_ID, null, { fetchImpl: running, sleep: async (ms) => void (t += ms), nowMs: () => t });
    expect(timeout).toEqual({ kind: "timeout" });
    expect(t).toBeLessThanOrEqual(120_000);
    expect(await pollUntilSettled(CONVERSATION_ID, null, { fetchImpl: async () => json(404, {}), sleep: async () => {} })).toEqual({ kind: "gone" });
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await pollUntilSettled(CONVERSATION_ID, null, { signal: ctrl.signal, fetchImpl: running, sleep: async () => {} })).toEqual({ kind: "aborted" });
  });
});

describe("postProposalAction (test 94: Confirm posts { contentHash }; 200 / 409 changed / 410)", () => {
  it("Confirm posts exactly { contentHash } to the confirm route; 200 confirmed carries the task link", async () => {
    const fetchImpl = vi.fn(async () => json(200, { status: "confirmed", taskId: "t_9", taskHref: "/tasks/t_9" }));
    const out = await postProposalAction(proposal(), "confirm", { fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/exec/tasks/proposals/${proposal().id}/confirm`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ contentHash: HASH });
    expect(out).toEqual({ kind: "updated", proposal: proposal({ status: "confirmed", taskHref: "/tasks/t_9" }) });
  });

  it("409 changed hands back the server's proposal; 409 not_pending takes its status; in_progress is confirming; 410 expired; 404 removed", async () => {
    const current = proposal({ title: "[Removed]", description: "", redacted: true, contentHash: "e".repeat(64) });
    expect(await postProposalAction(proposal(), "confirm", { fetchImpl: async () => json(409, { error: "changed", proposal: current }) })).toEqual({ kind: "changed", proposal: current });
    expect(await postProposalAction(proposal(), "confirm", { fetchImpl: async () => json(409, { error: "not_pending", status: "dismissed" }) })).toEqual({
      kind: "updated",
      proposal: proposal({ status: "dismissed" })
    });
    expect(await postProposalAction(proposal(), "confirm", { fetchImpl: async () => json(409, { error: "in_progress" }) })).toEqual({ kind: "updated", proposal: proposal({ status: "confirming" }) });
    expect(await postProposalAction(proposal(), "confirm", { fetchImpl: async () => json(410, { error: "expired" }) })).toEqual({ kind: "updated", proposal: proposal({ status: "expired" }) });
    expect(await postProposalAction(proposal(), "confirm", { fetchImpl: async () => json(404, { error: "not_found" }) })).toEqual({ kind: "updated", proposal: proposal({ status: "withdrawn" }) });
  });

  it("anything else is the card's error line: assignee_unavailable, 429, 503, the network (with its status and code, ui-8)", async () => {
    for (const [reply, status, error] of [
      [json(409, { error: "assignee_unavailable" }), 409, "assignee_unavailable"],
      [json(429, { error: "rate_limited" }), 429, "rate_limited"],
      [json(503, { error: "unavailable" }), 503, "unavailable"],
      [json(403, { error: "chat_off" }), 403, "chat_off"]
    ] as const) {
      expect(await postProposalAction(proposal(), "confirm", { fetchImpl: async () => reply })).toEqual({ kind: "failed", status, error });
    }
    expect(await postProposalAction(proposal(), "confirm", { fetchImpl: async () => Promise.reject(new TypeError("offline")) })).toEqual({ kind: "failed", status: 0, error: null });
  });

  it("ui-8: 409 not_pending confirmed (another tab) links the task when the route names it", async () => {
    const reply = json(409, { error: "not_pending", status: "confirmed", taskId: "t_mhmh1234_abcde" });
    expect(await postProposalAction(proposal(), "dismiss", { fetchImpl: async () => reply })).toEqual({
      kind: "updated", proposal: proposal({ status: "confirmed", taskHref: "/tasks/t_mhmh1234_abcde" })
    });
    const bare = json(409, { error: "not_pending", status: "confirmed" });
    expect(await postProposalAction(proposal(), "dismiss", { fetchImpl: async () => bare })).toEqual({ kind: "updated", proposal: proposal({ status: "confirmed" }) });
  });

  it("Dismiss posts to the dismiss route without the hash; 200 dismissed", async () => {
    const fetchImpl = vi.fn(async () => json(200, { status: "dismissed" }));
    expect(await postProposalAction(proposal(), "dismiss", { fetchImpl })).toEqual({ kind: "updated", proposal: proposal({ status: "dismissed" }) });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/exec/tasks/proposals/${proposal().id}/dismiss`);
    expect(String(init.body)).not.toContain(HASH);
  });
});
