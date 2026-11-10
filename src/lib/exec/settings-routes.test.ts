import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
// P9 (F1): the step-up cases below run the REAL gate (vi.importActual) over a faked session; every other test mocks it.
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipal: vi.fn() }));
// Area A's helpers are mocked at the module boundary with the contract's
// behaviour (§3.2): the real ones have their own suite (http.test.ts).
vi.mock("@/lib/exec/http", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/http")>()),
  assertSameOrigin: vi.fn(),
  readJsonBodyOrError: vi.fn(),
  rateLimit: vi.fn(),
  runAudited: vi.fn()
}));
vi.mock("@/lib/exec/principal", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/principal")>()),
  loadSettings: vi.fn(),
  // The step-up cases below hand the real gate its principal; every other test's mocked gate returns one.
  loadPrincipalForUser: vi.fn()
}));
vi.mock("@/lib/exec/settings", async (orig) => ({
  ...(await orig<typeof import("@/lib/exec/settings")>()),
  getSettingsView: vi.fn(),
  updateSettings: vi.fn()
}));
vi.mock("@/lib/exec/drafts-store", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/drafts-store")>()), resetVoiceProfile: vi.fn() }));

import * as settingsRoute from "@/app/api/exec/settings/route";
import * as voiceResetRoute from "@/app/api/exec/settings/voice-reset/route";
import { requireExecPrincipal } from "@/lib/exec/access";
import { resetVoiceProfile } from "@/lib/exec/drafts-store";
import { assertSameOrigin, jsonError, rateLimit, readJsonBodyOrError, runAudited, type AuditOutcomeSummary } from "@/lib/exec/http";
import { DEFAULT_SETTINGS, loadPrincipalForUser, loadSettings, principalFromRows, type SettingsSnapshot } from "@/lib/exec/principal";
import { getSettingsView, updateSettings, type UpdateSettingsResult } from "@/lib/exec/settings";
import type { AuditEntry, ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import type { SettingsView } from "@/lib/exec/view-types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getSupabaseServer } from "@/lib/supabase-server";
import { OWNER_AUTH_ID, settle, stepUpToken, strongToken } from "@/lib/exec/__tests__/step-up-fixtures";

// The Settings routes (P5a contract §3.7.3, §3.7.4; tests 25 and 25b's route
// half). Every collaborator is a mock that records the order it was called
// in, so each test can pin the S2 order: gate → same-origin → body →
// installed → limit → audit → act.

const PRINCIPAL: ExecPrincipal = (() => {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: ["acc_1"], slack_team_id: null, slack_user_id: null },
    { id: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
})();
const V1 = "2026-11-05T09:00:00.123456+00:00";

const settings = (over: Partial<ExecSettings> = {}): ExecSettings => ({
  principalId: "ep_1",
  ...DEFAULT_SETTINGS,
  emailSchemaReady: true,
  draftsSchemaReady: true,
  ddtextSchemaReady: true,
  ...over
});
const snapshot = (over: Partial<ExecSettings> = {}, version: string | null = V1): SettingsSnapshot => ({ settings: settings(over), version });
const VIEW = { generatedAt: "2026-11-06T12:00:00.000Z", version: V1, marker: "the view" } as unknown as SettingsView;

let calls: string[];
interface AuditRecord { entry: AuditEntry; finished: { ok: boolean; result?: { outcome: string }; error?: string } | null }
let audits: AuditRecord[];
let auditDown: boolean;

function request(method: string, path: string, body?: string, headers: Record<string, string> = {}): Request {
  const h: Record<string, string> = { "sec-fetch-site": "same-origin", ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  return new Request(`https://ops.test${path}`, { method, headers: h, ...(body !== undefined ? { body } : {}) });
}
const patchReq = (body: unknown, headers: Record<string, string> = {}) =>
  request("PATCH", "/api/exec/settings", typeof body === "string" ? body : JSON.stringify(body), headers);
const resetReq = (body?: string, headers: Record<string, string> = {}) => request("POST", "/api/exec/settings/voice-reset", body, headers);
const bodyOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

beforeEach(() => {
  calls = [];
  audits = [];
  auditDown = false;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(requireExecPrincipal).mockReset().mockImplementation(async () => {
    calls.push("gate");
    return { ok: true, principal: PRINCIPAL };
  });
  vi.mocked(assertSameOrigin).mockReset().mockImplementation((req: Request) => {
    calls.push("sameOrigin");
    return req.headers.get("sec-fetch-site") === "same-origin" ? { ok: true } : { ok: false, response: jsonError(403, "forbidden") };
  });
  vi.mocked(readJsonBodyOrError).mockReset().mockImplementation(async (req: Request, maxBytes = 4096) => {
    calls.push("body");
    const text = await req.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) return { ok: false, response: jsonError(413, "too_large") };
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, response: jsonError(400, "invalid", { detail: "body" }) };
    }
  });
  vi.mocked(loadSettings).mockReset().mockImplementation(async () => {
    calls.push("settings");
    return settings();
  });
  vi.mocked(rateLimit).mockReset().mockImplementation(async () => {
    calls.push("limit");
    return { ok: true };
  });
  vi.mocked(runAudited).mockReset().mockImplementation(async (_p, entry, fn, outcomeOf) => {
    calls.push("audit");
    if (auditDown) return { ok: false, response: jsonError(503, "unavailable") };
    const record: AuditRecord = { entry, finished: null };
    audits.push(record);
    try {
      const value = await fn();
      const s: AuditOutcomeSummary = (outcomeOf as (v: unknown) => AuditOutcomeSummary)(value);
      record.finished = { ok: s.ok, result: { outcome: s.outcome } };
      return { ok: true, value } as never;
    } catch {
      record.finished = { ok: false, error: "exception" };
      return { ok: false, response: jsonError(503, "unavailable") };
    }
  });
  vi.mocked(updateSettings).mockReset().mockImplementation(async () => {
    calls.push("update");
    return { outcome: "updated", snapshot: snapshot({ retentionDaysChat: 30 }, "2026-11-06T12:00:00.000Z") };
  });
  vi.mocked(getSettingsView).mockReset().mockImplementation(async () => {
    calls.push("view");
    return VIEW;
  });
  vi.mocked(resetVoiceProfile).mockReset().mockImplementation(async () => {
    calls.push("reset");
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const gateFails = (status: 401 | 404 | 503) =>
  vi.mocked(requireExecPrincipal).mockImplementation(async () => {
    calls.push("gate");
    return { ok: false, response: NextResponse.json({ error: "x" }, { status }) };
  });

// ---------------------------------------------------------------------------
// GET /api/exec/settings
// ---------------------------------------------------------------------------

describe("GET /api/exec/settings (test 25)", () => {
  it("gates with a strong sign-in on its own route string, then answers the view, uncached", async () => {
    const res = await settingsRoute.GET(request("GET", "/api/exec/settings"));
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ generatedAt: "2026-11-06T12:00:00.000Z", version: V1, marker: "the view" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(requireExecPrincipal).toHaveBeenCalledWith(expect.any(Request), "GET /api/exec/settings", { requireStrongSignIn: true });
    expect(getSettingsView).toHaveBeenCalledWith(PRINCIPAL, expect.any(Date));
    expect(calls).toEqual(["gate", "view"]);
  });

  for (const status of [401, 404, 503] as const) {
    it(`a gate answer (${status}) is returned as is, and nothing is read`, async () => {
      gateFails(status);
      const res = await settingsRoute.GET(request("GET", "/api/exec/settings"));
      expect(res.status).toBe(status);
      expect(calls).toEqual(["gate"]);
    });
  }

  it("a failed settings read is 503 unavailable, with no detail", async () => {
    vi.mocked(getSettingsView).mockRejectedValue(new Error("exec_settings read failed: down"));
    const res = await settingsRoute.GET(request("GET", "/api/exec/settings"));
    expect(res.status).toBe(503);
    expect(await bodyOf(res)).toEqual({ error: "unavailable" });
  });

  it("exports only GET and PATCH, dynamic on the node runtime", () => {
    expect(Object.keys(settingsRoute).sort()).toEqual(["GET", "PATCH", "dynamic", "runtime"]);
    expect([settingsRoute.dynamic, settingsRoute.runtime]).toEqual(["force-dynamic", "nodejs"]);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/exec/settings
// ---------------------------------------------------------------------------

const GOOD = { patch: { retentionDaysChat: 30 }, expectedVersion: V1 };

describe("PATCH /api/exec/settings (test 25)", () => {
  it("runs gate → same-origin → body → installed → limit → audit → update → view, and answers 200 { settings }", async () => {
    const res = await settingsRoute.PATCH(patchReq(GOOD));
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ settings: { generatedAt: "2026-11-06T12:00:00.000Z", version: V1, marker: "the view" } });
    expect(calls).toEqual(["gate", "sameOrigin", "body", "settings", "limit", "audit", "update", "view"]);
    expect(requireExecPrincipal).toHaveBeenCalledWith(expect.any(Request), "PATCH /api/exec/settings", { requireStrongSignIn: true });
    expect(readJsonBodyOrError).toHaveBeenCalledWith(expect.any(Request), 4096);
    expect(rateLimit).toHaveBeenCalledWith(PRINCIPAL, "settings_update", 30, 600_000);
    expect(updateSettings).toHaveBeenCalledWith(PRINCIPAL, { retentionDaysChat: 30 }, { expectedVersion: V1, confirm: undefined, now: expect.any(Date) });
    // The view is built from the snapshot the write returned (no re-read).
    expect(getSettingsView).toHaveBeenCalledWith(PRINCIPAL, expect.any(Date), { snapshot: snapshot({ retentionDaysChat: 30 }, "2026-11-06T12:00:00.000Z") });
    expect(audits).toEqual([
      {
        entry: { actor: "owner", action: "settings.update", target: "exec_settings:ep_1", input: { changes: { retentionDaysChat: 30 }, confirm: null } },
        finished: { ok: true, result: { outcome: "updated" } }
      }
    ]);
  });

  it("passes the DD text notice confirmation through to the writer and the audit row", async () => {
    await settingsRoute.PATCH(patchReq({ patch: { ddtextEnabled: true }, expectedVersion: V1, confirm: "ddtext_notice" }));
    expect(updateSettings).toHaveBeenCalledWith(PRINCIPAL, { ddtextEnabled: true }, expect.objectContaining({ confirm: "ddtext_notice" }));
    expect(audits[0].entry.input).toEqual({ changes: { ddtextEnabled: true }, confirm: "ddtext_notice" });
  });

  it("accepts a null version (no row yet)", async () => {
    const res = await settingsRoute.PATCH(patchReq({ patch: { retentionDaysEmail: 365 }, expectedVersion: null }));
    expect(res.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith(PRINCIPAL, { retentionDaysEmail: 365 }, expect.objectContaining({ expectedVersion: null }));
  });

  it("a gate failure stops everything", async () => {
    gateFails(401);
    const res = await settingsRoute.PATCH(patchReq(GOOD));
    expect(res.status).toBe(401);
    expect(calls).toEqual(["gate"]);
  });

  it("a cross-site request is 403 forbidden before the body is read", async () => {
    const res = await settingsRoute.PATCH(patchReq(GOOD, { "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toEqual({ error: "forbidden" });
    expect(calls).toEqual(["gate", "sameOrigin"]);
  });

  const BAD_BODIES: [string, string, number, Record<string, unknown>][] = [
    ["over 4 KB", JSON.stringify({ ...GOOD, pad: "x".repeat(5000) }), 413, { error: "too_large" }],
    ["not JSON", "{patch:", 400, { error: "invalid", detail: "body" }],
    ["not an object", JSON.stringify([1, 2]), 400, { error: "invalid", detail: "body" }],
    ["an unknown top-level key", JSON.stringify({ ...GOOD, force: true }), 400, { error: "invalid", detail: "body" }],
    // (P7a made retentionDaysSlack a registry field; briefLocalTime is still not one.)
    ["an unknown setting", JSON.stringify({ patch: { briefLocalTime: "09:00" }, expectedVersion: V1 }), 400, { error: "invalid", detail: "patch" }],
    ["an empty patch", JSON.stringify({ patch: {}, expectedVersion: V1 }), 400, { error: "invalid", detail: "patch" }],
    ["a wrong type", JSON.stringify({ patch: { retentionDaysChat: "30" }, expectedVersion: V1 }), 400, { error: "invalid", detail: "patch.retentionDaysChat" }],
    ["a null value", JSON.stringify({ patch: { voiceEnabled: null }, expectedVersion: V1 }), 400, { error: "invalid", detail: "patch.voiceEnabled" }],
    ["retention 6", JSON.stringify({ patch: { retentionDaysEmail: 6 }, expectedVersion: V1 }), 400, { error: "invalid", detail: "patch.retentionDaysEmail" }],
    ["retention 731", JSON.stringify({ patch: { retentionDaysDdtext: 731 }, expectedVersion: V1 }), 400, { error: "invalid", detail: "patch.retentionDaysDdtext" }],
    ["a cap of 0", JSON.stringify({ patch: { dailyCostCapUsd: 0 }, expectedVersion: V1 }), 400, { error: "invalid", detail: "patch.dailyCostCapUsd" }],
    ["a cap of 100.001", JSON.stringify({ patch: { dailyCostCapUsd: 100.001 }, expectedVersion: V1 }), 400, { error: "invalid", detail: "patch.dailyCostCapUsd" }],
    ["a missing version", JSON.stringify({ patch: { retentionDaysChat: 30 } }), 400, { error: "invalid", detail: "expectedVersion" }],
    ["a version that isn't a timestamp", JSON.stringify({ patch: { retentionDaysChat: 30 }, expectedVersion: "v1; drop" }), 400, { error: "invalid", detail: "expectedVersion" }],
    ["another confirmation", JSON.stringify({ ...GOOD, confirm: "yes" }), 400, { error: "invalid", detail: "confirm" }]
  ];
  for (const [what, body, status, answer] of BAD_BODIES) {
    it(`${what}: ${status} before any read, limit or audit (no rate slot used)`, async () => {
      const res = await settingsRoute.PATCH(patchReq(body));
      expect(res.status).toBe(status);
      expect(await bodyOf(res)).toEqual(answer);
      expect(calls).toEqual(["gate", "sameOrigin", "body"]);
    });
  }

  it("a field whose migration isn't applied is 409 not_installed with its name, before the limit", async () => {
    vi.mocked(loadSettings).mockImplementation(async () => {
      calls.push("settings");
      return settings({ ddtextSchemaReady: false });
    });
    const res = await settingsRoute.PATCH(patchReq({ patch: { retentionDaysChat: 30, retentionDaysDdtext: 30 }, expectedVersion: V1 }));
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual({ error: "not_installed", field: "retentionDaysDdtext" });
    expect(calls).toEqual(["gate", "sameOrigin", "body", "settings"]);
    vi.mocked(loadSettings).mockImplementation(async () => settings({ draftsSchemaReady: false }));
    const voice = await settingsRoute.PATCH(patchReq({ patch: { voiceEnabled: false }, expectedVersion: V1 }));
    expect(await bodyOf(voice)).toEqual({ error: "not_installed", field: "voiceEnabled" });
  });

  it("a failed settings read is 503 before the limit", async () => {
    vi.mocked(loadSettings).mockRejectedValue(new Error("exec_settings read failed: down"));
    const res = await settingsRoute.PATCH(patchReq(GOOD));
    expect(res.status).toBe(503);
    expect(await bodyOf(res)).toEqual({ error: "unavailable" });
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("the rate limit's 429 and 503 come back as is, before the audit", async () => {
    vi.mocked(rateLimit).mockResolvedValueOnce({ ok: false, response: jsonError(429, "rate_limited", { retryAfterSeconds: 42, retryAfterSec: 42 }) });
    const limited = await settingsRoute.PATCH(patchReq(GOOD));
    expect(limited.status).toBe(429);
    expect(await bodyOf(limited)).toMatchObject({ error: "rate_limited", retryAfterSeconds: 42 });
    expect(limited.headers.get("retry-after")).toBe("42");
    vi.mocked(rateLimit).mockResolvedValueOnce({ ok: false, response: jsonError(503, "unavailable") });
    const down = await settingsRoute.PATCH(patchReq(GOOD));
    expect(down.status).toBe(503);
    expect(runAudited).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("the audit log unavailable is 503 and nothing is written", async () => {
    auditDown = true;
    const res = await settingsRoute.PATCH(patchReq(GOOD));
    expect(res.status).toBe(503);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  const REFUSED: [string, UpdateSettingsResult, number, Record<string, unknown>][] = [
    ["conflict", { outcome: "conflict", snapshot: snapshot({ retentionDaysChat: 45 }, "2026-11-06T11:59:00+00:00") }, 409, { error: "conflict", settings: { generatedAt: "2026-11-06T12:00:00.000Z", version: V1, marker: "the view" } }],
    ["invalid", { outcome: "invalid", field: "dailyCostCapUsd", detail: "must be an amount" }, 400, { error: "invalid", detail: "dailyCostCapUsd" }],
    ["not_installed", { outcome: "not_installed", field: "ddtextEnabled" }, 409, { error: "not_installed", field: "ddtextEnabled" }],
    ["confirmation_required", { outcome: "confirmation_required", field: "ddtextEnabled" }, 400, { error: "confirmation_required", field: "ddtextEnabled" }]
  ];
  for (const [outcome, result, status, answer] of REFUSED) {
    it(`a refused write (${outcome}) answers ${status} and finishes its audit row ok = false with the outcome`, async () => {
      vi.mocked(updateSettings).mockResolvedValue(result);
      const res = await settingsRoute.PATCH(patchReq(GOOD));
      expect(res.status).toBe(status);
      expect(await bodyOf(res)).toEqual(answer);
      expect(audits.map((a) => a.finished)).toEqual([{ ok: false, result: { outcome } }]);
      if (outcome === "conflict") expect(getSettingsView).toHaveBeenCalledWith(PRINCIPAL, expect.any(Date), { snapshot: (result as { snapshot: SettingsSnapshot }).snapshot });
      else expect(getSettingsView).not.toHaveBeenCalled();
    });
  }

  it("a writer that throws: 503, no message echoed, the audit row finished as an exception", async () => {
    vi.mocked(updateSettings).mockRejectedValue(new Error("exec_settings update failed: secret detail"));
    const res = await settingsRoute.PATCH(patchReq(GOOD));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await bodyOf(res))).not.toContain("secret");
    expect(audits.map((a) => a.finished)).toEqual([{ ok: false, error: "exception" }]);
  });

  it("an applied change whose view can't be built is 503 (the audit row already says updated)", async () => {
    vi.mocked(getSettingsView).mockRejectedValue(new Error("boom"));
    const res = await settingsRoute.PATCH(patchReq(GOOD));
    expect(res.status).toBe(503);
    expect(audits.map((a) => a.finished)).toEqual([{ ok: true, result: { outcome: "updated" } }]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/exec/settings/voice-reset (test 25b)
// ---------------------------------------------------------------------------

// P9 F1: the route's own gate call, run for real. A sign-in-link session (amr [otp]) gets the gate's 404 and never reaches
// the write. Since the authenticator code was removed (2026-11-10), a password sign-in (aal1, amr [password]) is all the
// step-up asks for: it reaches the write. A link session that sets a new password from DD's Settings can sign in that way
// too; access.ts's header names that gap.
describe("PATCH /api/exec/settings: the P9 step-up, run for real (F1)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** The real gate over a faked session whose access token is `token`; returns the exec_access_log rows it writes. */
  async function realGate(token: string): Promise<Record<string, unknown>[]> {
    const real = await vi.importActual<typeof import("@/lib/exec/access")>("@/lib/exec/access");
    vi.mocked(requireExecPrincipal).mockReset().mockImplementation(real.requireExecPrincipal);
    vi.stubEnv("EXEC_ENABLED", "true");
    const auth = {
      getUser: vi.fn(async () => ({ data: { user: { id: OWNER_AUTH_ID } }, error: null })),
      getSession: vi.fn(async () => ({ data: { session: { access_token: token } }, error: null }))
    };
    vi.mocked(getSupabaseServer).mockReturnValue({ auth } as unknown as ReturnType<typeof getSupabaseServer>);
    const logRows: Record<string, unknown>[] = [];
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from(table: string) {
        if (table === "users") {
          const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { id: "u_1", email: "mitchell@scaledai.org" }, error: null }) };
          return b;
        }
        if (table === "exec_access_log") return { insert: async (row: Record<string, unknown>) => (logRows.push(row), { error: null }) };
        throw new Error(`unexpected table ${table}`);
      }
    } as unknown as SupabaseClient);
    vi.mocked(loadPrincipalForUser).mockResolvedValue(PRINCIPAL);
    return logRows;
  }

  it("a sign-in-link token (aal1, amr [otp]) → the gate's 404: no body read, no settings read, no audit, no write; one refusal row", async () => {
    // The gate warns on a refusal (its log line names the sign-in methods only).
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logRows = await realGate(stepUpToken({ sessionId: "sess-link", aal: "aal1", methods: ["otp"] }));

    const res = await settingsRoute.PATCH(patchReq(GOOD));
    expect(res.status).toBe(404);
    expect(await bodyOf(res)).toEqual({ error: "not found" });
    expect(calls).toEqual([]);
    expect(readJsonBodyOrError).not.toHaveBeenCalled();
    expect(loadSettings).not.toHaveBeenCalled();
    expect(runAudited).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
    await settle();
    expect(logRows).toEqual([expect.objectContaining({ route: "PATCH /api/exec/settings step_up_refused", session_id: "sess-link" })]);
  });

  it("an aal1 password token → admitted: body read, settings read, audit, write (200); one access row, no refusal row", async () => {
    const logRows = await realGate(strongToken("sess-pw", OWNER_AUTH_ID));

    const res = await settingsRoute.PATCH(patchReq(GOOD));
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ settings: { generatedAt: "2026-11-06T12:00:00.000Z", version: V1, marker: "the view" } });
    // The real gate records no "gate" step (only the mocked one does); everything after it runs.
    expect(calls).toEqual(["sameOrigin", "body", "settings", "limit", "audit", "update", "view"]);
    expect(loadPrincipalForUser).toHaveBeenCalledWith("u_1");
    expect(updateSettings).toHaveBeenCalledWith(PRINCIPAL, { retentionDaysChat: 30 }, expect.objectContaining({ expectedVersion: V1 }));
    await settle();
    expect(logRows).toEqual([expect.objectContaining({ route: "PATCH /api/exec/settings", session_id: "sess-pw" })]);
  });
});

describe("POST /api/exec/settings/voice-reset (test 25b)", () => {
  it("runs gate → same-origin → no body → installed → limit → audit → reset, and answers { reset, hadProfile }", async () => {
    const res = await voiceResetRoute.POST(resetReq());
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ reset: true, hadProfile: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(calls).toEqual(["gate", "sameOrigin", "settings", "limit", "audit", "reset"]);
    expect(requireExecPrincipal).toHaveBeenCalledWith(expect.any(Request), "POST /api/exec/settings/voice-reset", { requireStrongSignIn: true });
    expect(rateLimit).toHaveBeenCalledWith(PRINCIPAL, "settings_update", 30, 600_000);
    expect(resetVoiceProfile).toHaveBeenCalledWith(PRINCIPAL);
    expect(audits).toEqual([
      {
        entry: { actor: "owner", action: "settings.voice_reset", target: "exec_voice_profile:ep_1", input: {} },
        finished: { ok: true, result: { outcome: "deleted" } }
      }
    ]);
  });

  it("no profile to delete: hadProfile false, audit outcome none", async () => {
    vi.mocked(resetVoiceProfile).mockResolvedValue(false);
    const res = await voiceResetRoute.POST(resetReq());
    expect(await bodyOf(res)).toEqual({ reset: true, hadProfile: false });
    expect(audits[0].finished).toEqual({ ok: true, result: { outcome: "none" } });
  });

  it("an empty body is no body", async () => {
    const res = await voiceResetRoute.POST(resetReq(""));
    expect(res.status).toBe(200);
  });

  it("a gate failure stops everything; a cross-site request is 403 with no further call", async () => {
    gateFails(404);
    expect((await voiceResetRoute.POST(resetReq())).status).toBe(404);
    expect(calls).toEqual(["gate"]);
    calls = [];
    vi.mocked(requireExecPrincipal).mockImplementation(async () => {
      calls.push("gate");
      return { ok: true, principal: PRINCIPAL };
    });
    const res = await voiceResetRoute.POST(resetReq(undefined, { "sec-fetch-site": "same-site" }));
    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toEqual({ error: "forbidden" });
    expect(calls).toEqual(["gate", "sameOrigin"]);
  });

  it("a non-empty body is 400 invalid before the settings read", async () => {
    for (const req of [resetReq("{}"), resetReq(" "), resetReq(undefined, { "content-length": "12" })]) {
      calls = [];
      const res = await voiceResetRoute.POST(req);
      expect(res.status).toBe(400);
      expect(await bodyOf(res)).toEqual({ error: "invalid", detail: "body" });
      expect(calls).toEqual(["gate", "sameOrigin"]);
    }
  });

  it("drafts not installed is 409 not_installed before the limit; a failed settings read is 503", async () => {
    vi.mocked(loadSettings).mockImplementation(async () => {
      calls.push("settings");
      return settings({ draftsSchemaReady: false });
    });
    const res = await voiceResetRoute.POST(resetReq());
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual({ error: "not_installed" });
    expect(calls).toEqual(["gate", "sameOrigin", "settings"]);
    vi.mocked(loadSettings).mockRejectedValue(new Error("down"));
    const down = await voiceResetRoute.POST(resetReq());
    expect(down.status).toBe(503);
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("the limit's 429 / 503 come back before the audit", async () => {
    vi.mocked(rateLimit).mockResolvedValueOnce({ ok: false, response: jsonError(429, "rate_limited", { retryAfterSeconds: 9, retryAfterSec: 9 }) });
    expect((await voiceResetRoute.POST(resetReq())).status).toBe(429);
    vi.mocked(rateLimit).mockResolvedValueOnce({ ok: false, response: jsonError(503, "unavailable") });
    expect((await voiceResetRoute.POST(resetReq())).status).toBe(503);
    expect(runAudited).not.toHaveBeenCalled();
    expect(resetVoiceProfile).not.toHaveBeenCalled();
  });

  it("the audit log unavailable is 503 and nothing is deleted", async () => {
    auditDown = true;
    expect((await voiceResetRoute.POST(resetReq())).status).toBe(503);
    expect(resetVoiceProfile).not.toHaveBeenCalled();
  });

  it("the table missing at delete time: 409 not_installed and the audit row ok = false", async () => {
    vi.mocked(resetVoiceProfile).mockResolvedValue(null);
    const res = await voiceResetRoute.POST(resetReq());
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual({ error: "not_installed" });
    expect(audits[0].finished).toEqual({ ok: false, result: { outcome: "not_installed" } });
  });

  it("a delete that throws: 503 and the audit row finished as an exception", async () => {
    vi.mocked(resetVoiceProfile).mockRejectedValue(new Error("exec drafts store: exec_voice_profile delete failed: timeout"));
    const res = await voiceResetRoute.POST(resetReq());
    expect(res.status).toBe(503);
    expect(audits[0].finished).toEqual({ ok: false, error: "exception" });
  });

  it("exports only POST, dynamic on the node runtime", () => {
    expect(Object.keys(voiceResetRoute).sort()).toEqual(["POST", "dynamic", "runtime"]);
  });
});
