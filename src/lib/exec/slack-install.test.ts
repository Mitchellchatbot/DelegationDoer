import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/jobs", () => ({ enqueueJob: vi.fn() }));

import { ROUTING_INSTALLATION as RI, SENTINELS, findSentinel } from "@/lib/exec/__tests__/slack-assert";
import { createFakeSlackDb, type FakeSlackDb, type FakeSlackDbSeed, type Row } from "@/lib/exec/__tests__/fake-slack-db";
import { SecretUnavailableError, sealSecret } from "@/lib/exec/crypto";
import { enqueueJob } from "@/lib/exec/jobs";
import {
  SlackStoreError,
  acceptAction,
  __resetAcceptActionV2ForTests,
  acceptEvent,
  clearSlackError,
  consumeOAuthState,
  conversationForThread,
  deleteExpiredOAuthStates,
  deleteOldSlackEvents,
  deleteSlackPostRecord,
  enqueueRevokeCheck,
  findAnswerBySlackTs,
  getActiveInstallation,
  getInstallationForSystem,
  getLatestInstallation,
  isSlackSchemaMissing,
  issueOAuthState,
  listCardPostsForMessage,
  listOldSlackPosts,
  listOpenReplies,
  listRedactionFollowups,
  listUnpurgedRevokedInstallations,
  markPostFollowed,
  openActiveInstallation,
  openInstallationById,
  openInstallationForSystem,
  purgeInstallation,
  recordChatFeedback,
  recordSlackError,
  recordSlackPost,
  replyStep,
  resetPostFollowed,
  revokeInstallation,
  saveInstallation,
  slackSchemaReady,
  slackSystemSummary,
  type NewInstallation
} from "@/lib/exec/slack-install";
import type { SlackActionFacts, SlackEventFacts } from "@/lib/exec/slack-types";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P6 contract §3.7 (Area A): slack-install.ts against fake-slack-db.ts (ST01-ST14, numbered in
// §5.9's order: ST01-ST03 saveInstallation, ST04 identical key sets, ST05 / ST06 opening (context,
// wrong-principal blob), ST07 schema detection, ST08 the acks' error mapping, ST09 consumeOAuthState,
// ST10 recordSlackError, ST11 findAnswerBySlackTs, ST12 recordChatFeedback and listOpenReplies),
// and RT-F: the fake's routing rule against the shared fixture, whose SQL half is
// RT-S in the scratch SQL suite (same rows, same expectations), so neither can drift.

const KEY = Buffer.alloc(32, 0xa1).toString("base64");
const hex32 = (n: number) => n.toString(16).padStart(32, "0");
const INST = `esi_${hex32(1)}`;
const INST_2 = `esi_${hex32(2)}`;
const MSG_ID = (n: number) => `ecm_${hex32(n)}`;
const CONV_ID = (n: number) => `ecv_${hex32(n)}`;
const principal = (id = "ep_1") => Object.freeze({ id, userId: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", timezone: "UTC",
  mailAccountIds: [], slackTeamId: null, slackUserId: null }) as unknown as ExecPrincipal;
const P1 = principal("ep_1");
const P2 = principal("ep_2");
const context = (pid: string) => `exec_slack_installations.bot_token:${pid}`;

let db: FakeSlackDb;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

function useDb(seed?: FakeSlackDbSeed): FakeSlackDb {
  db = createFakeSlackDb(seed);
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}

/** An installation row as the migration stores it (snake_case), sealed for its principal. */
function installation(over: Row = {}): Row {
  const principalId = (over.principal_id as string | undefined) ?? "ep_1";
  const token = (over.token as string | undefined) ?? SENTINELS.token;
  const sealed = sealSecret(token, context((over.sealed_for as string | undefined) ?? principalId));
  const row: Row = {
    id: INST, principal_id: principalId, team_id: RI.teamId, app_id: RI.appId, bot_user_id: RI.botUserId, bot_id: RI.botId,
    bot_token_enc: sealed, key_id: sealed.split(".")[1], bot_scopes: ["chat:write", "im:history", "im:read", "im:write", "users:read", "users:read.email"],
    user_id: RI.userId, user_token_enc: null, user_scopes: [], slack_dm_channel_id: RI.dmChannelId, installed_at: RI.installedAt,
    updated_at: RI.installedAt, revoked_at: null, revoke_reason: null, last_dm_at: null, last_error_code: null, last_error_at: null, purged_at: null,
    ...over
  };
  delete row.token;
  delete row.sealed_for;
  return row;
}
const revoked = (over: Row = {}) =>
  installation({ bot_token_enc: null, key_id: null, revoked_at: "2026-11-02T00:00:00.000Z", revoke_reason: "app_uninstalled", purged_at: "2026-11-02T00:05:00.000Z", ...over });

/** What a log line, an error or a result may never hold (§0.3 rule 4). */
function expectNoLeaks(...values: unknown[]) {
  expect(findSentinel([...values, errorSpy.mock.calls, warnSpy.mock.calls, logSpy.mock.calls])).toBeNull();
}

async function thrown(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  vi.stubEnv("EXEC_TOKEN_KEY", KEY);
  vi.stubEnv("EXEC_TOKEN_KEY_PREVIOUS", undefined);
  vi.mocked(getSupabaseAdmin).mockReset();
  vi.mocked(enqueueJob).mockReset();
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 41 });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  useDb();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

const NEW: NewInstallation = (() => {
  const sealed = "v1.0123abcd.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.CCCCCCCC";
  return {
    teamId: RI.teamId, appId: RI.appId, botUserId: RI.botUserId, botId: RI.botId, botTokenSealed: sealed, keyId: "0123abcd",
    botScopes: ["chat:write", "im:history", "im:read", "im:write", "users:read", "users:read.email"], userId: RI.userId, dmChannelId: RI.dmChannelId
  };
})();

describe("saveInstallation (K5 upsert)", () => {
  it("ST01: updates the principal's active row in place (token, key, scopes, ids, DM, installed_at = updated_at = now, last_error_* cleared) -> replaced", async () => {
    useDb({ tables: { exec_slack_installations: [installation({ last_error_code: "invalid_auth", last_error_at: "2026-11-02T00:00:00.000Z", slack_dm_channel_id: "D0OLDDM" })] } });
    const before = Date.now();
    const r = await saveInstallation(P1, { ...NEW, botScopes: ["chat:write"] });
    expect(r).toEqual({ id: INST, replaced: true });
    const [row] = db.tables.exec_slack_installations;
    expect(row).toMatchObject({ bot_token_enc: NEW.botTokenSealed, key_id: "0123abcd", bot_scopes: ["chat:write"], slack_dm_channel_id: RI.dmChannelId,
      last_error_code: null, last_error_at: null, revoked_at: null });
    expect(Date.parse(String(row.installed_at))).toBeGreaterThanOrEqual(before);
    expect(row.installed_at).toBe(row.updated_at);
    expect(db.calls.map((c) => `${c.kind} ${c.target}`)).toEqual(["update exec_slack_installations"]);
    expect(db.calls[0].filters).toEqual([{ op: "eq", column: "principal_id", value: "ep_1" }, { op: "is", column: "revoked_at", value: null }]);
  });

  it("ST02 / ST04: inserts when he has no active row (a revoked one stays as the record) -> not replaced; the insert's key set is the update's plus principal_id (identical key sets)", async () => {
    useDb({ tables: { exec_slack_installations: [revoked({ id: INST_2 })] } });
    const r = await saveInstallation(P1, NEW);
    expect(r.replaced).toBe(false);
    expect(r.id).toMatch(/^esi_[0-9a-f]{32}$/);
    expect(db.tables.exec_slack_installations).toHaveLength(2);
    const [update, insert] = db.calls;
    expect([update.kind, insert.kind]).toEqual(["update", "insert"]);
    const updateKeys = Object.keys(update.payload as Row).sort();
    expect(Object.keys(insert.payload as Row).sort()).toEqual([...updateKeys, "principal_id"].sort());
    expect(updateKeys).toEqual(["app_id", "bot_id", "bot_scopes", "bot_token_enc", "bot_user_id", "installed_at", "key_id", "last_error_at", "last_error_code",
      "slack_dm_channel_id", "team_id", "updated_at", "user_id"]);
    expect(db.tables.exec_slack_installations.find((i) => i.id === r.id)).toMatchObject({ principal_id: "ep_1", user_token_enc: null, user_scopes: [] });
  });

  it("ST03: a 23505 on exec_slack_installations_active_key (a concurrent install) re-runs the update once -> replaced", async () => {
    let raced = false;
    useDb({
      before: (call, fake) => {
        if (call.kind === "insert" && !raced) {
          raced = true;
          fake.tables.exec_slack_installations.push(installation({ id: INST_2 }));
        }
      }
    });
    expect(await saveInstallation(P1, NEW)).toEqual({ id: INST_2, replaced: true });
    expect(db.calls.map((c) => c.kind)).toEqual(["update", "insert", "update"]);
    expect(db.tables.exec_slack_installations).toHaveLength(1);
    expect(db.tables.exec_slack_installations[0].bot_token_enc).toBe(NEW.botTokenSealed);
  });

  it("ST03: a 23505 that isn't his (the DM channel active under another principal) throws SlackStoreError after the one retry", async () => {
    useDb({ tables: { exec_slack_installations: [installation({ id: INST_2, principal_id: "ep_2" })] } });
    const err = await thrown(saveInstallation(P1, NEW));
    expect(err).toBeInstanceOf(SlackStoreError);
    expect(err).toMatchObject({ op: "saveInstallation", pgCode: "23505", message: "exec slack store: saveInstallation failed (23505)" });
    expect(db.calls.map((c) => c.kind)).toEqual(["update", "insert", "update"]);
  });

  it("refuses a plaintext token, a key id that isn't the blob's, malformed ids or scopes before any database call (TypeError, no value in the message)", async () => {
    const cases: Partial<NewInstallation>[] = [
      { botTokenSealed: SENTINELS.token }, { botTokenSealed: "v1.0123abcd.A.B" }, { keyId: "deadbeef" }, { teamId: "X0" }, { appId: "a0" }, { botUserId: "B0" },
      { botId: "U0BOT" }, { userId: "mitch" }, { dmChannelId: "C0GENERAL" }, { botScopes: ["chat:write", "bad scope"] },
      { botScopes: Array.from({ length: 51 }, (_, i) => `s${i}`) }
    ];
    for (const over of cases) {
      const err = await thrown(saveInstallation(P1, { ...NEW, ...over }));
      expect(err, JSON.stringify(over)).toBeInstanceOf(TypeError);
      expect(findSentinel(err)).toBeNull();
    }
    expect(db.calls).toEqual([]);
  });
});

