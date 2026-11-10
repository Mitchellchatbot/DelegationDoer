// P9 (F1; AM-P9-15) test support for the real-gate tests: access tokens as GoTrue writes them (amr and aal), so
// page-access, chat-access, access-session, access-clientip and the route tests that run the real gate build the same
// strong session the same way.
//
// A strong session = a password sign-in with no one-time link anywhere in its record (signInIsStrong), whatever its
// aal. P9 also required his authenticator code, pinned in EXEC_OWNER_MFA_FACTOR_IDS; that was removed on 2026-11-10,
// so nothing here fakes factors any more. Since the same day the step-up runs only while EXEC_REQUIRE_PASSWORD_SIGNIN is
// "true" (isStepUpOn); off, every session on his account is admitted. Everything here is a fake: no GoTrue call is made.

export const OWNER_AUTH_ID = "11111111-1111-4111-8111-111111111111";

/** When the fixture sessions signed in (seconds; 2026-10-26T07:33:20Z). */
export const SIGNED_IN_AT = 1_793_000_000;

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

/** A token with amr [{ method, timestamp }] per method (default: a password sign-in at aal1). */
export function stepUpToken(opts: StepUpTokenOptions = {}): string {
  return jwt({
    sub: opts.sub ?? OWNER_AUTH_ID,
    session_id: opts.sessionId ?? "sess-1",
    aal: opts.aal ?? "aal1",
    amr: (opts.methods ?? ["password"]).map((method) => ({ method, timestamp: opts.at ?? SIGNED_IN_AT }))
  });
}

/** His password sign-in (aal1, amr [password]): what the step-up admits. */
export const strongToken = (sessionId = "sess-1", sub = OWNER_AUTH_ID) => stepUpToken({ sub, sessionId, aal: "aal1", methods: ["password"] });
/** F1: a leader-minted link session that enrolled and verified its own authenticator (aal2, amr [totp, otp]): refused while the step-up is on. */
export const linkWithOwnFactorToken = (sessionId = "sess-2", sub = OWNER_AUTH_ID) => stepUpToken({ sub, sessionId, aal: "aal2", methods: ["totp", "otp"] });

/** Lets fire-and-forget work (the refusal record, the new-network hook) and its dynamic imports settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
}
