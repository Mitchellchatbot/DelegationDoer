import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { createFakeLeadDb, type FakeLeadDb, type FakeLeadDbSeed } from "@/lib/exec/__tests__/fake-lead-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { P10_PHI_SENTINELS, assertNoLeadText } from "@/lib/exec/__tests__/p10-assert";
import * as store from "@/lib/exec/slack-leads-store";
import type { LeadMapRow } from "@/lib/exec/slack-p10-types";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P10 lead-count store (contract §3.4.4, B-P10-1; Area A) against the standalone fake (§5.14), whose function bodies mirror
// 20261112100000_exec_slack_leads_replies.sql §2.1.3 / §2.1.7. The same cases run on PGlite and real Postgres in the SQL suite
// (SQ05-SQ11): the "twin" tests here keep the fake equal to the SQL. Invented names only (zenith-house-*, Acme Recovery).

const NOW = new Date("2026-11-10T15:00:00.000Z");
const TODAY = "2026-11-10";
const P = { id: "ep_1", timezone: "America/New_York" } as unknown as ExecPrincipal;
const P2 = { id: "ep_2" } as unknown as ExecPrincipal;
const INST = `esi_${"a".repeat(32)}`;
const INST_OLD = `esi_${"b".repeat(32)}`;
const day = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

const marker = (id: string, reason = "fb_list", over: Row = {}): Row => ({
  principal_id: "ep_1", channel_id: id, installation_id: INST, conv_type: id.startsWith("G") ? "group" : "channel", class: "deny", deny_reason: reason,
  name: null, ...over
});
const standard = (id: string, name: string | null, over: Row = {}): Row => ({
  principal_id: "ep_1", channel_id: id, installation_id: INST, conv_type: "channel", class: "standard", deny_reason: null, name, ...over
});
const leadRow = (id: string, over: Row = {}): Row => ({
  principal_id: "ep_1", channel_id: id, installation_id: INST, kind: "vob", link: "none", mapped_at: NOW.toISOString(), expires_at: inDays(90), ...over
});
const mapRow = (channelId: string, over: Partial<LeadMapRow> = {}): LeadMapRow => ({
  channelId, kind: "vob", link: "none", taskId: null, clientId: null, clientLabel: null, ...over
});
const linked = (channelId: string, kind: LeadMapRow["kind"], link: LeadMapRow["link"], taskId: string, clientId: string | null, clientLabel: string): LeadMapRow =>
  ({ channelId, kind, link, taskId, clientId, clientLabel });
const dayCount = (d: string, n: number, complete = true, skipped = 0) => ({ day: d, n, skipped, complete, expiresAt: inDays(60) });

let db: FakeLeadDb;
function use(seed: FakeLeadDbSeed = {}): FakeLeadDb {
  db = createFakeLeadDb({ now: () => new Date(), ...seed });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  store.__resetLeadStoreForTests();
  use();
});

describe("leadSchemaReady", () => {
  it("true with the table; false while it is missing (cached 10 s), any other error throws a code-only error", async () => {
    expect(await store.leadSchemaReady()).toBe(true);
    store.__resetLeadStoreForTests();
    use({ missing: ["exec_slack_lead_channels"] });
    expect(await store.leadSchemaReady()).toBe(false);
    db.missing.clear();
    expect(await store.leadSchemaReady()).toBe(false);
    vi.setSystemTime(new Date(NOW.getTime() + 11_000));
    expect(await store.leadSchemaReady()).toBe(true);
    store.__resetLeadStoreForTests();
    db.failNext("exec_slack_lead_channels", "57014");
    await expect(store.leadSchemaReady()).rejects.toThrow(/^exec slack leads store: leadSchemaReady failed \(57014\)$/);
  });
});

