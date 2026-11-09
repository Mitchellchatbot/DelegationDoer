import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/jobs", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecSession: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditStart: vi.fn(), auditFinish: vi.fn(), auditEvent: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/http", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/http")>()), rateLimit: vi.fn() }));
// Area A's real store over the read fake, with call spies.
vi.mock("@/lib/exec/slack-install", async (orig) => {
  const a = await orig<typeof import("@/lib/exec/slack-install")>();
  return {
    ...a,
    issueOAuthState: vi.fn(a.issueOAuthState),
    consumeOAuthState: vi.fn(a.consumeOAuthState),
    saveInstallation: vi.fn(a.saveInstallation),
    saveReadingConsent: vi.fn(a.saveReadingConsent),
    getReadingHalf: vi.fn(a.getReadingHalf),
    slackReadingSchemaReady: vi.fn(a.slackReadingSchemaReady)
  };
});
vi.mock("@/lib/exec/crypto", async (orig) => {
  const a = await orig<typeof import("@/lib/exec/crypto")>();
  return { ...a, sealSecret: vi.fn(a.sealSecret) };
});

import * as callbackRoute from "@/app/api/integrations/exec-slack/callback/route";
import * as startRoute from "@/app/api/integrations/exec-slack/start/route";
import { installFakeSlack, SLACK_RECORDED, type FakeSlackHandler } from "@/lib/exec/__tests__/fake-slack-api";
import { createFakeSlackDb, type Row } from "@/lib/exec/__tests__/fake-slack-db";
import { createFakeSlackReadDb, type FakeSlackReadDb, type FakeSlackReadDbSeed } from "@/lib/exec/__tests__/fake-slack-read-db";
import { SENTINELS } from "@/lib/exec/__tests__/slack-assert";
import { SLACK_TEXT_SENTINELS, assertNoSlackText, captureConsole } from "@/lib/exec/__tests__/slack-read-assert";
import { INSTALLATION_ID, installationRow, slackEnv, testPrincipal } from "@/lib/exec/__tests__/slack-route-helpers";
import { requireExecSession } from "@/lib/exec/access";
import { auditEvent, auditFinish, auditStart } from "@/lib/exec/audit";
import { openSecret, sealSecret, signState } from "@/lib/exec/crypto";
import { rateLimit } from "@/lib/exec/http";
import { enqueueJob } from "@/lib/exec/jobs";
import { consumeOAuthState, getReadingHalf, issueOAuthState, saveInstallation, saveReadingConsent, slackReadingSchemaReady } from "@/lib/exec/slack-install";
import { SLACK_READ_COPY } from "@/lib/exec/slack-read-copy";
import { SLACK_USER_SCOPES_OPTIONAL, SLACK_USER_SCOPES_REQUIRED } from "@/lib/exec/slack-read-types";
import { SLACK_BOT_SCOPES, type SlackMethod } from "@/lib/exec/slack-types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// The read consent (P7a contract §3.10.3-4, N4, C7, C27; Area C): OR01-OR18 through P6's two unchanged route files.
// The store is Area A's real slack-install.ts over fake-slack-read-db.ts (the P7a columns: the state row's purpose, the
// installation's user half), Slack is fake-slack-api.ts with recorded shapes (auth.test answers the bot token and the
// user token apart by the bearer header), and the state mac is crypto.ts's real HMAC under the test key. The session
// gate, the audit, the rate limiter and the job queue are mocks at their module boundary.

const AUTH = "11111111-1111-4111-8111-111111111111";
const SESSION = "sess-strong-1";
const P = testPrincipal("ep_1", SENTINELS.email);
const START_URL = "https://operations.scaledai.org/api/integrations/exec-slack/start";
const CALLBACK_URL = "https://operations.scaledai.org/api/integrations/exec-slack/callback";
const SETTINGS = "https://operations.scaledai.org/executive/settings";
const USER_TOKEN = SLACK_TEXT_SENTINELS.userToken;
const ALL_USER_SCOPES = [...SLACK_USER_SCOPES_REQUIRED, ...SLACK_USER_SCOPES_OPTIONAL];
const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

let db: FakeSlackReadDb;
let out: ReturnType<typeof captureConsole>;