describe("opening an installation (the token stays inside)", () => {
  it("ST05: openActiveInstallation opens with exec_slack_installations.bot_token:<principalId>; the row carries hasToken, never the blob; the target's JSON / inspect forms omit the token", async () => {
    useDb({ tables: { exec_slack_installations: [installation()] } });
    const open = await openActiveInstallation(P1);
    expect(open).not.toBeNull();
    expect(open?.target.token).toBe(SENTINELS.token);
    expect(open?.target.dmChannelId).toBe(RI.dmChannelId);
    expect(open?.row).toMatchObject({ id: INST, principalId: "ep_1", hasToken: true, dmChannelId: RI.dmChannelId, botId: RI.botId, userId: RI.userId });
    expect(Object.keys(open?.row ?? {})).not.toContain("botTokenEnc");
    expect(JSON.stringify(open?.row)).not.toContain("v1.");
    expect(JSON.stringify(open)).not.toContain("xoxb-");
    const { inspect } = await import("node:util");
    expect(inspect(open?.target)).not.toContain("xoxb-");
    expect(Object.isFrozen(open?.target)).toBe(true);
    const row = await getActiveInstallation(P1);
    expect(row).toEqual(open?.row);
    expect(findSentinel(row)).toBeNull();
  });

  it("ST06: a blob sealed for another principal (copied into his row) fails to open: SecretUnavailableError auth_failed", async () => {
    useDb({ tables: { exec_slack_installations: [installation({ sealed_for: "ep_2" })] } });
    const err = await thrown(openActiveInstallation(P1));
    expect(err).toBeInstanceOf(SecretUnavailableError);
    expect((err as SecretUnavailableError).reason).toBe("auth_failed");
    const sealedEarlier = installation();
    vi.stubEnv("EXEC_TOKEN_KEY", undefined);
    useDb({ tables: { exec_slack_installations: [sealedEarlier] } });
    // (sealed before the key went away)
    expect(((await thrown(openActiveInstallation(P1))) as SecretUnavailableError).reason).toBe("not_configured");
  });

  it("ST05: openInstallationById: his active row opens; another principal's, a revoked one, a token-less one or a malformed id -> null (no call for the id)", async () => {
    useDb({ tables: { exec_slack_installations: [installation(), installation({ id: INST_2, principal_id: "ep_2", slack_dm_channel_id: "D0JAMES", user_id: "U0JAMES" })] } });
    expect((await openInstallationById(P1, INST))?.row.id).toBe(INST);
    expect(await openInstallationById(P1, INST_2)).toBeNull();
    expect(await openInstallationById(P2, INST)).toBeNull();
    expect((await openInstallationById(P2, INST_2))?.target.dmChannelId).toBe("D0JAMES");
    const calls = db.calls.length;
    expect(await openInstallationById(P1, "esi_nope")).toBeNull();
    expect(db.calls.length).toBe(calls);
    useDb({ tables: { exec_slack_installations: [revoked({ bot_token_enc: installation().bot_token_enc, key_id: installation().key_id, purged_at: null })] } });
    expect(await openInstallationById(P1, INST)).toBeNull();
    expect(await openActiveInstallation(P1)).toBeNull();
    expect(await openInstallationForSystem(INST)).toBeNull();
    useDb({ tables: { exec_slack_installations: [revoked()] } });
    expect(await openInstallationForSystem(INST)).toBeNull();
    expect(await getInstallationForSystem(INST)).toMatchObject({ id: INST, hasToken: false, revokeReason: "app_uninstalled", purgedAt: "2026-11-02T00:05:00.000Z" });
    expect(await getInstallationForSystem("nope")).toBeNull();
  });

  it("ST05: openInstallationForSystem opens by id without a principal, with the row's own principal as the context", async () => {
    useDb({ tables: { exec_slack_installations: [installation({ id: INST_2, principal_id: "ep_2", slack_dm_channel_id: "D0JAMES" })] } });
    const open = await openInstallationForSystem(INST_2);
    expect(open?.target).toMatchObject({ token: SENTINELS.token, dmChannelId: "D0JAMES" });
    expect(open?.row.principalId).toBe("ep_2");
  });

  it("getLatestInstallation is the newest by installed_at in any state; slackSystemSummary maps the states (null = schema missing)", async () => {
    useDb();
    expect(await getLatestInstallation(P1)).toBeNull();
    expect(await slackSystemSummary(P1)).toEqual({ state: "not_connected", lastDmAt: null, lastErrorCode: null, revokedAt: null });
    useDb({ tables: { exec_slack_installations: [revoked({ id: INST_2, installed_at: "2026-10-01T00:00:00.000Z" }), revoked({ installed_at: "2026-10-20T00:00:00.000Z", slack_dm_channel_id: "D0B" })] } });
    expect((await getLatestInstallation(P1))?.id).toBe(INST);
    expect(await getActiveInstallation(P1)).toBeNull();
    expect(await slackSystemSummary(P1)).toEqual({ state: "revoked", lastDmAt: null, lastErrorCode: null, revokedAt: "2026-11-02T00:00:00.000Z" });
    useDb({ tables: { exec_slack_installations: [installation({ last_dm_at: "2026-11-06T10:00:00.000Z" })] } });
    expect(await slackSystemSummary(P1)).toEqual({ state: "connected", lastDmAt: "2026-11-06T10:00:00.000Z", lastErrorCode: null, revokedAt: null });
    useDb({ tables: { exec_slack_installations: [installation({ last_error_code: "invalid_auth", last_error_at: "2026-11-06T10:00:00.000Z" })] } });
    expect(await slackSystemSummary(P1)).toMatchObject({ state: "error", lastErrorCode: "invalid_auth" });
    useDb({ missing: ["exec_slack_installations"] });
    expect(await slackSystemSummary(P1)).toBeNull();
    const err = await thrown(getActiveInstallation(P1));
    expect(err).toMatchObject({ op: "getActiveInstallation", pgCode: "PGRST205" });
    expect(isSlackSchemaMissing(err)).toBe(true);
    useDb({ fail: () => ({ code: "57014", message: "canceling statement due to statement timeout" }) });
    await expect(slackSystemSummary(P1)).rejects.toMatchObject({ pgCode: "57014" });
  });
});

describe("schema detection", () => {
  it("ST07: isSlackSchemaMissing: 42P01 / PGRST205 (table) and 42883 / PGRST202 (function) -> true, on raw errors and on SlackStoreError; anything else -> false", () => {
    for (const code of ["42P01", "PGRST205", "42883", "PGRST202"]) {
      expect(isSlackSchemaMissing({ code, message: "x" }), code).toBe(true);
      expect(isSlackSchemaMissing(new SlackStoreError("op", code)), code).toBe(true);
    }
    for (const v of [{ code: "23505" }, { code: "PGRST116" }, new SlackStoreError("op", null), new SlackStoreError("op", "57014"), new Error("42P01"), null, undefined, "42P01", { code: 42 }]) {
      expect(isSlackSchemaMissing(v), JSON.stringify(v)).toBe(false);
    }
  });

  it("ST07: slackSchemaReady: a plain read with limit 0 -> true; the table missing -> false; any other error throws", async () => {
    expect(await slackSchemaReady()).toBe(true);
    expect(db.calls[0]).toMatchObject({ kind: "select", target: "exec_slack_installations", columns: "id", limit: 0 });
    expect(db.calls[0].options?.head).toBeUndefined();
    useDb({ missing: ["exec_slack_installations"] });
    expect(await slackSchemaReady()).toBe(false);
    useDb({ fail: () => ({ code: "42P01", message: 'relation "public.exec_slack_installations" does not exist' }) });
    expect(await slackSchemaReady()).toBe(false);
    useDb({ fail: () => ({ code: "08006", message: "connection failure" }) });
    await expect(slackSchemaReady()).rejects.toMatchObject({ op: "slackSchemaReady", pgCode: "08006" });
  });
});

