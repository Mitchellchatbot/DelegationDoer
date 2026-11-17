import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-install")>()),
  openReadingInstallation: vi.fn(),
  recordUserTokenError: vi.fn(async () => undefined),
  enqueueUserCheck: vi.fn(async () => undefined),
  clearUserTokenError: vi.fn(async () => undefined)
}));
vi.mock("@/lib/exec/slack-rate", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/slack-rate")>()),
  takeSlackBudget: vi.fn(async () => undefined),
  noteSlackRateLimited: vi.fn(async () => undefined)
}));
vi.mock("@/lib/exec/sources/slack", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/sources/slack")>()),
  readHistoryShapes: vi.fn(),
  listMemberChannels: vi.fn()
}));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/sources/dd")>()),
  listFbLeadChannelsV2: vi.fn(),
  listUserSchedules: vi.fn(async () => [])
}));
vi.mock("@/lib/exec/dd-bot", () => ({ getDdBotIdentity: vi.fn() }));
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn(async () => true) }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/sync-state")>()),
  getSyncState: vi.fn(),
  putSyncState: vi.fn(),
  tryAcquireLease: vi.fn(async () => true),
  releaseLease: vi.fn(async () => undefined)
}));
vi.mock("@/lib/exec/llm/client", () => ({ callModel: vi.fn(() => { throw new Error("no model call in a lead run"); }) }));

import leadPages from "@/lib/exec/__tests__/fixtures/p10/lead-history-pages.json";
import { createFakeLeadDb, type FakeLeadDb } from "@/lib/exec/__tests__/fake-lead-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { assertNoLeadText } from "@/lib/exec/__tests__/p10-assert";
import { getDdBotIdentity } from "@/lib/exec/dd-bot";
import { slackLeadCountJobHandler, slackLeadCountScheduledWork } from "@/lib/exec/handlers/slack-lead-count";
import { enqueueJob } from "@/lib/exec/jobs";
import { callModel } from "@/lib/exec/llm/client";
import { notifyOps } from "@/lib/exec/ops";
import { DEFAULT_SETTINGS, loadSettings } from "@/lib/exec/principal";
import { openReadingInstallation, recordUserTokenError } from "@/lib/exec/slack-install";
import { __resetLeadStoreForTests } from "@/lib/exec/slack-leads-store";
import { SLACK_P10_OPS } from "@/lib/exec/slack-p10-copy";
import { P10_JOB_KINDS, P10_LIMITS, type FbLeadListRow, type LeadPostShape, type LeadRunSummary } from "@/lib/exec/slack-p10-types";
import { tsToMs, type ReadingInstallation } from "@/lib/exec/slack-read-types";
import { DdReadError, listFbLeadChannelsV2 } from "@/lib/exec/sources/dd";
import { SlackApiError, listMemberChannels, readHistoryShapes } from "@/lib/exec/sources/slack";
import { getSyncState, parseLeadRunSummary, putSyncState, tryAcquireLease } from "@/lib/exec/sync-state";
import { localTimeToUtc } from "@/lib/exec/time";
import type { ExecPrincipal, ExecSettings, JobContext } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P10 §5.3 (LC01-LC20; contract §3.4.5, C13-C24, v1.1 correctness-2, -11, product-2, -10): exec.slack-lead-count against the
// fake lead DB (Area A's §5.14 fake, whose functions mirror the SQL), the lead fixtures, and the two Slack readers mocked at
// their module boundary (Area D writes them). Invented names only.

const NOW = new Date(leadPages.now);
const TZ = leadPages.tz;
const INST = `esi_${"a".repeat(32)}`;
const P = { id: "ep_1", userId: "u_1", timezone: TZ, briefTimezone: TZ, workTimezone: TZ } as unknown as ExecPrincipal;
const RI = {
  row: { id: INST, teamId: leadPages.teamId, userId: leadPages.him, dmChannelId: "D0ASSIST", botUserId: "U0ABOT" },
  reading: { state: "ready", scopes: ["channels:history", "groups:history", "channels:read", "groups:read", "users:read"], installedAt: NOW.toISOString(),
    revokedAt: null, revokeReason: null, discoveredAt: "2026-11-09T10:00:00.000Z", purgedAt: null, lastErrorCode: null, lastErrorAt: null, hasToken: true },
  target: { userToken: "xoxp-fake-1", teamId: leadPages.teamId, userId: leadPages.him }
} as unknown as ReadingInstallation;

const settings = (over: Partial<ExecSettings> = {}): ExecSettings => ({
  principalId: "ep_1", ...DEFAULT_SETTINGS, slackReadingSchemaReady: true, slackReadingEnabled: true, slackP10SchemaReady: true,
  slackLeadCountsEnabled: true, ...over
});

let db: FakeLeadDb;
let sync: Map<string, unknown>;
let feeds: Map<string, LeadPostShape[]>;
let reads: { channel: string; oldest: string; latest: string | null; limit: number; cursor: string | null }[];
let readFail: ((q: { channel: string; limit: number; cursor: string | null }) => Error | null) | null;
let memberFail: Error | null;
const logs: unknown[][] = [];

/** P7a's rows for the fixture's markers (deny markers are bare: no name). */
function channelRows(): Row[] {
  return leadPages.markers.map((m) => ({
    principal_id: "ep_1", channel_id: m.channelId, installation_id: INST, conv_type: m.convType, class: m.class, deny_reason: m.denyReason,
    name: m.class === "deny" ? null : m.channelId === "C0ACMEOPS" ? "acme-recovery-ops" : null
  }));
}

