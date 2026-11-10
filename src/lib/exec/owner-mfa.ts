import "server-only";

import { notifyOps, type OpsAlert } from "@/lib/exec/ops";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// The owner's second factor, checked on the server (P9 contract F2, owner decisions Q1 and Q2).
//
// access.ts's signInIsStrong proves a session was signed in with a password and no one-time link. That alone can be
// borrowed: anyone who can open a sign-in link to the owner's account (leaders mint them, by agreement) can set a new
// password from DD's Settings and sign in with it. The one thing such a session can't bring is the code on his phone,
// so the step-up also asks, in this order:
//   1. EXEC_OWNER_MFA_FACTOR_IDS pins his authenticator (comma-separated GoTrue factor ids). Unset: the assistant's
//      pages stay closed until it is set up (Q2). Any entry that isn't a factor id: closed too, and ops hears about it.
//   2. The session is at aal2: a code was verified on it.
//   3. GoTrue's admin API lists the account's factors, and every VERIFIED one is pinned. A factor someone else enrolled
//      is never pinned, so it opens nothing (and ops hears about it). None verified: refused.
//   4. P9 fixer security-1: the session's newest second-factor verification (its amr "totp" / "mfa/..." timestamp) is no
//      earlier than the earliest pinned verified factor's created_at, give or take OWNER_FACTOR_TIME_TOLERANCE_MS. The
//      token can't name the factor that raised it to aal2 (auth-js AMREntry is { method, timestamp } only), so the pin is
//      bound to it in time: every one of his sessions verified a pinned factor after it was created, while a session that
//      reached aal2 with a factor of its own before he enrolled (a factor since deleted) carries an older timestamp, and
//      is refused however clean the factor list looks now.
// A factor list that can't be read is an outage (the gate's 503), never an "ok".
//
// Nothing here logs or forwards a factor's secret, a code, a token or an id: alerts carry counts and dates only.

/** EXEC_OWNER_MFA_FACTOR_IDS, parsed. Ids are compared lower-cased. */
export type OwnerFactorPin = { state: "unset" } | { state: "invalid" } | { state: "set"; ids: ReadonlySet<string> };

/** ok: admit; refused / unpinned: the gate's 404; outage: the gate's 503. */
export type OwnerFactorVerdict = "ok" | "refused" | "unpinned" | "outage";

/** Why, as an enum only (for a log line or an ops alert; never a value from the token or from GoTrue). */
export type OwnerFactorReason =
  | "ok"
  | "pin_unset"
  | "pin_invalid"
  | "not_aal2"
  | "no_verified_factor"
  | "unpinned_factor"
  /** P9 fixer security-1: no second-factor verification on this session at or after his pinned factor's creation. */
  | "factor_predates_pin"
  | "factor_read_failed";

export interface OwnerFactorCheck {
  verdict: OwnerFactorVerdict;
  reason: OwnerFactorReason;
}

/** How long a successful factor read is reused, per auth user and session. Failed reads are never kept. */
export const OWNER_FACTOR_CACHE_MS = 60_000;
/**
 * P9 fixer security-1: how much earlier than his pinned factor's created_at the session's code may be recorded and still
 * count. amr timestamps are whole seconds and created_at is sub-second, both written by GoTrue's own clock.
 */
export const OWNER_FACTOR_TIME_TOLERANCE_MS = 5_000;
/** GoTrue's amr methods for a verified second factor (auth-js AMRMethods: "totp", "mfa/totp", "mfa/phone", "mfa/webauthn"). */
const MFA_AMR_METHODS: ReadonlySet<string> = new Set(["totp", "mfa/totp", "mfa/phone", "mfa/webauthn"]);
const CACHE_MAX_ENTRIES = 64;
const CACHE_KEY = "__ddExecOwnerFactorCache" as const;

/** A GoTrue factor id: a UUID (8-4-4-4-12 hex). */
const FACTOR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const OWNER_MFA_OPS = Object.freeze({
  misconfiguredKey: "exec-owner-mfa-misconfigured",
  misconfiguredTitle:
    "EXEC_OWNER_MFA_FACTOR_IDS isn't a comma-separated list of factor ids, so the owner's assistant pages stay closed",
  unpinnedKey: (utcDate: string) => `exec-owner-unpinned-factor:${utcDate}`,
  unpinnedTitle: "The owner's account has a verified second factor that isn't pinned, so the assistant's pages refused it"
});

