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
import { installFakeSlack, SLACK_READ_RECORDED, slackReadError, slackSequence, type FakeSlackCall, type FakeSlackHandler } from "@/lib/exec/__tests__/fake-slack-api";
import { SLACK_TEXT_SENTINELS as S, assertNoSlackText, captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { DD_BOT, INST, NINE, NOW, PID, jobCtx, settings } from "@/lib/exec/__tests__/slack-read-jobs";
import { sealSecret } from "@/lib/exec/crypto";
import { getDdBotIdentity } from "@/lib/exec/dd-bot";
import { slackDiscoverJobHandler, slackDiscoverScheduledWork } from "@/lib/exec/handlers/slack-discover";
import { enqueueJob } from "@/lib/exec/jobs";
import { loadSettings } from "@/lib/exec/principal";
import { __resetSlackReadForTests } from "@/lib/exec/slack-read";
import { SlackRateBudgetError, takeSlackBudget } from "@/lib/exec/slack-rate";
import { getClientEmailChannelId, listClients, listDdBotDmChannelIds, listFbLeadChannels, DdReadError } from "@/lib/exec/sources/dd";
import { tryAcquireLease } from "@/lib/exec/sync-state";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7a contract §3.11.1, §5.5 DI01-DI12, §5.10 XC05/XC05b (Area D): exec.slack-discover against fake-slack-read-db (the
// store and slack-install for real), fake-slack-api for Slack, the DD reads mocked.

const KEY = Buffer.alloc(32, 0xa1).toString("base64");
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
    user_revoked_at: null, user_revoke_reason: null, user_last_error_code: null, user_last_error_at: null, reading_state: "discovering",
    discovered_at: null, reading_purged_at: null, ...over
  };
}
function channel(over: Row = {}): Row {
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
const rows = () => db.tables.exec_slack_channels;
const byId = (id: string) => rows().find((r) => r.channel_id === id);
const rpc = (fn: string) => db.calls.filter((c) => c.kind === "rpc" && c.target === fn);

/** users.conversations: everything he is in; with exclude_muted, all but `muted`. */
function members(ids: readonly string[], muted: readonly string[] = []): FakeSlackHandler {
  return (body) => ({ ok: true, channels: ids.filter((id) => body.exclude_muted !== "true" || !muted.includes(id)).map((id) => ({ id })), response_metadata: { next_cursor: "" } });
}
function slack(over: Record<string, FakeSlackHandler> = {}) {
  return installFakeSlack({
    "users.list": () => SLACK_READ_RECORDED.usersList(),
    "conversations.list": slackSequence(SLACK_READ_RECORDED.conversationsListPage1(), SLACK_READ_RECORDED.conversationsListPage2()),
    "users.conversations": members(["C0GENERAL", "G0PRIV", "D0JANE"]),
    ...over
  });
}
const methods = (calls: FakeSlackCall[]) => calls.map((c) => c.method);
const run = (payload: Record<string, unknown> = { installation_id: INST, reason: "consent" }) => slackDiscoverJobHandler.run(jobCtx("exec.slack-discover", payload));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("EXEC_TOKEN_KEY", KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  out = captureConsole();
  __resetSlackReadForTests();
  useDb();
  vi.mocked(loadSettings).mockResolvedValue(settings({ slackReadingEnabled: false }));
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
  assertNoSlackText([vi.mocked(enqueueJob).mock.calls], { label: "jobs" });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("DI-FX (correctness-7): a listing longer than one minute's budget", () => {
  it("20 conversations.list pages under a limiter that allows 15 a minute: the 16th waits into the next window and the run completes", async () => {
    // The limiter's contract (slack-rate.test.ts RL tests): a refusal waits when the wait is within maxWaitMs, else throws.
    const used = new Map<string, { window: number; n: number }>();
    vi.mocked(takeSlackBudget).mockImplementation(async (_team, method, _cls, opts) => {
      const limit = method === "conversations.list" || method === "users.list" ? 15 : 10;
      const win = Math.floor(Date.now() / 60_000);
      const u = used.get(method) ?? { window: win, n: 0 };
      if (u.window !== win) Object.assign(u, { window: win, n: 0 });
      if (u.n + 1 > limit) {
        const wait = (win + 1) * 60_000 - Date.now();
        if (wait > (opts?.maxWaitMs ?? 10_000)) throw new SlackRateBudgetError(wait);
        vi.setSystemTime(Date.now() + wait);
        Object.assign(u, { window: win + 1, n: 0 });
      }
      u.n += 1;
      used.set(method, u);
    });
    let page = 0;
    const s = slack({ "conversations.list": () => {
      page += 1;
      return { ok: true, channels: [], response_metadata: { next_cursor: page < 20 ? `cursor${page}` : "" } };
    } });
    const r = await run();
    expect(r).toMatchObject({ complete: true });
    expect(s.calls.filter((c) => c.method === "conversations.list")).toHaveLength(20);
    expect(vi.mocked(takeSlackBudget).mock.calls.every((c) => typeof c[3]?.maxWaitMs === "number" && (c[3]?.maxWaitMs as number) > 0)).toBe(true);
    expect(enqueueJob).not.toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ reason: "retry" }) }));
  });
});

