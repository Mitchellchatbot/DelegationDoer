import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// requireExecPrincipalForPage: the gate exec pages call first. It runs the
// real requireExecPrincipal; only the I/O around it is faked.
//
// P9 (F1, F2): the step-up admits only a password sign-in with no one-time
// link, at aal2, on an account whose verified factors are all pinned
// (EXEC_OWNER_MFA_FACTOR_IDS). The default session here is that one; every
// refusal leaves one "<route> step_up_refused" access row and an ops alert,
// without the 404 waiting on either.

const requestScope = vi.hoisted(() => ({ memo: new Map<unknown, Map<unknown, unknown>>(), headers: new Headers() }));

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));
// React's cache() memoizes per server request, and React isn't rendering
// here, so this stands in for it: one memo per wrapped function, cleared by
// newRequest().
vi.mock("@/lib/safe-cache", () => ({
  cache:
    <A, R>(fn: (arg: A) => R) =>
    (arg: A): R => {
      let memo = requestScope.memo.get(fn);
      if (!memo) {
        memo = new Map();
        requestScope.memo.set(fn, memo);
      }
      if (!memo.has(arg)) memo.set(arg, fn(arg));
      return memo.get(arg) as R;
    }
}));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", () => ({ loadPrincipalForUser: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn(async () => false) }));

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getSupabaseServer } from "@/lib/supabase-server";
import { loadPrincipalForUser } from "@/lib/exec/principal";
import { notifyOps } from "@/lib/exec/ops";
import { STEP_UP_REFUSED_OPS, STEP_UP_REFUSED_SUFFIX, execNavItemFor, requireExecPrincipalForPage, signInIsStrong } from "@/lib/exec/access";
import { OWNER_MFA_OPS } from "@/lib/exec/owner-mfa";
import type { ExecPrincipal } from "@/lib/exec/types";
import {
  OWNER_AUTH_ID,
  PINNED_FACTOR_ID,
  STRANGER_FACTOR_ID,
  fakeFactorAdmin,
  jwt,
  pinFactors,
  settle,
  unpinFactors,
  verifiedFactor,
  type FactorAdminOptions
} from "@/lib/exec/__tests__/step-up-fixtures";

const ROUTE = "GET /executive";
const REFUSED_ROUTE = `${ROUTE}${STEP_UP_REFUSED_SUFFIX}`;
const OTHER_AUTH_ID = "22222222-2222-4222-8222-222222222222";

// Access tokens as GoTrue issues them: amr lists how the session was signed
// in ([{ method, timestamp }]), aal its assurance level.
const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const SIGNED_IN = 1_793_000_000;
const tokenWith = (amr: unknown, over: Record<string, unknown> = {}) =>
  jwt({ sub: OWNER_AUTH_ID, session_id: "sess-1", aal: "aal1", amr, ...over });
const signedInWith = (...methods: string[]) => tokenWith(methods.map((method) => ({ method, timestamp: SIGNED_IN })));
const atAal2 = (...methods: string[]) => tokenWith(methods.map((method) => ({ method, timestamp: SIGNED_IN })), { aal: "aal2" });
/** A password sign-in alone (aal1): the step-up's first half only. */
const PASSWORD_TOKEN = signedInWith("password");
/** His password plus his authenticator code: what the step-up admits. */
const STRONG_TOKEN = atAal2("password", "totp");

// Built as plain data: tests may stand in for the trusted loader.
const PRINCIPAL = Object.freeze({
  id: "ep_1",
  userId: "u_1",
  email: "mitchell@scaledai.org",
  name: "Mitchell",
  timezone: "America/New_York",
  mailAccountIds: Object.freeze([]),
  slackTeamId: null,
  slackUserId: null
}) as unknown as ExecPrincipal;

const NOT_FOUND = "NEXT_NOT_FOUND";
const TODAY_UTC = () => new Date().toISOString().slice(0, 10);

function newRequest(incoming: Record<string, string> = {}) {
  requestScope.memo.clear();
  requestScope.headers = new Headers(incoming);
}

interface ServerOpts {
  userError?: { name: string; message: string; status?: number };
  /** Default: his password plus his code, on the owner's account. */
  session?: { access_token?: string; user?: { id: string } } | null;
  sessionError?: { name: string; message: string; status?: number };
  getSessionThrows?: Error;
}

