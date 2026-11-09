import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-rate", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-rate")>()), takeSlackBudget: vi.fn(), noteSlackRateLimited: vi.fn() }));
vi.mock("@/lib/exec/dd-bot", () => ({ getDdBotIdentity: vi.fn() }));
vi.mock("@/lib/exec/llm/client", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/llm/client")>()), callModel: vi.fn() }));
vi.mock("@/lib/exec/llm/usage", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/llm/usage")>()), featureSpentTodayUsd: vi.fn() }));

import { createFakeSlackReadDb, type FakeSlackReadDb, type FakeSlackReadDbSeed } from "@/lib/exec/__tests__/fake-slack-read-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { installFakeSlack, SLACK_READ_RECORDED, slackReadError, type FakeSlackCall, type FakeSlackHandler } from "@/lib/exec/__tests__/fake-slack-api";
import { ITEM_TEXT_KEYS, SLACK_TEXT_SENTINELS as S, assertNoSlackText, captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { DD_BOT, HIM, INST, NOW, NOW_MS, PID, PRINCIPAL, TOKEN_KEY, channelDbRow, historyPage, installationDbRow, itemDbRow, jobCtx, messageDbRow, rawMessage, settings } from "@/lib/exec/__tests__/slack-read-jobs";
import { sealSecret } from "@/lib/exec/crypto";
import { getDdBotIdentity } from "@/lib/exec/dd-bot";
import { slackTriageJobHandler } from "@/lib/exec/handlers/slack-triage";
import { callModel } from "@/lib/exec/llm/client";
import { featureSpentTodayUsd } from "@/lib/exec/llm/usage";
import { loadSettings } from "@/lib/exec/principal";
import { __resetSlackReadForTests } from "@/lib/exec/slack-read";
import { markDeleted, writeTriageResult } from "@/lib/exec/slack-read-store";
import { takeSlackBudget } from "@/lib/exec/slack-rate";
import { SLACK_TRIAGE_PLACEHOLDERS, slackContentHash } from "@/lib/exec/triage/slack";
import type { ItemWriteRow } from "@/lib/exec/slack-read-types";
import { BudgetExceededError } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7a contract §3.11.5, §5.11 TS01-TS16 / CC02-CC07, §5.7 DM01-DM04 / DM06 / DM09, §5.10 XC09 / XC10, §5.12 EX04 / EX06, §5.8 PG17
// (the triage half) (Area D): exec.slack-triage against fake-slack-read-db (the store and its writer for real), the model at
// callModel's boundary, Slack through fake-slack-api.

let db: FakeSlackReadDb;
let out: ReturnType<typeof captureConsole>;
const IM = (over: Row = {}) => channelDbRow({ channel_id: "D0JANE", conv_type: "im", is_private: true, name: null, im_user_id: "U0JANE", ...over });
const T1 = "1794149000.000100";
const T2 = "1794149100.000100";
function useDb(tables: Partial<Record<string, Row[]>>, seed: Partial<FakeSlackReadDbSeed> = {}): FakeSlackReadDb {
  db = createFakeSlackReadDb({ now: () => new Date(), tables: tables as never, slack: { tables: { exec_slack_installations: [installationDbRow(sealSecret)] } }, ...seed });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const cand = (ts: string, over: Row = {}) => messageDbRow({ channel_id: "D0JANE", ts, reasons: 1, ...over });
const imDb = (msgs: Row[] = [cand(T1)], ch: Row = IM(), extra: Partial<Record<string, Row[]>> = {}) => useDb({ exec_slack_channels: [ch], exec_slack_messages: msgs, ...extra });
const say = (ts: string, text: string, over: Record<string, unknown> = {}) => rawMessage(ts, { text, ...over });
const DEFAULT_TEXT = "Can you approve the Q4 budget for the new hires before Friday please";
function slack(over: Record<string, FakeSlackHandler> = {}, messages: Record<string, unknown>[] = [say(T1, DEFAULT_TEXT)]) {
  return installFakeSlack({
    "conversations.history": (body) => historyPage(body.inclusive === "true" ? messages : []),
    "conversations.replies": () => historyPage(messages),
    "users.info": (body) => SLACK_READ_RECORDED.usersInfo(String(body.user)),
    "chat.getPermalink": (body) => SLACK_READ_RECORDED.permalink(String(body.channel)),
    ...over
  });
}
const modelSays = (items: unknown[], injection = false) =>
  vi.mocked(callModel).mockResolvedValue({ message: { content: [{ type: "text", text: JSON.stringify({ items, injection_suspected: injection }) }], stop_details: null } as never,
    refused: false, truncated: false, costUsd: 0.001, latencyMs: 5, requestId: "req_1" });
const item = (msg: string, over: Record<string, unknown> = {}) => ({ msg, kind: "request", addressed_to_you: true, needs_response: true, urgency: "high",
  summary: "Asks you to approve a budget.", due_date: "", due_text: "", commitment_direction: "none", evidence: "", ...over });
const run = (payload: Record<string, unknown> = {}) =>
  slackTriageJobHandler.run(jobCtx("exec.slack-triage", { installation_id: INST, channel: "D0JANE", root: "c", mode: "window", ...payload }, { lane: "interactive" }));
const msgRow = (ts: string) => db.tables.exec_slack_messages.find((m) => m.ts === ts);
const items = () => db.tables.exec_slack_items;
const methods = (calls: FakeSlackCall[]) => calls.map((c) => c.method);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("EXEC_TOKEN_KEY", TOKEN_KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  out = captureConsole();
  __resetSlackReadForTests();
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(takeSlackBudget).mockResolvedValue(undefined);
  vi.mocked(featureSpentTodayUsd).mockResolvedValue(0.1);
  vi.mocked(getDdBotIdentity).mockResolvedValue({ teamId: "T0SCALED", userId: DD_BOT.userId, botId: "B0DDBOT", appId: DD_BOT.appId, checkedAt: NOW.toISOString() });
  modelSays([item("M1")]);
});
afterEach(() => {
  out.assertClean();
  // EX04: no job of any kind carries an excerpt, a summary or message text; no RPC argument but the writer's text keys does.
  assertNoSlackText(db.tables.exec_jobs.map((j) => j.payload), { label: "job payloads" });
  assertNoSlackText(db.calls.filter((c) => c.kind === "rpc").map((c) => c.payload), { label: "rpc", ignoreKeys: ITEM_TEXT_KEYS });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("the happy path", () => {
  it("TS01 / TS14 fetches the IM window, one users.info per author, one model call, writes the item with its excerpt, permalinks", async () => {
    imDb([cand(T1), cand(T2)]);
    const s = slack({}, [say(T1, DEFAULT_TEXT), say(T2, "and also the hiring plan for the spring team please")]);
    const r = await run();
    expect(r).toMatchObject({ written: 1, assessed: 2, model: "ok" });
    expect(methods(s.calls)).toEqual(["conversations.history", "conversations.history", "users.info", "chat.getPermalink"]);
    expect(s.calls[0].body).toMatchObject({ channel: "D0JANE", oldest: T1, inclusive: "true", limit: "200" });
    expect(s.calls[1].body).toMatchObject({ channel: "D0JANE", latest: T1, limit: "8" });
    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(1);
    expect(items()).toEqual([expect.objectContaining({ ts: T1, kind: "request", assessed: true, excerpt: DEFAULT_TEXT, author_label: "Sentinel Slackauthor",
      permalink: "https://scaledai.slack.com/archives/D0JANE/p1794150001000101", source_class: "private" })]);
    expect(msgRow(T1)).toMatchObject({ role: "item", triage_state: "assessed", content_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(msgRow(T2)).toMatchObject({ role: "candidate", triage_state: "assessed" });
    assertNoSlackText(r, { label: "result" });
  });
});

describe("TS06 / TS07 / TS15: scope and the switch", () => {
  it("TS06 an owner-muted channel: his-thread-only candidates skipped; DMs / mentions triaged with bypass_mute", async () => {
    useDb({ exec_slack_channels: [channelDbRow({ watch_state: "muted", mute_source: "owner" })], exec_slack_messages: [
      messageDbRow({ ts: T1, reasons: 2 }), messageDbRow({ ts: T2, reasons: 4, thread_ts: null })
    ] });
    slack({}, [say(T1, DEFAULT_TEXT), say(T2, "the thread reply about lunch plans")]);
    modelSays([item("M1")]);
    await run({ channel: "C0GENERAL", root: T1 });
    expect(items()).toEqual([expect.objectContaining({ ts: T1, bypass_mute: true })]);
  });

  it("TS06 a default_finance mute: every candidate skipped — no fetch, no label lookup, no model call", async () => {
    useDb({ exec_slack_channels: [channelDbRow({ class: "finance", finance_name: true, watch_state: "muted", mute_source: "default_finance" })],
      exec_slack_messages: [messageDbRow({ ts: T1, reasons: 1 })] });
    const s = slack();
    expect(await run({ channel: "C0GENERAL", root: T1 })).toMatchObject({ skipped: "finance_muted" });
    expect(s.calls).toEqual([]);
    expect(callModel).not.toHaveBeenCalled();
    expect(msgRow(T1)).toMatchObject({ triage_state: "skipped" });
  });

  it("TS07 a deny / hub / unwatched channel at job time → skipped, no fetch", async () => {
    for (const ch of [IM({ class: "deny", deny_reason: "bot_im", watch_state: "unwatched", is_member: false }), IM({ class: "hub", hub_kind: "outbound" }), IM({ watch_state: "unwatched" })]) {
      imDb([cand(T1)], ch);
      const s = slack();
      expect(await run()).toEqual({ skipped: "channel" });
      expect(s.calls).toEqual([]);
      s.restore();
    }
  });

  it("TS15 the switch off → skipped before any fetch, users.info or model call; the candidates stay pending", async () => {
    imDb();
    const s = slack();
    vi.mocked(loadSettings).mockResolvedValue(settings({ slackReadingEnabled: false }));
    expect(await run()).toEqual({ skipped: "reading_off" });
    expect(s.calls).toEqual([]);
    expect(callModel).not.toHaveBeenCalled();
    expect(msgRow(T1)).toMatchObject({ triage_state: "pending" });
  });

  it("TS15 the switch turned off between the fetch and the model call → no call, nothing written", async () => {
    imDb();
    slack();
    vi.mocked(loadSettings).mockResolvedValueOnce(settings()).mockResolvedValueOnce(settings()).mockResolvedValue(settings({ slackReadingEnabled: false }));
    expect(await run()).toEqual({ skipped: "reading_off" });
    expect(callModel).not.toHaveBeenCalled();
    expect(items()).toEqual([]);
    expect(msgRow(T1)).toMatchObject({ triage_state: "pending" });
  });
});

describe("TS-FX: the P7a fixer's triage rules", () => {
  const ROOT = "1794140000.000100";
  const topOnly = (messages: Record<string, unknown>[]) => (body: Record<string, unknown>) =>
    // conversations.history never returns a thread reply that wasn't broadcast (only the top-level messages).
    historyPage(body.inclusive === "true" ? messages.filter((m) => m.thread_ts === undefined || m.thread_ts === m.ts) : []);

  it("TS-FX1 (correctness-1): an edit of a stored thread reply is re-triaged from its thread (conversations.replies of the root), never marked deleted", async () => {
    const hash = slackContentHash(DEFAULT_TEXT);
    useDb({ exec_slack_channels: [channelDbRow()], exec_slack_messages: [messageDbRow({ ts: T1, thread_ts: ROOT, reasons: 2, role: "item", triage_state: "assessed", content_hash: hash })],
      exec_slack_items: [itemDbRow({ ts: T1, thread_ts: ROOT, excerpt: null })] });
    const messages = [say(ROOT, "the thread root about the budget", { thread_ts: ROOT, reply_count: 1 }), say(T1, DEFAULT_TEXT, { thread_ts: ROOT })];
    const s = slack({ "conversations.history": topOnly(messages) }, messages);
    // v2 4c names the edited ts itself as the root.
    expect(await run({ channel: "C0GENERAL", root: T1, mode: "retriage", ts: T1 })).toMatchObject({ retriage: "unchanged", written: 1 });
    expect(methods(s.calls).filter((m) => m.startsWith("conversations."))).toEqual(["conversations.replies"]);
    expect(s.calls.find((c) => c.method === "conversations.replies")?.body).toMatchObject({ channel: "C0GENERAL", ts: ROOT });
    expect(db.tables.exec_slack_deleted).toEqual([]);
    expect(items()).toEqual([expect.objectContaining({ ts: T1, excerpt: DEFAULT_TEXT })]);
  });

  it("TS-FX2 (correctness-8): an edit of a muted message that isn't a DM or a mention writes nothing (its items stay for the unmute, N11); no fetch", async () => {
    useDb({ exec_slack_channels: [channelDbRow({ watch_state: "muted", mute_source: "owner" })],
      exec_slack_messages: [messageDbRow({ ts: T1, thread_ts: ROOT, reasons: 4, role: "item", triage_state: "assessed" })],
      exec_slack_items: [itemDbRow({ ts: T1, thread_ts: ROOT, excerpt: null })] });
    const s = slack();
    expect(await run({ channel: "C0GENERAL", root: T1, mode: "retriage", ts: T1 })).toEqual({ skipped: "muted" });
    expect(s.calls).toEqual([]);
    expect(items()).toHaveLength(1);
    expect(msgRow(T1)).toMatchObject({ role: "item", triage_state: "assessed" });
    expect(db.calls.filter((c) => c.kind === "rpc" && c.target === "exec_slack_write_items")).toEqual([]);
    // The finance default mute: the same, never a write.
    useDb({ exec_slack_channels: [channelDbRow({ class: "finance", finance_name: true, watch_state: "muted", mute_source: "default_finance" })],
      exec_slack_messages: [messageDbRow({ ts: T1, reasons: 2, role: "item", triage_state: "assessed" })], exec_slack_items: [itemDbRow({ ts: T1, excerpt: null, source_class: "finance" })] });
    expect(await run({ channel: "C0GENERAL", root: T1, mode: "retriage", ts: T1 })).toEqual({ skipped: "finance_muted" });
    expect(items()).toHaveLength(1);
  });

  it("TS-FX3 (security-3): a rename into a lead name (deny) or a finance name while the job fetched → the text is never sent, nothing written", async () => {
    const renames: [string, Row][] = [
      ["deny", { class: "deny", deny_reason: "lead_name", name: null, watch_state: "unwatched", mute_source: null, is_member: false, is_private: true }],
      ["finance", { class: "finance", finance_name: true, watch_state: "muted", mute_source: "default_finance" }],
      ["unwatched", { watch_state: "unwatched" }]
    ];
    for (const [label, change] of renames) {
      vi.mocked(callModel).mockClear();
      useDb({ exec_slack_channels: [channelDbRow()], exec_slack_messages: [messageDbRow({ ts: T1, reasons: 2 })] });
      const s = slack({
        "conversations.history": (body) => {
          // The concurrent v2 rename lands while the window is being fetched.
          Object.assign(db.tables.exec_slack_channels[0], change);
          return historyPage(body.inclusive === "true" ? [say(T1, DEFAULT_TEXT)] : []);
        }
      });
      expect(await run({ channel: "C0GENERAL", root: T1 }), label).toEqual({ skipped: "channel" });
      expect(callModel, label).not.toHaveBeenCalled();
      expect(items(), label).toEqual([]);
      expect(msgRow(T1), label).toMatchObject({ triage_state: "pending" });
      s.restore();
    }
  });
});

describe("TS10-TS13, TS16: the fetch, retriage, failures, permalinks, placeholders", () => {
  it("TS10 a candidate missing from a fully paged fetch → marked deleted (absent), not triaged", async () => {
    imDb([cand(T1), cand(T2)]);
    slack({}, [say(T1, DEFAULT_TEXT)]);
    await run();
    expect(db.tables.exec_slack_deleted.map((d) => [d.ts, d.reason])).toEqual([[T2, "absent"]]);
    expect(msgRow(T2)).toBeUndefined();
  });

  it("C16 a candidate fetched as a tombstone → marked deleted (tombstone), never sent", async () => {
    useDb({ exec_slack_channels: [channelDbRow()], exec_slack_messages: [messageDbRow({ ts: T1, reasons: 2 }), messageDbRow({ ts: T2, thread_ts: T1, reasons: 4 })] });
    slack({}, [rawMessage(T1, { user: "USLACKBOT", subtype: "tombstone", hidden: true, thread_ts: T1, text: "This message was deleted." }), say(T2, "a reply", { thread_ts: T1 })]);
    modelSays([item("M1")]);
    await run({ channel: "C0GENERAL", root: T1 });
    expect(db.tables.exec_slack_deleted.map((d) => [d.ts, d.reason])).toEqual([[T1, "tombstone"]]);
    expect(msgRow(T2)).toBeDefined();
  });

  it("TS11 / EX06 retriage: an unchanged text re-writes the excerpt with no model call; a changed one is triaged from the NEW text", async () => {
    const hash = slackContentHash(DEFAULT_TEXT);
    imDb([cand(T1, { role: "item", triage_state: "assessed", content_hash: hash, edited_ts: "1794149500.000000" })], IM(),
      { exec_slack_items: [itemDbRow({ channel_id: "D0JANE", ts: T1, excerpt: null, source_class: "private" })] });
    slack();
    expect(await run({ mode: "retriage", root: "c", ts: T1 })).toMatchObject({ retriage: "unchanged", written: 1 });
    expect(callModel).not.toHaveBeenCalled();
    expect(items()[0]).toMatchObject({ excerpt: DEFAULT_TEXT, summary: S.summary });
    // Changed: the model runs on the new text and the excerpt is the new text.
    imDb([cand(T1, { role: "item", triage_state: "assessed", content_hash: hash })], IM(), { exec_slack_items: [itemDbRow({ channel_id: "D0JANE", ts: T1, excerpt: null })] });
    const edited = "Actually please approve the revised Q1 budget for the spring hires instead";
    installFakeSlack({ "conversations.history": (body) => historyPage(body.inclusive === "true" ? [say(T1, edited)] : []), "users.info": () => SLACK_READ_RECORDED.usersInfo(),
      "chat.getPermalink": () => SLACK_READ_RECORDED.permalink("D0JANE") });
    modelSays([item("M1")]);
    await run({ mode: "retriage", root: "c", ts: T1 });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(items()[0]).toMatchObject({ excerpt: edited });
    expect(msgRow(T1)?.content_hash).toBe(slackContentHash(edited));
  });

  it("TS12 refused / truncated / invalid → DM and mention candidates become unassessed (refused / failed), his-thread-only skipped", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ refused: true, truncated: false, message: { content: [], stop_details: null } }, "refused"],
      [{ refused: false, truncated: true, message: { content: [{ type: "text", text: "{" }], stop_details: null } }, "failed"],
      [{ refused: false, truncated: false, message: { content: [{ type: "text", text: "nope" }], stop_details: null } }, "failed"]
    ];
    for (const [result, state] of cases) {
      useDb({ exec_slack_channels: [channelDbRow()], exec_slack_messages: [messageDbRow({ ts: T1, thread_ts: "1794140000.000100", reasons: 2 }),
        messageDbRow({ ts: T2, thread_ts: "1794140000.000100", reasons: 4 })] });
      const s = slack({}, [say("1794140000.000100", "root"), say(T1, DEFAULT_TEXT, { thread_ts: "1794140000.000100" }), say(T2, "his thread reply", { thread_ts: "1794140000.000100" })]);
      vi.mocked(callModel).mockResolvedValueOnce({ costUsd: 0, latencyMs: 1, requestId: null, ...result } as never);
      await run({ channel: "C0GENERAL", root: "1794140000.000100" });
      expect(items().map((i) => [i.ts, i.assessed, i.summary, i.excerpt])).toEqual([[T1, false, null, null]]);
      expect(msgRow(T1)).toMatchObject({ triage_state: state });
      expect(msgRow(T2)).toMatchObject({ triage_state: "skipped" });
      s.restore();
    }
  });

  it("TS13 permalinks for at most 10 surfacing messages, only allow-listed URLs; message_not_found → none", async () => {
    const ts = Array.from({ length: 12 }, (_, i) => `17941490${String(i).padStart(2, "0")}.000100`);
    imDb(ts.map((t) => cand(t)));
    const s = slack({ "chat.getPermalink": (body) => (body.message_ts === ts[0] ? slackReadError("message_not_found")
      : body.message_ts === ts[1] ? { ok: true, permalink: "https://evil.example/archives/D0JANE/p1" } : SLACK_READ_RECORDED.permalink("D0JANE")) },
      ts.map((t, i) => say(t, `please review document number ${i} carefully today`)));
    modelSays(ts.map((_, i) => item(`M${i + 1}`, { summary: `Asks you to review document ${i}.` })));
    await run();
    expect(s.calls.filter((c) => c.method === "chat.getPermalink")).toHaveLength(10);
    expect(items().filter((i) => i.permalink !== null)).toHaveLength(8);
    expect(items().find((i) => i.ts === ts[1])?.permalink).toBeNull();
  });

  it("TS14 an external author: 'External member', author_external, no excerpt; one users.info per distinct author", async () => {
    useDb({ exec_slack_channels: [IM({ class: "external", is_ext_shared: true, ext_ever: true })], exec_slack_messages: [cand(T1), cand(T2)] });
    const s = slack({ "users.info": () => SLACK_READ_RECORDED.usersInfo("U0JANE", "T0PARTNER") },
      [say(T1, DEFAULT_TEXT, { team: "T0PARTNER", user_team: "T0PARTNER" }), say(T2, "and the partner contract too", { team: "T0PARTNER", user_team: "T0PARTNER" })]);
    modelSays([item("M1"), item("M2")]);
    await run();
    expect(s.calls.filter((c) => c.method === "users.info")).toHaveLength(1);
    expect(items().map((i) => [i.author_external, i.author_label, i.excerpt])).toEqual([[true, "External member", null], [true, "External member", null]]);
  });

  it("TS16 a DD-template candidate → skipped; the DD / bot / opted-out context never reaches the model", async () => {
    imDb([cand(T1), cand(T2)], IM(), { exec_slack_author_optouts: [{ principal_id: PID, author_user_id: "U0OPTOUT", created_at: NOW.toISOString() }] });
    slack({}, [
      say("1794148000.000100", `${S.text} sync`, { user: "U0DDBOT", bot_id: "B0DDBOT", app_id: "A0DDAPP" }),
      say("1794148100.000100", `${S.text} zap`, { subtype: "bot_message", bot_id: "B0ZAP", user: undefined }),
      say("1794148200.000100", `${S.text} please forget me`, { user: "U0OPTOUT" }),
      say(T1, DEFAULT_TEXT),
      say(T2, `${S.text} FYI`, { app_id: "A0DDAPP" })
    ]);
    modelSays([item("M4")]);
    await run();
    expect(msgRow(T2)).toMatchObject({ triage_state: "skipped" });
    const arg = vi.mocked(callModel).mock.calls[0][0];
    assertNoSlackText(arg, { label: "callModel", allow: ["authorName"] });
    for (const p of Object.values(SLACK_TRIAGE_PLACEHOLDERS)) expect(JSON.stringify(arg)).toContain(p);
  });
});

describe("CC02-CC07: the Slack sub-cap", () => {
  it("CC02 spend at the effective cap → no fetch, no model call; DMs / mentions → unassessed requests; his-thread-only → skipped", async () => {
    useDb({ exec_slack_channels: [channelDbRow()], exec_slack_messages: [messageDbRow({ ts: T1, thread_ts: "1794140000.000100", reasons: 2 }),
      messageDbRow({ ts: T2, thread_ts: "1794140000.000100", reasons: 4 })] });
    vi.mocked(featureSpentTodayUsd).mockResolvedValue(2);
    const s = slack();
    expect(await run({ channel: "C0GENERAL", root: "1794140000.000100" })).toMatchObject({ degraded: "budget", written: 1 });
    expect(methods(s.calls).filter((m) => m !== "users.info")).toEqual([]);
    expect(callModel).not.toHaveBeenCalled();
    expect(items()).toEqual([expect.objectContaining({ ts: T1, kind: "request", assessed: false, summary: null, excerpt: null })]);
    expect(msgRow(T2)).toMatchObject({ triage_state: "skipped" });
    expect(db.tables.exec_jobs.some((j) => j.kind === "exec.slack-attention")).toBe(true);
  });

  it("CC03 a spend read failing → the same degradation (fail closed)", async () => {
    imDb();
    vi.mocked(featureSpentTodayUsd).mockRejectedValue(new Error("exec_ai_usage unreadable"));
    const s = slack();
    expect(await run()).toMatchObject({ degraded: "budget" });
    expect(methods(s.calls)).not.toContain("conversations.history");
    expect(items()[0]).toMatchObject({ assessed: false });
  });

  it("CC04 BudgetExceededError from callModel (the daily cap) → the same", async () => {
    imDb();
    slack();
    vi.mocked(callModel).mockRejectedValue(new BudgetExceededError(15, 15));
    expect(await run()).toMatchObject({ degraded: "budget" });
    expect(items()[0]).toMatchObject({ assessed: false, summary: null, excerpt: null });
  });

  it("CC05 the spend sums only SLACK_CAP_FEATURES, in his zone; the cap is min(slack cap, 0.2 × daily)", async () => {
    imDb();
    slack();
    vi.mocked(loadSettings).mockResolvedValue(settings({ slackDailyCapUsd: 2, dailyCostCapUsd: 5 }));
    vi.mocked(featureSpentTodayUsd).mockResolvedValue(1);
    expect(await run()).toMatchObject({ degraded: "budget" });
    // P7b stage 0 (P7a-1, C14): triage now sums the digest feature too (one Slack total under one cap).
    expect(vi.mocked(featureSpentTodayUsd).mock.calls[0].slice(0, 3)).toEqual(["ep_1", "America/New_York", ["slack_triage", "digest"]]);
  });

  it("CC07 the next day new candidates are assessed; old unassessed items aren't re-triaged", async () => {
    imDb([cand("1794100000.000100", { role: "item", triage_state: "unassessed" }), cand(T1)], IM(),
      { exec_slack_items: [itemDbRow({ channel_id: "D0JANE", ts: "1794100000.000100", assessed: false, summary: null, excerpt: null })] });
    vi.mocked(featureSpentTodayUsd).mockResolvedValue(0);
    slack();
    await run();
    expect(items().find((i) => i.ts === T1)).toMatchObject({ assessed: true });
    expect(items().find((i) => i.ts === "1794100000.000100")).toMatchObject({ assessed: false });
  });
});

describe("DM01-DM04, DM06, DM09: the deleted-marker race (SQL twin RQ14)", () => {
  const row: ItemWriteRow = { ts: T1, kind: "request", author: "U0JANE", author_label: "Jane", author_external: false, author_internal_verified: true, assessed: true,
    addressed: true, needs_response: true, bypass_mute: false, urgency: "normal", summary: "s", excerpt: "e", due_text: null, due_at: null, direction: null, source_class: "private" };
  const outcome = { ts: T1, state: "assessed" as const, content_hash: null };
  it("DM01 a marked ts → refusedDeleted, no item; DM02 a gone message row → refusedMissing", async () => {
    imDb([cand(T1)], IM(), { exec_slack_deleted: [{ principal_id: PID, channel_id: "D0JANE", ts: T1, reason: "event", deleted_at: NOW.toISOString(),
      expires_at: new Date(NOW_MS + 26 * 3_600_000).toISOString() }] });
    expect(await writeTriageResult(PRINCIPAL, "D0JANE", [row], [outcome])).toMatchObject({ written: 0, refusedDeleted: 1 });
    imDb([]);
    expect(await writeTriageResult(PRINCIPAL, "D0JANE", [row], [outcome])).toMatchObject({ written: 0, refusedMissing: 1 });
    expect(items()).toEqual([]);
  });

  it("DM03 a delete committed between the job's fetch and its write (under the writer's lock) → refused", async () => {
    imDb([cand(T1)], IM(), {});
    useDb({ exec_slack_channels: [IM()], exec_slack_messages: [cand(T1)] }, {
      afterWriteLock: (_ctx, d) => {
        d.tables.exec_slack_deleted.push({ principal_id: PID, channel_id: "D0JANE", ts: T1, reason: "event", deleted_at: NOW.toISOString(),
          expires_at: new Date(NOW_MS + 26 * 3_600_000).toISOString() });
      }
    });
    slack();
    expect(await run()).toMatchObject({ written: 0, refusedDeleted: 1 });
    expect(items()).toEqual([]);
  });

  it("DM04 a delete after the write removes the item; the job's later re-write is refused", async () => {
    imDb();
    slack();
    await run();
    expect(items()).toHaveLength(1);
    await markDeleted(PRINCIPAL, "D0JANE", [T1], "event");
    expect(items()).toEqual([]);
    expect(await writeTriageResult(PRINCIPAL, "D0JANE", [row], [outcome])).toMatchObject({ written: 0 });
    expect(items()).toEqual([]);
  });

  it("DM06 the marker lives 26 h (≥ 25 h); a re-delete extends it, never shortens it", async () => {
    imDb();
    await markDeleted(PRINCIPAL, "D0JANE", [T1], "event");
    const first = Date.parse(String(db.tables.exec_slack_deleted[0].expires_at));
    expect(first - NOW_MS).toBe(26 * 3_600_000);
    vi.setSystemTime(NOW_MS + 3_600_000);
    await markDeleted(PRINCIPAL, "D0JANE", [T1], "absent");
    expect(Date.parse(String(db.tables.exec_slack_deleted[0].expires_at))).toBe(first + 3_600_000);
    vi.setSystemTime(NOW_MS);
    await markDeleted(PRINCIPAL, "D0JANE", [T1], "event");
    expect(Date.parse(String(db.tables.exec_slack_deleted[0].expires_at))).toBe(first + 3_600_000);
  });

  it("DM09 (C50) the writer takes the channel row (share) before message rows (update)", async () => {
    imDb();
    slack();
    await run();
    const w = db.locks.filter((l) => l.rpc === "exec_slack_write_items");
    expect(w[0]).toMatchObject({ table: "exec_slack_channels", mode: "share" });
    expect(w.slice(1).every((l) => l.table === "exec_slack_messages" && l.mode === "update")).toBe(true);
  });
});

describe("XC09 / XC10 / PG17: Slack Connect and opt-outs at triage", () => {
  it("XC09 users.info user_not_found (and, separately, a brief without team_id) in a Slack Connect channel → external, no excerpt", async () => {
    for (const info of [() => slackReadError("user_not_found"), () => ({ ...SLACK_READ_RECORDED.usersInfo(), user: { ...SLACK_READ_RECORDED.usersInfo().user, team_id: undefined } })]) {
      useDb({ exec_slack_channels: [IM({ class: "external", is_ext_shared: true, ext_ever: true })], exec_slack_messages: [cand(T1)] });
      const s = slack({ "users.info": info }, [say(T1, DEFAULT_TEXT, { team: undefined })]);
      await run();
      expect(items().map((i) => [i.author_external, i.author_label, i.excerpt])).toEqual([[true, "External member", null]]);
      s.restore();
    }
  });

  it("XC09 (SQL half) a faulty caller's excerpt with author_internal_verified false in a shared conversation is stored null", async () => {
    useDb({ exec_slack_channels: [IM({ class: "external", is_ext_shared: true, ext_ever: true })], exec_slack_messages: [cand(T1)] });
    await writeTriageResult(PRINCIPAL, "D0JANE", [{ ...row(), author_internal_verified: false }], [{ ts: T1, state: "assessed", content_hash: null }]);
    expect(items()[0]).toMatchObject({ excerpt: null, author_external: true });
    function row(): ItemWriteRow {
      return { ts: T1, kind: "request", author: "U0JANE", author_label: "Jane", author_external: false, author_internal_verified: true, assessed: true, addressed: true,
        needs_response: true, bypass_mute: false, urgency: "normal", summary: "s", excerpt: S.excerpt, due_text: null, due_at: null, direction: null, source_class: "private" };
    }
  });

  it("XC10 a candidate stored author_external (no user_team on the event) → no excerpt; user_team ours and users.info ours → the excerpt is kept", async () => {
    useDb({ exec_slack_channels: [IM({ class: "external", is_ext_shared: true, ext_ever: true })], exec_slack_messages: [cand(T1, { author_external: true })] });
    let s = slack({}, [say(T1, DEFAULT_TEXT, { user_team: "T0SCALED" })]);
    await run();
    expect(items()[0]).toMatchObject({ author_external: true, excerpt: null });
    s.restore();
    useDb({ exec_slack_channels: [IM({ class: "external", is_ext_shared: true, ext_ever: true })], exec_slack_messages: [cand(T1)] });
    s = slack({}, [say(T1, DEFAULT_TEXT, { user_team: "T0SCALED" })]);
    await run();
    expect(items()[0]).toMatchObject({ author_external: false, excerpt: DEFAULT_TEXT });
  });

  it("PG17 an opted-out author's pending candidate is skipped (never sent); a direct write for it is refused", async () => {
    imDb([cand(T1, { author_user_id: "U0OPTOUT" })], IM(), { exec_slack_author_optouts: [{ principal_id: PID, author_user_id: "U0OPTOUT", created_at: NOW.toISOString() }] });
    const s = slack({}, [say(T1, DEFAULT_TEXT, { user: "U0OPTOUT" })]);
    expect(await run()).toMatchObject({ skipped: "none_active" });
    expect(s.calls).toEqual([]);
    const r = await writeTriageResult(PRINCIPAL, "D0JANE", [{ ts: T1, kind: "request", author: "U0OPTOUT", author_label: "x", author_external: false, author_internal_verified: true,
      assessed: true, addressed: true, needs_response: true, bypass_mute: false, urgency: "normal", summary: "s", excerpt: null, due_text: null, due_at: null, direction: null,
      source_class: "private" }], [{ ts: T1, state: "assessed", content_hash: null }]);
    expect(r).toMatchObject({ written: 0, refusedOptout: 1 });
  });

  it("the payload is checked; his own message is never a candidate", async () => {
    imDb();
    expect(await slackTriageJobHandler.run(jobCtx("exec.slack-triage", { installation_id: INST, channel: "bad", root: "c", mode: "window" }))).toEqual({ skipped: "bad_payload" });
    expect(HIM).toBe("U0MITCH");
  });
});
