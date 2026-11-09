import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  DEFAULT_SETTINGS,
  DEFAULT_TIMEZONE,
  SETTINGS_COLUMN_GROUPS,
  countEnabledMailPinnedPrincipals,
  isValidTimeZone,
  listEnabledPrincipals,
  loadOwnerBriefRowForLegacy,
  loadPrincipalById,
  loadPrincipalForUser,
  loadSettings,
  loadSettingsSnapshot,
  principalFromRows,
  resolveTimezone,
  settingsColumnsFor,
  settingsFromRow,
  settingsSchemaFlags,
  snapshotFromRow
} from "@/lib/exec/principal";
import { SETTINGS_FIELDS, settingsFieldFor } from "@/lib/exec/settings-fields";
import { SLACK_READ_COPY } from "@/lib/exec/slack-read-copy";

// ---------------------------------------------------------------------------
// A chainable stand-in for the service-role client: from().select().eq()...
// then .maybeSingle() or a plain await. Rows are filtered by every .eq().
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
interface Query {
  table: string;
  columns: string | null;
  filters: [string, unknown][];
}
type DbError = { message: string; code?: string };

/**
 * `errors` fails every query to a table; `failSelect` fails a query by its
 * table and selected columns (a column the database doesn't have yet).
 * Selected rows are projected to the selected columns, like PostgREST.
 */
function fakeDb(
  tables: Record<string, Row[]>,
  errors: Record<string, string> = {},
  failSelect?: (table: string, columns: string) => DbError | null
) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, columns: null, filters: [] };
      queries.push(q);
      const run = () => {
        if (errors[table]) return { data: null, error: { message: errors[table] } as DbError };
        const failed = q.columns !== null ? failSelect?.(table, q.columns) : null;
        if (failed) return { data: null, error: failed };
        const cols = q.columns?.split(",").map((c) => c.trim());
        const rows = (tables[table] ?? [])
          .filter((r) => q.filters.every(([k, v]) => r[k] === v))
          .map((r) => (cols ? Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])) : r));
        return { data: rows, error: null };
      };
      const builder = {
        select(columns: string) {
          q.columns = columns;
          return builder;
        },
        eq(column: string, value: unknown) {
          q.filters.push([column, value]);
          return builder;
        },
        async maybeSingle() {
          const r = run();
          if (r.error) return r;
          if (r.data.length > 1) return { data: null, error: { message: "multiple rows" } };
          return { data: r.data[0] ?? null, error: null };
        },
        then<A, B>(onFulfilled?: (v: ReturnType<typeof run>) => A, onRejected?: (e: unknown) => B) {
          return Promise.resolve(run()).then(onFulfilled, onRejected);
        }
      };
      return builder;
    }
  };
  vi.mocked(getSupabaseAdmin).mockReturnValue(client as unknown as SupabaseClient);
  return { queries, tablesQueried: () => queries.map((q) => q.table) };
}

const principalRow = (over: Row = {}): Row => ({
  id: "ep_1",
  user_id: "u_1",
  enabled: true,
  mail_account_ids: ["acc_1"],
  slack_team_id: null,
  slack_user_id: null,
  ...over
});
const userRow = (over: Row = {}): Row => ({
  id: "u_1",
  email: "Mitchell@ScaledAI.org",
  name: "Mitchell",
  work_timezone: "America/Chicago",
  ...over
});
const settingsRow = (over: Row = {}): Row => ({
  principal_id: "ep_1",
  brief_enabled: true,
  brief_local_time: "07:30",
  brief_timezone: "Asia/Karachi",
  supersede_legacy_brief: true,
  checkins_enabled: false,
  restricted_policy: "dd_only",
  watch_mode: "member_only",
  muted_channel_ids: ["C1", "C2"],
  retention_days_slack: 30,
  retention_days_email: 60,
  retention_days_chat: 45,
  daily_cost_cap_usd: "12.50",
  email_enabled: true,
  drafts_enabled: true,
  send_enabled: false,
  voice_enabled: true,
  ...over
});
const P4_COLUMNS = ["drafts_enabled", "send_enabled", "voice_enabled"] as const;
/** The P3-era row: the P4 switches never read. */
function p3Row(over: Row = {}): Row {
  const { drafts_enabled: _d, send_enabled: _s, voice_enabled: _v, ...rest } = settingsRow(over);
  void _d;
  void _s;
  void _v;
  return rest;
}

// principalFromRows takes the module's private row types; tests build them as plain objects.
type PRow = Parameters<typeof principalFromRows>[0];
type URow = Parameters<typeof principalFromRows>[1];
type SRow = NonNullable<Parameters<typeof principalFromRows>[2]>;

beforeEach(() => {
  vi.mocked(getSupabaseAdmin).mockReset();
});

describe("isValidTimeZone / resolveTimezone", () => {
  it("accepts IANA zones and rejects everything else", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
  });

  it("prefers the settings zone, then the user's zone, then New York", () => {
    expect(resolveTimezone("Asia/Karachi", "Europe/London")).toBe("Asia/Karachi");
    expect(resolveTimezone(null, "Europe/London")).toBe("Europe/London");
    expect(resolveTimezone(undefined, undefined)).toBe(DEFAULT_TIMEZONE);
    expect(DEFAULT_TIMEZONE).toBe("America/New_York");
  });

  it("skips invalid zones instead of failing", () => {
    expect(resolveTimezone("Mars/Olympus", "Europe/London")).toBe("Europe/London");
    expect(resolveTimezone("Mars/Olympus", "Also/Bad")).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimezone("", "")).toBe(DEFAULT_TIMEZONE);
  });
});

