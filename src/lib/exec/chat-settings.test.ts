import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
// Area C's effective chat cap (C30) is tested in its own suite (T46); the view only carries its answer.
vi.mock("@/lib/exec/agent/budget", () => ({ effectiveChatCapUsd: vi.fn() }));
vi.mock("@/lib/exec/attention-feedback", () => ({ feedbackTotals: vi.fn(async () => null) }));
vi.mock("@/lib/exec/drafts-store", () => ({ getVoiceProfile: vi.fn(async () => null) }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), getSyncState: vi.fn(async () => null) }));

import { createChatFakeDb, type ChatFakeDb, type Row } from "@/lib/exec/__tests__/fake-chat-store-db";
import { effectiveChatCapUsd } from "@/lib/exec/agent/budget";
import { DEFAULT_SETTINGS, SETTINGS_COLUMN_GROUPS, loadSettings, settingsFromRow, settingsSchemaFlags } from "@/lib/exec/principal";
import { getSettingsView, updateSettings } from "@/lib/exec/settings";
import { SETTINGS_FIELDS, isSettingsFieldInstalled, settingsFieldFor, validateSettingsField, type SettingsPatch } from "@/lib/exec/settings-fields";
import { principalFromRows } from "@/lib/exec/principal";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P5b's settings (contract §3.2, §3.19.12, B8, B10, C30; T70): the "chat"
// column group in P5a's tolerant loader, the three registry fields behind
// P5a's CAS writer, and SettingsView.effectiveChatCapUsd. The fake PostgREST
// answers 42703 for a selected column the table doesn't have, which is how a
// database without the P5b migration looks to the loader.

const NOW = new Date("2026-11-07T12:00:00.000Z");
const V1 = "2026-11-07T09:00:00.123456+00:00";
const P: ExecPrincipal = (() => {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
})();

const BASE: Row = {
  principal_id: "ep_1", brief_enabled: false, brief_local_time: "08:00", brief_timezone: null, supersede_legacy_brief: false,
  checkins_enabled: true, restricted_policy: "hidden", watch_mode: "active_public", muted_channel_ids: [], retention_days_slack: 90,
  retention_days_email: 180, retention_days_chat: 90, daily_cost_cap_usd: "15.00", updated_at: V1,
  email_enabled: true, drafts_enabled: true, send_enabled: false, voice_enabled: true, ddtext_enabled: false, retention_days_ddtext: 90
};
const CHAT: Row = { chat_enabled: true, ask_ai_uses_exec: false, chat_daily_cap_usd: "4.50" };
/** P7a's two columns: present whenever P5b's are (P7a's migration comes after), so the reads below stay single. */
const SLACK: Row = { slack_reading_enabled: false, slack_daily_cap_usd: "2.00" };

