import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// requireExecPrincipalForPage: the gate exec pages call first. It runs the
// real requireExecPrincipal; only the I/O around it is faked.

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

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getSupabaseServer } from "@/lib/supabase-server";
import { loadPrincipalForUser } from "@/lib/exec/principal";
import { execNavItemFor, requireExecPrincipalForPage, signInIsStrong } from "@/lib/exec/access";
import type { ExecPrincipal } from "@/lib/exec/types";

const ROUTE = "GET /executive";
const OWNER_AUTH_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AUTH_ID = "22222222-2222-4222-8222-222222222222";

// Access tokens as GoTrue issues them: amr lists how the session was signed
// in ([{ method, timestamp }]), aal its assurance level.
const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const jwt = (payload: unknown) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.c2ln`;
const SIGNED_IN = 1_793_000_000;
const tokenWith = (amr: unknown, over: Record<string, unknown> = {}) =>
  jwt({ sub: OWNER_AUTH_ID, session_id: "sess-1", aal: "aal1", amr, ...over });
const signedInWith = (...methods: string[]) => tokenWith(methods.map((method) => ({ method, timestamp: SIGNED_IN })));
const PASSWORD_TOKEN = signedInWith("password");

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

function newRequest(incoming: Record<string, string> = {}) {
  requestScope.memo.clear();
  requestScope.headers = new Headers(incoming);
}

interface ServerOpts {
  userError?: { name: string; message: string; status?: number };
  /** Default: a password sign-in on the owner's account. */
  session?: { access_token?: string } | null;
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
      return { data: { session: opts.session === undefined ? { access_token: PASSWORD_TOKEN } : opts.session }, error: null };
    })
  };
  vi.mocked(getSupabaseServer).mockReturnValue({ auth } as unknown as ReturnType<typeof getSupabaseServer>);
  return auth;
}

function fakeAdmin(opts: { email?: string; usersError?: { message: string } } = {}) {
  const logRows: Record<string, unknown>[] = [];
  const client = {
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
          insert: async (row: Record<string, unknown>) => {
            logRows.push(row);
            return { error: null };
          }
        };
      }
      throw new Error(`unexpected table ${table}`);
    }
  };
  vi.mocked(getSupabaseAdmin).mockReturnValue(client as unknown as SupabaseClient);
  return { logRows };
}

beforeEach(() => {
  vi.stubEnv("EXEC_ENABLED", "true");
  vi.mocked(headers).mockImplementation(() => requestScope.headers as unknown as ReturnType<typeof headers>);
  vi.mocked(notFound).mockImplementation(() => {
    throw Object.assign(new Error(NOT_FOUND), { digest: NOT_FOUND });
  });
  vi.mocked(loadPrincipalForUser).mockResolvedValue(PRINCIPAL);
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
    const { logRows } = fakeAdmin();

    newRequest();
    const [a, b] = await Promise.all([requireExecPrincipalForPage(ROUTE), requireExecPrincipalForPage(ROUTE)]);
    await requireExecPrincipalForPage(ROUTE);
    expect(a).toBe(PRINCIPAL);
    expect(b).toBe(PRINCIPAL);
    expect(auth.getUser).toHaveBeenCalledTimes(1);
    expect(headers).toHaveBeenCalledTimes(1);
    expect(logRows).toHaveLength(1);

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
      ip: "203.0.113.7",
      user_agent: "Mozilla/5.0 Test",
      route: ROUTE,
      surface: "web"
    });
    expect(JSON.stringify(logRows[0])).not.toContain("not-for-the-log");
  });

  it("falls back to x-real-ip, and logs nulls when the headers are absent", async () => {
    fakeServer();
    const { logRows } = fakeAdmin();
    newRequest({ "x-real-ip": "198.51.100.9" });
    await requireExecPrincipalForPage(ROUTE);
    newRequest();
    await requireExecPrincipalForPage(ROUTE);
    expect(logRows[0]).toMatchObject({ ip: "198.51.100.9", user_agent: null });
    expect(logRows[1]).toMatchObject({ ip: null, user_agent: null });
  });

  it("404s while the feature flag is off, before any auth or logging", async () => {
    vi.stubEnv("EXEC_ENABLED", "false");
    const auth = fakeServer();
    const { logRows } = fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(auth.getUser).not.toHaveBeenCalled();
    expect(logRows).toHaveLength(0);
  });

  it("404s a session GoTrue refuses (a 401), with no access-log row", async () => {
    fakeServer({ userError: { name: "AuthSessionMissingError", message: "Auth session missing!" } });
    const { logRows } = fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(logRows).toHaveLength(0);
  });

  it("404s a signed-in teammate who isn't the owner (a 404)", async () => {
    fakeServer();
    const { logRows } = fakeAdmin({ email: "sam@scaledai.org" });
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    expect(notFound).toHaveBeenCalledTimes(1);
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
// check. The page gate also asks how the session was signed in.
describe("requireExecPrincipalForPage: the sign-in step-up", () => {
  it("lets a password sign-in through, and logs that session's id", async () => {
    fakeServer();
    const { logRows } = fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).resolves.toBe(PRINCIPAL);
    expect(logRows).toEqual([expect.objectContaining({ auth_user_id: OWNER_AUTH_ID, session_id: "sess-1" })]);
  });

  it.each([
    // DD's admin-minted owner links are implicit-flow magic links: GoTrue records "otp".
    ["a leader-minted sign-in link (otp)", "otp"],
    ["a PKCE magic link", "magiclink"],
    ["a password-recovery link", "recovery"],
    ["an invite link", "invite"],
    ["a signup confirmation", "email/signup"],
    ["an email-change link", "email_change"]
  ])("404s the owner's account opened by %s, before loading a principal or logging", async (_label, method) => {
    fakeServer({ session: { access_token: signedInWith(method) } });
    const { logRows } = fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(loadPrincipalForUser).not.toHaveBeenCalled();
    expect(logRows).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(`[exec-access] ${ROUTE}: step-up refused a session on the owner's account (sign-in: ${method})`);
  });

  it("admits a session verified with a second factor, however it began", async () => {
    const mfa = tokenWith([{ method: "totp", timestamp: SIGNED_IN }, { method: "otp", timestamp: SIGNED_IN }], { aal: "aal2", session_id: "sess-2" });
    fakeServer({ session: { access_token: mfa } });
    const { logRows } = fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).resolves.toBe(PRINCIPAL);
    expect(logRows).toEqual([expect.objectContaining({ session_id: "sess-2" })]);
  });

  it.each<[string, string]>([
    ["a password session that also carries a one-time link", signedInWith("password", "otp")],
    ["a token with no amr", jwt({ sub: OWNER_AUTH_ID, session_id: "sess-1", aal: "aal1" })],
    ["a token with an empty amr", tokenWith([])],
    ["amr written as bare strings", tokenWith(["password"])],
    ["an amr entry without a method", tokenWith([{ timestamp: SIGNED_IN }])],
    ["only a sign-in method DD doesn't offer", signedInWith("oauth")],
    ["a password token for another user", jwt({ sub: OTHER_AUTH_ID, session_id: "sess-9", aal: "aal1", amr: [{ method: "password", timestamp: SIGNED_IN }] })],
    ["a token that isn't a JWT", "not-a-jwt"]
  ])("404s %s (it doesn't show a password sign-in)", async (_label, accessToken) => {
    fakeServer({ session: { access_token: accessToken } });
    const { logRows } = fakeAdmin();
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    expect(logRows).toHaveLength(0);
  });

  it("404s when there is no session to read, or GoTrue refuses to read it", async () => {
    for (const opts of [{ session: null }, { session: {} }, { sessionError: { name: "AuthApiError", message: "Invalid Refresh Token", status: 400 } }] satisfies ServerOpts[]) {
      newRequest();
      vi.mocked(notFound).mockClear();
      fakeServer(opts);
      fakeAdmin();
      await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
      expect(notFound).toHaveBeenCalledTimes(1);
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
    fakeAdmin({ email: "sam@scaledai.org" });
    await expect(requireExecPrincipalForPage(ROUTE)).rejects.toMatchObject({ digest: NOT_FOUND });
    expect(auth.getSession).not.toHaveBeenCalled();
  });
});

