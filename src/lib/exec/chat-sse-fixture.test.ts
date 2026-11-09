import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/lib/anthropic-client", () => ({ getAnthropic: vi.fn(), resetAnthropic: vi.fn() }));
vi.mock("@/lib/exec/llm/usage", () => ({ recordUsage: vi.fn(), assertWithinDailyCap: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/llm/binding-alert", () => ({ reportBindingTransformations: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipal: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditStart: vi.fn(), auditFinish: vi.fn(), auditEvent: vi.fn() }));
vi.mock("@/lib/exec/http", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/http")>()), rateLimit: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
// Area A's store: Area C's in-memory stand-in written from the frozen §3.3 (records every call's signal).
vi.mock("@/lib/exec/chat-store", async () => (await import("./agent/__tests__/fake-chat-db")).chatStoreModule(() => db.current as never));
// Area B's modules: Area C's contract stand-ins (bindings AM21); the tools are a fake executor.
vi.mock("@/lib/exec/agent/refs", async () => (await import("./agent/__tests__/fake-tools")).fakeRefsModule);
vi.mock("@/lib/exec/agent/serialize", async () => (await import("./agent/__tests__/fake-tools")).fakeSerializeModule);
vi.mock("@/lib/exec/agent/tool-defs", async () => (await import("./agent/__tests__/fake-tools")).fakeToolDefsModule);
vi.mock("@/lib/exec/agent/tools", () => ({ executeToolCall: vi.fn(), createTurnMemo: vi.fn() }));
vi.mock("@/lib/exec/agent/budget", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/agent/budget")>()), chatSpentTodayUsd: vi.fn() }));
vi.mock("@/lib/exec/drafts-store", async (orig) => (await import("./agent/__tests__/b-stub")).stubOnly(await orig(), ["purgeDraftsByIds"]));
vi.mock("@/lib/exec/attention-read", () => ({ listScreenedAttention: vi.fn(), getScreenedAttentionItem: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => (await import("./agent/__tests__/b-stub")).stubModule(await orig()));
vi.mock("@/lib/exec/email-store", async (orig) => (await import("./agent/__tests__/b-stub")).stubOnly(await orig(), ["getEmailThread", "listThreadScreenRows"]));
vi.mock("@/lib/exec/sources/mail", async (orig) => (await import("./agent/__tests__/b-stub")).stubOnly(await orig(), ["loadScreeningPolicy"]));

import * as chatRoute from "@/app/api/exec/chat/route";
import * as conversationRoute from "@/app/api/exec/conversations/[id]/route";
import { getAnthropic } from "@/lib/anthropic-client";
import { requireExecPrincipal } from "@/lib/exec/access";
import { chatSpentTodayUsd } from "@/lib/exec/agent/budget";
import { createTurnMemo, executeToolCall } from "@/lib/exec/agent/tools";
import { storedMessageViews } from "@/lib/exec/agent/turn";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import { FAILED_TEXT, REFUSED_TEXT } from "@/lib/exec/chat/copy";
import type { ChatDonePayload, ChatMessageView, ChatSseEvent } from "@/lib/exec/chat/view-types";
import { purgeDraftsByIds } from "@/lib/exec/drafts-store";
import { listThreadScreenRows } from "@/lib/exec/email-store";
import { rateLimit } from "@/lib/exec/http";
import { assertWithinDailyCap, recordUsage } from "@/lib/exec/llm/usage";
import { DEFAULT_SETTINGS, loadSettings, principalFromRows } from "@/lib/exec/principal";
import { listDepartments } from "@/lib/exec/sources/dd";
import { loadScreeningPolicy } from "@/lib/exec/sources/mail";
import type { ExecSettings } from "@/lib/exec/types";

import { blockStart, delta, messageStart, turnEvents, use, withResponse } from "./agent/__tests__/fake-anthropic";
import { FakeChatDb } from "./agent/__tests__/fake-chat-db";
import { fakeExecutor, fakeMemo } from "./agent/__tests__/fake-tools";
import { parseSseStrict, readBlocks, readSse, type SseRead } from "./__tests__/sse-frames";

// The recorded-fixture SSE test (P5b contract §5 test 83) and the route's real-turn tests (80, 81, 84, 110): the REAL
// route → prepareChatTurn → runPreparedTurn → runAgentTurn → callModel, over a fake SDK client that replays raw
// Messages API stream events, and Area C's in-memory chat store. The route's bytes go through Area E's
// createSseParser and chatReducer (when they're in the tree) and the final state must equal the stored row. No test
// calls a model.

const principal = principalFromRows(
  { id: "ep_owner", user_id: "u_mitchell", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
  { id: "u_mitchell", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
)!;
const SETTINGS: ExecSettings = { ...DEFAULT_SETTINGS, principalId: principal.id, chatEnabled: true, chatSchemaReady: true, chatDailyCapUsd: 9, dailyCostCapUsd: 15 };
const URL_CHAT = "https://operations.scaledai.org/api/exec/chat";
const SAME = { "sec-fetch-site": "same-origin", "content-type": "application/json" };

// Area E's pure transport and state (§3.19.3, §3.19.4), loaded only when present: this file must run while E builds.
type UiState = { conversationId: string | null; messages: ChatMessageView[]; live: unknown; pending: unknown; banner: unknown };
interface UiModules {
  chatReducer: (state: UiState, action: unknown) => UiState;
  createSseParser: (onEvent: (e: ChatSseEvent) => void) => { push(chunk: string): void; end(): void };
  /** Area E's starting state, when it exports one (else §3.19.3's empty state). */
  initialChatState: ((init: Record<string, unknown>) => UiState) | null;
}
const REDUCER_MODULE = "@/lib/exec/chat/reducer";
const PARSER_MODULE = "@/lib/exec/chat/sse-parse";
async function loadUi(): Promise<UiModules | null> {
  try {
    const [r, p] = (await Promise.all([import(/* @vite-ignore */ REDUCER_MODULE), import(/* @vite-ignore */ PARSER_MODULE)])) as [Record<string, unknown>, Record<string, unknown>];
    if (typeof r.chatReducer === "function" && typeof p.createSseParser === "function") {
      return {
        chatReducer: r.chatReducer as UiModules["chatReducer"],
        createSseParser: p.createSseParser as UiModules["createSseParser"],
        initialChatState: typeof r.initialChatState === "function" ? (r.initialChatState as UiModules["initialChatState"]) : null
      };
    }
  } catch {
    // not in the tree yet
  }
  return null;
}
const ui = await loadUi();

let fdb: FakeChatDb;
let n = 0;

/** A fake SDK client: each call streams its script; a "hang" script then waits for the call's signal and ends quietly
 *  (0.32.1's Stream ends without a throw when its signal aborts mid-body; callModel turns that into the abort). */
type Script = unknown[] | { hangAfter: unknown[] };
function fakeClient(scripts: Script[]) {
  let i = 0;
  const create = vi.fn((_body: Record<string, unknown>, opts: { signal?: AbortSignal } = {}) => {
    const s = scripts[Math.min(i, scripts.length - 1)];
    i++;
    async function* events() {
      for (const e of Array.isArray(s) ? s : s.hangAfter) yield e;
      if (!Array.isArray(s)) {
        await new Promise<void>((resolve) => {
          if (!opts.signal || opts.signal.aborted) return resolve();
          opts.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    }
    return withResponse(events());
  });
  vi.mocked(getAnthropic).mockResolvedValue({ messages: { create } } as never);
  return { create };
}

function body(text: string, over: Record<string, unknown> = {}) {
  n += 1;
  return { clientTurnId: `client-turn-${String(n).padStart(4, "0")}`, text, ...over };
}
const post = (b: Record<string, unknown>, signal?: AbortSignal) =>
  chatRoute.POST(new Request(URL_CHAT, { method: "POST", headers: SAME, body: JSON.stringify(b), signal }));
const getConversation = (id: string) => conversationRoute.GET(new Request(`https://operations.scaledai.org/api/exec/conversations/${id}`), { params: { id } });

const doneOf = (read: SseRead) => read.frames.find((f) => f.event === "done")?.data as ChatDonePayload;
const helloOf = (read: SseRead) => read.frames[0].data as { turnId: string; conversationId: string; messageId: string; created: boolean };

/** The stored assistant row of a turn, as the GET route and the chat page show it. */
async function storedView(conversationId: string, messageId: string): Promise<ChatMessageView> {
  const turns = fdb.turnsOf(conversationId);
  const views = await storedMessageViews(principal, turns, new Date(), {});
  const v = views.find((m) => m.id === messageId);
  if (!v) throw new Error("no stored view");
  return v;
}
const core = (m: Pick<ChatMessageView, "id" | "turnId" | "role" | "status" | "statusReason" | "text" | "recommendations" | "sources" | "cards">) => ({
  id: m.id, turnId: m.turnId, role: m.role, status: m.status, statusReason: m.statusReason, text: m.text, recommendations: m.recommendations,
  sources: m.sources, cards: m.cards
});
const doneCore = (d: ChatDonePayload) => ({
  id: d.messageId, turnId: d.turnId, role: "assistant" as const, status: d.status, statusReason: d.statusReason, text: d.answer,
  recommendations: d.recommendations, sources: d.sources, cards: d.cards
});

/** The bytes through Area E's parser (in uneven chunks, splitting frames) and reducer. */
function throughUi(m: UiModules, raw: string, clientTurnId: string, question: string) {
  let state: UiState =
    m.initialChatState?.({}) ?? ({ conversationId: null, title: null, messages: [], live: null, banner: null, context: null, pending: null } as UiState);
  state = m.chatReducer(state, { type: "send", clientTurnId, question, nowMs: 1 });
  const events: ChatSseEvent[] = [];
  const parser = m.createSseParser((e) => events.push(e));
  const sizes = [1, 7, 3, 64, 2, 19];
  for (let at = 0, k = 0; at < raw.length; k++) {
    const size = sizes[k % sizes.length];
    parser.push(raw.slice(at, at + size));
    at += size;
  }
  parser.end();
  for (const event of events) state = m.chatReducer(state, { type: "event", event, nowMs: 2 });
  return { state, events };
}

// The fixtures: raw stream events as the API sends them.
const TOOL_ROUND = turnEvents({ text: ["Let me look."], tools: [use("toolu_01", "search_tasks", { q: "overdue" })] });
const FINAL_ROUND = turnEvents({ text: ["Ann has two overdue tasks [r1]", " and [r999].", "\n\n**Suggested next steps**\n- Ask Ann about [r1]"] });
const REFUSAL_ROUND = turnEvents({ text: ["Sure, here is how to get in"], stopReason: "refusal", stopDetails: { type: "refusal", category: "cyber" }, thinking: false });
const ERROR_EVENTS = [
  messageStart(),
  blockStart(0, { type: "text", text: "" }),
  delta(0, { type: "text_delta", text: "Partial answer" }),
  { type: "error", error: { type: "overloaded_error", message: "Overloaded SECRET-UPSTREAM-TEXT" } }
];

const savedEnv = process.env.EXEC_ENABLED;
beforeEach(() => {
  process.env.EXEC_ENABLED = "true";
  fdb = new FakeChatDb();
  db.current = fdb;
  vi.mocked(requireExecPrincipal).mockResolvedValue({ ok: true, principal });
  vi.mocked(loadSettings).mockResolvedValue(SETTINGS);
  vi.mocked(rateLimit).mockResolvedValue({ ok: true });
  vi.mocked(auditStart).mockResolvedValue(9);
  vi.mocked(auditFinish).mockResolvedValue(undefined);
  vi.mocked(assertWithinDailyCap).mockResolvedValue({ spentUsd: 0, capUsd: 15 });
  vi.mocked(recordUsage).mockResolvedValue(undefined);
  vi.mocked(chatSpentTodayUsd).mockResolvedValue(0);
  vi.mocked(createTurnMemo).mockImplementation(() => fakeMemo());
  vi.mocked(executeToolCall).mockImplementation(fakeExecutor().executeToolCall);
  vi.mocked(listThreadScreenRows).mockResolvedValue(new Map());
  vi.mocked(loadScreeningPolicy).mockResolvedValue({ rules: [], hash: "h1" });
  vi.mocked(purgeDraftsByIds).mockResolvedValue(0);
  vi.mocked(listDepartments).mockResolvedValue([]);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  if (savedEnv === undefined) delete process.env.EXEC_ENABLED;
  else process.env.EXEC_ENABLED = savedEnv;
});

// ---------------------------------------------------------------------------
// Test 83: recorded fixtures → the route's bytes → parser → reducer = the stored row
// ---------------------------------------------------------------------------

describe("recorded-fixture SSE (test 83)", () => {
  it("a thinking + tool_use round, then a final round with markers and suggestions: the bytes, the done and the stored row agree", async () => {
    const fake = fakeClient([TOOL_ROUND, FINAL_ROUND]);
    const b = body("Who has overdue tasks?");
    const read = await readSse(await post(b));
    expect(fake.create).toHaveBeenCalledTimes(2);
    const hello = helloOf(read);
    expect(read.frames.map((f) => f.event)).toEqual(["hello", "text", "tool", "tool", "text", "text", "text", "done"]);
    expect(read.frames[0]).toEqual({ event: "hello", data: { turnId: hello.turnId, conversationId: hello.conversationId, messageId: hello.messageId, created: true } });
    expect(read.frames[1]).toEqual({ event: "text", data: { round: 1, delta: "Let me look." } });
    expect(read.frames.slice(2, 4).map((f) => f.data)).toEqual([
      { round: 1, callId: "1.0", name: "search_tasks", label: "Label search_tasks", state: "running" },
      { round: 1, callId: "1.0", name: "search_tasks", label: "Label search_tasks", state: "done" }
    ]);
    expect(read.frames.slice(4, 7).map((f) => (f.data as { round: number }).round)).toEqual([2, 2, 2]);

    const done = doneOf(read);
    expect(done).toMatchObject({ status: "complete", statusReason: null, answer: "Ann has two overdue tasks [r1] and .", recommendations: "- Ask Ann about [r1]", saved: true });
    expect(done.sources.map((s) => [s.n, s.ref])).toEqual([[1, "r1"]]);

    const stored = fdb.message(hello.messageId)!;
    expect(stored).toMatchObject({ status: "complete", statusReason: null, text: done.answer, recommendations: done.recommendations });
    expect(stored.finish?.toolCalls.map((t) => t.name)).toEqual(["search_tasks"]);
    // The stream's done is exactly what a reload (GET, the chat page) shows.
    expect(doneCore(done)).toEqual(core(await storedView(hello.conversationId, hello.messageId)));
    expect(auditFinish).toHaveBeenCalledWith(9, { ok: true, result: { status: "complete", statusReason: null, modelCalls: 2, toolCalls: 1, costUsd: expect.any(Number) } });
  });

  it("a mid-stream refusal: text, then retract, then the fixed refusal, stored refused", async () => {
    fakeClient([REFUSAL_ROUND]);
    const read = await readSse(await post(body("How do I get into his account?")));
    expect(read.frames.map((f) => f.event)).toEqual(["hello", "text", "retract", "done"]);
    expect(read.frames[2].data).toEqual({});
    const done = doneOf(read);
    expect(done).toMatchObject({ status: "refused", statusReason: "refusal", answer: REFUSED_TEXT, recommendations: "", sources: [] });
    const hello = helloOf(read);
    expect(fdb.message(hello.messageId)).toMatchObject({ status: "refused", statusReason: "refusal", text: REFUSED_TEXT });
    expect(fdb.message(hello.messageId)?.finish?.refusalCategory).toBe("cyber");
    expect(doneCore(done)).toEqual(core(await storedView(hello.conversationId, hello.messageId)));
  });

  it("an error event mid-stream: retract, the fixed failure, stored failed; the API's error text never in the bytes", async () => {
    fakeClient([ERROR_EVENTS]);
    const read = await readSse(await post(body("Catch me up")));
    expect(read.frames.map((f) => f.event)).toEqual(["hello", "text", "retract", "done"]);
    const done = doneOf(read);
    expect(done).toMatchObject({ status: "failed", statusReason: "model_error", answer: FAILED_TEXT });
    expect(read.raw).not.toMatch(/SECRET-UPSTREAM-TEXT|Overloaded|overloaded_error/);
    const hello = helloOf(read);
    expect(fdb.message(hello.messageId)).toMatchObject({ status: "failed", statusReason: "model_error", text: FAILED_TEXT });
    expect(doneCore(done)).toEqual(core(await storedView(hello.conversationId, hello.messageId)));
  });

  it.skipIf(ui === null)("through Area E's createSseParser and chatReducer: the final state equals the stored row, for every fixture", async () => {
    const m = ui as UiModules;
    for (const scripts of [[TOOL_ROUND, FINAL_ROUND], [REFUSAL_ROUND], [ERROR_EVENTS]]) {
      fakeClient(scripts);
      const b = body("A question");
      const res = await post(b);
      const raw = (await readSse(res)).raw;
      const { state, events } = throughUi(m, raw, b.clientTurnId, b.text);
      expect(events.map((e) => e.event)).toEqual(parseSseStrict(raw).frames.map((f) => f.event));
      const hello = events[0].data as { conversationId: string; messageId: string };
      expect(state.conversationId).toBe(hello.conversationId);
      expect(state.live).toBeNull();
      expect(state.pending).toBeNull();
      const last = state.messages.filter((x) => x.role === "assistant").at(-1)!;
      expect(core(last)).toEqual(core(await storedView(hello.conversationId, hello.messageId)));
    }
  });
});

// ---------------------------------------------------------------------------
// Test 80 (real turn): a replay never re-runs
// ---------------------------------------------------------------------------

describe("SSE replay through the real turn (test 80)", () => {
  it("the same client turn id again → hello + the stored done; callModel never called again", async () => {
    const fake = fakeClient([TOOL_ROUND, FINAL_ROUND]);
    const b = body("Who has overdue tasks?");
    const first = await readSse(await post(b));
    const hello = helloOf(first);
    expect(fake.create).toHaveBeenCalledTimes(2);

    for (const again of [{ ...b, conversationId: hello.conversationId }, b]) {
      const read = await readSse(await post(again));
      expect(read.frames.map((f) => f.event)).toEqual(["hello", "done"]);
      expect(read.frames[0].data).toEqual({ turnId: hello.turnId, conversationId: hello.conversationId, messageId: hello.messageId, created: false });
      expect(doneOf(read)).toEqual(doneOf(first));
    }
    expect(fake.create).toHaveBeenCalledTimes(2);
    expect(fdb.messages.filter((x) => x.role === "user")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test 81 (real turn): a disconnect mid-stream is stored as aborted
// ---------------------------------------------------------------------------

describe("a disconnect mid-stream through the real turn (test 81)", () => {
  const HANG = { hangAfter: [messageStart(), blockStart(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "Partial ans" })] };

  it.each([
    ["the reader cancels (the browser left)", "cancel"],
    ["the request's signal aborts", "abort"]
  ] as const)("%s → the model call aborts, the row is stored aborted with the streamed text, on its own signal", async (_name, how) => {
    fakeClient([HANG]);
    const ac = new AbortController();
    const res = await post(body("A long question"), ac.signal);
    const reader = res.body!.getReader();
    const text = await readBlocks(reader, 2);
    const hello = parseSseStrict(text).frames[0].data as { messageId: string };
    expect(parseSseStrict(text).frames[1]).toEqual({ event: "text", data: { round: 1, delta: "Partial ans" } });
    if (how === "cancel") await reader.cancel();
    else ac.abort();
    await vi.waitFor(() => expect(fdb.message(hello.messageId)?.status).toBe("aborted"));
    expect(fdb.message(hello.messageId)).toMatchObject({ statusReason: "client_abort", text: "Partial ans" });
    const finish = fdb.signals.find((s) => s.fn === "finishTurn")!;
    expect(finish.abortedAtCall).toBe(false);
    await vi.waitFor(() => expect(auditFinish).toHaveBeenCalledWith(9, expect.objectContaining({ ok: true, result: expect.objectContaining({ status: "aborted" }) })));
    if (how === "abort") await reader.cancel();
  });
});

// ---------------------------------------------------------------------------
// Test 110: the request's signal aborts during begin; begin's own timeout
// ---------------------------------------------------------------------------

describe("begin on its own controller (test 110, C55)", () => {
  it("the request aborts while beginTurn is in flight: begin completes, the stream opens, the row ends aborted with no model call", async () => {
    const fake = fakeClient([FINAL_ROUND]);
    const ac = new AbortController();
    const realBegin = fdb.beginTurn.bind(fdb);
    fdb.beginTurn = async (input, signal) => {
      ac.abort();
      await Promise.resolve();
      return realBegin(input, signal);
    };
    const read = await readSse(await post(body("Stop right away"), ac.signal));
    expect(read.frames.map((f) => f.event)).toEqual(["hello", "done"]);
    const hello = helloOf(read);
    expect(doneOf(read)).toMatchObject({ status: "aborted", statusReason: "client_abort", answer: "" });
    expect(fdb.message(hello.messageId)).toMatchObject({ status: "aborted", statusReason: "client_abort", text: "" });
    expect(fake.create).not.toHaveBeenCalled();
    const begin = fdb.signals.find((s) => s.fn === "beginTurn")!;
    expect(begin.abortedAtCall).toBe(false);
    expect(begin.signal?.aborted).toBe(false);
    expect(fdb.messages.some((x) => x.status === "running")).toBe(false);
  });

  it("a begin that runs past its own 10 s deadline → 503 unavailable, nothing streamed, no row left running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const fake = fakeClient([FINAL_ROUND]);
    let called!: () => void;
    const beginCalled = new Promise<void>((r) => (called = r));
    fdb.beginTurn = (_input, signal) =>
      new Promise((_resolve, reject) => {
        called();
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const pending = post(body("Slow database"));
    await beginCalled;
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;
    expect([res.status, await res.json()]).toEqual([503, { error: "unavailable" }]);
    expect(fake.create).not.toHaveBeenCalled();
    expect(fdb.messages).toEqual([]);
    expect(auditFinish).toHaveBeenCalledWith(9, { ok: false, result: { outcome: "unavailable" } });
  });
});

// ---------------------------------------------------------------------------
// Test 84 (real views): GET shows what was stored; a stale running answer as failed / stale
// ---------------------------------------------------------------------------

describe("GET /api/exec/conversations/:id through the real views (test 84)", () => {
  it("after a streamed turn: the GET's assistant message equals the stream's done", async () => {
    fakeClient([TOOL_ROUND, FINAL_ROUND]);
    const read = await readSse(await post(body("Who has overdue tasks?")));
    const hello = helloOf(read);
    const res = await getConversation(hello.conversationId);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { conversation: Record<string, unknown>; messages: ChatMessageView[]; hasEarlier: boolean };
    expect(json.conversation).toMatchObject({ id: hello.conversationId, turnCount: 1 });
    expect(json.messages.map((x) => x.role)).toEqual(["user", "assistant"]);
    expect(json.messages[0]).toMatchObject({ role: "user", text: "Who has overdue tasks?", contextKind: null });
    expect(core(json.messages[1])).toEqual(doneCore(doneOf(read)));
    expect(json.hasEarlier).toBe(false);
  });

  it("a running answer older than 600 s is shown failed / stale; a younger one stays running", async () => {
    const conv = fdb.addConversation();
    const turn = fdb.seedTurn(conv.id, { text: "Old question" }, { status: "running", text: "" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(turn.assistant!.createdAt) + 601_000);
    let json = (await (await getConversation(conv.id)).json()) as { messages: ChatMessageView[] };
    expect(json.messages[1]).toMatchObject({ status: "failed", statusReason: "stale", text: FAILED_TEXT, finishedAt: null });
    vi.setSystemTime(Date.parse(turn.assistant!.createdAt) + 30_000);
    json = (await (await getConversation(conv.id)).json()) as { messages: ChatMessageView[] };
    expect(json.messages[1]).toMatchObject({ status: "running" });
  });
});