function job(over: Partial<JobContext["job"]> = {}, payload: unknown = { reason: "settings" }): JobContext {
  return {
    principal: P,
    signal: new AbortController().signal,
    workerId: "w1",
    job: { id: 7, kind: P10_JOB_KINDS.leadCount, lane: "bulk", payload, attempts: 1, max_attempts: 1, dedupe_key: null, ...over }
  } as unknown as JobContext;
}

const run = (ctx: JobContext = job()) => slackLeadCountJobHandler.run(ctx) as Promise<Record<string, unknown>>;
const summary = (): LeadRunSummary | null => parseLeadRunSummary(sync.get("slack/lead-run") ?? null);
const countsOf = (channel: string) => db.tables.exec_slack_lead_counts.filter((r) => r.channel_id === channel)
  .map((r) => ({ day: String(r.local_day), n: r.n, skipped: r.skipped, complete: r.complete }))
  .sort((a, b) => (a.day < b.day ? -1 : 1));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  __resetLeadStoreForTests();
  db = createFakeLeadDb({ now: () => new Date(), tables: { exec_slack_channels: channelRows(), exec_slack_installations: [{ id: INST, principal_id: "ep_1" }] } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  vi.mocked(loadSettings).mockResolvedValue(settings());
  vi.mocked(openReadingInstallation).mockResolvedValue(RI);
  vi.mocked(getDdBotIdentity).mockResolvedValue({ teamId: leadPages.teamId, userId: "U0DDBOT", botId: "B0DDBOT", appId: "A0DDAPP", checkedAt: NOW.toISOString() });
  vi.mocked(listFbLeadChannelsV2).mockResolvedValue(leadPages.fbList as FbLeadListRow[]);
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 1 });
  sync = new Map();
  vi.mocked(getSyncState).mockImplementation(async (_p, source, key, parse) => {
    const v = sync.get(`${source}/${key}`);
    const value = v === undefined ? null : parse(v);
    return value === null ? null : { value, rev: 1 };
  });
  vi.mocked(putSyncState).mockImplementation(async (_p, source, key, value) => {
    sync.set(`${source}/${key}`, JSON.parse(JSON.stringify(value)));
  });
  feeds = new Map(leadPages.channels.map((c) => [c.channelId, [...(c.expect.shapes as LeadPostShape[])]]));
  reads = [];
  readFail = null;
  memberFail = null;
  vi.mocked(readHistoryShapes).mockImplementation(async (_t, q) => {
    reads.push({ channel: q.channel, oldest: q.oldest, latest: q.latest, limit: q.limit, cursor: q.cursor ?? null });
    const err = readFail?.({ channel: q.channel, limit: q.limit, cursor: q.cursor ?? null }) ?? null;
    if (err) throw err;
    const lo = tsToMs(q.oldest);
    const hi = q.latest === null ? Number.POSITIVE_INFINITY : tsToMs(q.latest);
    const all = (feeds.get(q.channel) ?? []).filter((s) => tsToMs(s.ts) >= lo && tsToMs(s.ts) <= hi);
    const start = q.cursor ? Number(q.cursor) : 0;
    const page = all.slice(start, start + q.limit);
    const next = start + q.limit < all.length ? String(start + q.limit) : null;
    return { shapes: page, hasMore: next !== null, nextCursor: next };
  });
  vi.mocked(listMemberChannels).mockImplementation(async (_t, q) => {
    if (memberFail) throw memberFail;
    const pages = leadPages.memberPages.map((p) => p.response.channels.map((c) => ({ id: c.id, name: c.name })));
    const i = q.cursor ? 1 : 0;
    return { channels: pages[i], nextCursor: i === 0 ? "dXNlcl9jb252c18y" : null };
  });
  logs.length = 0;
  for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logs.push(a); });
});

describe("LC01 gates", () => {
  const cases: [string, () => void, string][] = [
    ["the switch off", () => vi.mocked(loadSettings).mockResolvedValue(settings({ slackLeadCountsEnabled: false })), "off"],
    ["reading off", () => vi.mocked(loadSettings).mockResolvedValue(settings({ slackReadingEnabled: false })), "reading_off"],
    ["the P10 schema missing", () => vi.mocked(loadSettings).mockResolvedValue(settings({ slackP10SchemaReady: false })), "not_installed"],
    ["the P7a schema missing", () => vi.mocked(loadSettings).mockResolvedValue(settings({ slackReadingSchemaReady: false })), "not_installed"],
    ["the lead tables missing", () => db.missing.add("exec_slack_lead_channels"), "not_installed"],
    ["no reader", () => vi.mocked(openReadingInstallation).mockResolvedValue(null), "not_reading"],
    ["not discovered yet", () => vi.mocked(openReadingInstallation).mockResolvedValue({ ...RI, reading: { ...RI.reading, discoveredAt: null } }), "not_reading"]
  ];
  for (const [name, arrange, skipped] of cases) {
    it(`${name} → skipped ${skipped}; no Slack call, no write`, async () => {
      arrange();
      expect(await run()).toEqual({ skipped });
      expect(reads).toHaveLength(0);
      expect(vi.mocked(listMemberChannels)).not.toHaveBeenCalled();
      expect(db.mutations()).toBe(0);
      expect(vi.mocked(putSyncState)).not.toHaveBeenCalled();
    });
  }
});

