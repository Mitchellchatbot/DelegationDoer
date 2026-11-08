import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
// Area A's feedback store has its own suite; here only its answer matters.
vi.mock("@/lib/exec/attention-feedback", () => ({ feedbackTotals: vi.fn() }));
// The fake PostgREST can't project sync-state's JSON-path select; the mailbox state is stubbed here.
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), getSyncState: vi.fn() }));
// P5b: Area C's effective chat cap (C30) has its own suite; the view only carries its answer (chat-settings.test.ts).
vi.mock("@/lib/exec/agent/budget", () => ({ effectiveChatCapUsd: vi.fn(() => 9) }));

import { createFakeDraftsDb, type FakeDraftsDb, type FakeRequest, type Row } from "@/lib/exec/__tests__/fake-drafts-db";
import { feedbackTotals } from "@/lib/exec/attention-feedback";
import { DraftStoreError, resetVoiceProfile } from "@/lib/exec/drafts-store";
import { DEFAULT_SETTINGS, loadSettingsSnapshot, principalFromRows } from "@/lib/exec/principal";
import { getSettingsView, listRecentAccess, spendTodayByFeature, updateSettings, updateWatchMode } from "@/lib/exec/settings";
import { SETTINGS_FIELDS, isSettingsFieldInstalled, settingsFieldFor, validateSettingsField, type SettingsPatch } from "@/lib/exec/settings-fields";
import { getSyncState } from "@/lib/exec/sync-state";
import type { ExecPrincipal } from "@/lib/exec/types";
import type { FeedbackTotals } from "@/lib/exec/view-types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// The Settings service (P5a contract §3.7.2, §3.14.2b; tests 24, 25b's store
// half, 25c, 26, 27 and the page model) against the fake PostgREST, which
// projects selects strictly: a selected column the row doesn't have answers
// 42703, which is how a not-yet-applied migration looks to the loader.

const NOW = new Date("2026-11-06T12:00:00.000Z"); // 07:00 in New York (EST)
const V1 = "2026-11-05T09:00:00.123456+00:00";
const V0 = "2026-11-04T09:00:00+00:00";