// ---------------------------------------------------------------------------

const FACTS = (over: Partial<SlackEventFacts> = {}): SlackEventFacts => ({
  eventId: "Ev0STORE01", teamId: RI.teamId, apiAppId: RI.appId, eventType: "message", eventTime: 1793977301, retryNum: 0, channel: RI.dmChannelId,
  channelType: "im", user: RI.userId, ts: "1793977301.000101", threadTs: null, hasBotId: false, hasAppId: false, subtype: null, hidden: false,
  textIsString: true, hasMessage: false, tab: null, revokedBotIds: [], revokedUserIds: [], ...over
});
const ACTION = (over: Partial<SlackActionFacts> = {}): SlackActionFacts => ({
  teamId: RI.teamId, apiAppId: RI.appId, userId: RI.userId, triggerId: "1793977301.111.222", actionId: "ea_fb_up", value: `f1.${MSG_ID(9)}`,
  containerType: "message", channelId: RI.dmChannelId, messageTs: "1793977301.000101", ...over
});

describe("the acks (RPCs 1 and 2)", () => {
  it("ST08: acceptEvent sends exactly the 20 RPC parameters from the facts, on the route's signal, and maps the answer", async () => {
    useDb({ tables: { exec_slack_installations: [installation()] } });
    const signal = new AbortController().signal;
    const r = await acceptEvent(FACTS(), { signal });
    expect(r).toEqual({ outcome: "accepted", decision: "reply", reason: null, enqueued: true, interactive: true });
    const call = db.calls[0];
    expect(call).toMatchObject({ kind: "rpc", target: "exec_slack_accept_event", signal });
    expect(Object.keys(call.payload as Row).sort()).toEqual([
      "p_api_app_id", "p_channel", "p_channel_type", "p_event_id", "p_event_time", "p_event_type", "p_has_app_id", "p_has_bot_id", "p_has_message",
      "p_hidden", "p_retry_num", "p_revoked_bot_ids", "p_revoked_user_ids", "p_subtype", "p_tab", "p_team_id", "p_text_is_string", "p_thread_ts", "p_ts", "p_user"
    ]);
    expect(await acceptEvent(FACTS(), { signal })).toEqual({ outcome: "duplicate" });
    expect(db.calls).toHaveLength(2);
  });

  it("ST08: PGRST202 (the RPC missing) and a missing table -> not_installed; any other error throws SlackStoreError (code only, no content)", async () => {
    const signal = new AbortController().signal;
    useDb({ missing: ["exec_slack_accept_event"] });
    expect(await acceptEvent(FACTS(), { signal })).toEqual({ outcome: "not_installed" });
    useDb({ fail: () => ({ code: "42P01", message: "relation does not exist" }) });
    expect(await acceptEvent(FACTS(), { signal })).toEqual({ outcome: "not_installed" });
    useDb({ fail: () => ({ code: "P0001", message: `exec_slack_accept_event: ${SENTINELS.text}`, details: SENTINELS.text }) });
    const err = await thrown(acceptEvent(FACTS(), { signal }));
    expect(err).toBeInstanceOf(SlackStoreError);
    expect(err).toMatchObject({ op: "acceptEvent", pgCode: "P0001", message: "exec slack store: acceptEvent failed (P0001)" });
    expectNoLeaks(err);
    useDb({ fail: () => ({ code: "", message: "TypeError: fetch failed" }) });
    expect(await thrown(acceptEvent(FACTS(), { signal }))).toMatchObject({ op: "acceptEvent", pgCode: null });
  });

  it("ST08: a slow database loses to the route's controller: the abort reason is thrown, not an answer", async () => {
    vi.useFakeTimers();
    try {
      useDb({ tables: { exec_slack_installations: [installation()] }, before: () => new Promise((r) => setTimeout(r, 5_000)) });
      const controller = new AbortController();
      const pending = thrown(acceptEvent(FACTS(), { signal: controller.signal }));
      setTimeout(() => controller.abort(new DOMException("ack timeout", "TimeoutError")), 2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      const err = await pending;
      expect((err as DOMException).name).toBe("TimeoutError");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ST08: a malformed RPC answer throws instead of guessing", async () => {
    const signal = new AbortController().signal;
    useDb();
    (db.client as { rpc: unknown }).rpc = () => ({ abortSignal: () => ({ then: (f: (v: unknown) => unknown) => Promise.resolve({ data: { outcome: "accepted", decision: "maybe" }, error: null }).then(f) }) });
    await expect(acceptEvent(FACTS(), { signal })).rejects.toMatchObject({ op: "acceptEvent: malformed answer" });
  });

  it("acceptAction: maps enqueued / duplicate / ignored, the RPC missing -> not_installed, other errors -> SlackStoreError", async () => {
    const signal = new AbortController().signal;
    useDb({ tables: { exec_slack_installations: [installation()] } });
    expect(await acceptAction(ACTION(), { signal })).toEqual({ outcome: "enqueued" });
    expect(await acceptAction(ACTION(), { signal })).toEqual({ outcome: "duplicate" });
    expect(await acceptAction(ACTION({ userId: "U0JANE", triggerId: "t.2" }), { signal })).toEqual({ outcome: "ignored", reason: "not_owner" });
    expect(Object.keys(db.calls[0].payload as Row).sort()).toEqual(["p_action_id", "p_api_app_id", "p_channel_id", "p_container_type", "p_message_ts", "p_team_id", "p_trigger_id", "p_user_id", "p_value"]);
    expect(db.tables.exec_jobs).toHaveLength(1);
    expect(db.tables.exec_jobs[0]).toMatchObject({ kind: "exec.slack-action", lane: "interactive", max_attempts: 1, principal_id: "ep_1",
      payload: { installation_id: INST, action_id: "ea_fb_up", value: `f1.${MSG_ID(9)}`, channel_id: RI.dmChannelId, message_ts: "1793977301.000101" } });
    // P8 (C43): acceptAction calls exec_slack_accept_action_v2 first and P6's RPC when v2 is missing: not installed = both missing.
    useDb({ missing: ["exec_slack_accept_action", "exec_slack_accept_action_v2"] });
    expect(await acceptAction(ACTION(), { signal })).toEqual({ outcome: "not_installed" });
    __resetAcceptActionV2ForTests();
    useDb({ fail: () => ({ code: "53300", message: "too many connections" }) });
    await expect(acceptAction(ACTION(), { signal })).rejects.toMatchObject({ op: "acceptAction", pgCode: "53300" });
  });
});

// ---------------------------------------------------------------------------
// RT-F: the fake's routing rule on every fixture row (the SQL half is RT-S)

type RoutingRow = { name: string; envelope: Row; installation: "owner" | "revoked" | null; expect: { routeLevel?: string; decision?: string; reason?: string | null } };

/** The route's facts for one envelope (§2.1.6's parameter comments); the same extraction as the SQL suite's factsOf. */
function factsOf(env: Row): SlackEventFacts {
  const e = (typeof env.event === "object" && env.event !== null ? env.event : {}) as Row;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  const present = (k: string) => Object.prototype.hasOwnProperty.call(e, k) && e[k] !== undefined && e[k] !== null;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const tokens = (typeof e.tokens === "object" && e.tokens !== null ? e.tokens : {}) as Row;
  return {
    eventId: String(env.event_id), teamId: String(env.team_id), apiAppId: String(env.api_app_id), eventType: s(e.type) ?? "", eventTime: Number(env.event_time),
    retryNum: 0, channel: s(e.channel), channelType: s(e.channel_type), user: s(e.user), ts: s(e.ts), threadTs: s(e.thread_ts),
    hasBotId: present("bot_id") || present("bot_profile"), hasAppId: present("app_id"), subtype: present("subtype") ? String(e.subtype) : null,
    hidden: e.hidden === true, textIsString: typeof e.text === "string", hasMessage: present("message") || present("previous_message"), tab: s(e.tab),
    revokedBotIds: ids(tokens.bot), revokedUserIds: ids(tokens.oauth)
  };
}

describe("RT-F: fake-slack-db's RPC 1 against the routing fixture", () => {
  const rows = JSON.parse(readFileSync(new URL("./__tests__/fixtures/slack-routing.json", import.meta.url), "utf8")) as RoutingRow[];

  it("the fixture is the shared one: 35 rows, every decision, and ROUTING_INSTALLATION's installed_at splits the stale rows from the live ones", () => {
    expect(rows).toHaveLength(35);
    expect(new Set(rows.filter((r) => r.expect.decision).map((r) => r.expect.decision))).toEqual(new Set(["reply", "home", "revoke", "revoke_check", "drop"]));
    for (const r of rows.filter((x) => typeof x.envelope.event_time === "number")) {
      if (r.expect.reason === "stale_revoke") expect(Number(r.envelope.event_time)).toBeLessThan(RI.installedAtEpochSec);
      else expect(Number(r.envelope.event_time)).toBeGreaterThan(RI.installedAtEpochSec);
    }
  });

  for (const row of rows) {
    it(`RT-F ${row.name}`, async () => {
      if (row.expect.routeLevel) {
        // Dropped by the route before any database call; the fake never sees it.
        expect(["wrong_app", "wrong_team", "disabled", "other_type"]).toContain(row.expect.routeLevel);
        return;
      }
      const seeded = row.installation === "owner" ? [installation()] : row.installation === "revoked" ? [revoked()] : [];
      useDb({ tables: { exec_slack_installations: seeded } });
      const facts = factsOf(row.envelope);
      const r = await acceptEvent(facts, { signal: new AbortController().signal });
      expect(r).toMatchObject({ outcome: "accepted", decision: row.expect.decision, reason: row.expect.reason ?? null });
      const [ev] = db.tables.exec_slack_events;
      expect(ev).toMatchObject({ event_id: facts.eventId, decision: row.expect.decision, drop_reason: row.expect.reason ?? null });
      const found = row.installation === "owner" && (facts.eventType !== "message" || facts.channel === RI.dmChannelId);
      expect(ev.slack_user_id, "C47: only the owner's own id").toBe(found && facts.user === RI.userId ? RI.userId : null);
      const jobs = db.tables.exec_jobs;
      if (row.expect.decision === "reply") {
        expect(jobs.map((j) => [j.kind, j.lane, j.max_attempts, j.dedupe_key])).toEqual([["exec.slack-reply", "interactive", 1, `slack-reply:${facts.eventId}`]]);
        expect(jobs[0].payload).toEqual({ event_id: facts.eventId, installation_id: INST, channel: facts.channel, ts: facts.ts, thread_ts: facts.threadTs, event_time: facts.eventTime });
        expect(ev).toMatchObject({ reply_state: "queued", job_id: jobs[0].id, installation_id: INST, principal_id: "ep_1" });
      } else if (row.expect.decision === "home") {
        expect(jobs.map((j) => [j.kind, j.lane, j.max_attempts])).toEqual([["exec.slack-home", "interactive", 2]]);
        expect(jobs[0].payload).toEqual({ installation_id: INST, slack_user_id: facts.user });
      } else if (row.expect.decision === "revoke") {
        expect(jobs.map((j) => [j.kind, j.lane, j.principal_id, j.max_attempts, j.dedupe_key])).toEqual([["exec.slack-uninstall", "bulk", null, 6, `slack-uninstall:${INST}`]]);
        expect(db.tables.exec_slack_installations[0].revoke_reason).toBe("app_uninstalled");
      } else if (row.expect.decision === "revoke_check") {
        expect(jobs.map((j) => [j.kind, j.lane, j.max_attempts, j.dedupe_key])).toEqual([["exec.slack-uninstall", "bulk", 3, `slack-revoke-check:${facts.eventId}:${INST}`]]);
        expect(db.tables.exec_slack_installations[0].revoked_at).toBeNull();
      } else {
        expect(jobs).toEqual([]);
      }
    });
  }

  it("RT-F: a null boolean fact fails closed in the fake as in the SQL", async () => {
    useDb({ tables: { exec_slack_installations: [installation()] } });
    const cases: [Partial<SlackEventFacts>, string][] = [[{ hasBotId: null as unknown as boolean }, "bot_message"], [{ hasAppId: null as unknown as boolean }, "app_message"],
      [{ hidden: null as unknown as boolean }, "hidden"], [{ textIsString: null as unknown as boolean }, "no_text"], [{ hasMessage: null as unknown as boolean }, "nested_message"]];
    let n = 0;
    for (const [over, reason] of cases) {
      n += 1;
      expect(await acceptEvent(FACTS({ ...over, eventId: `Ev0NULL${n}` }), { signal: new AbortController().signal })).toMatchObject({ decision: "drop", reason });
    }
  });
});

// ---------------------------------------------------------------------------

describe("OAuth states (C1)", () => {
  const H1 = "a".repeat(64);
  const H2 = "b".repeat(64);

  it("issueOAuthState deletes his other Slack states and every expired one, then inserts with a TTL the CHECK accepts", async () => {
    const now = Date.now();
    useDb({
      tables: {
        exec_oauth_states: [
          { nonce_hash: "c".repeat(64), provider: "slack", principal_id: "ep_1", auth_user_id: "a", session_id: "s", created_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 60_000).toISOString() },
          { nonce_hash: "d".repeat(64), provider: "slack", principal_id: "ep_2", auth_user_id: "a", session_id: "s", created_at: new Date(now - 700_000).toISOString(), expires_at: new Date(now - 100_000).toISOString() },
          { nonce_hash: "e".repeat(64), provider: "slack", principal_id: "ep_2", auth_user_id: "a", session_id: "s", created_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 60_000).toISOString() }
        ]
      }
    });
    await issueOAuthState(P1, { nonceHash: H1, authUserId: "auth-m", sessionId: "sess-1", ttlSeconds: 600 });
    expect(db.tables.exec_oauth_states.map((s) => s.nonce_hash).sort()).toEqual([H1, "e".repeat(64)]);
    const row = db.tables.exec_oauth_states.find((s) => s.nonce_hash === H1) as Row;
    expect(row).toMatchObject({ provider: "slack", principal_id: "ep_1", auth_user_id: "auth-m", session_id: "sess-1" });
    expect(Date.parse(String(row.expires_at)) - Date.parse(String(row.created_at))).toBe(600_000);
    expect(db.calls.map((c) => `${c.kind} ${c.target}`)).toEqual(["delete exec_oauth_states", "delete exec_oauth_states", "insert exec_oauth_states"]);
    for (const bad of [{ nonceHash: "A".repeat(64) }, { nonceHash: "a".repeat(63) }, { authUserId: "" }, { sessionId: "s".repeat(129) }, { ttlSeconds: 601 }, { ttlSeconds: 0 }, { ttlSeconds: 1.5 }]) {
      await expect(issueOAuthState(P1, { nonceHash: H2, authUserId: "a", sessionId: "s", ttlSeconds: 60, ...bad }), JSON.stringify(bad)).rejects.toBeInstanceOf(TypeError);
    }
    useDb({ missing: ["exec_oauth_states"] });
    const err = await thrown(issueOAuthState(P1, { nonceHash: H1, authUserId: "a", sessionId: "s", ttlSeconds: 60 }));
    expect(isSlackSchemaMissing(err)).toBe(true);
  });

  it("ST09: consumeOAuthState is single use (delete ... returning), returns expiresAt for an expired row too, and the row is gone either way", async () => {
    await issueOAuthState(P1, { nonceHash: H1, authUserId: "auth-m", sessionId: "sess-1", ttlSeconds: 600 });
    const first = await consumeOAuthState(H1);
    expect(first).toMatchObject({ principalId: "ep_1", authUserId: "auth-m", sessionId: "sess-1" });
    expect(Date.parse(String(first?.expiresAt))).toBeGreaterThan(Date.now());
    expect(await consumeOAuthState(H1)).toBeNull();
    const call = db.calls.filter((c) => c.kind === "delete").at(-1);
    expect(call).toMatchObject({ target: "exec_oauth_states", columns: "principal_id,auth_user_id,session_id,expires_at" });
    expect(call?.filters).toContainEqual({ op: "eq", column: "nonce_hash", value: H1 });
    expect(call?.filters.some((f) => "column" in f && f.column === "expires_at")).toBe(false);
    // Created 11 minutes ago, expired a minute ago: consumed (gone) and handed back so the caller says state_expired.
    const now = Date.now();
    db.tables.exec_oauth_states.push({ nonce_hash: H2, provider: "slack", principal_id: "ep_1", auth_user_id: "auth-m", session_id: "sess-1",
      created_at: new Date(now - 11 * 60_000).toISOString(), expires_at: new Date(now - 60_000).toISOString() });
    const expired = await consumeOAuthState(H2);
    expect(expired?.expiresAt).toBe(new Date(now - 60_000).toISOString());
    expect(db.tables.exec_oauth_states).toEqual([]);
    expect(await consumeOAuthState(H2)).toBeNull();
    const calls = db.calls.length;
    expect(await consumeOAuthState("not-a-hash")).toBeNull();
    expect(db.calls.length).toBe(calls);
    useDb({ fail: () => ({ code: "57P01", message: "terminating connection" }) });
    await expect(consumeOAuthState(H1)).rejects.toMatchObject({ op: "consumeOAuthState", pgCode: "57P01" });
  });

  it("deleteExpiredOAuthStates deletes expires_at < now (count), and answers 0 before the migration", async () => {
    const now = new Date("2026-11-07T12:00:00.000Z");
    useDb({ tables: { exec_oauth_states: [
      { nonce_hash: H1, provider: "slack", principal_id: "ep_1", auth_user_id: "a", session_id: "s", created_at: "2026-11-07T11:50:00.000Z", expires_at: "2026-11-07T11:59:59.000Z" },
      { nonce_hash: H2, provider: "slack", principal_id: "ep_1", auth_user_id: "a", session_id: "s", created_at: "2026-11-07T11:55:00.000Z", expires_at: "2026-11-07T12:05:00.000Z" }
    ] } });
    expect(await deleteExpiredOAuthStates(now)).toBe(1);
    expect(db.tables.exec_oauth_states.map((s) => s.nonce_hash)).toEqual([H2]);
    expect(db.calls[0].options).toMatchObject({ count: "exact" });
    useDb({ missing: ["exec_oauth_states"] });
    expect(await deleteExpiredOAuthStates(now)).toBe(0);
    useDb({ fail: () => ({ code: "40001", message: "serialization failure" }) });
    await expect(deleteExpiredOAuthStates(now)).rejects.toMatchObject({ op: "deleteExpiredOAuthStates" });
  });
});