function useEnv(over: Record<string, string | undefined> = {}): void {
  for (const [k, v] of Object.entries(slackEnv(over))) vi.stubEnv(k, v);
}
/** His active P6 installation with the P7a columns (the user half: none unless overridden). */
function readingInstallation(over: Row = {}): Row {
  return {
    ...installationRow(), user_key_id: null, user_installed_at: null, user_revoked_at: null, user_revoke_reason: null, user_last_error_code: null,
    user_last_error_at: null, reading_state: "none", discovered_at: null, reading_purged_at: null, ...over
  };
}
/** The same with a live user half (his user token sealed under its own context). */
function liveHalf(over: Row = {}): Row {
  const sealed = sealSecret(USER_TOKEN, "exec_slack_installations.user_token:ep_1");
  vi.mocked(sealSecret).mockClear();
  return readingInstallation({
    user_token_enc: sealed, user_key_id: sealed.split(".")[1], user_scopes: [...ALL_USER_SCOPES], user_installed_at: "2026-11-02T00:00:00.000Z",
    reading_state: "ready", discovered_at: "2026-11-02T01:00:00.000Z", ...over
  });
}
function useDb(seed: FakeSlackReadDbSeed = { tables: { exec_slack_installations: [readingInstallation()] } }): FakeSlackReadDb {
  db = createFakeSlackReadDb({ now: () => new Date(), ...seed });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
function session(): void {
  vi.mocked(requireExecSession).mockResolvedValue({ ok: true, principal: P, authUserId: AUTH, sessionId: SESSION });
}
const userAuthTest = (over: Row = {}) => ({ ok: true, url: "https://scaledai.slack.com/", team: "ScaledAI", user: "mitchell", team_id: "T0SCALED", user_id: "U0MITCH", ...over });
/** auth.test answers by token: the bot's for the bot token, his for the user token. */
const authTestBy = (user: () => object = () => userAuthTest()): FakeSlackHandler => (_body, headers) =>
  headers.get("authorization") === `Bearer ${USER_TOKEN}` ? user() : SLACK_RECORDED.authTest();
/** oauth.v2.access for the read consent: the bot token (K5's in-place replacement) and his user grant. */
const readAccess = (authed: Row = {}, over: Row = {}): FakeSlackHandler => () => ({
  ...SLACK_RECORDED.oauthAccess(),
  access_token: SENTINELS.token,
  authed_user: { id: "U0MITCH", scope: ALL_USER_SCOPES.join(","), access_token: USER_TOKEN, token_type: "user", ...authed },
  ...over
});

/** Slack answering a clean read consent by Mitchell; any method can be overridden or removed (undefined = no handler). */
function slack(over: Partial<Record<SlackMethod, FakeSlackHandler | undefined>> = {}) {
  const handlers: Partial<Record<SlackMethod, FakeSlackHandler>> = {
    "oauth.v2.access": readAccess(),
    "users.lookupByEmail": () => SLACK_RECORDED.lookupByEmail(),
    "auth.test": authTestBy(),
    "conversations.open": () => SLACK_RECORDED.conversationsOpen(),
    "auth.revoke": () => SLACK_RECORDED.revoke()
  };
  for (const [k, v] of Object.entries(over) as [SlackMethod, FakeSlackHandler | undefined][]) {
    if (v === undefined) delete handlers[k];
    else handlers[k] = v;
  }
  return installFakeSlack(handlers);
}

function startReq(query = "?purpose=read", headers: Record<string, string> = {}): Request {
  return new Request(`${START_URL}${query}`, { headers: { host: "operations.scaledai.org", "sec-fetch-site": "same-origin", ...headers } });
}
const callback = (query: Record<string, string>) =>
  callbackRoute.GET(new Request(`${CALLBACK_URL}?${new URLSearchParams(query).toString()}`, { headers: { host: "operations.scaledai.org", "sec-fetch-site": "cross-site" } }));
function resultOf(res: Response): Record<string, string> {
  expect(res.status).toBe(303);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  const loc = new URL(res.headers.get("location") ?? "");
  expect(`${loc.origin}${loc.pathname}`).toBe(SETTINGS);
  return Object.fromEntries(loc.searchParams);
}
async function readState(): Promise<string> {
  const res = await startRoute.GET(startReq());
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "";
}
const consent = async () => callback({ code: SENTINELS.oauthCode, state: await readState() });
const methods = (s: { calls: { method: SlackMethod }[] }) => s.calls.map((c) => c.method);
const revokes = (s: { calls: { method: SlackMethod; headers: Record<string, string> }[] }) =>
  s.calls.filter((c) => c.method === "auth.revoke").map((c) => c.headers.authorization);
const readEvents = () => vi.mocked(auditEvent).mock.calls.filter((c) => c[1].action === "slack.read_consent").map((c) => c[1]);
const installRow = () => db.tables.exec_slack_installations.find((r) => r.id === INSTALLATION_ID) as Row;
const auditCalls = () => [vi.mocked(auditStart).mock.calls.map((c) => c[1]), vi.mocked(auditFinish).mock.calls, vi.mocked(auditEvent).mock.calls.map((c) => c[1])];

beforeEach(() => {
  useEnv();
  useDb();
  session();
  out = captureConsole();
  vi.mocked(auditStart).mockReset().mockResolvedValue(77);
  vi.mocked(auditFinish).mockReset().mockResolvedValue(undefined);
  vi.mocked(auditEvent).mockReset().mockResolvedValue(undefined);
  vi.mocked(rateLimit).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(enqueueJob).mockReset().mockResolvedValue({ enqueued: true, id: 1 });
  for (const fn of [issueOAuthState, consumeOAuthState, saveInstallation, saveReadingConsent, getReadingHalf, slackReadingSchemaReady, sealSecret]) vi.mocked(fn).mockClear();
});

afterEach(() => {
  // OR18: no token, code, state, email or Slack name reached a log line or an audit row.
  assertNoSlackText([out.calls(), auditCalls()], { label: "logs and audit" });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Start (§3.10.3)

describe("GET …/start?purpose=read", () => {
  it("OR01 the authorize URL: P6's exact bot scope plus exactly the nine user scopes; the audit carries the purpose", async () => {
    const res = await startRoute.GET(startReq());
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location") ?? "");
    expect([url.protocol, url.host, url.pathname]).toEqual(["https:", "slack.com", "/oauth/v2/authorize"]);
    expect([...url.searchParams.keys()].sort()).toEqual(["client_id", "redirect_uri", "scope", "state", "team", "user_scope"]);
    expect(url.searchParams.get("scope")?.split(",")).toEqual([...SLACK_BOT_SCOPES]);
    expect(url.searchParams.get("user_scope")).toBe("channels:history,groups:history,channels:read,groups:read,users:read,im:history,im:read,mpim:history,mpim:read");
    expect(url.searchParams.get("redirect_uri")).toBe("https://operations.scaledai.org/api/integrations/exec-slack/callback");
    expect(url.searchParams.get("team")).toBe("T0SCALED");
    expect(auditStart).toHaveBeenCalledWith(P, { actor: "owner", action: "slack.oauth.start", target: "exec_oauth_states", input: { purpose: "read" } });
    expect(rateLimit).toHaveBeenCalledWith(P, "slack_connect", 10, 600_000);
  });

  it.each(["?purpose=bogus", "?purpose=read&purpose=read", "?purpose=", "?purpose=READ", "?purpose=install"])(
    "OR02 %s → state_invalid, before anything is read or written",
    async (q) => {
      expect(resultOf(await startRoute.GET(startReq(q)))).toEqual({ slack: "state_invalid" });
      expect(requireExecSession).not.toHaveBeenCalled();
      expect(db.calls).toEqual([]);
      expect(auditStart).not.toHaveBeenCalled();
      vi.mocked(requireExecSession).mockClear();
    }
  );

  it("OR03 no P7a schema (the reading columns missing) → not_installed, no state", async () => {
    useDb({ tables: { exec_slack_installations: [readingInstallation()] }, missing: ["exec_slack_installations.reading_state"] });
    expect(resultOf(await startRoute.GET(startReq()))).toEqual({ slack: "not_installed" });
    expect(issueOAuthState).not.toHaveBeenCalled();
    expect(auditStart).not.toHaveBeenCalled();
  });

  it("OR03 the reading check failing → unavailable", async () => {
    useDb({ tables: { exec_slack_installations: [readingInstallation()] }, fail: (c) => (c.target === "exec_slack_installations" && c.kind === "select" ? { code: "53300", message: "x" } : null) });
    expect(resultOf(await startRoute.GET(startReq()))).toEqual({ slack: "unavailable" });
  });

  it("OR04 no active installation (never connected, or revoked) → read_not_connected, no state", async () => {
    useDb({ tables: { exec_slack_installations: [] } });
    expect(resultOf(await startRoute.GET(startReq()))).toEqual({ slack: "read_not_connected" });
    useDb({ tables: { exec_slack_installations: [readingInstallation({ bot_token_enc: null, key_id: null, revoked_at: "2026-11-02T00:00:00.000Z", revoke_reason: "disconnected" })] } });
    expect(resultOf(await startRoute.GET(startReq()))).toEqual({ slack: "read_not_connected" });
    expect(issueOAuthState).not.toHaveBeenCalled();
  });

  it("OR05 the state row has purpose 'read'; a plain start stays P6's (no purpose, no user_scope, OA05's URL)", async () => {
    const state = await readState();
    expect(db.tables.exec_oauth_states).toHaveLength(1);
    expect(db.tables.exec_oauth_states[0]).toMatchObject({ nonce_hash: sha256hex(state.split(".")[1]), purpose: "read", principal_id: "ep_1" });
    expect(vi.mocked(issueOAuthState).mock.calls[0][1]).toMatchObject({ purpose: "read" });
    const res = await startRoute.GET(startReq(""));
    const url = new URL(res.headers.get("location") ?? "");
    expect([...url.searchParams.keys()].sort()).toEqual(["client_id", "redirect_uri", "scope", "state", "team"]);
    expect(vi.mocked(issueOAuthState).mock.calls[1][1]).not.toHaveProperty("purpose");
    expect(db.tables.exec_oauth_states[0].purpose ?? "install").toBe("install");
    expect(vi.mocked(auditStart).mock.calls[1][1].input).toEqual({});
  });

  it("the gate's order holds: no strong session → its own answer before the reading check", async () => {
    vi.mocked(requireExecSession).mockResolvedValueOnce({ ok: false, response: new Response(JSON.stringify({ error: "not found" }), { status: 404 }) as never });
    const res = await startRoute.GET(startReq());
    expect(res.status).toBe(404);
    expect(slackReadingSchemaReady).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Callback (§3.10.4, purpose = read)

describe("GET …/callback for a read consent", () => {
  it("OR06 happy path: the user token sealed under its own context, the granted scopes, the replaced bot token, one discover job, counts-only audit, read_connected", async () => {
    const s = slack();
    expect(resultOf(await consent())).toEqual({ slack: "read_connected" });
    expect(methods(s)).toEqual(["oauth.v2.access", "users.lookupByEmail", "auth.test", "auth.test", "conversations.open"]);
    expect(s.calls[3].headers.authorization).toBe(`Bearer ${USER_TOKEN}`);
    expect(revokes(s)).toEqual([]);
    expect(saveReadingConsent).toHaveBeenCalledTimes(1);
    expect(saveInstallation).not.toHaveBeenCalled();
    const [principal, input] = vi.mocked(saveReadingConsent).mock.calls[0];
    expect(principal).toBe(P);
    expect(input).toMatchObject({ teamId: "T0SCALED", appId: "A0EXEC", botUserId: "U0BOT", botId: "B0BOT", userId: "U0MITCH", dmChannelId: "D0MITCH",
      botScopes: [...SLACK_BOT_SCOPES], userScopes: [...ALL_USER_SCOPES] });
    expect(vi.mocked(sealSecret).mock.calls).toEqual([
      [SENTINELS.token, "exec_slack_installations.bot_token:ep_1"],
      [USER_TOKEN, "exec_slack_installations.user_token:ep_1"]
    ]);
    expect(input.userKeyId).toBe(input.userTokenSealed.split(".")[1]);
    const row = installRow();
    expect(row).toMatchObject({ reading_state: "discovering", user_scopes: [...ALL_USER_SCOPES], revoked_at: null, user_revoked_at: null });
    expect(openSecret(String(row.user_token_enc), "exec_slack_installations.user_token:ep_1")).toBe(USER_TOKEN);
    expect(openSecret(String(row.bot_token_enc), "exec_slack_installations.bot_token:ep_1")).toBe(SENTINELS.token);
    expect(vi.mocked(enqueueJob).mock.calls).toEqual([[{
      kind: "exec.slack-discover", lane: "bulk", principalId: "ep_1", payload: { installation_id: INSTALLATION_ID, reason: "consent" },
      dedupeKey: `slack-discover:consent:${INSTALLATION_ID}:${Date.parse(String(row.installed_at))}`, maxAttempts: 3
    }]]);
    expect(readEvents()).toEqual([{ actor: "owner", action: "slack.read_consent", target: `exec_slack_installations:${INSTALLATION_ID}`, input: { scopes: 9, optional: 4 } }]);
    expect(vi.mocked(auditEvent).mock.calls.filter((c) => c[1].action === "slack.install")).toEqual([]);
  });

  it("OR06 the discover job failing to enqueue is logged; the consent still stands", async () => {
    slack();
    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error("queue down"));
    expect(resultOf(await consent())).toEqual({ slack: "read_connected" });
    expect(installRow().reading_state).toBe("discovering");
    expect(out.calls().some((c) => String(c[0]).includes("discovery not enqueued"))).toBe(true);
  });

  it.each<[string, Row, boolean]>([
    ["no authed_user.access_token", { access_token: undefined }, false],
    ["a xoxb- token as the user token (never revoked: it could be the bot's)", { access_token: "xoxb-FAKE-not-a-user-token" }, false],
    ["token_type bot", { token_type: "bot" }, true],
    ["no token_type at all (read as not issued)", { token_type: undefined }, true]
  ])("OR07 %s → exchange_failed, nothing stored, the bot token never revoked", async (_label, authed, revokedUser) => {
    const s = slack({ "oauth.v2.access": readAccess(authed), "users.lookupByEmail": undefined, "auth.test": undefined, "conversations.open": undefined });
    expect(resultOf(await consent())).toEqual({ slack: "exchange_failed" });
    expect(saveReadingConsent).not.toHaveBeenCalled();
    expect(installRow()).toMatchObject({ reading_state: "none", user_token_enc: null });
    expect(revokes(s)).toEqual(revokedUser ? [`Bearer ${USER_TOKEN}`] : []);
    expect(revokes(s)).not.toContain(`Bearer ${SENTINELS.token}`);
    expect(readEvents().map((e) => [e.ok, e.error])).toEqual([[false, "exchange_failed"]]);
  });

  it.each<[string, Row, string]>([
    ["another workspace", { team: { id: "T0OTHER", name: "Other" } }, "wrong_team"],
    ["an org-wide install", { is_enterprise_install: true }, "enterprise"],
    ["another app", { app_id: "A0OTHER" }, "wrong_app"],
    ["a bot scope missing", { scope: "chat:write,im:history,im:read,im:write,users:read" }, "missing_scopes"],
    ["an extra bot scope", { scope: `${SLACK_BOT_SCOPES.join(",")},channels:history` }, "extra_scopes"],
    ["a malformed bot user id", { bot_user_id: "bot" }, "exchange_failed"]
  ])("OR08 %s → P6's code (%s) and auth.revoke once with the user token", async (_label, over, want) => {
    const s = slack({ "oauth.v2.access": readAccess({}, over), "users.lookupByEmail": undefined, "auth.test": undefined, "conversations.open": undefined });
    expect(resultOf(await consent())).toEqual({ slack: want });
    expect(revokes(s)).toEqual([`Bearer ${USER_TOKEN}`]);
    expect(saveReadingConsent).not.toHaveBeenCalled();
    expect(installRow().user_token_enc).toBeNull();
  });

  it("OR08 the identity: another member behind his email → wrong_user; no member → identity_not_found; each revokes the user token", async () => {
    let s = slack({ "users.lookupByEmail": () => ({ ok: true, user: { id: "U0JANE", deleted: false, is_bot: false } }), "auth.test": undefined, "conversations.open": undefined });
    expect(resultOf(await consent())).toEqual({ slack: "wrong_user", who: "U0MITCH" });
    expect(revokes(s)).toEqual([`Bearer ${USER_TOKEN}`]);
    s.restore();
    s = slack({ "users.lookupByEmail": () => SLACK_RECORDED.error("users_not_found"), "auth.test": undefined, "conversations.open": undefined });
    expect(resultOf(await consent())).toEqual({ slack: "identity_not_found" });
    expect(revokes(s)).toEqual([`Bearer ${USER_TOKEN}`]);
  });

  it("OR08 the bot's auth.test naming another bot → exchange_failed, the user token revoked", async () => {
    const s = slack({
      "auth.test": (_b, h) => (h.get("authorization") === `Bearer ${USER_TOKEN}` ? userAuthTest() : { ...SLACK_RECORDED.authTest(), user_id: "U0OTHERBOT" }),
      "conversations.open": undefined
    });
    expect(resultOf(await consent())).toEqual({ slack: "exchange_failed" });
    expect(revokes(s)).toEqual([`Bearer ${USER_TOKEN}`]);
  });

  it("OR09 the consenting member isn't the installation's member → wrong_user&who=<his id>, the user token revoked, nothing stored", async () => {
    useDb({ tables: { exec_slack_installations: [readingInstallation({ user_id: "U0EARLIER" })] } });
    const s = slack({ "conversations.open": undefined });
    expect(resultOf(await consent())).toEqual({ slack: "wrong_user", who: "U0MITCH" });
    expect(revokes(s)).toEqual([`Bearer ${USER_TOKEN}`]);
    expect(saveReadingConsent).not.toHaveBeenCalled();
    expect(installRow()).toMatchObject({ user_token_enc: null, reading_state: "none" });
  });

  it("OR10 the installation revoked between start and callback → read_not_connected, revoked, nothing stored", async () => {
    const state = await readState();
    installRow().revoked_at = "2026-11-08T00:00:00.000Z";
    installRow().revoke_reason = "disconnected";
    installRow().bot_token_enc = null;
    installRow().key_id = null;
    const s = slack({ "conversations.open": undefined });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state }))).toEqual({ slack: "read_not_connected" });
    expect(revokes(s)).toEqual([`Bearer ${USER_TOKEN}`]);
    expect(saveReadingConsent).not.toHaveBeenCalled();
  });

  it("OR11 a required user scope missing → missing_user_scopes, revoked", async () => {
    const s = slack({ "oauth.v2.access": readAccess({ scope: "channels:history,groups:history,channels:read,groups:read" }), "conversations.open": undefined });
    expect(resultOf(await consent())).toEqual({ slack: "missing_user_scopes" });
    expect(revokes(s)).toEqual([`Bearer ${USER_TOKEN}`]);
    expect(saveReadingConsent).not.toHaveBeenCalled();
  });

  it("OR12 an extra user scope (search:read.public) → extra_user_scopes, revoked", async () => {
    const s = slack({ "oauth.v2.access": readAccess({ scope: `${ALL_USER_SCOPES.join(",")},search:read.public` }), "conversations.open": undefined });
    expect(resultOf(await consent())).toEqual({ slack: "extra_user_scopes" });
    expect(revokes(s)).toEqual([`Bearer ${USER_TOKEN}`]);
    expect(saveReadingConsent).not.toHaveBeenCalled();
  });

  it("OR13 the optional DM scopes declined → saved with only the five granted; the half carries no im:history (no DMs read)", async () => {
    slack({ "oauth.v2.access": readAccess({ scope: SLACK_USER_SCOPES_REQUIRED.join(",") }) });
    expect(resultOf(await consent())).toEqual({ slack: "read_connected" });
    expect(vi.mocked(saveReadingConsent).mock.calls[0][1].userScopes).toEqual([...SLACK_USER_SCOPES_REQUIRED]);
    expect(installRow().user_scopes).toEqual([...SLACK_USER_SCOPES_REQUIRED]);
    const half = await getReadingHalf(P);
    expect(half?.reading.scopes).toEqual([...SLACK_USER_SCOPES_REQUIRED]);
    expect(half?.reading.scopes).not.toContain("im:history");
    expect(half?.reading.scopes).not.toContain("mpim:history");
    expect(readEvents()[0].input).toEqual({ scopes: 5, optional: 0 });
  });

  it("OR13 a duplicated user scope is de-duplicated → saved once", async () => {
    slack({ "oauth.v2.access": readAccess({ scope: `${ALL_USER_SCOPES.join(",")},users:read,channels:read` }) });
    expect(resultOf(await consent())).toEqual({ slack: "read_connected" });
    expect(installRow().user_scopes).toEqual([...ALL_USER_SCOPES]);
  });

  it.each<[string, () => object]>([
    ["another user", () => userAuthTest({ user_id: "U0JANE" })],
    ["another workspace", () => userAuthTest({ team_id: "T0OTHER" })],
    ["a refusal (invalid_auth)", () => SLACK_RECORDED.error("invalid_auth")]
  ])("OR14 auth.test of the user token answering %s → exchange_failed, revoked", async (_label, answer) => {
    const s = slack({ "auth.test": authTestBy(answer), "conversations.open": undefined });
    expect(resultOf(await consent())).toEqual({ slack: "exchange_failed" });
    expect(revokes(s)).toEqual([`Bearer ${USER_TOKEN}`]);
    expect(saveReadingConsent).not.toHaveBeenCalled();
  });

  it("OR14 auth.test of the user token unreachable (HTTP 503) → slack_unavailable, revoked", async () => {
    const s = slack({ "auth.test": (_b, h) => (h.get("authorization") === `Bearer ${USER_TOKEN}` ? new Response("", { status: 503 }) : SLACK_RECORDED.authTest()), "conversations.open": undefined });
    expect(resultOf(await consent())).toEqual({ slack: "slack_unavailable" });
    expect(revokes(s)).toEqual([`Bearer ${USER_TOKEN}`]);
  });

  it("OR15 a second reader in the workspace (the reading key taken) → read_taken, revoked, nothing stored for him", async () => {
    const other = liveHalf({ id: `esi_${"9".repeat(32)}`, principal_id: "ep_2", slack_dm_channel_id: "D0SECOND" });
    // Seal the other principal's tokens for ep_2 so the row is consistent.
    const otherUser = sealSecret("xoxp-FAKE-other-reader-token", "exec_slack_installations.user_token:ep_2");
    const otherBot = sealSecret("xoxb-FAKE-other-bot-token", "exec_slack_installations.bot_token:ep_2");
    vi.mocked(sealSecret).mockClear();
    Object.assign(other, { user_token_enc: otherUser, user_key_id: otherUser.split(".")[1], bot_token_enc: otherBot, key_id: otherBot.split(".")[1], user_id: "U0SECOND" });
    useDb({ tables: { exec_slack_installations: [readingInstallation(), other] } });
    const s = slack();
    expect(resultOf(await consent())).toEqual({ slack: "read_taken" });
    expect(revokes(s)).toEqual([`Bearer ${USER_TOKEN}`]);
    expect(installRow()).toMatchObject({ user_token_enc: null, reading_state: "none" });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("OR15 the save failing → unavailable, revoked", async () => {
    slack();
    const state = await readState();
    vi.mocked(saveReadingConsent).mockRejectedValueOnce(new Error("store down"));
    const s = slack();
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state }))).toEqual({ slack: "unavailable" });
    expect(revokes(s)).toEqual([`Bearer ${USER_TOKEN}`]);
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(readEvents().map((e) => e.error)).toEqual(["unavailable"]);
  });

  it("OR15 the installation gone at the save (no_installation) → read_not_connected, revoked", async () => {
    slack();
    const state = await readState();
    vi.mocked(saveReadingConsent).mockResolvedValueOnce({ outcome: "no_installation" });
    const s = slack();
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state }))).toEqual({ slack: "read_not_connected" });
    expect(revokes(s)).toEqual([`Bearer ${USER_TOKEN}`]);
  });

  it("OR15 the DM channel failing to open → slack_unavailable, revoked", async () => {
    const s = slack({ "conversations.open": () => SLACK_RECORDED.error("internal_error") });
    expect(resultOf(await consent())).toEqual({ slack: "slack_unavailable" });
    expect(revokes(s)).toEqual([`Bearer ${USER_TOKEN}`]);
  });

  it("the exchange itself failing → P6's codes, nothing to revoke", async () => {
    let s = slack({ "oauth.v2.access": () => SLACK_RECORDED.error("invalid_code") });
    expect(resultOf(await consent())).toEqual({ slack: "exchange_failed" });
    expect(revokes(s)).toEqual([]);
    s.restore();
    s = slack({ "oauth.v2.access": () => new Response("down", { status: 503 }) });
    expect(resultOf(await consent())).toEqual({ slack: "slack_unavailable" });
    expect(revokes(s)).toEqual([]);
  });

  it("error=access_denied → denied, no exchange, audited as slack.read_consent ok: false", async () => {
    const s = slack();
    expect(resultOf(await callback({ error: "access_denied", state: await readState() }))).toEqual({ slack: "denied" });
    expect(s.calls).toEqual([]);
    expect(readEvents()).toEqual([{ actor: "owner", action: "slack.read_consent", target: "exec_slack_installations", input: {}, ok: false, error: "denied" }]);
  });

  it("a failed revoke of the user grant is logged by code only; the refusal stands", async () => {
    const s = slack({ "oauth.v2.access": readAccess({}, { app_id: "A0OTHER" }), "auth.revoke": () => SLACK_RECORDED.error("internal_error") });
    expect(resultOf(await consent())).toEqual({ slack: "wrong_app" });
    expect(revokes(s)).toHaveLength(1);
    expect(out.calls().some((c) => String(c[0]).includes("(internal_error)"))).toBe(true);
  });
});