describe("LC02 / LC03 the due rule and the lease", () => {
  it("an odd bucket outside his window is skipped; forced runs; a partial last run runs", async () => {
    vi.mocked(loadSettings).mockResolvedValue(settings());
    const off = job({ dedupe_key: "exec.slack-lead-count:ep_1:i29437" }, {});   // Tuesday 10:00 local is in the window; use a Saturday below
    vi.setSystemTime(new Date("2026-11-07T15:00:00.000Z"));   // Saturday: outside the default Monday–Friday window
    expect(await run(off)).toEqual({ skipped: "off_window" });
    sync.set("slack/lead-run", { at: "2026-11-07T14:00:00.000Z", complete: false, partial: true, needsFinal: 0, channels: 6, counted: 3, pages: 100 });
    const r = await run(off);
    expect(r).not.toHaveProperty("skipped");
    vi.setSystemTime(NOW);
  });
  it("a held lease → skipped lease, nothing read", async () => {
    vi.mocked(tryAcquireLease).mockResolvedValueOnce(false);
    expect(await run()).toEqual({ skipped: "lease" });
    expect(reads).toHaveLength(0);
    expect(vi.mocked(tryAcquireLease).mock.calls[0][1]).toBe("slack-leads-lease");
    expect(vi.mocked(tryAcquireLease).mock.calls[0][3]).toBe(P10_LIMITS.leadLeaseMs);
  });
});

describe("LC04 a DD read failure of the typed list", () => {
  it("→ skipped dd_read: no count, no lead row, no Slack read; P10 fixer ui-5: the run summary says it failed (dd_read)", async () => {
    vi.mocked(listFbLeadChannelsV2).mockRejectedValueOnce(new DdReadError("exec_slack_fb_lead_channels_v2", "57014"));
    expect(await run()).toEqual({ skipped: "dd_read" });
    expect(db.mutations()).toBe(0);
    expect(reads).toHaveLength(0);
    // A first run that never gets the list isn't "the first time" forever: a failing summary (counts and a code only).
    expect(vi.mocked(putSyncState)).toHaveBeenCalledTimes(1);
    expect(summary()).toMatchObject({ complete: false, partial: true, failingRuns: 1, failCode: "dd_read", channels: 0, listedNotMember: 0, notMember: [] });
    assertNoLeadText(sync.get("slack/lead-run"));
  });
  it("P10 fixer ui-5: after a good run, a dd_read failure carries its coverage, counts failing runs and alerts on the third", async () => {
    await run();
    const good = summary();
    for (let i = 1; i <= 3; i += 1) {
      vi.mocked(listFbLeadChannelsV2).mockRejectedValueOnce(new DdReadError("exec_slack_fb_lead_channels_v2", "57014"));
      expect(await run()).toEqual({ skipped: "dd_read" });
      expect(summary()).toMatchObject({ failingRuns: i, failCode: "dd_read", channels: good?.channels, listedNotMember: good?.listedNotMember,
        notMember: good?.notMember });
    }
    expect(vi.mocked(notifyOps)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyOps).mock.calls[0][0]).toMatchObject({ key: SLACK_P10_OPS.leadRunFailing.key("ep_1"), title: SLACK_P10_OPS.leadRunFailing.title,
      detail: "3 lead-count runs in a row ended on dd_read." });
    // The next good run resets it.
    await run();
    expect(summary()).toMatchObject({ failingRuns: 0, failCode: null });
  });
});

describe("P10 fixer ui-5: a partial membership listing proves nobody's absence", () => {
  it("a first run whose listing failed reports no listed-but-not-a-member entries; a later partial run carries the last complete run's", async () => {
    memberFail = new SlackApiError("users.conversations", "ratelimited", { errorClass: "retryable" });
    await run();
    expect(summary()).toMatchObject({ complete: false, partial: true, listedNotMember: 0, notMember: [] });
    memberFail = null;
    await run();
    const good = summary();
    expect(good).toMatchObject({ complete: true, listedNotMember: 2 });
    memberFail = new SlackApiError("users.conversations", "internal_error", { errorClass: "retryable" });
    await run();
    expect(summary()).toMatchObject({ complete: false, listedNotMember: 2, notMember: good?.notMember });
  });
});

describe("P10 fixer correctness-2: the brief's forced run retries a failed final pass before the brief reads yesterday", () => {
  it("a final pass that failed at 01:00 is retried by the brief's run (reason brief), not by the hourly ones (6-hour gate)", async () => {
    await run();
    // Yesterday's final pass failed 5 hours ago on every channel: final_through still the day before.
    db.tables.exec_slack_lead_channels.forEach((l) => { l.final_through = "2026-11-08"; l.final_attempt_at = new Date(NOW.getTime() - 5 * 3_600_000).toISOString(); });
    const weekStart = localTimeToUtc("2026-11-03", "00:00", TZ).getTime();
    const todayStart = localTimeToUtc("2026-11-10", "00:00", TZ).getTime();
    reads = [];
    await run(job({}, { reason: "settings" }));
    expect(reads.length).toBeGreaterThan(0);
    for (const q of reads) expect(tsToMs(q.oldest)).toBe(todayStart);
    reads = [];
    await run(job({}, { reason: "brief" }));
    expect(reads.length).toBeGreaterThan(0);
    for (const q of reads) expect(tsToMs(q.oldest)).toBe(weekStart);
    const vob = db.tables.exec_slack_lead_channels.find((l) => l.channel_id === "C0LEADVOB1");
    expect(String(vob?.final_through)).toBe("2026-11-09");
  });
});

