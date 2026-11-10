import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// P9 contract F2 step 1 (owner decisions Q1, Q2): owner-mfa.ts, the second half of the step-up. The service-role
// client's auth.admin.mfa.listFactors and the ops channel are fakes at their module boundary; no GoTrue call is made.

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn(async () => false) }));

import { notifyOps } from "@/lib/exec/ops";
import {
  OWNER_FACTOR_CACHE_MS,
  OWNER_FACTOR_TIME_TOLERANCE_MS,
  OWNER_MFA_OPS,
  __resetOwnerFactorCacheForTests,
  ownerFactorCheck,
  ownerFactorVerdict,
  readOwnerFactorPin
} from "@/lib/exec/owner-mfa";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  OWNER_AUTH_ID,
  PINNED_FACTOR_ID,
  SIGNED_IN_AT,
  STRANGER_FACTOR_ID,
  fakeFactorAdmin,
  jwt,
  passwordOnlyToken,
  stepUpToken,
  strongToken,
  verifiedFactor,
  type FactorAdminOptions
} from "@/lib/exec/__tests__/step-up-fixtures";

const NOW = Date.parse("2026-11-10T14:00:00.000Z");
const STRONG = strongToken("sess-1", OWNER_AUTH_ID);

function admin(opts: FactorAdminOptions = {}) {
  const fake = fakeFactorAdmin(opts);
  vi.mocked(getSupabaseAdmin).mockReturnValue({ auth: fake.auth } as unknown as SupabaseClient);
  return fake.listFactors;
}

beforeEach(() => {
  __resetOwnerFactorCacheForTests();
  vi.stubEnv("EXEC_OWNER_MFA_FACTOR_IDS", PINNED_FACTOR_ID);
  vi.mocked(notifyOps).mockResolvedValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readOwnerFactorPin (EXEC_OWNER_MFA_FACTOR_IDS)", () => {
  it("unset or blank → unset", () => {
    for (const v of [undefined, "", "   "]) {
      vi.stubEnv("EXEC_OWNER_MFA_FACTOR_IDS", v);
      expect(readOwnerFactorPin()).toEqual({ state: "unset" });
    }
  });

  it("one or more factor ids (trimmed, compared lower-case) → set", () => {
    vi.stubEnv("EXEC_OWNER_MFA_FACTOR_IDS", ` ${PINNED_FACTOR_ID.toUpperCase()} , ${STRANGER_FACTOR_ID}`);
    const pin = readOwnerFactorPin();
    expect(pin.state).toBe("set");
    if (pin.state === "set") expect([...pin.ids]).toEqual([PINNED_FACTOR_ID, STRANGER_FACTOR_ID]);
  });

  it.each([
    ["a non-UUID entry", `${PINNED_FACTOR_ID},abc`],
    ["an empty entry (a trailing comma)", `${PINNED_FACTOR_ID},`],
    ["an id with a character too many", `${PINNED_FACTOR_ID}0`],
    ["a factor's friendly name instead of its id", "Authenticator"],
    ["two ids glued without a comma", `${PINNED_FACTOR_ID} ${STRANGER_FACTOR_ID}`]
  ])("any bad entry → invalid (%s)", (_label, raw) => {
    vi.stubEnv("EXEC_OWNER_MFA_FACTOR_IDS", raw);
    expect(readOwnerFactorPin()).toEqual({ state: "invalid" });
  });
});

