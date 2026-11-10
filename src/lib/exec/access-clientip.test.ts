import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// P8 contract §5.15 NA01, NA04, NA10, NA12 (M13, C20, C21): clientIp's right-most hop, and the strong-web-access hook in
// the shared gate body: only after the step-up ran, fire-and-forget, loaded lazily. The hook module is mocked here (its
// own suite is handlers/access-alert.test.ts); its factory can hold the import open or fail it.

const hookState = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  fail: false,
  note: vi.fn()
}));

vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", () => ({ loadPrincipalForUser: vi.fn(), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/handlers/access-alert", async () => {
  if (hookState.hold) await hookState.hold;
  if (hookState.fail) throw new Error("module load failed at 203.0.113.7");
  return { noteStrongWebAccess: hookState.note };
});

import { STEP_UP_REFUSED_SUFFIX, clientIp, requireExecPrincipal } from "@/lib/exec/access";
import { loadPrincipalForUser } from "@/lib/exec/principal";
import { fakeFactorAdmin, passwordOnlyToken, pinFactors, settle as settleAll, strongToken } from "@/lib/exec/__tests__/step-up-fixtures";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getSupabaseServer } from "@/lib/supabase-server";

const OWNER_AUTH_ID = "11111111-1111-4111-8111-111111111111";
const ROUTE = "GET /api/exec/overview";
const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const jwt = (payload: unknown) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.c2ln`;
// P9 (F2, AM-P9-15): a strong session is his password plus his pinned code (aal2); the pin is set in beforeEach.
const STRONG = strongToken("sess-strong", OWNER_AUTH_ID);
const LINK = jwt({ sub: OWNER_AUTH_ID, session_id: "sess-link", aal: "aal1", amr: [{ method: "otp", timestamp: 1793977000 }] });
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const PRINCIPAL = Object.freeze({
  id: "ep_1", userId: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", timezone: "America/New_York",
  briefTimezone: "America/New_York", workTimezone: "America/New_York", mailAccountIds: Object.freeze([]), slackTeamId: null, slackUserId: null
}) as unknown as ExecPrincipal;

function fakeServer(token: string) {
  const auth = {
    getUser: vi.fn(async () => ({ data: { user: { id: OWNER_AUTH_ID } }, error: null })),
    getSession: vi.fn(async () => ({ data: { session: { access_token: token } }, error: null }))
  };
  vi.mocked(getSupabaseServer).mockReturnValue({ auth } as unknown as ReturnType<typeof getSupabaseServer>);
}

function fakeAdmin() {
  const logRows: Record<string, unknown>[] = [];
  const client = {
    auth: fakeFactorAdmin().auth,
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

const request = (xff = "198.51.100.23, 203.0.113.7") =>
  new Request("https://operations.scaledai.org/api/exec/overview", { headers: { "x-forwarded-for": xff, "user-agent": UA } });
/** Lets every pending microtask and the mocked module's import settle. */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
};

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(loadPrincipalForUser).mockResolvedValue(PRINCIPAL);
  vi.stubEnv("EXEC_ENABLED", "true");
  pinFactors();
  hookState.note.mockReset();
  hookState.fail = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// NA10 runs first: the mocked module is loaded (and cached) by the first strong request, which this test holds open.
describe("the strong-web-access hook: the request never waits (NA10)", () => {
  it("NA10 the gate resolves while the hook's module is still loading; the hook then runs once", async () => {
    let release!: () => void;
    hookState.hold = new Promise<void>((r) => (release = r));
    fakeServer(STRONG);
    fakeAdmin();
    const gate = await requireExecPrincipal(request(), ROUTE, { requireStrongSignIn: true });
    expect(gate.ok).toBe(true);
    await settle();
    expect(hookState.note).not.toHaveBeenCalled();
    release();
    hookState.hold = null;
    await settle();
    expect(hookState.note).toHaveBeenCalledTimes(1);
  });
});

describe("the strong-web-access hook (NA04)", () => {
  it("NA04 runs only when the step-up ran: a gate call without requireStrongSignIn enqueues nothing", async () => {
    fakeServer(STRONG);
    fakeAdmin();
    expect((await requireExecPrincipal(request(), ROUTE)).ok).toBe(true);
    await settle();
    expect(hookState.note).not.toHaveBeenCalled();
  });

  it("NA04 a refused step-up (a link sign-in) never reaches it", async () => {
    fakeServer(LINK);
    fakeAdmin();
    expect((await requireExecPrincipal(request(), ROUTE, { requireStrongSignIn: true })).ok).toBe(false);
    await settle();
    expect(hookState.note).not.toHaveBeenCalled();
  });

  it("P9 F2: a password-only session (aal1) under the step-up never reaches it; its refusal row is not a sighting", async () => {
    fakeServer(passwordOnlyToken("sess-pw", OWNER_AUTH_ID));
    const admin = fakeAdmin();
    expect((await requireExecPrincipal(request(), ROUTE, { requireStrongSignIn: true })).ok).toBe(false);
    await settleAll();
    expect(hookState.note).not.toHaveBeenCalled();
    expect(admin.logRows).toEqual([expect.objectContaining({ route: `${ROUTE}${STEP_UP_REFUSED_SUFFIX}`, ip: "203.0.113.7" })]);
  });

  it("NA04 a strong session: the hook gets the principal, the right-most hop, the user agent and the time, after the access row", async () => {
    fakeServer(STRONG);
    const admin = fakeAdmin();
    const before = Date.now();
    await requireExecPrincipal(request(), ROUTE, { requireStrongSignIn: true });
    await settle();
    expect(hookState.note).toHaveBeenCalledTimes(1);
    const [p, entry] = hookState.note.mock.calls[0] as [ExecPrincipal, { ip: string | null; userAgent: string | null; now: Date }];
    expect(p).toBe(PRINCIPAL);
    expect(entry.ip).toBe("203.0.113.7");
    expect(entry.userAgent).toBe(UA);
    expect(entry.now.getTime()).toBeGreaterThanOrEqual(before);
    expect(Object.keys(entry).sort()).toEqual(["ip", "now", "userAgent"]);
    expect(admin.logRows).toHaveLength(1);
    expect(admin.logRows[0]).toMatchObject({ ip: "203.0.113.7", user_agent: UA, surface: "web" });
  });

  it("NA10 a failing hook (or a rejected import) is logged by route and error name only, and the gate still answers", async () => {
    hookState.note.mockImplementation(() => {
      throw new TypeError("boom at 203.0.113.7");
    });
    fakeServer(STRONG);
    fakeAdmin();
    expect((await requireExecPrincipal(request(), ROUTE, { requireStrongSignIn: true })).ok).toBe(true);
    await settle();
    expect(warnSpy).toHaveBeenCalledWith(`[exec-access] ${ROUTE}: new-network check unavailable (TypeError)`);
    for (const call of warnSpy.mock.calls) expect(JSON.stringify(call)).not.toContain("203.0.113");
  });

  it("NA10 a rejected import of the hook's module is logged by route only", async () => {
    // A fresh module graph whose hook module fails to load.
    vi.resetModules();
    vi.doMock("@/lib/exec/handlers/access-alert", () => {
      throw new Error("module load failed at 203.0.113.7");
    });
    try {
      const { requireExecPrincipal: fresh } = await import("@/lib/exec/access");
      fakeServer(STRONG);
      fakeAdmin();
      expect((await fresh(request(), ROUTE, { requireStrongSignIn: true })).ok).toBe(true);
      await settle();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^\\[exec-access\\] ${ROUTE}: new-network check unavailable \\((?:Error|SyntaxError)\\)$`)));
      for (const call of warnSpy.mock.calls) expect(JSON.stringify(call)).not.toContain("203.0.113");
    } finally {
      vi.doUnmock("@/lib/exec/handlers/access-alert");
    }
  });
});