describe("installation health (C34)", () => {
  it("ST10: recordSlackError stores the code (normalised to the CHECK's alphabet) on the active row and never throws", async () => {
    useDb({ tables: { exec_slack_installations: [installation()] } });
    await recordSlackError(INST, "invalid_auth");
    expect(db.tables.exec_slack_installations[0]).toMatchObject({ last_error_code: "invalid_auth" });
    expect(Number.isFinite(Date.parse(String(db.tables.exec_slack_installations[0].last_error_at)))).toBe(true);
    await recordSlackError(INST, "HTTP-503 Upstream");
    expect(db.tables.exec_slack_installations[0].last_error_code).toBe("http_____upstream");
    await recordSlackError(INST, "x".repeat(80));
    expect(db.tables.exec_slack_installations[0].last_error_code).toHaveLength(60);
    await recordSlackError(INST, "123");
    expect(db.tables.exec_slack_installations[0].last_error_code).toBe("unknown_error");
    await clearSlackError(INST);
    expect(db.tables.exec_slack_installations[0]).toMatchObject({ last_error_code: null, last_error_at: null });
    // Never throws: a database error, a malformed id, a thrown client.
    useDb({ fail: () => ({ code: "08006", message: "connection failure" }) });
    await expect(recordSlackError(INST, "token_revoked")).resolves.toBeUndefined();
    await expect(clearSlackError(INST)).resolves.toBeUndefined();
    await expect(recordSlackError(SENTINELS.token, "invalid_auth")).resolves.toBeUndefined();
    vi.mocked(getSupabaseAdmin).mockImplementation(() => {
      throw new Error(`env ${SENTINELS.signingSecret}`);
    });
    await expect(recordSlackError(INST, "invalid_auth")).resolves.toBeUndefined();
    await expect(clearSlackError(INST)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0][0])).toContain(INST);
    expectNoLeaks();
  });

  it("recordSlackError leaves a revoked row's record alone; clearSlackError touches only a row that has an error", async () => {
    useDb({ tables: { exec_slack_installations: [revoked({ updated_at: "2026-11-02T00:05:00.000Z" })] } });
    await recordSlackError(INST, "invalid_auth");
    await clearSlackError(INST);
    expect(db.tables.exec_slack_installations[0]).toMatchObject({ last_error_code: null, updated_at: "2026-11-02T00:05:00.000Z" });
    useDb({ tables: { exec_slack_installations: [installation()] } });
    await clearSlackError(INST);
    expect(db.tables.exec_slack_installations[0].updated_at).toBe(RI.installedAt);
  });
});

