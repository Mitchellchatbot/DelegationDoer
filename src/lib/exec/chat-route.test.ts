import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipal: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditStart: vi.fn(), auditFinish: vi.fn() }));
vi.mock("@/lib/exec/http", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/http")>()), rateLimit: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
// Area C's turn and Area A's store, at their module boundary.
vi.mock("@/lib/exec/agent/turn", () => ({ prepareChatTurn: vi.fn(), runPreparedTurn: vi.fn(), storedTurnPayload: vi.fn(), storedMessageViews: vi.fn() }));
vi.mock("@/lib/exec/chat-store", () => ({
  finishTurn: vi.fn(),
  loadConversation: vi.fn(),
  ChatStoreError: class ChatStoreError extends Error {
    readonly table: string;
    constructor(table: string, message: string) {
      super(message);
      this.table = table;
    }
  }
}));

import * as chatRoute from "@/app/api/exec/chat/route";
import * as conversationRoute from "@/app/api/exec/conversations/[id]/route";
import { requireExecPrincipal } from "@/lib/exec/access";
import { prepareChatTurn, runPreparedTurn, storedMessageViews, storedTurnPayload, type ChatTurnRequest, type PreparedTurn } from "@/lib/exec/agent/turn";
import type { AgentEventSink } from "@/lib/exec/agent/types";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import { ChatStoreError, finishTurn, loadConversation, type StoredTurn } from "@/lib/exec/chat-store";
import { FAILED_TEXT } from "@/lib/exec/chat/copy";
import type { ChatDonePayload, ChatMessageView } from "@/lib/exec/chat/view-types";
import { jsonError, rateLimit } from "@/lib/exec/http";
import { DEFAULT_SETTINGS, loadSettings, principalFromRows } from "@/lib/exec/principal";
import { AuditUnavailableError, type ExecSettings } from "@/lib/exec/types";

import { parseSseStrict, readBlocks, readSse } from "./__tests__/sse-frames";

// POST /api/exec/chat and GET /api/exec/conversations/:id (P5b contract §3.16.1, §3.16.2; tests 75-82, 84):
// the gate order, the body rules, every refusal's exact answer, the SSE frames (live, replay, a heartbeat,
// a disconnect, a throw after hello) and the conversation read. Area C's turn is mocked here; the
// recorded-fixture test (83) and 110 run the real turn and loop in chat-sse-fixture.test.ts.

const principal = principalFromRows(
  { id: "ep_owner", user_id: "u_owner", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
  { id: "u_owner", email: "owner@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
)!;
const CONV = `ecv_${"a".repeat(32)}`;
const TURN = `ect_${"b".repeat(32)}`;
const UMSG = `ecm_${"c".repeat(32)}`;
const AMSG = `ecm_${"d".repeat(32)}`;
const ATTENTION_ID = `ea_${"1".repeat(32)}`;
const URL_CHAT = "https://operations.scaledai.org/api/exec/chat";
const SAME = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
const OK_BODY = { clientTurnId: "client-turn-0001", text: "Who has overdue tasks?" };

const settings = (over: Partial<ExecSettings> = {}): ExecSettings => ({
  ...DEFAULT_SETTINGS, principalId: principal.id, chatSchemaReady: true, chatEnabled: true, ...over
});
const BEGIN: Extract<PreparedTurn, { kind: "started" }>["begin"] = {
  outcome: "started", conversationId: CONV, created: true, turnId: TURN, userMessageId: UMSG,
  userCreatedAt: "2026-11-07T15:00:00.000Z", assistantMessageId: AMSG, refSeq: 3, contextRef: null
};
const STARTED: PreparedTurn = { kind: "started", begin: BEGIN, context: null };
const DONE: ChatDonePayload = {
  messageId: AMSG, conversationId: CONV, turnId: TURN, conversationTitle: "Who has overdue tasks?", status: "complete", statusReason: null,
  answer: "Ann has two [r1].", recommendations: "- Ask Ann [r1]",
  sources: [{ n: 1, ref: "r1", source: { system: "dd", id: "tasks/t_1", url: "/tasks/t_1", label: "Fix the form", class: "internal" } }],
  cards: [], saved: true
};
const AUDIT = { status: "complete", statusReason: null, modelCalls: 2, toolCalls: 1, costUsd: 0.12 };

function chatReq(body: unknown, opts: { headers?: Record<string, string>; signal?: AbortSignal } = {}) {
  return new Request(URL_CHAT, {
    method: "POST",
    headers: opts.headers ?? SAME,
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: opts.signal
  });
}
const post = (body: unknown = OK_BODY, opts: { headers?: Record<string, string>; signal?: AbortSignal } = {}) => chatRoute.POST(chatReq(body, opts));
const answer = async (res: Response | Promise<Response>) => {
  const r = await res;
  return [r.status, await r.json()] as const;
};
const order = (...fns: unknown[]) => fns.map((f) => (f as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(requireExecPrincipal).mockResolvedValue({ ok: true, principal });
  vi.mocked(rateLimit).mockResolvedValue({ ok: true });
  vi.mocked(auditStart).mockResolvedValue(77);
  vi.mocked(auditFinish).mockResolvedValue(undefined);
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(prepareChatTurn).mockResolvedValue(STARTED);
  vi.mocked(runPreparedTurn).mockResolvedValue({ done: DONE, audit: AUDIT });
  vi.mocked(finishTurn).mockResolvedValue(true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the route files", () => {
  it("export only their handler and the route config", () => {
    expect(Object.keys(chatRoute).sort()).toEqual(["POST", "dynamic", "runtime"]);
    expect(Object.keys(conversationRoute).sort()).toEqual(["GET", "dynamic", "runtime"]);
    for (const m of [chatRoute, conversationRoute]) {
      expect(m.dynamic).toBe("force-dynamic");
      expect(m.runtime).toBe("nodejs");
    }
  });
});

// ---------------------------------------------------------------------------
// Test 75: the gate order
// ---------------------------------------------------------------------------

describe("POST /api/exec/chat: gate order (test 75)", () => {
  const later = () => [loadSettings, rateLimit, auditStart, prepareChatTurn, runPreparedTurn];
  const notCalled = (fns: unknown[]) => fns.forEach((f) => expect(f).not.toHaveBeenCalled());

  it("1. the gate, with the step-up, first: its own answer and nothing else runs", async () => {
    vi.mocked(requireExecPrincipal).mockResolvedValue({ ok: false, response: NextResponse.json({ error: "not found" }, { status: 404 }) });
    expect((await post()).status).toBe(404);
    expect(requireExecPrincipal).toHaveBeenCalledWith(expect.any(Request), "POST /api/exec/chat", { requireStrongSignIn: true });
    notCalled(later());
  });

  it.each([401, 503])("1. the gate's %i passes through", async (status) => {
    vi.mocked(requireExecPrincipal).mockResolvedValue({ ok: false, response: NextResponse.json({ error: "x" }, { status }) });
    expect((await post()).status).toBe(status);
    notCalled(later());
  });

  it("2. same origin: a cross-site POST → 403 forbidden, before the body or any read", async () => {
    expect(await answer(post(OK_BODY, { headers: { "sec-fetch-site": "cross-site", "content-type": "application/json" } }))).toEqual([403, { error: "forbidden" }]);
    expect(await answer(post(OK_BODY, { headers: { "content-type": "application/json" } }))).toEqual([403, { error: "forbidden" }]);
    notCalled(later());
  });

  it("3. a bad body → 400 before settings", async () => {
    expect((await post({ ...OK_BODY, extra: 1 })).status).toBe(400);
    notCalled(later());
  });

  it("4. chat off → 403 before the rate limit", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings({ chatEnabled: false }));
    expect(await answer(post())).toEqual([403, { error: "chat_off" }]);
    notCalled([rateLimit, auditStart, prepareChatTurn]);
  });

  it("5. the rate limit before the audit row; its read failure refuses there (loop-4: its 429 is advisory, see below)", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ ok: false, response: jsonError(503, "unavailable") });
    expect((await post()).status).toBe(503);
    notCalled([auditStart, prepareChatTurn]);
  });

  it("6. the audit row before prepare", async () => {
    vi.mocked(auditStart).mockRejectedValue(new AuditUnavailableError("down"));
    expect(await answer(post())).toEqual([503, { error: "audit_unavailable" }]);
    notCalled([prepareChatTurn, runPreparedTurn]);
  });

  it("all passing: gate → settings → rate → audit → prepare → run, in that order", async () => {
    const res = await post();
    await readSse(res);
    const [gate, s, rate, audit, prep, run] = order(requireExecPrincipal, loadSettings, rateLimit, auditStart, prepareChatTurn, runPreparedTurn);
    expect(gate).toBeLessThan(s);
    expect(s).toBeLessThan(rate);
    expect(rate).toBeLessThan(audit);
    expect(audit).toBeLessThan(prep);
    expect(prep).toBeLessThan(run);
    expect(rateLimit).toHaveBeenCalledWith(principal, "chat", 30, 600_000, { now: expect.any(Date) });
    expect(auditStart).toHaveBeenCalledWith(principal, {
      actor: "owner", action: "chat.turn", target: "exec_conversations:new",
      input: { conversationId: null, contextKind: null, textChars: OK_BODY.text.length }
    });
  });
});