describe("clientIp (C21)", () => {
  const ip = (headers: Record<string, string>) => clientIp(new Request("https://x.test/", { headers }));

  it("NA01 the right-most entry wins; a single entry is itself", () => {
    expect(ip({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" })).toBe("2.2.2.2");
    expect(ip({ "x-forwarded-for": "1.1.1.1" })).toBe("1.1.1.1");
    expect(ip({ "x-forwarded-for": "  1.1.1.1 ,   2.2.2.2   " })).toBe("2.2.2.2");
  });

  it("NA01 empty entries are skipped; nothing usable → null", () => {
    expect(ip({ "x-forwarded-for": "  ,  " })).toBeNull();
    expect(ip({ "x-forwarded-for": "2.2.2.2, , " })).toBe("2.2.2.2");
    expect(ip({ "x-forwarded-for": "" })).toBeNull();
    expect(ip({})).toBeNull();
  });

  it("NA01 brackets and ports are stripped", () => {
    expect(ip({ "x-forwarded-for": "[2001:db8::1]:443" })).toBe("2001:db8::1");
    expect(ip({ "x-forwarded-for": "[2001:DB8::1]" })).toBe("2001:db8::1");
    expect(ip({ "x-forwarded-for": "2.2.2.2:8080" })).toBe("2.2.2.2");
    expect(ip({ "x-forwarded-for": "9.9.9.9, 2001:db8::7" })).toBe("2001:db8::7");
  });

  it("NA01 an invalid right-most entry is null: never a fall back to an earlier one", () => {
    expect(ip({ "x-forwarded-for": "not-an-ip" })).toBeNull();
    expect(ip({ "x-forwarded-for": "1.1.1.1, not-an-ip" })).toBeNull();
    expect(ip({ "x-forwarded-for": "1.1.1.1, 300.1.1.1" })).toBeNull();
    expect(ip({ "x-forwarded-for": "1.1.1.1, unknown" })).toBeNull();
  });

  it("NA01 a spoofed first entry never wins", () => {
    // The client sends its own X-Forwarded-For; the proxy appends what it saw.
    expect(ip({ "x-forwarded-for": "127.0.0.1, 10.0.0.1, 203.0.113.50" })).toBe("203.0.113.50");
  });

  it("NA01 X-Real-IP alone → null (it's no longer read)", () => {
    expect(ip({ "x-real-ip": "198.51.100.1" })).toBeNull();
    expect(ip({ "x-real-ip": "198.51.100.1", "x-forwarded-for": "2.2.2.2" })).toBe("2.2.2.2");
  });

  it("NA12 the gate's access row records the right-most hop", async () => {
    fakeServer(LINK);
    const admin = fakeAdmin();
    await requireExecPrincipal(request("6.6.6.6, 203.0.113.9"), ROUTE);
    expect(admin.logRows[0]).toMatchObject({ ip: "203.0.113.9" });
  });
});
