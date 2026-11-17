import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/attention-feedback", () => ({ feedbackTotals: vi.fn() }));
vi.mock("@/lib/exec/sync-state", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/sync-state")>()), getSyncState: vi.fn() }));
vi.mock("@/lib/exec/agent/budget", () => ({ effectiveChatCapUsd: vi.fn(() => 9) }));

import { createFakeDraftsDb, type FakeDraftsDb, type Row } from "@/lib/exec/__tests__/fake-drafts-db";
import { loadSettings, principalFromRows, settingsFromRow, settingsSchemaFlags } from "@/lib/exec/principal";
import { SETTINGS_CONFIRMS, updateSettings } from "@/lib/exec/settings";
import { SETTINGS_FIELDS, isSettingsFieldInstalled, type SettingsPatch } from "@/lib/exec/settings-fields";
import { SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P10 §5.12 (ST01-ST05; contract §3.7, C1, C30, C52; Area B): the slackP10 settings group: the loader, the registry, the
// four confirms (one switch per request), the reply dependencies and the writer's cascade, the route's confirm enum. Against
// the fake PostgREST (a selected column the row doesn't have answers 42703, how a not-applied migration looks).

const NOW = new Date("2026-11-10T15:00:00.000Z");
const V1 = "2026-11-09T09:00:00.123456+00:00";
const P = principalFromRows(
  { id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
  { id: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
) as ExecPrincipal;

const P10_COLS = ["slack_read_all", "slack_lead_counts_enabled", "slack_replies_enabled", "slack_reply_send_enabled", "slack_reply_auto", "slack_reply_daily_cap_usd",
  "slack_voice_enabled"];
function row(over: Row = {}, opts: { p10?: boolean; slack?: boolean } = {}): Row {
  const r: Row = {
    principal_id: "ep_1", brief_enabled: false, brief_local_time: "08:00", brief_timezone: null, supersede_legacy_brief: false, checkins_enabled: true,
    restricted_policy: "hidden", watch_mode: "member_only", muted_channel_ids: [], retention_days_slack: 90, retention_days_email: 180, retention_days_chat: 90,
    daily_cost_cap_usd: "15.00", updated_at: V1, email_enabled: true, drafts_enabled: true, send_enabled: false, voice_enabled: true, ddtext_enabled: false,
    retention_days_ddtext: 90, chat_enabled: false, ask_ai_uses_exec: false, chat_daily_cap_usd: "9.00"
  };
  if (opts.slack !== false) Object.assign(r, { slack_reading_enabled: true, slack_daily_cap_usd: "2.00" });
  if (opts.p10 !== false && opts.slack !== false) {
    Object.assign(r, { slack_read_all: false, slack_lead_counts_enabled: false, slack_replies_enabled: false, slack_reply_send_enabled: false,
      slack_reply_auto: false, slack_reply_daily_cap_usd: "1.50", slack_voice_enabled: true });
  }
  return { ...r, ...over };
}
let db: FakeDraftsDb;
function useDb(r: Row | null = row()): FakeDraftsDb {
  db = createFakeDraftsDb({ now: () => NOW, tables: { exec_settings: r === null ? [] : [r] } });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
const stored = () => (db.tables.exec_settings ?? []).find((r) => r.principal_id === "ep_1") as Row;
const writes = () => db.requests.filter((r) => r.target === "exec_settings" && r.kind !== "select");
const update = (patch: SettingsPatch, confirm?: (typeof SETTINGS_CONFIRMS)[number]) => updateSettings(P, patch, { expectedVersion: V1, now: NOW, ...(confirm ? { confirm } : {}) });

beforeEach(() => {
  vi.mocked(getSupabaseAdmin).mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  useDb();
});

describe("ST01 each notice switch needs its own confirm (one switch per request)", () => {
  const cases: [keyof SettingsPatch, (typeof SETTINGS_CONFIRMS)[number], Row][] = [
    ["slackReadAll", "slack_read_all_notice", {}],
    ["slackLeadCountsEnabled", "slack_lead_counts_notice", {}],
    ["slackRepliesEnabled", "slack_replies_notice", {}],
    ["slackReplySendEnabled", "slack_reply_send_notice", { slack_replies_enabled: true }]
  ];
  for (const [field, confirm, over] of cases) {
    it(`${field}: without ${confirm} → confirmation_required; another confirm → still required; with it → updated`, async () => {
      useDb(row(over));
      expect(await update({ [field]: true })).toEqual({ outcome: "confirmation_required", field });
      expect(await update({ [field]: true }, "slack_reading_notice")).toEqual({ outcome: "confirmation_required", field });
      expect(writes()).toHaveLength(0);
      const r = await update({ [field]: true }, confirm);
      expect(r.outcome).toBe("updated");
      if (r.outcome === "updated") expect((r.snapshot.settings as unknown as Record<string, unknown>)[field]).toBe(true);
      // on → on and on → off need none.
      useDb(row({ ...over, [SETTINGS_FIELDS.find((d) => d.key === field)?.column as string]: true }));
      expect((await update({ [field]: false })).outcome).toBe("updated");
    });
  }
  it("two notice switches in one patch: the one without its confirm answers", async () => {
    expect(await update({ slackReadAll: true, slackLeadCountsEnabled: true }, "slack_read_all_notice")).toEqual({ outcome: "confirmation_required", field: "slackLeadCountsEnabled" });
    expect(await update({ slackReadAll: true, slackLeadCountsEnabled: true }, "slack_lead_counts_notice")).toEqual({ outcome: "confirmation_required", field: "slackReadAll" });
    expect(writes()).toHaveLength(0);
  });
  it("the non-notice P10 fields need no confirm", async () => {
    useDb(row({ slack_replies_enabled: true }));
    expect((await update({ slackReplyAuto: true })).outcome).toBe("updated");
    expect((await update({ slackReplyDailyCapUsd: 3 })).outcome).not.toBe("confirmation_required");
    expect((await update({ slackVoiceEnabled: false })).outcome).not.toBe("confirmation_required");
  });
});

describe("ST02 the reply dependencies and the cascade", () => {
  it("sending or automatic drafts on while replies are (or become) off → invalid naming the field; nothing written", async () => {
    expect(await update({ slackReplySendEnabled: true }, "slack_reply_send_notice")).toMatchObject({ outcome: "invalid", field: "slackReplySendEnabled" });
    expect(await update({ slackReplyAuto: true })).toMatchObject({ outcome: "invalid", field: "slackReplyAuto" });
    useDb(row({ slack_replies_enabled: true }));
    expect(await update({ slackRepliesEnabled: false, slackReplyAuto: true })).toMatchObject({ outcome: "invalid", field: "slackReplyAuto" });
    expect(writes()).toHaveLength(0);
  });
  it("replies off also turns sending and the automatic drafts off in the same write", async () => {
    useDb(row({ slack_replies_enabled: true, slack_reply_send_enabled: true, slack_reply_auto: true }));
    const r = await update({ slackRepliesEnabled: false });
    expect(r.outcome).toBe("updated");
    expect(stored()).toMatchObject({ slack_replies_enabled: false, slack_reply_send_enabled: false, slack_reply_auto: false });
    expect(Object.keys(writes()[0].payload as Row).sort()).toEqual(["slack_replies_enabled", "slack_reply_auto", "slack_reply_send_enabled", "updated_at"]);
  });
  it("replies and sending in one patch with only the replies confirm: sending's confirm is still asked", async () => {
    expect(await update({ slackRepliesEnabled: true, slackReplySendEnabled: true }, "slack_replies_notice"))
      .toEqual({ outcome: "confirmation_required", field: "slackReplySendEnabled" });
  });
  it("the automatic drafts' budget: 0..20 dollars", async () => {
    useDb(row({ slack_replies_enabled: true }));
    expect((await update({ slackReplyDailyCapUsd: 20.01 })).outcome).toBe("invalid");
    expect((await update({ slackReplyDailyCapUsd: -1 })).outcome).toBe("invalid");
    expect((await update({ slackReplyDailyCapUsd: 0 })).outcome).toBe("updated");
  });
});

describe("ST03 the route's confirm enum", () => {
  it("accepts exactly the six confirm values", () => {
    expect([...SETTINGS_CONFIRMS]).toEqual(["ddtext_notice", "slack_reading_notice", "slack_read_all_notice", "slack_lead_counts_notice", "slack_replies_notice",
      "slack_reply_send_notice"]);
    const route = readFileSync(fileURLToPath(new URL("../../app/api/exec/settings/route.ts", import.meta.url)), "utf8");
    expect(route).toContain("confirm: z.enum(SETTINGS_CONFIRMS).optional()");
    expect(route).toMatch(/afterSlackP10Settings\(principal, before, result\.snapshot\.settings, now\)/);
    expect(route.indexOf("afterSlackP10Settings(")).toBeGreaterThan(route.indexOf("runAudited("));
  });
});

describe("ST04 the loader's slackP10 group", () => {
  it("all seven columns: read, the switches exactly as stored, the cap parsed; ready", async () => {
    useDb(row({ slack_read_all: true, slack_lead_counts_enabled: true, slack_replies_enabled: true, slack_reply_send_enabled: "true", slack_reply_daily_cap_usd: "2.25",
      slack_voice_enabled: false }));
    expect(await loadSettings("ep_1")).toMatchObject({ slackP10SchemaReady: true, slackReadAll: true, slackLeadCountsEnabled: true, slackRepliesEnabled: true,
      slackReplySendEnabled: false, slackReplyAuto: false, slackReplyDailyCapUsd: 2.25, slackVoiceEnabled: false });
  });
  it("a missing column drops the group (defaults, not ready); the slack group missing takes it too", async () => {
    useDb(row({ slack_read_all: true }, { p10: false }));
    const s = await loadSettings("ep_1");
    expect(s).toMatchObject({ slackP10SchemaReady: false, slackReadAll: false, slackLeadCountsEnabled: false, slackReplyDailyCapUsd: 1.5, slackVoiceEnabled: true,
      slackReadingSchemaReady: true });
    expect(settingsSchemaFlags(s).slackP10).toBe(false);
    useDb(row({}, { slack: false }));
    expect(await loadSettings("ep_1")).toMatchObject({ slackReadingSchemaReady: false, slackP10SchemaReady: false });
    // settingsFromRow with only some P10 columns: not ready.
    const partial = { ...row(), slack_voice_enabled: undefined } as Row;
    delete partial.slack_voice_enabled;
    expect(settingsFromRow(partial as never, "ep_1")).toMatchObject({ slackP10SchemaReady: false });
  });
  it("a P10 field before the migration is not_installed", async () => {
    useDb(row({}, { p10: false }));
    expect(await update({ slackLeadCountsEnabled: true }, "slack_lead_counts_notice")).toEqual({ outcome: "not_installed", field: "slackLeadCountsEnabled" });
  });
});

describe("ST05 the seven registry rows", () => {
  it("section slack, group slackP10, §3.7.2's order, the copy's labels; installed only with the slackP10 flag", () => {
    const rows = SETTINGS_FIELDS.filter((d) => d.group === "slackP10");
    expect(rows.map((d) => [d.key, d.column, d.kind, d.section])).toEqual([
      ["slackReadAll", "slack_read_all", "boolean", "slack"], ["slackLeadCountsEnabled", "slack_lead_counts_enabled", "boolean", "slack"],
      ["slackRepliesEnabled", "slack_replies_enabled", "boolean", "slack"], ["slackReplySendEnabled", "slack_reply_send_enabled", "boolean", "slack"],
      ["slackReplyAuto", "slack_reply_auto", "boolean", "slack"], ["slackReplyDailyCapUsd", "slack_reply_daily_cap_usd", "money", "slack"],
      ["slackVoiceEnabled", "slack_voice_enabled", "boolean", "slack"]
    ]);
    expect(rows.map((d) => d.column)).toEqual(P10_COLS);
    expect(rows.find((d) => d.key === "slackReplyDailyCapUsd")).toMatchObject({ min: 0, max: 20 });
    expect(rows[0].label).toBe(SLACK_P10_COPY.settings.readAllLabel);
    const flags = { email: true, drafts: true, ddtext: true, chat: true, slack: true, slackP10: false };
    for (const d of rows) {
      expect(isSettingsFieldInstalled(d, flags), d.key).toBe(false);
      expect(isSettingsFieldInstalled(d, { ...flags, slackP10: true }), d.key).toBe(true);
    }
  });
  it("P5a's generic form renders none of them (section slack is skipped)", () => {
    const form = readFileSync(fileURLToPath(new URL("../../components/exec/settings/SettingsForm.tsx", import.meta.url)), "utf8");
    expect(form).toMatch(/section === "slack"|section !== "slack"/);
  });
});