describe("the map: listLeadMarkers and applyLeadMap (twins of SQ05)", () => {
  beforeEach(() => {
    use({ tables: {
      exec_slack_channels: [marker("C0LV1"), marker("C0LN1", "lead_name"), marker("G0LP1"), standard("C0STD", "zenith-house-team"),
        marker("C0BOTIM", "bot_im"), marker("C0OTH", "fb_list", { installation_id: INST_OLD })]
    } });
  });

  it("listLeadMarkers: this installation's lead markers and the readable rows the list names (by id or slug); malformed list entries never reach SQL", async () => {
    const m = await store.listLeadMarkers(P, INST, ["C0STD", "not an id"], ["zenith-house-ops", "#Bad Slug"]);
    expect(m.map((r) => [r.channelId, r.class, r.denyReason, r.listed])).toEqual([
      ["C0LN1", "deny", "lead_name", false], ["C0LV1", "deny", "fb_list", false], ["C0STD", "standard", null, true], ["G0LP1", "deny", "fb_list", false]
    ]);
    expect(db.calls.at(-1)?.payload).toEqual({ p_principal: "ep_1", p_installation: INST, p_listed_ids: ["C0STD"], p_listed_slugs: ["zenith-house-ops"] });
    expect((await store.listLeadMarkers(P, INST, [], ["zenith-house-team"])).filter((r) => r.class !== "deny").map((r) => r.channelId)).toEqual(["C0STD"]);
    expect((await store.listLeadMarkers(P, INST_OLD, [], [])).map((r) => r.channelId)).toEqual(["C0OTH"]);
    db.missing.add("exec_slack_lead_markers");
    expect(await store.listLeadMarkers(P, INST, [], [])).toEqual([]);
  });

  it("applyLeadMap: one call, every row with the identical key set; refuses a non-deny, another reason or another installation", async () => {
    const r = await store.applyLeadMap(P, INST, [
      linked("C0LV1", "vob", "fb_id", "t_zen", "cl_zen", "Zenith House"), mapRow("C0LN1", { kind: "nonvob" }), mapRow("G0LP1", { kind: "calendly", link: "ambiguous" }),
      mapRow("C0STD"), mapRow("C0BOTIM"), mapRow("C0OTH"), mapRow("C0NONE")
    ], false, NOW, new Date(inDays(90)));
    expect(r).toEqual({ upserted: 3, refused: 4, deleted: 0 });
    const call = db.calls.filter((c) => c.target === "exec_slack_lead_map_apply").at(-1);
    const rows = (call?.payload as { p_rows: Row[] }).p_rows;
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(Object.keys(row)).toEqual(["channel_id", "kind", "link", "task_id", "client_id", "client_label"]);
    expect(db.tables.exec_slack_lead_channels.map((l) => l.channel_id).sort()).toEqual(["C0LN1", "C0LV1", "G0LP1"]);
    expect(db.tables.exec_slack_lead_channels.find((l) => l.channel_id === "C0LV1")).toMatchObject({ kind: "vob", link: "fb_id", task_id: "t_zen",
      client_id: "cl_zen", client_label: "Zenith House", installation_id: INST, counted_at: null });
  });

  it("applyLeadMap: incomplete deletes nothing unlisted; complete deletes the unlisted rows; a parent no longer a lead marker goes on any call", async () => {
    await store.applyLeadMap(P, INST, [linked("C0LV1", "vob", "fb_id", "t_zen", "cl_zen", "Zenith House"), mapRow("C0LN1"), mapRow("G0LP1")], false, NOW,
      new Date(inDays(90)));
    expect(await store.applyLeadMap(P, INST, [mapRow("C0LV1")], false, NOW, new Date(inDays(90)))).toEqual({ upserted: 1, refused: 0, deleted: 0 });
    expect(db.tables.exec_slack_lead_channels).toHaveLength(3);
    expect(await store.applyLeadMap(P, INST, [mapRow("C0LV1"), mapRow("C0LN1")], true, NOW, new Date(inDays(90)))).toEqual({ upserted: 2, refused: 0, deleted: 1 });
    const ln1 = db.tables.exec_slack_channels.find((c) => c.channel_id === "C0LN1") as Row;
    Object.assign(ln1, { class: "standard", deny_reason: null, name: "zenith-house-ops" });
    expect(await store.applyLeadMap(P, INST, [], false, NOW, new Date(inDays(90)))).toEqual({ upserted: 0, refused: 0, deleted: 1 });
    expect(db.tables.exec_slack_lead_channels.map((l) => l.channel_id)).toEqual(["C0LV1"]);
  });

  it("applyLeadMap: above 500 rows the first 500 go with complete = false (nothing deleted that run) and lead_map_too_large is logged by principal id only", async () => {
    await store.applyLeadMap(P, INST, [mapRow("C0LV1"), mapRow("C0LN1")], false, NOW, new Date(inDays(90)));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const many = Array.from({ length: 501 }, (_, i) => mapRow(`C0X${String(i).padStart(4, "0")}`));
    const r = await store.applyLeadMap(P, INST, many, true, NOW, new Date(inDays(90)));
    expect(r).toEqual({ upserted: 0, refused: 500, deleted: 0 });
    const call = db.calls.filter((c) => c.target === "exec_slack_lead_map_apply").at(-1)?.payload as { p_rows: Row[]; p_complete: boolean };
    expect([call.p_rows.length, call.p_complete]).toEqual([500, false]);
    expect(warn.mock.calls).toEqual([["[exec-slack-leads] lead_map_too_large principal=ep_1"]]);
    expect(db.tables.exec_slack_lead_channels).toHaveLength(2);
  });

  it("applyLeadMap: bad rows are TypeErrors naming the field (never its value); a missing function throws not_installed; a duplicate id keeps its first row", async () => {
    const bad: [LeadMapRow, RegExp][] = [
      [mapRow("bad-id"), /a lead channel id/], [mapRow("C0LV1", { kind: "leads" as never }), /kind/], [mapRow("C0LV1", { link: "guess" as never }), /link/],
      [mapRow("C0LV1", { link: "fb_id" }), /linked row/], [mapRow("C0LV1", { clientId: "cl_zen" }), /linked row|clientId/],
      [mapRow("C0LV1", { taskId: "t".repeat(65), link: "fb_name", clientLabel: "Zenith House" }), /taskId/]
    ];
    for (const [row, re] of bad) {
      const err = await store.applyLeadMap(P, INST, [row], false, NOW, new Date(inDays(90))).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TypeError);
      expect(String((err as Error).message)).toMatch(re);
      expect(String((err as Error).message)).not.toContain("Zenith House");
    }
    await expect(store.applyLeadMap(P, INST, [], false, NOW, NOW)).rejects.toThrow(TypeError);
    await expect(store.applyLeadMap(P, INST, [], false, NOW, new Date(inDays(402)))).rejects.toThrow(/401 days/);
    await store.applyLeadMap(P, INST, [mapRow("C0LV1", { kind: "vob" }), mapRow("C0LV1", { kind: "other" })], false, NOW, new Date(inDays(90)));
    expect(db.tables.exec_slack_lead_channels.find((l) => l.channel_id === "C0LV1")?.kind).toBe("vob");
    // A label longer than 120 characters is clipped (the table's CHECK).
    await store.applyLeadMap(P, INST, [linked("C0LN1", "nonvob", "fb_name", "t_zen", null, "Z".repeat(130))], false, NOW, new Date(inDays(90)));
    expect(String(db.tables.exec_slack_lead_channels.find((l) => l.channel_id === "C0LN1")?.client_label).length).toBe(120);
    db.missing.add("exec_slack_lead_map_apply");
    await expect(store.applyLeadMap(P, INST, [], false, NOW, new Date(inDays(90)))).rejects.toThrow(/not_installed failed \(PGRST202\)/);
  });

  it("the fake's own refusals match the SQL: bad rows and arguments raise P0001; the CHECKs refuse a linked row without a task (23514)", async () => {
    const args = (rows: unknown[], complete = false, mapped = NOW.toISOString(), expires = inDays(90)) =>
      ({ p_principal: "ep_1", p_installation: INST, p_rows: rows, p_complete: complete, p_mapped_at: mapped, p_expires_at: expires });
    const r1 = await db.rpc("exec_slack_lead_map_apply", args([{ channel_id: "C0LV1", kind: "leads", link: "none" }]));
    expect(r1.error?.code).toBe("P0001");
    expect((await db.rpc("exec_slack_lead_map_apply", args([], false, NOW.toISOString(), NOW.toISOString()))).error?.code).toBe("P0001");
    const r2 = await db.rpc("exec_slack_lead_map_apply", args([{ channel_id: "C0LV1", kind: "vob", link: "fb_id" }]));
    expect(r2.error).toMatchObject({ code: "23514", message: expect.stringContaining("exec_slack_lead_channels_link_pair_check") });
    expect(db.tables.exec_slack_lead_channels).toEqual([]);
  });
});