// ---------------------------------------------------------------------------
// Test 76: the body
// ---------------------------------------------------------------------------

describe("POST /api/exec/chat: the body (test 76)", () => {
  it("> 16 KB → 413 too_large, the body never parsed", async () => {
    const big = JSON.stringify({ ...OK_BODY, text: "x".repeat(16_400) });
    expect(await answer(post(big))).toEqual([413, { error: "too_large" }]);
    expect(loadSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "{oops"],
    ["empty", ""],
    ["an array", "[]"],
    ["a string", '"hello"'],
    ["an unknown key", JSON.stringify({ ...OK_BODY, model: "x" })],
    ["a label smuggled in", JSON.stringify({ ...OK_BODY, label: "Acme" })],
    ["a malformed conversation id", JSON.stringify({ ...OK_BODY, conversationId: "ecv_123" })],
    ["a conversation id of another kind", JSON.stringify({ ...OK_BODY, conversationId: `ecm_${"a".repeat(32)}` })],
    ["a short client turn id", JSON.stringify({ ...OK_BODY, clientTurnId: "short" })],
    ["a client turn id with a space", JSON.stringify({ ...OK_BODY, clientTurnId: "client turn 0001" })],
    ["a 65-character client turn id", JSON.stringify({ ...OK_BODY, clientTurnId: "x".repeat(65) })],
    ["no client turn id", JSON.stringify({ text: "hi" })]
  ])("%s → 400 bad_request", async (_name, body) => {
    expect(await answer(post(body))).toEqual([400, { error: "bad_request" }]);
    expect(loadSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["only whitespace", " \r\n\t "],
    ["4,001 characters", "x".repeat(4001)],
    ["not a string", 42],
    ["missing", undefined],
    ["a NUL", `a${String.fromCharCode(0)}b`],
    ["a lone surrogate", `a${String.fromCharCode(0xd800)}b`]
  ])("text %s → 400 bad_text", async (_name, text) => {
    expect(await answer(post({ clientTurnId: OK_BODY.clientTurnId, ...(text === undefined ? {} : { text }) }))).toEqual([400, { error: "bad_text" }]);
    expect(loadSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown kind", { kind: "task", id: "t_1" }],
    ["a malformed attention id", { kind: "attention", id: "ea_123" }],
    ["a thread id with a space", { kind: "thread", id: "th 1" }],
    ["a thread id with a C0 control", { kind: "thread", id: `th${String.fromCharCode(1)}1` }],
    ["a thread id with a C1 control", { kind: "thread", id: `th${String.fromCharCode(0x9b)}1` }],
    ["a 201-character thread id", { kind: "thread", id: "t".repeat(201) }],
    ["a project id with a slash", { kind: "project", id: "p/1" }],
    ["a 101-character client id", { kind: "client", id: "c".repeat(101) }],
    ["a label", { kind: "client", id: "c_1", label: "Acme Dental" }],
    ["no id", { kind: "client" }],
    ["a string", "attention:ea_1"],
    ["an array", [{ kind: "client", id: "c_1" }]]
  ])("context %s → 400 bad_context", async (_name, context) => {
    expect(await answer(post({ ...OK_BODY, context }))).toEqual([400, { error: "bad_context" }]);
    expect(loadSettings).not.toHaveBeenCalled();
  });

  it("text is trimmed, CRLF and CR become LF; 4,000 characters pass; ids and the context reach prepare as given", async () => {
    await readSse(await post({ ...OK_BODY, conversationId: CONV, text: "  line one\r\nline two\rthree  ", context: { kind: "attention", id: ATTENTION_ID } }));
    const req = vi.mocked(prepareChatTurn).mock.calls[0][2] as ChatTurnRequest;
    expect(req).toEqual({ conversationId: CONV, clientTurnId: OK_BODY.clientTurnId, surface: "web", text: "line one\nline two\nthree", context: { kind: "attention", id: ATTENTION_ID } });
    vi.mocked(prepareChatTurn).mockClear();
    await readSse(await post({ ...OK_BODY, conversationId: null, text: "y".repeat(4000), context: null }));
    expect(vi.mocked(prepareChatTurn).mock.calls[0][2]).toMatchObject({ conversationId: null, text: "y".repeat(4000), context: null });
    for (const context of [{ kind: "thread", id: "AAMkAD-x=_y.z" }, { kind: "project", id: "p_site:2" }, { kind: "client", id: "c.acme_1" }]) {
      expect((await post({ ...OK_BODY, context })).status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests 77-78: settings, limits, the audit and prepare's refusals
// ---------------------------------------------------------------------------

describe("POST /api/exec/chat: settings, limits and refusals (tests 77, 78)", () => {
  it.each([
    ["the P5b schema missing", { chatSchemaReady: false, chatEnabled: false }],
    ["chat installed but off", { chatSchemaReady: true, chatEnabled: false }]
  ])("%s → 403 chat_off", async (_name, over) => {
    vi.mocked(loadSettings).mockResolvedValue(settings(over));
    expect(await answer(post())).toEqual([403, { error: "chat_off" }]);
  });

  it("a settings read failure → 503 unavailable, the error never echoed", async () => {
    vi.mocked(loadSettings).mockRejectedValue(new Error("exec_settings read failed: SECRET"));
    expect(await answer(post())).toEqual([503, { error: "unavailable" }]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
  });

  it("loop-4: at P5a's limit a NEW turn still reaches the begin RPC, whose exact 429 answers with its Retry-After", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ ok: false, response: jsonError(429, "rate_limited", { retryAfterSeconds: 42 }) });
    vi.mocked(prepareChatTurn).mockResolvedValue({ kind: "rate_limited", retryAfterSeconds: 41 });
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("41");
    expect(await res.json()).toEqual({ error: "rate_limited", retryAfterSeconds: 41 });
    expect(prepareChatTurn).toHaveBeenCalledTimes(1);
  });

  it("loop-4: at P5a's limit a retry of a turn still running gets 409 turn_in_progress (not 429)", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ ok: false, response: jsonError(429, "rate_limited", { retryAfterSeconds: 42 }) });
    vi.mocked(prepareChatTurn).mockResolvedValue({ kind: "busy", conversationId: CONV });
    expect(await answer(post())).toEqual([409, { error: "turn_in_progress", conversationId: CONV }]);
  });

  it("the limiter's count failure (503) passes through", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ ok: false, response: jsonError(503, "unavailable") });
    expect(await answer(post())).toEqual([503, { error: "unavailable" }]);
    expect(auditStart).not.toHaveBeenCalled();
  });

  it("429 from the begin RPC's exact count (C49) with its retryAfterSeconds", async () => {
    vi.mocked(prepareChatTurn).mockResolvedValue({ kind: "rate_limited", retryAfterSeconds: 17 });
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    expect(await res.json()).toEqual({ error: "rate_limited", retryAfterSeconds: 17 });
    expect(auditFinish).toHaveBeenCalledWith(77, { ok: false, result: { outcome: "rate_limited" } });
  });

  it("audit unavailable → 503 audit_unavailable and no prepare call", async () => {
    vi.mocked(auditStart).mockRejectedValue(new AuditUnavailableError("audit log unavailable"));
    expect(await answer(post())).toEqual([503, { error: "audit_unavailable" }]);
    expect(prepareChatTurn).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "context_unavailable", reason: "gone" } as PreparedTurn, 409, { error: "context_unavailable", reason: "gone" }],
    [{ kind: "context_unavailable", reason: "check_failed" } as PreparedTurn, 409, { error: "context_unavailable", reason: "check_failed" }],
    [{ kind: "not_found" } as PreparedTurn, 404, { error: "not_found" }],
    [{ kind: "busy" } as PreparedTurn, 409, { error: "turn_in_progress" }],
    [{ kind: "busy", conversationId: CONV } as PreparedTurn, 409, { error: "turn_in_progress", conversationId: CONV }],
    [{ kind: "busy_principal" } as PreparedTurn, 409, { error: "too_many_running" }]
  ])("prepare %o → %i, the audit row finished ok: false", async (prepared, status, body) => {
    vi.mocked(prepareChatTurn).mockResolvedValue(prepared);
    const res = await post({ ...OK_BODY, conversationId: CONV });
    expect([res.status, await res.json()]).toEqual([status, body]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(auditFinish).toHaveBeenCalledWith(77, { ok: false, result: { outcome: prepared.kind } });
    expect(runPreparedTurn).not.toHaveBeenCalled();
    expect(auditStart).toHaveBeenCalledWith(principal, expect.objectContaining({ target: `exec_conversations:${CONV}` }));
  });

  it("a DB error or prepare's own timeout → 503 unavailable, the audit row finished ok: false, nothing streamed", async () => {
    for (const err of [new ChatStoreError("exec_messages", "exec chat store: exec_chat_begin_turn failed: SECRET"), Object.assign(new Error("deadline"), { name: "TimeoutError" })]) {
      vi.mocked(auditFinish).mockClear();
      vi.mocked(prepareChatTurn).mockRejectedValueOnce(err);
      expect(await answer(post())).toEqual([503, { error: "unavailable" }]);
      expect(auditFinish).toHaveBeenCalledWith(77, { ok: false, result: { outcome: "unavailable" } });
    }
    expect(runPreparedTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
  });

  it("prepare gets its own 10 s timeout and never the request's signal (C55)", async () => {
    await readSse(await post());
    const call = vi.mocked(prepareChatTurn).mock.calls[0];
    expect(call[0]).toBe(principal);
    expect(call[1]).toEqual(settings());
    expect(call[3]).toBeInstanceOf(Date);
    expect(call[4]).toEqual({ timeoutMs: 10_000 });
    expect(call).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Tests 79-82: the stream
// ---------------------------------------------------------------------------

describe("POST /api/exec/chat: SSE live (test 79)", () => {
  it("the exact headers; hello first with the ids; text, tool and done frames; a heartbeat; close after done", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-11-07T15:00:00.000Z"));
    const gate = deferred();
    vi.mocked(runPreparedTurn).mockImplementation(async (_p, _s, _prep, _req, opts) => {
      const sink = opts.sink as AgentEventSink;
      sink.tool({ round: 1, callId: "1.0", name: "search_tasks", label: "Searching tasks", state: "running" });
      sink.tool({ round: 1, callId: "1.0", name: "search_tasks", label: "Searching tasks", state: "done" });
      sink.text(2, "Ann has ");
      sink.text(2, "two [r1].");
      await gate.promise;
      return { done: DONE, audit: AUDIT };
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers.entries())).toEqual({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "private, no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    const reader = res.body!.getReader();
    const carry = { text: "" };
    await readBlocks(reader, 5, carry);
    await vi.advanceTimersByTimeAsync(15_000);
    await readBlocks(reader, 6, carry);
    gate.resolve();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      carry.text += new TextDecoder().decode(value);
    }
    const read = parseSseStrict(carry.text);
    expect(read.sequence).toEqual([
      { event: "hello", data: { turnId: TURN, conversationId: CONV, messageId: AMSG, created: true } },
      { event: "tool", data: { round: 1, callId: "1.0", name: "search_tasks", label: "Searching tasks", state: "running" } },
      { event: "tool", data: { round: 1, callId: "1.0", name: "search_tasks", label: "Searching tasks", state: "done" } },
      { event: "text", data: { round: 2, delta: "Ann has " } },
      { event: "text", data: { round: 2, delta: "two [r1]." } },
      { event: ":", data: `ping ${Date.parse("2026-11-07T15:00:15.000Z")}` },
      { event: "done", data: DONE }
    ]);
    expect(vi.getTimerCount()).toBe(0);
    expect(auditFinish).toHaveBeenCalledWith(77, { ok: true, result: AUDIT });
  });

  it("the turn runs with the request's signal (linked), the sink, the request's time; the binding is the loop's default", async () => {
    const ac = new AbortController();
    const seen = deferred<AbortSignal>();
    const release = deferred();
    vi.mocked(runPreparedTurn).mockImplementation(async (_p, _s, prepared, req, opts) => {
      expect(prepared).toBe(STARTED);
      expect(req).toMatchObject({ clientTurnId: OK_BODY.clientTurnId, surface: "web" });
      expect(opts.binding).toBeUndefined();
      expect(opts.now).toBeInstanceOf(Date);
      seen.resolve(opts.signal);
      await release.promise;
      return { done: DONE, audit: AUDIT };
    });
    const res = await post(OK_BODY, { signal: ac.signal });
    const signal = await seen.promise;
    expect(signal.aborted).toBe(false);
    ac.abort();
    expect(signal.aborted).toBe(true);
    release.resolve();
    await readSse(res);
  });

  it("a failed turn's done is sent and the audit row finished ok: false (counts and codes only)", async () => {
    const failed = { ...DONE, status: "failed" as const, statusReason: "model_error", answer: FAILED_TEXT, recommendations: "", sources: [] };
    vi.mocked(runPreparedTurn).mockResolvedValue({ done: failed, audit: { ...AUDIT, status: "failed", statusReason: "model_error" } });
    const read = await readSse(await post());
    expect(read.frames.map((f) => f.event)).toEqual(["hello", "done"]);
    expect(read.frames[1].data).toEqual(failed);
    expect(auditFinish).toHaveBeenCalledWith(77, { ok: false, result: { ...AUDIT, status: "failed", statusReason: "model_error" } });
  });

  it("hello carries created: false for an existing conversation", async () => {
    vi.mocked(prepareChatTurn).mockResolvedValue({ kind: "started", begin: { ...BEGIN, created: false }, context: null });
    const read = await readSse(await post({ ...OK_BODY, conversationId: CONV }));
    expect(read.frames[0]).toEqual({ event: "hello", data: { turnId: TURN, conversationId: CONV, messageId: AMSG, created: false } });
  });
});

describe("POST /api/exec/chat: SSE replay (test 80)", () => {
  const STORED: StoredTurn = {
    turnId: TURN,
    user: { id: UMSG, role: "user", status: "complete", statusReason: null, text: "Who has overdue tasks?", recommendations: "", context: null, sources: [], cards: [], consultedEmailThreadIds: [], consultedClientIds: [], consultedDdText: false, createdAt: "2026-11-07T15:00:00.000Z", finishedAt: "2026-11-07T15:00:00.000Z", redactedAt: null },
    assistant: { id: AMSG, role: "assistant", status: "complete", statusReason: null, text: "Ann has two [r1].", recommendations: "", context: null, sources: [], cards: [], consultedEmailThreadIds: [], consultedClientIds: [], consultedDdText: false, createdAt: "2026-11-07T15:00:00.000Z", finishedAt: "2026-11-07T15:00:09.000Z", redactedAt: null }
  };
  const CONVERSATION = { id: CONV, surface: "web" as const, title: "Who has overdue tasks?", refSeq: 3, turnCount: 1, createdAt: "2026-11-07T15:00:00.000Z", lastMessageAt: "2026-11-07T15:00:00.000Z" };

  it("loop-4: at P5a's limit (the 30th question is the retried one) a retry of a stored turn gets 200 SSE hello + its done", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ ok: false, response: jsonError(429, "rate_limited", { retryAfterSeconds: 42 }) });
    vi.mocked(prepareChatTurn).mockResolvedValue({ kind: "replay", turn: STORED, conversation: CONVERSATION });
    vi.mocked(storedTurnPayload).mockResolvedValue(DONE);
    const res = await post({ ...OK_BODY, conversationId: CONV });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const read = await readSse(res);
    expect(read.frames.map((f) => f.event)).toEqual(["hello", "done"]);
    expect(read.frames[1].data).toEqual(DONE);
    expect(auditFinish).toHaveBeenCalledWith(77, { ok: true, result: { outcome: "replay" } });
  });

  it("hello + the stored done, then close; the turn never runs", async () => {
    vi.mocked(prepareChatTurn).mockResolvedValue({ kind: "replay", turn: STORED, conversation: CONVERSATION });
    vi.mocked(storedTurnPayload).mockResolvedValue(DONE);
    const res = await post({ ...OK_BODY, conversationId: CONV });
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const read = await readSse(res);
    expect(read.sequence).toEqual([
      { event: "hello", data: { turnId: TURN, conversationId: CONV, messageId: AMSG, created: false } },
      { event: "done", data: DONE }
    ]);
    expect(storedTurnPayload).toHaveBeenCalledWith(principal, CONVERSATION, STORED, expect.any(Date), { signal: expect.any(AbortSignal) });
    expect(runPreparedTurn).not.toHaveBeenCalled();
    expect(auditFinish).toHaveBeenCalledWith(77, { ok: true, result: { outcome: "replay" } });
  });

  it("a stored turn that can't be read → 503 unavailable (the client retries the same id)", async () => {
    vi.mocked(prepareChatTurn).mockResolvedValue({ kind: "replay", turn: STORED, conversation: CONVERSATION });
    vi.mocked(storedTurnPayload).mockRejectedValue(new Error("exec_task_proposals read failed: SECRET"));
    expect(await answer(post())).toEqual([503, { error: "unavailable" }]);
    expect(auditFinish).toHaveBeenCalledWith(77, { ok: false, result: { outcome: "unavailable" } });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
  });
});

describe("POST /api/exec/chat: a disconnect (test 81)", () => {
  it("the client leaving aborts the turn's signal; the turn's later writes are dropped without a throw", async () => {
    const after = deferred<{ textOk: boolean }>();
    vi.mocked(runPreparedTurn).mockImplementation(async (_p, _s, _prep, _req, opts) => {
      const sink = opts.sink as AgentEventSink;
      sink.text(1, "Part");
      await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
      let textOk = true;
      try {
        sink.text(1, " more");
        sink.tool({ round: 1, callId: "1.0", name: "get_task", label: "Reading the task", state: "error" });
        sink.retract();
      } catch {
        textOk = false;
      }
      after.resolve({ textOk });
      return { done: { ...DONE, status: "aborted", statusReason: "client_abort", answer: "Part", recommendations: "", sources: [] }, audit: { ...AUDIT, status: "aborted", statusReason: "client_abort" } };
    });
    const res = await post();
    const reader = res.body!.getReader();
    const text = await readBlocks(reader, 2);
    expect(parseSseStrict(text).frames.map((f) => f.event)).toEqual(["hello", "text"]);
    await reader.cancel();
    expect((await after.promise).textOk).toBe(true);
    await vi.waitFor(() => expect(auditFinish).toHaveBeenCalledWith(77, { ok: true, result: { ...AUDIT, status: "aborted", statusReason: "client_abort" } }));
  });

  it("the request's own abort (the platform's disconnect signal) aborts the turn too", async () => {
    const ac = new AbortController();
    const aborted = deferred<boolean>();
    vi.mocked(runPreparedTurn).mockImplementation(async (_p, _s, _prep, _req, opts) => {
      await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
      aborted.resolve(opts.signal.aborted);
      return { done: { ...DONE, status: "aborted", statusReason: "client_abort" }, audit: AUDIT };
    });
    const res = await post(OK_BODY, { signal: ac.signal });
    const reader = res.body!.getReader();
    await readBlocks(reader, 1);
    ac.abort();
    expect(await aborted.promise).toBe(true);
    await reader.cancel();
  });

  it("a request already aborted when the turn starts still runs it (C55), on an aborted signal", async () => {
    const ac = new AbortController();
    vi.mocked(prepareChatTurn).mockImplementation(async () => {
      ac.abort();
      return STARTED;
    });
    let wasAborted: boolean | null = null;
    vi.mocked(runPreparedTurn).mockImplementation(async (_p, _s, _prep, _req, opts) => {
      wasAborted = opts.signal.aborted;
      return { done: { ...DONE, status: "aborted", statusReason: "client_abort", answer: "" }, audit: AUDIT };
    });
    const read = await readSse(await post(OK_BODY, { signal: ac.signal }));
    expect(runPreparedTurn).toHaveBeenCalledTimes(1);
    expect(wasAborted).toBe(true);
    expect(read.frames.map((f) => f.event)).toEqual(["hello", "done"]);
  });
});

describe("POST /api/exec/chat: a throw after hello (test 82)", () => {
  it("error {code:internal}, no error text in the bytes, a best-effort failed finish on a fresh signal, close", async () => {
    const ac = new AbortController();
    vi.mocked(runPreparedTurn).mockImplementation(async (_p, _s, _prep, _req, opts) => {
      (opts.sink as AgentEventSink).text(1, "Partial");
      ac.abort();
      throw new Error("SECRET-TOKEN: column exec_messages.text broke");
    });
    const read = await readSse(await post(OK_BODY, { signal: ac.signal }));
    expect(read.sequence).toEqual([
      { event: "hello", data: { turnId: TURN, conversationId: CONV, messageId: AMSG, created: true } },
      { event: "text", data: { round: 1, delta: "Partial" } },
      { event: "error", data: { code: "internal" } }
    ]);
    expect(read.raw).not.toMatch(/SECRET|column|broke/);
    expect(finishTurn).toHaveBeenCalledTimes(1);
    const [p, input, opts] = vi.mocked(finishTurn).mock.calls[0];
    expect(p).toBe(principal);
    expect(input).toMatchObject({
      messageId: AMSG, status: "failed", statusReason: "internal", refusalCategory: null, text: FAILED_TEXT, recommendations: "",
      sources: [], cards: [], toolCalls: [], consultedEmailThreadIds: [], consultedClientIds: [], consultedDdText: false, refSeq: 3
    });
    expect(input.model).toBe("claude-opus-5-5");
    expect(input.usage).toMatchObject({ modelCalls: 0, toolCalls: 0, costUsd: 0, promptVersion: "exec-chat-v3" });
    // A fresh controller: not the request's (already aborted) signal.
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.signal.aborted).toBe(false);
    expect(auditFinish).toHaveBeenCalledWith(77, { ok: false, result: { status: "failed", statusReason: "internal" } });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/SECRET|column|broke/);
  });

  it("a failed finish that throws too still closes the stream", async () => {
    vi.mocked(runPreparedTurn).mockRejectedValue(new TypeError("x is undefined"));
    vi.mocked(finishTurn).mockRejectedValue(new ChatStoreError("exec_messages", "exec chat store: exec_chat_finish_turn failed: SECRET"));
    const read = await readSse(await post());
    expect(read.frames.map((f) => f.event)).toEqual(["hello", "error"]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
  });
});