describe("LC05 / LC07 / LC17 the fixture's six channels", () => {
  it("every counted channel's days are exactly its expect.days; the summary and the result hold counts and codes only", async () => {
    const r = await run();
    expect(r).toEqual({ channels: 6, counted: 6, pages: 6, partial: false, needsFinal: 0, errors: {} });   // one 100-post page each
    for (const ch of leadPages.channels) expect(countsOf(ch.channelId), ch.channelId).toEqual(ch.expect.days);
    const s = summary();
    expect(s).toMatchObject({ complete: true, partial: false, needsFinal: 0, channels: 6, counted: 6, pages: 6, listedNotMember: 2,
      classifyEnqueued: 1, errors: {}, failingRuns: 0, failCode: null });
    expect(new Set(s?.notMember.map((n) => `${n.taskId}#${n.i}`))).toEqual(new Set(["t_acme_onb#1", "t_zenith_onb#2"]));
    // the lead rows: kinds, links and DD labels, and no Slack name
    const rows = db.tables.exec_slack_lead_channels.map((l) => ({ channelId: l.channel_id, kind: l.kind, link: l.link, taskId: l.task_id ?? null,
      clientId: l.client_id ?? null, clientLabel: l.client_label ?? null })).sort((a, b) => (String(a.channelId) < String(b.channelId) ? -1 : 1));
    expect(rows).toEqual(leadPages.expectMap.rows);
    expect(JSON.stringify(db.tables)).not.toContain("sentinel-patient-name");
  });
  it("LC07: a lead marker he isn't in, a kind-other row and every non-lead channel are never read", async () => {
    await run();
    const named = new Set(reads.map((r) => r.channel));
    for (const id of leadPages.neverRead) expect(named.has(id), id).toBe(false);
    expect([...named].sort()).toEqual(leadPages.channels.map((c) => c.channelId).sort());
  });
  it("LC07 (C18): a lead marker he isn't in stays unread even when its card names it by URL with a VOB name", async () => {
    // Integrator (contract section 5.17, M13): the fixture types its one non-member lead marker (C0LEADNOT1) as
    // "zenith-house-fb-leads", a kind the count skips anyway; typed as a VOB channel it is a channel the run would read if
    // the map ever took a marker he isn't in.
    vi.mocked(listFbLeadChannelsV2).mockResolvedValue((leadPages.fbList as FbLeadListRow[]).map((r) =>
      (r.channelId === "C0LEADNOT1" ? { ...r, name: "zenith-house-fb-vob-leads" } : r)));
    const r = await run();
    const named = new Set(reads.map((q) => q.channel));
    expect(named.has("C0LEADNOT1")).toBe(false);
    expect([...named].sort()).toEqual(leadPages.channels.map((c) => c.channelId).sort());
    expect(db.tables.exec_slack_lead_channels.some((l) => l.channel_id === "C0LEADNOT1")).toBe(false);
    expect(r).toMatchObject({ channels: 6 });
  });
  it("LC17 (C21): no lead channel id in the result, the sync-state value, a log line or an alert", async () => {
    const r = await run();
    const ids = leadPages.markers.map((m) => m.channelId);
    const out = JSON.stringify([r, sync.get("slack/lead-run"), logs, vi.mocked(notifyOps).mock.calls]);
    for (const id of ids) expect(out, id).not.toContain(id);
    assertNoLeadText([r, sync.get("slack/lead-run")]);
    // The same on a channel's own error, a dropped channel and a run that ends on an auth error (M12).
    readFail = (q) => (q.channel === "C0LEADVOB2" ? new SlackApiError("conversations.history", "internal_error", { errorClass: "retryable" })
      : q.channel === "C0LEADCAL1" ? new SlackApiError("conversations.history", "not_in_channel", { errorClass: "fatal" }) : null);
    const r2 = await run();
    expect(r2.errors).toEqual({ internal_error: 1, not_in_channel: 1 });
    readFail = (q) => (q.channel === "C0LEADNON1" ? new SlackApiError("conversations.history", "invalid_auth", { errorClass: "auth" }) : null);
    await expect(run()).rejects.toBeInstanceOf(SlackApiError);
    const out2 = JSON.stringify([r2, sync.get("slack/lead-run"), logs, vi.mocked(notifyOps).mock.calls]);
    expect(logs.length).toBeGreaterThan(0);
    for (const id of ids) expect(out2, id).not.toContain(id);
  });
  it("reads newest first from the window's first local midnight, in P7a's sweep class with the run's box", async () => {
    await run();
    const oldest = (localTimeToUtc("2026-11-03", "00:00", TZ).getTime() / 1000).toFixed(6);
    for (const q of reads) {
      expect(Number(q.oldest)).toBeCloseTo(Number(oldest), 3);
      expect(q.latest).toBeNull();
      expect(q.limit).toBe(P10_LIMITS.leadPageLimit);
    }
  });
});