function mint(id = "ep_1", accounts: string[] = ["acc_1", "acc_2"]): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: `u_${id}`, enabled: true, mail_account_ids: accounts, slack_team_id: null, slack_user_id: null },
    { id: `u_${id}`, email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const P = mint();
const OTHER = mint("ep_2");

type Groups = { email?: boolean; drafts?: boolean; ddtext?: boolean; chat?: boolean; slack?: boolean };
/** An exec_settings row holding the base columns, updated_at and the groups asked for (all by default; P5b's chat and P7a's
 *  slack included). */
function settingsDbRow(over: Row = {}, groups: Groups = {}): Row {
  const g = { email: true, drafts: true, ddtext: true, chat: true, slack: true, ...groups };
  const row: Row = {
    principal_id: "ep_1",
    brief_enabled: false,
    brief_local_time: "08:00",
    brief_timezone: null,
    supersede_legacy_brief: false,
    checkins_enabled: true,
    restricted_policy: "hidden",
    watch_mode: "active_public",
    muted_channel_ids: [],
    retention_days_slack: 90,
    retention_days_email: 180,
    retention_days_chat: 90,
    daily_cost_cap_usd: "15.00",
    updated_at: V1
  };
  if (g.email) row.email_enabled = true;
  if (g.drafts) Object.assign(row, { drafts_enabled: true, send_enabled: false, voice_enabled: true });
  if (g.ddtext) Object.assign(row, { ddtext_enabled: false, retention_days_ddtext: 90 });
  if (g.chat) Object.assign(row, { chat_enabled: false, ask_ai_uses_exec: false, chat_daily_cap_usd: "9.00" });
  if (g.slack) Object.assign(row, { slack_reading_enabled: false, slack_daily_cap_usd: "2.00" });
  return { ...row, ...over };
}

let db: FakeDraftsDb;
function useDb(cfg: Parameters<typeof createFakeDraftsDb>[0] = {}): FakeDraftsDb {
  db = createFakeDraftsDb({ now: () => NOW, ...cfg });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const writes = () => db.requests.filter((r) => r.target === "exec_settings" && r.kind !== "select");
const stored = () => (db.tables.exec_settings ?? []).find((r) => r.principal_id === "ep_1");

beforeEach(() => {
  vi.mocked(getSupabaseAdmin).mockReset();
  vi.mocked(feedbackTotals).mockReset();
  vi.mocked(getSyncState).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------
// Test 24 (with 25c's agreement): updateSettings
// ---------------------------------------------------------------------------

/** Every bound of test 24: [field, value, accepted]. */
const BOUNDS: readonly [keyof SettingsPatch, unknown, boolean][] = [
  ["retentionDaysEmail", 6, false],
  ["retentionDaysEmail", 7, true],
  ["retentionDaysEmail", 730, true],
  ["retentionDaysEmail", 731, false],
  ["retentionDaysEmail", 30.5, false],
  ["retentionDaysEmail", "30", false],
  ["retentionDaysDdtext", 6, false],
  ["retentionDaysDdtext", 7, true],
  ["retentionDaysDdtext", 730, true],
  ["retentionDaysDdtext", 731, false],
  ["retentionDaysChat", 6, false],
  ["retentionDaysChat", 7, true],
  ["retentionDaysChat", 730, true],
  ["retentionDaysChat", 731, false],
  ["dailyCostCapUsd", 0, false],
  ["dailyCostCapUsd", 0.99, false],
  ["dailyCostCapUsd", 1, true],
  ["dailyCostCapUsd", 12.5, true],
  ["dailyCostCapUsd", 12.34, true],
  ["dailyCostCapUsd", 12.345, false],
  ["dailyCostCapUsd", 100, true],
  ["dailyCostCapUsd", 100.001, false],
  ["dailyCostCapUsd", 101, false],
  ["dailyCostCapUsd", Number.NaN, false],
  ["dailyCostCapUsd", Number.POSITIVE_INFINITY, false],
  ["dailyCostCapUsd", "15", false],
  ["voiceEnabled", true, true],
  ["voiceEnabled", false, true],
  ["voiceEnabled", 1, false],
  ["voiceEnabled", "true", false],
  ["ddtextEnabled", false, true],
  ["ddtextEnabled", null, false]
];

describe("updateSettings (test 24)", () => {
  for (const [field, value, accepted] of BOUNDS) {
    it(`${field} = ${String(value)} is ${accepted ? "written" : "refused as invalid before any read"}`, async () => {
      useDb({ tables: { exec_settings: [settingsDbRow()] } });
      const r = await updateSettings(P, { [field]: value } as SettingsPatch, { expectedVersion: V1, now: NOW });
      if (accepted) {
        expect(r.outcome).toBe("updated");
        const def = settingsFieldFor(field);
        expect(stored()?.[def?.column ?? ""]).toBe(value);
      } else {
        expect(r).toMatchObject({ outcome: "invalid", field });
        expect(db.requests).toEqual([]);
      }
    });
  }

  it("an empty patch or an unknown key is invalid on the whole patch, before any read", async () => {
    useDb({ tables: { exec_settings: [settingsDbRow()] } });
    expect(await updateSettings(P, {}, { expectedVersion: V1 })).toMatchObject({ outcome: "invalid", field: "patch" });
    // (P7a made retentionDaysSlack a registry field; briefLocalTime is still not one.)
    expect(await updateSettings(P, { briefLocalTime: "09:00" } as unknown as SettingsPatch, { expectedVersion: V1 })).toMatchObject({ outcome: "invalid", field: "patch" });
    expect(await updateSettings(P, { ddtextEnabled: undefined }, { expectedVersion: V1 })).toMatchObject({ outcome: "invalid", field: "patch" });
    expect(db.requests).toEqual([]);
  });

  it("writes exactly the patch's columns and updated_at, by CAS on the raw version, and answers with the row it selected (no second read)", async () => {
    useDb({ tables: { exec_settings: [settingsDbRow()] } });
    const r = await updateSettings(P, { retentionDaysEmail: 60, dailyCostCapUsd: 20.5, voiceEnabled: false }, { expectedVersion: V1, now: NOW });
    expect(r.outcome).toBe("updated");
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0].kind).toBe("update");
    expect(Object.keys(w[0].payload as Row).sort()).toEqual(["daily_cost_cap_usd", "retention_days_email", "updated_at", "voice_enabled"]);
    expect(w[0].payload).toEqual({ retention_days_email: 60, daily_cost_cap_usd: 20.5, voice_enabled: false, updated_at: NOW.toISOString() });
    expect(w[0].filters).toEqual([
      { op: "eq", column: "principal_id", value: "ep_1" },
      { op: "eq", column: "updated_at", value: V1 }
    ]);
    expect(db.log).toEqual(["select exec_settings", "update exec_settings"]);
    if (r.outcome !== "updated") return;
    expect(r.snapshot.version).toBe(NOW.toISOString());
    expect(r.snapshot.settings).toMatchObject({ retentionDaysEmail: 60, dailyCostCapUsd: 20.5, voiceEnabled: false, draftsEnabled: true, ddtextSchemaReady: true });
    // Untouched columns keep their stored values.
    expect(stored()).toMatchObject({ retention_days_chat: 90, email_enabled: true, ddtext_enabled: false });
  });

  it("the new version is always later than the one it replaces, even when this clock is behind", async () => {
    const ahead = "2026-11-06T12:00:05.000700+00:00";
    useDb({ tables: { exec_settings: [settingsDbRow({ updated_at: ahead })] } });
    const r = await updateSettings(P, { retentionDaysChat: 30 }, { expectedVersion: ahead, now: NOW });
    expect(r.outcome).toBe("updated");
    expect((writes()[0].payload as Row).updated_at).toBe("2026-11-06T12:00:05.001Z");
  });

  it("a stale version: no write lands, the current row comes back as a conflict", async () => {
    useDb({ tables: { exec_settings: [settingsDbRow({ retention_days_email: 365 })] } });
    const r = await updateSettings(P, { retentionDaysEmail: 60 }, { expectedVersion: V0, now: NOW });
    expect(r).toMatchObject({ outcome: "conflict", snapshot: { version: V1, settings: { retentionDaysEmail: 365 } } });
    expect(stored()).toMatchObject({ retention_days_email: 365, updated_at: V1 });
  });

  it("a change between its read and its write (0 rows) re-reads and answers conflict", async () => {
    useDb({
      tables: { exec_settings: [settingsDbRow()] },
      before: (r: FakeRequest, fdb: FakeDraftsDb) => {
        if (r.kind === "update" && r.target === "exec_settings") Object.assign(fdb.tables.exec_settings[0], { updated_at: "2026-11-06T11:59:00+00:00", retention_days_chat: 45 });
      }
    });
    const r = await updateSettings(P, { retentionDaysChat: 30 }, { expectedVersion: V1, now: NOW });
    expect(r).toMatchObject({ outcome: "conflict", snapshot: { version: "2026-11-06T11:59:00+00:00", settings: { retentionDaysChat: 45 } } });
    expect(db.log).toEqual(["select exec_settings", "update exec_settings", "select exec_settings"]);
  });

  it("no row and no version: inserts (on conflict do nothing) the patch, and answers with the new row", async () => {
    // The fake applies no DDL defaults to exec_settings; this hook stands in for them.
    let sent: unknown = null;
    useDb({
      tables: { exec_settings: [] },
      before: (r: FakeRequest) => {
        if (r.kind !== "upsert" || r.target !== "exec_settings") return;
        sent = structuredClone(r.payload);
        r.payload = { ...settingsDbRow(), ...(r.payload as Row) };
      }
    });
    const r = await updateSettings(P, { retentionDaysChat: 30 }, { expectedVersion: null, now: NOW });
    expect(r.outcome).toBe("updated");
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ kind: "upsert", options: { onConflict: "principal_id", ignoreDuplicates: true } });
    expect(sent).toEqual({ principal_id: "ep_1", retention_days_chat: 30, updated_at: NOW.toISOString() });
    if (r.outcome !== "updated") return;
    expect(r.snapshot.version).toBe(NOW.toISOString());
    expect(r.snapshot.settings.retentionDaysChat).toBe(30);
  });

  it("no version but a row exists (or one appears before the insert): conflict, nothing overwritten", async () => {
    useDb({ tables: { exec_settings: [settingsDbRow()] } });
    expect(await updateSettings(P, { retentionDaysChat: 30 }, { expectedVersion: null, now: NOW })).toMatchObject({ outcome: "conflict", snapshot: { version: V1 } });
    expect(writes()).toEqual([]);
    useDb({
      tables: { exec_settings: [] },
      before: (r: FakeRequest, fdb: FakeDraftsDb) => {
        if (r.kind === "upsert") fdb.tables.exec_settings.push(settingsDbRow({ retention_days_chat: 60 }));
      }
    });
    expect(await updateSettings(P, { retentionDaysChat: 30 }, { expectedVersion: null, now: NOW })).toMatchObject({ outcome: "conflict", snapshot: { settings: { retentionDaysChat: 60 } } });
    expect(stored()).toMatchObject({ retention_days_chat: 60 });
  });

  it("a field whose migration isn't applied is not_installed, and nothing is written", async () => {
    useDb({ tables: { exec_settings: [settingsDbRow({}, { ddtext: false })] } });
    expect(await updateSettings(P, { ddtextEnabled: true }, { expectedVersion: V1, confirm: "ddtext_notice" })).toEqual({ outcome: "not_installed", field: "ddtextEnabled" });
    expect(await updateSettings(P, { retentionDaysChat: 30, retentionDaysDdtext: 30 }, { expectedVersion: V1 })).toEqual({ outcome: "not_installed", field: "retentionDaysDdtext" });
    useDb({ tables: { exec_settings: [settingsDbRow({}, { drafts: false })] } });
    expect(await updateSettings(P, { voiceEnabled: false }, { expectedVersion: V1 })).toEqual({ outcome: "not_installed", field: "voiceEnabled" });
    expect(writes()).toEqual([]);
    // Base fields need no migration.
    expect((await updateSettings(P, { retentionDaysEmail: 30 }, { expectedVersion: V1 })).outcome).toBe("updated");
  });

  it("turning DD text triage on needs the notice confirmation; off→off, on→on and on→off need none", async () => {
    useDb({ tables: { exec_settings: [settingsDbRow()] } });
    expect(await updateSettings(P, { ddtextEnabled: true }, { expectedVersion: V1, now: NOW })).toEqual({ outcome: "confirmation_required", field: "ddtextEnabled" });
    expect(writes()).toEqual([]);
    expect((await updateSettings(P, { ddtextEnabled: false }, { expectedVersion: V1, now: NOW })).outcome).toBe("updated");
    const on = await updateSettings(P, { ddtextEnabled: true }, { expectedVersion: NOW.toISOString(), confirm: "ddtext_notice", now: new Date(NOW.getTime() + 1000) });
    expect(on).toMatchObject({ outcome: "updated", snapshot: { settings: { ddtextEnabled: true } } });
    const version = on.outcome === "updated" ? on.snapshot.version : null;
    const again = await updateSettings(P, { ddtextEnabled: true }, { expectedVersion: version, now: new Date(NOW.getTime() + 2000) });
    expect(again.outcome).toBe("updated");
    const off = await updateSettings(P, { ddtextEnabled: false }, { expectedVersion: again.outcome === "updated" ? again.snapshot.version : null, now: new Date(NOW.getTime() + 3000) });
    expect(off).toMatchObject({ outcome: "updated", snapshot: { settings: { ddtextEnabled: false } } });
    // Turning it off writes only the flag (the next ddtext run deletes its data).
    expect(Object.keys(writes().at(-1)?.payload as Row).sort()).toEqual(["ddtext_enabled", "updated_at"]);
  });

  it("a database error throws (the route answers 503); a bad version or principal is a programming error", async () => {
    useDb({ tables: { exec_settings: [settingsDbRow()] }, fail: (r) => (r.kind === "update" ? { message: "lock timeout" } : null) });
    await expect(updateSettings(P, { retentionDaysChat: 30 }, { expectedVersion: V1 })).rejects.toThrow("exec_settings update failed: lock timeout");
    useDb({ tables: { exec_settings: [settingsDbRow()] } });
    await expect(updateSettings(P, { retentionDaysChat: 30 }, { expectedVersion: "x".repeat(65) })).rejects.toThrow(/expectedVersion/);
    await expect(updateSettings({} as ExecPrincipal, { retentionDaysChat: 30 }, { expectedVersion: V1 })).rejects.toThrow(/ExecPrincipal/);
  });

  it("only his row is written", async () => {
    useDb({ tables: { exec_settings: [settingsDbRow(), settingsDbRow({ principal_id: "ep_2" })] } });
    expect((await updateSettings(P, { retentionDaysChat: 30 }, { expectedVersion: V1, now: NOW })).outcome).toBe("updated");
    expect(db.tables.exec_settings.find((r) => r.principal_id === "ep_2")).toMatchObject({ retention_days_chat: 90, updated_at: V1 });
  });
});

