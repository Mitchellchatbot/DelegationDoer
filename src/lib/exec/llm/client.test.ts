import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/anthropic-client", () => ({ getAnthropic: vi.fn(), resetAnthropic: vi.fn() }));
vi.mock("@/lib/exec/llm/usage", () => ({ recordUsage: vi.fn(), assertWithinDailyCap: vi.fn() }));

import { getAnthropic, resetAnthropic } from "@/lib/anthropic-client";
import { principalFromRows } from "@/lib/exec/principal";
import { BudgetExceededError, NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";
import { LlmCallError, callModel, classifyLlmError, type CallModelInput } from "@/lib/exec/llm/client";
import { costUsd } from "@/lib/exec/llm/models";
import {
  ExecRequestShapeError,
  THINKING_BINDING_BETA,
  buildExecRequest,
  type ExecRequestParams,
  type ExecToolDef
} from "@/lib/exec/llm/request";
import { LlmProtocolError, StreamEventError } from "@/lib/exec/llm/stream";
import { assertWithinDailyCap, recordUsage } from "@/lib/exec/llm/usage";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const principal: ExecPrincipal = principalFromRows(
  { id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
  { id: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
)!;

const tool: ExecToolDef = {
  name: "get_local_time",
  description: "Current local time in an IANA zone.",
  input_schema: { type: "object", properties: { timezone: { type: "string" } }, required: ["timezone"], additionalProperties: false },
  strict: true
};

const chatRequest = buildExecRequest({ feature: "chat", system: "You are the assistant.", messages: [{ role: "user", content: "Hi" }] });
const triageRequest = buildExecRequest({ feature: "triage", system: "Classify.", messages: [{ role: "user", content: "Email..." }] });

const SIGNATURE = "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds+/w==";
const START_USAGE = { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function messageStart(model = "claude-opus-5-5") {
  return {
    type: "message_start",
    message: { id: "msg_c1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: START_USAGE }
  };
}

function textEvents(stopReason = "end_turn", extraDelta: Record<string, unknown> = {}): Record<string, unknown>[] {
  return [
    messageStart(),
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: SIGNATURE } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " there." } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null, ...extraDelta }, usage: { output_tokens: 40 } },
    { type: "message_stop" }
  ];
}

const FINAL_USAGE = { ...START_USAGE, output_tokens: 40 };

const triageMessage = {
  id: "msg_t1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "text", text: '{"urgency":"high"}' }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 300, output_tokens: 20 }
};

async function* iterate(list: unknown[]): AsyncGenerator<unknown> {
  for (const e of list) yield e;
}

/** What 0.32.1's APIPromise offers: withResponse() → { data, response }. */
function withResponse(data: unknown, requestId: string | null = "req_fake") {
  return {
    withResponse: async () => ({ data, response: { headers: new Headers(requestId ? { "request-id": requestId } : {}) } })
  };
}

type CreateImpl = (body: Record<string, unknown>, options: Record<string, unknown>) => unknown;

function fakeClient(impl: CreateImpl) {
  const create = vi.fn(impl);
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

function useClients(...clients: Anthropic[]): void {
  const mock = vi.mocked(getAnthropic);
  for (const c of clients) mock.mockResolvedValueOnce(c);
}

function input(overrides: Partial<CallModelInput> = {}): CallModelInput {
  return { principal, feature: "chat", request: chatRequest, ...overrides };
}

function apiError(status: number, type: string, requestId = "req_err"): Error {
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { type, message: `${type} happened` } },
    undefined,
    { "request-id": requestId }
  );
}

const savedEnv = process.env.EXEC_ENABLED;

beforeEach(() => {
  process.env.EXEC_ENABLED = "true";
  vi.mocked(getAnthropic).mockReset();
  vi.mocked(resetAnthropic).mockReset();
  vi.mocked(assertWithinDailyCap).mockReset().mockResolvedValue({ spentUsd: 0, capUsd: 15 });
  vi.mocked(recordUsage).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.EXEC_ENABLED;
  else process.env.EXEC_ENABLED = savedEnv;
});

// ---------------------------------------------------------------------------
// Gates that must stop a call before any API traffic
// ---------------------------------------------------------------------------