describe("settingsFromRow", () => {
  it("returns the defaults when there is no row, without sharing the defaults' array", () => {
    const s = settingsFromRow(null, "ep_9");
    expect(s).toEqual({ principalId: "ep_9", ...DEFAULT_SETTINGS });
    s.mutedChannelIds.push("C_MUTATED");
    expect(DEFAULT_SETTINGS.mutedChannelIds).toEqual([]);
  });

  it("maps every column of a full row", () => {
    expect(settingsFromRow(settingsRow() as unknown as SRow, "ep_1")).toEqual({
      principalId: "ep_1",
      briefEnabled: true,
      briefLocalTime: "07:30",
      briefTimezone: "Asia/Karachi",
      supersedeLegacyBrief: true,
      checkinsEnabled: false,
      restrictedPolicy: "dd_only",
      watchMode: "member_only",
      mutedChannelIds: ["C1", "C2"],
      retentionDaysSlack: 30,
      retentionDaysEmail: 60,
      retentionDaysChat: 45,
      dailyCostCapUsd: 12.5,
      emailEnabled: true,
      emailSchemaReady: true,
      draftsEnabled: true,
      sendEnabled: false,
      voiceEnabled: true,
      draftsSchemaReady: true,
      // P5a stage -1 seed: this row has no P5a columns, so ddtext is off and not installed.
      ddtextEnabled: false,
      retentionDaysDdtext: 90,
      ddtextSchemaReady: false,
      // P5b stage -1 seed: nor the P5b columns, so chat is off and not installed.
      chatEnabled: false,
      askAiUsesExec: false,
      chatDailyCapUsd: 9,
      chatSchemaReady: false,
      // P7a stage -1 seed: nor the P7a columns, so Slack reading is off and not installed.
      slackReadingEnabled: false,
      slackDailyCapUsd: 2,
      slackReadingSchemaReady: false
    });
  });

  it("fills every null column with its default (a NULL switch is off, but the column is there)", () => {
    const nulls = Object.fromEntries(Object.keys(settingsRow()).map((k) => [k, null]));
    const s = settingsFromRow({ ...nulls, principal_id: "ep_1" } as unknown as SRow, "ep_1");
    expect(s).toEqual({ principalId: "ep_1", ...DEFAULT_SETTINGS, emailSchemaReady: true, draftsSchemaReady: true });
    expect(s.emailEnabled).toBe(false);
    expect(s.draftsEnabled).toBe(false);
    expect(s.voiceEnabled).toBe(false);
  });

  it("drafts, send and voice (Y2): on only when the P4 schema is ready and the column is exactly true", () => {
    const s = (over: Row, opts?: { emailSchemaReady?: boolean; draftsSchemaReady?: boolean }) =>
      settingsFromRow(settingsRow(over) as unknown as SRow, "ep_1", opts);
    expect(s({})).toMatchObject({ draftsEnabled: true, sendEnabled: false, voiceEnabled: true, draftsSchemaReady: true });
    expect(s({ send_enabled: true })).toMatchObject({ sendEnabled: true });
    expect(s({ drafts_enabled: null, voice_enabled: null })).toMatchObject({ draftsEnabled: false, voiceEnabled: false, draftsSchemaReady: true });
    expect(s({ drafts_enabled: "true", voice_enabled: 1 })).toMatchObject({ draftsEnabled: false, voiceEnabled: false });
    // A row read without the P4 columns (the P3 or base tier) is never on, whatever it holds.
    expect(settingsFromRow(p3Row() as unknown as SRow, "ep_1")).toMatchObject({ draftsEnabled: false, sendEnabled: false, voiceEnabled: false, draftsSchemaReady: false, emailSchemaReady: true, emailEnabled: true });
    // The loader's explicit answer wins over the row's shape.
    expect(s({}, { draftsSchemaReady: false })).toMatchObject({ draftsEnabled: false, voiceEnabled: false, draftsSchemaReady: false, emailEnabled: true });
    expect(settingsFromRow(null, "ep_1")).toMatchObject({ draftsEnabled: false, draftsSchemaReady: false });
    expect(settingsFromRow(null, "ep_1", { emailSchemaReady: true, draftsSchemaReady: true })).toMatchObject({ draftsEnabled: false, voiceEnabled: false, draftsSchemaReady: true });
    // All three P4 columns must have been read for the schema to count as ready.
    const { voice_enabled: _v, ...twoOfThree } = settingsRow();
    void _v;
    expect(settingsFromRow(twoOfThree as unknown as SRow, "ep_1")).toMatchObject({ draftsSchemaReady: false, draftsEnabled: false });
  });

  it("email: on only when the schema is ready and the column is exactly true", () => {
    const s = (over: Row, opts?: { emailSchemaReady?: boolean }) =>
      settingsFromRow(settingsRow(over) as unknown as SRow, "ep_1", opts);
    expect(s({ email_enabled: true })).toMatchObject({ emailEnabled: true, emailSchemaReady: true });
    expect(s({ email_enabled: false })).toMatchObject({ emailEnabled: false, emailSchemaReady: true });
    expect(s({ email_enabled: null })).toMatchObject({ emailEnabled: false, emailSchemaReady: true });
    expect(s({ email_enabled: "true" })).toMatchObject({ emailEnabled: false, emailSchemaReady: true });
    expect(s({ email_enabled: 1 })).toMatchObject({ emailEnabled: false, emailSchemaReady: true });
    // A row read without the column (the fallback) is never enabled, whatever it holds.
    const { email_enabled: _dropped, ...withoutColumn } = settingsRow();
    void _dropped;
    expect(settingsFromRow(withoutColumn as unknown as SRow, "ep_1")).toMatchObject({ emailEnabled: false, emailSchemaReady: false });
    // The loader's explicit answer wins over the row's shape.
    expect(s({ email_enabled: true }, { emailSchemaReady: false })).toMatchObject({ emailEnabled: false, emailSchemaReady: false });
    // No row: off, and ready only when the caller says the column was read.
    expect(settingsFromRow(null, "ep_1")).toMatchObject({ emailEnabled: false, emailSchemaReady: false });
    expect(settingsFromRow(null, "ep_1", { emailSchemaReady: true })).toMatchObject({ emailEnabled: false, emailSchemaReady: true });
  });

  it("the defaults keep email, drafts, send and voice off and not installed", () => {
    expect(DEFAULT_SETTINGS.emailEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.emailSchemaReady).toBe(false);
    expect(DEFAULT_SETTINGS).toMatchObject({ draftsEnabled: false, sendEnabled: false, voiceEnabled: false, draftsSchemaReady: false });
  });

  it("only accepts a 24h HH:MM brief time", () => {
    const at = (v: unknown) => settingsFromRow(settingsRow({ brief_local_time: v }) as unknown as SRow, "ep_1").briefLocalTime;
    expect(at("23:59")).toBe("23:59");
    expect(at("00:00")).toBe("00:00");
    expect(at("7:00")).toBe("08:00");
    expect(at("24:00")).toBe("08:00");
    expect(at("12:60")).toBe("08:00");
    expect(at("08:00 ")).toBe("08:00");
    expect(at("")).toBe("08:00");
  });

  it("coerces unknown enum values to the safe default", () => {
    const s = (over: Row) => settingsFromRow(settingsRow(over) as unknown as SRow, "ep_1");
    expect(s({ restricted_policy: "show_everything" }).restrictedPolicy).toBe("hidden");
    expect(s({ restricted_policy: "hidden" }).restrictedPolicy).toBe("hidden");
    // P7a N12 (SE02/SE03): anything but exactly 'active_public' is member_only, the smaller footprint.
    expect(s({ watch_mode: "everything" }).watchMode).toBe("member_only");
    expect(s({ watch_mode: "active_public" }).watchMode).toBe("active_public");
  });

  it("parses numeric strings, keeps a 0 cost cap and falls back on garbage", () => {
    const s = (over: Row) => settingsFromRow(settingsRow(over) as unknown as SRow, "ep_1");
    expect(s({ daily_cost_cap_usd: "0" }).dailyCostCapUsd).toBe(0);
    expect(s({ daily_cost_cap_usd: 0 }).dailyCostCapUsd).toBe(0);
    expect(s({ daily_cost_cap_usd: "abc" }).dailyCostCapUsd).toBe(DEFAULT_SETTINGS.dailyCostCapUsd);
    expect(s({ daily_cost_cap_usd: Number.NaN }).dailyCostCapUsd).toBe(DEFAULT_SETTINGS.dailyCostCapUsd);
    expect(s({ retention_days_email: Number.POSITIVE_INFINITY }).retentionDaysEmail).toBe(DEFAULT_SETTINGS.retentionDaysEmail);
  });

  it("copies the muted channel list and ignores a non-array", () => {
    const muted = ["C1"];
    const s = settingsFromRow(settingsRow({ muted_channel_ids: muted }) as unknown as SRow, "ep_1");
    muted.push("C_LATER");
    expect(s.mutedChannelIds).toEqual(["C1"]);
    expect(settingsFromRow(settingsRow({ muted_channel_ids: "C1" }) as unknown as SRow, "ep_1").mutedChannelIds).toEqual([]);
  });

  it("passes brief_timezone through untouched (principalFromRows validates it)", () => {
    expect(settingsFromRow(settingsRow({ brief_timezone: "Mars/Olympus" }) as unknown as SRow, "ep_1").briefTimezone).toBe("Mars/Olympus");
  });
});