/** A verified factor as the gate needs it: its id (lower-cased) and when GoTrue created it (null when unreadable). */
interface VerifiedFactor {
  id: string;
  createdAtMs: number | null;
}

interface CachedFactors {
  at: number;
  verified: readonly VerifiedFactor[];
}
type GlobalWithCache = typeof globalThis & { [CACHE_KEY]?: Map<string, CachedFactors> };

/** The process's factor cache (globalThis: Next may load this module more than once per process). */
function factorCache(): Map<string, CachedFactors> {
  const g = globalThis as GlobalWithCache;
  let cache = g[CACHE_KEY];
  if (!cache) {
    cache = new Map();
    g[CACHE_KEY] = cache;
  }
  return cache;
}

/** An ops alert the gate never waits on and that can never decide the verdict (notifyOps is best-effort already). */
function alertOps(alert: OpsAlert): void {
  try {
    const sent: unknown = notifyOps(alert);
    if (sent instanceof Promise) void sent.catch(() => false);
  } catch {
    // An alert that fails changes nothing about the answer.
  }
}

/** Test seam: forget every cached factor read. */
export function __resetOwnerFactorCacheForTests(): void {
  delete (globalThis as GlobalWithCache)[CACHE_KEY];
}

/** EXEC_OWNER_MFA_FACTOR_IDS: unset or blank → unset; every comma-separated entry must be a factor id, else invalid. */
export function readOwnerFactorPin(): OwnerFactorPin {
  const raw = process.env.EXEC_OWNER_MFA_FACTOR_IDS;
  if (typeof raw !== "string" || raw.trim() === "") return { state: "unset" };
  const entries = raw.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !FACTOR_ID_RE.test(entry))) return { state: "invalid" };
  return { state: "set", ids: new Set(entries.map((entry) => entry.toLowerCase())) };
}

/**
 * The newest second-factor verification an amr list records, in ms (null when there is none): GoTrue writes amr as
 * [{ method, timestamp }] with timestamp in whole seconds (auth-js AMREntry); the RFC 8176 string form carries no time.
 */
function newestMfaAtMs(amr: unknown): number | null {
  if (!Array.isArray(amr)) return null;
  let newest: number | null = null;
  for (const entry of amr as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    if (typeof method !== "string" || !MFA_AMR_METHODS.has(method)) continue;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) continue;
    const ms = timestamp * 1000;
    if (newest === null || ms > newest) newest = ms;
  }
  return newest;
}

/** The token's aal, session_id and newest second-factor time, read only when its sub is the verified user (unverified payload: see access.ts). */
function tokenFacts(token: string, authUserId: string): { aal: string | null; sessionId: string | null; mfaAtMs: number | null } | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
  const record = claims as Record<string, unknown>;
  if (record.sub !== authUserId) return null;
  return {
    aal: typeof record.aal === "string" ? record.aal : null,
    sessionId: typeof record.session_id === "string" && record.session_id.length > 0 ? record.session_id : null,
    mfaAtMs: newestMfaAtMs(record.amr)
  };
}

/**
 * The account's verified factors (ids lower-cased, with their created_at), or null when they can't be read. One GoTrue
 * admin call per auth user and session per OWNER_FACTOR_CACHE_MS; a token without a session id is never cached. Never
 * throws: auth-js rejects (not resolves) on a user id that isn't a UUID, and that is a failed read like any other.
 */