describe("counts: putLeadCounts, noteLeadChannelError, dropLeadChannel (twins of SQ06)", () => {
  beforeEach(async () => {
    use({ tables: { exec_slack_channels: [marker("C0LV1"), marker("C0LN1", "lead_name"), standard("C0STD", "zenith-house-team")] } });
    await store.applyLeadMap(P, INST, [mapRow("C0LV1")], false, NOW, new Date(inDays(90)));
  });
  const put = (channel: string, days: ReturnType<typeof dayCount>[], over: { finalThrough?: string | null; finalAttempt?: boolean; today?: string; countedAt?: Date } = {}) =>
    store.putLeadCounts(P, channel, { tz: "America/New_York", today: over.today ?? TODAY, days, countedAt: over.countedAt ?? NOW,
      finalThrough: over.finalThrough ?? null, finalAttempt: over.finalAttempt ?? false });
  const stored = () => db.tables.exec_slack_lead_counts.find((k) => k.channel_id === "C0LV1" && k.local_day === TODAY);

  it("refused for a non-marker, no_row for a marker without a lead row; written otherwise; the payload holds days with the identical key set", async () => {
    expect(await put("C0STD", [dayCount(TODAY, 1)])).toBe("refused");
    expect(await put("C0LN1", [dayCount(TODAY, 1)])).toBe("no_row");
    expect(await put("C0LV1", [dayCount(TODAY, 1), dayCount(day(-1), 0)])).toBe("written");
    const payload = db.calls.filter((c) => c.target === "exec_slack_lead_counts_put").at(-1)?.payload as { p_days: Row[] };
    for (const d of payload.p_days) expect(Object.keys(d)).toEqual(["d", "n", "skipped", "complete", "expires_at"]);
    expect(db.tables.exec_slack_lead_counts.map((k) => [k.local_day, k.n])).toEqual([[TODAY, 1], [day(-1), 0]]);
  });

  it("replaces, never increments; a complete day always wins; a lower bound only raises a stored number (v1.1 correctness-2)", async () => {
    await put("C0LV1", [dayCount(TODAY, 5)]);
    await put("C0LV1", [dayCount(TODAY, 3)]);
    expect(stored()).toMatchObject({ n: 3, complete: true });
    await put("C0LV1", [dayCount(TODAY, 10, true, 2)]);
    await put("C0LV1", [dayCount(TODAY, 4, false)]);
    expect(stored()).toMatchObject({ n: 10, complete: true, skipped: 2 });
    await put("C0LV1", [dayCount(TODAY, 12, false)]);
    expect(stored()).toMatchObject({ n: 12, complete: false });
    await put("C0LV1", [dayCount(TODAY, 2, true)]);
    expect(stored()).toMatchObject({ n: 2, complete: true });
    const r = await db.rpc("exec_slack_lead_counts_put", { p_principal: "ep_1", p_channel: "C0LV1", p_tz: "UTC", p_today: TODAY, p_counted_at: NOW.toISOString(),
      p_final_through: null, p_final_attempt: false, p_days: [{ d: TODAY, n: 1, skipped: 0, complete: false, expires_at: inDays(60) }] });
    expect(r.data).toEqual({ outcome: "written", days: 1, kept: 1 });
  });

  it("the RPC's bounds raise (today - 9, today + 2, today two days off, final_through not yesterday): a code-only store error", async () => {
    for (const [days, over] of [[[dayCount(day(-9), 1)], {}], [[dayCount(day(2), 1)], {}], [[], { today: day(-2) }], [[], { finalThrough: day(-2) }]] as const) {
      await expect(put("C0LV1", [...days], over)).rejects.toThrow(/^exec slack leads store: putLeadCounts failed \(P0001\)$/);
    }
    expect(await put("C0LV1", [dayCount(day(-8), 1), dayCount(day(1), 1)])).toBe("written");
    await expect(put("C0LV1", Array.from({ length: 11 }, () => dayCount(TODAY, 1)))).rejects.toThrow(TypeError);
    await expect(put("C0LV1", [{ ...dayCount(TODAY, 1), n: -1 }])).rejects.toThrow(/n must be an integer/);
    await expect(put("C0LV1", [{ ...dayCount(TODAY, 1), expiresAt: NOW.toISOString() }])).rejects.toThrow(/after countedAt/);
  });

  it("0 days stamps counted_at; final_through moves to yesterday; finalAttempt stamps final_attempt_at, false leaves it; a write clears last_error_code", async () => {
    await store.noteLeadChannelError(P, "C0LV1", "internal_error", false);
    expect(await put("C0LV1", [], { countedAt: new Date("2026-11-10T12:00:00.000Z") })).toBe("written");
    let row = db.tables.exec_slack_lead_channels[0];
    expect([row.counted_at, row.final_attempt_at, row.last_error_code]).toEqual(["2026-11-10T12:00:00.000Z", null, null]);
    await put("C0LV1", [dayCount(day(-1), 4)], { countedAt: new Date("2026-11-10T12:30:00.000Z"), finalThrough: day(-1), finalAttempt: true });
    row = db.tables.exec_slack_lead_channels[0];
    expect([row.final_attempt_at, row.final_through, row.counted_from]).toEqual(["2026-11-10T12:30:00.000Z", day(-1), day(-1)]);
    await put("C0LV1", [dayCount(TODAY, 1)], { countedAt: new Date("2026-11-10T13:00:00.000Z") });
    row = db.tables.exec_slack_lead_channels[0];
    expect([row.final_attempt_at, row.final_through, row.counted_from]).toEqual(["2026-11-10T12:30:00.000Z", day(-1), day(-1)]);
    db.missing.add("exec_slack_lead_counts_put");
    await expect(put("C0LV1", [])).rejects.toThrow(/not_installed/);
  });

  it("noteLeadChannelError stores the code (and final_attempt_at on a final attempt) and never throws; its log names no channel id (C21)", async () => {
    await store.noteLeadChannelError(P, "C0LV1", "not_in_channel", true);
    expect(db.tables.exec_slack_lead_channels[0]).toMatchObject({ last_error_code: "not_in_channel", final_attempt_at: NOW.toISOString() });
    await store.noteLeadChannelError(P, "C0LV1", "Bad Code With Spaces", false);
    expect(db.tables.exec_slack_lead_channels[0].last_error_code).toBe("unknown");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.failNext("update:exec_slack_lead_channels", "57014");
    await expect(store.noteLeadChannelError(P, "C0LV1", "timeout", false)).resolves.toBeUndefined();
    await expect(store.noteLeadChannelError(P, "bad id", "timeout", false)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(err.mock.calls)).not.toMatch(/C0LV1/);
    expect(err.mock.calls[0]).toEqual(["[exec-slack-leads] noteLeadChannelError failed principal=ep_1 (57014)"]);
  });

  it("dropLeadChannel deletes his lead row and its counts (the cascade); a missing table is nothing to do", async () => {
    await put("C0LV1", [dayCount(TODAY, 2)]);
    await store.dropLeadChannel(P, "C0LV1");
    expect([db.tables.exec_slack_lead_channels, db.tables.exec_slack_lead_counts]).toEqual([[], []]);
    db.missing.add("exec_slack_lead_channels");
    await expect(store.dropLeadChannel(P, "C0LV1")).resolves.toBeUndefined();
  });
});