describe("DI01 / DI09: the consent run", () => {
  it("lists every granted type, every page (cursor until empty), both membership listings; applies; finishes once; ready", async () => {
    const s = slack();
    const r = await run();
    expect(r).toMatchObject({ complete: true, conversations: 11 });
    expect(methods(s.calls)).toEqual(["users.list", "conversations.list", "conversations.list", "users.conversations", "users.conversations"]);
    const lists = s.calls.filter((c) => c.method === "conversations.list");
    expect(lists.map((c) => c.body.cursor)).toEqual([undefined, "dGVhbTpDMDYxRkE1UEI="]);
    expect(lists.every((c) => c.body.types === "public_channel,private_channel,im,mpim" && c.body.exclude_archived === "true" && c.body.limit === "200")).toBe(true);
    expect(s.calls.filter((c) => c.method === "users.conversations").map((c) => c.body.exclude_muted)).toEqual(["false", "true"]);
    expect(rpc("exec_slack_apply_classes")).toHaveLength(1);
    expect(rpc("exec_slack_finish_discovery")).toHaveLength(1);
    expect(db.tables.exec_slack_installations[0]).toMatchObject({ reading_state: "ready" });
    // DI09: no history call; deny / IM / MPIM rows carry no name.
    expect(methods(s.calls).some((m) => m === "conversations.history" || m === "conversations.replies")).toBe(false);
    expect(byId("D0MITCH")).toMatchObject({ class: "deny", deny_reason: "assistant_dm", name: null });
    for (const id of ["D0JANE", "G0MPIM", "D0MITCH"]) expect(byId(id)?.name ?? null).toBeNull();
    expect(byId("C0GENERAL")).toMatchObject({ class: "standard", watch_state: "watched", name: "general" });
    expect(byId("C0SHARED")).toMatchObject({ class: "external", ext_ever: true });
    expect(byId("C0BADNAME")).toMatchObject({ class: "unclassified" });
    assertNoSlackText(r, { label: "result" });
  });

  it("applies in chunks of 200, sequentially", async () => {
    const many = Array.from({ length: 450 }, (_, i) => ({ id: `C0N${String(i).padStart(4, "0")}`, name: `team-${i}`, is_channel: true, is_member: true,
      is_private: false, is_ext_shared: false, is_pending_ext_shared: false, is_archived: false, is_mpim: false, is_im: false }));
    const s = slack({ "conversations.list": () => ({ ok: true, channels: many, response_metadata: { next_cursor: "" } }), "users.conversations": members([]) });
    await run();
    expect(rpc("exec_slack_apply_classes").map((c) => ((c.payload as Row).p_rows as unknown[]).length)).toEqual([200, 200, 50]);
    s.restore();
  });

  it("DI09 / C26: im:* declined → no im type is listed", async () => {
    useDb({}, installation({ user_scopes: NINE.filter((x) => !x.startsWith("im:")) }));
    const s = slack();
    await run();
    expect(s.calls.filter((c) => c.method === "conversations.list").every((c) => c.body.types === "public_channel,private_channel,mpim")).toBe(true);
    expect(byId("D0JANE")).toBeUndefined();
  });
});