// ---------------------------------------------------------------------------
// Test 25c: the registry is client-safe, and the form and the writer agree
// ---------------------------------------------------------------------------

describe("settings-fields.ts (test 25c)", () => {
  const source = readFileSync(fileURLToPath(new URL("./settings-fields.ts", import.meta.url)), "utf8");

  it("imports nothing: no server-only, no Supabase, no other module", () => {
    // (The header comment names server-only and Supabase; only code counts.)
    expect(source).not.toMatch(/^\s*import[\s{("']/m);
    expect(source).not.toMatch(/\brequire\(|\bimport\(|^\s*export\s[^\n]*\sfrom\s/m);
  });

  it("validateSettingsField and updateSettings agree on every bound of test 24", async () => {
    for (const [field, value, accepted] of BOUNDS) {
      const def = settingsFieldFor(field);
      if (!def) throw new Error(`no field ${field}`);
      expect(validateSettingsField(def, value).ok, `${field}=${String(value)}`).toBe(accepted);
      useDb({ tables: { exec_settings: [settingsDbRow()] } });
      const r = await updateSettings(P, { [field]: value } as SettingsPatch, { expectedVersion: V1, confirm: "ddtext_notice", now: NOW });
      expect(r.outcome === "invalid", `${field}=${String(value)}`).toBe(!accepted);
    }
  });

  it("every field has its copy, a known group and kind; bounds only on numbers; the helpers", () => {
    for (const def of SETTINGS_FIELDS) {
      expect(def.label.length).toBeGreaterThan(3);
      expect(def.help.length).toBeGreaterThan(10);
      expect(`${def.label} ${def.help}`).not.toMatch(/stub/i);
      expect(["base", "email", "drafts", "ddtext", "chat", "slack"]).toContain(def.group);
      if (def.kind === "boolean") expect([def.min, def.max]).toEqual([undefined, undefined]);
      else expect(typeof def.min === "number" && typeof def.max === "number").toBe(true);
    }
    expect(settingsFieldFor("briefLocalTime")).toBeUndefined();
    const retention = settingsFieldFor("retentionDaysDdtext");
    if (!retention) throw new Error("no field");
    expect(isSettingsFieldInstalled(retention, { ddtext: true })).toBe(true);
    expect(isSettingsFieldInstalled(retention, { ddtext: false })).toBe(false);
    expect(isSettingsFieldInstalled(retention, {})).toBe(false);
    expect(isSettingsFieldInstalled({ group: "base" }, {})).toBe(true);
    expect(validateSettingsField(retention, 5)).toEqual({ ok: false, detail: "must be a whole number from 7 to 730" });
  });
});

// ---------------------------------------------------------------------------
// Test 26: recent access
// ---------------------------------------------------------------------------

describe("listRecentAccess (test 26)", () => {
  const accessRow = (n: number, over: Row = {}): Row => ({
    id: n,
    principal_id: "ep_1",
    auth_user_id: "auth_1",
    session_id: `sess_${n}_abcdefghijkl`,
    ip: "203.0.113.7",
    user_agent: `Mozilla/5.0 ${"x".repeat(200)}`,
    route: "GET /executive",
    surface: "web",
    created_at: new Date(NOW.getTime() - n * 60_000).toISOString(),
    ...over
  });

  it("reads his rows newest first, 50 by default, by the (principal_id, created_at desc) index", async () => {
    useDb({ tables: { exec_access_log: [...Array.from({ length: 60 }, (_, i) => accessRow(i + 1)), accessRow(0, { principal_id: "ep_2" })] } });
    const rows = await listRecentAccess(P);
    expect(rows).toHaveLength(50);
    expect(rows[0].at).toBe(new Date(NOW.getTime() - 60_000).toISOString());
    const q = db.requests[0];
    expect(q).toMatchObject({
      kind: "select",
      target: "exec_access_log",
      columns: "created_at,route,surface,ip,user_agent,session_id",
      filters: [{ op: "eq", column: "principal_id", value: "ep_1" }],
      orders: [{ column: "created_at", ascending: false }],
      limit: 50
    });
  });

  it("clips the device to 120 characters and the session to an 8-character tag; nulls stay null", async () => {
    useDb({ tables: { exec_access_log: [accessRow(1), accessRow(2, { user_agent: null, session_id: null, ip: null, surface: "slack" })] } });
    const [a, b] = await listRecentAccess(P);
    expect(a).toEqual({ at: accessRow(1).created_at, route: "GET /executive", surface: "web", ip: "203.0.113.7", device: `Mozilla/5.0 ${"x".repeat(108)}`, sessionTag: "sess_1_a" });
    expect(a.device).toHaveLength(120);
    expect(b).toMatchObject({ surface: "slack", ip: null, device: null, sessionTag: null });
  });

  it("takes a smaller limit, caps a larger one at 200, refuses a bad one; a read error or a malformed row throws", async () => {
    useDb({ tables: { exec_access_log: [accessRow(1)] } });
    await listRecentAccess(P, 5);
    await listRecentAccess(P, 500);
    expect(db.requests.map((r) => r.limit)).toEqual([5, 200]);
    await expect(listRecentAccess(P, 0)).rejects.toThrow(/limit/);
    await expect(listRecentAccess(P, 2.5)).rejects.toThrow(/limit/);
    useDb({ fail: () => ({ message: "down" }) });
    await expect(listRecentAccess(P)).rejects.toThrow("exec_access_log read failed: down");
    useDb({ tables: { exec_access_log: [accessRow(1, { surface: "carrier-pigeon" })] } });
    await expect(listRecentAccess(P)).rejects.toThrow(/malformed/);
  });
});

// ---------------------------------------------------------------------------
// Test 27: today's spend by feature
// ---------------------------------------------------------------------------

describe("spendTodayByFeature (test 27)", () => {
  // Local midnight in New York on 2026-11-06 (EST) is 05:00Z.
  const usage = (id: number, feature: string, cost: unknown, createdAt = "2026-11-06T06:00:00.000Z", principal = "ep_1"): Row => ({
    id,
    principal_id: principal,
    feature,
    model: "m",
    cost_usd: cost,
    created_at: createdAt
  });

  it("sums each feature's cost since his local midnight, biggest first; capUsd from the caller", async () => {
    useDb({
      tables: {
        exec_ai_usage: [
          usage(1, "triage", "0.250000"),
          usage(2, "triage", 0.5),
          usage(3, "draft", "1.125000"),
          usage(4, "ddtext", "0.010000", "2026-11-06T05:00:00.000Z"),
          usage(5, "draft", "9.000000", "2026-11-06T04:59:59.999Z"), // yesterday, locally
          usage(6, "chat", "3.000000", "2026-11-06T07:00:00.000Z", "ep_2"),
          usage(7, "brief", "garbage")
        ]
      }
    });
    const spend = await spendTodayByFeature(P, NOW, { capUsd: 15 });
    expect(spend).toEqual({
      totalUsd: 1.885,
      capUsd: 15,
      byFeature: [
        { feature: "draft", usd: 1.125 },
        { feature: "triage", usd: 0.75 },
        { feature: "ddtext", usd: 0.01 },
        { feature: "brief", usd: 0 }
      ]
    });
    expect(db.requests[0]).toMatchObject({
      target: "exec_ai_usage",
      columns: "id,feature,cost_usd",
      filters: [
        { op: "eq", column: "principal_id", value: "ep_1" },
        { op: "gte", column: "created_at", value: "2026-11-06T05:00:00.000Z" },
        { op: "gt", column: "id", value: 0 }
      ],
      orders: [{ column: "id", ascending: true }],
      limit: 1000
    });
    expect(db.log).toEqual(["select exec_ai_usage"]);
  });

  it("pages by id (keyset) until a short page, and reads his cap when not given", async () => {
    useDb({
      tables: {
        exec_ai_usage: Array.from({ length: 2500 }, (_, i) => usage(i + 1, i % 2 ? "triage" : "draft", "0.001000")),
        exec_settings: [settingsDbRow({ daily_cost_cap_usd: "7.50" })]
      }
    });
    const spend = await spendTodayByFeature(P, NOW);
    expect(spend.totalUsd).toBe(2.5);
    expect(spend.capUsd).toBe(7.5);
    expect(spend.byFeature).toEqual([
      { feature: "draft", usd: 1.25 },
      { feature: "triage", usd: 1.25 }
    ]);
    const pages = db.requests.filter((r) => r.target === "exec_ai_usage");
    expect(pages.map((r) => (r.filters.find((f) => f.op === "gt") as { value: unknown }).value)).toEqual([0, 1000, 2000]);
  });

  it("an empty day is zero; a read error throws", async () => {
    useDb({ tables: { exec_ai_usage: [] } });
    expect(await spendTodayByFeature(P, NOW, { capUsd: 15 })).toEqual({ totalUsd: 0, capUsd: 15, byFeature: [] });
    useDb({ fail: () => ({ message: "statement timeout" }) });
    await expect(spendTodayByFeature(P, NOW, { capUsd: 15 })).rejects.toThrow("exec_ai_usage read failed: statement timeout");
  });
});

// ---------------------------------------------------------------------------
// The page model
// ---------------------------------------------------------------------------

const TOTALS: FeedbackTotals = { sinceIso: "2025-11-06T12:00:00.000Z", up: 3, down: 1, byKind: [{ kind: "dd_overdue", up: 3, down: 1 }], byReason: [{ reason: "wrong_priority", count: 1 }] };
const VOICE_ROW: Row = {
  principal_id: "ep_1",
  status: "ready",
  formality: "casual",
  typical_length: "short",
  greeting: "hi_first_name",
  paragraphing: "short_paragraphs",
  bullets: "sometimes",
  emoji: "never",
  sign_off: "Thanks",
  sample_count: 20,
  samples_hash: "a".repeat(64),
  window_days: 90,
  model: "claude-haiku-5-5",
  prompt_version: "voice-v1",
  built_at: "2026-11-01T04:00:00.000Z",
  last_attempt_at: "2026-11-01T04:00:00.000Z",
  last_attempt_error: null,
  updated_at: "2026-11-01T04:00:00.000Z"
};
const accountsState = {
  value: {
    checkedAt: "2026-11-06T11:00:00.000Z",
    accounts: [
      { id: "acc_2", email: "mitchell@scaledai.org", lastSyncedAt: null, lastSyncError: null, lastSyncErrorAt: null },
      { id: "acc_9", email: "someone@else.org", lastSyncedAt: null, lastSyncError: null, lastSyncErrorAt: null }
    ],
    problems: []
  },
  rev: 3
};

describe("getSettingsView", () => {
  it("builds every section: version, settings, schema, pinned mailbox, spend, recent access, feedback, voice", async () => {
    useDb({
      tables: {
        exec_settings: [settingsDbRow({ ddtext_enabled: true })],
        exec_ai_usage: [{ id: 1, principal_id: "ep_1", feature: "triage", model: "m", cost_usd: "0.200000", created_at: "2026-11-06T06:00:00.000Z" }],
        exec_access_log: [{ id: 1, principal_id: "ep_1", session_id: "s1234567890", ip: "203.0.113.7", user_agent: "UA", route: "GET /executive", surface: "web", created_at: "2026-11-06T11:00:00.000Z" }],
        exec_voice_profile: [VOICE_ROW]
      }
    });
    vi.mocked(feedbackTotals).mockResolvedValue(TOTALS);
    vi.mocked(getSyncState).mockResolvedValue(accountsState as never);
    const view = await getSettingsView(P, NOW);
    expect(view).toMatchObject({
      generatedAt: NOW.toISOString(),
      timezone: "America/New_York",
      version: V1,
      settings: { principalId: "ep_1", ddtextEnabled: true, dailyCostCapUsd: 15 },
      schema: { email: true, drafts: true, ddtext: true },
      pinnedMailbox: { ok: true, data: { accountIds: ["acc_1", "acc_2"], emails: ["mitchell@scaledai.org"] } },
      spend: { ok: true, data: { totalUsd: 0.2, capUsd: 15, byFeature: [{ feature: "triage", usd: 0.2 }] } },
      recentAccess: { ok: true, data: [{ at: "2026-11-06T11:00:00.000Z", route: "GET /executive", surface: "web", ip: "203.0.113.7", device: "UA", sessionTag: "s1234567" }] },
      feedback: { ok: true, data: TOTALS },
      voice: { ok: true, data: { installed: true, profile: { principalId: "ep_1", status: "ready", signOff: "Thanks", sampleCount: 20 } } }
    });
    expect(feedbackTotals).toHaveBeenCalledWith(P, NOW, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(getSyncState).toHaveBeenCalledWith(P, "mail", "accounts", expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    // The cap came from the settings read: one settings read in all.
    expect(db.log.filter((l) => l === "select exec_settings")).toHaveLength(1);
  });

  it("before the P5a / P4 migrations: feedback null and voice not installed, without reading either", async () => {
    useDb({ tables: { exec_settings: [settingsDbRow({}, { drafts: false, ddtext: false })] } });
    vi.mocked(getSyncState).mockResolvedValue(null);
    const view = await getSettingsView(P, NOW);
    expect(view.schema).toEqual({ email: true, drafts: false, ddtext: false, chat: false, slack: false });
    expect(view.feedback).toEqual({ ok: true, data: null });
    expect(view.voice).toEqual({ ok: true, data: { installed: false, profile: null } });
    expect(feedbackTotals).not.toHaveBeenCalled();
    expect(db.log).not.toContain("select exec_voice_profile");
    // No accounts state yet: the ids alone.
    expect(view.pinnedMailbox).toEqual({ ok: true, data: { accountIds: ["acc_1", "acc_2"], emails: [] } });
  });

  it("drafts installed but no profile yet: installed, profile null", async () => {
    useDb({ tables: { exec_settings: [settingsDbRow()], exec_voice_profile: [] } });
    vi.mocked(feedbackTotals).mockResolvedValue(null);
    vi.mocked(getSyncState).mockResolvedValue(null);
    const view = await getSettingsView(P, NOW);
    expect(view.voice).toEqual({ ok: true, data: { installed: true, profile: null } });
    expect(view.feedback).toEqual({ ok: true, data: null });
  });

  it("each failed section is unavailable on its own; the others still render", async () => {
    useDb({
      tables: { exec_settings: [settingsDbRow()], exec_voice_profile: [VOICE_ROW] },
      fail: (r) => (r.target === "exec_access_log" || r.target === "exec_ai_usage" ? { message: "down" } : null)
    });
    vi.mocked(feedbackTotals).mockRejectedValue(new Error("exec feedback read failed"));
    vi.mocked(getSyncState).mockRejectedValue(new Error("exec_sync_state mail/accounts: read failed: down"));
    const view = await getSettingsView(P, NOW);
    const unavailable = { ok: false, error: "unavailable" };
    expect(view.recentAccess).toEqual(unavailable);
    expect(view.spend).toEqual(unavailable);
    expect(view.feedback).toEqual(unavailable);
    expect(view.pinnedMailbox).toEqual(unavailable);
    expect(view.voice).toMatchObject({ ok: true, data: { installed: true } });
    expect(view.settings.principalId).toBe("ep_1");
  });

  it("the settings read failing fails the view; a snapshot handed in is used without a read", async () => {
    useDb({ fail: (r) => (r.target === "exec_settings" ? { message: "down" } : null) });
    await expect(getSettingsView(P, NOW)).rejects.toThrow("exec_settings read failed: down");
    useDb({ tables: { exec_settings: [settingsDbRow()] } });
    const snapshot = await loadSettingsSnapshot("ep_1");
    useDb({ tables: { exec_voice_profile: [] } });
    vi.mocked(feedbackTotals).mockResolvedValue(null);
    vi.mocked(getSyncState).mockResolvedValue(null);
    const view = await getSettingsView(P, NOW, { snapshot });
    expect(view.version).toBe(V1);
    expect(db.log).not.toContain("select exec_settings");
  });

  it("no pinned mailbox: no state read", async () => {
    useDb({ tables: { exec_settings: [settingsDbRow()] } });
    vi.mocked(feedbackTotals).mockResolvedValue(null);
    const view = await getSettingsView(mint("ep_1", []), NOW);
    expect(view.pinnedMailbox).toEqual({ ok: true, data: { accountIds: [], emails: [] } });
    expect(getSyncState).not.toHaveBeenCalled();
    expect(DEFAULT_SETTINGS.ddtextEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 25b's store half: resetVoiceProfile (P4's drafts-store.ts, §3.14.2b)
// ---------------------------------------------------------------------------

describe("resetVoiceProfile (test 25b)", () => {
  it("deletes exactly his row: true when one was there, false when none", async () => {
    useDb({ tables: { exec_voice_profile: [VOICE_ROW, { ...VOICE_ROW, principal_id: "ep_2" }] } });
    expect(await resetVoiceProfile(P)).toBe(true);
    expect(db.tables.exec_voice_profile.map((r) => r.principal_id)).toEqual(["ep_2"]);
    const q = db.requests[0];
    expect(q).toMatchObject({ kind: "delete", target: "exec_voice_profile", columns: "principal_id", filters: [{ op: "eq", column: "principal_id", value: "ep_1" }] });
    expect(await resetVoiceProfile(P)).toBe(false);
    expect(await resetVoiceProfile(OTHER)).toBe(true);
  });

  it("null when the table is missing (42P01 / PGRST205); any other error throws", async () => {
    useDb({ missing: ["exec_voice_profile"] });
    expect(await resetVoiceProfile(P)).toBeNull();
    useDb({ fail: () => ({ code: "42P01", message: 'relation "public.exec_voice_profile" does not exist' }) });
    expect(await resetVoiceProfile(P)).toBeNull();
    useDb({ fail: () => ({ code: "57014", message: "canceling statement due to statement timeout" }) });
    await expect(resetVoiceProfile(P)).rejects.toBeInstanceOf(DraftStoreError);
    await expect(resetVoiceProfile(P)).rejects.toThrow(/exec_voice_profile delete failed/);
  });

  it("passes the caller's signal to the query", async () => {
    useDb({ tables: { exec_voice_profile: [] } });
    const signal = new AbortController().signal;
    await resetVoiceProfile(P, { signal });
    expect(db.requests[0].signal).toBe(signal);
  });
});

// ---------------------------------------------------------------------------
// P7a (contract §3.2, §3.10.7, N12, N20, C30): the slack group's fields, the reading notice, updateWatchMode.
// ---------------------------------------------------------------------------

describe("P7a: Slack reading settings", () => {
  it("turning Slack reading on needs confirm: \"slack_reading_notice\" (the DD text notice doesn't count); turning it off writes only the flag", async () => {
    useDb({ tables: { exec_settings: [settingsDbRow()] } });
    expect(await updateSettings(P, { slackReadingEnabled: true }, { expectedVersion: V1, now: NOW })).toEqual({ outcome: "confirmation_required", field: "slackReadingEnabled" });
    expect(await updateSettings(P, { slackReadingEnabled: true }, { expectedVersion: V1, confirm: "ddtext_notice", now: NOW })).toEqual({ outcome: "confirmation_required", field: "slackReadingEnabled" });
    expect(writes()).toEqual([]);
    const on = await updateSettings(P, { slackReadingEnabled: true }, { expectedVersion: V1, confirm: "slack_reading_notice", now: NOW });
    expect(on.outcome).toBe("updated");
    expect(writes()[0].payload).toEqual({ slack_reading_enabled: true, updated_at: NOW.toISOString() });
    if (on.outcome !== "updated") return;
    expect(on.snapshot.settings).toMatchObject({ slackReadingEnabled: true, slackReadingSchemaReady: true });
    // Already on: no confirmation needed again; off: the flag only.
    const off = await updateSettings(P, { slackReadingEnabled: false }, { expectedVersion: NOW.toISOString(), now: new Date(NOW.getTime() + 1000) });
    expect(off.outcome).toBe("updated");
    expect(writes()[1].payload).toEqual({ slack_reading_enabled: false, updated_at: new Date(NOW.getTime() + 1000).toISOString() });
  });

  it("the cap and the Slack retention: bounds from the registry; the slack group before the P7a migration is not_installed (retention is a base column)", async () => {
    useDb({ tables: { exec_settings: [settingsDbRow()] } });
    expect(await updateSettings(P, { slackDailyCapUsd: 100.01 }, { expectedVersion: V1 })).toMatchObject({ outcome: "invalid", field: "slackDailyCapUsd" });
    expect(await updateSettings(P, { retentionDaysSlack: 6 }, { expectedVersion: V1 })).toMatchObject({ outcome: "invalid", field: "retentionDaysSlack" });
    expect(await updateSettings(P, { retentionDaysSlack: 366 }, { expectedVersion: V1 })).toMatchObject({ outcome: "invalid", field: "retentionDaysSlack" });
    const r = await updateSettings(P, { slackDailyCapUsd: 1.5, retentionDaysSlack: 30 }, { expectedVersion: V1, now: NOW });
    expect(r.outcome).toBe("updated");
    expect(writes()[0].payload).toEqual({ slack_daily_cap_usd: 1.5, retention_days_slack: 30, updated_at: NOW.toISOString() });
    useDb({ tables: { exec_settings: [settingsDbRow({}, { slack: false })] } });
    expect(await updateSettings(P, { slackReadingEnabled: true }, { expectedVersion: V1, confirm: "slack_reading_notice" })).toEqual({ outcome: "not_installed", field: "slackReadingEnabled" });
    expect(await updateSettings(P, { slackDailyCapUsd: 1 }, { expectedVersion: V1 })).toEqual({ outcome: "not_installed", field: "slackDailyCapUsd" });
    expect(writes()).toEqual([]);
    expect((await updateSettings(P, { retentionDaysSlack: 30 }, { expectedVersion: V1, now: NOW })).outcome).toBe("updated");
  });

  it("updateWatchMode: the same CAS on updated_at, watch_mode and updated_at only; conflict, insert without a row, an unknown mode", async () => {
    useDb({ tables: { exec_settings: [settingsDbRow({ watch_mode: "member_only" })] } });
    const r = await updateWatchMode(P, "active_public", { expectedVersion: V1 });
    expect(r.outcome).toBe("updated");
    const w = writes();
    expect(w).toHaveLength(1);
    expect(Object.keys(w[0].payload as Row).sort()).toEqual(["updated_at", "watch_mode"]);
    expect((w[0].payload as Row).watch_mode).toBe("active_public");
    expect(w[0].filters).toEqual([{ op: "eq", column: "principal_id", value: "ep_1" }, { op: "eq", column: "updated_at", value: V1 }]);
    if (r.outcome === "updated") expect(r.snapshot.settings.watchMode).toBe("active_public");
    expect(await updateWatchMode(P, "member_only", { expectedVersion: V0 })).toMatchObject({ outcome: "conflict" });
    expect(await updateWatchMode(P, "everything" as never, { expectedVersion: V1 })).toEqual({ outcome: "invalid", field: "patch", detail: "names a watch mode that doesn't exist" });
    expect(await updateWatchMode(P, "member_only", { expectedVersion: null })).toMatchObject({ outcome: "conflict" });
    let sent: unknown = null;
    useDb({
      tables: { exec_settings: [] },
      before: (req: FakeRequest) => {
        if (req.kind !== "upsert" || req.target !== "exec_settings") return;
        sent = structuredClone(req.payload);
        req.payload = { ...settingsDbRow(), ...(req.payload as Row) };
      }
    });
    expect((await updateWatchMode(P, "member_only", { expectedVersion: null })).outcome).toBe("updated");
    expect(Object.keys(sent as Row).sort()).toEqual(["principal_id", "updated_at", "watch_mode"]);
  });
});