function fakeServer(opts: ServerOpts = {}) {
  const auth = {
    getUser: vi.fn(async () =>
      opts.userError ? { data: { user: null }, error: opts.userError } : { data: { user: { id: OWNER_AUTH_ID } }, error: null }
    ),
    getSession: vi.fn(async () => {
      if (opts.getSessionThrows) throw opts.getSessionThrows;
      if (opts.sessionError) return { data: { session: null }, error: opts.sessionError };
      const session = opts.session === undefined ? { access_token: STRONG_TOKEN } : opts.session;
      // The cookie session carries its user (execNavItemFor binds the token to it, AM-P9-12).
      return { data: { session: session === null ? null : { user: { id: OWNER_AUTH_ID }, ...session } }, error: null };
    })
  };
  vi.mocked(getSupabaseServer).mockReturnValue({ auth } as unknown as ReturnType<typeof getSupabaseServer>);
  return auth;
}

interface AdminOpts extends FactorAdminOptions {
  email?: string;
  usersError?: { message: string };
  /** The access-log insert never answers (the refusal must not hold the 404). */
  insertHangs?: boolean;
}

function fakeAdmin(opts: AdminOpts = {}) {
  const logRows: Record<string, unknown>[] = [];
  const factorAdmin = fakeFactorAdmin(opts);
  const client = {
    auth: factorAdmin.auth,
    from(table: string) {
      if (table === "users") {
        const b = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () =>
            opts.usersError
              ? { data: null, error: opts.usersError }
              : { data: { id: "u_1", email: opts.email ?? "mitchell@scaledai.org" }, error: null }
        };
        return b;
      }
      if (table === "exec_access_log") {
        return {
          insert: (row: Record<string, unknown>) => {
            if (opts.insertHangs) return new Promise(() => {});
            logRows.push(row);
            return Promise.resolve({ error: null });
          }
        };
      }
      throw new Error(`unexpected table ${table}`);
    }
  };
  vi.mocked(getSupabaseAdmin).mockReturnValue(client as unknown as SupabaseClient);
  return { logRows, listFactors: factorAdmin.listFactors };
}