describe("revoke, purge and the DM reply RPCs", () => {
  it("revokeInstallation / purgeInstallation map RPCs 3 and 4 (purge null when missing); a bad reason is refused before any call", async () => {
    useDb({ tables: { exec_slack_installations: [installation()] } });
    expect(await revokeInstallation(INST, "disconnected")).toEqual({ revoked: true });
    expect(await revokeInstallation(INST, "disconnected")).toEqual({ revoked: false });
    expect(db.tables.exec_jobs.map((j) => j.dedupe_key)).toEqual([`slack-uninstall:${INST}`]);
    expect(await purgeInstallation(INST)).toEqual({ purged: true, events: 0, posts: 0, conversations: 0 });
    expect(db.tables.exec_slack_installations[0]).toMatchObject({ bot_token_enc: null, key_id: null });
    await expect(revokeInstallation(INST, "expired" as never)).rejects.toBeInstanceOf(TypeError);
    expect(await revokeInstallation("nope", "disconnected")).toEqual({ revoked: false });
    useDb({ missing: ["exec_slack_purge_installation"] });
    expect(await purgeInstallation(INST)).toBeNull();
    useDb({ fail: () => ({ code: "55P03", message: "lock not available" }) });
    await expect(purgeInstallation(INST)).rejects.toMatchObject({ op: "purgeInstallation", pgCode: "55P03" });
    await expect(revokeInstallation(INST, "app_uninstalled")).rejects.toMatchObject({ op: "revokeInstallation", pgCode: "55P03" });
  });

  it("purgeInstallation through the fake: the installation's events, ledger rows and Slack conversations go; web conversations and another installation's rows stay", async () => {
    const created = "2026-11-03T00:00:00.000Z";
    useDb({
      tables: {
        exec_slack_installations: [revoked({ purged_at: null, bot_token_enc: installation().bot_token_enc, key_id: installation().key_id }), installation({ id: INST_2, installed_at: "2026-11-04T00:00:00.000Z" })],
        exec_conversations: [{ id: CONV_ID(1), principal_id: "ep_1", surface: "slack", created_at: "2026-11-01T12:00:00.000Z" }, { id: CONV_ID(2), principal_id: "ep_1", surface: "web", created_at: "2026-11-01T12:00:00.000Z" },
          { id: CONV_ID(3), principal_id: "ep_1", surface: "slack", created_at: created }],
        exec_messages: [{ id: MSG_ID(1), principal_id: "ep_1", conversation_id: CONV_ID(1), role: "assistant" }, { id: MSG_ID(3), principal_id: "ep_1", conversation_id: CONV_ID(3), role: "assistant" }],
        exec_chat_feedback: [{ principal_id: "ep_1", message_id: MSG_ID(1), vote: 1, surface: "slack" }],
        exec_slack_events: [{ event_id: "Ev0P1", installation_id: INST }, { event_id: "Ev0P2", installation_id: INST_2, assistant_message_id: MSG_ID(3) }],
        exec_slack_posts: [{ installation_id: INST, ts: "1.1" }, { installation_id: INST_2, ts: "1.2", message_id: MSG_ID(3) }]
      }
    });
    expect(await purgeInstallation(INST)).toEqual({ purged: true, events: 1, posts: 1, conversations: 1 });
    expect(db.tables.exec_conversations.map((c) => c.id)).toEqual([CONV_ID(2), CONV_ID(3)]);
    expect(db.tables.exec_messages.map((m) => m.id)).toEqual([MSG_ID(3)]);
    expect(db.tables.exec_chat_feedback).toEqual([]);
    expect(db.tables.exec_slack_events.map((e) => e.event_id)).toEqual(["Ev0P2"]);
    expect(db.tables.exec_slack_posts.map((p) => p.ts)).toEqual(["1.2"]);
    expect(db.tables.exec_slack_installations[0]).toMatchObject({ bot_token_enc: null, key_id: null });
    expect(db.tables.exec_slack_installations[0].purged_at).not.toBeNull();
  });

  it("ST-c4 (fixer correctness-4): before a pending revocation's purge, an old thread gets a fresh conversation (the old one goes, as RPC 4 would); after the purge it is reused", async () => {
    useDb({ tables: { exec_slack_installations: [installation()] } });
    const old = await conversationForThread(P1, { channel: RI.dmChannelId, rootTs: "1793977301.000101", title: "q", retentionDays: 90 });
    const conv = db.tables.exec_conversations.find((c) => c.id === old)!;
    conv.created_at = "2026-11-07T08:00:00.000Z";
    db.tables.exec_messages.push({ id: MSG_ID(9), principal_id: "ep_1", conversation_id: old, role: "assistant" });
    Object.assign(db.tables.exec_slack_installations[0], { revoked_at: "2026-11-07T09:00:00.000Z", revoke_reason: "disconnected" });
    const fresh = await conversationForThread(P1, { channel: RI.dmChannelId, rootTs: "1793977301.000101", title: "q", retentionDays: 90 });
    expect(fresh).not.toBe(old);
    expect(db.tables.exec_conversations.map((c) => c.id)).toEqual([fresh]);
    expect(db.tables.exec_messages).toEqual([]);
    expect(await conversationForThread(P1, { channel: RI.dmChannelId, rootTs: "1793977301.000101", title: "q", retentionDays: 90 })).toBe(fresh);
    db.tables.exec_slack_installations[0].purged_at = "2026-11-07T09:05:00.000Z";
    db.tables.exec_conversations[0].created_at = "2026-11-07T08:30:00.000Z";
    expect(await conversationForThread(P1, { channel: RI.dmChannelId, rootTs: "1793977301.000101", title: "q", retentionDays: 90 })).toBe(fresh);
  });

  it("conversationForThread maps RPC 5 (one id per thread); its RAISE throws SlackStoreError P0001 without the title in the message", async () => {
    const id = await conversationForThread(P1, { channel: RI.dmChannelId, rootTs: "1793977301.000101", title: SENTINELS.text, retentionDays: 90 });
    expect(id).toMatch(/^ecv_[0-9a-f]{32}$/);
    expect(await conversationForThread(P1, { channel: RI.dmChannelId, rootTs: "1793977301.000101", title: "other", retentionDays: 30 })).toBe(id);
    expect(db.tables.exec_conversations).toHaveLength(1);
    expect(db.tables.exec_conversations[0]).toMatchObject({ surface: "slack", create_client_turn_id: "slkc_D0MITCH_1793977301_000101", slack_thread_ts: "1793977301.000101" });
    const err = await thrown(conversationForThread(P1, { channel: "C0GENERAL", rootTs: "1793977301.000101", title: SENTINELS.text, retentionDays: 90 }));
    expect(err).toMatchObject({ op: "conversationForThread", pgCode: "P0001" });
    expectNoLeaks(err);
  });

  it("replyStep maps RPC 6: true once, false on the lost CAS; a disallowed transition throws; unknown states are refused before the call", async () => {
    useDb({ tables: { exec_slack_installations: [installation({ last_error_code: "invalid_auth", last_error_at: "2026-11-02T00:00:00.000Z" })],
      exec_slack_events: [{ event_id: "Ev0STEP1", installation_id: INST, principal_id: "ep_1", decision: "reply", reply_state: "queued", channel_id: RI.dmChannelId, message_ts: "1793977301.000101", retry_num: 0, team_id: RI.teamId, api_app_id: RI.appId, event_type: "message" }],
      exec_messages: [{ id: MSG_ID(4), principal_id: "ep_1", role: "assistant", slack_ts: null }] } });
    expect(await replyStep("Ev0STEP1", ["queued"], "started")).toBe(true);
    expect(await replyStep("Ev0STEP1", ["queued"], "started")).toBe(false);
    expect(await replyStep("Ev0STEP1", ["started"], "placeholder", { placeholderTs: "1793977302.000001", conversationId: CONV_ID(1), assistantMessageId: MSG_ID(4) })).toBe(true);
    expect(db.tables.exec_messages[0].slack_ts).toBe("1793977302.000001");
    expect(db.calls.at(-1)?.payload).toEqual({ p_event_id: "Ev0STEP1", p_from: ["started"], p_to: "placeholder", p_placeholder_ts: "1793977302.000001",
      p_conversation_id: CONV_ID(1), p_assistant_message_id: MSG_ID(4) });
    expect(await replyStep("Ev0STEP1", ["started", "placeholder"], "answered")).toBe(true);
    expect(db.tables.exec_slack_installations[0]).toMatchObject({ last_error_code: null, last_error_at: null });
    expect(db.tables.exec_slack_installations[0].last_dm_at).not.toBeNull();
    await expect(replyStep("Ev0STEP1", ["queued"], "answered")).rejects.toMatchObject({ op: "replyStep", pgCode: "P0001" });
    await expect(replyStep("Ev0STEP1", ["done" as never], "swept")).rejects.toBeInstanceOf(TypeError);
    await expect(replyStep("Ev0STEP1", ["queued"], "done" as never)).rejects.toBeInstanceOf(TypeError);
    // "queued" is a state but never a target: the RPC refuses it (its bad-target RAISE).
    await expect(replyStep("Ev0STEP1", ["queued"], "queued")).rejects.toMatchObject({ op: "replyStep", pgCode: "P0001" });
  });

  it("ST12: listOpenReplies filters on updated_at (since <= updated_at <= before), never received_at; oldest updated_at first; the limit is clamped", async () => {
    const t = (min: number) => new Date(Date.parse("2026-11-07T12:00:00.000Z") - min * 60_000).toISOString();
    const ev = (id: string, state: string, received: number, updated: number, over: Row = {}) => ({
      event_id: id, installation_id: INST, principal_id: "ep_1", channel_id: RI.dmChannelId, message_ts: "1793977301.000101", thread_ts: null, decision: "reply",
      reply_state: state, placeholder_ts: state === "placeholder" ? "1793977302.000001" : null, received_at: t(received), updated_at: t(updated), ...over
    });
    useDb({ tables: { exec_slack_events: [
      ev("Ev0FRESH", "placeholder", 12, 2), ev("Ev0STALE", "queued", 11, 11), ev("Ev0DONE", "answered", 30, 20), ev("Ev0OLD", "started", 40, 30),
      ev("Ev0OTHER", "queued", 11, 11, { principal_id: "ep_2" })
    ] } });
    const rows = await listOpenReplies(P1, { before: t(10), since: t(60 * 25), limit: 20 });
    expect(rows.map((r) => r.eventId)).toEqual(["Ev0OLD", "Ev0STALE"]);
    expect(rows[1]).toEqual({ eventId: "Ev0STALE", installationId: INST, principalId: "ep_1", channelId: RI.dmChannelId, messageTs: "1793977301.000101", threadTs: null,
      replyState: "queued", placeholderTs: null, receivedAt: t(11), updatedAt: t(11) });
    const call = db.calls[0];
    expect(call.filters).toEqual([
      { op: "eq", column: "principal_id", value: "ep_1" }, { op: "in", column: "reply_state", values: ["queued", "started", "placeholder"] },
      { op: "gte", column: "updated_at", value: t(60 * 25) }, { op: "lte", column: "updated_at", value: t(10) }
    ]);
    expect(call.filters.some((f) => "column" in f && f.column === "received_at")).toBe(false);
    expect(call.orders).toEqual([{ column: "updated_at", ascending: true }]);
    expect((await listOpenReplies(P1, { before: t(0), since: t(60), limit: 500 })).map((r) => r.eventId)).toEqual(["Ev0OLD", "Ev0STALE", "Ev0FRESH"]);
    expect(db.calls.at(-1)?.limit).toBe(100);
    await expect(listOpenReplies(P1, { before: "soon", since: t(60), limit: 5 })).rejects.toBeInstanceOf(TypeError);
  });
});

