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
// Area A's store: the contract's in-memory stand-in.
vi.mock("@/lib/exec/chat-store", async () => (await import("./__tests__/fake-chat-db")).chatStoreModule(() => db.current as never));
// Area B's modules: the contract's stand-ins (bindings AM21).
vi.mock("@/lib/exec/agent/refs", async () => (await import("./__tests__/fake-tools")).fakeRefsModule);
vi.mock("@/lib/exec/agent/serialize", async () => (await import("./__tests__/fake-tools")).fakeSerializeModule);
vi.mock("@/lib/exec/agent/tool-defs", async () => (await import("./__tests__/fake-tools")).fakeToolDefsModule);
vi.mock("@/lib/exec/agent/tools", () => ({ executeToolCall: vi.fn(), createTurnMemo: vi.fn() }));
vi.mock("@/lib/exec/agent/budget", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/agent/budget")>()), chatSpentTodayUsd: vi.fn() }));
// Area F's purge by id, and the P3/P5a reads the turn makes.
vi.mock("@/lib/exec/drafts-store", async (orig) => (await import("./__tests__/b-stub")).stubOnly(await orig(), ["purgeDraftsByIds"]));
vi.mock("@/lib/exec/attention-read", () => ({ listScreenedAttention: vi.fn(), getScreenedAttentionItem: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => (await import("./__tests__/b-stub")).stubModule(await orig()));
vi.mock("@/lib/exec/email-store", async (orig) => (await import("./__tests__/b-stub")).stubOnly(await orig(), ["getEmailThread", "listThreadScreenRows"]));
vi.mock("@/lib/exec/sources/mail", async (orig) => (await import("./__tests__/b-stub")).stubOnly(await orig(), ["loadScreeningPolicy"]));

import { chatSpentTodayUsd } from "@/lib/exec/agent/budget";
import { createTurnMemo, executeToolCall, type TurnMemo } from "@/lib/exec/agent/tools";
import {
  newConversationTitle,
  prepareChatTurn,
  proposalViewFor,
  resolveChatContext,
  runPreparedTurn,
  storedMessageViews,
  storedTurnPayload,
  type ChatTurnRequest,
  type PreparedTurn
} from "@/lib/exec/agent/turn";
import type { AgentEventSink, ChatContextInput, RefEntry } from "@/lib/exec/agent/types";
import { getScreenedAttentionItem } from "@/lib/exec/attention-read";
import type { AttentionFeedItem } from "@/lib/exec/attention-types";
import { beginTurn, finishTurn, listRedactedSince, proposalContentHash, redactChatForThreads, redactChatMessage } from "@/lib/exec/chat-store";
import { FAILED_TEXT, REDACTED_TEXT, REFUSED_TEXT, UNCHECKED_TEXT } from "@/lib/exec/chat/copy";
import { purgeDraftsByIds } from "@/lib/exec/drafts-store";
import { getEmailThread, listThreadScreenRows } from "@/lib/exec/email-store";
import type { ThreadScreenRow } from "@/lib/exec/email-types";
import { callModel } from "@/lib/exec/llm/client";
import { DEFAULT_SETTINGS, principalFromRows } from "@/lib/exec/principal";
import { DdReadError, listClients, listDepartments, listProjects } from "@/lib/exec/sources/dd";
import { loadScreeningPolicy } from "@/lib/exec/sources/mail";
import type { ExecSettings } from "@/lib/exec/types";

import { scriptedModel, use, type Step } from "./__tests__/fake-anthropic";
import { FakeChatDb, FAKE_REDACTED_TEXT } from "./__tests__/fake-chat-db";
import { fakeExecutor, fakeMemo, itemResult, type ToolBehaviour } from "./__tests__/fake-tools";


// P5b contract §3.15 (C18, C21, C49, C55, b-agent-8): tests 63-68, 111, 116, and the stored-turn mappers (bindings AM17).

const principal = principalFromRows(
  { id: "ep_owner", user_id: "u_mitchell", enabled: true, mail_account_ids: ["acc_his"], slack_team_id: null, slack_user_id: null },
  { id: "u_mitchell", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
)!;
const NOW = new Date("2026-11-07T15:00:00.000Z");
const SETTINGS: ExecSettings = {
  ...DEFAULT_SETTINGS, principalId: principal.id, chatEnabled: true, chatSchemaReady: true, emailEnabled: true, emailSchemaReady: true
};
const ATTENTION_ID = `ea_${"1".repeat(32)}`;

let fdb: FakeChatDb;
let n = 0;

function setModel(steps: readonly Step[] | ((call: number) => Step)) {
  const model = scriptedModel(steps);
  vi.mocked(callModel).mockImplementation(model.callModel);
  return model;
}
function setExecutor(behaviours: Partial<Record<string, ToolBehaviour>> = {}) {
  const exec = fakeExecutor({ behaviours });
  vi.mocked(executeToolCall).mockImplementation(exec.executeToolCall);
  return exec;
}
function req(text: string, over: Partial<ChatTurnRequest> = {}): ChatTurnRequest {
  n += 1;
  return { conversationId: null, clientTurnId: `client-turn-${n}`, surface: "web", text, context: null, ...over };
}
type Started = Extract<PreparedTurn, { kind: "started" }>;
async function turnOnce(r: ChatTurnRequest, opts: { signal?: AbortSignal; sink?: AgentEventSink } = {}) {
  const prepared = await prepareChatTurn(principal, SETTINGS, r, NOW);
  expect(prepared.kind).toBe("started");
  const out = await runPreparedTurn(principal, SETTINGS, prepared as Started, r, { signal: opts.signal ?? new AbortController().signal, sink: opts.sink, now: NOW, binding: "error" });
  return { prepared: prepared as Started, ...out, stored: fdb.message((prepared as Started).begin.assistantMessageId)! };
}
const screenRow = (threadId: string, over: Partial<ThreadScreenRow> = {}): ThreadScreenRow => ({
  threadId, accountId: "acc_his", state: "triaged", screenHashes: [], screenTruncated: false, screenedPolicyHash: "h1", ...over
});
const emailOn = (): TurnMemo => ({ ...fakeMemo(), email: async () => ({ state: "on", usable: ["acc_his"], rules: [], policyHash: "h1" }) }) as TurnMemo;
const consultThreads = (...ids: string[]): ToolBehaviour => (call, ctx) => {
  ctx.consulted.admit(ids);
  return itemResult(ctx, { type: "email_thread", id: ids[0] }, "Re: invoice");
};

beforeEach(() => {
  fdb = new FakeChatDb();
  db.current = fdb;
  vi.mocked(chatSpentTodayUsd).mockResolvedValue(0);
  vi.mocked(createTurnMemo).mockImplementation(() => fakeMemo());
  vi.mocked(loadScreeningPolicy).mockResolvedValue({ rules: [], hash: "h1" });
  vi.mocked(listThreadScreenRows).mockResolvedValue(new Map());
  vi.mocked(purgeDraftsByIds).mockResolvedValue(0);
  vi.mocked(listDepartments).mockResolvedValue([{ id: "d_web", name: "Website", headUserId: null }]);
  vi.mocked(listProjects).mockResolvedValue([{ id: "p_site", name: "Zenith Site Rebuild", departmentId: "d_web", createdAt: "2026-09-01T00:00:00.000Z" }]);
  vi.mocked(listClients).mockResolvedValue([{ id: "c_acme", name: "Acme Dental" } as never]);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  setExecutor();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("newConversationTitle", () => {
  it("collapses whitespace and clips to 80 with an ellipsis", () => {
    expect(newConversationTitle("  Who has\n\toverdue   tasks? ")).toBe("Who has overdue tasks?");
    expect(newConversationTitle("x".repeat(80))).toBe("x".repeat(80));
    const long = newConversationTitle(`${"word ".repeat(30)}end`);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith(String.fromCharCode(0x2026))).toBe(true);
  });
});

describe("prepareChatTurn (test 63)", () => {
  const ctx = (kind: ChatContextInput["kind"], id: string) => req("What about this?", { context: { kind, id } });

  it("each context kind resolves to its target and a server-built source; the begin RPC reserves its ref", async () => {
    vi.mocked(getScreenedAttentionItem).mockResolvedValue({
      ok: true,
      item: { id: ATTENTION_ID, fingerprint: "email:thread:th_9:decision", refs: [{ system: "dd", id: "/executive/email/th_9", url: null, label: "Re: renewal", class: "private", excerpt: "secret" }] } as unknown as AttentionFeedItem
    });
    const att = (await prepareChatTurn(principal, SETTINGS, ctx("attention", ATTENTION_ID), NOW)) as Started;
    expect(att.kind).toBe("started");
    expect(att.context?.target).toEqual({ type: "attention", id: ATTENTION_ID, threadId: "th_9" });
    expect(att.context?.source).not.toHaveProperty("excerpt");
    expect(att.begin.contextRef).toBe("r1");
    // ui-1: the chip names the item by its title; with no title, by its source.
    vi.mocked(getScreenedAttentionItem).mockResolvedValueOnce({
      ok: true,
      item: { id: ATTENTION_ID, fingerprint: "dd:overdue_person:u_sam", title: "Sam Lee   has 4 overdue tasks", refs: [{ system: "dd", id: "t_1", url: null, label: "Fix the sitemap", class: "internal" }] } as unknown as AttentionFeedItem
    });
    const titled = await resolveChatContext(principal, SETTINGS, { kind: "attention", id: ATTENTION_ID }, NOW);
    expect(titled).toMatchObject({ ok: true, label: "Sam Lee has 4 overdue tasks", context: { source: { label: "Fix the sitemap" } } });
    expect(await resolveChatContext(principal, SETTINGS, { kind: "attention", id: ATTENTION_ID }, NOW)).toMatchObject({ ok: true, label: "Re: renewal" });

    const proj = (await prepareChatTurn(principal, SETTINGS, ctx("project", "p_site"), NOW)) as Started;
    expect(proj.context?.target).toEqual({ type: "project", id: "p_site" });
    expect(proj.context?.source.label).toBe("Zenith Site Rebuild");
    const client = (await prepareChatTurn(principal, SETTINGS, ctx("client", "c_acme"), NOW)) as Started;
    expect(client.context?.target).toEqual({ type: "client", id: "c_acme" });

    vi.mocked(createTurnMemo).mockImplementation(emailOn);
    vi.mocked(getEmailThread).mockResolvedValue({ ...screenRow("th_1"), subject: "Invoice 42" } as never);
    const thread = (await prepareChatTurn(principal, SETTINGS, ctx("thread", "th_1"), NOW)) as Started;
    expect(thread.context?.target).toEqual({ type: "email_thread", id: "th_1" });
    expect(thread.context?.source).toMatchObject({ label: "Invoice 42", class: "private" });
  });

  it("withheld or missing attention, a restricted or gone thread, email off, a bad id → context_unavailable / gone", async () => {
    for (const reason of ["withheld", "missing"] as const) {
      vi.mocked(getScreenedAttentionItem).mockResolvedValueOnce({ ok: false, reason });
      expect(await prepareChatTurn(principal, SETTINGS, ctx("attention", ATTENTION_ID), NOW)).toEqual({ kind: "context_unavailable", reason: "gone" });
    }
    expect(await prepareChatTurn(principal, SETTINGS, ctx("attention", "ea_bad"), NOW)).toEqual({ kind: "context_unavailable", reason: "gone" });
    expect(await prepareChatTurn(principal, SETTINGS, ctx("project", "p_nope"), NOW)).toEqual({ kind: "context_unavailable", reason: "gone" });
    // email off
    expect(await prepareChatTurn(principal, SETTINGS, ctx("thread", "th_1"), NOW)).toEqual({ kind: "context_unavailable", reason: "gone" });
    vi.mocked(createTurnMemo).mockImplementation(emailOn);
    for (const row of [null, screenRow("th_1", { state: "restricted_hidden" }), screenRow("th_1", { state: "gone" }), screenRow("th_1", { accountId: "acc_other" }), screenRow("th_1", { screenTruncated: true, screenedPolicyHash: "old" })]) {
      vi.mocked(getEmailThread).mockResolvedValueOnce(row as never);
      expect(await prepareChatTurn(principal, SETTINGS, ctx("thread", "th_1"), NOW)).toEqual({ kind: "context_unavailable", reason: "gone" });
    }
    expect(fdb.messages).toHaveLength(0);
  });

  it("screen_unavailable and a rules or row read failure → context_unavailable / check_failed; nothing stored", async () => {
    vi.mocked(getScreenedAttentionItem).mockResolvedValueOnce({ ok: false, reason: "screen_unavailable" });
    expect(await prepareChatTurn(principal, SETTINGS, ctx("attention", ATTENTION_ID), NOW)).toEqual({ kind: "context_unavailable", reason: "check_failed" });
    vi.mocked(createTurnMemo).mockImplementation(() => ({ ...fakeMemo(), email: async () => { throw new Error("rules unreadable"); } }) as TurnMemo);
    expect(await prepareChatTurn(principal, SETTINGS, ctx("thread", "th_1"), NOW)).toEqual({ kind: "context_unavailable", reason: "check_failed" });
    vi.mocked(createTurnMemo).mockImplementation(emailOn);
    vi.mocked(getEmailThread).mockRejectedValueOnce(new Error("row read"));
    expect(await prepareChatTurn(principal, SETTINGS, ctx("thread", "th_1"), NOW)).toEqual({ kind: "context_unavailable", reason: "check_failed" });
    vi.mocked(listProjects).mockRejectedValueOnce(new DdReadError("projects", "x"));
    expect(await prepareChatTurn(principal, SETTINGS, ctx("project", "p_site"), NOW)).toEqual({ kind: "context_unavailable", reason: "check_failed" });
    expect(fdb.messages).toHaveLength(0);
  });

  it("busy, busy_principal, rate_limited and not_found are mapped; the title is the clipped question; begin's limits are C49's", async () => {
    const r = req("  Who has   overdue tasks?  ");
    const started = await prepareChatTurn(principal, SETTINGS, r, NOW);
    expect(started.kind).toBe("started");
    expect(vi.mocked(beginTurn).mock.calls[0][1]).toMatchObject({
      title: "Who has overdue tasks?", retentionDays: 90, staleSeconds: 600, rateLimit: 30, rateWindowSeconds: 600, maxRunning: 2, surface: "web", context: null
    });
    fdb.beginOutcome = { outcome: "busy_principal" };
    expect(await prepareChatTurn(principal, SETTINGS, req("q"), NOW)).toEqual({ kind: "busy_principal" });
    fdb.beginOutcome = { outcome: "rate_limited", retryAfterSeconds: 42 };
    expect(await prepareChatTurn(principal, SETTINGS, req("q"), NOW)).toEqual({ kind: "rate_limited", retryAfterSeconds: 42 });
    fdb.beginOutcome = { outcome: "busy", conversationId: "ecv_x" };
    expect(await prepareChatTurn(principal, SETTINGS, req("q"), NOW)).toEqual({ kind: "busy", conversationId: "ecv_x" });
    fdb.beginOutcome = { outcome: "not_found" };
    expect(await prepareChatTurn(principal, SETTINGS, req("q"), NOW)).toEqual({ kind: "not_found" });
  });

  it("a replayed client turn id returns the stored turn and its conversation, and never re-runs", async () => {
    setModel([{ text: ["Ann [r1]."] }]);
    const r = req("Who is late?");
    const first = await turnOnce(r);
    const again = await prepareChatTurn(principal, SETTINGS, { ...r, conversationId: first.done.conversationId }, NOW);
    expect(again.kind).toBe("replay");
    if (again.kind !== "replay") return;
    expect(again.turn.assistant?.id).toBe(first.done.messageId);
    expect(again.conversation.id).toBe(first.done.conversationId);
    const payload = await storedTurnPayload(principal, again.conversation, again.turn, NOW);
    expect(payload).toMatchObject({ messageId: first.done.messageId, status: "complete", saved: true });
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("DB errors throw (the route answers 503)", async () => {
    fdb.fail("beginTurn", new Error("db down"));
    await expect(prepareChatTurn(principal, SETTINGS, req("q"), NOW)).rejects.toThrow("db down");
  });
});

describe("own signals (tests 64, 65, 68)", () => {
  it("64: with the request's signal aborted, the begin RPC, finishTurn and the screen's reads each get a live signal; aborted is stored", async () => {
    const request = new AbortController();
    request.abort();
    const model = setModel([{ text: ["never"] }]);
    const seeded = fdb.addConversation();
    fdb.seedTurn(seeded.id, { text: "Earlier?" }, { status: "complete", text: "Earlier answer." });
    const { done, stored } = await turnOnce(req("Now?", { conversationId: seeded.id }), { signal: request.signal });
    expect(model.callModel).not.toHaveBeenCalled();
    expect(stored.status).toBe("aborted");
    expect(stored.statusReason).toBe("client_abort");
    expect(done.status).toBe("aborted");
    for (const fn of ["beginTurn", "finishTurn", "listRedactedSince"]) {
      const calls = fdb.signals.filter((s) => s.fn === fn);
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        expect(c.signal).toBeInstanceOf(AbortSignal);
        expect(c.signal).not.toBe(request.signal);
        expect(c.abortedAtCall).toBe(false);
      }
    }
    expect(redactChatForThreads).not.toHaveBeenCalled();
    expect(redactChatMessage).not.toHaveBeenCalled();
  });

  it("64: the post-finish screen's reads get live signals too, after a disconnect mid-answer", async () => {
    const request = new AbortController();
    setExecutor({ search_email: consultThreads("th_1") });
    setModel([{ tools: [use("toolu_1", "search_email", { q: "x" })] }, { kind: "hang", text: ["Partial"] }]);
    // He closes the tab while the second round streams.
    const sink: AgentEventSink = { text: () => request.abort(), tool: () => undefined, retract: () => undefined };
    const screenSignals: (AbortSignal | undefined)[] = [];
    vi.mocked(listThreadScreenRows).mockImplementation(async (_p, _ids, opts) => {
      screenSignals.push(opts?.signal);
      expect(opts?.signal?.aborted).toBe(false);
      return new Map([["th_1", screenRow("th_1")]]);
    });
    const { stored } = await turnOnce(req("Q?", { context: null }), { signal: request.signal, sink });
    expect(stored.status).toBe("aborted");
    expect(stored.text).toBe("Partial");
    expect(stored.consultedEmailThreadIds).toEqual(["th_1"]);
    expect(screenSignals).toHaveLength(1);
    expect(screenSignals[0]).not.toBe(request.signal);
    const finish = fdb.signals.find((s) => s.fn === "finishTurn");
    expect(finish?.abortedAtCall).toBe(false);
    expect(redactChatMessage).not.toHaveBeenCalled();
  });

  it("65: a failed budget read → failed / internal, FAILED_TEXT, no model call", async () => {
    const model = setModel([{ text: ["x"] }]);
    vi.mocked(chatSpentTodayUsd).mockRejectedValueOnce(new Error("usage read"));
    const { done, stored, audit } = await turnOnce(req("Q?"));
    expect(model.callModel).not.toHaveBeenCalled();
    expect([stored.status, stored.statusReason, stored.text]).toEqual(["failed", "internal", FAILED_TEXT]);
    expect([done.status, done.answer, done.saved]).toEqual(["failed", FAILED_TEXT, true]);
    expect(audit).toEqual({ status: "failed", statusReason: "internal", modelCalls: 0, toolCalls: 0, costUsd: 0 });
  });

  it("68: done.saved is false when finishTurn returns false or throws", async () => {
    setModel([{ text: ["An answer."] }]);
    fdb.finishResult = false;
    expect((await turnOnce(req("Q1?"))).done.saved).toBe(false);
    fdb.finishResult = null;
    fdb.fail("finishTurn", new Error("timeout"), 1);
    const thrown = await turnOnce(req("Q2?"));
    expect(thrown.done.saved).toBe(false);
    expect(thrown.done.answer).toBe("An answer.");
    expect(vi.mocked(finishTurn).mock.calls.length).toBe(2);
  });
});

describe("the post-finish screen (test 66)", () => {
  it("a consulted thread tombstoned mid-turn → stored and done are REDACTED_TEXT, sources emptied, principal-wide redaction, chat drafts purged", async () => {
    setExecutor({
      search_email: consultThreads("th_1"),
      create_draft: (_c, ctx) => {
        ctx.cards.push({ kind: "draft", id: `ed_${"a".repeat(32)}`, existing: false, privateRefKinds: [] });
        return { ok: true, json: { draft: "started" } };
      }
    });
    setModel([{ tools: [use("toolu_1", "search_email", { q: "x" }), use("toolu_2", "create_draft", { q: "y" })] }, { text: ["The invoice is overdue [r1]."] }]);
    vi.mocked(listThreadScreenRows).mockResolvedValue(new Map([["th_1", screenRow("th_1", { state: "restricted_hidden" })]]));
    const { done, stored } = await turnOnce(req("Any invoice news?"));
    expect(redactChatForThreads).toHaveBeenCalledWith(principal, ["th_1"], expect.anything());
    expect(purgeDraftsByIds).toHaveBeenCalledWith(principal, [`ed_${"a".repeat(32)}`], expect.anything());
    expect(stored.text).toBe(REDACTED_TEXT);
    expect(stored.sources).toEqual([]);
    expect(done.answer).toBe(REDACTED_TEXT);
    expect(done.recommendations).toBe("");
    expect(done.sources).toEqual([]);
    expect(done.cards).toHaveLength(1);
    expect(FAKE_REDACTED_TEXT).toBe(REDACTED_TEXT);
  });

  it("loop-2: a finish that committed but missed its deadline (saved=false) is still hidden: the per-message write runs", async () => {
    setExecutor({ search_email: consultThreads("th_2") });
    setModel([{ tools: [use("toolu_1", "search_email", { q: "x" })] }, { text: ["Found it [r1]."] }]);
    vi.mocked(listThreadScreenRows).mockResolvedValue(new Map([["th_2", screenRow("th_2", { screenTruncated: true, screenedPolicyHash: "old" })]]));
    const realFinish = fdb.finishTurn.bind(fdb);
    fdb.finishTurn = async (input, signal) => {
      await realFinish(input, signal);
      throw new DOMException("The operation was aborted.", "AbortError");
    };
    const { done, stored } = await turnOnce(req("Q?"));
    expect(redactChatMessage).toHaveBeenCalledWith(principal, stored.id, UNCHECKED_TEXT, expect.anything());
    expect(stored.text).toBe(UNCHECKED_TEXT);
    expect(done.answer).toBe(UNCHECKED_TEXT);
  });

  it("loop-2: a finish that really failed → this turn's own chat drafts are purged though no card was stored", async () => {
    const draftId = `ed_${"b".repeat(32)}`;
    setExecutor({
      search_email: consultThreads("th_1"),
      create_draft: (_c, ctx) => {
        ctx.cards.push({ kind: "draft", id: draftId, existing: false, privateRefKinds: [] });
        return { ok: true, json: { draft: "started" } };
      }
    });
    setModel([{ tools: [use("toolu_1", "search_email", { q: "x" }), use("toolu_2", "create_draft", { q: "y" })] }, { text: ["Overdue [r1]."] }]);
    vi.mocked(listThreadScreenRows).mockResolvedValue(new Map([["th_1", screenRow("th_1", { state: "restricted_hidden" })]]));
    fdb.fail("finishTurn", new Error("finish failed"), 5);
    const { done } = await turnOnce(req("Any invoice news?"));
    expect(done.answer).toBe(REDACTED_TEXT);
    expect(purgeDraftsByIds).toHaveBeenCalledWith(principal, [draftId], expect.anything());
  });

  it("a stale_truncated verdict → this message only, UNCHECKED_TEXT, no principal-wide redaction", async () => {
    setExecutor({ search_email: consultThreads("th_2") });
    setModel([{ tools: [use("toolu_1", "search_email", { q: "x" })] }, { text: ["Found it [r1]."] }]);
    vi.mocked(listThreadScreenRows).mockResolvedValue(new Map([["th_2", screenRow("th_2", { screenTruncated: true, screenedPolicyHash: "old" })]]));
    const { done, stored } = await turnOnce(req("Q?"));
    expect(redactChatForThreads).not.toHaveBeenCalled();
    expect(purgeDraftsByIds).not.toHaveBeenCalled();
    expect(redactChatMessage).toHaveBeenCalledWith(principal, stored.id, UNCHECKED_TEXT, expect.anything());
    expect(stored.text).toBe(UNCHECKED_TEXT);
    expect(done.answer).toBe(UNCHECKED_TEXT);
  });

  it("a screen read failing once then succeeding → no redaction; failing twice → this message only, unchecked, no purge", async () => {
    setExecutor({ search_email: consultThreads("th_3") });
    setModel((call) => (call % 2 === 1 ? { tools: [use(`toolu_${call}`, "search_email", { q: "x" })] } : { text: ["Clean [r1]."] }));
    vi.mocked(listThreadScreenRows).mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce(new Map([["th_3", screenRow("th_3")]]));
    const once = await turnOnce(req("Q1?"));
    expect(once.stored.text).toBe("Clean [r1].");
    expect(redactChatMessage).not.toHaveBeenCalled();

    vi.mocked(listThreadScreenRows).mockRejectedValue(new Error("down"));
    const twice = await turnOnce(req("Q2?"));
    expect(twice.stored.text).toBe(UNCHECKED_TEXT);
    expect(twice.done.answer).toBe(UNCHECKED_TEXT);
    expect(redactChatForThreads).not.toHaveBeenCalled();
    expect(purgeDraftsByIds).not.toHaveBeenCalled();
    expect(vi.mocked(redactChatMessage).mock.calls.map((c) => c[1])).toEqual([twice.stored.id]);
  });

  it("an earlier answer of the conversation redacted during the turn → this one is redacted too (REDACTED_TEXT when that was verified)", async () => {
    const conv = fdb.addConversation();
    const earlier = fdb.seedTurn(conv.id, { text: "Earlier?" }, { status: "complete", text: "It said X." });
    setModel([
      {
        kind: "fn",
        run: async () => {
          // A tombstone lands while this turn runs and redacts the earlier answer.
          const m = fdb.message(earlier.assistant!.id)!;
          m.text = FAKE_REDACTED_TEXT;
          m.redactedAt = new Date(fdb.clock + 5_000).toISOString();
          const { fakeMessage } = await import("./__tests__/fake-anthropic");
          return { message: fakeMessage({ text: ["Following up on X."] }), refused: false, truncated: false, costUsd: 0.01, latencyMs: 1, requestId: null };
        }
      }
    ]);
    const { done, stored } = await turnOnce(req("And then?", { conversationId: conv.id }));
    expect(redactChatMessage).toHaveBeenCalledWith(principal, stored.id, REDACTED_TEXT, expect.anything());
    expect(stored.text).toBe(REDACTED_TEXT);
    expect(done.answer).toBe(REDACTED_TEXT);
    expect(listRedactedSince).toHaveBeenCalled();
  });

  it("an answer that re-cites an earlier answer's [rX] without reading X stores X's thread in consulted", async () => {
    const conv = fdb.addConversation({ refSeq: 3 });
    const earlierRef: RefEntry = { ref: "r3", target: { type: "email_thread", id: "th_old" }, source: { system: "dd", id: "/executive/email/th_old", url: null, label: "Email thread", class: "private" } };
    fdb.seedTurn(conv.id, { text: "Earlier?" }, { status: "complete", text: "See [r3].", sources: [earlierRef] });
    setModel([{ text: ["As before [r3]."] }]);
    const { stored } = await turnOnce(req("Again?", { conversationId: conv.id }));
    expect(stored.finish?.consultedEmailThreadIds).toEqual(["th_old"]);
    expect(stored.sources.map((s) => s.ref)).toEqual(["r3"]);
  });
});

describe("refs across turns (tests 67, 111) and declined questions (test 116)", () => {
  it("67: a previously cited ref can be cited again; a previously issued but uncited one is unknown; an earlier context ref is citable", async () => {
    const conv = fdb.addConversation({ refSeq: 4 });
    const cited: RefEntry = { ref: "r3", target: { type: "task", id: "t_3" }, source: { system: "dd", id: "t_3", url: null, label: "Task 3", class: "internal" } };
    fdb.seedTurn(conv.id, { text: "About the project?", context: { kind: "project", id: "p_site", ref: "r1" } }, { status: "complete", text: "See [r3].", sources: [cited] });
    setModel([{ text: ["Still [r3], not [r4], and [r1]."] }]);
    const { done } = await turnOnce(req("Update?", { conversationId: conv.id }));
    expect(done.answer).toBe("Still [r3], not , and [r1].");
    expect(done.sources.map((s) => [s.n, s.ref])).toEqual([[1, "r3"], [2, "r1"]]);
  });

  it("111: turn 2 can call get_source on turn 1's context ref and cite it; an unavailable earlier context is skipped; at most 5 are re-resolved", async () => {
    const conv = fdb.addConversation({ refSeq: 1 });
    fdb.seedTurn(conv.id, { text: "Blocking?", context: { kind: "project", id: "p_site", ref: "r1" } }, { status: "complete", text: "Stage 2 [r1]." });
    const seen: (RefEntry | null)[] = [];
    setExecutor({
      get_source: (call, ctx) => {
        seen.push(ctx.refs.citable(String(call.input.q)));
        return { ok: true, json: { source: { ref: call.input.q } } };
      }
    });
    setModel([{ tools: [use("toolu_1", "get_source", { q: "r1" })] }, { text: ["Still blocked [r1]."] }]);
    const { done } = await turnOnce(req("And now?", { conversationId: conv.id }));
    expect(seen[0]?.target).toEqual({ type: "project", id: "p_site" });
    expect(done.answer).toBe("Still blocked [r1].");
    expect(done.sources.map((s) => s.ref)).toEqual(["r1"]);

    // Cited in turn 2, r1 stays citable (C6) even once the project is gone…
    vi.mocked(listProjects).mockResolvedValue([]);
    setModel([{ text: ["Was [r1]."] }]);
    expect((await turnOnce(req("Still?", { conversationId: conv.id }))).done.answer).toBe("Was [r1].");
    // …but an earlier context that was never cited and no longer resolves is skipped: its ref is unknown.
    const uncited = fdb.addConversation({ refSeq: 1 });
    fdb.seedTurn(uncited.id, { text: "Blocking?", context: { kind: "project", id: "p_site", ref: "r1" } }, { status: "complete", text: "Stage 2." });
    setModel([{ text: ["Was [r1]."] }]);
    const gone = await turnOnce(req("Still?", { conversationId: uncited.id }));
    expect(gone.done.answer).toBe("Was .");

    // Seven distinct earlier contexts: only the 5 newest are re-resolved.
    const many = fdb.addConversation({ refSeq: 7 });
    for (let i = 1; i <= 7; i++) fdb.seedTurn(many.id, { text: `Q${i}?`, context: { kind: "client", id: `c_${i}`, ref: `r${i}` } }, { status: "complete", text: `A${i}.` });
    vi.mocked(listClients).mockClear();
    vi.mocked(listClients).mockResolvedValue(Array.from({ length: 7 }, (_, i) => ({ id: `c_${i + 1}`, name: `Client ${i + 1}` }) as never));
    setModel([{ text: ["[r7][r3][r2]"] }]);
    const capped = await turnOnce(req("Summary?", { conversationId: many.id }));
    expect(listClients).toHaveBeenCalledTimes(5);
    expect(capped.done.answer).toBe("[r7][r3]");
  });

  it("116: a refused turn followed by a turn: the replay holds the placeholder, never the refused question", async () => {
    const model = setModel([{ refused: true, stopDetails: { type: "refusal", category: "cyber" } }, { text: ["Sure."] }]);
    const first = await turnOnce(req("How do I break into the payroll system?"));
    expect(first.stored.status).toBe("refused");
    expect(first.done.answer).toBe(REFUSED_TEXT);
    await turnOnce(req("Who is late today?", { conversationId: first.done.conversationId }));
    const second = JSON.stringify(model.requests[1].messages);
    expect(second).toContain("[A question that was declined.]");
    expect(second).not.toContain("payroll");
    expect(second).toContain("Who is late today?");
  });
});

describe("the done payload and the stored-turn mappers (bindings AM17)", () => {
  it("done numbers sources, resolves proposal and draft cards, and carries the conversation title", async () => {
    setExecutor({
      propose_task: (_c, ctx) => {
        const row = fdb.addProposal({
          conversationId: ctx.conversationId, messageId: ctx.assistantMessageId, title: "Call Ann", description: "About the invoice.",
          assigneeUserId: "u_ann", assigneeName: "Ann", departmentId: "d_web", dueOn: "2026-11-09", dueAt: "2026-11-09T22:00:00.000Z",
          clientName: "Acme Dental", priority: "high", expiresAt: "2026-11-14T15:00:00.000Z"
        });
        ctx.cards.push({ kind: "task_proposal", id: row.id });
        ctx.markDdText();
        return { ok: true, json: { staged: true } };
      },
      create_draft: (_c, ctx) => {
        ctx.cards.push({ kind: "draft", id: `ed_${"b".repeat(32)}`, existing: true, privateRefKinds: ["dd_text"] });
        return { ok: true, json: {} };
      }
    });
    setModel([{ tools: [use("toolu_1", "propose_task", { q: "a" }), use("toolu_2", "create_draft", { q: "b" }), use("toolu_3", "search_tasks", { q: "c" })] }, { text: ["Staged [r1]."] }]);
    const { done } = await turnOnce(req("Stage a task for Ann about the Acme invoice"));
    expect(done.conversationTitle).toBe("Stage a task for Ann about the Acme invoice");
    expect(done.sources.map((s) => [s.n, s.ref])).toEqual([[1, "r1"]]);
    expect(done.cards).toHaveLength(2);
    const [proposal, draft] = done.cards;
    expect(proposal.kind).toBe("task_proposal");
    if (proposal.kind === "task_proposal") {
      expect(proposal.proposal).toMatchObject({ title: "Call Ann", departmentName: "Website", status: "pending", privacyNotice: true, redacted: false, taskHref: null });
      expect(proposal.proposal.contentHash).toBe(proposalContentHash(fdb.proposals[0]));
    }
    expect(draft).toEqual({ kind: "draft", draftId: `ed_${"b".repeat(32)}`, href: `/executive/email/drafts/ed_${"b".repeat(32)}`, existing: true, privateRefKinds: ["dd_text"] });
  });

  it("storedMessageViews: two views per turn, contexts, a stale running answer as failed / stale, expired proposals, redaction", async () => {
    const conv = fdb.addConversation();
    const src: RefEntry = { ref: "r2", target: { type: "task", id: "t_2" }, source: { system: "dd", id: "t_2", url: null, label: "Task 2", class: "internal" } };
    const t1 = fdb.seedTurn(conv.id, { text: "First?", context: { kind: "client", id: "c_acme", ref: "r1" } }, { status: "complete", text: "Yes [r2].", sources: [src], cards: [] });
    const t2 = fdb.seedTurn(conv.id, { text: "Second?" }, { status: "complete", text: REDACTED_TEXT, redactedAt: "2026-11-07T15:00:30.000Z", consultedEmailThreadIds: ["th_1"] });
    const p = fdb.addProposal({
      conversationId: conv.id, messageId: t2.assistant!.id, title: "T", description: "D", assigneeUserId: null, assigneeName: null, departmentId: null,
      dueOn: null, dueAt: null, clientName: null, priority: "low", expiresAt: "2026-11-01T00:00:00.000Z"
    });
    fdb.message(t2.assistant!.id)!.cards = [{ kind: "task_proposal", id: p.id }];
    const t3 = fdb.seedTurn(conv.id, { text: "Third?" }, { status: "running", text: "" });
    fdb.message(t3.assistant!.id)!.createdAt = new Date(NOW.getTime() - 601_000).toISOString();
    const views = await storedMessageViews(principal, fdb.turnsOf(conv.id), NOW);
    expect(views.map((v) => [v.role, v.status])).toEqual([
      ["user", "complete"], ["assistant", "complete"], ["user", "complete"], ["assistant", "complete"], ["user", "complete"], ["assistant", "failed"]
    ]);
    expect(views[0].contextKind).toBe("client");
    expect(views[1].sources).toEqual([{ n: 1, ref: "r2", source: src.source }]);
    expect(views[3].redacted).toBe(true);
    expect(views[3].cards[0]).toMatchObject({ kind: "task_proposal", proposal: { status: "expired", privacyNotice: true, departmentName: null } });
    expect(views[5]).toMatchObject({ statusReason: "stale", text: FAILED_TEXT });
    expect(t1.user.id).toBe(views[0].id);
  });

  it("proposalViewFor: the card for the confirm route's 409; an unreadable roster falls back to the id; an unknown message shows the notice", async () => {
    const conv = fdb.addConversation();
    const t = fdb.seedTurn(conv.id, { text: "Q?" }, { status: "complete", text: "A." });
    const row = fdb.addProposal({
      conversationId: conv.id, messageId: t.assistant!.id, title: "Call Ann", description: "", assigneeUserId: "u_ann", assigneeName: "Ann", departmentId: "d_web",
      dueOn: null, dueAt: null, clientName: null, priority: "medium", expiresAt: "2026-11-14T00:00:00.000Z"
    });
    row.status = "confirmed";
    row.taskId = "t_abc";
    const view = await proposalViewFor(principal, row, NOW);
    expect(view).toMatchObject({ status: "confirmed", taskHref: "/tasks/t_abc", departmentName: "Website", privacyNotice: false, contentHash: proposalContentHash(row) });
    vi.mocked(listDepartments).mockRejectedValueOnce(new Error("down"));
    expect((await proposalViewFor(principal, { ...row, messageId: "ecm_unknown" }, NOW)).departmentName).toBe("d_web");
    expect((await proposalViewFor(principal, { ...row, messageId: "ecm_unknown" }, NOW)).privacyNotice).toBe(true);
  });

  it("resolveChatContext never takes a label from the caller and never throws for a read failure", async () => {
    vi.mocked(listClients).mockRejectedValueOnce(new Error("x"));
    expect(await resolveChatContext(principal, SETTINGS, { kind: "client", id: "c_acme" }, NOW)).toEqual({ ok: false, reason: "check_failed" });
    expect(await resolveChatContext(principal, SETTINGS, { kind: "nope" as never, id: "x" }, NOW)).toEqual({ ok: false, reason: "gone" });
  });
});