describe("OR16 a plain install while a reading half exists (C27)", () => {
  async function installState(): Promise<string> {
    const res = await startRoute.GET(startReq(""));
    expect(res.status).toBe(302);
    return new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "";
  }
  const installAccess = readAccess({ access_token: "xoxp-FAKE-returned-user-token", scope: "search:read" });

  it("a live user half: the returned user token is neither revoked nor stored; the bot install completes", async () => {
    useDb({ tables: { exec_slack_installations: [liveHalf()] } });
    const s = slack({ "oauth.v2.access": installAccess });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: await installState() }))).toEqual({ slack: "connected" });
    expect(revokes(s)).toEqual([]);
    const row = installRow();
    expect(openSecret(String(row.user_token_enc), "exec_slack_installations.user_token:ep_1")).toBe(USER_TOKEN);
    expect(JSON.stringify([db.tables, db.calls])).not.toContain("returned-user-token");
    expect(saveReadingConsent).not.toHaveBeenCalled();
  });

  it("no live user half: the returned user token is revoked at once (K1)", async () => {
    const s = slack({ "oauth.v2.access": installAccess });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: await installState() }))).toEqual({ slack: "connected" });
    expect(revokes(s)).toEqual(["Bearer xoxp-FAKE-returned-user-token"]);
  });

  it("a revoked reading half counts as none: revoked", async () => {
    useDb({ tables: { exec_slack_installations: [readingInstallation({ reading_state: "revoked", user_revoked_at: "2026-11-03T00:00:00.000Z", user_revoke_reason: "stopped" })] } });
    const s = slack({ "oauth.v2.access": installAccess });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: await installState() }))).toEqual({ slack: "connected" });
    expect(revokes(s)).toEqual(["Bearer xoxp-FAKE-returned-user-token"]);
  });

  it("a P6-only database (no reading columns): revoked, as P6 does", async () => {
    db = createFakeSlackDb() as unknown as FakeSlackReadDb;
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    const s = slack({ "oauth.v2.access": installAccess });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: await installState() }))).toEqual({ slack: "connected" });
    expect(revokes(s)).toEqual(["Bearer xoxp-FAKE-returned-user-token"]);
  });
});