describe("principalFromRows", () => {
  const build = (p: Row = {}, u: Row = {}, s: Row | null = null) =>
    principalFromRows(principalRow(p) as unknown as PRow, userRow(u) as unknown as URow, s as unknown as SRow | null);

  it("returns null for a disabled principal", () => {
    expect(build({ enabled: false })).toBeNull();
  });

  it("returns null when the user has no email", () => {
    expect(build({}, { email: null })).toBeNull();
    expect(build({}, { email: "" })).toBeNull();
  });

  it("maps ids, trims and lowercases the email, and trims the name", () => {
    const p = build({ slack_team_id: "T1", slack_user_id: "U1" }, { email: "  Mitchell@ScaledAI.org ", name: "  Mitchell  " });
    expect(p).toMatchObject({
      id: "ep_1",
      userId: "u_1",
      email: "mitchell@scaledai.org",
      name: "Mitchell",
      slackTeamId: "T1",
      slackUserId: "U1"
    });
  });

  it("falls back to the trimmed email when the name is blank", () => {
    expect(build({}, { name: "   " })?.name).toBe("Mitchell@ScaledAI.org");
    expect(build({}, { name: null })?.name).toBe("Mitchell@ScaledAI.org");
  });

  it("resolves the timezone: settings, then user, then New York", () => {
    expect(build({}, {}, settingsRow())?.timezone).toBe("Asia/Karachi");
    expect(build({}, {}, settingsRow({ brief_timezone: "Mars/Olympus" }))?.timezone).toBe("America/Chicago");
    expect(build({}, { work_timezone: null }, null)?.timezone).toBe(DEFAULT_TIMEZONE);
  });

  it("keeps only non-empty string mail account ids", () => {
    expect(build({ mail_account_ids: ["acc_1", "", null, 5, "acc_2"] })?.mailAccountIds).toEqual(["acc_1", "acc_2"]);
    expect(build({ mail_account_ids: null })?.mailAccountIds).toEqual([]);
  });

  it("returns a frozen principal with its own frozen copy of the account ids", () => {
    const ids = ["acc_1"];
    const p = build({ mail_account_ids: ids });
    expect(p).not.toBeNull();
    if (!p) return;
    ids.push("acc_injected");
    expect(p.mailAccountIds).toEqual(["acc_1"]);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.mailAccountIds)).toBe(true);
    expect(() => {
      (p as unknown as { email: string }).email = "attacker@example.com";
    }).toThrow(TypeError);
    expect(() => {
      (p.mailAccountIds as string[]).push("acc_x");
    }).toThrow(TypeError);
  });

  it("defaults missing slack ids to null", () => {
    const p = principalFromRows(
      { id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: [] } as unknown as PRow,
      userRow() as unknown as URow,
      null
    );
    expect(p?.slackTeamId).toBeNull();
    expect(p?.slackUserId).toBeNull();
  });
});

describe("loadPrincipalForUser", () => {
  it("loads the enabled principal for a user, with settings applied", async () => {
    const db = fakeDb({ exec_principals: [principalRow()], users: [userRow()], exec_settings: [settingsRow()] });
    const p = await loadPrincipalForUser("u_1");
    expect(p).toMatchObject({ id: "ep_1", userId: "u_1", email: "mitchell@scaledai.org", timezone: "Asia/Karachi" });
    expect(db.queries[0]).toMatchObject({ table: "exec_principals", filters: [["user_id", "u_1"]] });
    expect(db.queries[0].columns).toContain("mail_account_ids");
    expect(db.queries.find((q) => q.table === "users")?.filters).toEqual([["id", "u_1"]]);
    expect(db.queries.find((q) => q.table === "exec_settings")?.filters).toEqual([["principal_id", "ep_1"]]);
  });

  it("returns null for a user without a principal, without reading further", async () => {
    const db = fakeDb({ exec_principals: [principalRow()], users: [userRow({ id: "u_2" })] });
    expect(await loadPrincipalForUser("u_2")).toBeNull();
    expect(db.tablesQueried()).toEqual(["exec_principals"]);
  });

  it("returns null for a disabled principal, without reading the user", async () => {
    const db = fakeDb({ exec_principals: [principalRow({ enabled: false })], users: [userRow()] });
    expect(await loadPrincipalForUser("u_1")).toBeNull();
    expect(db.tablesQueried()).toEqual(["exec_principals"]);
  });

  it("returns null when the users row is gone or has no email", async () => {
    fakeDb({ exec_principals: [principalRow()], users: [] });
    expect(await loadPrincipalForUser("u_1")).toBeNull();
    fakeDb({ exec_principals: [principalRow()], users: [userRow({ email: null })] });
    expect(await loadPrincipalForUser("u_1")).toBeNull();
  });

  it("throws (never returns null) when any read fails", async () => {
    fakeDb({}, { exec_principals: "boom" });
    await expect(loadPrincipalForUser("u_1")).rejects.toThrow("exec_principals read failed: boom");
    fakeDb({ exec_principals: [principalRow()] }, { users: "down" });
    await expect(loadPrincipalForUser("u_1")).rejects.toThrow("users read failed: down");
    fakeDb({ exec_principals: [principalRow()], users: [userRow()] }, { exec_settings: "gone" });
    await expect(loadPrincipalForUser("u_1")).rejects.toThrow("exec_settings read failed: gone");
  });
});

describe("loadPrincipalById", () => {
  it("loads by principal id", async () => {
    const db = fakeDb({ exec_principals: [principalRow()], users: [userRow()], exec_settings: [] });
    const p = await loadPrincipalById("ep_1");
    expect(p).toMatchObject({ id: "ep_1", timezone: "America/Chicago" });
    expect(db.queries[0]).toMatchObject({ table: "exec_principals", filters: [["id", "ep_1"]] });
  });

  it("returns null for an unknown or disabled principal", async () => {
    fakeDb({ exec_principals: [principalRow()] });
    expect(await loadPrincipalById("ep_missing")).toBeNull();
    fakeDb({ exec_principals: [principalRow({ enabled: false })], users: [userRow()] });
    expect(await loadPrincipalById("ep_1")).toBeNull();
  });

  it("throws when the read fails", async () => {
    fakeDb({}, { exec_principals: "timeout" });
    await expect(loadPrincipalById("ep_1")).rejects.toThrow("exec_principals read failed: timeout");
  });
});

describe("listEnabledPrincipals", () => {
  it("returns every enabled principal that maps to a usable user", async () => {
    const db = fakeDb({
      exec_principals: [
        principalRow(),
        principalRow({ id: "ep_2", user_id: "u_2" }),
        principalRow({ id: "ep_3", user_id: "u_3", enabled: false }),
        principalRow({ id: "ep_4", user_id: "u_4" })
      ],
      users: [
        userRow(),
        userRow({ id: "u_2", email: "exec2@scaledai.org", name: "Second" }),
        userRow({ id: "u_3", email: "off@scaledai.org" }),
        userRow({ id: "u_4", email: null })
      ],
      exec_settings: []
    });
    const list = await listEnabledPrincipals();
    expect(list.map((p) => p.id)).toEqual(["ep_1", "ep_2"]);
    expect(db.queries[0]).toMatchObject({ table: "exec_principals", filters: [["enabled", true]] });
  });

  it("returns an empty list when there are none", async () => {
    fakeDb({ exec_principals: [] });
    expect(await listEnabledPrincipals()).toEqual([]);
  });

  it("throws when the read fails", async () => {
    fakeDb({}, { exec_principals: "nope" });
    await expect(listEnabledPrincipals()).rejects.toThrow("exec_principals read failed: nope");
  });
});

