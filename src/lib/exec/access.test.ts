import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", () => ({ loadPrincipalForUser: vi.fn() }));

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getSupabaseServer } from "@/lib/supabase-server";
import { loadPrincipalForUser } from "@/lib/exec/principal";
import {
  clientIp,
  isExecEnabled,
  logAccess,
  requireExecPrincipal,
  sessionIdFromAccessToken,
  type ExecAccessResult
} from "@/lib/exec/access";
import type { ExecPrincipal } from "@/lib/exec/types";

const OWNER_AUTH_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AUTH_ID = "22222222-2222-4222-8222-222222222222";
const ROUTE = "GET /api/exec/overview";

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const jwt = (payload: unknown) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.c2ln`;

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

// --- fakes --------------------------------------------------------------------

interface ServerOpts {
  user?: { id: string } | null;
  userError?: { name: string; message: string; status?: number };
  getUserThrows?: Error;
  session?: { access_token?: string } | null;
  sessionError?: { message: string };
  getSessionThrows?: Error;
}

function fakeServer(opts: ServerOpts = {}) {
  const auth = {
    getUser: vi.fn(async () => {
      if (opts.getUserThrows) throw opts.getUserThrows;
      if (opts.userError) return { data: { user: null }, error: opts.userError };
      return { data: { user: opts.user === undefined ? { id: OWNER_AUTH_ID } : opts.user }, error: null };
    }),
    getSession: vi.fn(async () => {
      if (opts.getSessionThrows) throw opts.getSessionThrows;
      if (opts.sessionError) return { data: { session: null }, error: opts.sessionError };
      const session =
        opts.session === undefined ? { access_token: jwt({ sub: OWNER_AUTH_ID, session_id: "sess-1" }) } : opts.session;
      return { data: { session }, error: null };
    })
  };
  vi.mocked(getSupabaseServer).mockReturnValue({ auth } as unknown as ReturnType<typeof getSupabaseServer>);
  return auth;
}

interface AdminOpts {
  userRow?: { id: string; email: string | null } | null;
  usersError?: { message: string };
  usersThrows?: Error;
  logError?: { message: string };
  logThrows?: Error;
}

function fakeAdmin(opts: AdminOpts = {}) {
  const usersFilters: [string, unknown][] = [];
  const logRows: Record<string, unknown>[] = [];
  const client = {
    from(table: string) {
      if (table === "users") {
        const b = {
          select: () => b,
          eq: (column: string, value: unknown) => {
            usersFilters.push([column, value]);
            return b;
          },
          maybeSingle: async () => {
            if (opts.usersThrows) throw opts.usersThrows;
            if (opts.usersError) return { data: null, error: opts.usersError };
            return { data: opts.userRow === undefined ? { id: "u_1", email: "mitchell@scaledai.org" } : opts.userRow, error: null };
          }
        };
        return b;
      }
      if (table === "exec_access_log") {
        return {
          insert: async (row: Record<string, unknown>) => {
            if (opts.logThrows) throw opts.logThrows;
            logRows.push(row);
            return { error: opts.logError ?? null };
          }
        };
      }
      throw new Error(`unexpected table ${table}`);
    }
  };
  vi.mocked(getSupabaseAdmin).mockReturnValue(client as unknown as SupabaseClient);
  return { usersFilters, logRows };
}

function request(headers: Record<string, string> = { "x-forwarded-for": "203.0.113.7, 10.0.0.2", "user-agent": "Mozilla/5.0 Test" }) {
  return new Request("https://operations.scaledai.org/api/exec/overview", { headers });
}

async function denial(result: ExecAccessResult): Promise<{ status: number; body: unknown }> {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a denial");
  return { status: result.response.status, body: await result.response.json() };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(getSupabaseServer).mockReset();
  vi.mocked(getSupabaseAdmin).mockReset();
  vi.mocked(loadPrincipalForUser).mockReset();
  vi.mocked(loadPrincipalForUser).mockResolvedValue(PRINCIPAL);
  vi.stubEnv("EXEC_ENABLED", "true");
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// --- tests ----------------------------------------------------------------------

describe("isExecEnabled", () => {
  it("is true only for the exact string 'true'", () => {
    expect(isExecEnabled()).toBe(true);
    for (const v of ["TRUE", "1", "yes", "true ", ""]) {
      vi.stubEnv("EXEC_ENABLED", v);
      expect(isExecEnabled()).toBe(false);
    }
    vi.stubEnv("EXEC_ENABLED", undefined);
    expect(isExecEnabled()).toBe(false);
  });
});

describe("requireExecPrincipal", () => {
  it("lets the owner through and returns the principal", async () => {
    fakeServer();
    fakeAdmin();
    const result = await requireExecPrincipal(request(), ROUTE);
    expect(result).toEqual({ ok: true, principal: PRINCIPAL });
    expect(loadPrincipalForUser).toHaveBeenCalledWith("u_1");
  });

  it("404s while EXEC_ENABLED is off, before touching auth", async () => {
    vi.stubEnv("EXEC_ENABLED", "false");
    fakeServer();
    fakeAdmin();
    expect(await denial(await requireExecPrincipal(request(), ROUTE))).toEqual({ status: 404, body: { error: "not found" } });
    expect(getSupabaseServer).not.toHaveBeenCalled();
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it("503s when the auth client can't be built (env missing)", async () => {
    vi.mocked(getSupabaseServer).mockImplementation(() => {
      throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required");
    });
    fakeAdmin();
    expect(await denial(await requireExecPrincipal(request(), ROUTE))).toEqual({ status: 503, body: { error: "auth unavailable" } });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("401s when GoTrue reports an error, logging anything but a missing session", async () => {
    fakeServer({ userError: { name: "AuthApiError", message: "invalid JWT" } });
    const admin = fakeAdmin();
    expect(await denial(await requireExecPrincipal(request(), ROUTE))).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(admin.usersFilters).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("AuthApiError: invalid JWT"));

    warnSpy.mockClear();
    fakeServer({ userError: { name: "AuthSessionMissingError", message: "Auth session missing!" } });
    fakeAdmin();
    expect((await denial(await requireExecPrincipal(request(), ROUTE))).status).toBe(401);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("401s when there is no signed-in user", async () => {
    fakeServer({ user: null });
    fakeAdmin();
    expect(await denial(await requireExecPrincipal(request(), ROUTE))).toEqual({ status: 401, body: { error: "unauthorized" } });
  });

  it.each([
    ["a network failure", { name: "AuthRetryableFetchError", message: "fetch failed", status: 0 }],
    ["a gateway error", { name: "AuthRetryableFetchError", message: "Bad Gateway", status: 502 }],
    ["GoTrue rate-limiting", { name: "AuthApiError", message: "Request rate limit reached", status: 429 }],
    ["a GoTrue 500", { name: "AuthApiError", message: "Internal Server Error", status: 500 }]
  ])("503s (not 401) when getUser reports %s", async (_label, userError) => {
    fakeServer({ userError });
    const admin = fakeAdmin();
    expect(await denial(await requireExecPrincipal(request(), ROUTE))).toEqual({ status: 503, body: { error: "auth unavailable" } });
    expect(admin.usersFilters).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`${userError.name}: ${userError.message}`));
  });

  it("still 401s a token GoTrue rejected (a 4xx other than 429)", async () => {
    fakeServer({ userError: { name: "AuthApiError", message: "invalid JWT", status: 403 } });
    fakeAdmin();
    expect((await denial(await requireExecPrincipal(request(), ROUTE))).status).toBe(401);
  });

  it("503s when getUser itself throws", async () => {
    fakeServer({ getUserThrows: new Error("socket hang up") });
    fakeAdmin();
    expect(await denial(await requireExecPrincipal(request(), ROUTE))).toEqual({ status: 503, body: { error: "auth unavailable" } });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("decides identity with getUser, never the cookie session", async () => {
    // A forged cookie session naming the owner, while GoTrue says nobody is signed in.
    const auth = fakeServer({ user: null, session: { access_token: jwt({ sub: OWNER_AUTH_ID, session_id: "forged" }) } });
    const admin = fakeAdmin();
    expect((await denial(await requireExecPrincipal(request(), ROUTE))).status).toBe(401);
    expect(auth.getSession).not.toHaveBeenCalled();
    expect(admin.usersFilters).toEqual([]);
    expect(admin.logRows).toEqual([]);
  });

  it("looks the users row up by the GoTrue user id, whatever the session token claims", async () => {
    fakeServer({ user: { id: OTHER_AUTH_ID }, session: { access_token: jwt({ sub: OWNER_AUTH_ID, session_id: "sess-owner" }) } });
    const admin = fakeAdmin();
    const result = await requireExecPrincipal(request(), ROUTE);
    expect(result.ok).toBe(true);
    expect(admin.usersFilters).toEqual([["auth_user_id", OTHER_AUTH_ID]]);
    // The token's sub isn't the verified user, so its session id stays off the log.
    expect(admin.logRows[0]).toMatchObject({ auth_user_id: OTHER_AUTH_ID, session_id: null });
  });

  it("404s when no users row is linked to the auth account", async () => {
    fakeServer();
    const admin = fakeAdmin({ userRow: null });
    expect(await denial(await requireExecPrincipal(request(), ROUTE))).toEqual({ status: 404, body: { error: "not found" } });
    expect(loadPrincipalForUser).not.toHaveBeenCalled();
    expect(admin.logRows).toEqual([]);
  });

  it("503s when the users lookup fails or throws", async () => {
    fakeServer();
    fakeAdmin({ usersError: { message: "connection refused" } });
    expect((await denial(await requireExecPrincipal(request(), ROUTE))).status).toBe(503);

    fakeServer();
    fakeAdmin({ usersThrows: new Error("fetch failed") });
    expect((await denial(await requireExecPrincipal(request(), ROUTE))).status).toBe(503);

    fakeServer();
    vi.mocked(getSupabaseAdmin).mockImplementation(() => {
      throw new Error("Supabase admin requires a service role key");
    });
    expect(await denial(await requireExecPrincipal(request(), ROUTE))).toEqual({ status: 503, body: { error: "auth unavailable" } });
    expect(loadPrincipalForUser).not.toHaveBeenCalled();
  });

  it("404s any signed-in user who isn't the owner, without loading a principal", async () => {
    fakeServer();
    const admin = fakeAdmin({ userRow: { id: "u_7", email: "leader@scaledai.org" } });
    expect(await denial(await requireExecPrincipal(request(), ROUTE))).toEqual({ status: 404, body: { error: "not found" } });
    expect(loadPrincipalForUser).not.toHaveBeenCalled();
    expect(admin.logRows).toEqual([]);

    fakeServer();
    fakeAdmin({ userRow: { id: "u_8", email: null } });
    expect((await denial(await requireExecPrincipal(request(), ROUTE))).status).toBe(404);
    expect(loadPrincipalForUser).not.toHaveBeenCalled();
  });

  it("matches the owner's email case- and whitespace-insensitively", async () => {
    fakeServer();
    fakeAdmin({ userRow: { id: "u_1", email: "  Mitchell@ScaledAI.org " } });
    expect((await requireExecPrincipal(request(), ROUTE)).ok).toBe(true);
  });

  it("404s when the owner has no enabled principal", async () => {
    fakeServer();
    const admin = fakeAdmin();
    vi.mocked(loadPrincipalForUser).mockResolvedValue(null);
    expect(await denial(await requireExecPrincipal(request(), ROUTE))).toEqual({ status: 404, body: { error: "not found" } });
    expect(admin.logRows).toEqual([]);
  });

  it("503s when the principal lookup throws", async () => {
    fakeServer();
    fakeAdmin();
    vi.mocked(loadPrincipalForUser).mockRejectedValue(new Error("exec_principals read failed: timeout"));
    expect(await denial(await requireExecPrincipal(request(), ROUTE))).toEqual({ status: 503, body: { error: "auth unavailable" } });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("writes one access-log row for a granted request", async () => {
    fakeServer();
    const admin = fakeAdmin();
    await requireExecPrincipal(request(), ROUTE);
    expect(admin.logRows).toEqual([
      {
        principal_id: "ep_1",
        auth_user_id: OWNER_AUTH_ID,
        session_id: "sess-1",
        ip: "203.0.113.7",
        user_agent: "Mozilla/5.0 Test",
        route: ROUTE,
        surface: "web"
      }
    ]);
  });

  it("still grants access when the access log write fails or throws", async () => {
    fakeServer();
    fakeAdmin({ logError: { message: "relation exec_access_log does not exist" } });
    expect((await requireExecPrincipal(request(), ROUTE)).ok).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("access log write failed"));

    fakeServer();
    fakeAdmin({ logThrows: new Error("network down") });
    expect((await requireExecPrincipal(request(), ROUTE)).ok).toBe(true);
  });

  it("logs a null session id when the session can't be read, and still grants access", async () => {
    for (const opts of [
      { sessionError: { message: "session missing" } },
      { getSessionThrows: new Error("cookie parse") },
      { session: null },
      { session: {} },
      { session: { access_token: jwt({ sub: OWNER_AUTH_ID }) } },
      { session: { access_token: "not-a-jwt" } }
    ] satisfies ServerOpts[]) {
      fakeServer(opts);
      const admin = fakeAdmin();
      const result = await requireExecPrincipal(request(), ROUTE);
      expect(result.ok).toBe(true);
      expect(admin.logRows[0]?.session_id).toBeNull();
    }
    expect(warnSpy).toHaveBeenCalled();
  });

  it("records a null ip and user agent when the request has neither", async () => {
    fakeServer();
    const admin = fakeAdmin();
    await requireExecPrincipal(request({}), ROUTE);
    expect(admin.logRows[0]).toMatchObject({ ip: null, user_agent: null });
  });
});

describe("logAccess", () => {
  const entry = {
    principalId: "ep_1",
    authUserId: OWNER_AUTH_ID,
    sessionId: "sess-1",
    ip: "203.0.113.7",
    userAgent: "UA",
    route: ROUTE,
    surface: "slack" as const
  };

  it("inserts the row as given", async () => {
    const admin = fakeAdmin();
    await logAccess(entry);
    expect(admin.logRows).toEqual([
      {
        principal_id: "ep_1",
        auth_user_id: OWNER_AUTH_ID,
        session_id: "sess-1",
        ip: "203.0.113.7",
        user_agent: "UA",
        route: ROUTE,
        surface: "slack"
      }
    ]);
  });

  it("truncates the user agent to 400 characters and caps the other client-supplied fields", async () => {
    const admin = fakeAdmin();
    await logAccess({ ...entry, userAgent: "u".repeat(5_000), ip: "9".repeat(500), route: "r".repeat(500), sessionId: "s".repeat(500) });
    const row = admin.logRows[0];
    expect((row.user_agent as string).length).toBe(400);
    expect((row.ip as string).length).toBe(64);
    expect((row.route as string).length).toBe(200);
    expect((row.session_id as string).length).toBe(128);
  });

  it("never cuts a surrogate pair in half", async () => {
    const admin = fakeAdmin();
    await logAccess({ ...entry, userAgent: `${"a".repeat(399)}😀tail` });
    expect(admin.logRows[0].user_agent).toBe("a".repeat(399));
  });

  it("keeps nulls as nulls", async () => {
    const admin = fakeAdmin();
    await logAccess({ ...entry, principalId: null, authUserId: null, sessionId: null, ip: null, userAgent: null });
    expect(admin.logRows[0]).toMatchObject({ principal_id: null, auth_user_id: null, session_id: null, ip: null, user_agent: null });
  });

  it("never throws, and logs the failure", async () => {
    vi.mocked(getSupabaseAdmin).mockImplementation(() => {
      throw new Error("no service key");
    });
    await expect(logAccess(entry)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("no service key"));

    fakeAdmin({ logError: { message: "permission denied" } });
    await expect(logAccess(entry)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
  });
});

describe("clientIp", () => {
  const ip = (headers: Record<string, string>) => clientIp(new Request("https://x.test/", { headers }));

  it("uses the first X-Forwarded-For entry, trimmed", () => {
    expect(ip({ "x-forwarded-for": "203.0.113.7, 10.0.0.2" })).toBe("203.0.113.7");
    expect(ip({ "x-forwarded-for": "  2001:db8::1  ,10.0.0.2", "x-real-ip": "198.51.100.1" })).toBe("2001:db8::1");
  });

  it("falls back to X-Real-IP when X-Forwarded-For is absent or empty", () => {
    expect(ip({ "x-real-ip": " 198.51.100.1 " })).toBe("198.51.100.1");
    expect(ip({ "x-forwarded-for": " , 10.0.0.2", "x-real-ip": "198.51.100.1" })).toBe("198.51.100.1");
  });

  it("is null when neither header is usable", () => {
    expect(ip({})).toBeNull();
    expect(ip({ "x-forwarded-for": " ", "x-real-ip": " " })).toBeNull();
  });
});

describe("sessionIdFromAccessToken", () => {
  it("reads session_id from the payload", () => {
    expect(sessionIdFromAccessToken(jwt({ sub: OWNER_AUTH_ID, session_id: "sess-1" }))).toBe("sess-1");
  });

  it("checks sub when an expected user is given", () => {
    const token = jwt({ sub: OWNER_AUTH_ID, session_id: "sess-1" });
    expect(sessionIdFromAccessToken(token, OWNER_AUTH_ID)).toBe("sess-1");
    expect(sessionIdFromAccessToken(token, OTHER_AUTH_ID)).toBeNull();
    expect(sessionIdFromAccessToken(jwt({ session_id: "sess-1" }), OWNER_AUTH_ID)).toBeNull();
  });

  it("returns null for anything that isn't a three-part token with a string session_id", () => {
    const head = b64url({ alg: "HS256" });
    const cases: unknown[] = [
      "",
      "abc",
      `${head}.${b64url({ session_id: "s" })}`,
      `${head}.${b64url({ session_id: "s" })}.sig.extra`,
      `${head}..sig`,
      `${head}.${Buffer.from("{not json").toString("base64url")}.sig`,
      `${head}.@@@.sig`,
      jwt(null),
      jwt([1, 2]),
      jwt(42),
      jwt("session"),
      jwt({ session_id: 7 }),
      jwt({ session_id: "" }),
      jwt({ sid: "s" }),
      null,
      undefined,
      12
    ];
    for (const c of cases) expect(sessionIdFromAccessToken(c as string)).toBeNull();
  });
});