beforeEach(() => {
  vi.stubEnv("EXEC_ENABLED", "true");
  pinFactors(PINNED_FACTOR_ID);
  vi.mocked(headers).mockImplementation(() => requestScope.headers as unknown as ReturnType<typeof headers>);
  vi.mocked(notFound).mockImplementation(() => {
    throw Object.assign(new Error(NOT_FOUND), { digest: NOT_FOUND });
  });
  vi.mocked(loadPrincipalForUser).mockResolvedValue(PRINCIPAL);
  vi.mocked(notifyOps).mockResolvedValue(false);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  newRequest();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireExecPrincipalForPage", () => {
  it("returns the principal for the owner", async () => {
    fakeServer();
    fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).resolves.toBe(PRINCIPAL);
    expect(notFound).not.toHaveBeenCalled();
  });

  it("runs the gate once per request however many callers ask, and again on the next request", async () => {
    const auth = fakeServer();
    const { logRows, listFactors } = fakeAdmin();

    newRequest();
    const [a, b] = await Promise.all([requireExecPrincipalForPage(ROUTE), requireExecPrincipalForPage(ROUTE)]);
    await requireExecPrincipalForPage(ROUTE);
    expect(a).toBe(PRINCIPAL);
    expect(b).toBe(PRINCIPAL);
    expect(auth.getUser).toHaveBeenCalledTimes(1);
    expect(headers).toHaveBeenCalledTimes(1);
    expect(logRows).toHaveLength(1);
    expect(listFactors).toHaveBeenCalledTimes(1);

    newRequest();
    await requireExecPrincipalForPage(ROUTE);
    expect(auth.getUser).toHaveBeenCalledTimes(2);
    expect(logRows).toHaveLength(2);
  });

  it("forwards the client IP and user agent into the access log", async () => {
    fakeServer();
    const { logRows } = fakeAdmin();
    newRequest({
      "x-forwarded-for": "203.0.113.7, 10.0.0.2",
      "x-real-ip": "198.51.100.9",
      "user-agent": "Mozilla/5.0 Test",
      cookie: "sb-access-token=not-for-the-log"
    });
    await requireExecPrincipalForPage(ROUTE);
    expect(logRows).toHaveLength(1);
    expect(logRows[0]).toMatchObject({
      principal_id: "ep_1",
      auth_user_id: OWNER_AUTH_ID,
      // P8 C21 (§5.15 NA12): the right-most X-Forwarded-For hop (was the first entry); X-Real-IP is no longer read.
      ip: "10.0.0.2",
      user_agent: "Mozilla/5.0 Test",
      route: ROUTE,
      surface: "web"
    });
    expect(JSON.stringify(logRows[0])).not.toContain("not-for-the-log");
  });

  // P8 C21 (§5.15 NA12): X-Real-IP is no longer read (a client can set it); it used to be the fallback.
  it("no longer falls back to x-real-ip, and logs nulls when the headers are absent", async () => {
    fakeServer();
    const { logRows } = fakeAdmin();
    newRequest({ "x-real-ip": "198.51.100.9" });
    await requireExecPrincipalForPage(ROUTE);
    newRequest();
    await requireExecPrincipalForPage(ROUTE);
    expect(logRows[0]).toMatchObject({ ip: null, user_agent: null });
    expect(logRows[1]).toMatchObject({ ip: null, user_agent: null });
  });

  it("404s while the feature flag is off, before any auth or logging", async () => {
    vi.stubEnv("EXEC_ENABLED", "false");
    const auth = fakeServer();
    const { logRows } = fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(auth.getUser).not.toHaveBeenCalled();
    await settle();
    expect(logRows).toHaveLength(0);
  });

  it("404s a session GoTrue refuses (a 401), with no access-log row", async () => {
    fakeServer({ userError: { name: "AuthSessionMissingError", message: "Auth session missing!" } });
    const { logRows } = fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    expect(notFound).toHaveBeenCalledTimes(1);
    await settle();
    expect(logRows).toHaveLength(0);
  });

  it("404s a signed-in teammate who isn't the owner (a 404)", async () => {
    fakeServer();
    const { logRows } = fakeAdmin({ email: "sam@scaledai.org" });
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    expect(notFound).toHaveBeenCalledTimes(1);
    await settle();
    expect(loadPrincipalForUser).not.toHaveBeenCalled();
    expect(logRows).toHaveLength(0);
  });

  it("404s the owner when he has no enabled principal", async () => {
    fakeServer();
    fakeAdmin();
    vi.mocked(loadPrincipalForUser).mockResolvedValue(null);
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("throws to the error boundary on an auth outage (a 503) instead of a 404", async () => {
    fakeServer({ userError: { name: "AuthRetryableFetchError", message: "fetch failed", status: 0 } });
    fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toThrow("exec: temporarily unavailable");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("throws on a database outage (a 503) too", async () => {
    fakeServer();
    fakeAdmin({ usersError: { message: "connection refused" } });
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toThrow("exec: temporarily unavailable");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("shares a denial within the request: one gate run, one notFound", async () => {
    const auth = fakeServer();
    fakeAdmin({ email: "sam@scaledai.org" });
    const results = await Promise.allSettled([requireExecPrincipalForPage(ROUTE), requireExecPrincipalForPage(ROUTE)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(auth.getUser).toHaveBeenCalledTimes(1);
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});

// Any leader can mint a one-time sign-in link for the owner's account
// (users/[id]/magic-link), and the session it opens passes every identity
// check. The page gate also asks how the session was signed in, and (P9 F2)
// for his pinned second factor.
describe("requireExecPrincipalForPage: the sign-in step-up", () => {
  it("lets his password plus his pinned code through, and logs that session's id (P9: was any password sign-in)", async () => {
    fakeServer();
    const { logRows } = fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).resolves.toBe(PRINCIPAL);
    expect(logRows).toEqual([expect.objectContaining({ auth_user_id: OWNER_AUTH_ID, session_id: "sess-1", route: ROUTE })]);
  });

  it.each([
    // DD's admin-minted owner links are implicit-flow magic links: GoTrue records "otp".
    ["a leader-minted sign-in link (otp)", "otp"],
    ["a PKCE magic link", "magiclink"],
    ["a password-recovery link", "recovery"],
    ["an invite link", "invite"],
    ["a signup confirmation", "email/signup"],
    ["an email-change link", "email_change"]
  ])("404s the owner's account opened by %s; P9: one step_up_refused row, written without holding the 404", async (_label, method) => {
    fakeServer({ session: { access_token: signedInWith(method) } });
    const { logRows, listFactors } = fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(`[exec-access] ${ROUTE}: step-up refused a session on the owner's account (sign-in: ${method})`);
    await settle();
    // P9 F2 step 3 (flip): the refusal is recorded; the principal is read only for that row's principal_id.
    expect(logRows).toEqual([expect.objectContaining({ principal_id: "ep_1", route: REFUSED_ROUTE, surface: "web", session_id: "sess-1" })]);
    expect(loadPrincipalForUser).toHaveBeenCalledTimes(1);
    expect(listFactors).not.toHaveBeenCalled();
  });

  // P9 F1 (flip of "admits a session verified with a second factor, however it began").
  it("404s a link session that enrolled its own second factor (aal2, amr [totp, otp])", async () => {
    const mfa = tokenWith([{ method: "totp", timestamp: SIGNED_IN }, { method: "otp", timestamp: SIGNED_IN }], { aal: "aal2", session_id: "sess-2" });
    fakeServer({ session: { access_token: mfa } });
    // Even with only pinned factors on the account: the link in its record is enough to refuse it.
    const { logRows, listFactors } = fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    expect(console.warn).toHaveBeenCalledWith(`[exec-access] ${ROUTE}: step-up refused a session on the owner's account (sign-in: totp, otp)`);
    await settle();
    expect(logRows).toEqual([expect.objectContaining({ route: REFUSED_ROUTE, session_id: "sess-2" })]);
    expect(listFactors).not.toHaveBeenCalled();
  });

  it("P9 F1: a PKCE link with its own factor (aal2, amr [totp, magiclink]) → 404", async () => {
    fakeServer({ session: { access_token: atAal2("totp", "magiclink") } });
    fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
  });

  it("P9 F1: a password sign-in verified with his pinned factor (aal2, amr [totp, password]) is admitted", async () => {
    fakeServer({ session: { access_token: atAal2("totp", "password") } });
    const { logRows } = fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).resolves.toBe(PRINCIPAL);
    expect(logRows).toEqual([expect.objectContaining({ route: ROUTE })]);
  });

  it.each<[string, string]>([
    ["a password session that also carries a one-time link", signedInWith("password", "otp")],
    ["a token with no amr", jwt({ sub: OWNER_AUTH_ID, session_id: "sess-1", aal: "aal1" })],
    ["a token with an empty amr", tokenWith([])],
    ["amr written as bare strings", tokenWith(["password"])],
    ["an amr entry without a method", tokenWith([{ timestamp: SIGNED_IN }])],
    ["only a sign-in method DD doesn't offer", signedInWith("oauth")],
    ["a password token for another user", jwt({ sub: OTHER_AUTH_ID, session_id: "sess-9", aal: "aal2", amr: [{ method: "password", timestamp: SIGNED_IN }, { method: "totp", timestamp: SIGNED_IN }] })],
    ["a token that isn't a JWT", "not-a-jwt"]
  ])("404s %s (it doesn't show a password sign-in); P9: its refusal row only", async (label, accessToken) => {
    fakeServer({ session: { access_token: accessToken } });
    const { logRows } = fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    await settle();
    expect(logRows).toHaveLength(1);
    expect(logRows[0]).toMatchObject({ route: REFUSED_ROUTE, auth_user_id: OWNER_AUTH_ID });
    // A token for anyone else never puts its session id on the owner's log.
    if (label.includes("another user")) expect(logRows[0].session_id).toBeNull();
  });

  it("404s when there is no session to read, or GoTrue refuses to read it", async () => {
    for (const opts of [{ session: null }, { session: {} }, { sessionError: { name: "AuthApiError", message: "Invalid Refresh Token", status: 400 } }] satisfies ServerOpts[]) {
      newRequest();
      vi.mocked(notFound).mockClear();
      fakeServer(opts);
      const { logRows } = fakeAdmin();
      await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
      expect(notFound).toHaveBeenCalledTimes(1);
      await settle();
      expect(logRows).toHaveLength(0);
    }
  });

  it("throws to the error boundary when the session can't be read for an outage", async () => {
    fakeServer({ sessionError: { name: "AuthRetryableFetchError", message: "fetch failed", status: 0 } });
    fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toThrow("exec: temporarily unavailable");

    newRequest();
    fakeServer({ getSessionThrows: new Error("cookie parse") });
    fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toThrow("exec: temporarily unavailable");
    expect(notFound).not.toHaveBeenCalled();
    expect(loadPrincipalForUser).not.toHaveBeenCalled();
  });

  it("asks only for the owner's account: a teammate's 404 comes before any session read", async () => {
    const auth = fakeServer();
    const { listFactors } = fakeAdmin({ email: "sam@scaledai.org" });
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    expect(auth.getSession).not.toHaveBeenCalled();
    expect(listFactors).not.toHaveBeenCalled();
  });
});

// P9 F2 (owner decisions Q1, Q2): the second half of the step-up.
describe("requireExecPrincipalForPage: his pinned second factor (F2)", () => {
  it("pin set: an aal1 password sign-in → 404, one step_up_refused row and one daily-keyed alert, no factor read", async () => {
    fakeServer({ session: { access_token: PASSWORD_TOKEN } });
    const { logRows, listFactors } = fakeAdmin();
    newRequest({ "x-forwarded-for": "203.0.113.7", "user-agent": "UA/1" });
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    expect(listFactors).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(`[exec-access] ${ROUTE}: step-up refused a session on the owner's account (second factor: not_aal2)`);
    await settle();
    expect(logRows).toEqual([
      { principal_id: "ep_1", auth_user_id: OWNER_AUTH_ID, session_id: "sess-1", ip: "203.0.113.7", user_agent: "UA/1", route: REFUSED_ROUTE, surface: "web" }
    ]);
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(notifyOps).toHaveBeenCalledWith({ key: STEP_UP_REFUSED_OPS.key(TODAY_UTC()), title: STEP_UP_REFUSED_OPS.title, detail: "password aal=aal1 (not_aal2)" });
  });

  it("pin set: aal2 [totp, password] with the pinned factor → admitted, one GoTrue read for the user id", async () => {
    fakeServer({ session: { access_token: atAal2("totp", "password") } });
    const { listFactors } = fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).resolves.toBe(PRINCIPAL);
    expect(listFactors).toHaveBeenCalledTimes(1);
    expect(listFactors).toHaveBeenCalledWith({ userId: OWNER_AUTH_ID });
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("Q2: with the pin unset, even his password plus code is refused (no factor read)", async () => {
    unpinFactors();
    fakeServer();
    const { logRows, listFactors } = fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    expect(listFactors).not.toHaveBeenCalled();
    await settle();
    expect(logRows).toEqual([expect.objectContaining({ route: REFUSED_ROUTE })]);
    expect(vi.mocked(notifyOps).mock.calls[0][0]).toMatchObject({ detail: "password, totp aal=aal2 (pin_unset)" });
  });

  it("a malformed pin is refused and tells ops it is misconfigured", async () => {
    vi.stubEnv("EXEC_OWNER_MFA_FACTOR_IDS", `${PINNED_FACTOR_ID},not-a-factor-id`);
    fakeServer();
    const { listFactors } = fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    expect(listFactors).not.toHaveBeenCalled();
    await settle();
    expect(vi.mocked(notifyOps).mock.calls.map(([a]) => a.key)).toEqual([OWNER_MFA_OPS.misconfiguredKey, STEP_UP_REFUSED_OPS.key(TODAY_UTC())]);
  });

  it("a verified factor nobody pinned beside his → 404 and the unpinned alert (counts only)", async () => {
    fakeServer();
    const { logRows } = fakeAdmin({ factors: [verifiedFactor(PINNED_FACTOR_ID), verifiedFactor(STRANGER_FACTOR_ID)] });
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    await settle();
    expect(logRows).toEqual([expect.objectContaining({ route: REFUSED_ROUTE })]);
    const alerts = vi.mocked(notifyOps).mock.calls.map(([a]) => a);
    expect(alerts[0]).toEqual({ key: OWNER_MFA_OPS.unpinnedKey(TODAY_UTC()), title: OWNER_MFA_OPS.unpinnedTitle, detail: "1 unpinned verified factor(s)" });
    expect(JSON.stringify(alerts)).not.toContain(STRANGER_FACTOR_ID.slice(0, 8));
  });

  it("no verified factor on the account (an unverified one only) → 404", async () => {
    fakeServer();
    fakeAdmin({ factors: [verifiedFactor(PINNED_FACTOR_ID, { status: "unverified" })] });
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
  });

  it("security-1: a session whose code was verified before his pinned factor existed (its own factor, since deleted) → 404, one refused row and the alert", async () => {
    // S reached aal2 with amr [password, totp] on its own factor; the team deleted that factor, he enrolled the pinned one a
    // day later. The factor list is clean (his pinned factor only), so only the time binding tells S's session from his.
    const enrolledAt = new Date((SIGNED_IN + 86_400) * 1000).toISOString();
    fakeServer({ session: { access_token: STRONG_TOKEN } });
    const { logRows, listFactors } = fakeAdmin({ factors: [verifiedFactor(PINNED_FACTOR_ID, { created_at: enrolledAt })] });
    newRequest({ "x-forwarded-for": "203.0.113.9", "user-agent": "UA/S" });
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    expect(listFactors).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(`[exec-access] ${ROUTE}: step-up refused a session on the owner's account (second factor: factor_predates_pin)`);
    await settle();
    expect(logRows).toEqual([
      { principal_id: "ep_1", auth_user_id: OWNER_AUTH_ID, session_id: "sess-1", ip: "203.0.113.9", user_agent: "UA/S", route: REFUSED_ROUTE, surface: "web" }
    ]);
    expect(notifyOps).toHaveBeenCalledWith({ key: STEP_UP_REFUSED_OPS.key(TODAY_UTC()), title: STEP_UP_REFUSED_OPS.title, detail: "password, totp aal=aal2 (factor_predates_pin)" });
    // His own session, whose code came after the factor was created, opens the page on the next request.
    newRequest();
    fakeServer({ session: { access_token: tokenWith([{ method: "password", timestamp: SIGNED_IN + 86_400 + 30 }, { method: "totp", timestamp: SIGNED_IN + 86_400 + 60 }], { aal: "aal2", session_id: "sess-m" }) } });
    fakeAdmin({ factors: [verifiedFactor(PINNED_FACTOR_ID, { created_at: enrolledAt })] });
    await expect(requireExecPrincipalForPage(ROUTE)).resolves.toBe(PRINCIPAL);
  });

  it("the factor list can't be read (an error or a throw) → 503 to the error boundary, no refusal row", async () => {
    fakeServer();
    const first = fakeAdmin({ error: { name: "AuthRetryableFetchError", message: "fetch failed", status: 0 } });
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toThrow("exec: temporarily unavailable");

    newRequest();
    fakeServer();
    const second = fakeAdmin({ throws: new Error("@supabase/auth-js: Expected parameter to be UUID but is not") });
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toThrow("exec: temporarily unavailable");
    expect(notFound).not.toHaveBeenCalled();
    await settle();
    expect([...first.logRows, ...second.logRows]).toEqual([]);
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("the refusal never holds the 404: an access-log insert that never answers", async () => {
    fakeServer({ session: { access_token: PASSWORD_TOKEN } });
    fakeAdmin({ insertHangs: true });
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
  });

  it("the refusal row's principal id is null when the principal can't be read; the alert never carries the token", async () => {
    fakeServer({ session: { access_token: PASSWORD_TOKEN } });
    const { logRows } = fakeAdmin();
    vi.mocked(loadPrincipalForUser).mockRejectedValue(new Error("exec_principals read failed"));
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    await settle();
    expect(logRows).toEqual([expect.objectContaining({ principal_id: null, route: REFUSED_ROUTE })]);
    const sent = JSON.stringify(vi.mocked(notifyOps).mock.calls);
    expect(sent).not.toContain(PASSWORD_TOKEN);
    expect(sent).not.toContain(PASSWORD_TOKEN.split(".")[1]);
    expect(sent).not.toContain("sess-1");
  });
});

describe("signInIsStrong", () => {
  it.each<[string, string, boolean]>([
    ["a password sign-in", PASSWORD_TOKEN, true],
    ["a password sign-in with another method recorded beside it", signedInWith("password", "token_refresh"), true],
    ["a one-time link", signedInWith("otp"), false],
    ["a password sign-in plus a link", signedInWith("password", "magiclink"), false],
    // P9 F1 (flip): a second factor no longer stands in for the password.
    ["a second factor on top of a link", tokenWith([{ method: "totp", timestamp: SIGNED_IN }, { method: "otp", timestamp: SIGNED_IN }], { aal: "aal2" }), false],
    ["a second factor on top of a PKCE link", atAal2("totp", "magiclink"), false],
    ["a second factor alone (no password recorded)", atAal2("totp"), false],
    ["a password sign-in verified with a second factor", atAal2("totp", "password"), true],
    ["nothing recorded", tokenWith(undefined), false],
    ["a payload that isn't an object", `${b64url({ alg: "HS256" })}.${b64url(["password"])}.c2ln`, false]
  ])("%s → %s", (_label, token, expected) => {
    expect(signInIsStrong(token)).toBe(expected);
  });

  it("binds the token to the user GoTrue verified", () => {
    expect(signInIsStrong(PASSWORD_TOKEN, OWNER_AUTH_ID)).toBe(true);
    expect(signInIsStrong(PASSWORD_TOKEN, OTHER_AUTH_ID)).toBe(false);
  });
});

describe("execNavItemFor (the Sidebar row)", () => {
  const OWNER = { email: "mitchell@scaledai.org" };

  it("is the row for the owner on his password plus pinned code while the flag is on", async () => {
    fakeServer();
    const { listFactors } = fakeAdmin();
    await expect(execNavItemFor(OWNER)).resolves.toEqual({ href: "/executive", label: "Executive AI" });
    expect(listFactors).toHaveBeenCalledWith({ userId: OWNER_AUTH_ID });
  });

  it("is null, without reading the session, while the flag is off or for anyone else", async () => {
    const auth = fakeServer();
    await expect(execNavItemFor({ email: "sam@scaledai.org" })).resolves.toBeNull();
    await expect(execNavItemFor(null)).resolves.toBeNull();
    vi.stubEnv("EXEC_ENABLED", "false");
    await expect(execNavItemFor(OWNER)).resolves.toBeNull();
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it("is null for a session the page gate would turn away: a sign-in link, or none", async () => {
    fakeAdmin();
    fakeServer({ session: { access_token: signedInWith("otp") } });
    await expect(execNavItemFor(OWNER)).resolves.toBeNull();
    fakeServer({ session: null });
    await expect(execNavItemFor(OWNER)).resolves.toBeNull();
  });

  it("P9: is null for a password-only sign-in (F2), a link with its own factor (F1), an unpinned factor, or the pin unset (Q2)", async () => {
    fakeAdmin();
    fakeServer({ session: { access_token: PASSWORD_TOKEN } });
    await expect(execNavItemFor(OWNER)).resolves.toBeNull();
    fakeServer({ session: { access_token: atAal2("totp", "otp") } });
    await expect(execNavItemFor(OWNER)).resolves.toBeNull();
    fakeServer();
    fakeAdmin({ factors: [verifiedFactor(PINNED_FACTOR_ID), verifiedFactor(STRANGER_FACTOR_ID)] });
    await expect(execNavItemFor(OWNER)).resolves.toBeNull();
    fakeAdmin();
    unpinFactors();
    await expect(execNavItemFor(OWNER)).resolves.toBeNull();
  });

  it("P9 (AM-P9-12): binds the token to the cookie session's own user", async () => {
    fakeAdmin();
    fakeServer({ session: { access_token: STRONG_TOKEN, user: { id: OTHER_AUTH_ID } } });
    await expect(execNavItemFor(OWNER)).resolves.toBeNull();
    fakeServer({ session: { access_token: STRONG_TOKEN, user: undefined as unknown as { id: string } } });
    await expect(execNavItemFor(OWNER)).resolves.toBeNull();
  });

  it("never throws: a session or factor list it can't read just gets no row", async () => {
    fakeAdmin();
    fakeServer({ sessionError: { name: "AuthRetryableFetchError", message: "fetch failed", status: 0 } });
    await expect(execNavItemFor(OWNER)).resolves.toBeNull();
    fakeServer({ getSessionThrows: new Error("cookie parse") });
    await expect(execNavItemFor(OWNER)).resolves.toBeNull();
    fakeServer();
    fakeAdmin({ throws: new Error("socket hang up") });
    await expect(execNavItemFor(OWNER)).resolves.toBeNull();
    vi.mocked(getSupabaseServer).mockImplementation(() => {
      throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required");
    });
    await expect(execNavItemFor(OWNER)).resolves.toBeNull();
  });
});