describe("callModel gates", () => {
  it.each([undefined, "false", "TRUE", "1"])("refuses while EXEC_ENABLED is %s", async (value) => {
    if (value === undefined) delete process.env.EXEC_ENABLED;
    else process.env.EXEC_ENABLED = value;
    const err = await callModel(input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(classifyLlmError(err)).toBe("fatal");
    expect(getAnthropic).not.toHaveBeenCalled();
    expect(assertWithinDailyCap).not.toHaveBeenCalled();
  });

  it("rejects a malformed request before the budget check or any API call, flag on or off", async () => {
    const bad = { ...chatRequest, temperature: 0.7 } as unknown as ExecRequestParams;
    await expect(callModel(input({ request: bad }))).rejects.toBeInstanceOf(ExecRequestShapeError);
    delete process.env.EXEC_ENABLED;
    await expect(callModel(input({ request: bad }))).rejects.toBeInstanceOf(ExecRequestShapeError);
    expect(assertWithinDailyCap).not.toHaveBeenCalled();
    expect(getAnthropic).not.toHaveBeenCalled();
  });

  it("checks the principal's cap, and makes no call once it is spent", async () => {
    const spent = new BudgetExceededError(15.2, 15);
    vi.mocked(assertWithinDailyCap).mockRejectedValue(spent);
    await expect(callModel(input())).rejects.toBe(spent);
    expect(assertWithinDailyCap).toHaveBeenCalledWith(principal);
    expect(getAnthropic).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("lets a failed budget read propagate unchanged (fail closed)", async () => {
    const readFailure = new Error("exec_ai_usage read failed: timeout");
    vi.mocked(assertWithinDailyCap).mockRejectedValue(readFailure);
    await expect(callModel(input())).rejects.toBe(readFailure);
    expect(getAnthropic).not.toHaveBeenCalled();
  });

  it.each([
    ["skipBudgetCheck", { skipBudgetCheck: true }],
    ["no principal", { principal: null }]
  ] as const)("skips the cap check with %s", async (_label, overrides) => {
    const { client } = fakeClient(() => withResponse(iterate(textEvents())));
    useClients(client);
    await callModel(input(overrides));
    expect(assertWithinDailyCap).not.toHaveBeenCalled();
  });

  it("throws the caller's abort reason when the signal is already aborted, calling nothing", async () => {
    const controller = new AbortController();
    const reason = new Error("job lease lost");
    controller.abort(reason);
    await expect(callModel(input({ signal: controller.signal }))).rejects.toBe(reason);
    expect(assertWithinDailyCap).not.toHaveBeenCalled();
    expect(getAnthropic).not.toHaveBeenCalled();
  });

  it("wraps a non-Error abort reason in an AbortError", async () => {
    const controller = new AbortController();
    controller.abort("client went away");
    const err = await callModel(input({ signal: controller.signal })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
    expect((err as DOMException).message).toBe("client went away");

    const other = new AbortController();
    other.abort({ code: 7 });
    const err2 = await callModel(input({ signal: other.signal })).catch((e: unknown) => e);
    expect(err2).toMatchObject({ name: "AbortError", message: "This operation was aborted" });
  });

  it("stops with the caller's abort reason when it aborts during the budget check, building no client", async () => {
    const controller = new AbortController();
    const reason = new Error("client went away");
    vi.mocked(assertWithinDailyCap).mockImplementation(async () => {
      controller.abort(reason);
      return { spentUsd: 0, capUsd: 15 };
    });
    await expect(callModel(input({ signal: controller.signal }))).rejects.toBe(reason);
    expect(getAnthropic).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Successful calls
// ---------------------------------------------------------------------------

describe("callModel success", () => {
  it("streams a chat call: assembled message, cost, latency, request id and a usage row", async () => {
    const { client, create } = fakeClient(() => withResponse(iterate(textEvents()), "req_123"));
    useClients(client);
    const deltas: [string, number][] = [];
    const result = await callModel(input({ onTextDelta: (t, i) => deltas.push([t, i]) }));

    expect(result.message.content).toEqual([
      { type: "thinking", thinking: "", signature: SIGNATURE },
      { type: "text", text: "Hello there." }
    ]);
    expect(result.refused).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.requestId).toBe("req_123");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.costUsd).toBeCloseTo(costUsd("claude-opus-5-5", FINAL_USAGE), 12);
    expect(deltas).toEqual([
      ["Hello", 1],
      [" there.", 1]
    ]);

    const [body, options] = create.mock.calls[0];
    expect(body).toEqual({ ...chatRequest, stream: true });
    expect(options).toEqual({});
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith({
      principalId: "ep_1",
      feature: "chat",
      model: "claude-opus-5-5",
      usage: FINAL_USAGE,
      latencyMs: result.latencyMs,
      stopReason: "end_turn",
      requestId: "req_123"
    });
  });

  it("defaults triage to a non-streamed call and reads the JSON message", async () => {
    const { client, create } = fakeClient(async () => triageMessage);
    useClients(client);
    const result = await callModel(input({ feature: "triage", request: triageRequest }));
    expect(create.mock.calls[0][0]).toMatchObject({ stream: false, model: "claude-haiku-5-5" });
    expect(result.message.content).toEqual(triageMessage.content);
    // A plain promise (no withResponse) has no request id to offer.
    expect(result.requestId).toBeNull();
    expect(result.costUsd).toBeCloseTo((300 * 0.1 + 20 * 0.5) / 1e6, 12);
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ feature: "triage", model: "claude-haiku-5-5", requestId: null }));
  });

  it.each(["chat", "draft", "brief", "voice"] as const)("streams %s by default", async (feature) => {
    const { client, create } = fakeClient(() => withResponse(iterate(textEvents())));
    useClients(client);
    await callModel(input({ feature }));
    expect(create.mock.calls[0][0]).toMatchObject({ stream: true });
  });

  it.each(["triage", "digest", "spike"] as const)("does not stream %s by default", async (feature) => {
    const { client, create } = fakeClient(async () => triageMessage);
    useClients(client);
    await callModel(input({ feature }));
    expect(create.mock.calls[0][0]).toMatchObject({ stream: false });
  });

  it("lets `stream` override the feature default both ways", async () => {
    const a = fakeClient(async () => ({ ...triageMessage, model: "claude-opus-5-5" }));
    useClients(a.client);
    await callModel(input({ stream: false }));
    expect(a.create.mock.calls[0][0]).toMatchObject({ stream: false });

    const b = fakeClient(() => withResponse(iterate(textEvents())));
    useClients(b.client);
    await callModel(input({ feature: "triage", request: triageRequest, stream: true }));
    expect(b.create.mock.calls[0][0]).toMatchObject({ stream: true });
  });

  it("adds the thinking-binding beta whenever block_binding is set, merged and de-duplicated", async () => {
    const bound = buildExecRequest({
      feature: "chat",
      system: "s",
      messages: [{ role: "user", content: "Hi" }],
      tools: [tool],
      thinkingBinding: "error"
    });
    const { client, create } = fakeClient(() => withResponse(iterate(textEvents())));
    useClients(client);
    await callModel(input({ request: bound, betas: ["some-beta-2026-01-01", THINKING_BINDING_BETA] }));
    expect(create.mock.calls[0][1]).toEqual({
      headers: { "anthropic-beta": `some-beta-2026-01-01,${THINKING_BINDING_BETA}` }
    });

    const plain = fakeClient(() => withResponse(iterate(textEvents())));
    useClients(plain.client);
    await callModel(input({ request: bound }));
    expect(plain.create.mock.calls[0][1]).toEqual({ headers: { "anthropic-beta": THINKING_BINDING_BETA } });
  });

  it("passes the signal and maxRetries to the SDK", async () => {
    const controller = new AbortController();
    const { client, create } = fakeClient(() => withResponse(iterate(textEvents())));
    useClients(client);
    await callModel(input({ signal: controller.signal, maxRetries: 0 }));
    expect(create.mock.calls[0][1]).toEqual({ signal: controller.signal, maxRetries: 0 });
  });

  it("flags a refusal and still records its usage", async () => {
    const { client } = fakeClient(() =>
      withResponse(iterate(textEvents("refusal", { stop_details: { type: "refusal", category: "bio", explanation: null } })))
    );
    useClients(client);
    const result = await callModel(input());
    expect(result.refused).toBe(true);
    expect(result.message.stop_details).toEqual({ type: "refusal", category: "bio", explanation: null });
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ stopReason: "refusal", usage: FINAL_USAGE }));
  });

  it("keeps going when onTextDelta throws: logs once, stops forwarding, returns the full message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client } = fakeClient(() => withResponse(iterate(textEvents())));
    useClients(client);
    const sink = vi.fn(() => {
      throw new Error("SSE connection closed");
    });
    const result = await callModel(input({ onTextDelta: sink }));
    expect(sink).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][1])).toContain("SSE connection closed");
    expect(result.message.content[1]).toEqual({ type: "text", text: "Hello there." });
  });

  // An async sink (a stream writer's write()) fails by rejecting. Left
  // unwatched, each rejection would be an unhandled one, and an unhandled
  // rejection fails the whole Vitest run (dangerouslyIgnoreUnhandledErrors is
  // off), so these tests catch that even apart from their assertions.
  it("drops an async sink at its first rejection: one warning, nothing unhandled, the full message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client } = fakeClient(() => withResponse(iterate(textEvents())));
    useClients(client);
    const sink = vi.fn(async () => {
      throw new Error("SSE writer closed");
    });
    const result = await callModel(input({ onTextDelta: sink }));
    expect(sink).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][1])).toContain("SSE writer closed");
    expect(result.message.content[1]).toEqual({ type: "text", text: "Hello there." });
  });

  it("catches every rejection of an async sink that fails late, warning once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client } = fakeClient(() => withResponse(iterate(textEvents())));
    useClients(client);
    const sink = vi.fn(
      () => new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("client disconnected")), 5))
    );
    const result = await callModel(input({ onTextDelta: sink }));
    // Both deltas went out before either write failed.
    expect(sink).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][1])).toContain("client disconnected");
    expect(result.message.content[1]).toEqual({ type: "text", text: "Hello there." });
  });

  it.each(["max_tokens", "model_context_window_exceeded"])("flags a %s stop as truncated, records it and warns", async (stop) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { client } = fakeClient(() => withResponse(iterate(textEvents(stop)), "req_short"));
    useClients(client);
    const result = await callModel(input());
    expect(result.truncated).toBe(true);
    expect(result.refused).toBe(false);
    expect(result.message.content[1]).toEqual({ type: "text", text: "Hello there." });
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ stopReason: stop, usage: FINAL_USAGE }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(
      new RegExp(`chat: stopped at ${stop} \\(max_tokens 16000, output_tokens 40, request req_short\\)`)
    );
  });

  it("warns when the message carries unapplied deltas (and so must not be replayed)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const events = textEvents();
    events.splice(6, 0, { type: "content_block_delta", index: 1, delta: { type: "brand_new_delta", x: 1 } });
    const { client } = fakeClient(() => withResponse(iterate(events), "req_w"));
    useClients(client);
    const result = await callModel(input());
    expect(result.message.unknownDeltas).toBe(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/1 unapplied stream events.*req_w/);
  });

  it("prices by the requested model when the response names one it can't price", async () => {
    const { client } = fakeClient(async () => ({ ...triageMessage, model: "claude-haiku-5-5-20261101" }));
    useClients(client);
    const result = await callModel(input({ feature: "triage", request: triageRequest }));
    expect(result.costUsd).toBeCloseTo(costUsd("claude-haiku-5-5", triageMessage.usage), 12);
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-haiku-5-5" }));
  });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe("callModel failures", () => {
  it("resets the cached client after a 401 and retries exactly once", async () => {
    const stale = fakeClient(async () => {
      throw apiError(401, "authentication_error");
    });
    const fresh = fakeClient(() => withResponse(iterate(textEvents()), "req_after_reset"));
    useClients(stale.client, fresh.client);
    const result = await callModel(input());
    expect(resetAnthropic).toHaveBeenCalledTimes(1);
    expect(stale.create).toHaveBeenCalledTimes(1);
    expect(fresh.create).toHaveBeenCalledTimes(1);
    expect(result.requestId).toBe("req_after_reset");
  });

  it("gives up after the second 401 with an auth-class LlmCallError", async () => {
    const a = fakeClient(async () => {
      throw apiError(401, "authentication_error", "req_a");
    });
    const b = fakeClient(async () => {
      throw apiError(401, "authentication_error", "req_b");
    });
    useClients(a.client, b.client);
    const err = await callModel(input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmCallError);
    expect(err).toMatchObject({ status: 401, errorClass: "auth", errorType: "authentication_error", requestId: "req_b" });
    expect(resetAnthropic).toHaveBeenCalledTimes(1);
    expect(getAnthropic).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401 after the caller aborted: reports the abort, and logs the 401 it raced", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const controller = new AbortController();
    const unauthorized = apiError(401, "authentication_error", "req_late_401");
    const { client, create } = fakeClient(async () => {
      controller.abort();
      throw unauthorized;
    });
    useClients(client);
    const err = await callModel(input({ signal: controller.signal })).catch((e: unknown) => e);
    // One identity for a cancelled call, so callers can test `err === signal.reason`.
    expect(err).toBe(controller.signal.reason);
    expect((err as DOMException).name).toBe("AbortError");
    expect(resetAnthropic).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(recordUsage).not.toHaveBeenCalled();
    // The 401 isn't lost: a stale key would otherwise go unseen until the next call.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/chat: aborted by the caller.*401 authentication_error.*req_late_401/);
  });

  it.each([
    [400, "invalid_request_error", "fatal"],
    [402, "billing_error", "fatal"],
    [404, "not_found_error", "fatal"],
    [413, "request_too_large", "fatal"],
    [422, "invalid_request_error", "fatal"],
    [403, "permission_error", "auth"],
    [408, "timeout_error", "retryable"],
    [409, "api_error", "retryable"],
    [425, "api_error", "retryable"],
    [429, "rate_limit_error", "retryable"],
    [500, "api_error", "retryable"],
    [503, "api_error", "retryable"],
    [529, "overloaded_error", "retryable"]
  ] as const)("maps HTTP %i (%s) to %s", async (status, type, expected) => {
    const { client } = fakeClient(async () => {
      throw apiError(status, type, `req_${status}`);
    });
    useClients(client);
    const err = await callModel(input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmCallError);
    expect(err).toMatchObject({ status, errorClass: expected, errorType: type, requestId: `req_${status}` });
    expect((err as LlmCallError).cause).toBeInstanceOf(Anthropic.APIError);
    expect((err as LlmCallError).message).toContain(String(status));
    // Nothing streamed, so nothing was billed or recorded.
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("maps network failures and timeouts to retryable with no status", async () => {
    for (const thrown of [
      new Anthropic.APIConnectionError({ message: "Connection error.", cause: new TypeError("fetch failed") }),
      new Anthropic.APIConnectionTimeoutError(),
      new TypeError("fetch failed"),
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })
    ]) {
      const { client } = fakeClient(async () => {
        throw thrown;
      });
      useClients(client);
      const err = await callModel(input()).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: "LlmCallError", status: null, errorClass: "retryable" });
    }
  });

  it("clips a long error message for exec_jobs.last_error", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("x".repeat(2000));
    });
    useClients(client);
    const err = (await callModel(input()).catch((e: unknown) => e)) as LlmCallError;
    const detail = err.message.slice(err.message.indexOf(": ") + 2);
    expect(detail).toHaveLength(500);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("passes an LlmCallError through unchanged", async () => {
    const already = new LlmCallError("already classified", { status: 503, errorClass: "retryable", requestId: "req_x" });
    vi.mocked(getAnthropic).mockRejectedValueOnce(already);
    await expect(callModel(input())).rejects.toBe(already);
  });

  it("wraps a failure to build the client (key unavailable) as retryable", async () => {
    vi.mocked(getAnthropic).mockRejectedValueOnce(new Error("Supabase Vault read failed: timeout"));
    const err = await callModel(input()).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "LlmCallError", errorClass: "retryable" });
    expect((err as Error).message).toContain("Vault");
  });

  it("refuses a streaming response that isn't an event stream", async () => {
    const { client } = fakeClient(() => withResponse({ not: "a stream" }));
    useClients(client);
    const err = await callModel(input()).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "LlmCallError", errorClass: "retryable" });
    expect((err as LlmCallError).cause).toBeInstanceOf(LlmProtocolError);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("refuses a non-streamed body that isn't a message", async () => {
    const { client } = fakeClient(async () => ({ type: "error", error: { type: "api_error" } }));
    useClients(client);
    const err = await callModel(input({ feature: "triage", request: triageRequest })).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "LlmCallError", errorClass: "retryable" });
  });

  it("treats a stream that ends before message_stop as retryable, recording the partial usage", async () => {
    const { client } = fakeClient(() => withResponse(iterate(textEvents().slice(0, 6)), "req_cut"));
    useClients(client);
    const err = await callModel(input()).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "LlmCallError", errorClass: "retryable", requestId: "req_cut" });
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: "error", usage: START_USAGE, requestId: "req_cut", principalId: "ep_1" })
    );
  });

  it("classifies a mid-stream error event by its type and records what was billed", async () => {
    const events = [...textEvents().slice(0, 6), { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }];
    const { client } = fakeClient(() => withResponse(iterate(events), "req_mid"));
    useClients(client);
    const err = await callModel(input()).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "LlmCallError", status: 529, errorClass: "retryable", errorType: "overloaded_error", requestId: "req_mid" });
    expect((err as LlmCallError).cause).toBeInstanceOf(StreamEventError);
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ stopReason: "error" }));
  });

  it("rethrows the caller's abort unchanged when the stream stops early because of it", async () => {
    const controller = new AbortController();
    // Mimic 0.32.1: an aborted Stream just ends, without throwing.
    async function* abortedStream(): AsyncGenerator<unknown> {
      yield messageStart();
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      controller.abort();
    }
    const { client } = fakeClient(() => withResponse(abortedStream()));
    useClients(client);
    const err = await callModel(input({ signal: controller.signal })).catch((e: unknown) => e);
    expect(err).toBe(controller.signal.reason);
    expect((err as DOMException).name).toBe("AbortError");
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ stopReason: "aborted", usage: START_USAGE }));
  });

  it("returns a stream that completed even if the caller aborted right after", async () => {
    const controller = new AbortController();
    async function* finishedThenAborted(): AsyncGenerator<unknown> {
      yield* iterate(textEvents());
      controller.abort();
    }
    const { client } = fakeClient(() => withResponse(finishedThenAborted()));
    useClients(client);
    const result = await callModel(input({ signal: controller.signal }));
    expect(result.message.stop_reason).toBe("end_turn");
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ stopReason: "end_turn" }));
  });
});