// ---------------------------------------------------------------------------

describe("the post ledger (C43) and the follow-ups (C42)", () => {
  const post = (p: Partial<Parameters<typeof recordSlackPost>[1]> = {}) =>
    recordSlackPost(P1, { installationId: INST, channelId: RI.dmChannelId, ts: "1793977302.000001", threadTs: "1793977301.000101", kind: "answer", messageId: MSG_ID(1), ...p });

  it("ST13: recordSlackPost writes one row per post with the identical key set; a duplicate (installation, ts) is a no-op; a failure never throws", async () => {
    useDb({ tables: { exec_slack_installations: [installation()] } });
    await post();
    await post({ ts: "1793977303.000001", kind: "draft", refId: `ed_${hex32(7)}`, messageId: MSG_ID(1) });
    await post({ ts: "1793977304.000001", kind: "note", messageId: undefined, refId: undefined, threadTs: null });
    await post();
    const inserts = db.calls.filter((c) => c.kind === "insert");
    expect(inserts).toHaveLength(4);
    const keys = inserts.map((c) => Object.keys(c.payload as Row).sort().join(","));
    expect(new Set(keys)).toEqual(new Set(["channel_id,installation_id,kind,message_id,principal_id,ref_id,thread_ts,ts"]));
    expect(inserts[2].payload).toMatchObject({ message_id: null, ref_id: null, thread_ts: null });
    expect(db.tables.exec_slack_posts).toHaveLength(3);
    expect(errorSpy).not.toHaveBeenCalled();
    // A refusal is logged by installation id and ts only, and swallowed.
    useDb({ fail: () => ({ code: "08006", message: `connection failure ${SENTINELS.text}` }) });
    await expect(post()).resolves.toBeUndefined();
    expect(String(errorSpy.mock.calls[0][0])).toBe(`[exec-slack] ledger row not written (installation ${INST}, ts 1793977302.000001): 08006`);
    vi.mocked(getSupabaseAdmin).mockImplementation(() => {
      throw new Error(SENTINELS.token);
    });
    await expect(post()).resolves.toBeUndefined();
    // A malformed reference is never written (and the log names no value it can't vouch for).
    useDb({ tables: { exec_slack_installations: [installation()] } });
    await post({ kind: "draft", refId: null });
    await post({ ts: SENTINELS.text });
    await post({ kind: "proposal", refId: `ed_${hex32(7)}` });
    expect(db.calls).toEqual([]);
    expectNoLeaks();
  });

  it("listCardPostsForMessage: his card posts of one message, oldest first; listOldSlackPosts / deleteSlackPostRecord drive the DM purge", async () => {
    useDb({ tables: { exec_slack_posts: [
      { installation_id: INST, principal_id: "ep_1", ts: "1793977305.000001", kind: "proposal", message_id: MSG_ID(1), ref_id: `etp_${hex32(1)}`, posted_at: "2026-11-07T10:00:02.000Z" },
      { installation_id: INST, principal_id: "ep_1", ts: "1793977304.000001", kind: "draft", message_id: MSG_ID(1), ref_id: `ed_${hex32(1)}`, posted_at: "2026-11-07T10:00:01.000Z" },
      { installation_id: INST, principal_id: "ep_1", ts: "1793977303.000001", kind: "answer", message_id: MSG_ID(1), ref_id: null, posted_at: "2026-10-01T10:00:00.000Z" },
      { installation_id: INST, principal_id: "ep_2", ts: "1793977306.000001", kind: "draft", message_id: MSG_ID(1), ref_id: `ed_${hex32(2)}`, posted_at: "2026-10-01T10:00:00.000Z" },
      { installation_id: INST_2, principal_id: "ep_1", ts: "1793977307.000001", kind: "draft", message_id: MSG_ID(1), ref_id: `ed_${hex32(3)}`, posted_at: "2026-10-01T10:00:00.000Z" }
    ] } });
    expect(await listCardPostsForMessage(P1, INST, MSG_ID(1))).toEqual([
      { ts: "1793977304.000001", kind: "draft", refId: `ed_${hex32(1)}` }, { ts: "1793977305.000001", kind: "proposal", refId: `etp_${hex32(1)}` }
    ]);
    expect(await listCardPostsForMessage(P1, INST, "bad")).toEqual([]);
    expect(await listOldSlackPosts(INST, "2026-11-01T00:00:00.000Z", 10)).toEqual([
      { ts: "1793977303.000001", kind: "answer" }, { ts: "1793977306.000001", kind: "draft" }
    ]);
    await deleteSlackPostRecord(INST, "1793977303.000001");
    expect(db.tables.exec_slack_posts.map((p) => p.ts)).not.toContain("1793977303.000001");
    expect(db.tables.exec_slack_posts).toHaveLength(4);
    useDb({ fail: () => ({ code: "08006", message: "x" }) });
    await expect(deleteSlackPostRecord(INST, "1793977303.000001")).rejects.toMatchObject({ op: "deleteSlackPostRecord" });
    await expect(listOldSlackPosts(INST, "2026-11-01T00:00:00.000Z", 10)).rejects.toMatchObject({ op: "listOldSlackPosts" });
  });

  it("listRedactionFollowups maps RPC 7 to camelCase, keeps changed_at verbatim, and answers null before the migration", async () => {
    const changed = "2026-11-07T10:00:00.123456+00:00";
    useDb({ tables: {
      exec_slack_posts: [{ installation_id: INST, principal_id: "ep_1", ts: "1793977302.000001", kind: "answer", message_id: MSG_ID(1), followed_at: null },
        { installation_id: INST, principal_id: "ep_1", ts: "1793977303.000001", kind: "draft", ref_id: `ed_${hex32(1)}`, followed_at: null },
        { installation_id: INST, principal_id: "ep_1", ts: "1793977304.000001", kind: "proposal", ref_id: `etp_${hex32(1)}`, followed_at: null },
        { installation_id: INST, principal_id: "ep_1", ts: "1793977305.000001", kind: "proposal", ref_id: `etp_${hex32(2)}`, followed_at: null }],
      exec_messages: [{ id: MSG_ID(1), principal_id: "ep_1", conversation_id: CONV_ID(1), redacted_at: changed, updated_at: changed }],
      exec_drafts: [{ id: `ed_${hex32(1)}`, principal_id: "ep_1", restricted_purged: true, updated_at: changed }],
      // (c): a redacted proposal is returned; one that wasn't redacted isn't.
      exec_task_proposals: [{ id: `etp_${hex32(1)}`, principal_id: "ep_1", redacted_at: changed, updated_at: changed },
        { id: `etp_${hex32(2)}`, principal_id: "ep_1", redacted_at: null, updated_at: changed }]
    } });
    expect(await listRedactionFollowups(P1, INST, 20)).toEqual({
      answers: [{ ts: "1793977302.000001", messageId: MSG_ID(1), conversationId: CONV_ID(1), changedAt: changed }],
      drafts: [{ ts: "1793977303.000001", draftId: `ed_${hex32(1)}`, changedAt: changed }],
      proposals: [{ ts: "1793977304.000001", proposalId: `etp_${hex32(1)}`, changedAt: changed }]
    });
    expect(db.calls[0].payload).toEqual({ p_principal: "ep_1", p_installation_id: INST, p_limit: 20 });
    await listRedactionFollowups(P1, INST, 5000);
    expect((db.calls.at(-1)?.payload as Row).p_limit).toBe(100);
    useDb({ missing: ["exec_slack_redaction_followups"] });
    expect(await listRedactionFollowups(P1, INST, 20)).toBeNull();
  });

  it("ST14: markPostFollowed stores the changed_at it was given, verbatim (microseconds), and never moves followed_at backwards", async () => {
    const later = "2026-11-07T10:00:00.123456+00:00";
    const earlier = "2026-11-07T09:00:00.000001+00:00";
    const row = (followed: string | null) => ({ installation_id: INST, principal_id: "ep_1", channel_id: RI.dmChannelId, ts: "1793977302.000001", kind: "answer", followed_at: followed });
    useDb({ tables: { exec_slack_installations: [installation()], exec_slack_posts: [row(null)] } });
    await markPostFollowed(INST, "1793977302.000001", later);
    expect(db.tables.exec_slack_posts[0].followed_at).toBe(later);
    expect(db.calls.filter((c) => c.kind === "update").map((c) => (c.payload as Row).followed_at)).toEqual([later]);
    // An older follow-up arriving late changes nothing.
    await markPostFollowed(INST, "1793977302.000001", earlier);
    expect(db.tables.exec_slack_posts[0].followed_at).toBe(later);
    const guard = db.calls.at(-1);
    expect(guard?.filters).toContainEqual({ op: "lt", column: "followed_at", value: earlier });
    // A newer one moves it forward.
    const newest = "2026-11-07T11:00:00.5+00:00";
    await markPostFollowed(INST, "1793977302.000001", newest);
    expect(db.tables.exec_slack_posts[0].followed_at).toBe(newest);
    for (const bad of ["now", "2026-11-07", "", "2026-11-07T10:00:00.1234567+00:00"]) {
      await expect(markPostFollowed(INST, "1793977302.000001", bad), bad).rejects.toBeInstanceOf(TypeError);
    }
    useDb({ fail: () => ({ code: "08006", message: "x" }) });
    await expect(markPostFollowed(INST, "1793977302.000001", later)).rejects.toMatchObject({ op: "markPostFollowed" });
  });

  it("ST14b (fixer correctness-1): resetPostFollowed clears one post's follow marker (RPC 7 re-checks it), never another's, and never throws", async () => {
    const followed = "2026-11-07T10:00:00.123456+00:00";
    const row = (ts: string) => ({ installation_id: INST, principal_id: "ep_1", channel_id: RI.dmChannelId, ts, kind: "answer", followed_at: followed });
    useDb({ tables: { exec_slack_installations: [installation()], exec_slack_posts: [row("1793977302.000001"), row("1793977302.000002")] } });
    await resetPostFollowed(INST, "1793977302.000001");
    expect(db.tables.exec_slack_posts.map((p) => p.followed_at)).toEqual([null, followed]);
    expect(db.calls.at(-1)?.filters).toEqual(expect.arrayContaining([{ op: "eq", column: "installation_id", value: INST }, { op: "eq", column: "ts", value: "1793977302.000001" }]));
    const before = db.calls.length;
    await resetPostFollowed("bad-id", "1793977302.000002");
    await resetPostFollowed(INST, "not-a-ts");
    expect(db.calls.length).toBe(before);
    useDb({ fail: () => ({ code: "08006", message: "x" }) });
    await expect(resetPostFollowed(INST, "1793977302.000001")).resolves.toBeUndefined();
    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain(INST);
  });

  it("ST15b (fixer correctness-5): listUnpurgedRevokedInstallations lists ids revoked before the cutoff whose purge never ran, oldest first; schema missing → []", async () => {
    const id = (n: number) => `esi_${hex32(n)}`;
    useDb({ tables: { exec_slack_installations: [
      installation({ id: id(1), revoked_at: "2026-11-07T08:00:00.000Z", revoke_reason: "disconnected", bot_token_enc: null, key_id: null }),
      installation({ id: id(2), revoked_at: "2026-11-07T07:00:00.000Z", revoke_reason: "app_uninstalled" }),
      installation({ id: id(3), revoked_at: "2026-11-07T06:00:00.000Z", revoke_reason: "app_uninstalled", bot_token_enc: null, key_id: null, purged_at: "2026-11-07T06:05:00.000Z" }),
      installation({ id: id(4), revoked_at: "2026-11-07T09:30:00.000Z", revoke_reason: "disconnected" }),
      installation({ id: id(5) })
    ] } });
    expect(await listUnpurgedRevokedInstallations("2026-11-07T09:00:00.000Z", 10)).toEqual([id(2), id(1)]);
    expect(await listUnpurgedRevokedInstallations("2026-11-07T09:00:00.000Z", 1)).toEqual([id(2)]);
    await expect(listUnpurgedRevokedInstallations("soon", 10)).rejects.toBeInstanceOf(TypeError);
    useDb({ missing: ["exec_slack_installations"] });
    expect(await listUnpurgedRevokedInstallations("2026-11-07T09:00:00.000Z", 10)).toEqual([]);
  });

  it("ST14: enqueueRevokeCheck enqueues the hour-bucketed check (bulk, maxAttempts 3, event_time = now) and never throws", async () => {
    const now = new Date("2026-11-07T09:59:59.999Z");
    await enqueueRevokeCheck(INST, now);
    expect(enqueueJob).toHaveBeenCalledWith({
      kind: "exec.slack-uninstall", lane: "bulk", principalId: null, payload: { installation_id: INST, mode: "check", event_time: 1794045599 },
      dedupeKey: `slack-revoke-check:auth:${INST}:2026110709`, maxAttempts: 3
    });
    await enqueueRevokeCheck(INST, new Date("2026-11-07T10:00:00.000Z"));
    expect(vi.mocked(enqueueJob).mock.calls[1][0].dedupeKey).toBe(`slack-revoke-check:auth:${INST}:2026110710`);
    vi.mocked(enqueueJob).mockRejectedValue(new Error("exec_jobs enqueue failed (exec.slack-uninstall): down"));
    await expect(enqueueRevokeCheck(INST, now)).resolves.toBeUndefined();
    expect(String(errorSpy.mock.calls[0][0])).toContain(INST);
    await expect(enqueueRevokeCheck("bad-id", now)).resolves.toBeUndefined();
    await expect(enqueueRevokeCheck(INST, new Date(Number.NaN))).resolves.toBeUndefined();
    expect(enqueueJob).toHaveBeenCalledTimes(3);
  });
});

