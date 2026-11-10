import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P5b contract §5 test 88 (Area E; §3.19.10, B10, S1): execAskAiRoutingFor,
// the one signal that routes the owner's Ask AI drawer through the assistant.
// It runs the real access.ts; only the I/O around it is faked.

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/principal", () => ({ loadPrincipalForUser: vi.fn(), loadSettings: vi.fn() }));

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getSupabaseServer } from "@/lib/supabase-server";
import { execAskAiRoutingFor } from "@/lib/exec/access";
import { OWNER_AUTH_ID, PINNED_FACTOR_ID, STRANGER_FACTOR_ID, fakeFactorAdmin, pinFactors, unpinFactors, verifiedFactor } from "../__tests__/step-up-fixtures";
import { loadPrincipalForUser, loadSettings } from "@/lib/exec/principal";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import { settings as settingsFixture } from "../__tests__/p5a-ui-fixtures";

const OWNER = { id: "u_owner", email: "mitchell@scaledai.org" };
const LEADER = { id: "u_lead", email: "lead@scaledai.org" };
const PRINCIPAL = Object.freeze({ id: "ep_owner", userId: "u_owner", email: OWNER.email, name: "Mitchell", timezone: "America/New_York" }) as unknown as ExecPrincipal;

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const jwt = (payload: unknown) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.c2ln`;
const token = (methods: string[], aal = "aal1") => jwt({ sub: OWNER_AUTH_ID, session_id: "s", aal, amr: methods.map((method) => ({ method, timestamp: 1_793_000_000 })) });
/** P9 (F1, F2): his password plus his pinned code is the strong session now; a password alone (aal1) is not. */
const STRONG = token(["password", "totp"], "aal2");
const PASSWORD = token(["password"]);
const LINK = token(["otp"]);
const LINK_WITH_MFA = token(["otp", "totp"], "aal2");

const ON: ExecSettings = settingsFixture({ chatSchemaReady: true, chatEnabled: true, askAiUsesExec: true });

function session(opts: { token?: string | null; error?: boolean; throws?: boolean } = {}) {
  const getSession = vi.fn(async () => {
    if (opts.throws) throw new Error("cookies unavailable");
    if (opts.error) return { data: { session: null }, error: { name: "AuthApiError", message: "x" } };
    return { data: { session: opts.token === null ? null : { access_token: opts.token ?? STRONG, user: { id: OWNER_AUTH_ID } } }, error: null };
  });
  vi.mocked(getSupabaseServer).mockReturnValue({ auth: { getSession } } as unknown as ReturnType<typeof getSupabaseServer>);
  return getSession;
}

function factors(list = [verifiedFactor(PINNED_FACTOR_ID)]) {
  const admin = fakeFactorAdmin({ factors: list });
  vi.mocked(getSupabaseAdmin).mockReturnValue({ auth: admin.auth } as unknown as SupabaseClient);
  return admin.listFactors;
}

beforeEach(() => {
  vi.stubEnv("EXEC_ENABLED", "true");
  pinFactors(PINNED_FACTOR_ID);
  factors();
  session();
  vi.mocked(loadPrincipalForUser).mockResolvedValue(PRINCIPAL);
  vi.mocked(loadSettings).mockResolvedValue(ON);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("execAskAiRoutingFor (test 88)", () => {
  it("all on: EXEC_ENABLED, the owner, his password plus his pinned code (P9: was a password session), an enabled principal, chat installed and on, Ask AI on → true", async () => {
    expect(await execAskAiRoutingFor(OWNER)).toBe(true);
    expect(loadPrincipalForUser).toHaveBeenCalledWith("u_owner");
    expect(loadSettings).toHaveBeenCalledWith("ep_owner");
  });

  // P9 F1 (flip): a second factor on top of a link is still a link session.
  it("a one-time link session verified with its own second factor is not strong → false", async () => {
    session({ token: LINK_WITH_MFA });
    expect(await execAskAiRoutingFor(OWNER)).toBe(false);
    expect(loadPrincipalForUser).not.toHaveBeenCalled();
  });

  it("P9 F2: a password sign-in without the code (aal1), the pin unset (Q2) or an unpinned factor → false; a factor read that fails → false", async () => {
    session({ token: PASSWORD });
    expect(await execAskAiRoutingFor(OWNER)).toBe(false);
    session();
    factors([verifiedFactor(PINNED_FACTOR_ID), verifiedFactor(STRANGER_FACTOR_ID)]);
    expect(await execAskAiRoutingFor(OWNER)).toBe(false);
    factors();
    unpinFactors();
    expect(await execAskAiRoutingFor(OWNER)).toBe(false);
    pinFactors(PINNED_FACTOR_ID);
    const broken = fakeFactorAdmin({ error: { name: "AuthRetryableFetchError", message: "fetch failed", status: 0 } });
    vi.mocked(getSupabaseAdmin).mockReturnValue({ auth: broken.auth } as unknown as SupabaseClient);
    expect(await execAskAiRoutingFor(OWNER)).toBe(false);
    expect(loadPrincipalForUser).not.toHaveBeenCalled();
  });

  it("the flag off → false, with nothing read", async () => {
    vi.stubEnv("EXEC_ENABLED", "false");
    const getSession = session();
    expect(await execAskAiRoutingFor(OWNER)).toBe(false);
    expect(getSession).not.toHaveBeenCalled();
    expect(loadPrincipalForUser).not.toHaveBeenCalled();
  });

  it("not the owner → false, with nothing read", async () => {
    const getSession = session();
    expect(await execAskAiRoutingFor(LEADER)).toBe(false);
    expect(await execAskAiRoutingFor({ id: "", email: OWNER.email })).toBe(false);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("a link session (or no session, or an unreadable one) → false, before any principal read", async () => {
    for (const s of [{ token: LINK }, { token: null }, { error: true }]) {
      session(s);
      expect(await execAskAiRoutingFor(OWNER), JSON.stringify(s)).toBe(false);
    }
    expect(loadPrincipalForUser).not.toHaveBeenCalled();
  });

  it("no enabled principal → false", async () => {
    vi.mocked(loadPrincipalForUser).mockResolvedValue(null);
    expect(await execAskAiRoutingFor(OWNER)).toBe(false);
    expect(loadSettings).not.toHaveBeenCalled();
  });

  it("schema missing, chat off, Ask AI off → false", async () => {
    for (const over of [{ chatSchemaReady: false }, { chatEnabled: false }, { askAiUsesExec: false }] as Partial<ExecSettings>[]) {
      vi.mocked(loadSettings).mockResolvedValue({ ...ON, ...over });
      expect(await execAskAiRoutingFor(OWNER), JSON.stringify(over)).toBe(false);
    }
  });

  it("any throw → false (never throws itself)", async () => {
    session({ throws: true });
    expect(await execAskAiRoutingFor(OWNER)).toBe(false);
    session();
    vi.mocked(loadPrincipalForUser).mockRejectedValue(new Error("exec_principals read failed"));
    expect(await execAskAiRoutingFor(OWNER)).toBe(false);
    vi.mocked(loadPrincipalForUser).mockResolvedValue(PRINCIPAL);
    vi.mocked(loadSettings).mockRejectedValue(new Error("exec_settings read failed"));
    expect(await execAskAiRoutingFor(OWNER)).toBe(false);
    vi.mocked(getSupabaseServer).mockImplementation(() => {
      throw new Error("no cookies here");
    });
    expect(await execAskAiRoutingFor(OWNER)).toBe(false);
  });

  it("returns a plain boolean, never the principal", async () => {
    const out: unknown = await execAskAiRoutingFor(OWNER);
    expect(typeof out).toBe("boolean");
  });
});