describe("DI02-DI05: failures", () => {
  it("DI02 a DD read failing (FB list, clients, workspace settings, briefings) throws and applies nothing", async () => {
    for (const fn of [listFbLeadChannels, listClients, getClientEmailChannelId, listDdBotDmChannelIds]) {
      __resetSlackReadForTests();
      useDb();
      slack();
      vi.mocked(fn).mockRejectedValueOnce(new DdReadError("t", "57014"));
      await expect(run()).rejects.toBeInstanceOf(DdReadError);
      expect(rpc("exec_slack_apply_classes")).toHaveLength(0);
      expect(rpc("exec_slack_finish_discovery")).toHaveLength(0);
    }
  });

  it("DI03 users.list failing → IMs with an ordinary counterpart stay unclassified; special ones are still denied", async () => {
    slack({ "users.list": () => slackReadError("internal_error") });
    await run();
    expect(byId("D0JANE")).toMatchObject({ class: "unclassified" });
    expect(byId("D0MITCH")).toMatchObject({ class: "deny", deny_reason: "assistant_dm" });
    // The leftovers get their own classify jobs.
    expect(vi.mocked(enqueueJob).mock.calls.map((c) => c[0]).filter((j) => j.kind === "exec.slack-classify").map((j) => j.payload?.channel)).toContain("D0JANE");
  });

  it("DI04 a conversations.list page failing → no finish, a retry job in 15 min, partial; the applied rows stay", async () => {
    slack({ "conversations.list": slackSequence(SLACK_READ_RECORDED.conversationsListPage1(), slackReadError("internal_error")) });
    const r = await run();
    expect(r).toMatchObject({ partial: true, complete: false });
    expect(rpc("exec_slack_finish_discovery")).toHaveLength(0);
    expect(byId("C0GENERAL")).toBeDefined();
    const retry = vi.mocked(enqueueJob).mock.calls.map((c) => c[0]).find((j) => j.kind === "exec.slack-discover");
    expect(retry).toMatchObject({ lane: "bulk", payload: { installation_id: INST, reason: "retry" }, dedupeKey: `slack-discover:retry:${INST}:2026110815`, maxAttempts: 3,
      runAfter: new Date(NOW.getTime() + 15 * 60_000) });
    expect(db.tables.exec_slack_installations[0]).toMatchObject({ reading_state: "discovering" });
  });

  it("DI04 the 240 s box → partial too", async () => {
    slack({
      "conversations.list": (() => {
        let n = 0;
        return () => {
          if (n++ === 0) vi.setSystemTime(NOW.getTime() + 241_000);
          return n === 1 ? SLACK_READ_RECORDED.conversationsListPage1() : SLACK_READ_RECORDED.conversationsListPage2();
        };
      })()
    });
    const r = await run();
    expect(r).toMatchObject({ partial: true });
    expect(rpc("exec_slack_finish_discovery")).toHaveLength(0);
  });

  it("DI05 the two users.conversations listings differing → muted (slack) for exactly the difference; equal → none", async () => {
    slack({ "users.conversations": members(["C0GENERAL", "G0PRIV", "D0JANE"], ["G0PRIV"]) });
    await run();
    expect(byId("G0PRIV")).toMatchObject({ watch_state: "muted", mute_source: "slack" });
    expect(byId("C0GENERAL")).toMatchObject({ watch_state: "watched", mute_source: null });
    __resetSlackReadForTests();
    useDb();
    slack();
    await run();
    expect(rows().filter((r) => r.mute_source === "slack")).toEqual([]);
  });
});