describe("ownerFactorVerdict", () => {
  it("Q2: the pin unset → refused, with no factor read and no alert", async () => {
    vi.stubEnv("EXEC_OWNER_MFA_FACTOR_IDS", "");
    const listFactors = admin();
    await expect(ownerFactorCheck(OWNER_AUTH_ID, STRONG, { now: NOW })).resolves.toEqual({ verdict: "refused", reason: "pin_unset" });
    expect(listFactors).not.toHaveBeenCalled();
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("a malformed pin → refused and one misconfiguration alert (no value from the env in it)", async () => {
    vi.stubEnv("EXEC_OWNER_MFA_FACTOR_IDS", `${PINNED_FACTOR_ID},nope-not-an-id`);
    const listFactors = admin();
    await expect(ownerFactorCheck(OWNER_AUTH_ID, STRONG, { now: NOW })).resolves.toEqual({ verdict: "refused", reason: "pin_invalid" });
    expect(listFactors).not.toHaveBeenCalled();
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(notifyOps).toHaveBeenCalledWith({ key: OWNER_MFA_OPS.misconfiguredKey, title: OWNER_MFA_OPS.misconfiguredTitle });
    expect(JSON.stringify(vi.mocked(notifyOps).mock.calls)).not.toMatch(/nope-not-an-id|f0f0f0f0/);
  });

  it("an aal1 password token → refused before any factor read", async () => {
    const listFactors = admin();
    await expect(ownerFactorCheck(OWNER_AUTH_ID, passwordOnlyToken("sess-1", OWNER_AUTH_ID), { now: NOW })).resolves.toEqual({ verdict: "refused", reason: "not_aal2" });
    expect(listFactors).not.toHaveBeenCalled();
  });

  it("a token for someone else, with no aal, or that isn't a JWT → refused", async () => {
    admin();
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, strongToken("sess-1", "22222222-2222-4222-8222-222222222222"), { now: NOW })).toBe("refused");
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, stepUpToken({ aal: "" }), { now: NOW })).toBe("refused");
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, "not-a-jwt", { now: NOW })).toBe("refused");
    expect(await ownerFactorVerdict("", STRONG, { now: NOW })).toBe("refused");
  });

  it("aal2 with only pinned verified factors → ok (an unverified factor beside them changes nothing)", async () => {
    const listFactors = admin({ factors: [verifiedFactor(PINNED_FACTOR_ID), verifiedFactor(STRANGER_FACTOR_ID, { status: "unverified" })] });
    await expect(ownerFactorCheck(OWNER_AUTH_ID, STRONG, { now: NOW })).resolves.toEqual({ verdict: "ok", reason: "ok" });
    expect(listFactors).toHaveBeenCalledWith({ userId: OWNER_AUTH_ID });
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("the pin matches whatever the case GoTrue or the env writes the id in", async () => {
    vi.stubEnv("EXEC_OWNER_MFA_FACTOR_IDS", PINNED_FACTOR_ID.toUpperCase());
    admin({ factors: [verifiedFactor(PINNED_FACTOR_ID)] });
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, STRONG, { now: NOW })).toBe("ok");
  });

  it("aal2 with one unpinned verified factor → unpinned and one daily-keyed alert with a count only", async () => {
    admin({ factors: [verifiedFactor(PINNED_FACTOR_ID), verifiedFactor(STRANGER_FACTOR_ID)] });
    await expect(ownerFactorCheck(OWNER_AUTH_ID, STRONG, { now: NOW })).resolves.toEqual({ verdict: "unpinned", reason: "unpinned_factor" });
    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(notifyOps).toHaveBeenCalledWith({ key: "exec-owner-unpinned-factor:2026-11-10", title: OWNER_MFA_OPS.unpinnedTitle, detail: "1 unpinned verified factor(s)" });
    expect(JSON.stringify(vi.mocked(notifyOps).mock.calls)).not.toContain(STRANGER_FACTOR_ID.slice(0, 8));
  });

  it("only someone else's factor verified (his pinned one gone) → unpinned", async () => {
    admin({ factors: [verifiedFactor(STRANGER_FACTOR_ID)] });
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, STRONG, { now: NOW })).toBe("unpinned");
  });

  it("no verified factor at all → refused", async () => {
    admin({ factors: [] });
    await expect(ownerFactorCheck(OWNER_AUTH_ID, STRONG, { now: NOW })).resolves.toEqual({ verdict: "refused", reason: "no_verified_factor" });
  });

  it("listFactors answering an error → outage (never ok)", async () => {
    admin({ error: { name: "AuthApiError", message: "User not found", status: 404 } });
    await expect(ownerFactorCheck(OWNER_AUTH_ID, STRONG, { now: NOW })).resolves.toEqual({ verdict: "outage", reason: "factor_read_failed" });
  });

  it("listFactors rejecting (auth-js's UUID check, a broken client) or an unusable answer → outage; it never throws", async () => {
    admin({ throws: new Error("@supabase/auth-js: Expected parameter to be UUID but is not") });
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, STRONG, { now: NOW })).toBe("outage");
    vi.mocked(getSupabaseAdmin).mockImplementation(() => {
      throw new Error("Supabase admin requires a service role key");
    });
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, STRONG, { now: NOW })).toBe("outage");
    for (const data of [null, { factors: null }, { factors: [null] }, { factors: [{ status: "verified" }] }]) {
      __resetOwnerFactorCacheForTests();
      const listFactors = vi.fn(async () => ({ data, error: null }));
      vi.mocked(getSupabaseAdmin).mockReturnValue({ auth: { admin: { mfa: { listFactors } } } } as unknown as SupabaseClient);
      expect(await ownerFactorVerdict(OWNER_AUTH_ID, STRONG, { now: NOW }), JSON.stringify(data)).toBe("outage");
    }
  });

  it("a second call within 60 s doesn't call listFactors again; after 60 s it reads again", async () => {
    const listFactors = admin();
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, STRONG, { now: NOW })).toBe("ok");
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, STRONG, { now: NOW + OWNER_FACTOR_CACHE_MS - 1 })).toBe("ok");
    expect(listFactors).toHaveBeenCalledTimes(1);
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, STRONG, { now: NOW + OWNER_FACTOR_CACHE_MS })).toBe("ok");
    expect(listFactors).toHaveBeenCalledTimes(2);
  });

  it("a failed read isn't cached: the next call reads again and can succeed", async () => {
    admin({ error: { name: "AuthRetryableFetchError", message: "fetch failed", status: 0 } });
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, STRONG, { now: NOW })).toBe("outage");
    const listFactors = admin();
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, STRONG, { now: NOW + 1 })).toBe("ok");
    expect(listFactors).toHaveBeenCalledTimes(1);
  });

  it("the cache is per session: a new session (one that just reached aal2) reads the factors fresh", async () => {
    const first = admin();
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, STRONG, { now: NOW })).toBe("ok");
    expect(first).toHaveBeenCalledTimes(1);
    // Within the minute someone else's factor appears; a different session doesn't get the cached answer.
    const second = admin({ factors: [verifiedFactor(PINNED_FACTOR_ID), verifiedFactor(STRANGER_FACTOR_ID)] });
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, strongToken("sess-new", OWNER_AUTH_ID), { now: NOW + 1_000 })).toBe("unpinned");
    expect(second).toHaveBeenCalledTimes(1);
    // A token with no session id is never cached.
    const third = admin();
    const noSession = stepUpToken({ sessionId: "" });
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, noSession, { now: NOW })).toBe("ok");
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, noSession, { now: NOW })).toBe("ok");
    expect(third).toHaveBeenCalledTimes(2);
  });

  it("an alert that throws or rejects never changes the verdict", async () => {
    admin({ factors: [verifiedFactor(STRANGER_FACTOR_ID)] });
    vi.mocked(notifyOps).mockRejectedValue(new Error("slack down"));
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, STRONG, { now: NOW })).toBe("unpinned");
    vi.mocked(notifyOps).mockImplementation(() => {
      throw new Error("ops broke");
    });
    __resetOwnerFactorCacheForTests();
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, STRONG, { now: NOW })).toBe("unpinned");
  });

  it("nothing reaches a log line: no token, factor id or session id", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info")].map((s) => s.mockImplementation(() => {}));
    admin({ factors: [verifiedFactor(PINNED_FACTOR_ID), verifiedFactor(STRANGER_FACTOR_ID)] });
    await ownerFactorVerdict(OWNER_AUTH_ID, STRONG, { now: NOW });
    admin({ throws: new Error("boom") });
    __resetOwnerFactorCacheForTests();
    await ownerFactorVerdict(OWNER_AUTH_ID, STRONG, { now: NOW });
    const logged = JSON.stringify(spies.map((s) => s.mock.calls));
    for (const secret of [STRONG, STRONG.split(".")[1], PINNED_FACTOR_ID, STRANGER_FACTOR_ID, "sess-1"]) expect(logged).not.toContain(secret);
  });
});