describe("answer feedback (C16, C41)", () => {
  const seedMessages = () =>
    useDb({ tables: { exec_messages: [
      { id: MSG_ID(1), principal_id: "ep_1", conversation_id: CONV_ID(1), role: "assistant", slack_ts: "1793977302.000001", text: SENTINELS.text },
      { id: MSG_ID(2), principal_id: "ep_2", conversation_id: CONV_ID(2), role: "assistant", slack_ts: "1793977302.000002" },
      { id: MSG_ID(3), principal_id: "ep_1", conversation_id: CONV_ID(1), role: "user", slack_ts: null }
    ] } });

  it("ST11: findAnswerBySlackTs selects only id, conversation_id of his assistant row by slack_ts", async () => {
    seedMessages();
    expect(await findAnswerBySlackTs(P1, "1793977302.000001")).toEqual({ messageId: MSG_ID(1), conversationId: CONV_ID(1) });
    expect(db.calls[0]).toMatchObject({ kind: "select", target: "exec_messages", columns: "id,conversation_id" });
    expect(db.calls[0].filters).toEqual([
      { op: "eq", column: "principal_id", value: "ep_1" }, { op: "eq", column: "slack_ts", value: "1793977302.000001" }, { op: "eq", column: "role", value: "assistant" }
    ]);
    expect(await findAnswerBySlackTs(P1, "1793977302.000002")).toBeNull();
    expect(await findAnswerBySlackTs(P1, "not-a-ts")).toBeNull();
    expect(db.calls).toHaveLength(2);
  });

  it("ST12: recordChatFeedback checks his assistant row first (another principal's or a question -> not_found), then upserts with the identical key set", async () => {
    seedMessages();
    expect(await recordChatFeedback(P1, MSG_ID(2), 1, "slack")).toBe("not_found");
    expect(await recordChatFeedback(P1, MSG_ID(3), 1, "slack")).toBe("not_found");
    expect(await recordChatFeedback(P1, "ecm_bad", 1, "slack")).toBe("not_found");
    expect(db.tables.exec_chat_feedback).toEqual([]);
    expect(await recordChatFeedback(P1, MSG_ID(1), 1, "slack")).toBe("recorded");
    expect(await recordChatFeedback(P1, MSG_ID(1), -1, "web")).toBe("recorded");
    expect(db.tables.exec_chat_feedback).toHaveLength(1);
    expect(db.tables.exec_chat_feedback[0]).toMatchObject({ principal_id: "ep_1", message_id: MSG_ID(1), vote: -1, surface: "web" });
    const upserts = db.calls.filter((c) => c.kind === "upsert");
    expect(upserts.map((c) => Object.keys(c.payload as Row).sort().join(","))).toEqual(["message_id,principal_id,surface,updated_at,vote", "message_id,principal_id,surface,updated_at,vote"]);
    expect(upserts[0].options).toMatchObject({ onConflict: "principal_id,message_id" });
    const own = db.calls.find((c) => c.kind === "select");
    expect(own?.columns).toBe("id");
    await expect(recordChatFeedback(P1, MSG_ID(1), 0 as never, "slack")).rejects.toBeInstanceOf(TypeError);
    await expect(recordChatFeedback(P1, MSG_ID(1), 1, "email" as never)).rejects.toBeInstanceOf(TypeError);
  });

  it("ST12: the answer deleted between the check and the write (23503) -> not_found; other errors throw", async () => {
    seedMessages();
    useDb({ tables: { exec_messages: db.tables.exec_messages }, before: (call, fake) => {
      if (call.kind === "upsert") fake.tables.exec_messages = [];
    } });
    expect(await recordChatFeedback(P1, MSG_ID(1), 1, "slack")).toBe("not_found");
    seedMessages();
    useDb({ tables: { exec_messages: db.tables.exec_messages }, fail: (c) => (c.kind === "upsert" ? { code: "40P01", message: "deadlock detected" } : null) });
    await expect(recordChatFeedback(P1, MSG_ID(1), 1, "slack")).rejects.toMatchObject({ op: "recordChatFeedback", pgCode: "40P01" });
  });
});