describe("loadSettings", () => {
  // What the database answers for a select naming a column it doesn't have,
  // in the forms the loader must recognise (L1).
  const missingColumn: Record<string, DbError> = {
    "42703": { code: "42703", message: "column exec_settings.email_enabled does not exist" },
    PGRST204: { code: "PGRST204", message: "Could not find the column in the schema cache" },
    "message only": { message: "column \"email_enabled\" does not exist" }
  };
  const failWhenEmailSelected = (err: DbError) => (table: string, columns: string) =>
    table === "exec_settings" && columns.includes("email_enabled") ? err : null;

  it("maps the stored row, email and P4 columns included (one read, the widest tier)", async () => {
    const db = fakeDb({ exec_settings: [settingsRow()] });
    expect(await loadSettings("ep_1")).toMatchObject({
      principalId: "ep_1",
      briefLocalTime: "07:30",
      dailyCostCapUsd: 12.5,
      emailEnabled: true,
      emailSchemaReady: true,
      draftsEnabled: true,
      sendEnabled: false,
      voiceEnabled: true,
      draftsSchemaReady: true
    });
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].columns).toContain("email_enabled");
    for (const c of P4_COLUMNS) expect(db.queries[0].columns).toContain(c);
  });

  // PX07: the three column tiers.
  const missingP4: Record<string, DbError> = {
    "42703": { code: "42703", message: "column exec_settings.drafts_enabled does not exist" },
    PGRST204: { code: "PGRST204", message: "Could not find the 'voice_enabled' column of 'exec_settings' in the schema cache" },
    "message only": { message: "column \"send_enabled\" does not exist" }
  };
  const failWhenP4Selected = (err: DbError) => (table: string, columns: string) =>
    table === "exec_settings" && P4_COLUMNS.some((c) => columns.includes(c)) ? err : null;

  for (const [form, err] of Object.entries(missingP4)) {
    it(`PX07: P4 columns missing (${form}): the P3 tier answers; drafts off and not installed, email still read`, async () => {
      const db = fakeDb({ exec_settings: [p3Row()] }, {}, failWhenP4Selected(err));
      expect(await loadSettings("ep_1")).toMatchObject({
        emailEnabled: true,
        emailSchemaReady: true,
        draftsEnabled: false,
        sendEnabled: false,
        voiceEnabled: false,
        draftsSchemaReady: false,
        retentionDaysEmail: 60
      });
      const reads = db.queries.filter((q) => q.table === "exec_settings");
      expect(reads).toHaveLength(2);
      expect(reads[0].columns).toContain("drafts_enabled");
      expect(reads[1].columns).toContain("email_enabled");
      expect(reads[1].columns).not.toContain("drafts_enabled");
    });
  }

  it("PX07: a NULL switch reads as off while the schema counts as ready", async () => {
    fakeDb({ exec_settings: [settingsRow({ drafts_enabled: null, send_enabled: null, voice_enabled: null })] });
    expect(await loadSettings("ep_1")).toMatchObject({ draftsEnabled: false, sendEnabled: false, voiceEnabled: false, draftsSchemaReady: true });
  });

  it("column present: false and NULL are off, and the schema is ready", async () => {
    fakeDb({ exec_settings: [settingsRow({ email_enabled: false })] });
    expect(await loadSettings("ep_1")).toMatchObject({ emailEnabled: false, emailSchemaReady: true });
    fakeDb({ exec_settings: [settingsRow({ email_enabled: null })] });
    expect(await loadSettings("ep_1")).toMatchObject({ emailEnabled: false, emailSchemaReady: true });
  });

  it("returns defaults when there is no row (the columns were read, so every schema is ready)", async () => {
    fakeDb({ exec_settings: [] });
    expect(await loadSettings("ep_1")).toEqual({
      principalId: "ep_1", ...DEFAULT_SETTINGS, emailSchemaReady: true, draftsSchemaReady: true, ddtextSchemaReady: true, chatSchemaReady: true,
      slackReadingSchemaReady: true
    });
  });

  // P5a (bindings AM9): the column-group loader replaces P4's three tiers. A
  // message that names email_enabled drops the email group and, with it, the
  // drafts group (P4's migration can't exist without P3's column); the ddtext
  // group needs neither and stays. A message that names no column drops the
  // last still-selected group each time, so PGRST204's bare form walks all the
  // way down (P7a's slack, P5b's chat, ddtext, drafts, email) before the base read answers.
  // P5b: the chat group needs drafts, so a named email column takes it too (and P7a's slack group, which needs chat).
  const emailMissingReads: Record<string, { reads: number; ddtextSchemaReady: boolean }> = {
    "42703": { reads: 2, ddtextSchemaReady: true },
    PGRST204: { reads: 6, ddtextSchemaReady: false },
    "message only": { reads: 2, ddtextSchemaReady: true }
  };
  for (const [form, err] of Object.entries(missingColumn)) {
    it(`column missing (${form}): drops the email group and the drafts group with it; email and drafts off and not installed, the rest still loads`, async () => {
      const { email_enabled: _dropped, ...p2aRow } = p3Row();
      void _dropped;
      const db = fakeDb({ exec_settings: [p2aRow] }, {}, failWhenEmailSelected(err));
      const expected = emailMissingReads[form];
      expect(await loadSettings("ep_1")).toMatchObject({
        principalId: "ep_1",
        briefLocalTime: "07:30",
        retentionDaysEmail: 60,
        emailEnabled: false,
        emailSchemaReady: false,
        draftsEnabled: false,
        draftsSchemaReady: false,
        ddtextSchemaReady: expected.ddtextSchemaReady,
        chatEnabled: false,
        chatSchemaReady: false
      });
      const reads = db.queries.filter((q) => q.table === "exec_settings");
      expect(reads).toHaveLength(expected.reads);
      expect(reads[0].columns).toContain("drafts_enabled");
      expect(reads[0].columns).toContain("email_enabled");
      const last = reads[reads.length - 1].columns ?? "";
      expect(last).not.toContain("email_enabled");
      expect(last).not.toContain("drafts_enabled");
      expect(last).toContain("retention_days_email");
      expect(last.includes("ddtext_enabled")).toBe(expected.ddtextSchemaReady);
      expect(last).not.toContain("chat_enabled");
      if (form === "PGRST204") {
        // Unnamed: the last group first (P7a's slack), then P5b's chat, then ddtext, then drafts, then email.
        expect(reads[1].columns).not.toContain("slack_reading_enabled");
        expect(reads[1].columns).toContain("chat_enabled");
        expect(reads[2].columns).not.toContain("chat_enabled");
        expect(reads[2].columns).toContain("ddtext_enabled");
        expect(reads[3].columns).not.toContain("ddtext_enabled");
        expect(reads[3].columns).toContain("drafts_enabled");
        expect(reads[4].columns).toContain("email_enabled");
        expect(reads[4].columns).not.toContain("drafts_enabled");
      }
    });
  }

  it("column missing and no row: defaults; email and drafts not installed, ddtext read", async () => {
    fakeDb({ exec_settings: [] }, {}, failWhenEmailSelected(missingColumn["42703"]));
    expect(await loadSettings("ep_1")).toEqual({ principalId: "ep_1", ...DEFAULT_SETTINGS, ddtextSchemaReady: true });
  });

  it("any other error does not fall back: it throws, and nothing reads as 'email off'", async () => {
    const db = fakeDb({ exec_settings: [settingsRow()] }, {}, (table) =>
      table === "exec_settings" ? { code: "57014", message: "canceling statement due to statement timeout" } : null
    );
    await expect(loadSettings("ep_1")).rejects.toThrow("exec_settings read failed: canceling statement due to statement timeout");
    expect(db.queries.filter((q) => q.table === "exec_settings")).toHaveLength(1);
  });

  it("throws when the fallback read fails too", async () => {
    fakeDb({ exec_settings: [settingsRow()] }, {}, (table, columns) =>
      table !== "exec_settings"
        ? null
        : columns.includes("email_enabled")
          ? missingColumn["42703"]
          : { message: "connection reset" }
    );
    await expect(loadSettings("ep_1")).rejects.toThrow("exec_settings read failed: connection reset");
  });

  it("a principal still loads before the P3 migration (its timezone comes from settings)", async () => {
    const { email_enabled: _dropped, ...p2aRow } = p3Row();
    void _dropped;
    fakeDb({ exec_principals: [principalRow()], users: [userRow()], exec_settings: [p2aRow] }, {}, failWhenEmailSelected(missingColumn.PGRST204));
    expect(await loadPrincipalById("ep_1")).toMatchObject({ id: "ep_1", timezone: "Asia/Karachi" });
  });

  it("throws when the read fails", async () => {
    fakeDb({}, { exec_settings: "down" });
    await expect(loadSettings("ep_1")).rejects.toThrow("exec_settings read failed: down");
  });
});