// ---------------------------------------------------------------------------
// classifyLlmError on its own
// ---------------------------------------------------------------------------

describe("classifyLlmError", () => {
  it("lets a class carried on the error win", () => {
    expect(classifyLlmError(new NonRetryableError("no", "auth"))).toBe("auth");
    expect(classifyLlmError(new NonRetryableError("no"))).toBe("fatal");
    expect(classifyLlmError(new LlmCallError("x", { status: 500, errorClass: "fatal" }))).toBe("fatal");
    expect(classifyLlmError(new ExecRequestShapeError(["bad"]))).toBe("fatal");
  });

  it("treats a spent budget as fatal and a broken stream as retryable", () => {
    expect(classifyLlmError(new BudgetExceededError(20, 15))).toBe("fatal");
    expect(classifyLlmError(new LlmProtocolError("cut short", null))).toBe("retryable");
  });

  it("maps stream error event types like their HTTP statuses", () => {
    expect(classifyLlmError(new StreamEventError("overloaded_error", "x", null))).toBe("retryable");
    expect(classifyLlmError(new StreamEventError("rate_limit_error", "x", null))).toBe("retryable");
    expect(classifyLlmError(new StreamEventError("api_error", "x", null))).toBe("retryable");
    expect(classifyLlmError(new StreamEventError("authentication_error", "x", null))).toBe("auth");
    expect(classifyLlmError(new StreamEventError("permission_error", "x", null))).toBe("auth");
    expect(classifyLlmError(new StreamEventError("invalid_request_error", "x", null))).toBe("fatal");
    expect(classifyLlmError(new StreamEventError("something_new", "x", null))).toBe("retryable");
  });

  it("reads 0.32.1's SSE error (an APIConnectionError whose message is the event JSON)", async () => {
    const sseData = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad" }, request_id: "req_sse" });
    const thrown = Anthropic.APIError.generate(undefined, `SSE Error: ${sseData}`, sseData, {});
    expect(thrown).toBeInstanceOf(Anthropic.APIConnectionError);
    expect(classifyLlmError(thrown)).toBe("fatal");

    const { client } = fakeClient(async () => {
      throw thrown;
    });
    useClients(client);
    const err = await callModel(input()).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, errorType: "invalid_request_error", requestId: "req_sse", errorClass: "fatal" });
  });

  it("falls back to retryable for aborts, unknown errors and non-errors", () => {
    expect(classifyLlmError(new Anthropic.APIUserAbortError())).toBe("retryable");
    expect(classifyLlmError(new DOMException("aborted", "AbortError"))).toBe("retryable");
    expect(classifyLlmError(new Error("{not json"))).toBe("retryable");
    expect(classifyLlmError(new Error('{"type":"something"}'))).toBe("retryable");
    expect(classifyLlmError("weird")).toBe("retryable");
    expect(classifyLlmError(null)).toBe("retryable");
    expect(classifyLlmError({ status: 302 })).toBe("retryable");
  });

  it("classifies plain objects by numeric status", () => {
    expect(classifyLlmError({ status: 401 })).toBe("auth");
    expect(classifyLlmError({ status: 418 })).toBe("fatal");
    expect(classifyLlmError({ status: 502 })).toBe("retryable");
  });
});

