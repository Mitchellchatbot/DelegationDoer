import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/slack-reading", () => ({ getSlackReadingState: vi.fn() }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), getSyncState: vi.fn() }));
vi.mock("@/lib/exec/sources/dd", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sources/dd")>()), listFbLeadChannelsV2: vi.fn() }));
vi.mock("@/lib/exec/slack-install", () => ({ getActiveInstallation: vi.fn() }));

import leadPages from "@/lib/exec/__tests__/fixtures/p10/lead-history-pages.json";
import { createFakeLeadDb, type FakeLeadDb } from "@/lib/exec/__tests__/fake-lead-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { P10_PHI_SENTINELS, assertNoLeadText } from "@/lib/exec/__tests__/p10-assert";
import { DEFAULT_SETTINGS } from "@/lib/exec/principal";
import { getActiveInstallation } from "@/lib/exec/slack-install";
import { __resetLeadStoreForTests } from "@/lib/exec/slack-leads-store";
import { briefLeadsFor, briefLeadsVisible, chatClientLeads, chatLeadsPart, leadCountsView, leadSystemRow, leadsState } from "@/lib/exec/slack-leads-view";
import { SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import type { FbLeadListRow, LeadRunSummary } from "@/lib/exec/slack-p10-types";
import { getSlackReadingState } from "@/lib/exec/slack-reading";
import { listFbLeadChannelsV2 } from "@/lib/exec/sources/dd";
import { getSyncState } from "@/lib/exec/sync-state";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P10 §5.5 LV01, LV02/LV12, LV09-LV11 and §5.4 LP05 (contract §3.4.6, §3.6.2, C33, C35, C56, C58; Area B): every surface's
// read of the counts, against the fake lead DB (its summary / coverage functions mirror the SQL). No Slack call anywhere:
// nothing here can reach one (the reading state, the run summary and the stores are the only reads). Invented names only.

const NOW = new Date("2026-11-10T15:00:00.000Z");
const TZ = "America/New_York";
const INST = `esi_${"a".repeat(32)}`;
const P = { id: "ep_1", userId: "u_1", timezone: TZ, briefTimezone: TZ } as unknown as ExecPrincipal;
const S = (over: Partial<ExecSettings> = {}): ExecSettings => ({ principalId: "ep_1", ...DEFAULT_SETTINGS, slackP10SchemaReady: true, slackLeadCountsEnabled: true,
  slackReadingSchemaReady: true, slackReadingEnabled: true, ...over });
const RUN: LeadRunSummary = { at: "2026-11-10T14:30:00.000Z", complete: true, partial: false, needsFinal: 0, channels: 5, counted: 5, pages: 5, listedNotMember: 2,
  classifyEnqueued: 1, errors: { bad_response: 1 }, failingRuns: 0, failCode: null, notMember: [{ taskId: "t_acme_onb", i: 1 }, { taskId: "t_zenith_onb", i: 2 }] };
const FAR = "2027-11-10T00:00:00.000Z";

let db: FakeLeadDb;
let run: LeadRunSummary | null;
type Lead = { id: string; kind: string; link: string; task?: string | null; client?: string | null; label?: string | null; reason?: string };
const LEADS: Lead[] = [
  { id: "C0LEADVOB1", kind: "vob", link: "fb_id", task: "t_zenith_onb", client: "cl_zenith", label: "Zenith House" },
  { id: "C0LEADNON1", kind: "nonvob", link: "fb_name", task: "t_zenith_onb", client: "cl_zenith", label: "Zenith House" },
  { id: "C0LEADCAL1", kind: "calendly", link: "fb_sibling", task: "t_zenith_onb", client: "cl_zenith", label: "Zenith House", reason: "lead_name" },
  { id: "C0LEADZAP1", kind: "zap_errors", link: "fb_sibling", task: "t_zenith_onb", client: "cl_zenith", label: "Zenith House", reason: "lead_name" },
  { id: "C0LEADVOB2", kind: "vob", link: "fb_name", task: "t_acme_onb", client: "cl_acme", label: "Acme Recovery" },
  { id: "G0LEADUNL1", kind: "vob", link: "none", reason: "lead_name" },
  { id: "C0ZENTEAM", kind: "other", link: "fb_id", task: "t_zenith_onb", client: "cl_zenith", label: "Zenith House" }
];
function seed(counts: [string, string, number, boolean?][], opts: { missing?: string[] } = {}) {
  const channels: Row[] = LEADS.map((l) => ({ principal_id: "ep_1", channel_id: l.id, installation_id: INST, conv_type: l.id.startsWith("G") ? "group" : "channel",
    class: "deny", deny_reason: l.reason ?? "fb_list", name: null }));
  const leadRows: Row[] = LEADS.map((l) => ({ principal_id: "ep_1", channel_id: l.id, installation_id: INST, kind: l.kind, link: l.link, task_id: l.task ?? null,
    client_id: l.client ?? null, client_label: l.label ?? null, counted_at: "2026-11-10T14:30:00.000Z", final_through: "2026-11-09", final_attempt_at: null,
    counted_from: "2026-11-03", last_error_code: null, mapped_at: NOW.toISOString(), expires_at: FAR, created_at: NOW.toISOString(), updated_at: NOW.toISOString() }));
  const countRows: Row[] = counts.map(([id, day, n, complete]) => ({ principal_id: "ep_1", channel_id: id, local_day: day, tz: TZ, n, skipped: id === "C0LEADVOB1" && day === "2026-11-10" ? 1 : 0,
    complete: complete !== false, counted_at: "2026-11-10T14:30:00.000Z", expires_at: FAR }));
  db = createFakeLeadDb({ now: () => new Date(), missing: opts.missing,
    tables: { exec_slack_channels: channels, exec_slack_lead_channels: leadRows, exec_slack_lead_counts: countRows, exec_slack_installations: [{ id: INST, principal_id: "ep_1" }] } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
}
const WEEK: [string, string, number, boolean?][] = [
  ["C0LEADVOB1", "2026-11-10", 2], ["C0LEADVOB1", "2026-11-09", 3], ["C0LEADVOB1", "2026-11-05", 1],
  ["C0LEADNON1", "2026-11-10", 1], ["C0LEADNON1", "2026-11-09", 2],
  ["C0LEADCAL1", "2026-11-10", 1], ["C0LEADCAL1", "2026-11-09", 2],
  ["C0LEADZAP1", "2026-11-10", 0], ["C0LEADZAP1", "2026-11-09", 1],
  ["C0LEADVOB2", "2026-11-10", 1], ["C0LEADVOB2", "2026-11-09", 1],
  ["G0LEADUNL1", "2026-11-10", 0], ["G0LEADUNL1", "2026-11-09", 2]
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  __resetLeadStoreForTests();
  seed(WEEK);
  run = RUN;
  vi.mocked(getSlackReadingState).mockResolvedValue({ state: "on", discoveredAt: "x", lastSweepAt: null, lastEventAt: null });
  vi.mocked(getSyncState).mockImplementation(async (_p, source, key, parse) => {
    if (source !== "slack" || key !== "lead-run" || run === null) return null;
    const v = parse(JSON.parse(JSON.stringify(run)));
    return v === null ? null : { value: v, rev: 1 };
  });
  vi.mocked(listFbLeadChannelsV2).mockResolvedValue(leadPages.fbList as FbLeadListRow[]);
  vi.mocked(getActiveInstallation).mockResolvedValue({ id: INST, teamId: "T0ZENITH" } as never);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("LV01 leadsState", () => {
  it("not_installed, off, reading_off, first_run, no_channels, ok, unavailable", async () => {
    expect(await leadsState(P, S({ slackP10SchemaReady: false }))).toBe("not_installed");
    expect(await leadsState(P, S({ slackLeadCountsEnabled: false }))).toBe("off");
    for (const state of ["paused", "discovering", "error", "revoked", "not_installed"] as const) {
      vi.mocked(getSlackReadingState).mockResolvedValueOnce({ state, discoveredAt: null, lastSweepAt: null, lastEventAt: null });
      expect(await leadsState(P, S()), state).toBe("reading_off");
    }
    expect(await leadsState(P, S())).toBe("ok");
    run = null;
    expect(await leadsState(P, S())).toBe("first_run");
    run = RUN;
    seed([]);
    db.tables.exec_slack_lead_channels.length = 0;
    expect(await leadsState(P, S())).toBe("no_channels");
    __resetLeadStoreForTests();
    seed(WEEK, { missing: ["exec_slack_lead_channels"] });
    expect(await leadsState(P, S())).toBe("not_installed");
    __resetLeadStoreForTests();
    seed(WEEK);
    vi.mocked(getSlackReadingState).mockRejectedValueOnce(new Error("down"));
    expect(await leadsState(P, S())).toBe("unavailable");
  });
  it("P10 fixer ui-5: a failed first run → unavailable (the brief says so, visible); a partial first run → first_run; no_channels only after a complete one", async () => {
    const sig = { signal: new AbortController().signal };
    seed([]);
    db.tables.exec_slack_lead_channels.length = 0;
    // A store error before anything was mapped: the summary says failing.
    run = { ...RUN, complete: false, partial: true, channels: 0, counted: 0, pages: 0, failingRuns: 1, failCode: "store", listedNotMember: 0, notMember: [] };
    expect(await leadsState(P, S())).toBe("unavailable");
    expect(await briefLeadsVisible(P, S())).toBe(true);
    expect(await briefLeadsFor(P, S(), NOW, sig)).toEqual({ v: 1, unavailable: true, localDate: "2026-11-09" });
    expect((await leadCountsView(P, S(), NOW, sig)).state).toBe("unavailable");
    // A ratelimited membership listing: nothing mapped, nothing proven.
    run = { ...RUN, complete: false, partial: true, channels: 0, counted: 0, pages: 0, failingRuns: 0, failCode: null, listedNotMember: 0, notMember: [] };
    expect(await leadsState(P, S())).toBe("first_run");
    expect(await briefLeadsFor(P, S(), NOW, sig)).toMatchObject({ firstRun: true });
    run = { ...RUN, channels: 0, counted: 0 };
    expect(await leadsState(P, S())).toBe("no_channels");
    expect(await briefLeadsFor(P, S(), NOW, sig)).toBeNull();
  });
  it("briefLeadsVisible: ok, first_run and unavailable show; off / not_installed / reading_off / no_channels hide", async () => {
    expect(await briefLeadsVisible(P, S())).toBe(true);
    run = null;
    expect(await briefLeadsVisible(P, S())).toBe(true);
    vi.mocked(getSlackReadingState).mockRejectedValueOnce(new Error("down"));
    expect(await briefLeadsVisible(P, S())).toBe(true);
    expect(await briefLeadsVisible(P, S({ slackLeadCountsEnabled: false }))).toBe(false);
    vi.mocked(getSlackReadingState).mockResolvedValueOnce({ state: "paused", discoveredAt: null, lastSweepAt: null, lastEventAt: null });
    expect(await briefLeadsVisible(P, S())).toBe(false);
  });
});

describe("LV02 / LV12 briefLeadsFor", () => {
  it("yesterday in the lead zone: linked clients, totals, the unlinked count, notCounted from the channel states", async () => {
    const b = await briefLeadsFor(P, S(), NOW, { signal: new AbortController().signal });
    expect(b).toMatchObject({ v: 1, localDate: "2026-11-09", asOf: RUN.at, unlinked: 2, more: 0, notCounted: 0, failing: false, dated: false, firstRun: false });
    if (!b || "unavailable" in b) throw new Error("no block");
    expect(b.rows.map((r) => [r.label, r.vob, r.nonvob, r.calendly, r.zapErrors])).toEqual([["Zenith House", 3, 2, 2, 1], ["Acme Recovery", 1, 0, 0, 0]]);
    expect(b.totals).toEqual({ vob: 4, nonvob: 2, calendly: 2, zapErrors: 1 });
    assertNoLeadText(b);
  });
  it("hidden (null) while off, not installed, reading off or with no channels; first_run; failing; unavailable on a read failure", async () => {
    const sig = { signal: new AbortController().signal };
    expect(await briefLeadsFor(P, S({ slackLeadCountsEnabled: false }), NOW, sig)).toBeNull();
    vi.mocked(getSlackReadingState).mockResolvedValueOnce({ state: "paused", discoveredAt: null, lastSweepAt: null, lastEventAt: null });
    expect(await briefLeadsFor(P, S(), NOW, sig)).toBeNull();
    run = { ...RUN, failingRuns: 2, failCode: "store" };
    expect(await briefLeadsFor(P, S(), NOW, sig)).toMatchObject({ failing: true });
    run = null;
    expect(await briefLeadsFor(P, S(), NOW, sig)).toMatchObject({ firstRun: true });
    run = RUN;
    db.failNext("exec_slack_lead_summary", "57014");
    expect(await briefLeadsFor(P, S(), NOW, sig)).toEqual({ v: 1, unavailable: true, localDate: "2026-11-09" });
  });
  it("P10 fixer correctness-2: the 07:00 brief after a failed 01:00 final pass: yesterday's pre-midnight snapshot is not the day", async () => {
    // Every row for the 9th is complete (the 22:00 run read the day so far), but C0LEADVOB2's final pass failed: final_through the 8th.
    (db.tables.exec_slack_lead_channels.find((r) => r.channel_id === "C0LEADVOB2") as Record<string, unknown>).final_through = "2026-11-08";
    const b = await briefLeadsFor(P, S(), NOW, { signal: new AbortController().signal });
    expect(b).toMatchObject({ notCounted: 1 });
    // The unlinked channel counts too.
    (db.tables.exec_slack_lead_channels.find((r) => r.channel_id === "G0LEADUNL1") as Record<string, unknown>).final_through = null;
    expect(await briefLeadsFor(P, S(), NOW, { signal: new AbortController().signal })).toMatchObject({ notCounted: 2 });
  });
  it("a channel without a complete row for the day is notCounted; dated when the brief zone's yesterday differs", async () => {
    seed(WEEK.filter(([id, day]) => !(id === "C0LEADCAL1" && day === "2026-11-09")).map(([id, d, n]) => [id, d, n, !(id === "C0LEADNON1" && d === "2026-11-09")] as [string, string, number, boolean]));
    const b = await briefLeadsFor(P, S(), NOW, { signal: new AbortController().signal });
    expect(b).toMatchObject({ notCounted: 2, incomplete: true });
    const other = { ...P, briefTimezone: "Pacific/Kiritimati" } as ExecPrincipal;
    expect(await briefLeadsFor(other, S(), NOW, { signal: new AbortController().signal })).toMatchObject({ localDate: "2026-11-09", dated: true });
  });
});

describe("LV09 the Slack tab's view", () => {
  it("today / yesterday / 7 days, the All clients row, Zapier by day, coverage, the fix lists from the stored ids and the typed list", async () => {
    const v = await leadCountsView(P, S(), NOW, { signal: new AbortController().signal });
    expect(v.state).toBe("ok");
    expect(v.totals).toEqual({ today: { vob: 3, nonvob: 1, calendly: 1 }, yesterday: { vob: 4, nonvob: 2, calendly: 2 }, last7: { vob: 8, nonvob: 3, calendly: 3 },
      kinds: ["vob", "nonvob", "calendly", "zap_errors"] });
    expect(v.clients.map((c) => c.label)).toEqual(["Zenith House", "Acme Recovery"]);
    expect(v.clients[0]).toMatchObject({ zapToday: 0, zapYesterday: 1, kinds: ["vob", "nonvob", "calendly", "zap_errors"], incomplete: false });
    expect(v.unlinked).toEqual({ today: { vob: 0, nonvob: 0, calendly: 0 }, yesterday: { vob: 2, nonvob: 0, calendly: 0 }, last7: { vob: 2, nonvob: 0, calendly: 0 } });
    expect(v.coverage).toMatchObject({ channels: 7, linked: 5, unlinked: 1, ambiguous: 0, otherKind: 1, listedNotMember: 2, skippedToday: 1, lastRunAt: RUN.at });
    expect(v.fix).toEqual({
      unlinked: [{ href: "https://slack.com/app_redirect?channel=G0LEADUNL1&team=T0ZENITH", kind: "vob" }], ambiguous: [],
      notMember: [{ client: "Acme Recovery", names: ["#acme-recovery-calendly"] }, { client: "Zenith House", names: ["#zenith-house-fb-leads"] }], more: 0
    });
  });
  it("first_run with no run summary; no_channels keeps the not-member lines; a typed-list or team failure → counts only; off → its state", async () => {
    const sig = { signal: new AbortController().signal };
    run = null;
    expect(await leadCountsView(P, S(), NOW, sig)).toMatchObject({ state: "first_run", clients: [], fix: null });
    run = RUN;
    seed([]);
    db.tables.exec_slack_lead_channels.length = 0;
    const none = await leadCountsView(P, S(), NOW, sig);
    expect(none.state).toBe("no_channels");
    expect(none.fix?.notMember).toHaveLength(2);
    seed(WEEK);
    vi.mocked(listFbLeadChannelsV2).mockRejectedValueOnce(new Error("down"));
    vi.mocked(getActiveInstallation).mockRejectedValueOnce(new Error("down"));
    const bare = await leadCountsView(P, S(), NOW, sig);
    expect(bare.state).toBe("ok");
    expect(bare.fix).toEqual({ unlinked: [], ambiguous: [], notMember: [], more: 0 });
    expect(bare.clients).toHaveLength(2);
    expect((await leadCountsView(P, S({ slackLeadCountsEnabled: false }), NOW, sig)).state).toBe("off");
    db.failNext("exec_slack_lead_summary", "57014");
    expect((await leadCountsView(P, S(), NOW, sig)).state).toBe("unavailable");
  });
});

describe("LV10 chat parts (v1.1 product-18): whole local days in his zone, in a DST week", () => {
  const DST_NOW = new Date("2026-11-02T15:00:00.000Z");   // Monday; the clocks went back on Sunday Nov 1
  const DST: [string, string, number][] = [["C0LEADVOB1", "2026-11-02", 2], ["C0LEADVOB1", "2026-11-01", 5], ["C0LEADVOB1", "2026-10-30", 1],
    ["C0LEADVOB1", "2026-10-26", 9], ["C0LEADVOB2", "2026-11-01", 1], ["G0LEADUNL1", "2026-11-02", 4]];
  beforeEach(() => {
    vi.setSystemTime(DST_NOW);
    seed(DST);
    // The last run that morning (9:30 AM in New York, the clocks back since Sunday).
    run = { ...RUN, at: "2026-11-02T14:30:00.000Z" };
    for (const r of db.tables.exec_slack_lead_channels) Object.assign(r, { counted_at: "2026-11-02T14:30:00.000Z", final_through: "2026-11-01" });
  });
  const sig = () => ({ signal: new AbortController().signal });
  it("today, yesterday, last_24h (two dated parts, never one sum), last_7_days; every result carries basis and note", async () => {
    const today = await chatLeadsPart(P, S(), { since: "today" }, DST_NOW, sig());
    if (today.state !== "ok") throw new Error(today.state);
    expect(today.parts.map((p) => [p.part, p.from, p.to])).toEqual([["today_so_far", "2026-11-02", "2026-11-02"]]);
    expect(today.parts[0].totals).toMatchObject({ vob: 2 });
    expect(today.parts[0].unlinked).toMatchObject({ vob: 4 });
    expect(today.basis).toBe("Whole local days in America/New_York; today so far as of 9:30 AM.");
    expect(today.note).toBe(SLACK_P10_COPY.leads.chatNote);
    const y = await chatLeadsPart(P, S(), { since: "yesterday" }, DST_NOW, sig());
    if (y.state !== "ok") throw new Error(y.state);
    expect(y.parts.map((p) => [p.part, p.from])).toEqual([["yesterday", "2026-11-01"]]);
    expect(y.parts[0].totals).toMatchObject({ vob: 6 });
    const d = await chatLeadsPart(P, S(), { since: "last_24h" }, DST_NOW, sig());
    if (d.state !== "ok") throw new Error(d.state);
    expect(d.parts.map((p) => [p.part, p.from, p.to, p.totals.vob])).toEqual([["yesterday", "2026-11-01", "2026-11-01", 6], ["today_so_far", "2026-11-02", "2026-11-02", 2]]);
    const w = await chatLeadsPart(P, S(), { since: "last_7_days" }, DST_NOW, sig());
    if (w.state !== "ok") throw new Error(w.state);
    expect(w.parts.map((p) => [p.part, p.from, p.to])).toEqual([["last_7_days", "2026-10-27", "2026-11-02"]]);
    expect(w.parts[0].totals).toMatchObject({ vob: 9, kinds: ["vob"] });
    expect(w.parts[0].clients.map((c) => [c.client, c.vob])).toEqual([["Zenith House", 8], ["Acme Recovery", 1]]);
  });
  it("one client: by id, else (no DD client) by exact label; unlinked left out", async () => {
    const one = await chatLeadsPart(P, S(), { since: "last_7_days", clientId: "cl_acme", clientName: "Acme Recovery" }, DST_NOW, sig());
    if (one.state !== "ok") throw new Error(one.state);
    expect(one.parts[0].clients.map((c) => c.client)).toEqual(["Acme Recovery"]);
    expect(one.parts[0].unlinked).toBeNull();
    const byName = await chatLeadsPart(P, S(), { since: "last_7_days", clientId: null, clientName: "Zenith House" }, DST_NOW, sig());
    if (byName.state !== "ok") throw new Error(byName.state);
    expect(byName.parts[0].clients).toEqual([]);   // Zenith House has a DD client id: a label match alone never stands in for it
  });
  it("P10 fixer correctness-3: a missing day is never a zero: today before the day's first run, yesterday before its final pass; the basis dates an older run", async () => {
    expect(await chatLeadsPart(P, S(), { since: "last_24h" }, DST_NOW, sig())).toMatchObject({ state: "ok",
      parts: [{ part: "yesterday", incomplete: false }, { part: "today_so_far", incomplete: false }] });
    // 00:30 on Monday: last night's 10 PM run counted Sunday so far; Monday isn't counted at all yet.
    const early = new Date("2026-11-02T05:30:00.000Z");
    vi.setSystemTime(early);
    run = { ...RUN, at: "2026-11-02T03:00:00.000Z" };
    for (const r of db.tables.exec_slack_lead_channels) Object.assign(r, { counted_at: "2026-11-02T03:00:00.000Z", final_through: "2026-10-31" });
    const d = await chatLeadsPart(P, S(), { since: "last_24h" }, early, sig());
    if (d.state !== "ok") throw new Error(d.state);
    expect(d.parts.map((p) => [p.part, p.incomplete])).toEqual([["yesterday", true], ["today_so_far", true]]);
    expect(d.basis).toBe("Whole local days in America/New_York; today so far as of Nov 1, 10:00 PM.");
    const c = await chatClientLeads(P, S(), { clientId: "cl_zenith", clientName: "Zenith House" }, early, sig());
    expect(c).toMatchObject({ state: "ok", incomplete: true });
    // Another client's channels don't make this one incomplete.
    for (const r of db.tables.exec_slack_lead_channels) if (r.client_id === "cl_acme") Object.assign(r, { counted_at: "2026-11-02T05:00:00.000Z", final_through: "2026-11-01" });
    expect(await chatClientLeads(P, S(), { clientId: "cl_acme", clientName: "Acme Recovery" }, early, sig())).toMatchObject({ state: "ok", incomplete: false });
  });
  it("CT10's halves: off and reading_off answer their state; a failing read answers unavailable", async () => {
    expect(await chatLeadsPart(P, S({ slackLeadCountsEnabled: false }), { since: "today" }, DST_NOW, sig())).toEqual({ state: "off" });
    vi.mocked(getSlackReadingState).mockResolvedValueOnce({ state: "paused", discoveredAt: null, lastSweepAt: null, lastEventAt: null });
    expect(await chatLeadsPart(P, S(), { since: "today" }, DST_NOW, sig())).toEqual({ state: "reading_off" });
    db.failNext("exec_slack_lead_summary", "57014");
    expect(await chatLeadsPart(P, S(), { since: "today" }, DST_NOW, sig())).toEqual({ state: "unavailable" });
  });
});

describe("chatClientLeads (§3.6.2, AM-P10-33)", () => {
  it("that client's today so far, yesterday and 7 days, its kinds only", async () => {
    const r = await chatClientLeads(P, S(), { clientId: "cl_zenith", clientName: "Zenith House" }, NOW, { signal: new AbortController().signal });
    expect(r).toMatchObject({ state: "ok", kinds: ["vob", "nonvob", "calendly", "zap_errors"], today_so_far: { vob: 2, nonvob: 1, calendly: 1, zap_errors: 0 },
      yesterday: { vob: 3, nonvob: 2, calendly: 2, zap_errors: 1 }, last_7_days: { vob: 6, nonvob: 3, calendly: 3, zap_errors: 1 }, incomplete: false, as_of: RUN.at });
    const acme = await chatClientLeads(P, S(), { clientId: "cl_acme", clientName: "Acme Recovery" }, NOW, { signal: new AbortController().signal });
    expect(acme).toMatchObject({ state: "ok", kinds: ["vob"] });
    expect(await chatClientLeads(P, S({ slackLeadCountsEnabled: false }), { clientId: "cl_acme", clientName: null }, NOW, { signal: new AbortController().signal }))
      .toEqual({ state: "off" });
  });
});

describe("LV11 the System row", () => {
  it("from the run summary and the coverage only; failingRuns and failCode for the failure form", async () => {
    expect(await leadSystemRow(P)).toEqual({ lastRunAt: RUN.at, channels: 7, unlinked: 1, listedNotMember: 2, lastError: "bad_response", failingRuns: 0, failCode: null });
    run = { ...RUN, failingRuns: 3, failCode: "store" };
    expect(await leadSystemRow(P)).toMatchObject({ failingRuns: 3, failCode: "store", lastError: "store" });
    run = null;
    expect(await leadSystemRow(P)).toMatchObject({ lastRunAt: null, channels: 7 });
    __resetLeadStoreForTests();
    seed(WEEK, { missing: ["exec_slack_lead_channels"] });
    expect(await leadSystemRow(P)).toBeNull();
  });
});

describe("LP05 the chat parts carry integers and DD labels only", () => {
  it("no sentinel, no channel name, no channel id", async () => {
    const a = await chatLeadsPart(P, S(), { since: "last_7_days" }, NOW, { signal: new AbortController().signal });
    const b = await chatClientLeads(P, S(), { clientId: "cl_zenith", clientName: "Zenith House" }, NOW, { signal: new AbortController().signal });
    const out = JSON.stringify([a, b]);
    for (const s of P10_PHI_SENTINELS) expect(out.toLowerCase()).not.toContain(s.toLowerCase());
    for (const l of LEADS) expect(out).not.toContain(l.id);
    expect(out).not.toMatch(/zenith-house-|acme-recovery-/);
  });
});
