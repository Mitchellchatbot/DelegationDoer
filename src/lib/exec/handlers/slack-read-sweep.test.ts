import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-rate", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-rate")>()), takeSlackBudget: vi.fn(), noteSlackRateLimited: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sources/dd")>()), listUserSchedules: vi.fn() }));
vi.mock("@/lib/exec/dd-bot", () => ({ getDdBotIdentity: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), tryAcquireLease: vi.fn(), releaseLease: vi.fn() }));

import channelWindow from "@/lib/exec/__tests__/fixtures/slack-history/channel-window.json";
import imWindow from "@/lib/exec/__tests__/fixtures/slack-history/im-window.json";
import threadOldParent from "@/lib/exec/__tests__/fixtures/slack-history/thread-old-parent.json";
import threadTombstone from "@/lib/exec/__tests__/fixtures/slack-history/thread-tombstone.json";
import { createFakeSlackReadDb, type FakeSlackReadDb } from "@/lib/exec/__tests__/fake-slack-read-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { installFakeSlack, slackRateLimitedAfter, slackReadError, type FakeSlackCall, type FakeSlackHandler } from "@/lib/exec/__tests__/fake-slack-api";
import { ITEM_TEXT_KEYS, SLACK_TEXT_SENTINELS as S, assertNoSlackText, captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { DD_BOT, HIM, INST, NOW, NOW_MS, PID, PRINCIPAL, TOKEN_KEY, channelDbRow, historyPage, installationDbRow, itemDbRow, jobCtx, messageDbRow, rawMessage, settings } from "@/lib/exec/__tests__/slack-read-jobs";
import { sealSecret } from "@/lib/exec/crypto";
import { getDdBotIdentity } from "@/lib/exec/dd-bot";
import { slackReadSweepJobHandler, slackReadSweepScheduledWork } from "@/lib/exec/handlers/slack-read-sweep";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import { __resetSlackReadForTests } from "@/lib/exec/slack-read";
import { noteSlackRateLimited, takeSlackBudget } from "@/lib/exec/slack-rate";
import { writeTriageResult } from "@/lib/exec/slack-read-store";
import { listUserSchedules } from "@/lib/exec/sources/dd";
import { tryAcquireLease } from "@/lib/exec/sync-state";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7a contract §3.11.3, §5.5 WM01-WM17, §5.7 DM05, §5.8 PG12 / PG17 (the sweep half), §5.9 AN01-AN08 / AN10-AN12 (Area D):
// exec.slack-read-sweep over the recorded history fixtures, against fake-slack-read-db (the store and its RPCs for real).

type Fixture = {
  channel: string; convType: "channel" | "group" | "im" | "mpim";
  channelRow: Record<string, unknown>; threads: { threadTs: string; hePostedTs: string | null; replyWatermarkTs: string | null; latestReplySeenTs: string | null }[];
  stored: { ts: string; threadTs: string | null; role: string; author: string | null; hasItem?: boolean }[];
  sweepCtx: { optedOut: string[] };
  history: { pass?: string; request: Record<string, unknown>; response: Record<string, unknown> }[];
  replies: Record<string, { request: Record<string, unknown>; response: Record<string, unknown> }[]>;
  expect: Record<string, unknown>;
};

let db: FakeSlackReadDb;
let out: ReturnType<typeof captureConsole>;

function channelFromFixture(fx: Fixture, over: Row = {}): Row {
  const c = fx.channelRow;
  return channelDbRow({
    channel_id: fx.channel, conv_type: fx.convType, class: c.class, watch_state: c.watchState, mute_source: c.muteSource, is_member: c.isMember,
    is_private: c.isPrivate, is_ext_shared: c.isExtShared, ext_ever: c.extEver, hist_watermark_ts: c.histWatermarkTs, deep_swept_at: c.deepSweptAt,
    swept_at: c.sweptAt, last_event_ts: c.lastEventTs, name: fx.convType === "channel" || fx.convType === "group" ? "general" : null,
    im_user_id: fx.convType === "im" ? "U0JANE" : null, ...over
  });
}
function seed(fx: Fixture, over: { channel?: Row; extra?: Partial<Record<string, Row[]>> } = {}): FakeSlackReadDb {
  const threads = fx.threads.map((t) => ({ principal_id: PID, channel_id: fx.channel, thread_ts: t.threadTs, he_posted_ts: t.hePostedTs,
    reply_watermark_ts: t.replyWatermarkTs, latest_reply_seen_ts: t.latestReplySeenTs, expires_at: "2026-12-01T00:00:00.000Z", updated_at: "2026-11-07T00:00:00.000Z" }));
  const messages = fx.stored.map((s) => messageDbRow({ channel_id: fx.channel, ts: s.ts, thread_ts: s.threadTs === s.ts ? null : s.threadTs,
    role: s.hasItem ? "item" : s.role, author_user_id: s.author, triage_state: s.hasItem ? "assessed" : "pending", reasons: 4 }));
  const items = fx.stored.filter((s) => s.hasItem).map((s) => itemDbRow({ channel_id: fx.channel, ts: s.ts, thread_ts: s.threadTs === s.ts ? null : s.threadTs }));
  const optouts = fx.sweepCtx.optedOut.map((a) => ({ principal_id: PID, author_user_id: a, created_at: "2026-11-01T00:00:00.000Z" }));
  return useDb({ exec_slack_channels: [over.channel ?? channelFromFixture(fx)], exec_slack_threads: threads, exec_slack_messages: messages,
    exec_slack_items: items, exec_slack_author_optouts: optouts, ...(over.extra ?? {}) });
}
function useDb(tables: Partial<Record<string, Row[]>>): FakeSlackReadDb {
  db = createFakeSlackReadDb({ now: () => new Date(), tables: tables as never, slack: { tables: { exec_slack_installations: [installationDbRow(sealSecret)] } } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
/** Answers the fixture's history requests by (oldest, cursor) and replies by (ts, cursor). */
function fixtureSlack(fx: Fixture, over: Record<string, FakeSlackHandler> = {}) {
  return installFakeSlack({
    "conversations.history": (body) => {
      const h = fx.history.find((x) => x.request.oldest === body.oldest && (x.request.cursor ?? undefined) === (body.cursor ?? undefined));
      return h ? h.response : slackReadError("invalid_cursor");
    },
    "conversations.replies": (body) => {
      const r = (fx.replies[String(body.ts)] ?? []).find((x) => (x.request.cursor ?? undefined) === (body.cursor ?? undefined));
      return r ? r.response : historyPage([]);
    },
    ...over
  });
}
const msgRow = (ts: string) => db.tables.exec_slack_messages.find((m) => m.ts === ts);
const chRow = (id: string) => db.tables.exec_slack_channels.find((r) => r.channel_id === id);
const methods = (calls: FakeSlackCall[]) => calls.map((c) => c.method);
const run = (payload: Record<string, unknown> = { reason: "owner" }, dedupeKey: string | null = null) =>
  slackReadSweepJobHandler.run(jobCtx("exec.slack-read-sweep", payload, { dedupeKey }));
const candidatesOf = () => db.tables.exec_slack_messages.filter((m) => m.role === "candidate").map((m) => m.ts).sort();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("EXEC_TOKEN_KEY", TOKEN_KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  out = captureConsole();
  __resetSlackReadForTests();
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(takeSlackBudget).mockResolvedValue(undefined);
  vi.mocked(noteSlackRateLimited).mockResolvedValue(undefined);
  vi.mocked(listUserSchedules).mockResolvedValue([]);
  vi.mocked(tryAcquireLease).mockResolvedValue(true);
  vi.mocked(notifyOps).mockResolvedValue(true);
  vi.mocked(getDdBotIdentity).mockResolvedValue({ teamId: "T0SCALED", userId: DD_BOT.userId, botId: "B0DDBOT", appId: DD_BOT.appId, checkedAt: NOW.toISOString() });
});
afterEach(() => {
  out.assertClean();
  assertNoSlackText(db.calls.filter((c) => c.kind === "rpc").map((c) => c.payload), { label: "rpc", ignoreKeys: ITEM_TEXT_KEYS });
  assertNoSlackText(vi.mocked(notifyOps).mock.calls, { label: "ops" });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("the recorded windows", () => {
  it("channel-window: verdicts become rows, both pages followed, the reply scan, the reaction, the watermark", async () => {
    const fx = channelWindow as unknown as Fixture;
    seed(fx, { channel: channelFromFixture(fx, { deep_swept_at: null }) });
    const s = fixtureSlack(fx);
    const r = await run();
    expect(r).toMatchObject({ conversations: 1, partial: false });
    expect(methods(s.calls).filter((m) => m === "conversations.history")).toHaveLength(fx.expect.historyCalls as number);
    // WM04: the cursor is followed within the run (the second page) and never persisted.
    expect(s.calls.filter((c) => c.method === "conversations.history").map((c) => c.body.cursor)).toEqual([undefined, "bmV4dF90czoxNzk0MDcwMDAw"]);
    expect(s.calls.filter((c) => c.method === "conversations.replies").map((c) => c.body.ts)).toEqual(fx.expect.replyCallsFor);
    expect(s.calls.find((c) => c.method === "conversations.replies")?.body.oldest).toBeUndefined();
    const verdicts = fx.expect.verdicts as Record<string, { role: string; ddPaths?: string[] }>;
    const wantCandidates = Object.entries(verdicts).filter(([, v]) => v.role === "candidate").map(([ts]) => ts).sort();
    expect(db.tables.exec_slack_messages.filter((m) => m.role !== "anchor").map((m) => m.ts).sort()).toEqual(wantCandidates);
    // WM11: the DD post is an anchor with its task path; the bot post and channel_join wrote nothing.
    expect(msgRow("1794149000.000300")).toMatchObject({ role: "anchor", is_dd_post: true, dd_paths: ["/tasks/t_42"], author_user_id: null });
    expect(msgRow("1794148500.000400")).toBeUndefined();
    expect(msgRow("1794148000.000500")).toBeUndefined();
    // WM10: his reaction.
    expect((fx.expect.acknowledged as string[]).map((ts) => msgRow(ts)?.acknowledged_at)).toEqual([NOW.toISOString()]);
    // WM09: his parent is thread participation; his later top-level message stamps the author it mentions (AN06).
    expect(db.tables.exec_slack_threads.find((t) => t.thread_ts === "1794100000.000300")).toMatchObject({ he_posted_ts: "1794100000.000300" });
    expect(msgRow("1794149400.000100")).toMatchObject({ responded_ts: "1794149700.000200" });
    expect(msgRow("1794070000.000800")).toMatchObject({ responded_ts: null });
    // WM03: fully paged → the watermark advances to the newest ts; only ts values in the progress columns (WM04).
    const ch = chRow(fx.channel) as Row;
    expect(ch.hist_watermark_ts).toBe(fx.expect.newWatermarkTs);
    expect(ch.deep_swept_at).toBe(NOW.toISOString());
    for (const k of ["hist_watermark_ts", "last_activity_ts"]) expect(String(ch[k])).toMatch(/^[0-9]+\.[0-9]+$/);
    assertNoSlackText(r, { label: "result" });
  });

  it("im-window: DM candidates, his message stamps the earlier ones, the reaction, the watermark", async () => {
    const fx = imWindow as unknown as Fixture;
    seed(fx, { channel: channelFromFixture(fx, { deep_swept_at: null }) });
    fixtureSlack(fx);
    await run();
    const verdicts = fx.expect.verdicts as Record<string, { role: string }>;
    expect(candidatesOf()).toEqual(Object.entries(verdicts).filter(([, v]) => v.role === "candidate").map(([ts]) => ts).sort());
    // AN01 / AN02: his later message stamps every earlier one of the IM; not a later one.
    expect(msgRow("1794147000.000100")).toMatchObject({ responded_ts: "1794148000.000300", acknowledged_at: NOW.toISOString() });
    expect(msgRow("1794149000.000400")).toMatchObject({ responded_ts: null });
    expect(chRow(fx.channel)?.hist_watermark_ts).toBe(fx.expect.newWatermarkTs);
  });

  it("WM05 / WM06 thread-old-parent: only the deep pass's latest_reply finds the new reply (one replies call, oldest = the thread watermark)", async () => {
    const fx = threadOldParent as unknown as Fixture;
    const deep = fx.expect.deep as { replyCalls: { ts: string; oldest: string }[]; candidates: string[]; newWatermarkTs: string };
    seed(fx);
    const s = fixtureSlack(fx);
    await run();
    expect(s.calls.filter((c) => c.method === "conversations.history").map((c) => c.body.oldest)).toEqual(["1793545200.000000"]);
    expect(s.calls.filter((c) => c.method === "conversations.replies").map((c) => ({ ts: c.body.ts, oldest: c.body.oldest }))).toEqual(deep.replyCalls);
    expect(candidatesOf()).toEqual(deep.candidates);
    expect(msgRow(deep.candidates[0])).toMatchObject({ reasons: 4, thread_ts: "1793890800.000100" });
    expect(chRow(fx.channel)?.hist_watermark_ts).toBe(deep.newWatermarkTs);
    expect(db.tables.exec_slack_threads.find((t) => t.thread_ts === "1793890800.000100")).toMatchObject({ reply_watermark_ts: "1794148000.000300", latest_reply_seen_ts: "1794148000.000300" });
    // The normal pass (deep sweep 1 h ago) doesn't fetch the parent, so it misses the reply until the next deep pass (documented).
    const normal = fx.expect.normal as { replyCalls: unknown[]; candidates: string[] };
    seed(fx, { channel: channelFromFixture(fx, { deep_swept_at: new Date(NOW_MS - 3_600_000).toISOString() }) });
    s.restore();
    const n = fixtureSlack(fx);
    await run();
    expect(n.calls.filter((c) => c.method === "conversations.history").map((c) => c.body.oldest)).toEqual(["1794145800.000100"]);
    expect(n.calls.filter((c) => c.method === "conversations.replies")).toEqual(normal.replyCalls);
    expect(candidatesOf()).toEqual(normal.candidates);
  });

  it("WM17 thread-tombstone: the tombstone deletes only its ts, even in a page-capped pass; the replies stay; the opted-out author writes nothing; the DD post anchors", async () => {
    const fx = threadTombstone as unknown as Fixture;
    seed(fx);
    const s = fixtureSlack(fx);
    await run();
    expect(s.calls.filter((c) => c.method === "conversations.history")).toHaveLength(3);
    expect(s.calls.filter((c) => c.method === "conversations.replies")).toEqual([]);
    expect(db.tables.exec_slack_deleted.map((d) => [d.ts, d.reason])).toEqual([["1794147500.000100", "tombstone"]]);
    expect(msgRow("1794147500.000100")).toBeUndefined();
    expect(msgRow("1794148000.000200")).toBeDefined();
    expect(db.tables.exec_slack_items.map((i) => i.ts)).toEqual(["1794148000.000200"]);
    expect(msgRow("1794148800.000200")).toBeUndefined();
    expect(msgRow("1794149000.000300")).toMatchObject({ role: "anchor", dd_paths: ["/tasks/t_77"] });
    // Page cap: the watermark stays; no absence delete.
    expect(chRow(fx.channel)?.hist_watermark_ts).toBe("1794146400.000100");
    expect(db.tables.exec_slack_deleted.filter((d) => d.reason === "absent")).toEqual([]);
  });
});

describe("WM01-WM04, WM07-WM08: passes, watermarks, absence", () => {
  const msgs = (n: number, base = 1794140000) => Array.from({ length: n }, (_, i) => rawMessage(`${base + n - i}.000100`, { user: "U0BOB", text: "lorem" }));
  it("WM01 the first sweep (no watermark) is deep: oldest = now − 7 days; WM02 a normal pass reads from the watermark − 10 min", async () => {
    useDb({ exec_slack_channels: [channelDbRow({ hist_watermark_ts: null })] });
    let s = installFakeSlack({ "conversations.history": () => historyPage([]) });
    await run();
    expect(s.calls[0].body.oldest).toBe("1793545200.000000");
    s.restore();
    useDb({ exec_slack_channels: [channelDbRow({ hist_watermark_ts: "1794146400.000100", deep_swept_at: new Date(NOW_MS - 3_600_000).toISOString() })] });
    s = installFakeSlack({ "conversations.history": () => historyPage([]) });
    await run();
    expect(s.calls[0].body).toMatchObject({ oldest: "1794145800.000100", limit: "200" });
  });

  it("WM03 a page cap leaves the watermark; WM04 no cursor is stored anywhere", async () => {
    useDb({ exec_slack_channels: [channelDbRow({ hist_watermark_ts: "1794146400.000100", deep_swept_at: new Date(NOW_MS - 3_600_000).toISOString() })] });
    let page = 0;
    const s = installFakeSlack({ "conversations.history": () => historyPage(msgs(2, 1794147000 + 10 * page++), { hasMore: true, nextCursor: `cur${page}` }) });
    await run();
    expect(s.calls).toHaveLength(3);
    const ch = chRow("C0GENERAL") as Row;
    expect(ch.hist_watermark_ts).toBe("1794146400.000100");
    // Integrator: no Slack cursor (cur1, cur2 or the capped page's cur3) reaches any write or job payload (mutant N31).
    expect(JSON.stringify(db.calls.map((c) => c.payload))).not.toMatch(/cur[0-9]/);
  });

  it("WM07 a deep, fully paged window missing a stored candidate → marked deleted (absent); WM08 with has_more left → nothing", async () => {
    const stored = messageDbRow({ ts: "1794000000.000100" });
    useDb({ exec_slack_channels: [channelDbRow({ hist_watermark_ts: null })], exec_slack_messages: [stored], exec_slack_items: [itemDbRow({ ts: "1794000000.000100" })] });
    let s = installFakeSlack({ "conversations.history": () => historyPage(msgs(3)) });
    expect(await run()).toMatchObject({ deleted: 1 });
    expect(db.tables.exec_slack_deleted.map((d) => [d.ts, d.reason])).toEqual([["1794000000.000100", "absent"]]);
    expect(db.tables.exec_slack_items).toEqual([]);
    s.restore();
    useDb({ exec_slack_channels: [channelDbRow({ hist_watermark_ts: null })], exec_slack_messages: [messageDbRow({ ts: "1794000000.000100" })] });
    s = installFakeSlack({ "conversations.history": () => historyPage(msgs(3), { hasMore: true, nextCursor: "more" }) });
    await run();
    expect(s.calls).toHaveLength(5);
    expect(db.tables.exec_slack_deleted).toEqual([]);
    expect(msgRow("1794000000.000100")).toBeDefined();
  });

  it("DM05 a stale sweep can't re-create a deleted message: a marked ts is blocked, no row", async () => {
    useDb({ exec_slack_channels: [channelDbRow()], exec_slack_deleted: [{ principal_id: PID, channel_id: "C0GENERAL", ts: "1794148000.000100", reason: "event",
      expires_at: new Date(NOW_MS + 26 * 3_600_000).toISOString(), created_at: NOW.toISOString() }] });
    installFakeSlack({ "conversations.history": () => historyPage([rawMessage("1794148000.000100", { text: `<@${HIM}> are you there?` })]) });
    await run();
    expect(msgRow("1794148000.000100")).toBeUndefined();
  });
});

describe("WM11-WM16: roles, the due rule, errors, the outage detector, the time box", () => {
  it("WM11 a hub keeps DD posts as anchors and nothing else", async () => {
    useDb({ exec_slack_channels: [channelDbRow({ channel_id: "C0OUT", class: "hub", hub_kind: "outbound", name: null })] });
    installFakeSlack({ "conversations.history": () => historyPage([
      rawMessage("1794148000.000100", { user: "U0DDBOT", bot_id: "B0DDBOT", app_id: "A0DDAPP", text: "<https://operations.scaledai.org/clients/c_1|Client>" }),
      rawMessage("1794148100.000100", { text: `<@${HIM}> what about this lead?` })
    ]) });
    await run();
    expect(db.tables.exec_slack_messages.map((m) => [m.ts, m.role, m.dd_paths])).toEqual([["1794148000.000100", "anchor", ["/clients/c_1"]]]);
  });

  it("WM12 the due rule: in-window bucket runs; off-window bucket 5 → off_window; bucket 6 runs; forced runs off-window", async () => {
    useDb({ exec_slack_channels: [] });
    installFakeSlack({ "conversations.history": () => historyPage([]) });
    // Sunday 10:00 New York: off the default Monday–Friday window.
    expect(await run({}, "exec.slack-read-sweep:ep_1:i5")).toEqual({ skipped: "off_window" });
    expect(await run({}, "exec.slack-read-sweep:ep_1:i6")).toMatchObject({ partial: false });
    expect(await run({ reason: "brief" }, "slack-sweep-now:ep_1:brief:1")).toMatchObject({ partial: false });
    vi.mocked(listUserSchedules).mockResolvedValue([{ userId: "u_1", weeklySchedule: { sun: { start: "09:00", end: "17:00" } } }] as never);
    expect(await run({}, "exec.slack-read-sweep:ep_1:i5")).toMatchObject({ partial: false });
    vi.mocked(listUserSchedules).mockRejectedValue(new Error("down"));
    expect(await run({}, "exec.slack-read-sweep:ep_1:i5")).toEqual({ skipped: "off_window" });
  });

  it("WM13 / PG12 not_in_channel on a private conversation → purged (lost access); channel_not_found on a public one → purged and deleted; not_in_channel on a public one → kept", async () => {
    useDb({ exec_slack_channels: [
      channelDbRow({ channel_id: "G0PRIV", conv_type: "group", is_private: true, name: "ops" }),
      channelDbRow({ channel_id: "C0DEAD", name: "dead" }),
      channelDbRow({ channel_id: "C0OPEN", name: "open" })
    ], exec_slack_messages: [messageDbRow({ channel_id: "G0PRIV" }), messageDbRow({ channel_id: "C0OPEN" })] });
    installFakeSlack({ "conversations.history": (body) => slackReadError(body.channel === "G0PRIV" ? "not_in_channel" : body.channel === "C0DEAD" ? "channel_not_found" : "not_in_channel") });
    const r = await run();
    expect(r).toMatchObject({ purged: 2 });
    expect(db.tables.exec_slack_messages.map((m) => m.channel_id)).toEqual(["C0OPEN"]);
    expect(chRow("C0DEAD")).toBeUndefined();
    expect(chRow("G0PRIV")).toBeDefined();
    expect(chRow("C0OPEN")).toBeDefined();
    expect(db.tables.exec_slack_purge_log.map((l) => [l.scope, l.channel_id, l.reason])).toEqual(expect.arrayContaining([["conversation", "G0PRIV", "lost_access"], ["conversation", "C0DEAD", "deleted"]]));
  });

  it("a thread that is gone (thread_not_found) is skipped; the rest of the conversation is swept", async () => {
    useDb({ exec_slack_channels: [channelDbRow({ hist_watermark_ts: null })], exec_slack_messages: [messageDbRow({ ts: "1794141000.000100", thread_ts: "1794140000.000100", reasons: 4 })] });
    installFakeSlack({
      "conversations.history": () => historyPage([rawMessage("1794140000.000100", { thread_ts: "1794140000.000100", reply_count: 1, latest_reply: "1794141000.000100" }),
        rawMessage("1794148000.000100", { text: `<@${HIM}> ping` })]),
      "conversations.replies": () => slackReadError("thread_not_found")
    });
    expect(await run()).toMatchObject({ conversations: 1, candidates: 1 });
    expect(msgRow("1794141000.000100")).toBeDefined();
    expect(chRow("C0GENERAL")?.swept_at).toBe(NOW.toISOString());
  });

  it("WM14 a rate limit mid-run → noteSlackRateLimited, the run stops partial, later conversations untouched", async () => {
    useDb({ exec_slack_channels: [channelDbRow({ channel_id: "C0A", name: "a", swept_at: "2026-11-08T10:00:00.000Z" }), channelDbRow({ channel_id: "C0B", name: "b", swept_at: "2026-11-08T11:00:00.000Z" })] });
    const s = installFakeSlack({ "conversations.history": slackRateLimitedAfter(7) });
    expect(await run()).toMatchObject({ partial: true, conversations: 0 });
    expect(noteSlackRateLimited).toHaveBeenCalledWith("T0SCALED", "conversations.history", 7000);
    expect(s.calls.map((c) => c.body.channel)).toEqual(["C0A"]);
    expect(chRow("C0B")?.swept_at).toBe("2026-11-08T11:00:00.000Z");
  });

  it("WM15 the outage detector: 25 human messages beyond last_event_ts + 10 min, the oldest 40 min old → one ops alert with counts; 10 → none", async () => {
    const human = (n: number) => Array.from({ length: n }, (_, i) => rawMessage(`${NOW_MS / 1000 - 2400 + i * 60}.000100`, { user: "U0BOB", text: "lorem" }));
    useDb({ exec_slack_channels: [channelDbRow({ last_event_ts: `${NOW_MS / 1000 - 4 * 3600}.000100` })] });
    let s = installFakeSlack({ "conversations.history": () => historyPage(human(25)) });
    expect(await run()).toMatchObject({ missed: 25 });
    expect(notifyOps).toHaveBeenCalledWith({ key: "exec-slack-events-missed:ep_1", title: "Executive Assistant: Slack events look stalled",
      detail: "25 messages in member conversations were found only by the sweep" });
    s.restore();
    vi.mocked(notifyOps).mockClear();
    useDb({ exec_slack_channels: [channelDbRow({ last_event_ts: `${NOW_MS / 1000 - 4 * 3600}.000100` })] });
    s = installFakeSlack({ "conversations.history": () => historyPage(human(10)) });
    await run();
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("WM16 the 120 s time box leaves later targets for the next bucket; IMs and group DMs come first", async () => {
    useDb({ exec_slack_channels: [channelDbRow({ channel_id: "C0A", name: "a" }), channelDbRow({ channel_id: "D0JANE", conv_type: "im", is_private: true, name: null })] });
    const s = installFakeSlack({ "conversations.history": () => {
      vi.setSystemTime(NOW_MS + 121_000);
      return historyPage([]);
    } });
    expect(await run()).toMatchObject({ partial: true, conversations: 1 });
    expect(s.calls.map((c) => c.body.channel)).toEqual(["D0JANE"]);
  });

  it("skips: reading off, the discovering half, a held lease; the schedule's gate", async () => {
    useDb({ exec_slack_channels: [channelDbRow()] });
    const s = installFakeSlack({});
    vi.mocked(loadSettings).mockResolvedValueOnce(settings({ slackReadingEnabled: false }));
    expect(await run()).toEqual({ skipped: "reading_off" });
    vi.mocked(tryAcquireLease).mockResolvedValueOnce(false);
    expect(await run()).toEqual({ skipped: "lease" });
    expect(s.calls).toEqual([]);
    expect(slackReadSweepScheduledWork).toMatchObject({ cadence: { kind: "interval", minutes: 30 }, maxAttempts: 1, lane: "bulk" });
    expect(slackReadSweepScheduledWork.enabled?.(settings({ slackReadingEnabled: false }))).toBe(false);
    expect(slackReadSweepScheduledWork.enabled?.(settings())).toBe(true);
  });
});

describe("WM-FX: the P7a fixer's sweep rules", () => {
  it("WM-FX1 (correctness-2): every metered read may wait into the limiter's next window, never past the 120 s box", async () => {
    useDb({ exec_slack_channels: [channelDbRow({ channel_id: "C0A", name: "a" }), channelDbRow({ channel_id: "C0B", name: "b" })] });
    installFakeSlack({ "conversations.history": (body) => {
      if (body.channel === "C0A") vi.setSystemTime(NOW_MS + 100_000);
      return historyPage([]);
    } });
    expect(await run()).toMatchObject({ conversations: 2, partial: false });
    const waits = vi.mocked(takeSlackBudget).mock.calls.map((c) => [c[1], c[3]?.maxWaitMs]);
    // At the start a full window (60 s and a second); 100 s in, only what is left of the box (20 s).
    expect(waits).toEqual([["conversations.history", 61_000], ["conversations.history", 20_000]]);
  });

  it("WM-FX2 (correctness-3): a conversation he or Slack muted is still swept: his mention there becomes a candidate (it bypasses the mute); a reply in his thread doesn't; a finance default mute isn't swept at all", async () => {
    const root = "1794140000.000100";
    useDb({ exec_slack_channels: [channelDbRow({ watch_state: "muted", mute_source: "slack" }),
      channelDbRow({ channel_id: "C0FIN", name: "payroll", class: "finance", finance_name: true, watch_state: "muted", mute_source: "default_finance" })] });
    const s = installFakeSlack({ "conversations.history": () => historyPage([
      rawMessage("1794149000.000100", { text: `<@${HIM}> can you review the hiring plan today` }),
      rawMessage("1794149100.000100", { text: "a reply under his thread", thread_ts: root, parent_user_id: HIM })
    ]) });
    await run();
    expect(s.calls.map((c) => c.body.channel)).toEqual(["C0GENERAL"]);
    expect(candidatesOf()).toEqual(["1794149000.000100"]);
    expect(msgRow("1794149000.000100")).toMatchObject({ reasons: 2, triage_state: "pending" });
  });
});

describe("AN: answered stamping through the sweep (SQL twin RQ15)", () => {
  // A normal pass (deep sweep an hour ago): the stored rows below are older than the window, so no absence delete touches them.
  const NORMAL = { hist_watermark_ts: "1794146400.000100", deep_swept_at: new Date(NOW_MS - 3_600_000).toISOString() };
  const sweepOnce = async (ch: Row, messages: Record<string, unknown>[], stored: Row[] = [], extra: Partial<Record<string, Row[]>> = {}) => {
    useDb({ exec_slack_channels: [ch], exec_slack_messages: stored, ...extra });
    installFakeSlack({ "conversations.history": () => historyPage(messages), "conversations.replies": () => historyPage([]) });
    await run();
  };
  const IM = channelDbRow({ channel_id: "D0JANE", conv_type: "im", is_private: true, name: null, im_user_id: "U0JANE", ...NORMAL });
  const MPIM = channelDbRow({ channel_id: "G0MPIM", conv_type: "mpim", is_private: true, name: null, ...NORMAL });

  it("AN03 / AN04 a reply of his stamps that thread's parent and earlier replies only; a top-level message of his doesn't stamp a thread", async () => {
    await sweepOnce(channelDbRow(NORMAL), [rawMessage("1794148000.000100", { user: HIM, text: "top level note" })], [
      messageDbRow({ ts: "1794140000.000100", thread_ts: null, reasons: 2 }),
      messageDbRow({ ts: "1794141000.000100", thread_ts: "1794140000.000100", reasons: 4 })
    ]);
    expect(db.tables.exec_slack_messages.map((m) => m.responded_ts)).toEqual([null, null]);
    useDb({ exec_slack_channels: [channelDbRow(NORMAL)], exec_slack_messages: [
      messageDbRow({ ts: "1794140000.000100", thread_ts: null, reasons: 2 }),
      messageDbRow({ ts: "1794141000.000100", thread_ts: "1794140000.000100", reasons: 4 }),
      messageDbRow({ ts: "1794142000.000100", thread_ts: "1794139000.000100", reasons: 4 })
    ], exec_slack_threads: [] });
    installFakeSlack({
      "conversations.history": () => historyPage([rawMessage("1794140000.000100", { thread_ts: "1794140000.000100", reply_count: 2, latest_reply: "1794143000.000100" })]),
      "conversations.replies": () => historyPage([rawMessage("1794140000.000100"), rawMessage("1794141000.000100", { thread_ts: "1794140000.000100" }),
        rawMessage("1794143000.000100", { user: HIM, thread_ts: "1794140000.000100", text: "on it" })])
    });
    await run();
    expect(db.tables.exec_slack_messages.map((m) => [m.ts, m.responded_ts])).toEqual([
      ["1794140000.000100", "1794143000.000100"], ["1794141000.000100", "1794143000.000100"], ["1794142000.000100", null]
    ]);
  });

  it("AN05 MPIM: his top-level message stamps earlier top-level items; a threaded reply stamps only its thread", async () => {
    await sweepOnce(MPIM, [rawMessage("1794148000.000100", { user: HIM, text: "noted" })], [
      messageDbRow({ channel_id: "G0MPIM", ts: "1794140000.000100", reasons: 1 }),
      messageDbRow({ channel_id: "G0MPIM", ts: "1794141000.000100", thread_ts: "1794139000.000100", reasons: 4 })
    ]);
    expect(db.tables.exec_slack_messages.map((m) => m.responded_ts)).toEqual(["1794148000.000100", null]);
  });

  it("AN06 channel: his later top-level message stamps the earlier top-level items of the author it mentions only", async () => {
    await sweepOnce(channelDbRow(NORMAL), [rawMessage("1794148000.000100", { user: HIM, text: "<@U0JANE> done" })], [
      messageDbRow({ ts: "1794140000.000100", author_user_id: "U0JANE" }),
      messageDbRow({ ts: "1794141000.000100", author_user_id: "U0BOB" })
    ]);
    expect(db.tables.exec_slack_messages.map((m) => m.responded_ts)).toEqual(["1794148000.000100", null]);
  });

  it("AN07 a DD-template post as him is an anchor, never an answer", async () => {
    await sweepOnce(IM, [rawMessage("1794148000.000100", { user: HIM, app_id: "A0DDAPP", text: "FYI" })], [messageDbRow({ channel_id: "D0JANE", ts: "1794140000.000100", reasons: 1 })]);
    expect(msgRow("1794140000.000100")).toMatchObject({ responded_ts: null });
    expect(msgRow("1794148000.000100")).toMatchObject({ role: "anchor" });
  });

  it("AN08 a check-in ts (exec_brief_checkins exists) stamps nothing; without the table stamping works", async () => {
    await sweepOnce(IM, [rawMessage("1794148000.000100", { user: HIM, text: "checking in" })], [messageDbRow({ channel_id: "D0JANE", ts: "1794140000.000100", reasons: 1 })],
      { exec_brief_checkins: [{ principal_id: PID, slack_ts: "1794148000.000100" }] });
    expect(msgRow("1794140000.000100")).toMatchObject({ responded_ts: null });
    await sweepOnce(IM, [rawMessage("1794148000.000100", { user: HIM, text: "checking in" })], [messageDbRow({ channel_id: "D0JANE", ts: "1794140000.000100", reasons: 1 })]);
    expect(msgRow("1794140000.000100")).toMatchObject({ responded_ts: "1794148000.000100" });
  });

  it("AN10 an item written by triage after the stamp inherits responded_ts from the locked message row", async () => {
    await sweepOnce(IM, [rawMessage("1794148000.000100", { user: HIM, text: "ok" })], [messageDbRow({ channel_id: "D0JANE", ts: "1794140000.000100", reasons: 1 })]);
    await writeTriageResult(PRINCIPAL, "D0JANE", [{ ts: "1794140000.000100", kind: "request", author: "U0JANE", author_label: "Jane", author_external: false,
      author_internal_verified: true, assessed: true, addressed: true, needs_response: true, bypass_mute: false, urgency: "normal", summary: "x", excerpt: "y",
      due_text: null, due_at: null, direction: null, source_class: "private" }], [{ ts: "1794140000.000100", state: "assessed", content_hash: null }]);
    expect(db.tables.exec_slack_items[0]).toMatchObject({ responded_ts: "1794148000.000100" });
  });

  it("AN11 his own mitchell_owes commitment is stamped by his later message in the same thread", async () => {
    useDb({ exec_slack_channels: [channelDbRow(NORMAL)], exec_slack_messages: [
      messageDbRow({ ts: "1794141000.000100", thread_ts: "1794140000.000100", author_user_id: HIM, role: "item", reasons: 4, triage_state: "assessed" })
    ], exec_slack_items: [itemDbRow({ ts: "1794141000.000100", thread_ts: "1794140000.000100", kind: "commitment", commitment_direction: "mitchell_owes", author_user_id: HIM })] });
    expect(db.tables.exec_slack_items[0].responded_ts).toBeNull();
    installFakeSlack({
      "conversations.history": () => historyPage([rawMessage("1794140000.000100", { thread_ts: "1794140000.000100", reply_count: 2, latest_reply: "1794146000.000100" })]),
      "conversations.replies": () => historyPage([rawMessage("1794140000.000100"), rawMessage("1794146000.000100", { user: HIM, thread_ts: "1794140000.000100", text: "sent it" })])
    });
    await run();
    expect(db.tables.exec_slack_items[0]).toMatchObject({ responded_ts: "1794146000.000100" });
  });

  it("AN12 stamping writes no text and kicks attention once per batch", async () => {
    await sweepOnce(IM, [rawMessage("1794148000.000100", { user: HIM, text: `${S.text} replying` }), rawMessage("1794149000.000100", { user: HIM, text: `${S.text} again` })], [
      messageDbRow({ channel_id: "D0JANE", ts: "1794140000.000100", reasons: 1 }), messageDbRow({ channel_id: "D0JANE", ts: "1794141000.000100", reasons: 1 })
    ]);
    const call = db.calls.find((c) => c.kind === "rpc" && c.target === "exec_slack_note_from_him");
    assertNoSlackText(call?.payload, { label: "note_from_him" });
    expect(db.tables.exec_jobs.filter((j) => j.kind === "exec.slack-attention")).toHaveLength(1);
  });
});

describe("PG17 (the sweep half) and opt-outs", () => {
  it("an opted-out author's messages in a sweep window write nothing", async () => {
    useDb({ exec_slack_channels: [channelDbRow({ channel_id: "D0JANE", conv_type: "im", is_private: true, name: null })],
      exec_slack_author_optouts: [{ principal_id: PID, author_user_id: "U0JANE", created_at: NOW.toISOString() }] });
    installFakeSlack({ "conversations.history": () => historyPage([rawMessage("1794148000.000100", { text: "please call me back about the contract" })]) });
    await run();
    expect(db.tables.exec_slack_messages).toEqual([]);
    expect(INST).toMatch(/^esi_/);
  });
});
