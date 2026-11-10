// P9 (F1, F2; AM-P9-15) test support for the real-gate tests: access tokens as GoTrue writes them (amr and aal), the
// owner's pinned authenticator (EXEC_OWNER_MFA_FACTOR_IDS) and a fake of the service-role client's
// auth.admin.mfa.listFactors, so page-access, chat-access, access-session, access-clientip and the route tests that run
// the real gate build the same strong session the same way.
//
// A strong session after P9 = a password sign-in with no one-time link (signInIsStrong), at aal2 (his code verified on
// it), on an account whose verified factors are all pinned. Everything here is a fake: no GoTrue call is made.

import { vi } from "vitest";
import { __resetOwnerFactorCacheForTests } from "@/lib/exec/owner-mfa";

export const OWNER_AUTH_ID = "11111111-1111-4111-8111-111111111111";
/** His authenticator, as pinned in EXEC_OWNER_MFA_FACTOR_IDS (a GoTrue factor id is a UUID). */
export const PINNED_FACTOR_ID = "f0f0f0f0-1111-4111-8111-0123456789ab";
/** A verified factor nobody pinned (enrolled by someone else). */
export const STRANGER_FACTOR_ID = "e1e1e1e1-2222-4222-8222-0123456789ab";

/** When the fixture sessions signed in and verified their code (seconds; 2026-10-26T07:33:20Z). */
export const SIGNED_IN_AT = 1_793_000_000;
/**
 * When his pinned factor was created: before SIGNED_IN_AT, as for every one of his sessions (P9 fixer security-1: the gate
 * refuses a session whose code was verified before his pinned factor existed).
 */
export const PINNED_FACTOR_CREATED_AT = "2026-10-20T09:00:00.000Z";

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
/** An access token whose payload is `payload` (the gate reads it unverified, after GoTrue confirmed the session). */
export const jwt = (payload: unknown) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.c2ln`;

export interface StepUpTokenOptions {
  sub?: string;
  sessionId?: string;
  aal?: string;
  methods?: string[];
  /** Every amr entry's timestamp (seconds; default SIGNED_IN_AT). */
  at?: number;
}

/** A token with amr [{ method, timestamp }] per method. */
export function stepUpToken(opts: StepUpTokenOptions = {}): string {
  return jwt({
    sub: opts.sub ?? OWNER_AUTH_ID,
    session_id: opts.sessionId ?? "sess-1",
    aal: opts.aal ?? "aal2",
    amr: (opts.methods ?? ["password", "totp"]).map((method) => ({ method, timestamp: opts.at ?? SIGNED_IN_AT }))
  });
}

/** His password plus his code: what the step-up admits once the pin is set. */
export const strongToken = (sessionId = "sess-1", sub = OWNER_AUTH_ID) => stepUpToken({ sub, sessionId, aal: "aal2", methods: ["password", "totp"] });
/** A password sign-in without the code (aal1): strong before P9, refused now. */
export const passwordOnlyToken = (sessionId = "sess-1", sub = OWNER_AUTH_ID) => stepUpToken({ sub, sessionId, aal: "aal1", methods: ["password"] });
/** F1: a leader-minted link session that enrolled and verified its own authenticator. */
export const linkWithOwnFactorToken = (sessionId = "sess-2", sub = OWNER_AUTH_ID) => stepUpToken({ sub, sessionId, aal: "aal2", methods: ["totp", "otp"] });

/** Pins `ids` (default: his one factor) in EXEC_OWNER_MFA_FACTOR_IDS and forgets cached factor reads. */
export function pinFactors(...ids: string[]): void {
  vi.stubEnv("EXEC_OWNER_MFA_FACTOR_IDS", (ids.length > 0 ? ids : [PINNED_FACTOR_ID]).join(","));
  __resetOwnerFactorCacheForTests();
}

/** Unsets the pin (owner decision Q2: the assistant's pages stay closed until it is set). */
export function unpinFactors(): void {
  vi.stubEnv("EXEC_OWNER_MFA_FACTOR_IDS", "");
  __resetOwnerFactorCacheForTests();
}

export interface FakeFactor {
  id: string;
  status: "verified" | "unverified";
  factor_type?: "totp" | "phone" | "webauthn";
  friendly_name?: string;
  created_at?: string;
  updated_at?: string;
}

export const verifiedFactor = (id = PINNED_FACTOR_ID, over: Partial<FakeFactor> = {}): FakeFactor => ({
  id,
  status: "verified",
  factor_type: "totp",
  friendly_name: "Authenticator",
  created_at: PINNED_FACTOR_CREATED_AT,
  updated_at: PINNED_FACTOR_CREATED_AT,
  ...over
});

export interface FactorAdminOptions {
  /** The account's factors (default: his one verified, pinned factor). */
  factors?: FakeFactor[];
  /** listFactors resolves { data: null, error } (an HTTP or network failure). */
  error?: { name: string; message: string; status?: number };
  /** listFactors rejects (auth-js's plain Error for a user id that isn't a UUID, or a broken client). */
  throws?: Error;
}

/** The auth.admin.mfa half of the service-role client: attach it as `auth` on a fake admin client. */
export function fakeFactorAdmin(opts: FactorAdminOptions = {}) {
  const listFactors = vi.fn(async (params: { userId: string }) => {
    void params;
    if (opts.throws) throw opts.throws;
    if (opts.error) return { data: null, error: opts.error };
    return { data: { factors: opts.factors ?? [verifiedFactor()] }, error: null };
  });
  return { auth: { admin: { mfa: { listFactors } } }, listFactors };
}

/** Lets fire-and-forget work (the refusal record, the new-network hook) and its dynamic imports settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
}