describe("reads: listLeadChannelStates, leadSummary, leadCoverage (twins of SQ08)", () => {
  beforeEach(async () => {
    use({ tables: { exec_slack_channels: ["C0SA1", "C0SA2", "C0SA3", "C0SA4", "C0SA5"].map((c) => marker(c)) } });
    await store.applyLeadMap(P, INST, [
      linked("C0SA1", "vob", "fb_id", "t_zen", "cl_zen", "Zenith House"), linked("C0SA2", "vob", "fb_name", "t_zen2", "cl_zen", "Zenith House"),
      linked("C0SA3", "calendly", "fb_sibling", "t_acme", null, "Acme Recovery"), mapRow("C0SA4"), linked("C0SA5", "other", "fb_id", "t_zen", "cl_zen", "Zenith House")
    ], true, NOW, new Date(inDays(90)));
  });
  const put = (channel: string, days: ReturnType<typeof dayCount>[], countedAt = NOW) =>
    store.putLeadCounts(P, channel, { tz: "America/New_York", today: TODAY, days, countedAt, finalThrough: null, finalAttempt: false });

  it("listLeadChannelStates: never counted first, then the oldest counted_at; every field, dates as YYYY-MM-DD", async () => {
    await put("C0SA1", [dayCount(TODAY, 1)], new Date("2026-11-10T10:00:00.000Z"));
    await put("C0SA2", [dayCount(day(-1), 1)], new Date("2026-11-10T09:00:00.000Z"));
    const s = await store.listLeadChannelStates(P);
    expect(s.map((r) => r.channelId)).toEqual(["C0SA3", "C0SA4", "C0SA5", "C0SA2", "C0SA1"]);
    expect(s.find((r) => r.channelId === "C0SA2")).toEqual({ channelId: "C0SA2", kind: "vob", link: "fb_name", countedFrom: day(-1), finalThrough: null,
      countedAt: "2026-11-10T09:00:00.000Z", lastErrorCode: null, finalAttemptAt: null, taskId: "t_zen2", clientId: "cl_zen", clientLabel: "Zenith House" });
    db.missing.add("exec_slack_lead_channels");
    expect(await store.listLeadChannelStates(P)).toEqual([]);
  });

  it("leadSummary groups by client (c:), task (t:) and unlinked per kind and day; drops non-marker parents and expired rows; <= 31 days", async () => {
    await put("C0SA1", [dayCount(TODAY, 3), dayCount(day(-1), 1, false)], new Date("2026-11-10T10:00:00.000Z"));
    await put("C0SA2", [dayCount(TODAY, 2)]);
    await put("C0SA3", [dayCount(TODAY, 4)]);
    await put("C0SA4", [dayCount(TODAY, 7)]);
    await put("C0SA5", [dayCount(TODAY, 9)]);
    const s = await store.leadSummary(P, day(-1), TODAY);
    expect(s.map((r) => [r.groupKey, r.kind, r.day, r.n, r.channels, r.complete, r.clientLabel])).toEqual([
      ["c:cl_zen", "other", TODAY, 9, 1, true, "Zenith House"], ["c:cl_zen", "vob", day(-1), 1, 1, false, "Zenith House"],
      ["c:cl_zen", "vob", TODAY, 5, 2, true, "Zenith House"], ["t:t_acme", "calendly", TODAY, 4, 1, true, "Acme Recovery"],
      ["unlinked", "vob", TODAY, 7, 1, true, null]
    ]);
    expect(s[1].oldestCountedAt).toBe("2026-11-10T10:00:00.000Z");
    Object.assign(db.tables.exec_slack_channels.find((c) => c.channel_id === "C0SA4") as Row, { class: "standard", deny_reason: null });
    Object.assign(db.tables.exec_slack_lead_counts.find((k) => k.channel_id === "C0SA3") as Row, { counted_at: inDays(-2), expires_at: inDays(-1) });
    expect((await store.leadSummary(P, day(-1), TODAY)).map((r) => r.groupKey)).toEqual(["c:cl_zen", "c:cl_zen", "c:cl_zen"]);
    expect(await store.leadSummary(P, day(-32), TODAY)).toEqual([]);
    expect(await store.leadSummary(P, TODAY, day(-1))).toEqual([]);
    await expect(store.leadSummary(P, "2026-11", TODAY)).rejects.toThrow(TypeError);
  });

  it("leadCoverage counts channels, links, other kinds, errors, never counted and today's skipped posts; missing → null", async () => {
    await put("C0SA1", [dayCount(TODAY, 3, true, 2)]);
    await store.noteLeadChannelError(P, "C0SA2", "not_in_channel", false);
    expect(await store.leadCoverage(P, TODAY)).toEqual({ channels: 5, linked: 3, unlinked: 1, ambiguous: 0, otherKind: 1, withError: 1, neverCounted: 4,
      oldestCountedAt: NOW.toISOString(), skippedToday: 2 });
    db.missing.add("exec_slack_lead_coverage");
    expect(await store.leadCoverage(P, TODAY)).toBeNull();
  });
});