// ---------------------------------------------------------------------------
// Test 84: GET /api/exec/conversations/:id
// ---------------------------------------------------------------------------

describe("GET /api/exec/conversations/:id (test 84)", () => {
  const BASE = "https://operations.scaledai.org/api/exec/conversations";
  const get = (id = CONV, headers: Record<string, string> = {}) => conversationRoute.GET(new Request(`${BASE}/${id}`, { headers }), { params: { id } });
  const CONVERSATION = { id: CONV, surface: "web" as const, title: "Who has overdue tasks?", refSeq: 9, turnCount: 3, createdAt: "2026-11-07T14:00:00.000Z", lastMessageAt: "2026-11-07T15:00:00.000Z" };
  const VIEWS: ChatMessageView[] = [
    { id: UMSG, turnId: TURN, role: "user", status: "complete", statusReason: null, text: "Who has overdue tasks?", recommendations: "", sources: [], cards: [], createdAt: "2026-11-07T15:00:00.000Z", finishedAt: "2026-11-07T15:00:00.000Z", redacted: false, contextKind: null },
    { id: AMSG, turnId: TURN, role: "assistant", status: "failed", statusReason: "stale", text: FAILED_TEXT, recommendations: "", sources: [], cards: [], createdAt: "2026-11-07T15:00:00.000Z", finishedAt: null, redacted: false, contextKind: null }
  ];

  beforeEach(() => {
    vi.mocked(loadConversation).mockResolvedValue({ conversation: CONVERSATION, turns: [], hasEarlier: true });
    vi.mocked(storedMessageViews).mockResolvedValue(VIEWS);
  });

  it("200 { conversation, messages, hasEarlier }: the view fields only (no ref_seq, no surface)", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["conversation", "hasEarlier", "messages"]);
    expect(body.conversation).toEqual({ id: CONV, title: "Who has overdue tasks?", createdAt: "2026-11-07T14:00:00.000Z", lastMessageAt: "2026-11-07T15:00:00.000Z", turnCount: 3 });
    expect(body.messages).toEqual(VIEWS);
    expect(body.hasEarlier).toBe(true);
    expect(loadConversation).toHaveBeenCalledWith(principal, CONV, { maxTurns: 100, surface: "web", signal: expect.any(AbortSignal) });
    expect(storedMessageViews).toHaveBeenCalledWith(principal, [], expect.any(Date), { signal: expect.any(AbortSignal) });
  });

  it("gates with the step-up; a refusal is the gate's own answer and nothing is read", async () => {
    vi.mocked(requireExecPrincipal).mockResolvedValue({ ok: false, response: NextResponse.json({ error: "not found" }, { status: 404 }) });
    expect((await get()).status).toBe(404);
    expect(requireExecPrincipal).toHaveBeenCalledWith(expect.any(Request), "GET /api/exec/conversations/:id", { requireStrongSignIn: true });
    expect(loadSettings).not.toHaveBeenCalled();
    expect(loadConversation).not.toHaveBeenCalled();
  });

  it.each(["ecv_123", `ecm_${"a".repeat(32)}`, `ecv_${"A".repeat(32)}`, "x"])("400 bad_request for the id %s", async (id) => {
    expect(await answer(get(id))).toEqual([400, { error: "bad_request" }]);
    expect(loadConversation).not.toHaveBeenCalled();
  });

  it("404 when P5b isn't installed (no read); chat merely off still reads his history", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings({ chatSchemaReady: false, chatEnabled: false }));
    expect(await answer(get())).toEqual([404, { error: "not_found" }]);
    expect(loadConversation).not.toHaveBeenCalled();
    vi.mocked(loadSettings).mockResolvedValue(settings({ chatEnabled: false }));
    expect((await get()).status).toBe(200);
  });

  it("404 not_found when the store has no such conversation of his", async () => {
    vi.mocked(loadConversation).mockResolvedValue(null);
    expect(await answer(get())).toEqual([404, { error: "not_found" }]);
    expect(storedMessageViews).not.toHaveBeenCalled();
  });

  it.each([
    ["the settings read", () => vi.mocked(loadSettings).mockRejectedValue(new Error("SECRET"))],
    ["the conversation read", () => vi.mocked(loadConversation).mockRejectedValue(new ChatStoreError("exec_messages", "exec chat store: exec_messages read failed: SECRET"))],
    ["the card read", () => vi.mocked(storedMessageViews).mockRejectedValue(new Error("exec_task_proposals read failed: SECRET"))]
  ])("503 unavailable when %s fails, the error never echoed", async (_name, fail) => {
    fail();
    expect(await answer(get())).toEqual([503, { error: "unavailable" }]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
  });

  it("a read: no same-origin check, no rate limit, no audit row", async () => {
    expect((await get(CONV, { "sec-fetch-site": "cross-site" })).status).toBe(200);
    expect(rateLimit).not.toHaveBeenCalled();
    expect(auditStart).not.toHaveBeenCalled();
  });
});