// P9 fixer security-1: the token can't name the factor that raised it to aal2, so the pin is bound to it in time. A session
// that verified a factor of its own before he enrolled (the runbook's remedy then deletes that factor) still reads aal2 with
// amr [password, totp]; its code is older than his pinned factor, so it is refused even once the factor list is clean.
describe("ownerFactorVerdict: the code is bound to the pinned factor in time (security-1)", () => {
  const CREATED_MS = Date.parse("2026-11-10T09:00:00.000Z");
  const pinnedAt = (iso: string) => verifiedFactor(PINNED_FACTOR_ID, { created_at: iso });
  /** His password, then a code verified at `atMs` (amr timestamps are whole seconds). */
  const codeAt = (atMs: number, sessionId = "sess-t") => stepUpToken({ sessionId, at: Math.floor(atMs / 1000) });

  it("a code verified before his pinned factor was created → refused (factor_predates_pin), no alert; one verified after it → ok", async () => {
    const listFactors = admin({ factors: [pinnedAt("2026-11-10T09:00:00.000Z")] });
    // S: aal2 with its own factor on the 9th; that factor was deleted, then he enrolled the pinned one on the 10th.
    await expect(ownerFactorCheck(OWNER_AUTH_ID, codeAt(CREATED_MS - 86_400_000, "sess-s"), { now: NOW }))
      .resolves.toEqual({ verdict: "refused", reason: "factor_predates_pin" });
    expect(listFactors).toHaveBeenCalledTimes(1);
    expect(notifyOps).not.toHaveBeenCalled();
    // His own session: the code came after the factor existed.
    await expect(ownerFactorCheck(OWNER_AUTH_ID, codeAt(CREATED_MS + 60_000, "sess-m"), { now: NOW })).resolves.toEqual({ verdict: "ok", reason: "ok" });
  });

  it("within the tolerance (whole-second amr times) → ok; just past it → refused", async () => {
    admin({ factors: [pinnedAt("2026-11-10T09:00:00.000Z")] });
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, codeAt(CREATED_MS - 900, "sess-a"), { now: NOW })).toBe("ok");
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, codeAt(CREATED_MS - OWNER_FACTOR_TIME_TOLERANCE_MS, "sess-b"), { now: NOW })).toBe("ok");
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, codeAt(CREATED_MS - OWNER_FACTOR_TIME_TOLERANCE_MS - 1_000, "sess-c"), { now: NOW })).toBe("refused");
  });

  it("two pinned factors: the EARLIEST bounds it (a code after his older factor is his), and the newest code on the session counts", async () => {
    vi.stubEnv("EXEC_OWNER_MFA_FACTOR_IDS", `${PINNED_FACTOR_ID},${STRANGER_FACTOR_ID}`);
    admin({ factors: [pinnedAt("2026-11-10T09:00:00.000Z"), verifiedFactor(STRANGER_FACTOR_ID, { created_at: "2026-11-12T09:00:00.000Z" })] });
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, codeAt(CREATED_MS + 3_600_000, "sess-1a"), { now: NOW })).toBe("ok");
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, codeAt(CREATED_MS - 3_600_000, "sess-1b"), { now: NOW })).toBe("refused");
    // An old totp entry beside a newer webauthn one: the newer one is the session's latest second factor.
    const at = (ms: number) => Math.floor(ms / 1000);
    const both = jwt({ sub: OWNER_AUTH_ID, session_id: "sess-1c", aal: "aal2",
      amr: [{ method: "password", timestamp: at(CREATED_MS - 7_200_000) }, { method: "totp", timestamp: at(CREATED_MS - 3_600_000) }, { method: "mfa/webauthn", timestamp: at(CREATED_MS + 60_000) }] });
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, both, { now: NOW })).toBe("ok");
  });

  it("an aal2 token whose amr records no second factor (or only the RFC 8176 string form, which has no time) → refused", async () => {
    admin();
    expect(await ownerFactorCheck(OWNER_AUTH_ID, stepUpToken({ sessionId: "sess-np", methods: ["password"] }), { now: NOW }))
      .toEqual({ verdict: "refused", reason: "factor_predates_pin" });
    const strings = jwt({ sub: OWNER_AUTH_ID, session_id: "sess-str", aal: "aal2", amr: ["password", "totp"] });
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, strings, { now: NOW })).toBe("refused");
    const badTime = jwt({ sub: OWNER_AUTH_ID, session_id: "sess-bt", aal: "aal2", amr: [{ method: "password", timestamp: SIGNED_IN_AT }, { method: "totp", timestamp: "soon" }] });
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, badTime, { now: NOW })).toBe("refused");
  });

  it("a pinned verified factor without a readable created_at → outage (the binding can't be checked; never ok)", async () => {
    for (const created of ["", "not a date", undefined]) {
      __resetOwnerFactorCacheForTests();
      admin({ factors: [verifiedFactor(PINNED_FACTOR_ID, { created_at: created as string })] });
      expect(await ownerFactorCheck(OWNER_AUTH_ID, STRONG, { now: NOW }), String(created)).toEqual({ verdict: "outage", reason: "factor_read_failed" });
    }
  });

  it("the cached read keeps the dates: a second call within 60 s applies the binding without another listFactors", async () => {
    const listFactors = admin({ factors: [pinnedAt("2026-11-10T09:00:00.000Z")] });
    const old = codeAt(CREATED_MS - 86_400_000, "sess-cached");
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, old, { now: NOW })).toBe("refused");
    expect(await ownerFactorVerdict(OWNER_AUTH_ID, old, { now: NOW + 1_000 })).toBe("refused");
    expect(listFactors).toHaveBeenCalledTimes(1);
  });
});