describe("purges and cascades (twins of SQ07, SQ10)", () => {
  beforeEach(async () => {
    use({ tables: { exec_slack_channels: [marker("C0LV1"), marker("C0LV2"), { ...marker("C0LVB"), principal_id: "ep_2" }] } });
    await store.applyLeadMap(P, INST, [mapRow("C0LV1"), mapRow("C0LV2")], false, NOW, new Date(inDays(90)));
    await store.applyLeadMap(P2, INST, [mapRow("C0LVB")], false, NOW, new Date(inDays(90)));
    for (const [p, c] of [[P, "C0LV1"], [P, "C0LV2"], [P2, "C0LVB"]] as const) {
      await store.putLeadCounts(p, c, { tz: "UTC", today: TODAY, days: [dayCount(TODAY, 1), dayCount(day(-1), 2)], countedAt: NOW, finalThrough: null, finalAttempt: false });
    }
  });

  it("purgeLeadCounts / purgeLeadCountsSystem delete one principal's rows; null while the function is missing", async () => {
    expect(await store.purgeLeadCounts(P)).toEqual({ counts: 4, channels: 2 });
    expect(await store.purgeLeadCountsSystem("ep_2")).toEqual({ counts: 2, channels: 1 });
    expect(await store.purgeLeadCounts(P)).toEqual({ counts: 0, channels: 0 });
    db.missing.add("exec_slack_lead_purge_principal");
    expect(await store.purgeLeadCountsSystem("ep_2")).toBeNull();
    await expect(store.purgeLeadCountsSystem("")).rejects.toThrow(TypeError);
  });

  it("purgeExpiredLeadCounts deletes expired counts and channel rows, again while a call fills the 5,000-row batch; missing → zeros", async () => {
    Object.assign(db.tables.exec_slack_lead_counts[0], { counted_at: inDays(-3), expires_at: inDays(-1) });
    Object.assign(db.tables.exec_slack_lead_channels.find((l) => l.channel_id === "C0LV2") as Row, { mapped_at: inDays(-3), expires_at: inDays(-1) });
    expect(await store.purgeExpiredLeadCounts(NOW)).toEqual({ counts: 1, channels: 1 });
    expect(db.tables.exec_slack_lead_counts.map((k) => k.channel_id).sort()).toEqual(["C0LV1", "C0LVB", "C0LVB"]);
    const extra = Array.from({ length: 5001 }, (_, i) => ({ principal_id: "ep_1", channel_id: "C0LV1", local_day: `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, "0")}`,
      tz: "UTC", n: 1, skipped: 0, complete: true, counted_at: inDays(-3), expires_at: inDays(-1), seq: i }));
    db.tables.exec_slack_lead_counts.push(...extra);
    const before = db.calls.length;
    expect(await store.purgeExpiredLeadCounts(NOW)).toEqual({ counts: 5001, channels: 0 });
    expect(db.calls.slice(before).filter((c) => c.target === "exec_slack_lead_purge_expired")).toHaveLength(2);
    db.missing.add("exec_slack_lead_purge_expired");
    expect(await store.purgeExpiredLeadCounts(NOW)).toEqual({ counts: 0, channels: 0 });
  });

  it("listPrincipalsWithLeadRows: distinct, ordered, <= limit; missing → []", async () => {
    expect(await store.listPrincipalsWithLeadRows(100)).toEqual(["ep_1", "ep_2"]);
    expect(await store.listPrincipalsWithLeadRows(1)).toEqual(["ep_1"]);
    db.missing.add("exec_slack_lead_channels");
    expect(await store.listPrincipalsWithLeadRows(10)).toEqual([]);
  });

  it("the fake's cascades: P7a's marker deleted → the lead row and its counts go; a re-key moves them (ON UPDATE CASCADE)", () => {
    expect(db.deleteChannel("ep_1", "C0LV1")).toBe(3);
    expect(db.tables.exec_slack_lead_channels.map((l) => l.channel_id).sort()).toEqual(["C0LV2", "C0LVB"]);
    db.rekeyChannel("ep_1", "C0LV2", "C0LV2NEW");
    expect(db.tables.exec_slack_lead_channels.find((l) => l.principal_id === "ep_1")?.channel_id).toBe("C0LV2NEW");
    expect(db.tables.exec_slack_lead_counts.filter((k) => k.channel_id === "C0LV2NEW")).toHaveLength(2);
  });
});