describe("LC06 a membership page failure", () => {
  it("→ applyLeadMap with complete false: nothing deleted, the run partial", async () => {
    await run();
    const before = db.tables.exec_slack_lead_channels.length;
    db.tables.exec_slack_lead_channels.push({ principal_id: "ep_1", channel_id: "C0STALE1", installation_id: INST, kind: "vob", link: "none",
      mapped_at: NOW.toISOString(), expires_at: new Date(NOW.getTime() + 86_400_000).toISOString(), created_at: NOW.toISOString(), updated_at: NOW.toISOString() });
    db.tables.exec_slack_channels.push({ principal_id: "ep_1", channel_id: "C0STALE1", installation_id: INST, conv_type: "channel", class: "deny", deny_reason: "lead_name", name: null });
    memberFail = new SlackApiError("users.conversations", "internal_error", { errorClass: "retryable" });
    const r = await run();
    expect(r.partial).toBe(true);
    expect(db.tables.exec_slack_lead_channels.some((l) => l.channel_id === "C0STALE1")).toBe(true);
    expect(db.tables.exec_slack_lead_channels.length).toBe(before + 1);
    expect(reads.filter((q) => q.channel === "C0STALE1")).toHaveLength(0);
  });
});

describe("LC08 the 8-day pass, then today only (C15, v1.1 correctness-2)", () => {
  it("finalThrough = yesterday after a complete pass; the next run reads today only", async () => {
    await run();
    const vob = db.tables.exec_slack_lead_channels.find((l) => l.channel_id === "C0LEADVOB1");
    expect(String(vob?.final_through)).toBe("2026-11-09");
    expect(vob?.final_attempt_at).not.toBeNull();
    reads = [];
    await run();
    const todayStart = localTimeToUtc("2026-11-10", "00:00", TZ).getTime();
    for (const q of reads) expect(tsToMs(q.oldest)).toBe(todayStart);
  });
  it("a capped final pass stamps final_attempt_at, keeps older complete days, and falls back to one read per day", async () => {
    // A flood two days ago (1,100 posts on 2026-11-08) on the VOB channel: the whole-window read caps.
    const flood: LeadPostShape[] = Array.from({ length: 1100 }, (_, k) => ({
      ts: `${Math.floor(localTimeToUtc("2026-11-08", "12:00", TZ).getTime() / 1000) - k}.000100`, reply: false, bot: true, excluded: false, hidden: false, subtypeClass: "bot_message"
    }));
    const vobShapes = (feeds.get("C0LEADVOB1") ?? []).filter((s) => !s.ts.startsWith("x"));
    feeds.set("C0LEADVOB1", [...vobShapes.filter((s) => tsToMs(s.ts) > tsToMs(flood[0].ts)), ...flood, ...vobShapes.filter((s) => tsToMs(s.ts) < tsToMs(flood[flood.length - 1].ts))]
      .sort((a, b) => tsToMs(b.ts) - tsToMs(a.ts)));
    // A stored complete day before the flood that the capped read must never overwrite with a smaller number.
    await run();
    const counts = countsOf("C0LEADVOB1");
    const nov08 = counts.find((d) => d.day === "2026-11-08");
    expect(nov08?.complete).toBe(false);   // a day alone over the per-day cap: a lower bound
    expect(Number(nov08?.n)).toBeGreaterThanOrEqual(990);   // the per-day read's 1,000 shapes, counted ones only
    for (const d of counts.filter((x) => x.day > "2026-11-08")) expect(d.complete, d.day).toBe(true);
    const dayReads = reads.filter((q) => q.channel === "C0LEADVOB1" && q.latest !== null);
    expect(dayReads.length).toBeGreaterThan(0);
    for (const q of dayReads) expect(tsToMs(q.latest as string) - tsToMs(q.oldest)).toBeGreaterThanOrEqual(23 * 3_600_000);
    const vob = db.tables.exec_slack_lead_channels.find((l) => l.channel_id === "C0LEADVOB1");
    expect(vob?.final_attempt_at).not.toBeNull();
    // Every day of the window was attempted (the fallback) and yesterday was read in full: final_through moves to yesterday.
    expect(String(vob?.final_through)).toBe("2026-11-09");
  });
  it("capped → final_through stays null when yesterday itself is a lower bound (a flood yesterday)", async () => {
    const flood: LeadPostShape[] = Array.from({ length: 1100 }, (_, k) => ({
      ts: `${Math.floor(localTimeToUtc("2026-11-09", "12:00", TZ).getTime() / 1000) - k}.000100`, reply: false, bot: true, excluded: false, hidden: false, subtypeClass: "bot_message"
    }));
    feeds.set("C0LEADVOB1", flood);
    await run();
    const vob = db.tables.exec_slack_lead_channels.find((l) => l.channel_id === "C0LEADVOB1");
    expect(vob?.final_through ?? null).toBeNull();
    expect(vob?.final_attempt_at).not.toBeNull();
    expect(countsOf("C0LEADVOB1").find((d) => d.day === "2026-11-09")?.complete).toBe(false);
    expect(countsOf("C0LEADVOB1").find((d) => d.day === "2026-11-10")).toMatchObject({ n: 0, complete: true });
    expect(summary()?.needsFinal).toBe(0);   // stamped: retried after 6 hours, never every 30 minutes
  });
  it("a stored complete day is never replaced by a smaller lower bound from a capped read (RPC 3's guard, mirrored by the fake)", async () => {
    // Integrator (contract section 5.17, M53; section 5.3 LC08: stored complete days unchanged, the fake DB's rows compared
    // before and after): the run writes the flooded day as a lower bound of 1,000, and the day's stored complete count
    // (1,050) stays, because a lower bound never replaces a stored number it doesn't reach.
    const flood: LeadPostShape[] = Array.from({ length: 1100 }, (_, k) => ({
      ts: `${Math.floor(localTimeToUtc("2026-11-08", "12:00", TZ).getTime() / 1000) - k}.000100`, reply: false, bot: true, excluded: false, hidden: false, subtypeClass: "bot_message"
    }));
    const vobShapes = (feeds.get("C0LEADVOB1") ?? []).filter((s) => !s.ts.startsWith("x"));
    feeds.set("C0LEADVOB1", [...vobShapes.filter((s) => tsToMs(s.ts) > tsToMs(flood[0].ts)), ...flood, ...vobShapes.filter((s) => tsToMs(s.ts) < tsToMs(flood[flood.length - 1].ts))]
      .sort((a, b) => tsToMs(b.ts) - tsToMs(a.ts)));
    const stored = { principal_id: "ep_1", channel_id: "C0LEADVOB1", local_day: "2026-11-08", tz: TZ, n: 1050, skipped: 0, complete: true,
      counted_at: "2026-11-09T05:00:00.000Z", expires_at: "2027-01-01T00:00:00.000Z" };
    db.tables.exec_slack_lead_counts.push({ ...stored });
    await run();
    const nov08 = db.tables.exec_slack_lead_counts.filter((k) => k.channel_id === "C0LEADVOB1" && String(k.local_day) === "2026-11-08");
    expect(nov08).toHaveLength(1);
    expect(nov08[0]).toMatchObject({ n: 1050, complete: true, counted_at: stored.counted_at });
    // The run did read and write the day (its lower bound was offered and refused), and every later day is its full count.
    const nov08Start = localTimeToUtc("2026-11-08", "00:00", TZ).getTime();
    expect(reads.some((q) => q.channel === "C0LEADVOB1" && q.latest !== null && Math.abs(tsToMs(q.oldest) - nov08Start) < 1)).toBe(true);
    for (const d of countsOf("C0LEADVOB1").filter((x) => x.day > "2026-11-08")) expect(d.complete, d.day).toBe(true);
  });
});