describe("DI06-DI08 / XC05: re-discovery", () => {
  it("DI06 a conversation no longer listed (complete run) → purged and its row deleted; a partial run leaves it", async () => {
    const gone = channel({ channel_id: "C0GONE", name: "gone-channel" });
    const msg = { principal_id: PID, channel_id: "C0GONE", ts: "1794100000.000100", thread_ts: null, role: "candidate", author_user_id: "U0JANE", author_external: false,
      is_dd_post: false, dd_paths: [], reasons: 2, triage_state: "pending", content_hash: null, edited_ts: null, responded_ts: null, responded_at: null,
      acknowledged_at: null, assessed_at: null, expires_at: "2027-02-01T00:00:00.000Z", created_at: "2026-11-07T00:00:00.000Z", updated_at: "2026-11-07T00:00:00.000Z" };
    useDb({ exec_slack_channels: [gone], exec_slack_messages: [msg] });
    slack({ "conversations.list": slackSequence(SLACK_READ_RECORDED.conversationsListPage1(), slackReadError("internal_error")) });
    await run();
    expect(byId("C0GONE")).toBeDefined();
    __resetSlackReadForTests();
    slack();
    await run();
    expect(byId("C0GONE")).toBeUndefined();
    expect(db.tables.exec_slack_messages.filter((m) => m.channel_id === "C0GONE")).toEqual([]);
  });

  it("DI07 re-consent declining im:* → every IM row and its data purged (C26)", async () => {
    useDb({ exec_slack_channels: [channel({ channel_id: "D0JANE", conv_type: "im", is_private: true, name: null, im_user_id: "U0JANE" })] },
      installation({ user_scopes: NINE.filter((x) => !x.startsWith("im:")) }));
    slack();
    await run();
    expect(rows().filter((r) => r.conv_type === "im")).toEqual([]);
  });

  it("DI08 an owner-set watch state survives a re-discovery; a reclassification to deny resets it (and purges)", async () => {
    useDb({ exec_slack_channels: [
      channel({ channel_id: "C0GENERAL", watch_state: "muted", mute_source: "owner", watch_set_by_owner_at: "2026-11-02T00:00:00.000Z" }),
      channel({ channel_id: "C0LEADS", name: "acme-vob-leads", watch_state: "watched", watch_set_by_owner_at: "2026-11-02T00:00:00.000Z" })
    ] });
    const leads = { id: "C0LEADS", name: "acme-vob-leads", is_channel: true, is_member: true, is_private: false, is_ext_shared: false, is_pending_ext_shared: false,
      is_archived: false, is_mpim: false, is_im: false };
    const page1 = SLACK_READ_RECORDED.conversationsListPage1();
    page1.channels.push(leads as never);
    slack({ "conversations.list": slackSequence(page1, SLACK_READ_RECORDED.conversationsListPage2()) });
    await run();
    expect(byId("C0GENERAL")).toMatchObject({ watch_state: "muted", mute_source: "owner" });
    expect(byId("C0LEADS")).toMatchObject({ class: "deny", deny_reason: "fb_list", watch_state: "unwatched", watch_set_by_owner_at: null, name: null });
  });

  it("XC05 / XC05b a channel shared meanwhile (its shared event lost): re-discovery makes it external, ext_ever, and its public items private", async () => {
    const item = { id: "esl_" + "a".repeat(32), principal_id: PID, channel_id: "C0SHARED", ts: "1794100000.000100", kind: "request", thread_ts: null, author_user_id: "U0JANE",
      author_label: "Jane", author_external: false, assessed: true, addressed_to_you: true, needs_response: true, bypass_mute: false, urgency: "normal",
      summary: "x", excerpt: null, due_text: null, due_at: null, commitment_direction: null, source_class: "public", permalink: null, responded_ts: null,
      responded_at: null, acknowledged_at: null, expires_at: "2027-02-01T00:00:00.000Z", created_at: "2026-11-07T00:00:00.000Z", updated_at: "2026-11-07T00:00:00.000Z" };
    const msg = { principal_id: PID, channel_id: "C0SHARED", ts: "1794100000.000100", thread_ts: null, role: "item", author_user_id: "U0JANE", author_external: false,
      is_dd_post: false, dd_paths: [], reasons: 2, triage_state: "assessed", content_hash: null, edited_ts: null, responded_ts: null, responded_at: null,
      acknowledged_at: null, assessed_at: null, expires_at: "2027-02-01T00:00:00.000Z", created_at: "2026-11-07T00:00:00.000Z", updated_at: "2026-11-07T00:00:00.000Z" };
    useDb({ exec_slack_channels: [channel({ channel_id: "C0SHARED", name: "partner-collab" })], exec_slack_messages: [msg], exec_slack_items: [item] });
    slack();
    await run();
    expect(byId("C0SHARED")).toMatchObject({ class: "external", ext_ever: true, is_ext_shared: true });
    expect(db.tables.exec_slack_items.find((i) => i.channel_id === "C0SHARED")).toMatchObject({ source_class: "private" });
    // Integrator (C45, mutant N61): a later triage write whose caller still says "public" stores the channel's class.
    const write = await (db.client as { rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> }).rpc("exec_slack_write_items", {
      p_principal: PID, p_channel: "C0SHARED",
      p_rows: [{ ts: item.ts, kind: "request", author: "U0JANE", author_label: "Jane", author_external: false, author_internal_verified: true, assessed: true,
        addressed: true, needs_response: true, bypass_mute: false, urgency: "normal", summary: "x", excerpt: null, due_text: null, due_at: null, direction: null,
        source_class: "public" }],
      p_outcomes: [{ ts: item.ts, state: "assessed", content_hash: null }]
    });
    expect(write.error).toBeNull();
    expect(write.data).toMatchObject({ written: 1, class_mismatch: 1 });
    expect(db.tables.exec_slack_items.filter((i) => i.channel_id === "C0SHARED").map((i) => i.source_class)).toEqual(["private"]);
  });
});

