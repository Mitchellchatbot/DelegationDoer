import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/lib/anthropic-client", () => ({ getAnthropic: vi.fn(), resetAnthropic: vi.fn() }));
vi.mock("@/lib/exec/llm/usage", () => ({ recordUsage: vi.fn(), assertWithinDailyCap: vi.fn() }));
vi.mock("@/lib/exec/llm/client", () => ({ callModel: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/llm/binding-alert", () => ({ reportBindingTransformations: vi.fn() }));
vi.mock("@/lib/exec/chat-store", async () => (await import("./__tests__/fake-chat-db")).chatStoreModule(() => db.current as never));
vi.mock("@/lib/exec/agent/refs", async () => (await import("./__tests__/fake-tools")).fakeRefsModule);
vi.mock("@/lib/exec/agent/serialize", async () => (await import("./__tests__/fake-tools")).fakeSerializeModule);
vi.mock("@/lib/exec/agent/tool-defs", async () => (await import("./__tests__/fake-tools")).fakeToolDefsModule);
vi.mock("@/lib/exec/agent/tools", () => ({ executeToolCall: vi.fn(), createTurnMemo: vi.fn() }));
vi.mock("@/lib/exec/agent/budget", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/agent/budget")>()), chatSpentTodayUsd: vi.fn() }));
vi.mock("@/lib/exec/drafts-store", async (orig) => (await import("./__tests__/b-stub")).stubOnly(await orig(), ["purgeDraftsByIds"]));
vi.mock("@/lib/exec/attention-read", () => ({ listScreenedAttention: vi.fn(), getScreenedAttentionItem: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => (await import("./__tests__/b-stub")).stubModule(await orig()));
vi.mock("@/lib/exec/email-store", async (orig) => (await import("./__tests__/b-stub")).stubOnly(await orig(), ["getEmailThread", "listThreadScreenRows"]));
vi.mock("@/lib/exec/sources/mail", async (orig) => (await import("./__tests__/b-stub")).stubOnly(await orig(), ["loadScreeningPolicy"]));
// P7b's post-finish recheck at its module (its own suite runs RPC 11).
vi.mock("@/lib/exec/slack-redact", () => ({ recheckSlackAnswer: vi.fn() }));

import { assertNoSlackLeak, captureConsole } from "@/lib/exec/__tests__/slack-intel-assert";
import { chatSpentTodayUsd } from "@/lib/exec/agent/budget";
import { CHAT_PROMPT_VERSION, CHAT_SYSTEM_PROMPT_V3 } from "@/lib/exec/agent/prompt";
import { createTurnMemo, executeToolCall, type ToolContext } from "@/lib/exec/agent/tools";
import { prepareChatTurn, runPreparedTurn, type ChatTurnRequest, type PreparedTurn } from "@/lib/exec/agent/turn";
import { finishTurn, redactChatMessage } from "@/lib/exec/chat-store";
import { callModel } from "@/lib/exec/llm/client";
import { DEFAULT_SETTINGS, principalFromRows } from "@/lib/exec/principal";
import { SLACK_REDACTED_TEXT, SLACK_UNCHECKED_TEXT } from "@/lib/exec/slack-intel-copy";
import { recheckSlackAnswer } from "@/lib/exec/slack-redact";
import { listClients, listDepartments, listProjects } from "@/lib/exec/sources/dd";
import { loadScreeningPolicy } from "@/lib/exec/sources/mail";
import { listThreadScreenRows } from "@/lib/exec/email-store";
import type { ExecSettings } from "@/lib/exec/types";

import { scriptedModel, use, type Step } from "./__tests__/fake-anthropic";
import { FakeChatDb } from "./__tests__/fake-chat-db";
import { fakeExecutor, fakeMemo, itemResult, type ToolBehaviour } from "./__tests__/fake-tools";

// P7b Area D: the turn's Slack wiring (contract §3.17.3 D2, D5, D6, D7, N15, C8, C30, C34): his question and the per-turn
// Slack members reach the tools, a replayed answer's private-Slack flag reaches prior, the consults go to the finish, and
// the post-finish recheck replaces the answer when RPC 11 redacts it (or can't run).

const principal = principalFromRows(
  { id: "ep_owner", user_id: "u_mitchell", enabled: true, mail_account_ids: ["acc_his"], slack_team_id: null, slack_user_id: null },
  { id: "u_mitchell", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
)!;
const NOW = new Date("2026-11-07T15:00:00.000Z");
const SETTINGS: ExecSettings = { ...DEFAULT_SETTINGS, principalId: principal.id, chatEnabled: true, chatSchemaReady: true, emailEnabled: true, emailSchemaReady: true };
const KEY = "m:C0PRIVOPS:1794140000.000100";

let fdb: FakeChatDb;
let out: ReturnType<typeof captureConsole>;
let n = 0;
let exec: ReturnType<typeof fakeExecutor>;
function setModel(steps: readonly Step[]) {
  const model = scriptedModel(steps);
  vi.mocked(callModel).mockImplementation(model.callModel);
  return model;
}
function req(text: string, over: Partial<ChatTurnRequest> = {}): ChatTurnRequest {
  n += 1;
  return { conversationId: null, clientTurnId: `client-turn-slack-${n}`, surface: "web", text, context: null, ...over };
}
type Started = Extract<PreparedTurn, { kind: "started" }>;
async function turnOnce(r: ChatTurnRequest) {
  const prepared = (await prepareChatTurn(principal, SETTINGS, r, NOW)) as Started;
  const out = await runPreparedTurn(principal, SETTINGS, prepared, r, { signal: new AbortController().signal, now: NOW, binding: "error" });
  return { prepared, ...out, stored: fdb.message(prepared.begin.assistantMessageId)! };
}
const consultsSlack = (privacy: "public" | "private"): ToolBehaviour => (_call, ctx) => {
  ctx.consultedSlack?.admit([KEY], "C0PRIVOPS", privacy);
  return itemResult(ctx, { type: "slack_message", channelId: "C0PRIVOPS", ts: "1794140000.000100", itemId: null }, "#private-ops message");
};

beforeEach(() => {
  fdb = new FakeChatDb();
  db.current = fdb;
  vi.mocked(chatSpentTodayUsd).mockResolvedValue(0);
  vi.mocked(createTurnMemo).mockImplementation(() => fakeMemo());
  vi.mocked(loadScreeningPolicy).mockResolvedValue({ rules: [], hash: "h1" });
  vi.mocked(listThreadScreenRows).mockResolvedValue(new Map());
  vi.mocked(listDepartments).mockResolvedValue([]);
  vi.mocked(listProjects).mockResolvedValue([]);
  vi.mocked(listClients).mockResolvedValue([]);
  vi.mocked(recheckSlackAnswer).mockResolvedValue("clean");
  out = captureConsole();
  exec = fakeExecutor({ behaviours: { search_slack: consultsSlack("private") } });
  vi.mocked(executeToolCall).mockImplementation(exec.executeToolCall);
});
afterEach(() => {
  // The turn's log lines carry ids, counts and codes only.
  assertNoSlackLeak({ console: out });
  vi.useRealTimers();
});

describe("the turn's Slack members (D2, D5)", () => {
  it("his question text, a Slack budget and a one-take client-update counter reach every tool call; the system prompt is v3", async () => {
    const model = setModel([{ tools: [use("toolu_1", "search_slack", { q: "x" }), use("toolu_2", "prepare_client_update", { q: "y" })] }, { text: ["Done [r1]."] }]);
    await turnOnce(req("Catch me up on #private-ops"));
    const ctxs = exec.contexts as ToolContext[];
    expect(ctxs).toHaveLength(2);
    for (const c of ctxs) expect(c.question).toBe("Catch me up on #private-ops");
    // One budget and one counter for the turn: shared by its calls.
    expect(ctxs[0].consultedSlack).toBe(ctxs[1].consultedSlack);
    expect(ctxs[0].clientUpdateCalls?.take()).toBe(true);
    expect(ctxs[1].clientUpdateCalls?.take()).toBe(false);
    const system = model.requests[0].system as { text: string }[];
    expect(system[0].text).toBe(CHAT_SYSTEM_PROMPT_V3);
    expect(CHAT_PROMPT_VERSION).toBe("exec-chat-v3");
  });

  it("D5 / D6: the consults go to the finish (refs, channels, the private flag) and the recheck runs on the answer", async () => {
    setModel([{ tools: [use("toolu_1", "search_slack", { q: "x" })] }, { text: ["Done [r1]."] }]);
    const { prepared, done } = await turnOnce(req("Anything in Slack?"));
    const input = vi.mocked(finishTurn).mock.calls[0][1];
    expect(input).toMatchObject({ slackRefs: [KEY], slackChannels: ["C0PRIVOPS"], privateSlack: true });
    expect(vi.mocked(recheckSlackAnswer).mock.calls).toEqual([[principal, prepared.begin.assistantMessageId]]);
    expect(done.answer).toBe("Done [r1].");   // clean: the answer as written (markers are numbered by the view)
  });

  it("a turn with no Slack consult: empty consults, and no recheck", async () => {
    setModel([{ tools: [use("toolu_1", "get_task", { q: "x" })] }, { text: ["Done [r1]."] }]);
    await turnOnce(req("Any task?"));
    expect(vi.mocked(finishTurn).mock.calls[0][1]).toMatchObject({ slackRefs: [], slackChannels: [], privateSlack: false });
    expect(recheckSlackAnswer).not.toHaveBeenCalled();
  });

  it("the recheck redacting → done carries SLACK_REDACTED_TEXT, no recommendations, no sources", async () => {
    vi.mocked(recheckSlackAnswer).mockResolvedValue("redacted");
    setModel([{ tools: [use("toolu_1", "search_slack", { q: "x" })] }, { text: ["Done [r1].\n\n**Suggested next steps**\n- Ask Sam"] }]);
    const { done } = await turnOnce(req("Anything in Slack?"));
    expect(done.answer).toBe(SLACK_REDACTED_TEXT);
    expect(done.recommendations).toBe("");
    expect(done.sources).toEqual([]);
  });

  it("the recheck unable to run → done carries SLACK_UNCHECKED_TEXT (fail closed); a throw counts the same", async () => {
    vi.mocked(recheckSlackAnswer).mockResolvedValue("unchecked");
    setModel([{ tools: [use("toolu_1", "search_slack", { q: "x" })] }, { text: ["Done [r1]."] }]);
    expect((await turnOnce(req("Anything in Slack?"))).done.answer).toBe(SLACK_UNCHECKED_TEXT);
    vi.mocked(recheckSlackAnswer).mockRejectedValue(new Error("boom"));
    setModel([{ tools: [use("toolu_1", "search_slack", { q: "x" })] }, { text: ["Done [r1]."] }]);
    expect((await turnOnce(req("Anything else in Slack?"))).done.answer).toBe(SLACK_UNCHECKED_TEXT);
  });

  it("a finish that wasn't saved (RPC 9 missing or failing): a Slack-consulting answer is hidden, the per-message write runs, no recheck", async () => {
    fdb.failures.set("finishTurn", { error: new Error("finish_v2_missing"), times: 1 });
    setModel([{ tools: [use("toolu_1", "search_slack", { q: "x" })] }, { text: ["Done [r1]."] }]);
    const { done, prepared } = await turnOnce(req("Anything in Slack?"));
    expect(done.saved).toBe(false);
    expect(done.answer).toBe(SLACK_UNCHECKED_TEXT);
    expect(recheckSlackAnswer).not.toHaveBeenCalled();
    expect(vi.mocked(redactChatMessage).mock.calls.some((c) => c[1] === prepared.begin.assistantMessageId && c[2] === SLACK_UNCHECKED_TEXT)).toBe(true);
  });

  it("N15 / C24: a replayed answer that consulted private Slack sets prior.privateSlack for the next turn's tools", async () => {
    setModel([{ tools: [use("toolu_1", "search_slack", { q: "x" })] }, { text: ["Done [r1]."] }]);
    const first = await turnOnce(req("Anything in Slack?"));
    // The store kept the flag (RPC 9); the replayed row carries it.
    first.stored.consultedPrivateSlack = true;
    setModel([{ tools: [use("toolu_2", "get_task", { q: "x" })] }, { text: ["Ok."] }]);
    await turnOnce(req("And the tasks?", { conversationId: first.prepared.begin.conversationId }));
    const ctxs = exec.contexts as ToolContext[];
    expect(ctxs.at(-1)?.prior.privateSlack).toBe(true);
    expect(ctxs[0].prior.privateSlack).toBe(false);
  });
});
