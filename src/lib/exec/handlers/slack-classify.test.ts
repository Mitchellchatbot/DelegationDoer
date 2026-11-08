import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-rate", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-rate")>()), takeSlackBudget: vi.fn(), noteSlackRateLimited: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/sources/dd")>()),
  listFbLeadChannels: vi.fn(), listClients: vi.fn(), getClientEmailChannelId: vi.fn(), listDdBotDmChannelIds: vi.fn()
}));
vi.mock("@/lib/exec/dd-bot", () => ({ getDdBotIdentity: vi.fn() }));

import { createFakeSlackReadDb, type FakeSlackReadDb } from "@/lib/exec/__tests__/fake-slack-read-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { installFakeSlack, SLACK_READ_RECORDED, slackReadError, type FakeSlackHandler } from "@/lib/exec/__tests__/fake-slack-api";
import { assertNoSlackText, captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { DD_BOT, INST, NOW, NOW_MS, TOKEN_KEY, channelDbRow, historyPage, installationDbRow, jobCtx, rawMessage, settings } from "@/lib/exec/__tests__/slack-read-jobs";
import { sealSecret } from "@/lib/exec/crypto";
import { getDdBotIdentity } from "@/lib/exec/dd-bot";
import { slackClassifyJobHandler } from "@/lib/exec/handlers/slack-classify";
import { loadSettings } from "@/lib/exec/principal";
import { __resetSlackReadForTests } from "@/lib/exec/slack-read";
import { takeSlackBudget } from "@/lib/exec/slack-rate";
import { getClientEmailChannelId, listClients, listDdBotDmChannelIds, listFbLeadChannels } from "@/lib/exec/sources/dd";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7a contract §3.11.2, §5.5 CJ01-CJ07 (Area D): exec.slack-classify against fake-slack-read-db (the store for real).

let db: FakeSlackReadDb;
let out: ReturnType<typeof captureConsole>;
const unclassifiedIm = (id = "D0JANE") => channelDbRow({ channel_id: id, conv_type: "im", class: "unclassified", watch_state: "unwatched", is_member: false,
  is_private: true, name: null, classified_at: null });
function useDb(channels: Row[]): FakeSlackReadDb {
  db = createFakeSlackReadDb({ now: () => new Date(), tables: { exec_slack_channels: channels }, slack: { tables: { exec_slack_installations: [installationDbRow(sealSecret)] } } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const row = (id: string) => db.tables.exec_slack_channels.find((r) => r.channel_id === id);
const run = (channel = "D0JANE") => slackClassifyJobHandler.run(jobCtx("exec.slack-classify", { installation_id: INST, channel }, { lane: "interactive" }));
const recentDm = () => historyPage([rawMessage(String(NOW_MS / 1000 - 120) + ".000100", { text: "can you look at the invoice before lunch?" })]);
function slack(over: Record<string, FakeSlackHandler> = {}) {
  return installFakeSlack({
    "conversations.info": () => SLACK_READ_RECORDED.conversationsInfoIm(),
    "users.info": () => SLACK_READ_RECORDED.usersInfo("U0JANE"),
    "conversations.history": () => recentDm(),
    ...over
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("EXEC_TOKEN_KEY", TOKEN_KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  out = captureConsole();
  __resetSlackReadForTests();
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(takeSlackBudget).mockResolvedValue(undefined);
  vi.mocked(listFbLeadChannels).mockResolvedValue([]);
  vi.mocked(listClients).mockResolvedValue([]);
  vi.mocked(getClientEmailChannelId).mockResolvedValue(null);
  vi.mocked(listDdBotDmChannelIds).mockResolvedValue([]);
  vi.mocked(getDdBotIdentity).mockResolvedValue({ teamId: "T0SCALED", userId: DD_BOT.userId, botId: "B0DDBOT", appId: DD_BOT.appId, checkedAt: NOW.toISOString() });
});
afterEach(() => {
  out.assertClean();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("exec.slack-classify", () => {
  it("CJ01 an unknown IM: info + users.info → standard / watched → catch-up read (oldest = now − 1 h) → a candidate on the interactive lane", async () => {
    useDb([unclassifiedIm()]);
    const s = slack();
    const r = await run();
    expect(r).toMatchObject({ class: "standard", watch: "watched", caughtUp: { candidates: 1 } });
    expect(s.calls.map((c) => c.method)).toEqual(["conversations.info", "users.info", "conversations.history"]);
    const history = s.calls.find((c) => c.method === "conversations.history");
    expect(history?.body).toMatchObject({ channel: "D0JANE", oldest: `${(NOW_MS - 3_600_000) / 1000}.000000`, limit: "50" });
    const job = db.tables.exec_jobs.find((j) => j.kind === "exec.slack-triage");
    expect(job).toMatchObject({ lane: "interactive", payload: { installation_id: INST, channel: "D0JANE", root: "c", mode: "window" } });
    expect(String(job?.dedupe_key)).toMatch(/^slack-triage:ep_1:D0JANE:c:m[0-9]+$/);
    assertNoSlackText([r, db.tables.exec_jobs], { label: "result and jobs" });
  });

  it("CJ02 an IM with a bot → deny bot_im, no catch-up read", async () => {
    useDb([unclassifiedIm()]);
    const s = slack({ "users.info": () => ({ ...SLACK_READ_RECORDED.usersInfo("U0JANE"), user: { ...SLACK_READ_RECORDED.usersInfo("U0JANE").user, is_bot: true } }) });
    expect(await run()).toMatchObject({ class: "deny", watch: "unwatched" });
    expect(row("D0JANE")).toMatchObject({ class: "deny", deny_reason: "bot_im", name: null });
    expect(s.calls.map((c) => c.method)).not.toContain("conversations.history");
  });

  it("CJ03 channel_not_found → the conversation purged and its row deleted", async () => {
    useDb([unclassifiedIm()]);
    slack({ "conversations.info": () => slackReadError("channel_not_found") });
    expect(await run()).toEqual({ purged: true });
    expect(row("D0JANE")).toBeUndefined();
  });

  it("CJ04 users.info failing → stays unclassified (fail closed), no catch-up", async () => {
    useDb([unclassifiedIm()]);
    const s = slack({ "users.info": () => slackReadError("internal_error") });
    expect(await run()).toMatchObject({ class: "unclassified" });
    expect(s.calls.map((c) => c.method)).not.toContain("conversations.history");
  });

  it("CJ05 two classify jobs within 10 minutes → one set of DD reads", async () => {
    useDb([unclassifiedIm(), unclassifiedIm("D0BOB")]);
    slack({ "conversations.info": (body) => ({ ...SLACK_READ_RECORDED.conversationsInfoIm(), channel: { ...SLACK_READ_RECORDED.conversationsInfoIm().channel, id: body.channel } }) });
    await run("D0JANE");
    vi.setSystemTime(NOW_MS + 5 * 60_000);
    await run("D0BOB");
    expect(listFbLeadChannels).toHaveBeenCalledTimes(1);
    expect(listClients).toHaveBeenCalledTimes(1);
    expect(getClientEmailChannelId).toHaveBeenCalledTimes(1);
    expect(listDdBotDmChannelIds).toHaveBeenCalledTimes(1);
  });

  it("CJ-FX (correctness-3): a conversation he muted (its DMs bypass the mute) still gets the catch-up read; a finance default mute never would", async () => {
    useDb([channelDbRow({ channel_id: "D0JANE", conv_type: "im", is_private: true, name: null, im_user_id: "U0JANE", watch_state: "muted", mute_source: "owner",
      watch_set_by_owner_at: "2026-11-02T00:00:00.000Z" })]);
    const s = slack();
    expect(await run()).toMatchObject({ class: "standard", watch: "muted", caughtUp: { candidates: 1 } });
    expect(s.calls.map((c) => c.method)).toContain("conversations.history");
  });

  it("CJ06 the catch-up is skipped when reading is off", async () => {
    useDb([unclassifiedIm()]);
    vi.mocked(loadSettings).mockResolvedValue(settings({ slackReadingEnabled: false }));
    const s = slack();
    expect(await run()).toEqual({ class: "standard", watch: "watched" });
    expect(s.calls.map((c) => c.method)).not.toContain("conversations.history");
  });

  it("CJ07 a channel (not an IM) makes no catch-up read", async () => {
    useDb([channelDbRow({ class: "unclassified", watch_state: "unwatched", name: null })]);
    const s = slack({ "conversations.info": () => SLACK_READ_RECORDED.conversationsInfoChannel() });
    expect(await run("C0GENERAL")).toMatchObject({ class: "standard", watch: "watched" });
    expect(s.calls.map((c) => c.method)).toEqual(["conversations.info"]);
  });

  it("a missing row → skipped; no reading half → skipped", async () => {
    useDb([]);
    const s = slack();
    expect(await run()).toEqual({ skipped: "no_row" });
    vi.mocked(loadSettings).mockResolvedValue(settings({ slackReadingSchemaReady: false }));
    expect(await run()).toEqual({ skipped: "not_reading" });
    expect(s.calls).toEqual([]);
  });
});