let db: ChatFakeDb;
/** exec_settings with the P2a-P5a columns, plus P5b's (and P7a's) when `chat` (the migrations applied). */
function useDb(row: Row | null, { chat = true, drop = [] as string[] } = {}): ChatFakeDb {
  const columns = [...Object.keys(BASE), ...(chat ? [...Object.keys(CHAT), ...Object.keys(SLACK)] : [])].filter((c) => !drop.includes(c));
  const full = row === null ? [] : [Object.fromEntries(Object.entries({ ...BASE, ...(chat ? { ...CHAT, ...SLACK } : {}), ...row }).filter(([k]) => columns.includes(k)))];
  db = createChatFakeDb({
    tables: { exec_settings: full, exec_ai_usage: [], exec_access_log: [] },
    columns: { exec_settings: columns, exec_ai_usage: ["id", "principal_id", "feature", "cost_usd", "created_at"], exec_access_log: ["created_at", "route", "surface", "ip", "user_agent", "session_id", "principal_id"] }
  });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const settingsReads = () => db.on("exec_settings").filter((r) => r.kind === "select");

beforeEach(() => {
  vi.mocked(getSupabaseAdmin).mockReset();
  vi.mocked(effectiveChatCapUsd).mockReset().mockReturnValue(7.77);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("the chat column group in the loader (T70)", () => {
  it("is the last group, needs the drafts group, and its flag is part of every settings value's schema flags", () => {
    // P7a appended its "slack" group after chat (C30): chat is now the last but one.
    expect(SETTINGS_COLUMN_GROUPS.at(-2)).toEqual({ key: "chat", columns: ["chat_enabled", "ask_ai_uses_exec", "chat_daily_cap_usd"] });
    expect(settingsSchemaFlags({ ...DEFAULT_SETTINGS, emailSchemaReady: true, draftsSchemaReady: true, ddtextSchemaReady: true, chatSchemaReady: true })).toEqual({
      email: true, drafts: true, ddtext: true, chat: true, slack: false
    });
  });

  it("P5b's columns present: one read; chat and the routing switch exactly as stored; the cap a numeric string read as a number", async () => {
    useDb({});
    expect(await loadSettings("ep_1")).toMatchObject({ chatEnabled: true, askAiUsesExec: false, chatDailyCapUsd: 4.5, chatSchemaReady: true, ddtextSchemaReady: true });
    expect(settingsReads()).toHaveLength(1);
    expect(settingsReads()[0].columns).toContain("chat_daily_cap_usd");
  });

  it("P5b's columns missing (the migration not applied): the chat group is dropped, chat off and not installed, cap 9; the rest still loads", async () => {
    useDb({ chat_enabled: true }, { chat: false });
    const s = await loadSettings("ep_1");
    expect(s).toMatchObject({ chatEnabled: false, askAiUsesExec: false, chatDailyCapUsd: 9, chatSchemaReady: false, ddtextSchemaReady: true, draftsSchemaReady: true, emailEnabled: true });
    const reads = settingsReads();
    expect(reads).toHaveLength(2);
    expect(reads[1].columns).not.toContain("chat_enabled");
    expect(reads[1].columns).toContain("ddtext_enabled");
  });

  it("the drafts group missing takes the chat group with it (P5b's migration needs P4's)", async () => {
    useDb({}, { chat: true, drop: ["drafts_enabled", "send_enabled", "voice_enabled"] });
    expect(await loadSettings("ep_1")).toMatchObject({ draftsSchemaReady: false, chatSchemaReady: false, chatEnabled: false, ddtextSchemaReady: true, emailSchemaReady: true });
    expect(settingsReads()).toHaveLength(2);
  });

  it("NULLs and junk read as off and the default cap while the schema counts as ready; no row: defaults, ready", async () => {
    useDb({ chat_enabled: null, ask_ai_uses_exec: null, chat_daily_cap_usd: null });
    expect(await loadSettings("ep_1")).toMatchObject({ chatEnabled: false, askAiUsesExec: false, chatDailyCapUsd: 9, chatSchemaReady: true });
    useDb({ chat_enabled: "true", ask_ai_uses_exec: 1, chat_daily_cap_usd: "abc" });
    expect(await loadSettings("ep_1")).toMatchObject({ chatEnabled: false, askAiUsesExec: false, chatDailyCapUsd: 9, chatSchemaReady: true });
    useDb({ ask_ai_uses_exec: true, chat_enabled: false, chat_daily_cap_usd: 0 });
    expect(await loadSettings("ep_1")).toMatchObject({ chatEnabled: false, askAiUsesExec: true, chatDailyCapUsd: 0 });
    useDb(null);
    expect(await loadSettings("ep_1")).toEqual({
      principalId: "ep_1", ...DEFAULT_SETTINGS, emailSchemaReady: true, draftsSchemaReady: true, ddtextSchemaReady: true, chatSchemaReady: true,
      slackReadingSchemaReady: true
    });
  });

  it("settingsFromRow: the switches only with the schema ready; told not ready, a stored true is still off", () => {
    const row = { ...BASE, ...CHAT, ask_ai_uses_exec: true } as never;
    expect(settingsFromRow(row, "ep_1", { chatSchemaReady: false })).toMatchObject({ chatEnabled: false, askAiUsesExec: false, chatSchemaReady: false, chatDailyCapUsd: 4.5 });
    expect(settingsFromRow(row, "ep_1")).toMatchObject({ chatEnabled: true, askAiUsesExec: true, chatSchemaReady: true });
  });
});

describe("the three registry fields (T70)", () => {
  it("chatEnabled, askAiUsesExec and chatDailyCapUsd: group chat, their columns, kinds, bounds and §3.19.12 copy", () => {
    // P7a appended its three fields after these (principal.test.ts pins them).
    expect(SETTINGS_FIELDS.filter((d) => d.group === "chat").map(({ key, column, group, kind, min, max, label }) => ({ key, column, group, kind, min, max, label }))).toEqual([
      { key: "chatEnabled", column: "chat_enabled", group: "chat", kind: "boolean", min: undefined, max: undefined, label: "Chat" },
      { key: "askAiUsesExec", column: "ask_ai_uses_exec", group: "chat", kind: "boolean", min: undefined, max: undefined, label: "Use the assistant for Ask AI" },
      { key: "chatDailyCapUsd", column: "chat_daily_cap_usd", group: "chat", kind: "money", min: 0, max: 100, label: "Chat daily budget" }
    ]);
    expect(settingsFieldFor("chatEnabled")?.help).toBe("Ask questions in DD. Answers use Opus and count toward the daily AI budget.");
    expect(settingsFieldFor("chatDailyCapUsd")?.help).toBe("Chat pauses for the day once it has used this much. The daily AI budget still applies.");
    expect(settingsFieldFor("askAiUsesExec")?.help).toBe(
      // P9 fixer ui-3 (re-pinned): the step-up is his password AND his authenticator code since P9 F1/F2.
      "When on, Ask AI on DD pages answers with the assistant while you're signed in with your password and your authenticator code. Other people, sign-in links and sign-ins without the code keep the current Ask AI."
    );
    // Chat ships: the retention field no longer says it isn't available (bindings AM4).
    expect(settingsFieldFor("retentionDaysChat")?.help).not.toMatch(/isn't available/);
    for (const key of ["chatEnabled", "askAiUsesExec", "chatDailyCapUsd"]) {
      const def = settingsFieldFor(key);
      if (!def) throw new Error(key);
      expect(isSettingsFieldInstalled(def, { chat: true }), key).toBe(true);
      expect(isSettingsFieldInstalled(def, { chat: false, email: true, drafts: true, ddtext: true }), key).toBe(false);
    }
  });

  it("bounds and decimals: the cap is $0 to $100 in whole cents; the switches are booleans", () => {
    const cap = settingsFieldFor("chatDailyCapUsd");
    const on = settingsFieldFor("chatEnabled");
    const routing = settingsFieldFor("askAiUsesExec");
    if (!cap || !on || !routing) throw new Error("fields");
    const cases: [unknown, boolean][] = [[0, true], [0.01, true], [9, true], [12.34, true], [100, true], [-0.01, false], [100.01, false], [12.345, false], ["9", false], [Number.NaN, false], [null, false]];
    for (const [v, ok] of cases) expect(validateSettingsField(cap, v).ok, String(v)).toBe(ok);
    expect(validateSettingsField(cap, 101)).toEqual({ ok: false, detail: "must be an amount from $0 to $100, in whole cents" });
    for (const def of [on, routing]) {
      expect(validateSettingsField(def, true).ok).toBe(true);
      expect(validateSettingsField(def, false).ok).toBe(true);
      expect(validateSettingsField(def, "true")).toEqual({ ok: false, detail: "must be on or off" });
    }
  });
});

describe("updateSettings with the chat fields (T70)", () => {
  it("installed: writes exactly the chat columns and updated_at by CAS; the routing switch is allowed whatever chat is", async () => {
    useDb({ chat_enabled: false });
    const r = await updateSettings(P, { askAiUsesExec: true, chatDailyCapUsd: 12.5 } satisfies SettingsPatch, { expectedVersion: V1, now: NOW });
    expect(r.outcome).toBe("updated");
    const [w] = db.on("exec_settings").filter((q) => q.kind === "update");
    expect(w.payload).toEqual({ ask_ai_uses_exec: true, chat_daily_cap_usd: 12.5, updated_at: NOW.toISOString() });
    if (r.outcome !== "updated") return;
    expect(r.snapshot.settings).toMatchObject({ chatEnabled: false, askAiUsesExec: true, chatDailyCapUsd: 12.5, chatSchemaReady: true });
  });

  it("not installed: any chat key answers not_installed with that field, and nothing is written", async () => {
    for (const patch of [{ chatEnabled: true }, { askAiUsesExec: true }, { chatDailyCapUsd: 5 }, { retentionDaysChat: 30, chatDailyCapUsd: 5 }] as SettingsPatch[]) {
      useDb({}, { chat: false });
      const field = Object.keys(patch).find((k) => k !== "retentionDaysChat");
      expect(await updateSettings(P, patch, { expectedVersion: V1, now: NOW }), JSON.stringify(patch)).toEqual({ outcome: "not_installed", field });
      expect(db.on("exec_settings").filter((q) => q.kind !== "select")).toEqual([]);
    }
  });

  it("an out-of-bounds cap or a non-boolean switch is invalid before any read", async () => {
    useDb({});
    expect(await updateSettings(P, { chatDailyCapUsd: 100.5 }, { expectedVersion: V1 })).toMatchObject({ outcome: "invalid", field: "chatDailyCapUsd" });
    expect(await updateSettings(P, { chatDailyCapUsd: 1.234 }, { expectedVersion: V1 })).toMatchObject({ outcome: "invalid", field: "chatDailyCapUsd" });
    expect(await updateSettings(P, { chatEnabled: "yes" as never }, { expectedVersion: V1 })).toMatchObject({ outcome: "invalid", field: "chatEnabled" });
    expect(db.requests).toEqual([]);
  });
});

describe("SettingsView: schema.chat and effectiveChatCapUsd (T70, C30)", () => {
  it("carries the chat flag and the effective cap computed from the settings it shows", async () => {
    useDb({});
    const view = await getSettingsView(P, NOW);
    expect(view.schema).toEqual({ email: true, drafts: true, ddtext: true, chat: true, slack: true });
    expect(view.effectiveChatCapUsd).toBe(7.77);
    expect(effectiveChatCapUsd).toHaveBeenCalledTimes(1);
    expect(effectiveChatCapUsd).toHaveBeenCalledWith(view.settings);
    expect(view.settings).toMatchObject({ chatDailyCapUsd: 4.5, dailyCostCapUsd: 15 });
  });

  it("before the P5b migration: schema.chat false, and the cap still computed (from the default 9)", async () => {
    useDb({}, { chat: false });
    vi.mocked(effectiveChatCapUsd).mockReturnValue(9);
    const view = await getSettingsView(P, NOW);
    expect(view.schema.chat).toBe(false);
    expect(view.effectiveChatCapUsd).toBe(9);
    expect(vi.mocked(effectiveChatCapUsd).mock.calls[0][0]).toMatchObject({ chatDailyCapUsd: 9, chatSchemaReady: false });
  });
});