describe("exec_slack_fb_lead_channels_v2 in the fake (twin of SQ11)", () => {
  it("the typed list with the onboarding's task and client: exact / case-insensitive unique / ambiguous; label fallback; malformed JSON; 12 entries; deleted task", async () => {
    const list = (entries: unknown[]) => ({ "access.notify.slack_channels": { v: JSON.stringify(entries) } });
    use({ tables: {
      clients: [{ id: "cl_zen", name: "Zenith House" }, { id: "cl_acme", name: "Acme Recovery" }, { id: "cl_p1", name: "Pine Lodge" }, { id: "cl_p2", name: "pine lodge" }],
      tasks: [
        { id: "t_zen", title: "Zenith onboarding", client_name: "Zenith House", deleted_at: null },
        { id: "t_acme", title: "Acme onboarding", client_name: " acme recovery ", deleted_at: null },
        { id: "t_pine", title: "Pine onboarding", client_name: "Pine Lodge ", deleted_at: null },
        { id: "t_none", title: "Untitled onboarding", client_name: null, deleted_at: null },
        { id: "t_gone", title: "Gone", client_name: "Zenith House", deleted_at: NOW.toISOString() },
        { id: "t_bad", title: "Bad", client_name: "Zenith House", deleted_at: null },
        { id: "t_many", title: "Many", client_name: "Acme Recovery", deleted_at: null }
      ],
      fb_onboarding: [
        { task_id: "t_zen", state: { ...list([{ name: "#Zenith House VOB Leads", url: "https://zenith.slack.com/archives/C0LEADVOB1" }]), ein: "12-3456789" } },
        { task_id: "t_acme", state: list([{ name: "acme-recovery-vob-leads", url: "https://app.slack.com/client/T0SCALED/C0LEADVOB2" }]) },
        { task_id: "t_pine", state: list([{ name: "pine-lodge-vob" }]) },
        { task_id: "t_none", state: list([{ name: "untitled-vob" }]) },
        { task_id: "t_gone", state: list([{ name: "gone-vob" }]) },
        { task_id: "t_bad", state: { "access.notify.slack_channels": { v: "[{not json" } } },
        { task_id: "t_many", state: list(Array.from({ length: 14 }, (_, i) => ({ name: `acme-ch-${i}` }))) }
      ]
    } });
    const { data } = await db.rpc("exec_slack_fb_lead_channels_v2", {});
    const rows = data as Row[];
    const by = (name: string) => rows.find((r) => r.name === name);
    expect(by("zenith-house-vob-leads")).toEqual({ task_id: "t_zen", client_id: "cl_zen", client_label: "Zenith House", name: "zenith-house-vob-leads",
      channel_id: "C0LEADVOB1" });
    expect([by("acme-recovery-vob-leads")?.client_id, by("acme-recovery-vob-leads")?.channel_id]).toEqual(["cl_acme", "C0LEADVOB2"]);
    expect([by("pine-lodge-vob")?.client_id, by("pine-lodge-vob")?.client_label]).toEqual([null, "Pine Lodge"]);
    expect([by("untitled-vob")?.client_id, by("untitled-vob")?.client_label]).toEqual([null, "Untitled onboarding"]);
    expect(by("gone-vob")).toBeUndefined();
    expect(rows.filter((r) => String(r.name).startsWith("acme-ch-"))).toHaveLength(12);
    expect(JSON.stringify(rows)).not.toContain("12-3456789");
  });
});