describe("LC09 bad_response: one retry at 25", () => {
  it("a bad_response at 100 → the same page at 25 → counted; twice → last_error_code", async () => {
    let once = true;
    readFail = (q) => (q.channel === "C0LEADVOB2" && q.limit === 100 && once ? ((once = false), new SlackApiError("conversations.history", "bad_response", { errorClass: "retryable" })) : null);
    await run();
    expect(reads.filter((q) => q.channel === "C0LEADVOB2").map((q) => q.limit)).toEqual([100, 25]);
    expect(countsOf("C0LEADVOB2")).toEqual(leadPages.channels.find((c) => c.channelId === "C0LEADVOB2")?.expect.days);
    readFail = (q) => (q.channel === "C0LEADVOB2" ? new SlackApiError("conversations.history", "bad_response", { errorClass: "retryable" }) : null);
    db.tables.exec_slack_lead_channels.forEach((l) => { l.final_through = null; l.final_attempt_at = null; });
    const r = await run();
    expect(db.tables.exec_slack_lead_channels.find((l) => l.channel_id === "C0LEADVOB2")?.last_error_code).toBe("bad_response");
    expect(r.errors).toEqual({ bad_response: 1 });
  });
});

describe("LC10 not_in_channel / channel_not_found", () => {
  it("→ the lead rows dropped and P7a's classify queued 11 minutes out, keyed per hour", async () => {
    readFail = (q) => (q.channel === "C0LEADCAL1" ? new SlackApiError("conversations.history", "not_in_channel", { errorClass: "fatal" }) : null);
    const r = await run();
    expect(db.tables.exec_slack_lead_channels.some((l) => l.channel_id === "C0LEADCAL1")).toBe(false);
    const classify = vi.mocked(enqueueJob).mock.calls.map((c) => c[0]).filter((j) => j.kind === "exec.slack-classify" && (j.payload as Row).channel === "C0LEADCAL1");
    expect(classify).toHaveLength(1);
    expect(classify[0]).toMatchObject({ lane: "bulk", maxAttempts: 3, payload: { installation_id: INST, channel: "C0LEADCAL1" } });
    expect(classify[0].dedupeKey).toMatch(/^slack-classify:ep_1:C0LEADCAL1:l\d{10}$/);
    expect((classify[0].runAfter as Date).getTime() - NOW.getTime()).toBe(11 * 60_000);
    expect(r.errors).toEqual({ not_in_channel: 1 });
    expect(r.channels).toBe(5);
  });
});