describe("loadSettings: the column-group loader (P5a test 22)", () => {
  const P5A_ROW = { ddtext_enabled: true, retention_days_ddtext: 30, updated_at: "2026-11-06T12:00:00.123456+00:00" };
  const fullRow = () => settingsRow(P5A_ROW);
  const failWhen = (column: string, err: DbError) => (table: string, columns: string) =>
    table === "exec_settings" && columns.split(",").includes(column) ? err : null;
  const reads = (db: ReturnType<typeof fakeDb>) => db.queries.filter((q) => q.table === "exec_settings").map((q) => q.columns ?? "");

  it("every group present: one read of every group's columns and updated_at; every flag true", async () => {
    const db = fakeDb({ exec_settings: [fullRow()] });
    expect(await loadSettings("ep_1")).toMatchObject({
      emailEnabled: true,
      emailSchemaReady: true,
      draftsEnabled: true,
      draftsSchemaReady: true,
      ddtextEnabled: true,
      retentionDaysDdtext: 30,
      ddtextSchemaReady: true
    });
    const cols = reads(db);
    expect(cols).toHaveLength(1);
    expect(cols[0].split(",")).toEqual(expect.arrayContaining(["updated_at", ...SETTINGS_COLUMN_GROUPS.flatMap((g) => [...g.columns])]));
    expect(cols[0]).toBe(settingsColumnsFor({ email: true, drafts: true, ddtext: true, chat: true, slack: true }));
  });

  const ddtextMissing: Record<string, DbError> = {
    "42703 naming ddtext_enabled": { code: "42703", message: "column exec_settings.ddtext_enabled does not exist" },
    "PGRST204 naming retention_days_ddtext": { code: "PGRST204", message: "Could not find the 'retention_days_ddtext' column of 'exec_settings' in the schema cache" },
    "message only": { message: 'column "ddtext_enabled" does not exist' }
  };
  for (const [form, err] of Object.entries(ddtextMissing)) {
    it(`ddtext columns missing (${form}): only ddtext is off and not installed; email and drafts still read`, async () => {
      const db = fakeDb({ exec_settings: [settingsRow()] }, {}, failWhen("ddtext_enabled", err));
      expect(await loadSettings("ep_1")).toMatchObject({
        emailEnabled: true,
        emailSchemaReady: true,
        draftsEnabled: true,
        draftsSchemaReady: true,
        ddtextEnabled: false,
        retentionDaysDdtext: 90,
        ddtextSchemaReady: false
      });
      const cols = reads(db);
      expect(cols).toHaveLength(2);
      expect(cols[1]).toContain("drafts_enabled");
      expect(cols[1]).toContain("email_enabled");
      expect(cols[1]).not.toContain("ddtext");
    });
  }

  it("the drafts group missing leaves the ddtext group alone (it doesn't need P4)", async () => {
    const db = fakeDb({ exec_settings: [{ ...p3Row(), ...P5A_ROW }] }, {}, failWhen("drafts_enabled", { code: "42703", message: "column exec_settings.drafts_enabled does not exist" }));
    expect(await loadSettings("ep_1")).toMatchObject({ emailSchemaReady: true, draftsSchemaReady: false, ddtextSchemaReady: true, ddtextEnabled: true });
    expect(reads(db)).toHaveLength(2);
  });

  it("the email group missing (named) takes the drafts group with it, and the ddtext group stays", async () => {
    const merged: Row = { ...p3Row(), ...P5A_ROW };
    const { email_enabled: _e, ...row } = merged;
    void _e;
    const db = fakeDb({ exec_settings: [row] }, {}, failWhen("email_enabled", { code: "42703", message: "column exec_settings.email_enabled does not exist" }));
    expect(await loadSettings("ep_1")).toMatchObject({ emailSchemaReady: false, draftsSchemaReady: false, ddtextSchemaReady: true, ddtextEnabled: true });
    const cols = reads(db);
    expect(cols).toHaveLength(2);
    expect(cols[1]).not.toContain("email_enabled");
    expect(cols[1]).not.toContain("drafts_enabled");
    expect(cols[1]).toContain("ddtext_enabled");
  });

  it("an unnamed 42703 drops the last still-selected group first", async () => {
    const unnamed = { code: "42703", message: "column does not exist" };
    // P5b: the chat group was the last one; P7a's slack group now is, so it goes first, then chat (then ddtext, whose
    // column fails).
    const db = fakeDb({ exec_settings: [fullRow()] }, {}, failWhen("ddtext_enabled", unnamed));
    expect(await loadSettings("ep_1")).toMatchObject({
      emailSchemaReady: true, draftsSchemaReady: true, ddtextSchemaReady: false, chatSchemaReady: false, slackReadingSchemaReady: false
    });
    expect(reads(db)).toHaveLength(4);
    // The failing column belongs to an earlier group: the later (present) groups go first, then that one.
    const db2 = fakeDb({ exec_settings: [fullRow()] }, {}, failWhen("send_enabled", unnamed));
    expect(await loadSettings("ep_1")).toMatchObject({ emailSchemaReady: true, draftsSchemaReady: false, ddtextSchemaReady: false, chatSchemaReady: false });
    const cols = reads(db2);
    expect(cols).toHaveLength(5);
    expect(cols[1]).toContain("chat_enabled");
    expect(cols[1]).not.toContain("slack_reading_enabled");
    expect(cols[2]).toContain("ddtext_enabled");
    expect(cols[2]).not.toContain("chat_enabled");
    expect(cols[3]).toContain("drafts_enabled");
    expect(cols[3]).not.toContain("ddtext_enabled");
    expect(cols[4]).toContain("email_enabled");
    expect(cols[4]).not.toContain("drafts_enabled");
  });

  it("any other error throws after one read (a 500, a timeout, a connection failure)", async () => {
    for (const err of [{ message: "Internal Server Error" }, { code: "57014", message: "canceling statement due to statement timeout" }, { code: "08006", message: "connection failure" }]) {
      const db = fakeDb({ exec_settings: [fullRow()] }, {}, (table) => (table === "exec_settings" ? err : null));
      await expect(loadSettings("ep_1")).rejects.toThrow(`exec_settings read failed: ${err.message}`);
      expect(reads(db)).toHaveLength(1);
    }
  });

  it("a base column failing throws once every optional group is dropped (one retry per group)", async () => {
    const db = fakeDb({ exec_settings: [fullRow()] }, {}, (table) =>
      table === "exec_settings" ? { code: "42703", message: "column exec_settings.updated_at does not exist" } : null
    );
    await expect(loadSettings("ep_1")).rejects.toThrow("exec_settings read failed: column exec_settings.updated_at does not exist");
    const cols = reads(db);
    expect(cols).toHaveLength(SETTINGS_COLUMN_GROUPS.length + 1);
    expect(cols[cols.length - 1]).toBe(settingsColumnsFor({ email: false, drafts: false, ddtext: false, chat: false, slack: false }));
  });

  it("a principal's timezone still loads with only the base columns", async () => {
    fakeDb({ exec_principals: [principalRow()], users: [userRow()], exec_settings: [p3Row()] }, {}, (table, columns) =>
      table === "exec_settings" && /email_enabled|ddtext_enabled|drafts_enabled/.test(columns) ? { code: "PGRST204", message: "Could not find the column" } : null
    );
    expect(await loadPrincipalById("ep_1")).toMatchObject({ id: "ep_1", timezone: "Asia/Karachi" });
  });
});