describe("retention (§2.6)", () => {
  it("deleteOldSlackEvents deletes received_at < now - hours in chunks of 1,000 by event_id, and answers 0 before the migration", async () => {
    const now = new Date("2026-11-07T12:00:00.000Z");
    const old = "2026-11-06T10:00:00.000Z";
    const fresh = "2026-11-07T11:00:00.000Z";
    const events = [
      ...Array.from({ length: 2500 }, (_, i) => ({ event_id: `Ev0OLD${String(i).padStart(5, "0")}`, received_at: old })),
      ...Array.from({ length: 3 }, (_, i) => ({ event_id: `Ev0NEW${i}`, received_at: fresh })),
      { event_id: "Ev0EDGE", received_at: "2026-11-06T11:00:00.000Z" }
    ];
    useDb({ tables: { exec_slack_events: events } });
    expect(await deleteOldSlackEvents(now, 25)).toBe(2500);
    expect(db.tables.exec_slack_events.map((e) => e.event_id).sort()).toEqual(["Ev0EDGE", "Ev0NEW0", "Ev0NEW1", "Ev0NEW2"]);
    const deletes = db.calls.filter((c) => c.kind === "delete");
    expect(deletes).toHaveLength(3);
    expect(deletes[0].filters).toEqual([{ op: "lt", column: "received_at", value: "2026-11-06T11:00:00.000Z" }, { op: "lte", column: "event_id", value: "Ev0OLD00999" }]);
    expect(deletes[2].filters).toEqual([{ op: "lt", column: "received_at", value: "2026-11-06T11:00:00.000Z" }]);
    expect(db.calls.filter((c) => c.kind === "select").every((c) => c.range?.[0] === 999 && c.range?.[1] === 999)).toBe(true);
    useDb({ missing: ["exec_slack_events"] });
    expect(await deleteOldSlackEvents(now, 25)).toBe(0);
    useDb({ fail: (c) => (c.kind === "delete" ? { code: "57014", message: "statement timeout" } : null) });
    await expect(deleteOldSlackEvents(now, 25)).rejects.toMatchObject({ op: "deleteOldSlackEvents", pgCode: "57014" });
    const controller = new AbortController();
    controller.abort(new Error("lease lost"));
    await expect(deleteOldSlackEvents(now, 25, { signal: controller.signal })).rejects.toThrow("lease lost");
    await expect(deleteOldSlackEvents(new Date(Number.NaN), 25)).rejects.toBeInstanceOf(TypeError);
  });
});
