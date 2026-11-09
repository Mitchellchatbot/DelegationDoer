import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/jobs", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/slack-gate-cache", () => ({ v2MissingWithSchemaAt: vi.fn() }));

import { createFakeSlackReadDb, type FakeSlackReadDb, type FakeSlackReadDbSeed } from "@/lib/exec/__tests__/fake-slack-read-db";
import type { Row } from "@/lib/exec/__tests__/fake-slack-db";
import { SLACK_TEXT_SENTINELS as S, assertNoSlackText, captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { SecretUnavailableError, sealSecret } from "@/lib/exec/crypto";
import { enqueueJob } from "@/lib/exec/jobs";
import { v2MissingWithSchemaAt } from "@/lib/exec/slack-gate-cache";
import {
  clearUserTokenError,
  consumeOAuthState,
  enqueueUserCheck,
  getInstallationReading,
  getReadingHalf,
  issueOAuthState,
  lastReadingEventAt,
  listGateInstallations,
  listRevokedReadingInstallations,
  openReadingForSystem,
  openReadingInstallation,
  recordUserTokenError,
  saveReadingConsent,
  slackReadingSchemaReady,
  slackSystemSummary,
  type ReadingConsentInput
} from "@/lib/exec/slack-install";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7a contract §3.7, §5.16 ST09-ST16 (Area A): the user (reading) half of slack-install.ts against
// fake-slack-read-db.ts (which composes P6's fake for the bot half): saveReadingConsent's outcomes (taken on the
// C7 reading key), the reading half's mapping, openReading*'s context string and state filter, the health columns,
// the user check, the global revoked listing, the schema probe, the gate listing, and the OAuth state's purpose.

const KEY = Buffer.alloc(32, 0xa1).toString("base64");
const NOW = new Date("2026-11-08T15:00:00.000Z");
const hex32 = (n: number) => n.toString(16).padStart(32, "0");
const INST = `esi_${hex32(1)}`;
const INST_2 = `esi_${hex32(2)}`;
const H1 = "a".repeat(64);
const principal = (id = "ep_1") => Object.freeze({ id, userId: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", timezone: "UTC",
  mailAccountIds: [], slackTeamId: null, slackUserId: null }) as unknown as ExecPrincipal;
const P1 = principal("ep_1");
const P2 = principal("ep_2");
const NINE = ["channels:history", "groups:history", "channels:read", "groups:read", "users:read", "im:history", "im:read", "mpim:history", "mpim:read"];
const userContext = (pid: string) => `exec_slack_installations.user_token:${pid}`;
const botContext = (pid: string) => `exec_slack_installations.bot_token:${pid}`;

let db: FakeSlackReadDb;
function useDb(seed: FakeSlackReadDbSeed = {}): FakeSlackReadDb {
  db = createFakeSlackReadDb(seed);
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}

/** A P6 (bot-only) installation row, optionally with a reading half. */
function inst(over: Row = {}, reading: boolean = false): Row {
  const pid = (over.principal_id as string | undefined) ?? "ep_1";
  const bot = sealSecret("xoxb-reading-test-bot", botContext(pid));
  const base: Row = {
    id: INST, principal_id: pid, team_id: "T0SCALED", app_id: "A0EXEC", bot_user_id: "U0BOT", bot_id: "B0BOT", bot_token_enc: bot,
    key_id: bot.split(".")[1], bot_scopes: ["chat:write"], user_id: "U0MITCH", user_token_enc: null, user_scopes: [],
    slack_dm_channel_id: "D0MITCH", installed_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z", revoked_at: null,
    revoke_reason: null, last_dm_at: null, last_error_code: null, last_error_at: null, purged_at: null, user_key_id: null, user_installed_at: null,
    user_revoked_at: null, user_revoke_reason: null, user_last_error_code: null, user_last_error_at: null, reading_state: "none", discovered_at: null,
    reading_purged_at: null
  };
  if (reading) {
    const user = sealSecret(S.userToken, userContext(pid));
    Object.assign(base, { user_token_enc: user, user_key_id: user.split(".")[1], user_scopes: [...NINE], user_installed_at: "2026-11-01T00:00:00.000Z",
      reading_state: "ready", discovered_at: "2026-11-01T01:00:00.000Z" });
  }
  return { ...base, ...over };
}

function consent(over: Partial<ReadingConsentInput> = {}): ReadingConsentInput {
  const bot = sealSecret("xoxb-reading-test-bot-2", botContext("ep_1"));
  const user = sealSecret(S.userToken, userContext("ep_1"));
  return {
    teamId: "T0SCALED", appId: "A0EXEC", botUserId: "U0BOT", botId: "B0BOT", botTokenSealed: bot, keyId: bot.split(".")[1],
    botScopes: ["chat:write", "im:history"], userId: "U0MITCH", dmChannelId: "D0MITCH", userTokenSealed: user, userKeyId: user.split(".")[1],
    userScopes: ["channels:history", "groups:history", "channels:read", "groups:read", "users:read", "im:history", "im:read"], ...over
  };
}

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

let out: ReturnType<typeof captureConsole>;
beforeEach(() => {
  vi.stubEnv("EXEC_TOKEN_KEY", KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  vi.mocked(enqueueJob).mockReset();
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 7 });
  vi.mocked(v2MissingWithSchemaAt).mockReset();
  vi.mocked(v2MissingWithSchemaAt).mockReturnValue(null);
  out = captureConsole();
  useDb();
});
afterEach(() => {
  out.assertClean();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe("ST09: saveReadingConsent (N4, C7)", () => {
  it("saved: updates his active row in place with P6's bot fields and the user half, discovering, discovered_at kept; identical key set", async () => {
    useDb({ slack: { tables: { exec_slack_installations: [inst({ discovered_at: null })] } } });
    const input = consent();
    const r = await saveReadingConsent(P1, input);
    expect(r).toMatchObject({ outcome: "saved", id: INST });
    const row = db.tables.exec_slack_installations[0];
    expect(row).toMatchObject({
      bot_token_enc: input.botTokenSealed, key_id: input.keyId, bot_scopes: ["chat:write", "im:history"], user_token_enc: input.userTokenSealed,
      user_key_id: input.userKeyId, user_scopes: ["channels:history", "groups:history", "channels:read", "groups:read", "users:read", "im:history", "im:read"],
      user_revoked_at: null, user_revoke_reason: null, user_last_error_code: null, user_last_error_at: null, reading_state: "discovering",
      reading_purged_at: null, discovered_at: null, revoked_at: null
    });
    expect(Date.parse(String(row.user_installed_at))).toBe((r as { installedAtMs: number }).installedAtMs);
    const update = db.calls.find((c) => c.kind === "update");
    expect(Object.keys(update?.payload as Row).sort()).toEqual([
      "app_id", "bot_id", "bot_scopes", "bot_token_enc", "bot_user_id", "installed_at", "key_id", "last_error_at", "last_error_code", "reading_purged_at",
      "reading_state", "slack_dm_channel_id", "team_id", "updated_at", "user_id", "user_installed_at", "user_key_id", "user_last_error_at",
      "user_last_error_code", "user_revoke_reason", "user_revoked_at", "user_scopes", "user_token_enc"
    ]);
    expect(update?.filters).toEqual([
      { op: "eq", column: "principal_id", value: "ep_1" }, { op: "is", column: "revoked_at", value: null }, { op: "eq", column: "user_id", value: "U0MITCH" }
    ]);
    // A re-consent after a revocation: discovered_at (null after the purge) stays null; earlier rows keep theirs.
    db.tables.exec_slack_installations[0].discovered_at = "2026-11-02T00:00:00.000Z";
    db.tables.exec_slack_installations[0].reading_state = "ready";
    await saveReadingConsent(P1, consent());
    expect(db.tables.exec_slack_installations[0]).toMatchObject({ reading_state: "discovering", discovered_at: "2026-11-02T00:00:00.000Z" });
  });

  it("no_installation: no active row, a revoked one, or another Slack user on it", async () => {
    expect(await saveReadingConsent(P1, consent())).toEqual({ outcome: "no_installation" });
    useDb({ slack: { tables: { exec_slack_installations: [inst({ bot_token_enc: null, key_id: null, revoked_at: NOW.toISOString(), revoke_reason: "disconnected" })] } } });
    expect(await saveReadingConsent(P1, consent())).toEqual({ outcome: "no_installation" });
    useDb({ slack: { tables: { exec_slack_installations: [inst()] } } });
    expect(await saveReadingConsent(P1, consent({ userId: "U0OTHER" }))).toEqual({ outcome: "no_installation" });
  });

  it("taken (C7): another principal's live reading half on the workspace and app → 23505 on the reading key; nothing stored", async () => {
    useDb({ slack: { tables: { exec_slack_installations: [
      inst({ id: INST_2, principal_id: "ep_2", slack_dm_channel_id: "D0JAMES", user_id: "U0JAMES" }, true),
      inst()
    ] } } });
    expect(await saveReadingConsent(P1, consent())).toEqual({ outcome: "taken" });
    expect(db.tables.exec_slack_installations[1]).toMatchObject({ user_token_enc: null, reading_state: "none" });
  });

  it("refuses a plaintext token, a key id that isn't the blob's, a scope outside the nine, a duplicate or a missing required scope", async () => {
    useDb({ slack: { tables: { exec_slack_installations: [inst()] } } });
    for (const bad of [
      { userTokenSealed: S.userToken }, { userKeyId: "00000000" }, { userScopes: ["channels:history", "groups:history", "channels:read", "groups:read", "users:read", "chat:write"] },
      { userScopes: ["channels:history", "channels:history", "groups:history", "channels:read", "groups:read", "users:read"] },
      { userScopes: ["channels:history", "groups:history", "channels:read", "groups:read"] }, { botTokenSealed: "xoxb-plain" }
    ] as Partial<ReadingConsentInput>[]) {
      const err = await thrown(saveReadingConsent(P1, consent(bad)));
      expect(err, JSON.stringify(Object.keys(bad))).toBeInstanceOf(TypeError);
      assertNoSlackText(err, { label: "consent error" });
    }
    expect(db.calls).toEqual([]);
  });
});

describe("ST10: the reading half's mapping", () => {
  it("getReadingHalf / getInstallationReading: every user-half column mapped, the token never (hasToken only), unknown scopes dropped", async () => {
    useDb({ slack: { tables: { exec_slack_installations: [inst({ user_last_error_code: "invalid_auth", user_last_error_at: NOW.toISOString() }, true)] } } });
    const half = await getReadingHalf(P1);
    expect(half?.row).toMatchObject({ id: INST, principalId: "ep_1", teamId: "T0SCALED", userId: "U0MITCH", hasToken: true });
    expect(half?.reading).toEqual({
      state: "ready", scopes: NINE, installedAt: "2026-11-01T00:00:00.000Z", revokedAt: null, revokeReason: null, discoveredAt: "2026-11-01T01:00:00.000Z",
      purgedAt: null, lastErrorCode: "invalid_auth", lastErrorAt: NOW.toISOString(), hasToken: true
    });
    assertNoSlackText(half, { label: "reading half" });
    expect(JSON.stringify(half)).not.toContain("v1.");
    expect(await getReadingHalf(P2)).toBeNull();
    expect((await getInstallationReading(INST))?.reading.state).toBe("ready");
    expect(await getInstallationReading("esi_bogus")).toBeNull();
    useDb({ slack: { tables: { exec_slack_installations: [inst()] } } });
    expect((await getReadingHalf(P1))?.reading).toMatchObject({ state: "none", scopes: [], hasToken: false });
  });

  it("before the P7a migration (a reading column missing): the read throws the database's code", async () => {
    useDb({ slack: { tables: { exec_slack_installations: [inst()] } }, missing: ["exec_slack_installations.reading_state"] });
    expect(await thrown(getReadingHalf(P1))).toMatchObject({ op: "getReadingHalf", pgCode: "42703" });
  });
});

describe("ST11: opening the user token (B-P7a-7)", () => {
  it("opens with exec_slack_installations.user_token:<principal>; the ReadTarget's JSON and inspect forms leave the token out", async () => {
    useDb({ slack: { tables: { exec_slack_installations: [inst({}, true)] } } });
    const ri = await openReadingInstallation(P1);
    expect(ri?.target.userToken).toBe(S.userToken);
    expect(ri?.target).toMatchObject({ teamId: "T0SCALED", userId: "U0MITCH" });
    expect(JSON.stringify(ri)).not.toContain("xoxp-");
    expect(inspect(ri?.target)).not.toContain("xoxp-");
    expect(Object.isFrozen(ri?.target)).toBe(true);
    expect((await openReadingInstallation(P1, INST))?.row.id).toBe(INST);
    expect((await openReadingForSystem(INST))?.target.userToken).toBe(S.userToken);
  });

  it("null unless active, his, holding a token and discovering|ready; a blob sealed for another context throws SecretUnavailableError", async () => {
    const cases: Row[] = [
      inst({ reading_state: "none", user_token_enc: null, user_key_id: null, user_scopes: [], user_installed_at: null, discovered_at: null }),
      inst({ bot_token_enc: null, key_id: null, revoked_at: NOW.toISOString(), revoke_reason: "app_uninstalled" }, true)
    ];
    for (const row of cases) {
      useDb({ slack: { tables: { exec_slack_installations: [row] } } });
      expect(await openReadingInstallation(P1)).toBeNull();
      expect(await openReadingForSystem(INST)).toBeNull();
    }
    useDb({ slack: { tables: { exec_slack_installations: [inst({}, true)] } } });
    expect(await openReadingInstallation(P2, INST)).toBeNull();
    expect(await openReadingInstallation(P1, "esi_bogus")).toBeNull();
    // The bot token's blob in the user column: sealed for another context.
    const bot = sealSecret("xoxb-other", botContext("ep_1"));
    useDb({ slack: { tables: { exec_slack_installations: [inst({ user_token_enc: bot, user_key_id: bot.split(".")[1] }, true)] } } });
    expect(await thrown(openReadingInstallation(P1))).toBeInstanceOf(SecretUnavailableError);
  });
});

describe("ST12 / ST13: health and the user check", () => {
  it("recordUserTokenError / clearUserTokenError: the code sanitized, never throws, logs the id and the code only", async () => {
    useDb({ slack: { tables: { exec_slack_installations: [inst({}, true)] } } });
    await recordUserTokenError(INST, "Token Revoked!");
    expect(db.tables.exec_slack_installations[0]).toMatchObject({ user_last_error_code: "token_revoked_", user_last_error_at: expect.any(String) });
    await clearUserTokenError(INST);
    expect(db.tables.exec_slack_installations[0]).toMatchObject({ user_last_error_code: null, user_last_error_at: null });
    await recordUserTokenError("bad id", S.text);
    useDb({ fail: () => ({ code: "57014", message: S.text }) });
    await expect(recordUserTokenError(INST, "invalid_auth")).resolves.toBeUndefined();
    await expect(clearUserTokenError(INST)).resolves.toBeUndefined();
    expect(out.calls().flat().length).toBeGreaterThan(0);
  });

  it("enqueueUserCheck: kind, bulk, principal null, payload refs only, the hourly key, maxAttempts 3; never throws", async () => {
    await enqueueUserCheck(INST, NOW);
    expect(enqueueJob).toHaveBeenCalledWith({
      kind: "exec.slack-user-check", lane: "bulk", principalId: null, payload: { installation_id: INST, event_time: 1794150000 },
      dedupeKey: `slack-user-check:auth:${INST}:2026110815`, maxAttempts: 3
    });
    vi.mocked(enqueueJob).mockRejectedValue(new Error("down"));
    await expect(enqueueUserCheck(INST, NOW)).resolves.toBeUndefined();
    await expect(enqueueUserCheck("bad", NOW)).resolves.toBeUndefined();
    expect(enqueueJob).toHaveBeenCalledTimes(2);
  });
});

describe("ST14: listRevokedReadingInstallations (N13 / M10: global)", () => {
  it("revoked or bot-revoked rows still holding reading data, any principal, oldest first; purged or never-consented rows not", async () => {
    useDb({ slack: { tables: { exec_slack_installations: [
      inst({ id: `esi_${hex32(3)}`, principal_id: "ep_3", slack_dm_channel_id: "D0C", reading_state: "revoked", user_revoked_at: "2026-11-05T00:00:00.000Z", user_revoke_reason: "stopped" }),
      inst({ id: `esi_${hex32(4)}`, principal_id: "ep_4", slack_dm_channel_id: "D0D", bot_token_enc: null, key_id: null, revoked_at: "2026-11-03T00:00:00.000Z", revoke_reason: "app_uninstalled" }, true),
      inst({ id: `esi_${hex32(5)}`, principal_id: "ep_5", slack_dm_channel_id: "D0E", reading_state: "revoked", user_revoked_at: "2026-11-01T00:00:00.000Z", user_revoke_reason: "stopped", reading_purged_at: "2026-11-01T00:01:00.000Z" }),
      inst({ id: `esi_${hex32(6)}`, principal_id: "ep_6", slack_dm_channel_id: "D0F", bot_token_enc: null, key_id: null, revoked_at: "2026-11-02T00:00:00.000Z", revoke_reason: "disconnected" }),
      inst({}, true)
    ] } } });
    expect(await listRevokedReadingInstallations()).toEqual([`esi_${hex32(4)}`, `esi_${hex32(3)}`]);
    useDb({ missing: ["exec_slack_installations.reading_state"] });
    expect(await listRevokedReadingInstallations()).toEqual([]);
  });
});

describe("ST15: the schema probe, the last reading event, the gate listing", () => {
  it("slackReadingSchemaReady: true; a missing column or table → false; another error throws", async () => {
    expect(await slackReadingSchemaReady()).toBe(true);
    useDb({ missing: ["exec_slack_installations.reading_state"] });
    expect(await slackReadingSchemaReady()).toBe(false);
    useDb({ missing: ["exec_slack_installations"] });
    expect(await slackReadingSchemaReady()).toBe(false);
    useDb({ fail: () => ({ code: "57014", message: "timeout" }) });
    expect(await thrown(slackReadingSchemaReady())).toMatchObject({ op: "slackReadingSchemaReady", pgCode: "57014" });
  });

  it("lastReadingEventAt: the newest ingest / lifecycle row of the installation", async () => {
    useDb({ slack: { tables: { exec_slack_installations: [inst({}, true)], exec_slack_events: [
      { event_id: "Ev0A", installation_id: INST, principal_id: "ep_1", team_id: "T0SCALED", api_app_id: "A0EXEC", event_type: "message", decision: "ingest",
        ingest_outcome: "candidate", event_time: NOW.toISOString(), retry_num: 0, received_at: "2026-11-08T14:00:00.000Z", updated_at: NOW.toISOString() },
      { event_id: "Ev0B", installation_id: INST, principal_id: "ep_1", team_id: "T0SCALED", api_app_id: "A0EXEC", event_type: "message", decision: "reply",
        reply_state: "queued", channel_id: "D0MITCH", message_ts: "1794150000.000100", event_time: NOW.toISOString(), retry_num: 0,
        received_at: "2026-11-08T14:30:00.000Z", updated_at: NOW.toISOString() },
      { event_id: "Ev0C", installation_id: INST, principal_id: "ep_1", team_id: "T0SCALED", api_app_id: "A0EXEC", event_type: "channel_rename", decision: "lifecycle",
        ingest_outcome: "classify", event_time: NOW.toISOString(), retry_num: 0, received_at: "2026-11-08T14:10:00.000Z", updated_at: NOW.toISOString() }
    ] } } });
    expect(await lastReadingEventAt(INST)).toBe("2026-11-08T14:10:00.000Z");
    expect(await lastReadingEventAt(INST_2)).toBeNull();
  });

  it("listGateInstallations: active rows, hasUserToken only (never the token); P6 columns only before the P7a migration", async () => {
    useDb({ slack: { tables: { exec_slack_installations: [
      inst({}, true), inst({ id: INST_2, principal_id: "ep_2", slack_dm_channel_id: "D0JAMES", user_id: "U0JAMES", bot_token_enc: null, key_id: null, revoked_at: NOW.toISOString(), revoke_reason: "disconnected" })
    ] } } });
    const rows = await listGateInstallations();
    expect(rows).toEqual([{ id: INST, principalId: "ep_1", teamId: "T0SCALED", dmChannelId: "D0MITCH", readingState: "ready", discoveredAt: "2026-11-01T01:00:00.000Z", hasUserToken: true }]);
    assertNoSlackText(rows, { label: "gate rows" });
    useDb({ slack: { tables: { exec_slack_installations: [inst()] } }, missing: ["exec_slack_installations.reading_state"] });
    expect(await listGateInstallations()).toEqual([{ id: INST, principalId: "ep_1", teamId: "T0SCALED", dmChannelId: "D0MITCH", readingState: "none", discoveredAt: null, hasUserToken: false }]);
  });
});

describe("ST16: the OAuth state's purpose; the System card's reading row", () => {
  it("issueOAuthState writes purpose only for read; consumeOAuthState answers it (and \"install\" without the column), single use", async () => {
    await issueOAuthState(P1, { nonceHash: H1, authUserId: "auth-m", sessionId: "sess-1", ttlSeconds: 600, purpose: "read" });
    const insert = db.calls.find((c) => c.kind === "insert");
    expect((insert?.payload as Row).purpose).toBe("read");
    expect(await consumeOAuthState(H1)).toMatchObject({ principalId: "ep_1", purpose: "read" });
    expect(await consumeOAuthState(H1)).toBeNull();
    await issueOAuthState(P1, { nonceHash: H1, authUserId: "auth-m", sessionId: "sess-1", ttlSeconds: 600 });
    expect(Object.keys(db.calls.filter((c) => c.kind === "insert").at(-1)?.payload as Row)).not.toContain("purpose");
    expect(await consumeOAuthState(H1)).toMatchObject({ purpose: "install" });
    await issueOAuthState(P1, { nonceHash: H1, authUserId: "auth-m", sessionId: "sess-1", ttlSeconds: 600, purpose: "install" });
    expect(Object.keys(db.calls.filter((c) => c.kind === "insert").at(-1)?.payload as Row)).not.toContain("purpose");
    await expect(issueOAuthState(P1, { nonceHash: H1, authUserId: "a", sessionId: "s", ttlSeconds: 60, purpose: "bogus" as never })).rejects.toBeInstanceOf(TypeError);
    // Before the P7a migration: no purpose column. The read of it fails without consuming; P6's delete still consumes once.
    useDb({ missing: ["exec_oauth_states.purpose"] });
    await issueOAuthState(P1, { nonceHash: H1, authUserId: "auth-m", sessionId: "sess-1", ttlSeconds: 600 });
    expect(await consumeOAuthState(H1)).toMatchObject({ principalId: "ep_1", purpose: "install" });
    expect(await consumeOAuthState(H1)).toBeNull();
    const deletes = db.calls.filter((c) => c.kind === "delete" && c.target === "exec_oauth_states" && c.columns !== null);
    expect(deletes.every((c) => c.columns === "principal_id,auth_user_id,session_id,expires_at")).toBe(true);
    // A read state can't be issued before the migration (PGRST204: the start route answers not_installed first).
    expect(await thrown(issueOAuthState(P1, { nonceHash: H1, authUserId: "a", sessionId: "s", ttlSeconds: 60, purpose: "read" }))).toMatchObject({ pgCode: "PGRST204" });
  });

  it("slackSystemSummary.reading: on / paused / discovering / error / revoked; nothing before consent, without a bot or the P7a schema; v2Missing within the hour", async () => {
    const settings = (on: boolean) => ({ principal_id: "ep_1", slack_reading_enabled: on, slack_daily_cap_usd: 2, watch_mode: "member_only", updated_at: NOW.toISOString() });
    useDb({ slack: { tables: { exec_slack_installations: [inst({}, true)] } }, tables: { exec_settings: [settings(true)] } });
    expect((await slackSystemSummary(P1))?.reading).toEqual({ state: "on", lastEventAt: null, lastSweepAt: null, blockedMethods: 0, pendingTriage: 0, userErrorCode: null, v2Missing: false });
    db.tables.exec_settings[0].slack_reading_enabled = false;
    expect((await slackSystemSummary(P1))?.reading?.state).toBe("paused");
    db.tables.exec_slack_installations[0].discovered_at = null;
    db.tables.exec_slack_installations[0].reading_state = "discovering";
    expect((await slackSystemSummary(P1))?.reading?.state).toBe("discovering");
    db.tables.exec_slack_installations[0].user_last_error_code = "token_revoked";
    db.tables.exec_slack_installations[0].user_last_error_at = NOW.toISOString();
    expect((await slackSystemSummary(P1))?.reading).toMatchObject({ state: "error", userErrorCode: "token_revoked" });
    vi.mocked(v2MissingWithSchemaAt).mockReturnValue(Date.now() - 60_000);
    expect((await slackSystemSummary(P1))?.reading?.v2Missing).toBe(true);
    vi.mocked(v2MissingWithSchemaAt).mockReturnValue(Date.now() - 2 * 3_600_000);
    expect((await slackSystemSummary(P1))?.reading?.v2Missing).toBe(false);
    useDb({ slack: { tables: { exec_slack_installations: [inst({ reading_state: "revoked", user_revoked_at: NOW.toISOString(), user_revoke_reason: "stopped" })] } }, tables: { exec_settings: [settings(true)] } });
    const stopped = (await slackSystemSummary(P1))?.reading;
    expect(stopped?.state).toBe("revoked");
    // Integrator (§3.20.4 "Stopped {date}"): the revoked summary carries the date.
    expect(Date.parse(String(stopped?.revokedAt))).toBe(NOW.getTime());
    useDb({ slack: { tables: { exec_slack_installations: [inst()] } } });
    const none = await slackSystemSummary(P1);
    expect(none).toEqual({ state: "connected", lastDmAt: null, lastErrorCode: null, revokedAt: null });
    useDb({ slack: { tables: { exec_slack_installations: [inst()] } }, missing: ["exec_slack_installations.reading_state"] });
    expect(await slackSystemSummary(P1)).toEqual({ state: "connected", lastDmAt: null, lastErrorCode: null, revokedAt: null });
    useDb();
    expect(await slackSystemSummary(P1)).toEqual({ state: "not_connected", lastDmAt: null, lastErrorCode: null, revokedAt: null });
  });
});