describe("LC11 / LC13 rate limits and the page budget", () => {
  it("ratelimited mid-run → partial; the next run starts with the oldest counted_at", async () => {
    readFail = (q) => (q.channel === "C0LEADVOB1" ? new SlackApiError("conversations.history", "ratelimited", { errorClass: "retryable", retryAfterMs: 1000 }) : null);
    const r = await run();
    expect(r.partial).toBe(true);
    expect(summary()?.partial).toBe(true);
    readFail = null;
    reads = [];
    await run();
    const counted = db.tables.exec_slack_lead_channels.filter((l) => l.counted_at !== null && l.counted_at !== undefined);
    expect(counted.length).toBeGreaterThan(0);
    // The never-counted channel (counted_at null) is read first.
    const firstRead = reads[0]?.channel;
    expect(["C0LEADVOB1", ...leadPages.channels.map((c) => c.channelId)]).toContain(firstRead);
  });
  it("≤ 100 history pages per run; the rest carries over and the run is partial", async () => {
    for (const ch of leadPages.channels) {
      feeds.set(ch.channelId, Array.from({ length: 2000 }, (_, k) => ({ ts: `${Math.floor(NOW.getTime() / 1000) - 60 - k * 20}.000100`, reply: false, bot: true,
        excluded: false, hidden: false, subtypeClass: "bot_message" })));
    }
    const r = await run();
    expect(reads.length).toBeLessThanOrEqual(P10_LIMITS.leadPagesPerRun);
    expect(r.pages).toBeLessThanOrEqual(P10_LIMITS.leadPagesPerRun);
    expect(r.partial).toBe(true);
  });
});

describe("LC12 an auth error", () => {
  it("is rethrown after paced recorded it; the summary counts a failing run with its code", async () => {
    readFail = () => new SlackApiError("conversations.history", "token_revoked", { errorClass: "auth" });
    await expect(run()).rejects.toThrow();
    expect(vi.mocked(recordUserTokenError)).toHaveBeenCalledWith(INST, "token_revoked");
    expect(summary()).toMatchObject({ failingRuns: 1, failCode: "token_revoked", partial: true });
  });
});

describe("LC14 C24: a readable row the typed list names", () => {
  it("gets one P7a classify job per hour, 11 minutes out", async () => {
    await run();
    await run();
    const jobs = vi.mocked(enqueueJob).mock.calls.map((c) => c[0]).filter((j) => (j.payload as Row).channel === "C0ACMEOPS");
    expect(jobs.length).toBeGreaterThan(0);
    expect(new Set(jobs.map((j) => j.dedupeKey)).size).toBe(1);
  });
});

describe("LC15 the DD bot's identity unavailable", () => {
  it("→ only USLACKBOT excluded (inside the reader), logged by code", async () => {
    vi.mocked(getDdBotIdentity).mockRejectedValueOnce(new Error("down"));
    await run();
    const exclusions = vi.mocked(readHistoryShapes).mock.calls[0][2];
    expect(exclusions).toEqual({ userIds: [], botIds: [], appIds: [] });
    expect(JSON.stringify(logs)).toMatch(/DD bot identity unavailable/);
    vi.mocked(readHistoryShapes).mockClear();
    await run();
    expect(vi.mocked(readHistoryShapes).mock.calls[0][2]).toEqual({ userIds: ["U0DDBOT"], botIds: ["B0DDBOT"], appIds: ["A0DDAPP"] });
  });
});

describe("LC16 / LC20 three failing runs, the failure code and the not-member positions", () => {
  it("a store error ends the run with failCode store; the third in a row raises one code-only alert", async () => {
    for (let k = 1; k <= 3; k += 1) {
      db.failNext("exec_slack_lead_map_apply", "57014");
      await expect(run()).rejects.toThrow();
      expect(summary()).toMatchObject({ failingRuns: k, failCode: "store" });
    }
    const alerts = vi.mocked(notifyOps).mock.calls.map((c) => c[0]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ key: SLACK_P10_OPS.leadRunFailing.key("ep_1"), title: SLACK_P10_OPS.leadRunFailing.title });
    for (const id of leadPages.markers.map((m) => m.channelId)) expect(String(alerts[0].detail)).not.toContain(id);
    // A good run resets the count.
    await run();
    expect(summary()).toMatchObject({ failingRuns: 0, failCode: null });
    expect(summary()?.notMember.every((n) => /^[A-Za-z0-9_-]{1,64}$/.test(n.taskId) && Number.isInteger(n.i))).toBe(true);
    expect(JSON.stringify(sync.get("slack/lead-run"))).not.toMatch(/zenith-house|acme-recovery|C0LEAD|G0LEAD/);
  });
});

