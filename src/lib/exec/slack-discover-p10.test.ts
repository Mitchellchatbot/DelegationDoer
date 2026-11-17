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
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), tryAcquireLease: vi.fn(), releaseLease: vi.fn() }));

import { createFakeSlackReadDb, type FakeSlackReadDb } from "@/lib/exec/__tests__/fake-slack-read-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { installFakeSlack, slackHistoryMessage, type FakeSlackCall, type FakeSlackHandler } from "@/lib/exec/__tests__/fake-slack-api";
import { SLACK_TEXT_SENTINELS as S, captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { DD_BOT, INST, NINE, NOW, PID, jobCtx, settings } from "@/lib/exec/__tests__/slack-read-jobs";
import { sealSecret } from "@/lib/exec/crypto";
import { getDdBotIdentity } from "@/lib/exec/dd-bot";
import { slackClassifyJobHandler } from "@/lib/exec/handlers/slack-classify";
import { slackDiscoverJobHandler } from "@/lib/exec/handlers/slack-discover";
import { enqueueJob } from "@/lib/exec/jobs";
import { loadSettings } from "@/lib/exec/principal";
import { __resetSlackReadForTests } from "@/lib/exec/slack-read";
import { takeSlackBudget } from "@/lib/exec/slack-rate";
import { countReadAllEffects } from "@/lib/exec/slack-read-store";
import { getClientEmailChannelId, listClients, listDdBotDmChannelIds, listFbLeadChannels } from "@/lib/exec/sources/dd";
import { tryAcquireLease } from "@/lib/exec/sync-state";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P10 §5.1 (RA07-RA10 discovery part, RA12; contract §3.3.3, §3.3.5, C2-C5, C10, v1.1 correctness-9, security-5, product-14;
// Area B): exec.slack-discover and exec.slack-classify with the read-all switch, against P7a's fake store (its
// exec_slack_apply_classes mirrors the SQL's owner / C34 / default branches), the fake Slack API, the DD reads mocked.
// Invented names only.

const KEY = Buffer.alloc(32, 0xa1).toString("base64");
const P = { id: PID } as unknown as ExecPrincipal;
let db: FakeSlackReadDb;
let out: ReturnType<typeof captureConsole>;

function installation(over: Row = {}): Row {
  const bot = sealSecret("xoxb-discover-test-bot", `exec_slack_installations.bot_token:${PID}`);
  const user = sealSecret(S.userToken, `exec_slack_installations.user_token:${PID}`);
  return {
    id: INST, principal_id: PID, team_id: "T0SCALED", app_id: "A0EXEC", bot_user_id: "U0BOT", bot_id: "B0BOT", bot_token_enc: bot, key_id: bot.split(".")[1],
    bot_scopes: ["chat:write"], user_id: "U0MITCH", user_token_enc: user, user_scopes: [...NINE], slack_dm_channel_id: "D0MITCH",
    installed_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z", revoked_at: null, revoke_reason: null, last_dm_at: null,
    last_error_code: null, last_error_at: null, purged_at: null, user_key_id: user.split(".")[1], user_installed_at: "2026-11-07T00:00:00.000Z",
    user_revoked_at: null, user_revoke_reason: null, user_last_error_code: null, user_last_error_at: null, reading_state: "ready",
    discovered_at: "2026-11-07T01:00:00.000Z", reading_purged_at: null, ...over
  };
}
function channelRow(over: Row = {}): Row {
  return {
    principal_id: PID, installation_id: INST, channel_id: "C0GENERAL", conv_type: "channel", class: "standard", deny_reason: null, hub_kind: null,
    finance_name: false, watch_state: "watched", mute_source: null, watch_set_by_owner_at: null, name: "general", im_user_id: null, is_member: true,
    is_private: false, is_ext_shared: false, ext_ever: false, is_archived: false, hist_watermark_ts: null, deep_swept_at: null, swept_at: null,
    last_event_ts: null, last_activity_ts: null, activity_30d: null, probed_at: null, classified_at: "2026-11-01T01:00:00.000Z",
    seen_at: "2026-11-01T01:00:00.000Z", left_at: null, created_at: "2026-11-01T01:00:00.000Z", updated_at: "2026-11-01T01:00:00.000Z", ...over
  };
}
function useDb(tables: Partial<Record<string, Row[]>> = {}, inst: Row = installation()): FakeSlackReadDb {
  db = createFakeSlackReadDb({ now: () => new Date(), tables: tables as never, slack: { tables: { exec_slack_installations: [inst] } } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const byId = (id: string) => db.tables.exec_slack_channels.find((r) => r.channel_id === id);
const applyCalls = () => db.calls.filter((c) => c.kind === "rpc" && c.target === "exec_slack_apply_classes");

/** One conversations.list item (the CL shape). */
const conv = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, is_channel: true, is_group: false, is_im: false, is_mpim: false, is_private: false, is_archived: false, is_ext_shared: false,
  is_pending_ext_shared: false, is_member: true, name_normalized: name, ...over
});
const CONVERSATIONS = [
  conv("C0GENERAL", "general"),
  conv("C0FIN", "zenith-house-finance"),
  conv("C0PAYROLL", "acme-payroll"),
  conv("C0OWNFIN", "acme-billing"),
  conv("C0MUTED", "zenith-house-ops"),
  conv("C0NOTFIN", "acme-legal", { is_member: false })
];
/** users.conversations: everything he is in; with exclude_muted, all but C0MUTED (his Slack mute). */
const members: FakeSlackHandler = (body) => ({
  ok: true,
  channels: ["C0GENERAL", "C0FIN", "C0PAYROLL", "C0OWNFIN", "C0MUTED"].filter((id) => body.exclude_muted !== "true" || id !== "C0MUTED").map((id) => ({ id })),
  response_metadata: { next_cursor: "" }
});
function slack(over: Record<string, FakeSlackHandler> = {}) {
  return installFakeSlack({
    "users.list": () => ({ ok: true, members: [], response_metadata: { next_cursor: "" } }),
    "conversations.list": () => ({ ok: true, channels: CONVERSATIONS, response_metadata: { next_cursor: "" } }),
    "users.conversations": members,
    "conversations.info": (body) => ({ ok: true, channel: CONVERSATIONS.find((c) => c.id === body.channel) ?? CONVERSATIONS[1] }),
    "conversations.history": () => ({ ok: true, messages: [slackHistoryMessage("1794149000.000100")], has_more: false }),
    ...over
  });
}
const methods = (calls: FakeSlackCall[]) => calls.map((c) => c.method);
const readAllOn = (on: boolean, over: Partial<ExecSettings> = {}) => settings({ slackReadingEnabled: false, slackP10SchemaReady: true, slackReadAll: on, ...over });
const discover = (payload: Record<string, unknown> = { installation_id: INST, reason: "settings" }, dedupeKey: string | null = null) =>
  slackDiscoverJobHandler.run(jobCtx("exec.slack-discover", payload, { dedupeKey })) as Promise<Record<string, unknown>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("EXEC_TOKEN_KEY", KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  out = captureConsole();
  __resetSlackReadForTests();
  useDb({ exec_slack_channels: [channelRow({ channel_id: "C0OWNFIN", name: "acme-billing", class: "finance", finance_name: true, watch_state: "watched",
    watch_set_by_owner_at: "2026-11-02T00:00:00.000Z" })] });
  vi.mocked(loadSettings).mockResolvedValue(readAllOn(false));
  vi.mocked(takeSlackBudget).mockResolvedValue(undefined);
  vi.mocked(tryAcquireLease).mockResolvedValue(true);
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 1 });
  vi.mocked(listFbLeadChannels).mockResolvedValue([{ name: "acme-vob-leads", channelId: "C0LEADS" }]);
  vi.mocked(listClients).mockResolvedValue([{ id: "c1", name: "Acme Recovery", status: "active" }] as never);
  vi.mocked(getClientEmailChannelId).mockResolvedValue("C0EMAIL");
  vi.mocked(listDdBotDmChannelIds).mockResolvedValue([]);
  vi.mocked(getDdBotIdentity).mockResolvedValue({ teamId: "T0SCALED", userId: DD_BOT.userId, botId: "B0DDBOT", appId: DD_BOT.appId, checkedAt: NOW.toISOString() });
});
afterEach(() => {
  out.assertClean();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("RA07 discovery with read-all on", () => {
  it("no users.conversations call; finance members watched with no mute; his Slack-muted channel watched", async () => {
    vi.mocked(loadSettings).mockResolvedValue(readAllOn(true));
    const fake = slack();
    const r = await discover();
    expect(r).toMatchObject({ complete: true });
    expect(methods(fake.calls)).not.toContain("users.conversations");
    expect(byId("C0FIN")).toMatchObject({ class: "finance", finance_name: true, watch_state: "watched", mute_source: null });
    expect(byId("C0PAYROLL")).toMatchObject({ class: "finance", watch_state: "watched", mute_source: null });
    expect(byId("C0MUTED")).toMatchObject({ class: "standard", watch_state: "watched", mute_source: null });
    expect(byId("C0NOTFIN")).toMatchObject({ class: "finance", watch_state: "unwatched" });
  });
  it("with it off, P7a's two listings run and the defaults stay (finance muted by default_finance, Slack mute kept)", async () => {
    const fake = slack();
    await discover();
    expect(methods(fake.calls).filter((m) => m === "users.conversations")).toHaveLength(2);
    expect(byId("C0FIN")).toMatchObject({ watch_state: "muted", mute_source: "default_finance" });
    expect(byId("C0MUTED")).toMatchObject({ watch_state: "muted", mute_source: "slack" });
  });
  it("the P10 schema missing reads as off whatever the stored switch (readAll needs slackP10SchemaReady)", async () => {
    vi.mocked(loadSettings).mockResolvedValue(readAllOn(true, { slackP10SchemaReady: false }));
    const fake = slack();
    await discover();
    expect(methods(fake.calls).filter((m) => m === "users.conversations")).toHaveLength(2);
    expect(byId("C0FIN")).toMatchObject({ watch_state: "muted", mute_source: "default_finance" });
  });
});

describe("RA08 a settings read failure", () => {
  it("in discovery throws before anything is applied (0 apply_classes calls)", async () => {
    vi.mocked(loadSettings).mockRejectedValue(new Error("exec_settings read failed: timeout"));
    slack();
    await expect(discover()).rejects.toThrow();
    expect(applyCalls()).toHaveLength(0);
  });
  it("in classify throws before anything is applied", async () => {
    slack();
    await discover();
    const before = applyCalls().length;
    vi.mocked(loadSettings).mockReset();
    vi.mocked(loadSettings).mockResolvedValueOnce(readAllOn(false)).mockRejectedValueOnce(new Error("exec_settings read failed: timeout"));
    await expect(slackClassifyJobHandler.run(jobCtx("exec.slack-classify", { installation_id: INST, channel: "C0FIN" }))).rejects.toThrow();
    expect(applyCalls()).toHaveLength(before);
  });
  it("classify passes the switch: a finance member classified under read-all is watched", async () => {
    slack();
    vi.mocked(loadSettings).mockResolvedValue(readAllOn(false));
    await discover();
    vi.mocked(loadSettings).mockResolvedValue(readAllOn(true));
    db.tables.exec_slack_channels.push(channelRow({ channel_id: "C0NEWFIN", name: null, class: "unclassified", watch_state: "unwatched" }));
    slack({ "conversations.info": () => ({ ok: true, channel: conv("C0NEWFIN", "zenith-house-finance-2") }) });
    await slackClassifyJobHandler.run(jobCtx("exec.slack-classify", { installation_id: INST, channel: "C0NEWFIN" }));
    expect(byId("C0NEWFIN")).toMatchObject({ class: "finance", watch_state: "watched", mute_source: null });
  });
});

describe("RA09 the apply cycle off → on → off (C4, C5)", () => {
  it("finance defaults muted → watched → muted; his own choice kept throughout; a Slack-muted row watched after on, still watched after off", async () => {
    slack();
    await discover();
    expect(byId("C0FIN")).toMatchObject({ watch_state: "muted", mute_source: "default_finance" });
    expect(byId("C0MUTED")).toMatchObject({ watch_state: "muted", mute_source: "slack" });
    expect(byId("C0OWNFIN")).toMatchObject({ watch_state: "watched" });
    vi.mocked(loadSettings).mockResolvedValue(readAllOn(true));
    await discover();
    expect(byId("C0FIN")).toMatchObject({ watch_state: "watched", mute_source: null });
    expect(byId("C0MUTED")).toMatchObject({ watch_state: "watched", mute_source: null });
    expect(byId("C0OWNFIN")).toMatchObject({ watch_state: "watched" });
    vi.mocked(loadSettings).mockResolvedValue(readAllOn(false));
    await discover();
    expect(byId("C0FIN")).toMatchObject({ watch_state: "muted", mute_source: "default_finance" });
    expect(byId("C0MUTED")).toMatchObject({ watch_state: "watched" });   // C4: a Slack-mute default never re-mutes an existing row
    expect(byId("C0OWNFIN")).toMatchObject({ watch_state: "watched" });
  });
});

describe("RA10 a settings run that meets the lease (v1.1 correctness-9)", () => {
  const KEY0 = `slack-discover:settings:${INST}:${Math.floor(NOW.getTime() / 60_000)}`;
  it("re-queues itself (retry 1, :r1, past the lease), then :r2, then gives up; a scheduled run stays a silent skip", async () => {
    vi.mocked(tryAcquireLease).mockResolvedValue(false);
    slack();
    expect(await discover({ installation_id: INST, reason: "settings" }, KEY0)).toEqual({ skipped: "lease", requeued: true });
    const first = vi.mocked(enqueueJob).mock.calls.at(-1)?.[0];
    expect(first).toMatchObject({ kind: "exec.slack-discover", lane: "bulk", principalId: PID, payload: { installation_id: INST, reason: "settings", retry: 1 },
      dedupeKey: `${KEY0}:r1`, maxAttempts: 3 });
    expect((first?.runAfter as Date).getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 365_000);
    expect(await discover({ installation_id: INST, reason: "settings", retry: 1 }, `${KEY0}:r1`)).toEqual({ skipped: "lease", requeued: true });
    expect(vi.mocked(enqueueJob).mock.calls.at(-1)?.[0]).toMatchObject({ payload: { retry: 2 }, dedupeKey: `${KEY0}:r2` });
    const n = vi.mocked(enqueueJob).mock.calls.length;
    expect(await discover({ installation_id: INST, reason: "settings", retry: 2 }, `${KEY0}:r2`)).toEqual({ skipped: "lease" });
    expect(vi.mocked(enqueueJob).mock.calls.length).toBe(n);
    expect(await discover({ installation_id: INST }, "exec.slack-discover:ep_1:d20261108")).toEqual({ skipped: "lease" });
    expect(await discover({ installation_id: INST, reason: "retry" })).toEqual({ skipped: "lease" });
    expect(vi.mocked(enqueueJob).mock.calls.length).toBe(n);
  });
  it("an enqueue failure → requeued false (logged by code); the follow-up that gets the lease applies the new value", async () => {
    vi.mocked(tryAcquireLease).mockResolvedValueOnce(false);
    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error("exec_jobs enqueue failed"));
    slack();
    expect(await discover({ installation_id: INST, reason: "settings" }, KEY0)).toEqual({ skipped: "lease", requeued: false });
    vi.mocked(loadSettings).mockResolvedValue(readAllOn(true));
    await discover({ installation_id: INST, reason: "settings", retry: 1 }, `${KEY0}:r1`);
    expect(byId("C0FIN")).toMatchObject({ watch_state: "watched", mute_source: null });
  });
});

describe("RA12 countReadAllEffects (C10, v1.1 security-5, product-14)", () => {
  const rows = () => [
    channelRow({ channel_id: "C0FINW", name: "zenith-house-finance", class: "finance", finance_name: true, watch_state: "watched" }),
    channelRow({ channel_id: "C0FINM", name: "acme-payroll", class: "finance", finance_name: true, watch_state: "muted", mute_source: "default_finance" }),
    channelRow({ channel_id: "C0EXTF", name: "acme-billing-shared", class: "external", finance_name: true, is_ext_shared: true, watch_state: "muted", mute_source: "default_finance" }),
    channelRow({ channel_id: "C0SMUTE", name: "zenith-house-ops", watch_state: "muted", mute_source: "slack" }),
    channelRow({ channel_id: "C0OWNM", name: "acme-legal", class: "finance", finance_name: true, watch_state: "muted", mute_source: "owner", watch_set_by_owner_at: "2026-11-02T00:00:00.000Z" }),
    channelRow({ channel_id: "C0NONM", name: "zenith-house-tax", class: "finance", finance_name: true, is_member: false, watch_state: "unwatched" }),
    channelRow({ channel_id: "C0LEFT", name: "acme-hr", class: "finance", finance_name: true, watch_state: "muted", mute_source: "default_finance", left_at: "2026-11-05T00:00:00.000Z" }),
    channelRow({ channel_id: "C0DENY", name: null, class: "deny", deny_reason: "lead_name", watch_state: "unwatched", is_member: false }),
    channelRow({ channel_id: "D0SMUTE", conv_type: "im", name: null, im_user_id: "U0JANE", watch_state: "muted", mute_source: "slack" })
  ];
  it("read-all off: the finance counts, the would-open list (sorted labels, never an owner mute, a deny row or a non-member), pending", async () => {
    useDb({ exec_slack_channels: rows() });
    const r = await countReadAllEffects(P, { readAll: false });
    expect(r).toEqual({
      financeWatched: 1, financeMuted: 3, pendingDefaults: 1,
      wouldOpen: { labels: ["#acme-billing-shared", "#acme-payroll", "#zenith-house-ops", "Direct message"], more: 0 }
    });
  });
  it("read-all on: pending counts the rows a re-discovery hasn't opened yet; 0 once applied; an owner-set row never counts", async () => {
    useDb({ exec_slack_channels: rows() });
    expect((await countReadAllEffects(P, { readAll: true }))?.pendingDefaults).toBe(4);
    useDb({ exec_slack_channels: rows().map((r) => (r.watch_set_by_owner_at === null && r.watch_state === "muted" ? { ...r, watch_state: "watched", mute_source: null } : r)) });
    expect(await countReadAllEffects(P, { readAll: true })).toMatchObject({ pendingDefaults: 0, wouldOpen: { labels: [], more: 0 } });
  });
  it("≤ 50 labels, the rest counted; the P7a schema missing → null", async () => {
    useDb({ exec_slack_channels: Array.from({ length: 63 }, (_, k) => channelRow({ channel_id: `C0F${String(k).padStart(3, "0")}`, name: `zenith-fin-${String(k).padStart(2, "0")}`,
      class: "finance", finance_name: true, watch_state: "muted", mute_source: "default_finance" })) });
    const r = await countReadAllEffects(P, { readAll: false });
    expect(r?.wouldOpen.labels).toHaveLength(50);
    expect(r?.wouldOpen.more).toBe(13);
    expect(r?.wouldOpen.labels[0]).toBe("#zenith-fin-00");
    useDb();
    db.missing?.add?.("exec_slack_channels");
    const gone = await countReadAllEffects(P, { readAll: false });
    expect(gone === null || (gone.financeWatched === 0 && gone.wouldOpen.labels.length === 0)).toBe(true);
  });
});