describe("signInIsStrong", () => {
  it.each<[string, string, boolean]>([
    ["a password sign-in", PASSWORD_TOKEN, true],
    ["a password sign-in with another method recorded beside it", signedInWith("password", "token_refresh"), true],
    ["a one-time link", signedInWith("otp"), false],
    ["a password sign-in plus a link", signedInWith("password", "magiclink"), false],
    ["a second factor on top of a link", tokenWith([{ method: "totp", timestamp: SIGNED_IN }, { method: "otp", timestamp: SIGNED_IN }], { aal: "aal2" }), true],
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

  it("is the row for the owner on a password sign-in while the flag is on", async () => {
    fakeServer();
    await expect(execNavItemFor(OWNER)).resolves.toEqual({ href: "/executive", label: "Executive AI" });
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
    fakeServer({ session: { access_token: signedInWith("otp") } });
    await expect(execNavItemFor(OWNER)).resolves.toBeNull();
    fakeServer({ session: null });
    await expect(execNavItemFor(OWNER)).resolves.toBeNull();
  });

  it("never throws: a session it can't read just gets no row", async () => {
    fakeServer({ sessionError: { name: "AuthRetryableFetchError", message: "fetch failed", status: 0 } });
    await expect(execNavItemFor(OWNER)).resolves.toBeNull();
    fakeServer({ getSessionThrows: new Error("cookie parse") });
    await expect(execNavItemFor(OWNER)).resolves.toBeNull();
    vi.mocked(getSupabaseServer).mockImplementation(() => {
      throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required");
    });
    await expect(execNavItemFor(OWNER)).resolves.toBeNull();
  });
});
