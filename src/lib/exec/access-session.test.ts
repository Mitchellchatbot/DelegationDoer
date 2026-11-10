import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", () => ({ loadPrincipalForUser: vi.fn(), loadSettings: vi.fn() }));
// P9: the refusal alert, the new-network job's DM and its queue are mocks at their module boundary.
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn(async () => false) }));
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJob: vi.fn(async () => ({ enqueued: true, id: 1 })) }));
vi.mock("@/lib/exec/slack-install", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-install")>()), openActiveInstallation: vi.fn(async () => null) }));

import { SENTINELS, findSentinel } from "@/lib/exec/__tests__/slack-assert";
import { createFakeSlackDb } from "@/lib/exec/__tests__/fake-slack-db";
import { createFakeJobsRead, type ReadRow } from "@/lib/exec/__tests__/fake-jobs-read";
import { jobRow } from "@/lib/exec/__tests__/fake-exec-db";
import { SIGNED_IN_AT, linkWithOwnFactorToken, settle, strongToken } from "@/lib/exec/__tests__/step-up-fixtures";
import {
  STEP_UP_REFUSED_OPS,
  STEP_UP_REFUSED_SUFFIX,
  listWebAccessSince,
  logAccess,
  requireExecPrincipal,
  requireExecSession,
  type ExecSessionResult
} from "@/lib/exec/access";
import { BRIEF_OPS } from "@/lib/exec/brief-copy";
import { ACCESS_ALERT_JOB_KIND, accessAlertJobHandler } from "@/lib/exec/handlers/access-alert";
import { ipNetwork, uaFamily } from "@/lib/exec/network";
import { notifyOps } from "@/lib/exec/ops";
import { loadPrincipalForUser } from "@/lib/exec/principal";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getSupabaseServer } from "@/lib/supabase-server";

// P6 contract §3.8 (C3, K9): requireExecSession and the access log's Slack
// columns (AC01, AC03-AC05). AC02 is access.test.ts itself, run unchanged:
// requireExecPrincipal now delegates to requireExecSession.
//
// P9 (F1, AM-P9-13): the step-up through requireExecSession. A strong session is a password sign-in with no one-time
// link in its record, whatever its aal (signInIsStrong); STRONG below is that session, at aal1. P9's F2 fix (aal2 with
// his authenticator code, pinned in EXEC_OWNER_MFA_FACTOR_IDS) was removed on 2026-11-10.

