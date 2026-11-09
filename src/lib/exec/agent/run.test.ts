import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/anthropic-client", () => ({ getAnthropic: vi.fn(), resetAnthropic: vi.fn() }));
vi.mock("@/lib/exec/llm/usage", () => ({ recordUsage: vi.fn(), assertWithinDailyCap: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/llm/binding-alert", () => ({ reportBindingTransformations: vi.fn() }));
// Area B's modules: the contract's stand-ins (bindings AM21).
vi.mock("@/lib/exec/agent/refs", async () => (await import("./__tests__/fake-tools")).fakeRefsModule);
vi.mock("@/lib/exec/agent/serialize", async () => (await import("./__tests__/fake-tools")).fakeSerializeModule);
vi.mock("@/lib/exec/agent/tool-defs", async () => (await import("./__tests__/fake-tools")).fakeToolDefsModule);
vi.mock("@/lib/exec/agent/tools", async () => {
  const m = await import("./__tests__/fake-tools");
  return { executeToolCall: vi.fn(), createTurnMemo: vi.fn(() => m.fakeMemo()) };
});

import { getAnthropic } from "@/lib/anthropic-client";
import { CHAT_LIMITS, runAgentTurn, type AgentTurnInput, type AgentTurnOptions, type AgentTurnResult } from "@/lib/exec/agent/run";
import type { AgentEventSink, RefEntry } from "@/lib/exec/agent/types";
import {
  CAPPED_NOTE,
  CHAT_PAUSED_TEXT,
  DEADLINE_NOTE,
  FAILED_TEXT,
  REFUSED_TEXT,
  TOOL_BUDGET_RESULT,
  TOO_MANY_TOOLS_RESULT,
  TRUNCATED_NOTE
} from "@/lib/exec/chat/copy";
import { numberSources } from "@/lib/exec/chat/markers";
import { reportBindingTransformations } from "@/lib/exec/llm/binding-alert";
import { LlmCallError } from "@/lib/exec/llm/client";
import { THINKING_BINDING_BETA, type ExecRequestParams, type ExecToolResultBlockParam } from "@/lib/exec/llm/request";
import { accumulateStream } from "@/lib/exec/llm/stream";
import { assertWithinDailyCap, recordUsage } from "@/lib/exec/llm/usage";
import { DEFAULT_SETTINGS, principalFromRows } from "@/lib/exec/principal";
import { BudgetExceededError, type ExecSettings } from "@/lib/exec/types";

import { fakeAnthropicClient, fakeMessage, iterate, scriptedModel, SIGNATURE, turnEvents, use, type Step } from "./__tests__/fake-anthropic";
import { fakeExecutor, type FakeExecutor, type ToolBehaviour } from "./__tests__/fake-tools";

// P5b contract §3.14 (B4, C1-C3, C11-C17, C39-C41, C55): tests 40-59, 107, 109, 114, 120 and the loop half of 56/126.
// No test calls a model: 40, 41 and 56 run the REAL callModel over fake SDK stream events; the rest a scripted callModel.

const principal = principalFromRows(
  { id: "ep_owner", user_id: "u_mitchell", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
  { id: "u_mitchell", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
)!;
const NOW = new Date("2026-11-07T15:00:00.000Z");
const TURN_ID = "ect_0123456789abcdef0123456789abcdef";
const SETTINGS: ExecSettings = {
  ...DEFAULT_SETTINGS, principalId: principal.id, chatEnabled: true, chatSchemaReady: true, chatDailyCapUsd: 9, dailyCostCapUsd: 15
};
const USER_TEXT = "[Now: Saturday, November 7, 2026 at 10:00 AM EST]\n\nWho has overdue tasks?";

function input(over: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    conversationId: "ecv_0123456789abcdef0123456789abcdef", assistantMessageId: "ecm_0123456789abcdef0123456789abcdef", turnId: TURN_ID,
    surface: "web", replay: [], userTurnText: USER_TEXT, priorRefs: [], contextRefs: [], refSeq: 0, context: null,
    prior: { threads: new Set(), clients: new Set(), ddText: false }, chatSpentAtStartUsd: 0, settings: SETTINGS, now: NOW, ...over
  };
}

type SinkEvent = { kind: "text"; round: number; delta: string } | { kind: "tool"; round: number; callId: string; name: string; label: string; state: string } | { kind: "retract" };
function recordingSink(): { sink: AgentEventSink; events: SinkEvent[] } {
  const events: SinkEvent[] = [];
  return {
    events,
    sink: {
      text: (round, delta) => events.push({ kind: "text", round, delta }),
      tool: (e) => events.push({ kind: "tool", ...e }),
      retract: () => events.push({ kind: "retract" })
    }
  };
}

const results: AgentTurnResult[] = [];

interface RunOpts {
  steps: readonly Step[] | ((call: number) => Step);
  exec?: FakeExecutor;
  input?: Partial<AgentTurnInput>;
  spend?: (call: number) => Promise<number>;
  signal?: AbortSignal;
  sink?: AgentEventSink;
  binding?: AgentTurnOptions["binding"];
  nowMs?: () => number;
}
async function run(o: RunOpts) {
  const model = scriptedModel(o.steps);
  const exec = o.exec ?? fakeExecutor();
  const rec = recordingSink();
  let reads = 0;
  const spend = vi.fn(async () => (o.spend ? o.spend(++reads) : 0));
  const result = await runAgentTurn(principal, input(o.input), {
    signal: o.signal ?? new AbortController().signal,
    sink: o.sink ?? rec.sink,
    binding: o.binding,
    deps: { callModel: model.callModel, executeToolCall: exec.executeToolCall, chatSpentTodayUsd: spend, ...(o.nowMs ? { nowMs: o.nowMs } : {}) }
  });
  results.push(result);
  return { result, model, exec, events: rec.events, spend };
}

const toolsStep = (n: number, count = 1, name = "search_tasks"): Step => ({ tools: Array.from({ length: count }, (_, i) => use(`toolu_${n}_${i}`, name, { q: `${n}.${i}` })) });
const lastUser = (r: ExecRequestParams) => r.messages[r.messages.length - 1];
const resultBlocks = (r: ExecRequestParams) => lastUser(r).content as ExecToolResultBlockParam[];
const blockText = (b: ExecToolResultBlockParam) => ((b.content as { text: string }[])[0]).text;
const priorRef = (ref: string, id = "t_1"): RefEntry => ({ ref, target: { type: "task", id }, source: { system: "dd", id, url: null, label: `Task ${id}`, class: "internal" } });

/** §2.1's CHECKs on the finish write, re-implemented (test 107): every terminal path must satisfy them. */
function finishCheckProblems(r: AgentTurnResult): string[] {
  const p: string[] = [];
  if (!["complete", "aborted", "refused", "failed", "capped"].includes(r.status)) p.push("status");
  if (r.statusReason !== null && !/^[a-z_]{1,40}$/.test(r.statusReason)) p.push("status_reason");
  if (r.refusalCategory !== null && r.refusalCategory.length > 60) p.push("refusal_category");
  if (r.answer.length > 40_000) p.push("text");
  if (r.recommendations.length > 8_000) p.push("recommendations");
  if (r.cited.length > 60) p.push("sources");
  if (r.cards.length > 10) p.push("cards");
  if (r.toolCalls.length > 100) p.push("tool_calls");
  if (r.consulted.length > 600) p.push("consulted");
  if (r.consultedClients.length > 500) p.push("consulted_clients");
  if (r.model.length > 64) p.push("model");
  if (typeof r.usage !== "object" || r.usage === null || Array.isArray(r.usage)) p.push("usage");
  for (const c of r.toolCalls) for (const v of Object.values(c.args)) if (typeof v === "string" && v.length > 500) p.push("args");
  return p;
}

const savedEnv = process.env.EXEC_ENABLED;
beforeEach(() => {
  process.env.EXEC_ENABLED = "true";
  vi.mocked(assertWithinDailyCap).mockResolvedValue({ spentUsd: 0, capUsd: 15 });
  vi.mocked(recordUsage).mockResolvedValue(undefined);
  vi.mocked(reportBindingTransformations).mockResolvedValue(undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const r of results) expect(finishCheckProblems(r)).toEqual([]);
  results.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (savedEnv === undefined) delete process.env.EXEC_ENABLED;
  else process.env.EXEC_ENABLED = savedEnv;
});

describe("one call and a tool round, through the real callModel (tests 40-41)", () => {
  it("40: one call answering → complete; split; markers validated; sources numbered", async () => {
    const fake = fakeAnthropicClient([turnEvents({ text: ["Ann is late [r1]", " and [r9].\n\n**Suggested next steps**\n- Ask Ann [r1]"] })]);
    vi.mocked(getAnthropic).mockResolvedValue(fake.client as never);
    const prior = priorRef("r1");
    const result = await runAgentTurn(principal, input({ priorRefs: [prior], refSeq: 1 }), {
      signal: new AbortController().signal,
      deps: { executeToolCall: fakeExecutor().executeToolCall, chatSpentTodayUsd: async () => 0 }
    });
    results.push(result);
    expect(result.status).toBe("complete");
    expect(result.statusReason).toBeNull();
    expect(result.answer).toBe("Ann is late [r1] and .");
    expect(result.recommendations).toBe("- Ask Ann [r1]");
    expect(result.cited.map((c) => c.ref)).toEqual(["r1"]);
    expect(result.usage.unknownMarkers).toBe(1);
    expect(numberSources(result.cited, result.answer, result.recommendations)).toEqual([{ n: 1, ref: "r1", source: prior.source }]);
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(result.usage.modelCalls).toBe(1);
  });

  it("41: the assistant content goes back byte-equal; all tool results in one user message, in tool_use order, nothing else", async () => {
    const round1 = turnEvents({ text: ["Checking."], tools: [use("toolu_a", "search_tasks", { q: "late" }), use("toolu_b", "get_task", { q: "t_9" })] });
    const round2 = turnEvents({ text: ["Both are late [r1][r2]."] });
    const fake = fakeAnthropicClient([round1, round2]);
    vi.mocked(getAnthropic).mockResolvedValue(fake.client as never);
    const exec = fakeExecutor();
    const result = await runAgentTurn(principal, input(), {
      signal: new AbortController().signal,
      deps: { executeToolCall: exec.executeToolCall, chatSpentTodayUsd: async () => 0 }
    });
    results.push(result);
    expect(result.status).toBe("complete");
    expect(result.cited.map((c) => c.ref)).toEqual(["r1", "r2"]);
    const sent = fake.bodies[1].messages as { role: string; content: Record<string, unknown>[] }[];
    expect(sent).toHaveLength(3);
    const expected = (await accumulateStream(iterate(round1))).content;
    expect(JSON.stringify(sent[1].content)).toBe(JSON.stringify(expected));
    expect(sent[1].content[0]).toEqual({ type: "thinking", thinking: "", signature: SIGNATURE });
    expect(sent[2].role).toBe("user");
    expect(sent[2].content.map((b) => [b.type, b.tool_use_id])).toEqual([
      ["tool_result", "toolu_a"],
      ["tool_result", "toolu_b"]
    ]);
  });
});

describe("tool rounds (tests 42-43)", () => {
  it("42: five calls run at most four at once, results in order; ten calls → eight run, two get TOO_MANY_TOOLS_RESULT", async () => {
    const exec = fakeExecutor({ delayMs: 15 });
    const five = await run({ steps: [toolsStep(1, 5), { text: ["Done."] }], exec });
    expect(five.result.status).toBe("complete");
    expect(exec.maxActive).toBe(4);
    expect(resultBlocks(five.model.requests[1]).map((b) => b.tool_use_id)).toEqual(["toolu_1_0", "toolu_1_1", "toolu_1_2", "toolu_1_3", "toolu_1_4"]);

    const ten = await run({ steps: [toolsStep(1, 10), { text: ["Done."] }] });
    expect(ten.exec.calls).toHaveLength(8);
    const blocks = resultBlocks(ten.model.requests[1]);
    expect(blocks).toHaveLength(10);
    expect(blocks.slice(8).map((b) => [b.is_error, blockText(b)])).toEqual([
      [true, TOO_MANY_TOOLS_RESULT],
      [true, TOO_MANY_TOOLS_RESULT]
    ]);
    expect(ten.events.filter((e) => e.kind === "tool" && e.state === "skipped").map((e) => (e as { callId: string }).callId)).toEqual(["1.8", "1.9"]);
    expect(ten.result.toolCalls.filter((t) => t.error === "too_many")).toHaveLength(2);
  });

  it("loop-1: a skipped call's persisted args are clipped to 500 without half a surrogate pair", async () => {
    const face = String.fromCodePoint(0x1f600);
    const long = `${"x".repeat(499)}${face}${"y".repeat(10)}`;
    // The first eight run (the fake executor records them as given); the last two are skipped and run.ts records them.
    const tools = Array.from({ length: 10 }, (_v, i) =>
      use(`toolu_s${i}`, "search_tasks", i < 8 ? { q: "short" } : { q: long, [`k${"z".repeat(62)}${face}`]: 1 })
    );
    const { result } = await run({ steps: [{ tools }, { text: ["Done."] }] });
    const skipped = result.toolCalls.filter((t) => t.error === "too_many");
    expect(skipped).toHaveLength(2);
    for (const rec of skipped) {
      expect(rec.args.q).toBe("x".repeat(499));
      expect(Object.keys(rec.args)).toContain(`k${"z".repeat(62)}`);
      expect(() => JSON.parse(JSON.stringify(rec.args))).not.toThrow();
    }
  });

  it("43 (loop half): an is_error result doesn't end the turn; the next call sees it and the turn completes", async () => {
    const behaviours: Partial<Record<string, ToolBehaviour>> = { get_task: () => ({ ok: false, code: "dd_read", text: "Couldn't read tasks from DD just now." }) };
    const { result, model } = await run({ steps: [{ tools: [use("toolu_x", "get_task", { q: "1" }), use("toolu_y", "search_tasks", { q: "2" })] }, { text: ["Partly."] }], exec: fakeExecutor({ behaviours }) });
    expect(result.status).toBe("complete");
    expect(resultBlocks(model.requests[1]).map((b) => b.is_error === true)).toEqual([true, false]);
  });
});

describe("limits (tests 44-47)", () => {
  it("44: a model that always asks for tools → tools run after calls 1-10, call 11's are skipped, call 12 → capped / round_cap", async () => {
    const { result, model, exec, events } = await run({ steps: (n) => toolsStep(n) });
    expect(model.callModel).toHaveBeenCalledTimes(12);
    expect(exec.calls).toHaveLength(10);
    expect(result.status).toBe("capped");
    expect(result.statusReason).toBe("round_cap");
    expect(result.answer.endsWith(CAPPED_NOTE)).toBe(true);
    const r12 = resultBlocks(model.requests[11]);
    expect(r12.map((b) => [b.tool_use_id, b.is_error, blockText(b)])).toEqual([["toolu_11_0", true, TOOL_BUDGET_RESULT]]);
    expect(events.filter((e) => e.kind === "tool" && e.state === "skipped").map((e) => (e as { round: number }).round)).toEqual([11]);
    expect(CHAT_LIMITS.maxModelCalls).toBe(12);
  });

  it("44: call 12 answering → complete", async () => {
    const { result, model } = await run({ steps: (n) => (n === 12 ? { text: ["Here it is."] } : toolsStep(n)) });
    expect(model.callModel).toHaveBeenCalledTimes(12);
    expect(result.status).toBe("complete");
    expect(result.answer).toBe("Here it is.");
  });

  it("45: the cost ceiling: $1.50 reached after call 3 → call 3's tools get the budget result; call 4 is final", async () => {
    const { result, model, exec } = await run({ steps: (n) => ({ ...(toolsStep(n) as object), costUsd: 0.5 }) as Step });
    expect(model.callModel).toHaveBeenCalledTimes(4);
    expect(exec.calls).toHaveLength(2);
    expect(blockText(resultBlocks(model.requests[3])[0])).toBe(TOOL_BUDGET_RESULT);
    expect(result.status).toBe("capped");
    expect(result.statusReason).toBe("cost_ceiling");
    expect(result.usage.costUsd).toBe(2);
  });

  it("46: spend at start ≥ the cap → no model call, capped / chat_budget, the paused sentence; a cap ≤ 0 likewise", async () => {
    const atCap = await run({ steps: [{ text: ["x"] }], input: { chatSpentAtStartUsd: 9 } });
    expect(atCap.model.callModel).not.toHaveBeenCalled();
    expect([atCap.result.status, atCap.result.statusReason, atCap.result.answer]).toEqual(["capped", "chat_budget", CHAT_PAUSED_TEXT]);
    const paused = await run({ steps: [{ text: ["x"] }], input: { settings: { ...SETTINGS, chatDailyCapUsd: 0 } } });
    expect(paused.model.callModel).not.toHaveBeenCalled();
    expect(paused.result.answer).toBe(CHAT_PAUSED_TEXT);
    const lowDaily = await run({ steps: [{ text: ["x"] }], input: { settings: { ...SETTINGS, dailyCostCapUsd: 5 }, chatSpentAtStartUsd: 3 } });
    expect(lowDaily.result.statusReason).toBe("chat_budget");
  });

  it("46: the LIVE spend crossing the cap after call 2 takes the exhausted path although the turn itself cost little", async () => {
    const { result, model, exec, spend } = await run({ steps: (n) => toolsStep(n), spend: async (k) => (k >= 2 ? 9.5 : 1) });
    expect(spend).toHaveBeenCalledTimes(2);
    expect(model.callModel).toHaveBeenCalledTimes(3);
    expect(exec.calls).toHaveLength(1);
    expect(blockText(resultBlocks(model.requests[2])[0])).toBe(TOOL_BUDGET_RESULT);
    expect([result.status, result.statusReason]).toEqual(["capped", "chat_budget"]);
    expect(result.usage.costUsd).toBeLessThan(0.1);
  });

  it("46: a throwing re-read → capped / chat_budget with CAPPED_NOTE and no further call (fail closed)", async () => {
    const { result, model, exec } = await run({
      steps: [{ text: ["Looking."], tools: [use("toolu_1", "search_tasks", { q: "x" })] }],
      spend: async () => {
        throw new Error("read failed");
      }
    });
    expect(model.callModel).toHaveBeenCalledTimes(1);
    expect(exec.calls).toHaveLength(0);
    expect([result.status, result.statusReason]).toEqual(["capped", "chat_budget"]);
    expect(result.answer).toBe(`Looking.\n\n${CAPPED_NOTE}`);
  });

  it("46: the live read gets its own short signal, never the turn's", async () => {
    const turnController = new AbortController();
    const seen: AbortSignal[] = [];
    await run({
      steps: [toolsStep(1), { text: ["ok"] }],
      signal: turnController.signal,
      exec: fakeExecutor(),
      spend: async () => 0
    });
    const model = scriptedModel([toolsStep(1), { text: ["ok"] }]);
    await runAgentTurn(principal, input(), {
      signal: turnController.signal,
      deps: {
        callModel: model.callModel, executeToolCall: fakeExecutor().executeToolCall,
        chatSpentTodayUsd: async (_p, _n, o) => {
          seen.push(o?.signal as AbortSignal);
          return 0;
        }
      }
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(turnController.signal);
    expect(seen[0]).not.toBe(model.signals[0]);
  });

  it("47: BudgetExceededError from callModel → capped / daily_budget", async () => {
    const { result } = await run({ steps: [{ kind: "throw", error: new BudgetExceededError(15, 15) }] });
    expect([result.status, result.statusReason, result.answer]).toEqual(["capped", "daily_budget", CHAT_PAUSED_TEXT]);
    expect(result.usage.partialRoundUncounted).toBe(false);
  });
});

describe("refusals, aborts, deadlines (tests 48-50)", () => {
  it("48: a refusal before output, mid-stream and after a tool round → retract before done, refused, the category stored", async () => {
    for (const steps of [
      [{ refused: true, stopDetails: { type: "refusal", category: "cyber" } }],
      [{ text: ["Sure, here is"], refused: true, stopDetails: { type: "refusal", category: "cyber" } }],
      [toolsStep(1), { text: ["Well"], refused: true, stopDetails: { type: "refusal", category: "cyber" } }]
    ] as Step[][]) {
      const { result, events } = await run({ steps });
      expect([result.status, result.statusReason, result.answer]).toEqual(["refused", "refusal", REFUSED_TEXT]);
      expect(result.refusalCategory).toBe("cyber");
      expect(events[events.length - 1]).toEqual({ kind: "retract" });
      expect(events.filter((e) => e.kind === "retract")).toHaveLength(1);
    }
    expect(REFUSED_TEXT).toMatch(/new conversation/);
  });

  it("49: an abort mid-stream → aborted / client_abort with that round's partial text", async () => {
    const controller = new AbortController();
    const sink: AgentEventSink = {
      text: (_r, d) => {
        if (d === " answer") controller.abort();
      },
      tool: () => undefined,
      retract: () => undefined
    };
    const { result, model } = await run({ steps: [{ kind: "hang", text: ["Partial", " answer"] }], signal: controller.signal, sink });
    expect([result.status, result.statusReason, result.answer]).toEqual(["aborted", "client_abort", "Partial answer"]);
    expect(result.usage.partialRoundUncounted).toBe(true);
    expect(model.callModel).toHaveBeenCalledTimes(1);
  });

  it("49: an abort during tools aborts the tools' signals and makes no further model call", async () => {
    const controller = new AbortController();
    const exec = fakeExecutor({ delayMs: 60_000 });
    setTimeout(() => controller.abort(), 20);
    const { result, model } = await run({ steps: [toolsStep(1, 2), { text: ["never"] }], exec, signal: controller.signal });
    expect(model.callModel).toHaveBeenCalledTimes(1);
    expect(exec.contexts.length).toBe(2);
    for (const ctx of exec.contexts) expect(ctx.signal.aborted).toBe(true);
    expect([result.status, result.statusReason]).toEqual(["aborted", "client_abort"]);
  });

  it("49: a signal already aborted at entry → aborted, no model call (C55)", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result, model } = await run({ steps: [{ text: ["x"] }], signal: controller.signal });
    expect(model.callModel).not.toHaveBeenCalled();
    expect([result.status, result.statusReason, result.answer]).toEqual(["aborted", "client_abort", ""]);
    expect(result.usage.modelCalls).toBe(0);
  });

  it("50: the hard deadline → capped / deadline, the partial text with DEADLINE_NOTE", async () => {
    vi.useFakeTimers();
    const pending = run({ steps: [{ kind: "hang", text: ["Half done"] }] });
    await vi.advanceTimersByTimeAsync(CHAT_LIMITS.hardDeadlineMs);
    const { result } = await pending;
    expect([result.status, result.statusReason]).toEqual(["capped", "deadline"]);
    expect(result.answer).toBe(`Half done\n\n${DEADLINE_NOTE}`);
    expect(CHAT_LIMITS.hardDeadlineMs).toBe(540_000);
  });

  it("50: the soft deadline at a round boundary → the exhausted path; the final call asking again → capped / deadline", async () => {
    let t = 0;
    const nowMs = () => {
      const v = t;
      t = CHAT_LIMITS.softDeadlineMs + 1;
      return v;
    };
    const { result, model, exec } = await run({ steps: (n) => toolsStep(n), nowMs });
    expect(model.callModel).toHaveBeenCalledTimes(2);
    expect(exec.calls).toHaveLength(0);
    expect(blockText(resultBlocks(model.requests[1])[0])).toBe(TOOL_BUDGET_RESULT);
    expect([result.status, result.statusReason]).toEqual(["capped", "deadline"]);
    expect(result.answer.endsWith(DEADLINE_NOTE)).toBe(true);
  });
});

describe("protocol and truncation (tests 51-53, 114)", () => {
  it("51: max_tokens without tools → capped / truncated with the note; with an unparseable tool input → capped / truncated", async () => {
    const plain = await run({ steps: [{ text: ["A long answer"], stopReason: "max_tokens" }] });
    expect([plain.result.status, plain.result.statusReason, plain.result.answer]).toEqual(["capped", "truncated", `A long answer\n\n${TRUNCATED_NOTE}`]);
    const tool = await run({ steps: [{ text: ["Let me"], tools: [use("toolu_1", "search_tasks", {})], stopReason: "max_tokens", toolInputErrors: [2] }] });
    expect([tool.result.status, tool.result.statusReason]).toEqual(["capped", "truncated"]);
    expect(tool.exec.calls).toHaveLength(0);
  });

  it("52: unknown deltas or pause_turn → failed / protocol; a blank final text → failed / empty_answer; LlmCallError after text → retract, model_error", async () => {
    const unknown = await run({ steps: [{ text: ["Hi"], unknownDeltas: 1 }] });
    expect([unknown.result.status, unknown.result.statusReason, unknown.result.answer]).toEqual(["failed", "protocol", FAILED_TEXT]);
    const pause = await run({ steps: [{ text: ["Hi"], stopReason: "pause_turn" }] });
    expect([pause.result.status, pause.result.statusReason]).toEqual(["failed", "protocol"]);
    const replay = await run({ steps: [{ tools: [use("toolu_1", "search_tasks", { q: "x" })], unknownDeltas: 2 }] });
    expect([replay.result.status, replay.result.statusReason]).toEqual(["failed", "protocol"]);
    const blank = await run({ steps: [{ text: ["  \n "] }] });
    expect([blank.result.status, blank.result.statusReason, blank.result.answer]).toEqual(["failed", "empty_answer", FAILED_TEXT]);
    const err = new LlmCallError("model call failed (529 overloaded_error)", { status: 529, errorClass: "retryable" });
    const failed = await run({ steps: [{ kind: "throw", error: err, text: ["Ann is"] }] });
    expect([failed.result.status, failed.result.statusReason, failed.result.answer]).toEqual(["failed", "model_error", FAILED_TEXT]);
    expect(failed.events[failed.events.length - 1]).toEqual({ kind: "retract" });
    expect(failed.result.usage.partialRoundUncounted).toBe(true);
  });

  it("53: an empty text block in a tool round is dropped and the loop continues", async () => {
    const { result, model } = await run({ steps: [{ tools: [use("toolu_1", "search_tasks", { q: "x" })], extraBlocks: [{ type: "text", text: "" }] }, { text: ["Done."] }] });
    expect(result.status).toBe("complete");
    const assistant = model.requests[1].messages[1].content as { type: string; text?: string }[];
    expect(assistant.map((b) => b.type)).toEqual(["thinking", "tool_use"]);
  });

  it("114: an answer blank after finalize (an image, an unknown marker, a definition, a bare heading) → failed / empty_answer, retracted", async () => {
    for (const raw of ["![](https://e.example/p.png)", "[r999]", "[1]: https://e.example/x", "**Suggested next steps**"]) {
      const { result, events } = await run({ steps: [{ text: [raw] }] });
      expect([result.status, result.statusReason, result.answer]).toEqual(["failed", "empty_answer", FAILED_TEXT]);
      expect(result.recommendations).toBe("");
      expect(result.cited).toEqual([]);
      expect(events[events.length - 1]).toEqual({ kind: "retract" });
    }
  });
});

describe("the request (tests 54-56)", () => {
  const countMarkers = (r: ExecRequestParams) => {
    let n = (r.system ?? []).filter((b) => b.cache_control).length;
    for (const m of r.messages) if (Array.isArray(m.content)) n += m.content.filter((b) => (b as { cache_control?: unknown }).cache_control).length;
    return n;
  };
  const replay = [
    { role: "user" as const, content: [{ type: "text" as const, text: "[Now: x]\n\nEarlier question?" }] },
    { role: "assistant" as const, content: [{ type: "text" as const, text: "Earlier answer." }] }
  ];

  it("54: exactly two cache_control per request: the last system block and the last block of the last user message", async () => {
    const { model } = await run({ steps: [toolsStep(1, 2), toolsStep(2), { text: ["Done."] }], input: { replay } });
    expect(model.requests).toHaveLength(3);
    for (const r of model.requests) {
      expect(countMarkers(r)).toBe(2);
      expect(r.system?.[r.system.length - 1].cache_control).toEqual({ type: "ephemeral" });
      const last = lastUser(r).content as { cache_control?: unknown }[];
      expect(last[last.length - 1].cache_control).toEqual({ type: "ephemeral" });
      for (const m of r.messages.slice(0, -1)) for (const b of m.content as { cache_control?: unknown }[]) expect(b.cache_control).toBeUndefined();
    }
  });

  it("55: tools, tool_choice, system, thinking and output_config are byte-identical in every call; the 5.5 request shape", async () => {
    const { model } = await run({ steps: [toolsStep(1), toolsStep(2), { text: ["Done."] }], input: { replay } });
    const pick = (r: ExecRequestParams) =>
      JSON.stringify({ tools: r.tools, tool_choice: r.tool_choice, system: r.system, thinking: r.thinking, output_config: r.output_config });
    expect(new Set(model.requests.map(pick)).size).toBe(1);
    for (const r of model.requests) {
      expect(r.model).toBe("claude-opus-5-5");
      expect(r.max_tokens).toBe(16_000);
      expect(r.tool_choice).toEqual({ type: "auto" });
      expect(r.output_config).toEqual({ effort: "medium" });
      expect(r.thinking?.type).toBe("adaptive");
      expect(r.thinking).not.toHaveProperty("display");
      for (const k of ["temperature", "top_p", "top_k"]) expect(r).not.toHaveProperty(k);
      expect(r.tools).toHaveLength(19);   // P7b stage 0 (§3.15, N16): 19 tools
    }
  });

  it("56: drop_block by default, error when asked; input_transformations counted and reported once", async () => {
    const dflt = await run({ steps: [{ text: ["ok"], inputTransformations: [{ type: "dropped" }, { type: "dropped" }] }] });
    expect(dflt.model.requests[0].thinking?.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
    expect(dflt.result.usage.transformations).toBe(2);
    expect(reportBindingTransformations).toHaveBeenCalledTimes(1);
    expect(reportBindingTransformations).toHaveBeenCalledWith(TURN_ID, 2);
    const strict = await run({ steps: [{ text: ["ok"] }], binding: "error" });
    expect(strict.model.requests[0].thinking?.block_binding).toEqual({ prefix_mismatch_behavior: "error" });
    expect(reportBindingTransformations).toHaveBeenCalledTimes(1);
  });

  it("56: the real callModel sends the binding beta header", async () => {
    const fake = fakeAnthropicClient([turnEvents({ text: ["ok"] })]);
    vi.mocked(getAnthropic).mockResolvedValue(fake.client as never);
    const result = await runAgentTurn(principal, input(), {
      signal: new AbortController().signal,
      deps: { executeToolCall: fakeExecutor().executeToolCall, chatSpentTodayUsd: async () => 0 }
    });
    results.push(result);
    const headers = (fake.options[0].headers ?? {}) as Record<string, string>;
    expect(headers["anthropic-beta"]).toContain(THINKING_BINDING_BETA);
    expect((fake.bodies[0].thinking as Record<string, unknown>).block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
    expect(fake.bodies[0].stream).toBe(true);
  });
});

describe("usage, the sink, and never throwing (tests 57-59)", () => {
  it("57: usage sums over completed calls; versions; model", async () => {
    const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 20 };
    const { result } = await run({ steps: [{ ...(toolsStep(1) as object), usage, costUsd: 0.25 } as Step, { text: ["Done."], usage, costUsd: 0.5, model: "claude-opus-5-5" }] });
    expect(result.usage).toMatchObject({
      modelCalls: 2, toolCalls: 1, toolCallsNotPersisted: 0, inputTokens: 200, outputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 40,
      costUsd: 0.75, transformations: 0, unknownMarkers: 0, partialRoundUncounted: false, promptVersion: "exec-chat-v3", toolsVersion: "fake-tools-v1"
    });
    expect(result.model).toBe("claude-opus-5-5");
  });

  it("58: text events carry their round; each tool is running → done / error; retract precedes done", async () => {
    const behaviours: Partial<Record<string, ToolBehaviour>> = { get_task: () => ({ ok: false, code: "not_found", text: "Nothing matches." }) };
    const { events } = await run({
      steps: [{ text: ["Look"], tools: [use("toolu_a", "search_tasks", { q: "x" }), use("toolu_b", "get_task", { q: "y" })] }, { text: ["Done"] }],
      exec: fakeExecutor({ behaviours })
    });
    expect(events.filter((e) => e.kind === "text")).toEqual([
      { kind: "text", round: 1, delta: "Look" },
      { kind: "text", round: 2, delta: "Done" }
    ]);
    const tools = events.filter((e): e is Extract<SinkEvent, { kind: "tool" }> => e.kind === "tool");
    expect(tools.map((e) => [e.callId, e.name, e.label, e.state])).toEqual(
      expect.arrayContaining([
        ["1.0", "search_tasks", "Label search_tasks", "running"],
        ["1.0", "search_tasks", "Label search_tasks", "done"],
        ["1.1", "get_task", "Label get_task", "running"],
        ["1.1", "get_task", "Label get_task", "error"]
      ])
    );
    for (const id of ["1.0", "1.1"]) {
      const states = tools.filter((e) => e.callId === id).map((e) => e.state);
      expect(states[0]).toBe("running");
      expect(states).toHaveLength(2);
    }
    const refusal = await run({ steps: [{ text: ["x"], refused: true }] });
    expect(refusal.events.map((e) => e.kind)).toEqual(["text", "retract"]);
  });

  it("59: a sink that throws changes nothing: same status, buffered text and answer; one log line names the turn", async () => {
    const steps: Step[] = [{ text: ["Ann ", "is ", "late"], tools: [use("toolu_1", "search_tasks", { q: "x" })] }, { text: ["Ann ", "is late."] }];
    const good = await run({ steps });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const broken of [
      { text: () => { throw new Error("closed"); }, tool: () => undefined, retract: () => undefined },
      { text: () => undefined, tool: () => { throw new Error("closed"); }, retract: () => undefined }
    ] as AgentEventSink[]) {
      warn.mockClear();
      const bad = await run({ steps, sink: broken });
      expect([bad.result.status, bad.result.answer, bad.result.recommendations]).toEqual([good.result.status, good.result.answer, good.result.recommendations]);
      expect(bad.result.toolCalls).toEqual(good.result.toolCalls.map((t) => ({ ...t, ms: expect.any(Number) })));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(`[exec-chat] sink failed turn=${TURN_ID}`);
    }
    warn.mockClear();
    const throwingRetract = await run({ steps: [{ text: ["x"], refused: true }], sink: { text: () => undefined, tool: () => undefined, retract: () => { throw new Error("closed"); } } });
    expect(throwingRetract.result.status).toBe("refused");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("59: a throwing executor mock → failed / internal; runAgentTurn never throws", async () => {
    const exec = fakeExecutor();
    exec.executeToolCall.mockImplementation(() => {
      throw new Error("executor bug");
    });
    const { result } = await run({ steps: [toolsStep(1), { text: ["never"] }], exec });
    expect([result.status, result.statusReason, result.answer]).toEqual(["failed", "internal", FAILED_TEXT]);
    const broken = await runAgentTurn(principal, input(), {
      signal: new AbortController().signal,
      deps: { callModel: scriptedModel([{ text: ["x"] }]).callModel, executeToolCall: exec.executeToolCall, chatSpentTodayUsd: async () => 0, nowMs: () => { throw new Error("clock"); } }
    });
    results.push(broken);
    expect([broken.status, broken.statusReason]).toEqual(["failed", "internal"]);
    const garbage = fakeExecutor();
    garbage.executeToolCall.mockResolvedValue(null as never);
    const g = await run({ steps: [toolsStep(1), { text: ["Fine."] }], exec: garbage });
    expect(g.result.status).toBe("complete");
    expect(resultBlocks(g.model.requests[1])[0].is_error).toBe(true);
  });
});

describe("finish limits (tests 107, 109)", () => {
  it("107: 6 propose_task and 4 create_draft calls in one turn → the 6th and 4th get limit; cards = 8", async () => {
    const behaviours: Partial<Record<string, ToolBehaviour>> = {
      propose_task: (_c, ctx) => {
        if (ctx.staged.proposals >= CHAT_LIMITS.maxProposalsPerTurn) return { ok: false, code: "limit", text: "Only 5 tasks can be staged per question." };
        ctx.staged.proposals += 1;
        ctx.cards.push({ kind: "task_proposal", id: `etp_${String(ctx.staged.proposals).padStart(32, "0")}` });
        return { ok: true, json: { staged: true } };
      },
      create_draft: (_c, ctx) => {
        if (ctx.staged.drafts >= CHAT_LIMITS.maxDraftsPerTurn) return { ok: false, code: "limit", text: "Only 3 drafts can be started per question." };
        ctx.staged.drafts += 1;
        ctx.cards.push({ kind: "draft", id: `ed_${String(ctx.staged.drafts).padStart(32, "0")}`, existing: false, privateRefKinds: [] });
        return { ok: true, json: { draft: "started" } };
      }
    };
    const round = (n: number, p: number, d: number): Step => ({
      tools: [...Array.from({ length: p }, (_, i) => use(`toolu_${n}_p${i}`, "propose_task", { q: `p${i}` })), ...Array.from({ length: d }, (_, i) => use(`toolu_${n}_d${i}`, "create_draft", { q: `d${i}` }))]
    });
    const { result } = await run({ steps: [round(1, 4, 2), round(2, 2, 2), { text: ["Staged."] }], exec: fakeExecutor({ behaviours }) });
    expect(result.status).toBe("complete");
    expect(result.cards).toHaveLength(8);
    expect(result.cards.filter((c) => c.kind === "task_proposal")).toHaveLength(5);
    expect(result.cards.filter((c) => c.kind === "draft")).toHaveLength(3);
    const limited = result.toolCalls.filter((t) => t.error === "limit").map((t) => t.name);
    expect(limited.sort()).toEqual(["create_draft", "propose_task"]);
  });

  it("107: a turn with 130 tool calls persists 100 records and counts 30 in toolCallsNotPersisted", async () => {
    const { result } = await run({ steps: (n) => (n <= 10 ? toolsStep(n, 13) : { text: ["Done."] }) });
    expect(result.status).toBe("complete");
    expect(result.usage.toolCalls).toBe(130);
    expect(result.toolCalls).toHaveLength(100);
    expect(result.usage.toolCallsNotPersisted).toBe(30);
    expect(result.toolCalls.filter((t) => t.error === "too_many").length).toBeGreaterThan(0);
  });

  it("109: a 40,000-character answer with each note stays ≤ 40,000 and ends with the note", async () => {
    const long = "a".repeat(40_000);
    const truncated = await run({ steps: [{ text: [long], stopReason: "max_tokens" }] });
    const capped = await run({ steps: [{ text: [long], tools: [use("toolu_1", "search_tasks", { q: "x" })] }], spend: async () => { throw new Error("x"); } });
    let t = 0;
    const deadline = await run({
      steps: (n) => (n === 1 ? toolsStep(1) : { text: [long], tools: [use("toolu_2", "search_tasks", { q: "y" })] }),
      nowMs: () => {
        const v = t;
        t = CHAT_LIMITS.softDeadlineMs;
        return v;
      }
    });
    for (const [r, note] of [[truncated.result, TRUNCATED_NOTE], [capped.result, CAPPED_NOTE], [deadline.result, DEADLINE_NOTE]] as const) {
      expect(r.status).toBe("capped");
      expect(r.answer.length).toBeLessThanOrEqual(40_000);
      expect(r.answer.endsWith(`\n\n${note}`)).toBe(true);
    }
  });
});

describe("consulted and citations (tests 66's loop half, 67)", () => {
  it("a cited earlier ref is citable again and its thread is consulted; an issued-but-dropped ref is unknown", async () => {
    const earlier: RefEntry = { ref: "r5", target: { type: "email_thread", id: "th_old" }, source: { system: "dd", id: "/executive/email/th_old", url: null, label: "Email thread", class: "private" } };
    const behaviours: Partial<Record<string, ToolBehaviour>> = {
      search_tasks: (_c, ctx) => {
        // Issued but never placed in the content: not delivered, so not citable (C39).
        ctx.refs.issue({ type: "task", id: "t_dropped" }, { system: "dd", id: "t_dropped", url: null, label: "Dropped", class: "internal" });
        return { ok: true, json: { items: [] } };
      }
    };
    const { result } = await run({
      steps: [toolsStep(1), { text: ["Re-cited [r5], dropped [r6]."] }],
      input: { priorRefs: [earlier], refSeq: 5 },
      exec: fakeExecutor({ behaviours })
    });
    expect(result.answer).toBe("Re-cited [r5], dropped .");
    expect(result.cited.map((c) => c.ref)).toEqual(["r5"]);
    expect(result.consulted).toEqual(["th_old"]);
    expect(result.usage.unknownMarkers).toBe(1);
    expect(result.refSeq).toBe(6);
  });

  it("the context thread is consulted from the start; the context ref is citable", async () => {
    const ctxEntry: RefEntry = { ref: "r1", target: { type: "email_thread", id: "th_ctx" }, source: { system: "dd", id: "/executive/email/th_ctx", url: null, label: "Re: invoice", class: "private" } };
    const { result } = await run({
      steps: [{ text: ["About it [r1]."] }],
      input: { contextRefs: [ctxEntry], refSeq: 1, context: { kind: "thread", id: "th_ctx", target: ctxEntry.target, source: ctxEntry.source } }
    });
    expect(result.cited.map((c) => c.ref)).toEqual(["r1"]);
    expect(result.consulted).toEqual(["th_ctx"]);
  });

  it("consulted clients and the DD-text flag come from the tools' context", async () => {
    const behaviours: Partial<Record<string, ToolBehaviour>> = {
      client_overview: (_c, ctx) => {
        ctx.consultedClients.add("c_acme");
        ctx.markDdText();
        ctx.consulted.admit(["th_1", "th_2"]);
        return { ok: true, json: { ok: true } };
      }
    };
    const { result } = await run({ steps: [toolsStep(1, 1, "client_overview"), { text: ["Fine."] }], exec: fakeExecutor({ behaviours }) });
    expect(result.consultedClients).toEqual(["c_acme"]);
    expect(result.consultedDdText).toBe(true);
    expect(result.consulted).toEqual(["th_1", "th_2"]);
  });
});

describe("concurrent turns and the live sub-cap (test 120)", () => {
  it("two turns against one spend store both stop at the sub-cap within one round of each other", async () => {
    // Calls of equal latency: the two turns take turns at the model (a, b, a, b, …), the way two concurrent turns
    // interleave, so the order can't depend on timer granularity. A finished turn stops holding the other up.
    let spend = 0;
    let next: "a" | "b" = "a";
    const finished = new Set<string>();
    const other = (t: "a" | "b") => (t === "a" ? "b" : "a");
    const stepFor = (tag: "a" | "b") => (n: number): Step => ({
      kind: "fn",
      run: async () => {
        while (next !== tag && !finished.has(other(tag))) await new Promise((r) => setTimeout(r, 0));
        spend += 1; // callModel records the call's cost before it returns
        next = other(tag);
        const message = fakeMessage({ tools: [use(`toolu_${tag}_${n}`, "search_tasks", { q: "x" })] });
        return { message, refused: false, truncated: false, costUsd: 0.01, latencyMs: 1, requestId: null };
      }
    });
    const live = async () => spend;
    const [a, b] = await Promise.all([
      run({ steps: stepFor("a"), spend: live }).finally(() => finished.add("a")),
      run({ steps: stepFor("b"), spend: live }).finally(() => finished.add("b"))
    ]);
    for (const r of [a, b]) expect([r.result.status, r.result.statusReason]).toEqual(["capped", "chat_budget"]);
    const callsA = a.model.callModel.mock.calls.length;
    const callsB = b.model.callModel.mock.calls.length;
    expect(Math.abs(callsA - callsB)).toBeLessThanOrEqual(1);
    // Each passes the cap by at most two calls (the one that crossed it and the final one).
    expect(spend).toBeLessThanOrEqual(9 + 2 * 2);
    expect(spend).toBeGreaterThanOrEqual(9);
  });
});