// ---------------------------------------------------------------------------
// Through the REAL SDK 0.32.1, with fetch faked: proves the raw-event path
// (thinking + signature deltas arrive untouched), SSE error events, the 401
// reset/retry, request ids and mid-stream aborts against the actual SDK code.
// ---------------------------------------------------------------------------

describe("callModel through the real SDK", () => {
  type FetchArgs = { url: string; init: RequestInit & { headers?: Record<string, string> } };

  function sseText(events: Record<string, unknown>[]): string {
    return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  }

  // Chunked at an awkward size so SSE frames straddle reads.
  function chunkedBody(text: string, size = 23): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
        controller.close();
      }
    });
  }

  function sdkClient(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, seen: FetchArgs[]): Anthropic {
    return new Anthropic({
      apiKey: "sk-ant-test-not-a-real-key",
      authToken: null,
      baseURL: "https://api.anthropic.test",
      maxRetries: 0,
      // The SDK types `fetch` against its bundled node-fetch; the platform
      // signature is runtime-compatible (anthropic-client.ts does the same).
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init: init as FetchArgs["init"] });
        return fetchImpl(url, init);
      }) as unknown as ClientOptions["fetch"]
    });
  }

  const sseHeaders = { "content-type": "text/event-stream", "request-id": "req_real" };

  function toolLoopEvents(): Record<string, unknown>[] {
    return [
      messageStart(),
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Tokyo is UTC+9; " } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "use the tool." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: SIGNATURE } },
      { type: "content_block_stop", index: 0 },
      { type: "ping" },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_9", name: "get_local_time", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"timezone":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ' "Asia/Tokyo"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 77 } },
      { type: "message_stop" }
    ];
  }

  it("keeps thinking text and signature through 0.32.1's raw Stream, and sends our exact body", async () => {
    const seen: FetchArgs[] = [];
    const client = sdkClient(async () => new Response(chunkedBody(sseText(toolLoopEvents())), { status: 200, headers: sseHeaders }), seen);
    useClients(client);
    const request = buildExecRequest({
      feature: "chat",
      system: "You are the assistant.",
      messages: [{ role: "user", content: "Time in Tokyo?" }],
      tools: [tool],
      thinkingBinding: "error"
    });

    const result = await callModel(input({ request }));

    expect(result.message.content).toEqual([
      { type: "thinking", thinking: "Tokyo is UTC+9; use the tool.", signature: SIGNATURE },
      { type: "tool_use", id: "toolu_9", name: "get_local_time", input: { timezone: "Asia/Tokyo" } }
    ]);
    expect(result.message.stop_reason).toBe("tool_use");
    expect(result.message.unknownDeltas).toBe(0);
    expect(result.requestId).toBe("req_real");

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.anthropic.test/v1/messages");
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toBe(THINKING_BINDING_BETA);
    const sent = JSON.parse(String(seen[0].init.body)) as Record<string, unknown>;
    expect(sent).toEqual({ ...request, stream: true });
    expect(sent).not.toHaveProperty("temperature");
  });

  it("surfaces an SSE error event as a classified LlmCallError, recording the partial usage", async () => {
    const events = [
      ...toolLoopEvents().slice(0, 3),
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }
    ];
    const client = sdkClient(async () => new Response(chunkedBody(sseText(events)), { status: 200, headers: sseHeaders }), []);
    useClients(client);
    const err = await callModel(input()).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "LlmCallError", status: 529, errorType: "overloaded_error", errorClass: "retryable", requestId: "req_real" });
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ stopReason: "error", usage: START_USAGE }));
  });

  it("maps an HTTP error body to status, type and request id", async () => {
    const body = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: '"thinking.type.disabled" is not supported for this model.' },
      request_id: "req_400"
    });
    const client = sdkClient(
      async () => new Response(body, { status: 400, headers: { "content-type": "application/json", "request-id": "req_400" } }),
      []
    );
    useClients(client);
    const err = await callModel(input()).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "LlmCallError", status: 400, errorType: "invalid_request_error", errorClass: "fatal", requestId: "req_400" });
    // The API's own sentence, not the SDK's JSON dump of the body.
    expect((err as Error).message).toBe(
      'model call failed (400 invalid_request_error): "thinking.type.disabled" is not supported for this model.'
    );
  });

  it("recovers from a 401 by resetting the client and retrying once", async () => {
    const unauthorized = sdkClient(
      async () =>
        new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), {
          status: 401,
          headers: { "content-type": "application/json", "request-id": "req_401" }
        }),
      []
    );
    const healthy = sdkClient(async () => new Response(chunkedBody(sseText(textEvents())), { status: 200, headers: sseHeaders }), []);
    useClients(unauthorized, healthy);
    const result = await callModel(input());
    expect(resetAnthropic).toHaveBeenCalledTimes(1);
    expect(result.message.content[1]).toEqual({ type: "text", text: "Hello there." });
  });

  it("rethrows the caller's AbortError unchanged when it aborts mid-stream", async () => {
    const controller = new AbortController();
    // 0.32.1's SSE chunker only releases a frame once bytes follow it, so a
    // trailing ping (as the live API sends) lets the text delta through.
    const firstFrames = new TextEncoder().encode(
      sseText([
        messageStart(),
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial" } },
        { type: "ping" }
      ])
    );
    const client = sdkClient(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(firstFrames);
          // The rest never comes: the stream only ends when the request is aborted.
          init.signal?.addEventListener("abort", () => streamController.error(new DOMException("The operation was aborted.", "AbortError")));
        }
      });
      return new Response(body, { status: 200, headers: sseHeaders });
    }, []);
    useClients(client);

    const onTextDelta = vi.fn(() => controller.abort());
    const err = await callModel(input({ signal: controller.signal, onTextDelta })).catch((e: unknown) => e);
    expect(onTextDelta).toHaveBeenCalledWith("Partial", 0);
    expect(err).toBe(controller.signal.reason);
    expect((err as DOMException).name).toBe("AbortError");
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ stopReason: "aborted", usage: START_USAGE }));
  });

  // A request the API hasn't answered: settles only when the SDK aborts the
  // fetch, rejecting the way fetch does.
  function unanswered(init: RequestInit): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      const fail = () => reject(new DOMException("This operation was aborted", "AbortError"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
  }

  // 0.32.1 reports every abort before the response starts as its own
  // APIUserAbortError (name "Error", not the caller's reason). For a
  // non-streamed call that window is the whole generation.
  it.each([
    ["a non-streamed call while the model is generating", "triage", false],
    ["a streamed call before the response starts", "chat", true]
  ] as const)("rethrows the caller's abort reason when it aborts %s", async (_label, feature, streamed) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const controller = new AbortController();
    const reason = new Error("job lease lost");
    const seen: FetchArgs[] = [];
    const client = sdkClient(async (_url, init) => {
      setTimeout(() => controller.abort(reason), 0);
      return unanswered(init);
    }, seen);
    useClients(client);
    const request = feature === "triage" ? triageRequest : chatRequest;

    const err = await callModel(input({ feature, request, signal: controller.signal })).catch((e: unknown) => e);
    expect(err).toBe(reason);
    expect(seen).toHaveLength(1);
    expect(JSON.parse(String(seen[0].init.body))).toMatchObject({ stream: streamed });
    expect(recordUsage).not.toHaveBeenCalled();
    // An abort is the expected end of a cancelled call, not something to log.
    expect(warn).not.toHaveBeenCalled();
  });

  it("rethrows the caller's abort reason when it aborts while a non-streamed body is still arriving", async () => {
    const controller = new AbortController();
    const reason = new Error("job timed out");
    const client = sdkClient(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"id":"msg_t1","type":"message","content":['));
          (init.signal as AbortSignal).addEventListener("abort", () =>
            stream.error(new DOMException("This operation was aborted", "AbortError"))
          );
          setTimeout(() => controller.abort(reason), 0);
        }
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json", "request-id": "req_body" } });
    }, []);
    useClients(client);
    const err = await callModel(input({ feature: "triage", request: triageRequest, signal: controller.signal })).catch(
      (e: unknown) => e
    );
    expect(err).toBe(reason);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("rethrows the caller's abort reason when it aborts while the client is being built, sending nothing", async () => {
    const controller = new AbortController();
    const reason = new Error("route closed");
    const seen: FetchArgs[] = [];
    const client = sdkClient(async () => new Response(chunkedBody(sseText(textEvents())), { status: 200, headers: sseHeaders }), seen);
    vi.mocked(getAnthropic).mockImplementationOnce(async () => {
      controller.abort(reason);
      return client;
    });
    const err = await callModel(input({ signal: controller.signal })).catch((e: unknown) => e);
    expect(err).toBe(reason);
    expect(seen).toHaveLength(0);
    expect(resetAnthropic).not.toHaveBeenCalled();
  });

  it("treats a connection that closes before message_stop as a retryable broken stream", async () => {
    const client = sdkClient(
      async () => new Response(chunkedBody(sseText(textEvents().slice(0, 7))), { status: 200, headers: sseHeaders }),
      []
    );
    useClients(client);
    const err = await callModel(input()).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "LlmCallError", errorClass: "retryable", status: null, requestId: "req_real" });
    expect((err as LlmCallError).cause).toBeInstanceOf(LlmProtocolError);
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ stopReason: "error" }));
  });
});
