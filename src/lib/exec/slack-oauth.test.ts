import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/jobs", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecSession: vi.fn() }));
vi.mock("@/lib/exec/audit", () => ({ auditStart: vi.fn(), auditFinish: vi.fn(), auditEvent: vi.fn() }));
vi.mock("@/lib/exec/http", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/http")>()), rateLimit: vi.fn() }));
// Area A's real store over the fake DB, with call spies.
vi.mock("@/lib/exec/slack-install", async (orig) => {
  const a = await orig<typeof import("@/lib/exec/slack-install")>();
  return {
    ...a,
    issueOAuthState: vi.fn(a.issueOAuthState),
    consumeOAuthState: vi.fn(a.consumeOAuthState),
    saveInstallation: vi.fn(a.saveInstallation),
    slackSchemaReady: vi.fn(a.slackSchemaReady)
  };
});
vi.mock("@/lib/exec/crypto", async (orig) => {
  const a = await orig<typeof import("@/lib/exec/crypto")>();
  return { ...a, sealSecret: vi.fn(a.sealSecret) };
});

import * as callbackRoute from "@/app/api/integrations/exec-slack/callback/route";
import * as startRoute from "@/app/api/integrations/exec-slack/start/route";
import { installFakeSlack, SLACK_RECORDED, type FakeSlackHandler } from "@/lib/exec/__tests__/fake-slack-api";
import { createFakeSlackDb, type FakeSlackDb, type FakeSlackDbSeed, type Row } from "@/lib/exec/__tests__/fake-slack-db";
import { SENTINELS, findSentinel } from "@/lib/exec/__tests__/slack-assert";
import { INSTALLATION_ID, installationRow, slackEnv, testPrincipal } from "@/lib/exec/__tests__/slack-route-helpers";
import { requireExecSession } from "@/lib/exec/access";
import { auditEvent, auditFinish, auditStart } from "@/lib/exec/audit";
import { openSecret, sealSecret, signState } from "@/lib/exec/crypto";
import { jsonError, rateLimit } from "@/lib/exec/http";
import { consumeOAuthState, issueOAuthState, saveInstallation, slackSchemaReady } from "@/lib/exec/slack-install";
import { isCanonicalRequestHost } from "@/lib/exec/slack-oauth";
import { SLACK_BOT_SCOPES, type SlackMethod } from "@/lib/exec/slack-types";
import { AuditUnavailableError } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// The Slack OAuth install (P6 contract §3.10.3-4, K5, C1, C2, C24, C25, C44, C45;
// Area C): OA01-OA23 incl. OA11b, through the two route files. The store is
// Area A's real slack-install.ts over fake-slack-db.ts (so the state row, its
// single use and the in-place reinstall are the real ones), the Slack Web API is
// fake-slack-api.ts with recorded shapes, and the state mac is crypto.ts's real
// HMAC under a test key. The session gate, the audit and the rate limiter are
// mocks at their module boundary.

const AUTH = "11111111-1111-4111-8111-111111111111";
const SESSION = "sess-strong-1";
const P = testPrincipal("ep_1", SENTINELS.email);
const START_URL = "https://operations.scaledai.org/api/integrations/exec-slack/start";
const CALLBACK_URL = "https://operations.scaledai.org/api/integrations/exec-slack/callback";
const SETTINGS = "https://operations.scaledai.org/executive/settings";
const RAILWAY = "delegationdoer-production.up.railway.app";
const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

let db: FakeSlackDb;
let spies: ReturnType<typeof vi.spyOn>[];

function useEnv(over: Record<string, string | undefined> = {}): void {
  for (const [k, v] of Object.entries(slackEnv(over))) vi.stubEnv(k, v);
}
function useDb(seed?: FakeSlackDbSeed): FakeSlackDb {
  db = createFakeSlackDb(seed);
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  return db;
}
function session(over: Partial<{ authUserId: string; sessionId: string | null; principal: typeof P }> = {}): void {
  vi.mocked(requireExecSession).mockResolvedValue({ ok: true, principal: over.principal ?? P, authUserId: over.authUserId ?? AUTH, sessionId: over.sessionId === undefined ? SESSION : over.sessionId });
}

/** Slack answering a clean bot-only install by Mitchell; any method can be overridden or removed (undefined = no handler). */
function slack(over: Partial<Record<SlackMethod, FakeSlackHandler | undefined>> = {}) {
  const handlers: Partial<Record<SlackMethod, FakeSlackHandler>> = {
    "oauth.v2.access": () => ({ ...SLACK_RECORDED.oauthAccess(), access_token: SENTINELS.token }),
    "users.lookupByEmail": () => SLACK_RECORDED.lookupByEmail(),
    "auth.test": () => SLACK_RECORDED.authTest(),
    "conversations.open": () => SLACK_RECORDED.conversationsOpen()
  };
  for (const [k, v] of Object.entries(over) as [SlackMethod, FakeSlackHandler | undefined][]) {
    if (v === undefined) delete handlers[k];
    else handlers[k] = v;
  }
  return installFakeSlack(handlers);
}
const access = (over: Row = {}): FakeSlackHandler => () => ({ ...SLACK_RECORDED.oauthAccess(), access_token: SENTINELS.token, ...over });

function startReq(headers: Record<string, string> = {}): Request {
  return new Request(START_URL, { headers: { host: "operations.scaledai.org", "sec-fetch-site": "same-origin", ...headers } });
}
function callbackReq(query: Record<string, string> | string): Request {
  const q = typeof query === "string" ? query : new URLSearchParams(query).toString();
  return new Request(`${CALLBACK_URL}?${q}`, { headers: { host: "operations.scaledai.org", "sec-fetch-site": "cross-site" } });
}
/** The 303's ?slack= result (and who), after checking it goes to Settings with the two headers. */
function resultOf(res: Response, origin = SETTINGS): Record<string, string> {
  expect(res.status).toBe(303);
  expectGuarded(res);
  const loc = new URL(res.headers.get("location") ?? "");
  expect(`${loc.origin}${loc.pathname}`).toBe(origin);
  return Object.fromEntries(loc.searchParams);
}
function expectGuarded(res: Response): void {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
}
/** A start that reached Slack: the state token from the authorize URL. */
async function startState(): Promise<string> {
  const res = await startRoute.GET(startReq());
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "";
}
const callback = (query: Record<string, string> | string) => callbackRoute.GET(callbackReq(query));
const consoleCalls = () => spies.flatMap((s) => s.mock.calls);
/** What the audit rows would hold (the principal argument aside: it is the principal, not row content). */
const auditCalls = () => [vi.mocked(auditStart).mock.calls.map((c) => c[1]), vi.mocked(auditFinish).mock.calls, vi.mocked(auditEvent).mock.calls.map((c) => c[1])];
const installEvents = () => vi.mocked(auditEvent).mock.calls.filter((c) => c[1].action === "slack.install").map((c) => c[1]);
const methods = (s: { calls: { method: SlackMethod }[] }) => s.calls.map((c) => c.method);

beforeEach(() => {
  useEnv();
  useDb();
  session();
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  vi.mocked(auditStart).mockReset().mockResolvedValue(77);
  vi.mocked(auditFinish).mockReset().mockResolvedValue(undefined);
  vi.mocked(auditEvent).mockReset().mockResolvedValue(undefined);
  vi.mocked(rateLimit).mockReset().mockResolvedValue({ ok: true });
  for (const fn of [issueOAuthState, consumeOAuthState, saveInstallation, slackSchemaReady, sealSecret]) vi.mocked(fn).mockReset();
});

afterEach(() => {
  // Nothing that could identify Mitchell, his Slack app or a grant reached a log line or an audit row.
  expect(findSentinel([consoleCalls(), auditCalls()])).toBeNull();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("route modules", () => {
  it("start and callback are dynamic, on Node, and export GET only", () => {
    for (const m of [startRoute, callbackRoute]) {
      expect(m.dynamic).toBe("force-dynamic");
      expect(m.runtime).toBe("nodejs");
      expect(Object.keys(m).sort()).toEqual(["GET", "dynamic", "runtime"]);
    }
  });
});

describe("isCanonicalRequestHost (C45)", () => {
  const h = (init: Record<string, string>) => new Headers(init);
  it.each<[Record<string, string>, boolean]>([
    [{ host: "operations.scaledai.org" }, true],
    [{ host: "OPERATIONS.SCALEDAI.ORG:443" }, true],
    [{ host: "operations.scaledai.org." }, true],
    [{ "x-forwarded-host": "operations.scaledai.org., other.example", host: RAILWAY }, true],
    [{ "x-forwarded-host": " operations.scaledai.org ", host: RAILWAY }, true],
    [{ "x-forwarded-host": RAILWAY, host: "operations.scaledai.org" }, false],
    [{ host: RAILWAY }, false],
    [{ host: "operations.scaledai.org:8443" }, false],
    [{ host: "operations.scaledai.org.evil.example" }, false],
    [{ "x-forwarded-host": "", host: "operations.scaledai.org" }, true],
    [{}, false]
  ])("%j → %s", (init, want) => {
    expect(isCanonicalRequestHost(h(init))).toBe(want);
  });
  it("takes next/headers' headers() shape (anything with get)", () => {
    expect(isCanonicalRequestHost({ get: (n: string) => (n === "host" ? "operations.scaledai.org" : null) })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Start

describe("GET …/start", () => {
  it("OA01 without a strong session → the gate's own answer (404), with no-store and no-referrer", async () => {
    vi.mocked(requireExecSession).mockResolvedValue({ ok: false, response: NextResponse.json({ error: "not found" }, { status: 404 }) });
    const res = await startRoute.GET(startReq());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expectGuarded(res);
    expect(vi.mocked(requireExecSession).mock.calls[0].slice(1)).toEqual(["GET /api/integrations/exec-slack/start", { requireStrongSignIn: true }]);
    expect(issueOAuthState).not.toHaveBeenCalled();
  });

  it("OA02 sec-fetch-site: cross-site → 403 { error: forbidden }", async () => {
    const res = await startRoute.GET(startReq({ "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expectGuarded(res);
    expect(auditStart).not.toHaveBeenCalled();
  });

  it("OA03 the Slack config missing, or EXEC_TOKEN_KEY missing → 303 not_configured", async () => {
    useEnv({ EXEC_SLACK_CLIENT_SECRET: undefined });
    expect(resultOf(await startRoute.GET(startReq()))).toEqual({ slack: "not_configured" });
    useEnv({ EXEC_TOKEN_KEY: undefined });
    expect(resultOf(await startRoute.GET(startReq()))).toEqual({ slack: "not_configured" });
    expect(auditStart).not.toHaveBeenCalled();
  });

  it("OA04 the P6 migration missing → not_installed; the check throwing → unavailable", async () => {
    useDb({ missing: ["exec_slack_installations"] });
    expect(resultOf(await startRoute.GET(startReq()))).toEqual({ slack: "not_installed" });
    useDb({ fail: () => ({ code: "53300", message: "too many connections" }) });
    expect(resultOf(await startRoute.GET(startReq()))).toEqual({ slack: "unavailable" });
    expect(auditStart).not.toHaveBeenCalled();
  });

  it("no session id to bind → session_unbound, no state", async () => {
    session({ sessionId: null });
    expect(resultOf(await startRoute.GET(startReq()))).toEqual({ slack: "session_unbound" });
    expect(issueOAuthState).not.toHaveBeenCalled();
  });

  it("OA05 the 302: slack.com/oauth/v2/authorize with exactly client_id, scope, redirect_uri, state, team; the six bot scopes; no user_scope", async () => {
    useEnv({ NEXT_PUBLIC_APP_URL: `https://${RAILWAY}` });
    const res = await startRoute.GET(startReq());
    expect(res.status).toBe(302);
    expectGuarded(res);
    const url = new URL(res.headers.get("location") ?? "");
    expect([url.protocol, url.host, url.pathname]).toEqual(["https:", "slack.com", "/oauth/v2/authorize"]);
    expect([...url.searchParams.keys()].sort()).toEqual(["client_id", "redirect_uri", "scope", "state", "team"]);
    expect(url.searchParams.has("user_scope")).toBe(false);
    expect(url.searchParams.get("scope")?.split(",")).toEqual([...SLACK_BOT_SCOPES]);
    expect(url.searchParams.get("redirect_uri")).toBe("https://operations.scaledai.org/api/integrations/exec-slack/callback");
    expect(url.searchParams.get("client_id")).toBe("1111111111.2222222222");
    expect(url.searchParams.get("team")).toBe("T0SCALED");
    expect(url.searchParams.get("state")).toMatch(/^s1\.[0-9a-f]{64}\.[0-9]{10}\.[A-Za-z0-9_-]{43}$/);
    expect(auditStart).toHaveBeenCalledWith(P, { actor: "owner", action: "slack.oauth.start", target: "exec_oauth_states", input: {} });
    expect(auditFinish).toHaveBeenCalledWith(77, { ok: true });
    expect(rateLimit).toHaveBeenCalledWith(P, "slack_connect", 10, 600_000);
  });

  it("OA06 the state row holds sha256(nonce), the principal, the auth user and the session; the raw nonce never reaches the DB", async () => {
    const before = Date.now();
    const state = await startState();
    const nonce = state.split(".")[1];
    const exp = Number(state.split(".")[2]);
    const rows = db.tables.exec_oauth_states;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nonce_hash: sha256hex(nonce), provider: "slack", principal_id: "ep_1", auth_user_id: AUTH, session_id: SESSION });
    expect(Date.parse(String(rows[0].expires_at)) - Date.parse(String(rows[0].created_at))).toBe(600_000);
    expect(exp).toBeGreaterThanOrEqual(Math.floor(before / 1000) + 600);
    expect(exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 600);
    expect(JSON.stringify(db.calls)).not.toContain(nonce);
    expect(vi.mocked(issueOAuthState).mock.calls[0][1]).toEqual({ nonceHash: sha256hex(nonce), authUserId: AUTH, sessionId: SESSION, ttlSeconds: 600 });
  });

  it("OA06 a second start replaces the first live state (one flow at a time)", async () => {
    const first = await startState();
    const second = await startState();
    expect(db.tables.exec_oauth_states.map((r) => r.nonce_hash)).toEqual([sha256hex(second.split(".")[1])]);
    expect(first).not.toBe(second);
  });

  it("OA07 the rate limit hit → rate_limited; its count unreadable → unavailable; the audit unavailable → unavailable", async () => {
    vi.mocked(rateLimit).mockResolvedValueOnce({ ok: false, response: jsonError(429, "rate_limited", { retryAfterSeconds: 30 }) });
    expect(resultOf(await startRoute.GET(startReq()))).toEqual({ slack: "rate_limited" });
    vi.mocked(rateLimit).mockResolvedValueOnce({ ok: false, response: jsonError(503, "unavailable") });
    expect(resultOf(await startRoute.GET(startReq()))).toEqual({ slack: "unavailable" });
    expect(auditStart).not.toHaveBeenCalled();
    vi.mocked(auditStart).mockRejectedValueOnce(new AuditUnavailableError("audit log unavailable"));
    expect(resultOf(await startRoute.GET(startReq()))).toEqual({ slack: "unavailable" });
    expect(issueOAuthState).not.toHaveBeenCalled();
    expect(db.tables.exec_oauth_states).toEqual([]);
  });

  it("the state store failing → unavailable, the audit finished ok: false; the table missing there → not_installed", async () => {
    useDb({ fail: (c) => (c.kind === "insert" && c.target === "exec_oauth_states" ? { code: "53300", message: "x" } : null) });
    expect(resultOf(await startRoute.GET(startReq()))).toEqual({ slack: "unavailable" });
    expect(auditFinish).toHaveBeenLastCalledWith(77, { ok: false, error: "unavailable" });
    useDb({ missing: ["exec_oauth_states"] });
    expect(resultOf(await startRoute.GET(startReq()))).toEqual({ slack: "not_installed" });
    expect(auditFinish).toHaveBeenLastCalledWith(77, { ok: false, error: "not_installed" });
  });

  it("OA23 on the Railway host (x-forwarded-host, or Host only) → 303 to exactly the canonical wrong_host page; no state, audit or rate read", async () => {
    const hosts: Record<string, string>[] = [{ "x-forwarded-host": RAILWAY, host: RAILWAY }, { host: RAILWAY }];
    for (const headers of hosts) {
      const res = await startRoute.GET(new Request(START_URL, { headers: { "sec-fetch-site": "same-origin", ...headers } }));
      expect(res.status).toBe(303);
      expectGuarded(res);
      expect(res.headers.get("location")).toBe("https://operations.scaledai.org/executive/settings?slack=wrong_host");
    }
    expect(issueOAuthState).not.toHaveBeenCalled();
    expect(auditStart).not.toHaveBeenCalled();
    expect(rateLimit).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
  });

  it("OA23 the canonical host behind a trailing dot and a list, or upper-case with :443 → proceeds to Slack", async () => {
    const hosts: Record<string, string>[] = [{ "x-forwarded-host": "operations.scaledai.org., other", host: RAILWAY }, { host: "OPERATIONS.SCALEDAI.ORG:443" }];
    for (const headers of hosts) {
      const res = await startRoute.GET(new Request(START_URL, { headers: { "sec-fetch-site": "same-origin", ...headers } }));
      expect(res.status).toBe(302);
    }
  });
});

// ---------------------------------------------------------------------------
// Callback

describe("GET …/callback: the state", () => {
  it("the gate's own answer without a strong session (404), nothing consumed", async () => {
    const state = await startState();
    vi.mocked(requireExecSession).mockResolvedValue({ ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) });
    const res = await callback({ code: SENTINELS.oauthCode, state });
    expect(res.status).toBe(401);
    expectGuarded(res);
    expect(vi.mocked(requireExecSession).mock.calls.at(-1)?.slice(1)).toEqual(["GET /api/integrations/exec-slack/callback", { requireStrongSignIn: true }]);
    expect(consumeOAuthState).not.toHaveBeenCalled();
    expect(db.tables.exec_oauth_states).toHaveLength(1);
  });

  it("OA14 a replayed state (second callback with the same state) → state_invalid, no second exchange", async () => {
    const s = slack();
    const state = await startState();
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state }))).toEqual({ slack: "connected" });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state }))).toEqual({ slack: "state_invalid" });
    expect(methods(s).filter((m) => m === "oauth.v2.access")).toHaveLength(1);
  });

  it("OA15 a row created 11 min ago that expired 1 min ago, mac valid → state_expired, the row consumed, no exchange (fake DB)", async () => {
    const s = slack({ "oauth.v2.access": undefined });
    const nonce = "7".repeat(64);
    const now = Date.now();
    useDb({
      tables: {
        exec_oauth_states: [{
          nonce_hash: sha256hex(nonce), provider: "slack", principal_id: "ep_1", auth_user_id: AUTH, session_id: SESSION,
          created_at: new Date(now - 11 * 60_000).toISOString(), expires_at: new Date(now - 60_000).toISOString()
        }]
      }
    });
    const state = signState("slack-oauth", `s1.${nonce}.${Math.floor((now - 60_000) / 1000)}`);
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state }))).toEqual({ slack: "state_expired" });
    expect(db.tables.exec_oauth_states).toEqual([]);
    expect(s.calls).toEqual([]);
    expect(installEvents()).toEqual([]);
  });

  it("OA16 a state from another session, another auth user or another principal → state_invalid, no exchange", async () => {
    const s = slack({ "oauth.v2.access": undefined });
    for (const other of [{ sessionId: "sess-other" }, { authUserId: "22222222-2222-4222-8222-222222222222" }, { principal: testPrincipal("ep_2") }, { sessionId: null }]) {
      session();
      const state = await startState();
      session(other);
      expect(resultOf(await callback({ code: SENTINELS.oauthCode, state }))).toEqual({ slack: "state_invalid" });
    }
    expect(s.calls).toEqual([]);
    expect(db.tables.exec_oauth_states).toEqual([]);
  });

  it("OA17 a tampered mac → state_invalid and consumeOAuthState not called; a signed payload of another shape too", async () => {
    const state = await startState();
    const flipped = state.slice(0, -1) + (state.endsWith("A") ? "B" : "A");
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: flipped }))).toEqual({ slack: "state_invalid" });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: signState("slack-oauth", "s2.abc.1793977800") }))).toEqual({ slack: "state_invalid" });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: SENTINELS.oauthState }))).toEqual({ slack: "state_invalid" });
    expect(consumeOAuthState).not.toHaveBeenCalled();
    expect(db.tables.exec_oauth_states).toHaveLength(1);
  });

  it("the query: no state, a repeated key or an overlong value → state_invalid before anything is consumed", async () => {
    const state = await startState();
    for (const q of [
      `code=${SENTINELS.oauthCode}`,
      `code=a&state=${state}&state=${state}`,
      `code=a&code=b&state=${state}`,
      `code=${"c".repeat(401)}&state=${state}`,
      `error=${"e".repeat(101)}&state=${state}`
    ]) {
      expect(resultOf(await callback(q))).toEqual({ slack: "state_invalid" });
    }
    expect(consumeOAuthState).not.toHaveBeenCalled();
  });

  it("OA18 error=access_denied → denied, the row consumed, no exchange, slack.install audited ok: false", async () => {
    const s = slack({ "oauth.v2.access": undefined });
    const state = await startState();
    expect(resultOf(await callback({ error: "access_denied", state }))).toEqual({ slack: "denied" });
    expect(db.tables.exec_oauth_states).toEqual([]);
    expect(s.calls).toEqual([]);
    expect(installEvents()).toEqual([{ actor: "owner", action: "slack.install", target: "exec_slack_installations", input: {}, ok: false, error: "denied" }]);
  });

  it("a valid state but no code → state_invalid (consumed, audited)", async () => {
    const state = await startState();
    expect(resultOf(await callback({ state }))).toEqual({ slack: "state_invalid" });
    expect(db.tables.exec_oauth_states).toEqual([]);
    expect(installEvents().map((e) => e.error)).toEqual(["state_invalid"]);
  });
});