describe("loadSettingsSnapshot and the snapshot helpers (P5a test 23)", () => {
  const RAW = "2026-11-06T12:00:00.123456+00:00";

  it("version is exec_settings.updated_at exactly as the database printed it; settings are loadSettings'", async () => {
    fakeDb({ exec_settings: [settingsRow({ ddtext_enabled: false, retention_days_ddtext: 45, updated_at: RAW })] });
    const snap = await loadSettingsSnapshot("ep_1");
    expect(snap.version).toBe(RAW);
    expect(snap.settings).toEqual(await loadSettings("ep_1"));
    expect(snap.settings).toMatchObject({ ddtextEnabled: false, retentionDaysDdtext: 45, ddtextSchemaReady: true });
  });

  it("no row: version null and defaults; a failed read throws", async () => {
    fakeDb({ exec_settings: [] });
    expect(await loadSettingsSnapshot("ep_1")).toEqual({
      version: null,
      settings: {
        principalId: "ep_1", ...DEFAULT_SETTINGS, emailSchemaReady: true, draftsSchemaReady: true, ddtextSchemaReady: true, chatSchemaReady: true,
        slackReadingSchemaReady: true
      }
    });
    fakeDb({}, { exec_settings: "down" });
    await expect(loadSettingsSnapshot("ep_1")).rejects.toThrow("exec_settings read failed: down");
  });

  it("settingsFromRow: ddtextEnabled only when the schema is ready and the column is exactly true; retention defaults to 90", () => {
    const s = (over: Row, ready?: boolean) => settingsFromRow(settingsRow(over) as unknown as SRow, "ep_1", ready === undefined ? {} : { ddtextSchemaReady: ready });
    expect(s({ ddtext_enabled: true, retention_days_ddtext: 30 })).toMatchObject({ ddtextEnabled: true, retentionDaysDdtext: 30, ddtextSchemaReady: true });
    expect(s({ ddtext_enabled: "true", retention_days_ddtext: 30 })).toMatchObject({ ddtextEnabled: false, ddtextSchemaReady: true });
    expect(s({ ddtext_enabled: 1, retention_days_ddtext: 30 })).toMatchObject({ ddtextEnabled: false });
    expect(s({ ddtext_enabled: null, retention_days_ddtext: null })).toMatchObject({ ddtextEnabled: false, retentionDaysDdtext: 90, ddtextSchemaReady: true });
    expect(s({ ddtext_enabled: true, retention_days_ddtext: "abc" })).toMatchObject({ retentionDaysDdtext: 90 });
    expect(s({ ddtext_enabled: true, retention_days_ddtext: 30 }, false)).toMatchObject({ ddtextEnabled: false, ddtextSchemaReady: false });
    // Only one of the two P5a columns read: not ready.
    expect(s({ ddtext_enabled: true })).toMatchObject({ ddtextEnabled: false, ddtextSchemaReady: false });
  });

  it("snapshotFromRow takes the raw version, and none from a row without a usable updated_at", () => {
    const schema = { email: true, drafts: true, ddtext: true, chat: false, slack: false };
    expect(snapshotFromRow(settingsRow({ updated_at: RAW, ddtext_enabled: true, retention_days_ddtext: 7 }), "ep_1", schema)).toMatchObject({
      version: RAW,
      settings: { ddtextEnabled: true, retentionDaysDdtext: 7, ddtextSchemaReady: true, draftsSchemaReady: true }
    });
    expect(snapshotFromRow(settingsRow(), "ep_1", schema).version).toBeNull();
    expect(snapshotFromRow(settingsRow({ updated_at: 12 }), "ep_1", schema).version).toBeNull();
    expect(snapshotFromRow(null, "ep_1", { email: false, drafts: false, ddtext: true, chat: false, slack: false })).toEqual({
      version: null,
      settings: { principalId: "ep_1", ...DEFAULT_SETTINGS, ddtextSchemaReady: true }
    });
  });

  it("settingsColumnsFor and settingsSchemaFlags", () => {
    const base = settingsColumnsFor({ email: false, drafts: false, ddtext: false, chat: false, slack: false });
    expect(base.split(",")).toContain("updated_at");
    expect(base).not.toMatch(/email_enabled|drafts_enabled|ddtext_enabled|chat_enabled/);
    expect(settingsColumnsFor({ email: true, drafts: false, ddtext: true, chat: false, slack: false })).toBe(`${base},email_enabled,ddtext_enabled,retention_days_ddtext`);
    expect(settingsColumnsFor({ email: true, drafts: true, ddtext: false, chat: true, slack: false })).toBe(
      `${base},email_enabled,drafts_enabled,send_enabled,voice_enabled,chat_enabled,ask_ai_uses_exec,chat_daily_cap_usd`
    );
    expect(settingsSchemaFlags({ emailSchemaReady: true, draftsSchemaReady: false, ddtextSchemaReady: true, chatSchemaReady: false, slackReadingSchemaReady: false })).toEqual({
      email: true,
      drafts: false,
      ddtext: true,
      chat: false,
      slack: false
    });
    expect(settingsSchemaFlags({ emailSchemaReady: true, draftsSchemaReady: true, ddtextSchemaReady: true, chatSchemaReady: true, slackReadingSchemaReady: true }).chat).toBe(true);
    expect(Object.keys(settingsSchemaFlags(DEFAULT_SETTINGS)).sort()).toEqual(SETTINGS_COLUMN_GROUPS.map((g) => g.key).sort());
  });
});

describe("countEnabledMailPinnedPrincipals (PX08)", () => {
  it("counts only enabled principals with a non-empty pin", async () => {
    const db = fakeDb({
      exec_principals: [
        principalRow(),
        principalRow({ id: "ep_2", user_id: "u_2", mail_account_ids: [] }),
        principalRow({ id: "ep_3", user_id: "u_3", mail_account_ids: null }),
        principalRow({ id: "ep_4", user_id: "u_4", enabled: false, mail_account_ids: ["acc_4"] }),
        principalRow({ id: "ep_5", user_id: "u_5", mail_account_ids: ["", null] }),
        principalRow({ id: "ep_6", user_id: "u_6", mail_account_ids: ["acc_6", "acc_7"] })
      ]
    });
    expect(await countEnabledMailPinnedPrincipals()).toBe(2);
    expect(db.queries[0]).toMatchObject({ table: "exec_principals", filters: [["enabled", true]] });
    expect(db.queries[0].columns).toBe("id,mail_account_ids");
  });

  it("is 0 with none, and throws on a read failure", async () => {
    fakeDb({ exec_principals: [] });
    expect(await countEnabledMailPinnedPrincipals()).toBe(0);
    fakeDb({}, { exec_principals: "down" });
    await expect(countEnabledMailPinnedPrincipals()).rejects.toThrow("exec_principals read failed: down");
  });
});

// ---------------------------------------------------------------------------
// P7a (contract §3.2, §5.16 SE01-SE04): the "slack" settings group, the watch_mode default and mapping, the fields.
// ---------------------------------------------------------------------------