const OWNER_AUTH_ID = "11111111-1111-4111-8111-111111111111";
const ROUTE = "GET /api/integrations/exec-slack/start";
const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const jwt = (payload: unknown) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.c2ln`;
const STRONG = strongToken("sess-strong-1", OWNER_AUTH_ID);
const LINK = jwt({ sub: OWNER_AUTH_ID, session_id: "sess-link-1", aal: "aal1", amr: [{ method: "otp", timestamp: 1793977000 }] });

const PRINCIPAL = Object.freeze({
  id: "ep_1", userId: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", timezone: "America/New_York",
  briefTimezone: "America/New_York", mailAccountIds: Object.freeze([]), slackTeamId: null, slackUserId: null
}) as unknown as ExecPrincipal;

function fakeServer(token: string | null, opts: { user?: { id: string } | null } = {}) {
  const auth = {
    getUser: vi.fn(async () => ({ data: { user: opts.user === undefined ? { id: OWNER_AUTH_ID } : opts.user }, error: null })),
    getSession: vi.fn(async () => ({ data: { session: token === null ? null : { access_token: token } }, error: null }))
  };
  vi.mocked(getSupabaseServer).mockReturnValue({ auth } as unknown as ReturnType<typeof getSupabaseServer>);
  return auth;
}

function fakeAdmin() {
  const logRows: Record<string, unknown>[] = [];
  const client = {
    from(table: string) {
      if (table === "users") {
        const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { id: "u_1", email: "mitchell@scaledai.org" }, error: null }) };
        return b;
      }
      if (table === "exec_access_log") return { insert: async (row: Record<string, unknown>) => (logRows.push(row), { error: null }) };
      throw new Error(`unexpected table ${table}`);
    }
  };
  vi.mocked(getSupabaseAdmin).mockReturnValue(client as unknown as SupabaseClient);
  return { logRows };
}

const request = () =>
  new Request("https://operations.scaledai.org/api/integrations/exec-slack/start", { headers: { "x-forwarded-for": "203.0.113.7", "user-agent": "UA/1" } });

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(getSupabaseServer).mockReset();
  vi.mocked(getSupabaseAdmin).mockReset();
  vi.mocked(loadPrincipalForUser).mockReset();
  vi.mocked(loadPrincipalForUser).mockResolvedValue(PRINCIPAL);
  vi.mocked(notifyOps).mockResolvedValue(false);
  vi.stubEnv("EXEC_ENABLED", "true");
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function denial(r: ExecSessionResult) {
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("expected a denial");
  return { status: r.response.status, body: await r.response.json() };
}

describe("requireExecSession (C3)", () => {
  it("AC01: with requireStrongSignIn, returns the principal, the GoTrue-verified auth user id and the strong token's own session_id", async () => {
    fakeServer(STRONG);
    const { logRows } = fakeAdmin();
    const r = await requireExecSession(request(), ROUTE, { requireStrongSignIn: true });
    expect(r).toEqual({ ok: true, principal: PRINCIPAL, authUserId: OWNER_AUTH_ID, sessionId: "sess-strong-1" });
    // The access-log row of a web request carries the same ids, and no Slack keys.
    expect(logRows).toEqual([
      { principal_id: "ep_1", auth_user_id: OWNER_AUTH_ID, session_id: "sess-strong-1", ip: "203.0.113.7", user_agent: "UA/1", route: ROUTE, surface: "web" }
    ]);
  });

  it("AC01: without the step-up, the session id is read from the session for the access log (null when there is none)", async () => {
    fakeServer(LINK);
    fakeAdmin();
    expect(await requireExecSession(request(), ROUTE)).toEqual({ ok: true, principal: PRINCIPAL, authUserId: OWNER_AUTH_ID, sessionId: "sess-link-1" });
    fakeServer(null);
    expect(await requireExecSession(request(), ROUTE)).toEqual({ ok: true, principal: PRINCIPAL, authUserId: OWNER_AUTH_ID, sessionId: null });
    // A token for someone else gives no session id (bound to the verified user).
    fakeServer(jwt({ sub: "someone-else", session_id: "sess-x" }));
    expect(await requireExecSession(request(), ROUTE)).toMatchObject({ ok: true, sessionId: null });
  });

  it("AC01: the gates deny exactly as requireExecPrincipal's: flag off 404, link sign-in under the step-up 404, no user 401, no principal 404", async () => {
    fakeAdmin();
    vi.stubEnv("EXEC_ENABLED", "false");
    fakeServer(STRONG);
    expect(await denial(await requireExecSession(request(), ROUTE, { requireStrongSignIn: true }))).toEqual({ status: 404, body: { error: "not found" } });
    vi.stubEnv("EXEC_ENABLED", "true");
    fakeServer(LINK);
    expect(await denial(await requireExecSession(request(), ROUTE, { requireStrongSignIn: true }))).toEqual({ status: 404, body: { error: "not found" } });
    fakeServer(STRONG, { user: null });
    expect(await denial(await requireExecSession(request(), ROUTE))).toEqual({ status: 401, body: { error: "unauthorized" } });
    fakeServer(STRONG);
    vi.mocked(loadPrincipalForUser).mockResolvedValue(null);
    expect(await denial(await requireExecSession(request(), ROUTE))).toEqual({ status: 404, body: { error: "not found" } });
  });

  it("AC02: requireExecPrincipal delegates and keeps its result shape exactly ({ ok, principal }: no session fields leak into it)", async () => {
    fakeServer(STRONG);
    fakeAdmin();
    const r = await requireExecPrincipal(request(), ROUTE, { requireStrongSignIn: true });
    expect(r).toStrictEqual({ ok: true, principal: PRINCIPAL });
    vi.stubEnv("EXEC_ENABLED", "false");
    const denied = await requireExecPrincipal(request(), ROUTE);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(404);
  });
});

// P9 F1 through requireExecSession (the Slack OAuth routes' gate): a password sign-in is admitted at any aal; a session
// with a one-time link in its record is refused, even one that verified a code of its own.
describe("requireExecSession: the P9 step-up (F1)", () => {
  const strong = { requireStrongSignIn: true } as const;
  const refusalRows = (rows: Record<string, unknown>[]) => rows.filter((r) => String(r.route).endsWith(STEP_UP_REFUSED_SUFFIX));

  it("F1: a link session that enrolled its own second factor (aal2, amr [totp, otp]) → 404, one refusal row", async () => {
    fakeServer(linkWithOwnFactorToken("sess-own-factor", OWNER_AUTH_ID));
    const { logRows } = fakeAdmin();
    expect(await denial(await requireExecSession(request(), ROUTE, strong))).toEqual({ status: 404, body: { error: "not found" } });
    await settle();
    expect(logRows).toEqual([
      { principal_id: "ep_1", auth_user_id: OWNER_AUTH_ID, session_id: "sess-own-factor", ip: "203.0.113.7", user_agent: "UA/1", route: `${ROUTE}${STEP_UP_REFUSED_SUFFIX}`, surface: "web" }
    ]);
    expect(vi.mocked(notifyOps).mock.calls.map(([a]) => a)).toEqual([
      { key: STEP_UP_REFUSED_OPS.key(new Date().toISOString().slice(0, 10)), title: STEP_UP_REFUSED_OPS.title, detail: "totp, otp aal=aal2" }
    ]);
  });

  // P9's F2 fix refused this session (no authenticator code); since that was removed, a password sign-in is enough.
  it("a password sign-in without a code (aal1, amr [password]) → admitted with its session id; no refusal row, no alert", async () => {
    fakeServer(jwt({ sub: OWNER_AUTH_ID, session_id: "sess-pw", aal: "aal1", amr: [{ method: "password", timestamp: SIGNED_IN_AT }] }));
    const { logRows } = fakeAdmin();
    expect(await requireExecSession(request(), ROUTE, strong)).toEqual({ ok: true, principal: PRINCIPAL, authUserId: OWNER_AUTH_ID, sessionId: "sess-pw" });
    await settle();
    expect(logRows).toEqual([
      { principal_id: "ep_1", auth_user_id: OWNER_AUTH_ID, session_id: "sess-pw", ip: "203.0.113.7", user_agent: "UA/1", route: ROUTE, surface: "web" }
    ]);
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("aal2 [totp, password] (a password sign-in plus a code) → admitted with its session id; no refusal", async () => {
    fakeServer(jwt({ sub: OWNER_AUTH_ID, session_id: "sess-tp", aal: "aal2", amr: [{ method: "totp", timestamp: SIGNED_IN_AT }, { method: "password", timestamp: SIGNED_IN_AT }] }));
    const { logRows } = fakeAdmin();
    expect(await requireExecSession(request(), ROUTE, strong)).toEqual({ ok: true, principal: PRINCIPAL, authUserId: OWNER_AUTH_ID, sessionId: "sess-tp" });
    await settle();
    expect(refusalRows(logRows)).toEqual([]);
    expect(notifyOps).not.toHaveBeenCalled();
  });
});

// AM-P9-13: a refused step-up's row must not teach P8's new-network check that its network or browser is "seen".
describe("listWebAccessSince never reads a refused step-up's row (AM-P9-13)", () => {
  const AT = "2026-11-06T15:00:00.000Z";
  const AT_MS = Date.parse(AT);
  const DAY = 86_400_000;
  const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  /** 25 strong rows from the office network over the last month (the learning floor is 20). */
  const office = (): ReadRow[] =>
    Array.from({ length: 25 }, (_, i) => ({
      principal_id: "ep_1", surface: "web", route: "GET /executive", ip: `198.51.100.${i + 1}`, user_agent: CHROME_MAC,
      created_at: new Date(AT_MS - (i + 1) * DAY).toISOString()
    }));
  /** Refused step-ups from network N (a team member's link session), the day before. */
  const refusedFromN = (): ReadRow[] =>
    Array.from({ length: 3 }, (_, i) => ({
      principal_id: "ep_1", surface: "web", route: `GET /executive${STEP_UP_REFUSED_SUFFIX}`, ip: `203.0.113.${i + 7}`, user_agent: CHROME_MAC,
      created_at: new Date(AT_MS - DAY / 2 - i * 60_000).toISOString()
    }));
  const runAlert = (net: string, family: string) =>
    accessAlertJobHandler.run({
      job: jobRow({ kind: ACCESS_ALERT_JOB_KIND, principal_id: "ep_1", payload: { net, family, at: AT } }),
      principal: PRINCIPAL,
      signal: new AbortController().signal,
      workerId: "w"
    });

  it("the read excludes routes ending in the refusal suffix, and keeps every other web row", async () => {
    const db = createFakeJobsRead({ exec_access_log: [...office(), ...refusedFromN()] });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    const rows = await listWebAccessSince("ep_1", new Date(AT_MS - 30 * DAY).toISOString(), AT, 5_000);
    expect(rows).toHaveLength(25);
    expect(rows.some((r) => r.ip?.startsWith("203.0.113."))).toBe(false);
    expect(db.queries[0].filters).toContainEqual({ op: "notLike", column: "route", value: `%${STEP_UP_REFUSED_SUFFIX}` });
  });

  it("a refused row from network N, then a strong session from N → the new-network alert still fires", async () => {
    const db = createFakeJobsRead({ exec_access_log: [...office(), ...refusedFromN()] });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    const net = ipNetwork("203.0.113.50");
    expect(net).toBe("203.0.113.0/24");
    const out = await runAlert(net as string, uaFamily(CHROME_MAC));
    expect(out).toMatchObject({ outcome: "alerted", newNetwork: true, newFamily: false });
    expect(vi.mocked(notifyOps).mock.calls.map(([a]) => a.key)).toEqual([BRIEF_OPS.newNetwork.key("ep_1")]);
  });
});

describe("logAccess: the Slack columns (K9, §3.8)", () => {
  // As the Slack DM job writes it: no auth user, session, IP or agent (Slack's servers made the request, CODE §10).
  const slackEntry = (over: Record<string, unknown> = {}) => ({
    principalId: "ep_1", authUserId: null, sessionId: null, ip: null, userAgent: null, route: "slack:message.im",
    surface: "slack" as const, slackUserId: "U0MITCH", slackEventId: "Ev0ABCDEF12", ...over
  });

  it("AC03: surface 'slack' inserts slack_user_id and slack_event_id; 'web' sends neither key (even if an entry carried them)", async () => {
    const db = createFakeSlackDb();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    await logAccess(slackEntry());
    await logAccess({ principalId: "ep_1", authUserId: "auth-m", sessionId: "s1", ip: "203.0.113.7", userAgent: "UA", route: "GET /api/exec/overview", surface: "web" });
    await logAccess({ principalId: "ep_1", authUserId: null, sessionId: null, ip: null, userAgent: null, route: "GET /x", surface: "web", slackUserId: "U0MITCH", slackEventId: "Ev0X" });
    const inserts = db.calls.filter((c) => c.kind === "insert").map((c) => c.payload as Record<string, unknown>);
    expect(inserts[0]).toEqual({
      principal_id: "ep_1", auth_user_id: null, session_id: null, ip: null, user_agent: null, route: "slack:message.im", surface: "slack",
      slack_user_id: "U0MITCH", slack_event_id: "Ev0ABCDEF12"
    });
    for (const web of inserts.slice(1)) {
      expect(Object.keys(web)).not.toContain("slack_user_id");
      expect(Object.keys(web)).not.toContain("slack_event_id");
    }
    expect(inserts[1]).toEqual({ principal_id: "ep_1", auth_user_id: "auth-m", session_id: "s1", ip: "203.0.113.7", user_agent: "UA", route: "GET /api/exec/overview", surface: "web" });
    expect(db.tables.exec_access_log.map((r) => [r.surface, r.slack_user_id, r.slack_event_id])).toEqual([
      ["slack", "U0MITCH", "Ev0ABCDEF12"], ["web", null, null], ["web", null, null]
    ]);
    // A Slack row with one id missing writes both keys (null for the missing one).
    await logAccess(slackEntry({ slackUserId: undefined, slackEventId: null }));
    expect(db.calls.at(-1)?.payload).toMatchObject({ surface: "slack", slack_user_id: null, slack_event_id: null });
    // A Slack-surface entry without the Slack fields at all (P2a's shape) is written exactly as before: no new keys.
    await logAccess({ principalId: "ep_1", authUserId: null, sessionId: null, ip: null, userAgent: null, route: "slack:legacy", surface: "slack" });
    expect(Object.keys(db.calls.at(-1)?.payload as Record<string, unknown>).sort()).toEqual(["auth_user_id", "ip", "principal_id", "route", "session_id", "surface", "user_agent"]);
  });

  it("AC04: both Slack ids are clipped to 40 characters (the CHECKs hold the shapes)", async () => {
    const db = createFakeSlackDb({ fail: () => null });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    await logAccess(slackEntry({ slackUserId: `U${"A".repeat(60)}`, slackEventId: `Ev${"b".repeat(60)}` }));
    const row = db.calls.at(-1)?.payload as Record<string, string>;
    expect(row.slack_user_id).toHaveLength(40);
    expect(row.slack_event_id).toHaveLength(40);
    expect(row.slack_user_id).toBe(`U${"A".repeat(39)}`);
  });

  it("AC05: before the P6 migration (the columns don't exist) a Slack row's failure is logged with the route and swallowed; nothing it holds is logged", async () => {
    const db = createFakeSlackDb({
      fail: (c) => (c.kind === "insert" && (c.payload as Record<string, unknown>).slack_user_id !== undefined
        ? { code: "PGRST204", message: "Could not find the 'slack_event_id' column of 'exec_access_log' in the schema cache" }
        : null)
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    await expect(logAccess(slackEntry({ slackUserId: "U0MITCH", slackEventId: "Ev0ABCDEF12" }))).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0][0]);
    expect(line).toContain("access log write failed (slack:message.im)");
    expect(findSentinel(errorSpy.mock.calls)).toBeNull();
    // A thrown client error is swallowed too.
    vi.mocked(getSupabaseAdmin).mockImplementation(() => {
      throw new Error("supabase env missing");
    });
    await expect(logAccess(slackEntry())).resolves.toBeUndefined();
    // Web rows still write before the migration (they never name the new columns).
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    await logAccess({ principalId: "ep_1", authUserId: null, sessionId: null, ip: null, userAgent: null, route: "GET /api/exec/overview", surface: "web" });
    expect(db.tables.exec_access_log.at(-1)).toMatchObject({ surface: "web", route: "GET /api/exec/overview" });
    void SENTINELS;
  });
});