describe("DI10-DI12", () => {
  it("DI10 the switch on → one sweep enqueued after completion; off → none; active_public → the probe too", async () => {
    slack();
    await run();
    expect(vi.mocked(enqueueJob).mock.calls.map((c) => c[0].kind)).not.toContain("exec.slack-read-sweep");
    __resetSlackReadForTests();
    useDb();
    vi.mocked(enqueueJob).mockClear();
    vi.mocked(loadSettings).mockResolvedValue(settings({ watchMode: "active_public" }));
    slack();
    await run();
    const kinds = vi.mocked(enqueueJob).mock.calls.map((c) => c[0]);
    expect(kinds.filter((j) => j.kind === "exec.slack-read-sweep")).toEqual([expect.objectContaining({ payload: { reason: "discover" }, lane: "bulk", maxAttempts: 1 })]);
    expect(kinds.filter((j) => j.kind === "exec.slack-probe")).toHaveLength(1);
  });

  it("DI11 a lease held by another run → skipped, nothing listed", async () => {
    const s = slack();
    vi.mocked(tryAcquireLease).mockResolvedValueOnce(false);
    expect(await run()).toEqual({ skipped: "lease" });
    expect(s.calls).toEqual([]);
  });

  it("DI12 the DD bot identity is refreshed (refresh: true) and its failure tolerated", async () => {
    slack();
    vi.mocked(getDdBotIdentity).mockRejectedValue(new Error("down"));
    expect(await run()).toMatchObject({ complete: true });
    expect(vi.mocked(getDdBotIdentity).mock.calls[0]).toEqual(["T0SCALED", expect.objectContaining({ refresh: true })]);
  });

  it("no reading half → skipped; the daily schedule is gated on the schema", async () => {
    useDb({}, installation({ reading_state: "none", user_token_enc: null, user_key_id: null, user_scopes: [] }));
    expect(await run({})).toEqual({ skipped: "not_reading" });
    expect(slackDiscoverScheduledWork.enabled?.(settings({ slackReadingSchemaReady: false }))).toBe(false);
    expect(slackDiscoverScheduledWork.enabled?.(settings())).toBe(true);
    expect(slackDiscoverScheduledWork.cadence.kind === "daily" && slackDiscoverScheduledWork.cadence.at(settings())).toBe("05:10");
  });
});