describe("P7a settings: the slack group and watch_mode (SE01-SE04)", () => {
  const slackMissing = (table: string, columns: string): DbError | null =>
    table === "exec_settings" && /slack_reading_enabled|slack_daily_cap_usd/.test(columns)
      ? { code: "42703", message: "column exec_settings.slack_reading_enabled does not exist" }
      : null;
  const p7aRow = (over: Row = {}): Row => ({
    ...settingsRow(),
    ddtext_enabled: true,
    retention_days_ddtext: 30,
    chat_enabled: true,
    ask_ai_uses_exec: false,
    chat_daily_cap_usd: "9.00",
    slack_reading_enabled: true,
    slack_daily_cap_usd: "1.50",
    ...over
  });

  it("SE01: the slack group dropped on a missing column: not ready, switch off, cap 2; the other groups still load", async () => {
    const db = fakeDb({ exec_settings: [p7aRow()] }, {}, slackMissing);
    const s = await loadSettings("ep_1");
    expect(s).toMatchObject({ slackReadingSchemaReady: false, slackReadingEnabled: false, slackDailyCapUsd: 2, chatSchemaReady: true, chatEnabled: true });
    const reads = db.queries.filter((q) => q.table === "exec_settings").map((q) => q.columns ?? "");
    expect(reads).toHaveLength(2);
    expect(reads[1]).not.toMatch(/slack_reading_enabled|slack_daily_cap_usd/);
    expect(reads[1]).toContain("chat_enabled");
    expect(settingsSchemaFlags(s).slack).toBe(false);
  });

  it("SE01: with the columns: the switch only when exactly true, the cap parsed from numeric text; the group follows chat's", async () => {
    fakeDb({ exec_settings: [p7aRow()] });
    expect(await loadSettings("ep_1")).toMatchObject({ slackReadingSchemaReady: true, slackReadingEnabled: true, slackDailyCapUsd: 1.5 });
    const s = (over: Row, ready?: boolean) =>
      settingsFromRow(p7aRow(over) as unknown as SRow, "ep_1", ready === undefined ? {} : { slackReadingSchemaReady: ready });
    expect(s({ slack_reading_enabled: "true" })).toMatchObject({ slackReadingEnabled: false, slackReadingSchemaReady: true });
    expect(s({ slack_reading_enabled: null, slack_daily_cap_usd: null })).toMatchObject({ slackReadingEnabled: false, slackDailyCapUsd: 2 });
    expect(s({ slack_daily_cap_usd: "abc" }).slackDailyCapUsd).toBe(2);
    expect(s({}, false)).toMatchObject({ slackReadingEnabled: false, slackReadingSchemaReady: false });
    // Only one of the two P7a columns read: not ready.
    const { slack_daily_cap_usd: _c, ...oneColumn } = p7aRow();
    void _c;
    expect(settingsFromRow(oneColumn as unknown as SRow, "ep_1")).toMatchObject({ slackReadingEnabled: false, slackReadingSchemaReady: false });
    expect(SETTINGS_COLUMN_GROUPS.map((g) => g.key)).toEqual(["email", "drafts", "ddtext", "chat", "slack"]);
    expect(SETTINGS_COLUMN_GROUPS[SETTINGS_COLUMN_GROUPS.length - 1]).toEqual({ key: "slack", columns: ["slack_reading_enabled", "slack_daily_cap_usd"] });
    // The chat group missing (P5b not applied) takes the slack group with it (P7a needs P6, which needs P5b).
    const chatMissing = (table: string, columns: string): DbError | null =>
      table === "exec_settings" && columns.includes("chat_enabled") ? { code: "42703", message: "column exec_settings.chat_enabled does not exist" } : null;
    fakeDb({ exec_settings: [p7aRow()] }, {}, chatMissing);
    expect(await loadSettings("ep_1")).toMatchObject({ chatSchemaReady: false, slackReadingSchemaReady: false, slackReadingEnabled: false, ddtextSchemaReady: true });
  });

  it("SE02: watch_mode NULL or unknown maps to member_only", () => {
    const s = (over: Row) => settingsFromRow(settingsRow(over) as unknown as SRow, "ep_1");
    expect(s({ watch_mode: null }).watchMode).toBe("member_only");
    expect(s({ watch_mode: "everything" }).watchMode).toBe("member_only");
    expect(s({ watch_mode: "ACTIVE_PUBLIC" }).watchMode).toBe("member_only");
    expect(s({ watch_mode: 1 }).watchMode).toBe("member_only");
    expect(s({ watch_mode: "member_only" }).watchMode).toBe("member_only");
    expect(settingsFromRow(null, "ep_1").watchMode).toBe("member_only");
  });

  it("SE03: active_public is kept", () => {
    expect(settingsFromRow(settingsRow({ watch_mode: "active_public" }) as unknown as SRow, "ep_1").watchMode).toBe("active_public");
  });

  it("SE04: DEFAULT_SETTINGS.watchMode is member_only, and the reading defaults are off / 2 / not ready", () => {
    expect(DEFAULT_SETTINGS.watchMode).toBe("member_only");
    expect(DEFAULT_SETTINGS).toMatchObject({ slackReadingEnabled: false, slackDailyCapUsd: 2, slackReadingSchemaReady: false });
  });

  it("the three P7a registry fields (section slack) carry SLACK_READ_COPY's copy and the §3.2 bounds", () => {
    const tail = SETTINGS_FIELDS.slice(-3).map(({ key, column, group, kind, min, max, section, label, help }) => ({ key, column, group, kind, min, max, section, label, help }));
    expect(tail).toEqual([
      { key: "slackReadingEnabled", column: "slack_reading_enabled", group: "slack", kind: "boolean", min: undefined, max: undefined, section: "slack",
        label: SLACK_READ_COPY.fieldReadingLabel, help: SLACK_READ_COPY.fieldReadingHelp },
      { key: "slackDailyCapUsd", column: "slack_daily_cap_usd", group: "slack", kind: "money", min: 0, max: 100, section: "slack",
        label: SLACK_READ_COPY.fieldCapLabel, help: SLACK_READ_COPY.fieldCapHelp },
      { key: "retentionDaysSlack", column: "retention_days_slack", group: "base", kind: "int", min: 7, max: 365, section: "slack",
        label: SLACK_READ_COPY.fieldRetentionLabel, help: SLACK_READ_COPY.fieldRetentionHelp }
    ]);
    expect(SETTINGS_FIELDS.filter((d) => d.section === "slack").map((d) => d.key)).toEqual(["slackReadingEnabled", "slackDailyCapUsd", "retentionDaysSlack"]);
    expect(settingsFieldFor("retentionDaysSlack")?.group).toBe("base");
  });
});

// ---------------------------------------------------------------------------
// P8 (contract §3.5, §5.1 OW12): the legacy brief gate's principal-free read
// ---------------------------------------------------------------------------