describe("LC18 a flooded Zapier-errors channel (v1.1 correctness-2)", () => {
  it("newer days in full, the flooded day as a lower bound, never a zero for an unread day; not due again for 6 hours", async () => {
    const day = (d: string, n: number, hh = 12) => Array.from({ length: n }, (_, k) => ({
      ts: `${Math.floor(localTimeToUtc(d, `${String(hh).padStart(2, "0")}:00`, TZ).getTime() / 1000) - k}.000100`, reply: false, bot: true, excluded: false,
      hidden: false, subtypeClass: "bot_message" as const }));
    // Yesterday is the flood: 1,100 posts, more than one capped read (10 pages of 100) takes, so it stays a lower bound and
    // final_through stays null; only the 6-hour retry on final_attempt_at keeps the channel off the 8-day pass (M54).
    feeds.set("C0LEADZAP1", [...day("2026-11-10", 20, 9), ...day("2026-11-09", 1100), ...day("2026-11-08", 60), ...day("2026-11-07", 20)]
      .sort((a, b) => tsToMs(b.ts) - tsToMs(a.ts)));
    await run();
    const c = countsOf("C0LEADZAP1");
    expect(c.find((d) => d.day === "2026-11-10")).toMatchObject({ n: 20, complete: true });
    // The flooded day keeps the larger lower bound: the capped 8-day read reached 980 of it, its own day read 1,000.
    expect(c.find((d) => d.day === "2026-11-09")).toMatchObject({ n: 1000, complete: false });
    expect(c.find((d) => d.day === "2026-11-08")).toMatchObject({ n: 60, complete: true });
    expect(c.find((d) => d.day === "2026-11-07")).toMatchObject({ n: 20, complete: true });
    for (const d of c) if (!d.complete) expect(Number(d.n)).toBeGreaterThan(0);
    const row = db.tables.exec_slack_lead_channels.find((l) => l.channel_id === "C0LEADZAP1");
    expect(row?.final_through ?? null).toBeNull();
    expect(row?.final_attempt_at).toBe(NOW.toISOString());
    expect(summary()?.needsFinal).toBe(0);
    const midnight = (d: string) => localTimeToUtc(d, "00:00", TZ).getTime() / 1000;
    const zapOldest = () => reads.filter((q) => q.channel === "C0LEADZAP1").map((q) => Number(q.oldest));
    // 30 minutes later: today only for it (not due again for 6 hours).
    reads.length = 0;
    vi.setSystemTime(new Date(NOW.getTime() + 30 * 60_000));
    await run();
    expect(zapOldest().length).toBeGreaterThan(0);
    for (const o of zapOldest()) expect(o).toBeGreaterThanOrEqual(midnight("2026-11-10"));
    // 7 hours later: the 8-day pass again, from the window's first local midnight.
    reads.length = 0;
    vi.setSystemTime(new Date(NOW.getTime() + 7 * 3_600_000));
    await run();
    expect(Math.min(...zapOldest())).toBeCloseTo(midnight("2026-11-03"), 3);
    vi.setSystemTime(NOW);
  });
  it("two flooded days in a row: each is a lower bound from its own read; a complete row is never a zero for a day no read reached (M52)", async () => {
    // Integrator (contract section 5.17, M52): with one flooded day the per-day fallback re-reads every older day in full, so
    // a capped tally's zeros for the days it never reached would be overwritten unseen; with two flooded days the second is
    // only a lower bound, which never replaces a complete row, so such a zero would be written and stay.
    const day = (d: string, n: number, hh = 12) => Array.from({ length: n }, (_, k) => ({
      ts: `${Math.floor(localTimeToUtc(d, `${String(hh).padStart(2, "0")}:00`, TZ).getTime() / 1000) - k}.000100`, reply: false, bot: true, excluded: false,
      hidden: false, subtypeClass: "bot_message" as const }));
    feeds.set("C0LEADZAP1", [...day("2026-11-10", 20, 9), ...day("2026-11-09", 1100), ...day("2026-11-08", 1100), ...day("2026-11-07", 20)]
      .sort((a, b) => tsToMs(b.ts) - tsToMs(a.ts)));
    await run();
    const c = countsOf("C0LEADZAP1");
    expect(c.find((d) => d.day === "2026-11-10")).toMatchObject({ n: 20, complete: true });
    expect(c.find((d) => d.day === "2026-11-09")).toMatchObject({ n: 1000, complete: false });
    expect(c.find((d) => d.day === "2026-11-08")).toMatchObject({ n: 1000, complete: false });
    expect(c.find((d) => d.day === "2026-11-07")).toMatchObject({ n: 20, complete: true });
    const truth: Record<string, number> = { "2026-11-10": 20, "2026-11-09": 1100, "2026-11-08": 1100, "2026-11-07": 20 };
    for (const d of c) {
      if (d.complete) expect(Number(d.n), d.day).toBe(truth[d.day] ?? 0);
      else expect(Number(d.n), d.day).toBeGreaterThan(0);
    }
    expect(db.tables.exec_slack_lead_channels.find((l) => l.channel_id === "C0LEADZAP1")?.final_through ?? null).toBeNull();
  });
});

describe("LC19 retention_days_slack at its limits (v1.1 correctness-11)", () => {
  for (const days of [1, 3650]) {
    it(`retention ${days}: every map and count write passes the tables' CHECKs (clamped)`, async () => {
      vi.mocked(loadSettings).mockResolvedValue(settings({ retentionDaysSlack: days }));
      const r = await run();
      expect(r).toMatchObject({ counted: 6 });
      const clamp = days < 7 ? 7 : 365;
      for (const l of db.tables.exec_slack_lead_channels) {
        expect(Date.parse(String(l.expires_at)) - Date.parse(String(l.mapped_at))).toBe(clamp * 86_400_000);
      }
      for (const k of db.tables.exec_slack_lead_counts) expect(Date.parse(String(k.expires_at))).toBeGreaterThan(Date.parse(String(k.counted_at)));
    });
  }
});

describe("LP07 / registration", () => {
  it("callModel is never called during a lead run; the handler's registration data", async () => {
    await run();
    expect(vi.mocked(callModel)).not.toHaveBeenCalled();
    expect(slackLeadCountJobHandler).toMatchObject({ kind: "exec.slack-lead-count", lane: "bulk", timeoutMs: 300_000 });
    expect(slackLeadCountScheduledWork).toMatchObject({ kind: "exec.slack-lead-count", lane: "bulk", cadence: { kind: "interval", minutes: 30 }, maxAttempts: 1 });
    expect(slackLeadCountScheduledWork.enabled?.(settings())).toBe(true);
    expect(slackLeadCountScheduledWork.enabled?.(settings({ slackLeadCountsEnabled: false }))).toBe(false);
    expect(slackLeadCountScheduledWork.enabled?.(settings({ slackReadingEnabled: false }))).toBe(false);
  });
});