describe("H3 / C21: nothing from a lead post, no channel name, no sentinel in any write", () => {
  it("a fixture run through the store: every request payload holds no sentinel and no Slack channel name", async () => {
    const fx = (await import("@/lib/exec/__tests__/fixtures/p10/lead-history-pages.json")).default as {
      expectMap: { rows: { channelId: string; kind: LeadMapRow["kind"]; link: LeadMapRow["link"]; taskId: string | null; clientId: string | null; clientLabel: string | null }[] };
      channels: { channelId: string; slackName: string; expect: { days: { n: number; skipped: number; complete: boolean }[] } }[];
    };
    use({ tables: { exec_slack_channels: fx.expectMap.rows.map((r) => marker(r.channelId)) } });
    await store.applyLeadMap(P, INST, fx.expectMap.rows.map((r) => ({ channelId: r.channelId, kind: r.kind, link: r.link, taskId: r.taskId, clientId: r.clientId,
      clientLabel: r.clientLabel })), true, NOW, new Date(inDays(90)));
    for (const c of fx.channels) {
      const days = c.expect.days.map((d, i) => dayCount(day(i - 7), d.n, d.complete, d.skipped));
      expect(await store.putLeadCounts(P, c.channelId, { tz: "America/New_York", today: TODAY, days, countedAt: NOW, finalThrough: day(-1), finalAttempt: true }))
        .toBe("written");
    }
    await store.leadSummary(P, day(-7), TODAY);
    await store.leadCoverage(P, TODAY);
    const everything = [db.calls.map((c) => c.payload), db.tables.exec_slack_lead_channels, db.tables.exec_slack_lead_counts];
    const text = JSON.stringify(everything).toLowerCase();
    for (const s of P10_PHI_SENTINELS) expect(text.includes(s.toLowerCase())).toBe(false);
    for (const c of fx.channels) expect(text.includes(c.slackName.toLowerCase())).toBe(false);
    assertNoLeadText(db.tables.exec_slack_lead_counts);
  });
});