describe("loadOwnerBriefRowForLegacy (OW12)", () => {
  interface LegacyQuery { table: string; columns: string | null; eq: [string, unknown][]; ilike: [string, string][]; limit: number | null }
  /** A chainable client for the loader's three reads: select / eq / ilike (a LIKE pattern, \-escaped, case-insensitive) / limit / maybeSingle. */
  function legacyDb(tables: Record<string, Row[]>, errors: Record<string, DbError> = {}) {
    const queries: LegacyQuery[] = [];
    const likeToRegExp = (pattern: string) => {
      let re = "";
      for (let i = 0; i < pattern.length; i += 1) {
        const c = pattern[i];
        if (c === "\\" && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        else if (c === "%") re += ".*";
        else if (c === "_") re += ".";
        else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      return new RegExp(`^${re}$`, "i");
    };
    const client = {
      from(table: string) {
        const q: LegacyQuery = { table, columns: null, eq: [], ilike: [], limit: null };
        queries.push(q);
        const run = () => {
          if (errors[table]) return { data: null, error: errors[table] };
          const rows = (tables[table] ?? [])
            .filter((r) => q.eq.every(([k, v]) => r[k] === v))
            .filter((r) => q.ilike.every(([k, p]) => typeof r[k] === "string" && likeToRegExp(p).test(r[k] as string)));
          return { data: q.limit === null ? rows : rows.slice(0, q.limit), error: null };
        };
        const b = {
          select(columns: string) { q.columns = columns; return b; },
          eq(column: string, value: unknown) { q.eq.push([column, value]); return b; },
          ilike(column: string, pattern: string) { q.ilike.push([column, pattern]); return b; },
          limit(n: number) { q.limit = n; return b; },
          async maybeSingle() {
            const r = run();
            if (r.error) return r;
            if ((r.data as Row[]).length > 1) return { data: null, error: { message: "multiple rows", code: "PGRST116" } };
            return { data: (r.data as Row[])[0] ?? null, error: null };
          },
          then<A, B>(onFulfilled?: (v: ReturnType<typeof run>) => A, onRejected?: (e: unknown) => B) {
            return Promise.resolve(run()).then(onFulfilled, onRejected);
          }
        };
        return b;
      }
    };
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as unknown as SupabaseClient);
    return { queries };
  }
  const OWNER = "mitchell@scaledai.org";
  const users = [userRow({ email: "Mitchell@ScaledAI.org" }), userRow({ id: "u_2", email: "mitchellxscaledai.org" }), userRow({ id: "u_3", email: "mitchell@scaledai_org" })];

  it("matches the owner's users row case-insensitively and reads the brief settings and zone, never minting a principal", async () => {
    const db = legacyDb({ users, exec_principals: [principalRow()], exec_settings: [settingsRow()] });
    const read = await loadOwnerBriefRowForLegacy(" Mitchell@ScaledAI.org ");
    expect(read).toEqual({
      state: "ok",
      row: { principalId: "ep_1", enabled: true, briefEnabled: true, supersede: true, checkinsEnabled: false, briefLocalTime: "07:30", briefTimezone: "Asia/Karachi" }
    });
    if (read.state !== "ok") throw new Error("expected a row");
    // Scalars only: nothing that holds the principal brand, the email, a name or a token.
    expect(Object.keys(read.row).sort()).toEqual(["briefEnabled", "briefLocalTime", "briefTimezone", "checkinsEnabled", "enabled", "principalId", "supersede"]);
    expect(Object.getOwnPropertySymbols(read.row)).toEqual([]);
    expect(db.queries.map((q) => [q.table, q.columns])).toEqual([
      ["users", "id,email,work_timezone"],
      ["exec_principals", "id,enabled"],
      ["exec_settings", "principal_id,brief_enabled,brief_local_time,brief_timezone,supersede_legacy_brief,checkins_enabled"]
    ]);
    expect(db.queries[0].ilike).toEqual([["email", "mitchell@scaledai.org"]]);
    expect(db.queries[0].limit).toBe(2);
  });

  it("escapes % and _ so a lookalike email never matches (the pattern is exact)", async () => {
    const db = legacyDb({ users, exec_principals: [principalRow({ id: "ep_3", user_id: "u_3" })], exec_settings: [] });
    // "mitchell@scaledai_org" with an unescaped _ would match "mitchell@scaledai.org"'s row too (two rows: a throw).
    await expect(loadOwnerBriefRowForLegacy("mitchell@scaledai_org")).resolves.toMatchObject({ state: "ok", row: { principalId: "ep_3" } });
    expect(db.queries[0].ilike).toEqual([["email", "mitchell@scaledai\\_org"]]);
    legacyDb({ users: [userRow({ email: "a@b.org" })], exec_principals: [principalRow()], exec_settings: [] });
    await expect(loadOwnerBriefRowForLegacy("%@b.org")).resolves.toEqual({ state: "no_principal" });
    await expect(loadOwnerBriefRowForLegacy("a*@b.org")).rejects.toThrow(TypeError);
  });

  it("two users rows for the email → throws", async () => {
    legacyDb({ users: [userRow({ email: OWNER }), userRow({ id: "u_9", email: "MITCHELL@scaledai.org" })], exec_principals: [principalRow()], exec_settings: [] });
    await expect(loadOwnerBriefRowForLegacy(OWNER)).rejects.toThrow("more than one row");
  });

  it("no user or no principal → no_principal; a disabled principal is still read (enabled false)", async () => {
    legacyDb({ users: [], exec_principals: [principalRow()], exec_settings: [] });
    await expect(loadOwnerBriefRowForLegacy(OWNER)).resolves.toEqual({ state: "no_principal" });
    legacyDb({ users, exec_principals: [], exec_settings: [] });
    await expect(loadOwnerBriefRowForLegacy(OWNER)).resolves.toEqual({ state: "no_principal" });
    await expect(loadOwnerBriefRowForLegacy("  ")).resolves.toEqual({ state: "no_principal" });
    legacyDb({ users, exec_principals: [principalRow({ enabled: false })], exec_settings: [] });
    await expect(loadOwnerBriefRowForLegacy(OWNER)).resolves.toEqual({
      state: "ok",
      // No settings row: the P2a defaults (brief off, 08:00, check-ins on) and the user's zone.
      row: { principalId: "ep_1", enabled: false, briefEnabled: false, supersede: false, checkinsEnabled: true, briefLocalTime: "08:00", briefTimezone: "America/Chicago" }
    });
  });

  it.each([["42P01"], ["PGRST205"], ["42703"], ["PGRST204"]])("%s on exec_principals or exec_settings → not_installed", async (code) => {
    legacyDb({ users, exec_principals: [principalRow()], exec_settings: [] }, { exec_principals: { message: "relation does not exist", code } });
    await expect(loadOwnerBriefRowForLegacy(OWNER)).resolves.toEqual({ state: "not_installed" });
    legacyDb({ users, exec_principals: [principalRow()], exec_settings: [] }, { exec_settings: { message: "relation does not exist", code } });
    await expect(loadOwnerBriefRowForLegacy(OWNER)).resolves.toEqual({ state: "not_installed" });
  });

  it("any other error throws, by table and code only", async () => {
    legacyDb({ users }, { users: { message: "canceling statement due to statement timeout mitchell@scaledai.org", code: "57014" } });
    await expect(loadOwnerBriefRowForLegacy(OWNER)).rejects.toThrow("users read failed (57014)");
    legacyDb({ users, exec_principals: [principalRow()] }, { exec_principals: { message: "connection reset" } });
    await expect(loadOwnerBriefRowForLegacy(OWNER)).rejects.toThrow("exec_principals read failed (error)");
    legacyDb({ users, exec_principals: [principalRow()] }, { exec_settings: { message: "timeout", code: "57014" } });
    const err = await loadOwnerBriefRowForLegacy(OWNER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("exec_settings read failed (57014)");
    expect((err as Error).message).not.toContain("mitchell");
  });

  it("the brief zone matches principalFromRows' timezone exactly (the legacy gate and the exec side agree on the day)", async () => {
    for (const [settingsTz, userTz] of [["Asia/Karachi", "America/Chicago"], [null, "America/Chicago"], [null, null], ["Not/AZone", "Asia/Manila"]] as const) {
      legacyDb({ users: [userRow({ work_timezone: userTz })], exec_principals: [principalRow()], exec_settings: [settingsRow({ brief_timezone: settingsTz })] });
      const read = await loadOwnerBriefRowForLegacy(OWNER);
      if (read.state !== "ok") throw new Error("expected a row");
      const p = principalFromRows(principalRow() as unknown as PRow, userRow({ work_timezone: userTz }) as unknown as URow, settingsRow({ brief_timezone: settingsTz }) as unknown as SRow);
      expect(read.row.briefTimezone).toBe(p?.briefTimezone);
      expect(p?.briefTimezone).toBe(p?.timezone);
    }
  });
});