describe("GET …/callback: Slack's answer", () => {
  it("OA20 success → the exchange over HTTP Basic, sealSecret with the principal's context, saveInstallation with the D… channel and bot_id, connected, slack.install audited without a token", async () => {
    const s = slack();
    const state = await startState();
    const res = await callback({ code: SENTINELS.oauthCode, state });
    expect(resultOf(res)).toEqual({ slack: "connected" });
    expect(methods(s)).toEqual(["oauth.v2.access", "users.lookupByEmail", "auth.test", "conversations.open"]);
    const exchange = s.calls[0];
    expect(exchange.headers.authorization).toBe(`Basic ${Buffer.from(`1111111111.2222222222:${SENTINELS.clientSecret}`).toString("base64")}`);
    expect(exchange.body).toEqual({ code: SENTINELS.oauthCode, redirect_uri: "https://operations.scaledai.org/api/integrations/exec-slack/callback" });
    expect(s.calls[1].headers.authorization).toBe(`Bearer ${SENTINELS.token}`);
    expect(s.calls[1].body).toEqual({ email: SENTINELS.email });
    expect(s.calls[3].body).toEqual({ users: "U0MITCH" });
    expect(sealSecret).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sealSecret).mock.calls[0]).toEqual([SENTINELS.token, "exec_slack_installations.bot_token:ep_1"]);
    const saved = vi.mocked(saveInstallation).mock.calls[0];
    expect(saved[0]).toBe(P);
    expect(saved[1]).toMatchObject({ teamId: "T0SCALED", appId: "A0EXEC", botUserId: "U0BOT", botId: "B0BOT", userId: "U0MITCH", dmChannelId: "D0MITCH", botScopes: [...SLACK_BOT_SCOPES] });
    expect(saved[1].keyId).toBe(saved[1].botTokenSealed.split(".")[1]);
    const [row] = db.tables.exec_slack_installations;
    expect(row).toMatchObject({ principal_id: "ep_1", slack_dm_channel_id: "D0MITCH", bot_id: "B0BOT", user_id: "U0MITCH", revoked_at: null, user_token_enc: null });
    expect(openSecret(String(row.bot_token_enc), "exec_slack_installations.bot_token:ep_1")).toBe(SENTINELS.token);
    expect(installEvents()).toEqual([{ actor: "owner", action: "slack.install", target: `exec_slack_installations:${String(row.id)}`, input: { replaced: false, scopes: 6 } }]);
    expect(findSentinel([db.calls.map((c) => c.payload), [...res.headers]])).toBeNull();
  });

  it("the redirect goes to appOrigin() (NEXT_PUBLIC_APP_URL) like every Settings answer", async () => {
    slack();
    const state = await startState();
    useEnv({ NEXT_PUBLIC_APP_URL: "https://dd.example.test/" });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state }), "https://dd.example.test/executive/settings")).toEqual({ slack: "connected" });
  });

  it("OA08 a team mismatch → wrong_team, saveInstallation not called, no identity lookup", async () => {
    const s = slack({ "oauth.v2.access": access({ team: { id: "T0OTHER", name: "Other" } }), "users.lookupByEmail": undefined, "auth.test": undefined, "conversations.open": undefined });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: await startState() }))).toEqual({ slack: "wrong_team" });
    expect(saveInstallation).not.toHaveBeenCalled();
    expect(methods(s)).toEqual(["oauth.v2.access"]);
    expect(installEvents().map((e) => [e.ok, e.error])).toEqual([[false, "wrong_team"]]);
  });

  it("OA09 is_enterprise_install: true → enterprise; an enterprise object with false → enterprise", async () => {
    for (const over of [{ is_enterprise_install: true }, { enterprise: { id: "E0GRID", name: "Grid" }, is_enterprise_install: false }]) {
      const s = slack({ "oauth.v2.access": access(over), "users.lookupByEmail": undefined, "auth.test": undefined, "conversations.open": undefined });
      expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: await startState() }))).toEqual({ slack: "enterprise" });
      s.restore();
    }
    expect(saveInstallation).not.toHaveBeenCalled();
  });

  it("OA10 an app_id mismatch → wrong_app", async () => {
    slack({ "oauth.v2.access": access({ app_id: "A0OTHER" }), "users.lookupByEmail": undefined, "auth.test": undefined, "conversations.open": undefined });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: await startState() }))).toEqual({ slack: "wrong_app" });
    expect(saveInstallation).not.toHaveBeenCalled();
  });

  it("OA11 a scope missing → missing_scopes", async () => {
    slack({ "oauth.v2.access": access({ scope: "chat:write,im:history,im:read,im:write,users:read" }), "users.lookupByEmail": undefined, "auth.test": undefined, "conversations.open": undefined });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: await startState() }))).toEqual({ slack: "missing_scopes" });
    expect(saveInstallation).not.toHaveBeenCalled();
  });

  it("OA11b the six plus channels:history → extra_scopes; saveInstallation and auth.revoke not called", async () => {
    const s = slack({
      "oauth.v2.access": access({ scope: `${SLACK_BOT_SCOPES.join(",")},channels:history` }),
      "users.lookupByEmail": undefined, "auth.test": undefined, "conversations.open": undefined
    });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: await startState() }))).toEqual({ slack: "extra_scopes" });
    expect(saveInstallation).not.toHaveBeenCalled();
    expect(methods(s)).toEqual(["oauth.v2.access"]);
    expect(db.tables.exec_slack_installations).toEqual([]);
  });

  it("OA11b a duplicated scope in the string is de-duplicated → connected", async () => {
    slack({ "oauth.v2.access": access({ scope: `chat:write,${SLACK_BOT_SCOPES.join(",")},users:read` }) });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: await startState() }))).toEqual({ slack: "connected" });
  });

  it("OA12 another Slack member installed → wrong_user&who=<authed id>, nothing stored, the bot token not revoked", async () => {
    const s = slack({
      "users.lookupByEmail": () => ({ ok: true, user: { id: "U0JANE", team_id: "T0SCALED", deleted: false, is_bot: false, name: SENTINELS.displayName } }),
      "auth.test": undefined,
      "conversations.open": undefined
    });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: await startState() }))).toEqual({ slack: "wrong_user", who: "U0MITCH" });
    expect(methods(s)).toEqual(["oauth.v2.access", "users.lookupByEmail"]);
    expect(saveInstallation).not.toHaveBeenCalled();
    expect(db.tables.exec_slack_installations).toEqual([]);
    expect(installEvents().map((e) => e.error)).toEqual(["wrong_user"]);
  });

  it("OA13 users_not_found, a deleted member or a bot → identity_not_found", async () => {
    const answers = [
      () => SLACK_RECORDED.error("users_not_found"),
      () => ({ ok: true, user: { id: "U0MITCH", deleted: true, is_bot: false } }),
      () => ({ ok: true, user: { id: "U0MITCH", deleted: false, is_bot: true } })
    ];
    for (const lookup of answers) {
      const s = slack({ "users.lookupByEmail": lookup, "auth.test": undefined, "conversations.open": undefined });
      expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: await startState() }))).toEqual({ slack: "identity_not_found" });
      s.restore();
    }
    expect(saveInstallation).not.toHaveBeenCalled();
  });

  it("OA19 an unexpected authed_user.access_token → auth.revoke on that user token only, never stored; the install still completes", async () => {
    const s = slack({
      "oauth.v2.access": access({ authed_user: { id: "U0MITCH", access_token: SENTINELS.userToken, token_type: "user", scope: "search:read" } }),
      "auth.revoke": () => SLACK_RECORDED.revoke()
    });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: await startState() }))).toEqual({ slack: "connected" });
    const revokes = s.calls.filter((c) => c.method === "auth.revoke");
    expect(revokes.map((c) => c.headers.authorization)).toEqual([`Bearer ${SENTINELS.userToken}`]);
    expect(JSON.stringify([db.tables, db.calls])).not.toContain(SENTINELS.userToken);
    expect(vi.mocked(sealSecret).mock.calls.map((c) => c[0])).toEqual([SENTINELS.token]);
  });

  it("OA19 the user token is revoked even when a later check fails, and a failed revoke is logged by code only", async () => {
    const s = slack({
      "oauth.v2.access": access({ team: { id: "T0OTHER" }, authed_user: { id: "U0MITCH", access_token: SENTINELS.userToken } }),
      "auth.revoke": () => SLACK_RECORDED.error("internal_error"),
      "users.lookupByEmail": undefined, "auth.test": undefined, "conversations.open": undefined
    });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: await startState() }))).toEqual({ slack: "wrong_team" });
    expect(methods(s)).toEqual(["oauth.v2.access", "auth.revoke"]);
    expect(consoleCalls().some((c) => String(c[0]).includes("(internal_error)"))).toBe(true);
  });

  it("OA21 a reinstall over an active row → updated in place (replaced: true), the old token never revoked", async () => {
    useDb({ tables: { exec_slack_installations: [installationRow({ token: "xoxb-OLD-token-0000", slack_dm_channel_id: "D0OLDDM", last_error_code: "token_revoked", last_error_at: "2026-11-05T00:00:00.000Z" })] } });
    const s = slack();
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: await startState() }))).toEqual({ slack: "connected" });
    expect(methods(s)).not.toContain("auth.revoke");
    expect(await vi.mocked(saveInstallation).mock.results[0].value).toEqual({ id: INSTALLATION_ID, replaced: true });
    expect(db.tables.exec_slack_installations).toHaveLength(1);
    const [row] = db.tables.exec_slack_installations;
    expect(row).toMatchObject({ id: INSTALLATION_ID, slack_dm_channel_id: "D0MITCH", last_error_code: null, revoked_at: null });
    expect(openSecret(String(row.bot_token_enc), "exec_slack_installations.bot_token:ep_1")).toBe(SENTINELS.token);
    expect(installEvents()[0].input).toEqual({ replaced: true, scopes: 6 });
  });

  it("OA22 the users table is never queried, and no fetch leaves for anything but Slack's Web API", async () => {
    const s = slack();
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: await startState() }))).toEqual({ slack: "connected" });
    expect(db.calls.map((c) => c.target)).not.toContain("users");
    expect(db.calls.every((c) => c.target.startsWith("exec_"))).toBe(true);
    expect(s.calls.every((c) => (["oauth.v2.access", "users.lookupByEmail", "auth.test", "conversations.open"] as SlackMethod[]).includes(c.method))).toBe(true);
  });

  it.each<[string, Partial<Record<SlackMethod, FakeSlackHandler | undefined>>, string]>([
    ["the exchange refused (invalid_code)", { "oauth.v2.access": () => SLACK_RECORDED.error("invalid_code") }, "exchange_failed"],
    ["the exchange unreachable (HTTP 503)", { "oauth.v2.access": () => new Response("down", { status: 503 }) }, "slack_unavailable"],
    ["Slack rate-limiting the exchange", { "oauth.v2.access": () => SLACK_RECORDED.error("ratelimited") }, "slack_unavailable"],
    ["a user token where the bot token should be", { "oauth.v2.access": access({ token_type: "user", access_token: SENTINELS.userToken }) }, "exchange_failed"],
    ["a non-xoxb bot token", { "oauth.v2.access": access({ access_token: "xoxe-1-not-a-bot-token" }) }, "exchange_failed"],
    ["a malformed bot user id", { "oauth.v2.access": access({ bot_user_id: "bot" }) }, "exchange_failed"],
    ["no authed user", { "oauth.v2.access": access({ authed_user: {} }) }, "exchange_failed"]
  ])("%s → %s, nothing stored", async (_label, over, want) => {
    slack({ "users.lookupByEmail": undefined, "auth.test": undefined, "conversations.open": undefined, ...over });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: await startState() }))).toEqual({ slack: want });
    expect(saveInstallation).not.toHaveBeenCalled();
    expect(installEvents().map((e) => e.error)).toEqual([want]);
  });

  it.each<[string, Partial<Record<SlackMethod, FakeSlackHandler | undefined>>, string]>([
    ["the identity lookup timing out at Slack (5xx)", { "users.lookupByEmail": () => new Response("", { status: 502 }), "auth.test": undefined, "conversations.open": undefined }, "slack_unavailable"],
    ["auth.test naming another bot user", { "auth.test": () => ({ ...SLACK_RECORDED.authTest(), user_id: "U0OTHERBOT" }), "conversations.open": undefined }, "exchange_failed"],
    ["auth.test in another workspace", { "auth.test": () => ({ ...SLACK_RECORDED.authTest(), team_id: "T0OTHER" }), "conversations.open": undefined }, "exchange_failed"],
    ["auth.test without a bot id", { "auth.test": () => ({ ...SLACK_RECORDED.authTest(), bot_id: undefined }), "conversations.open": undefined }, "exchange_failed"],
    ["conversations.open failing", { "conversations.open": () => SLACK_RECORDED.error("internal_error") }, "slack_unavailable"],
    ["conversations.open answering a channel that isn't a DM", { "conversations.open": () => ({ ok: true, channel: { id: "C0GENERAL" } }) }, "slack_unavailable"]
  ])("%s → %s, nothing stored", async (_label, over, want) => {
    slack(over);
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: await startState() }))).toEqual({ slack: want });
    expect(saveInstallation).not.toHaveBeenCalled();
    expect(db.tables.exec_slack_installations).toEqual([]);
  });

  it("the save failing → unavailable; the Slack config gone by the callback → not_configured", async () => {
    slack();
    useDb({ fail: (c) => (c.target === "exec_slack_installations" && c.kind !== "select" ? { code: "53300", message: "x" } : null) });
    // The state row has to live in this DB too.
    const state = await startState();
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state }))).toEqual({ slack: "unavailable" });
    const second = await startState();
    useEnv({ EXEC_SLACK_CLIENT_SECRET: undefined });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: second }))).toEqual({ slack: "not_configured" });
    expect(installEvents().map((e) => e.error)).toEqual(["unavailable", "not_configured"]);
  });

  it("an install with no principal email → identity_not_found without a lookup", async () => {
    const s = slack({ "users.lookupByEmail": undefined, "auth.test": undefined, "conversations.open": undefined });
    const noEmail = testPrincipal("ep_1", "");
    session({ principal: noEmail });
    expect(resultOf(await callback({ code: SENTINELS.oauthCode, state: await startState() }))).toEqual({ slack: "identity_not_found" });
    expect(methods(s)).toEqual(["oauth.v2.access"]);
  });
});