describe("OR17 a replayed or expired read state", () => {
  it("replayed → state_invalid, no second exchange", async () => {
    const s = slack();
    const state = await readState();
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state }))).toEqual({ slack: "read_connected" });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state }))).toEqual({ slack: "state_invalid" });
    expect(methods(s).filter((m) => m === "oauth.v2.access")).toHaveLength(1);
  });

  it("expired → state_expired, consumed, no exchange", async () => {
    const s = slack({ "oauth.v2.access": undefined });
    const nonce = "8".repeat(64);
    const now = Date.now();
    useDb({
      tables: {
        exec_slack_installations: [readingInstallation()],
        exec_oauth_states: [{
          nonce_hash: sha256hex(nonce), provider: "slack", principal_id: "ep_1", auth_user_id: AUTH, session_id: SESSION, purpose: "read",
          created_at: new Date(now - 11 * 60_000).toISOString(), expires_at: new Date(now - 60_000).toISOString()
        }]
      }
    });
    const state = signState("slack-oauth", `s1.${nonce}.${Math.floor((now - 60_000) / 1000)}`);
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state }))).toEqual({ slack: "state_expired" });
    expect(db.tables.exec_oauth_states).toEqual([]);
    expect(s.calls).toEqual([]);
    expect(readEvents()).toEqual([]);
  });
});

describe("OR18 the user token and the code never leave", () => {
  it("not in a log line, an audit input, the redirect, a stored plaintext or a job payload", async () => {
    slack();
    const res = await consent();
    expect(resultOf(res)).toEqual({ slack: "read_connected" });
    assertNoSlackText([out.calls(), auditCalls(), res.headers.get("location"), vi.mocked(enqueueJob).mock.calls], { label: "OR18" });
    expect(JSON.stringify([res.headers.get("location"), auditCalls(), out.calls()])).not.toContain(SENTINELS.oauthCode);
    const row = installRow();
    expect(String(row.user_token_enc)).not.toContain(USER_TOKEN);
    expect(JSON.stringify(db.calls.map((c) => c.payload))).not.toContain(USER_TOKEN);
  });

  it("every read-consent result has its Settings copy (the five P7a codes included)", () => {
    for (const code of ["read_connected", "read_not_connected", "missing_user_scopes", "extra_user_scopes", "read_taken"] as const) {
      expect(typeof SLACK_READ_COPY.connectResult[code]).toBe("string");
    }
  });
});