async function readVerifiedFactors(authUserId: string, sessionId: string | null, now: number): Promise<readonly VerifiedFactor[] | null> {
  const cache = factorCache();
  const key = sessionId === null ? null : `${authUserId}:${sessionId}`;
  if (key !== null) {
    const hit = cache.get(key);
    if (hit && now - hit.at >= 0 && now - hit.at < OWNER_FACTOR_CACHE_MS) return hit.verified;
  }
  let verified: VerifiedFactor[];
  try {
    const { data, error } = await getSupabaseAdmin().auth.admin.mfa.listFactors({ userId: authUserId });
    if (error || !data || !Array.isArray(data.factors)) return null;
    verified = [];
    for (const factor of data.factors as unknown[]) {
      if (!factor || typeof factor !== "object") return null;
      const { id, status, created_at: createdAt } = factor as { id?: unknown; status?: unknown; created_at?: unknown };
      if (status !== "verified") continue;
      // A verified factor without a usable id can't be shown to be pinned: the read is unusable.
      if (typeof id !== "string" || id === "") return null;
      const createdAtMs = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
      verified.push({ id: id.toLowerCase(), createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : null });
    }
  } catch {
    return null;
  }
  if (key !== null) {
    if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
    cache.set(key, { at: now, verified });
  }
  return verified;
}

/**
 * P9 fixer security-1: whether the session's newest code (`mfaAtMs`) came no earlier than the earliest of his pinned
 * verified factors was created (within OWNER_FACTOR_TIME_TOLERANCE_MS). "undated": a pinned factor's created_at can't
 * be read, so the binding can't be checked (the gate's 503, never an "ok").
 */
function codeAfterPinnedFactor(mfaAtMs: number | null, pinned: readonly VerifiedFactor[]): "ok" | "before" | "undated" {
  let earliest = Infinity;
  for (const f of pinned) {
    if (f.createdAtMs === null) return "undated";
    earliest = Math.min(earliest, f.createdAtMs);
  }
  if (!Number.isFinite(earliest)) return "undated";
  if (mfaAtMs === null) return "before";
  return mfaAtMs + OWNER_FACTOR_TIME_TOLERANCE_MS >= earliest ? "ok" : "before";
}

/**
 * The second-factor half of the step-up, with the reason as an enum. Never throws; every failure to read is an outage.
 * Call it only after GoTrue verified the session (access.ts step 2) and signInIsStrong passed.
 */
export async function ownerFactorCheck(authUserId: string, token: string, opts: { now?: number } = {}): Promise<OwnerFactorCheck> {
  const now = opts.now ?? Date.now();
  const pin = readOwnerFactorPin();
  if (pin.state === "unset") return { verdict: "refused", reason: "pin_unset" };
  if (pin.state === "invalid") {
    alertOps({ key: OWNER_MFA_OPS.misconfiguredKey, title: OWNER_MFA_OPS.misconfiguredTitle });
    return { verdict: "refused", reason: "pin_invalid" };
  }
  const facts = typeof authUserId === "string" && authUserId !== "" ? tokenFacts(token, authUserId) : null;
  if (facts === null || facts.aal !== "aal2") return { verdict: "refused", reason: "not_aal2" };
  const factors = await readVerifiedFactors(authUserId, facts.sessionId, now);
  const verified = factors === null ? null : factors.map((f) => f.id);
  if (verified === null) return { verdict: "outage", reason: "factor_read_failed" };
  if (verified.length === 0) return { verdict: "refused", reason: "no_verified_factor" };
  const unpinned = verified.filter((id) => !pin.ids.has(id)).length;
  if (unpinned > 0) {
    alertOps({
      key: OWNER_MFA_OPS.unpinnedKey(new Date(now).toISOString().slice(0, 10)),
      title: OWNER_MFA_OPS.unpinnedTitle,
      detail: `${unpinned} unpinned verified factor(s)`
    });
    return { verdict: "unpinned", reason: "unpinned_factor" };
  }
  // Every verified factor is pinned here: the session's code must not predate the earliest of them (security-1).
  const timing = codeAfterPinnedFactor(facts.mfaAtMs, factors ?? []);
  if (timing === "undated") return { verdict: "outage", reason: "factor_read_failed" };
  if (timing === "before") return { verdict: "refused", reason: "factor_predates_pin" };
  return { verdict: "ok", reason: "ok" };
}

/** ownerFactorCheck's verdict alone (contract F2 step 1's signature). */
export async function ownerFactorVerdict(authUserId: string, token: string, opts: { now?: number } = {}): Promise<OwnerFactorVerdict> {
  return (await ownerFactorCheck(authUserId, token, opts)).verdict;
}
