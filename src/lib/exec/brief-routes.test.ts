import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/access", () => ({ requireExecPrincipal: vi.fn() }));
// P5a's rate limit and audit at their module boundary, recording what the route hands them (http.test.ts covers them).
vi.mock("@/lib/exec/http", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/http")>()), rateLimit: vi.fn(), runAudited: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/jobs", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/jobs")>()), enqueueJob: vi.fn() }));
// Area C's build (the dry run) and the render-time screen at their module boundary.
vi.mock("@/lib/exec/brief-build", () => ({ runBriefBuild: vi.fn() }));
vi.mock("@/lib/exec/brief-screen", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/brief-screen")>()), screenBriefContent: vi.fn() }));
vi.mock("@/lib/exec/slack-intel-store", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/slack-intel-store")>()), slackIntelState: vi.fn() }));
vi.mock("@/lib/exec/brief-view", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/brief-view")>()), getBriefPageView: vi.fn() }));
vi.mock("@/lib/exec/brief-settings", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/brief-settings")>()), updateBriefSettings: vi.fn() }));

import * as latestRoute from "@/app/api/exec/briefs/latest/route";
import * as regenerateRoute from "@/app/api/exec/briefs/regenerate/route";
import * as settingsRoute from "@/app/api/exec/briefs/settings/route";
import { requireExecPrincipal } from "@/lib/exec/access";
import { runBriefBuild } from "@/lib/exec/brief-build";
import { BRIEF_COPY } from "@/lib/exec/brief-copy";
import { NO_SCREEN, screenBriefContent } from "@/lib/exec/brief-screen";
import { updateBriefSettings } from "@/lib/exec/brief-settings";
import { __resetBriefStoreForTests } from "@/lib/exec/brief-store";
import { getBriefPageView } from "@/lib/exec/brief-view";
import { jsonError, rateLimit, runAudited, type AuditOutcomeSummary } from "@/lib/exec/http";
import { enqueueJob } from "@/lib/exec/jobs";
import { loadSettings, type SettingsSnapshot } from "@/lib/exec/principal";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import type { AuditEntry, EnqueueJobInput } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { BRIEF_TEXT_SENTINELS, assertNoBriefText, captureConsole } from "./__tests__/brief-assert";
import { createFakeBriefDb, type FakeBriefDb } from "./__tests__/fake-brief-db";
import { BRIEF_ID, NOW, TODAY, briefDbRow, briefSettings, content, pageView, principal } from "./__tests__/brief-ui-fixtures";

// P8 contract §5.16 (Area E), the routes: UI10 (latest), UI11 (regenerate, intel-12), UI12 (the dry run), UI13 (the
// settings PATCH, route half), UI23 (no MAC in an answer) and UI24 (no Slack call). The real brief store runs over Area A's
// fake database (the claim's RPC mirror: regen_seq, the lock, busy and conflict); the build, the screen, the settings
// writer, the job queue, the rate limit and the audit are mocked at their module boundaries.

const V1 = "2026-11-09T09:00:00.123456+00:00";
const REGEN = "https://operations.scaledai.org/api/exec/briefs/regenerate";

let db: FakeBriefDb;
let calls: string[];
let audits: { entry: AuditEntry; finished: { ok: boolean; outcome?: string } | null }[];
let jobs: EnqueueJobInput[];
let enqueueAnswer: "insert" | "duplicate" | "throw";
let out: ReturnType<typeof captureConsole>;
let fetchSpy: ReturnType<typeof vi.fn>;

function request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const h: Record<string, string> = { "sec-fetch-site": "same-origin", ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  return new Request(url, { method, headers: h, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
}
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  out = captureConsole();
  calls = [];
  audits = [];
  jobs = [];
  enqueueAnswer = "insert";
  __resetBriefStoreForTests();
  db = createFakeBriefDb({ tables: { exec_briefs: [briefDbRow()] }, now: () => new Date() });
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  fetchSpy = vi.fn(async () => new Response("{}", { status: 500 }));
  vi.stubGlobal("fetch", fetchSpy);
  vi.mocked(requireExecPrincipal).mockReset().mockImplementation(async () => {
    calls.push("gate");
    return { ok: true, principal };
  });
  vi.mocked(loadSettings).mockReset().mockImplementation(async () => {
    calls.push("settings");
    return briefSettings({ supersedeLegacyBrief: true });
  });
  vi.mocked(rateLimit).mockReset().mockImplementation(async (_p, bucket) => {
    calls.push(`limit:${bucket}`);
    return { ok: true };
  });
  vi.mocked(runAudited).mockReset().mockImplementation(async (_p, entry, fn, outcomeOf) => {
    calls.push(`audit:${entry.action}`);
    const record: (typeof audits)[number] = { entry, finished: null };
    audits.push(record);
    try {
      const value = await fn();
      const s = (outcomeOf as (v: unknown) => AuditOutcomeSummary)(value);
      record.finished = { ok: s.ok, outcome: s.outcome };
      return { ok: true, value } as never;
    } catch {
      record.finished = { ok: false };
      return { ok: false, response: jsonError(503, "unavailable") };
    }
  });
  vi.mocked(enqueueJob).mockReset().mockImplementation(async (input) => {
    calls.push("enqueue");
    if (enqueueAnswer === "throw") throw new Error("exec_jobs enqueue failed");
    const seen = jobs.some((j) => j.dedupeKey === input.dedupeKey);
    jobs.push(input);
    return seen || enqueueAnswer === "duplicate" ? { enqueued: false, id: null } : { enqueued: true, id: jobs.length };
  });
  vi.mocked(screenBriefContent).mockReset().mockResolvedValue({ ok: true, screen: NO_SCREEN });
  vi.mocked(slackIntelState).mockReset().mockResolvedValue("ok");
});

afterEach(() => {
  // §0.3 rule 4: no brief text, check-in text or token in a log, an audit input or a job payload.
  assertNoBriefText([out.calls(), audits.map((a) => a.entry), jobs], { label: "route side effects" });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const cacheOf = (res: Response) => res.headers.get("cache-control");

describe("UI10: GET /api/exec/briefs/latest", () => {
  it("the strong gate, then 200 with the page view, private no-store", async () => {
    vi.mocked(getBriefPageView).mockResolvedValue(pageView());
    const res = await latestRoute.GET(request("GET", "https://operations.scaledai.org/api/exec/briefs/latest"));
    expect(requireExecPrincipal).toHaveBeenCalledWith(expect.any(Request), "GET /api/exec/briefs/latest", { requireStrongSignIn: true });
    expect(res.status).toBe(200);
    expect(cacheOf(res)).toBe("private, no-store");
    const body = await json(res);
    expect(body.state).toBe("ready");
    expect(vi.mocked(getBriefPageView).mock.calls[0][0]).toBe(principal);
  });

  it("a session from a one-time sign-in link gets the gate's 404 (private no-store) and nothing is read", async () => {
    vi.mocked(requireExecPrincipal).mockResolvedValue({ ok: false, response: jsonError(404, "not_found") } as never);
    const res = await latestRoute.GET(request("GET", "https://operations.scaledai.org/api/exec/briefs/latest"));
    expect(res.status).toBe(404);
    expect(cacheOf(res)).toBe("private, no-store");
    expect(getBriefPageView).not.toHaveBeenCalled();
  });

  it("a read failure → 503 unavailable, logged by route and error name only", async () => {
    vi.mocked(getBriefPageView).mockRejectedValue(new Error(`boom ${BRIEF_TEXT_SENTINELS.briefLine}`));
    const res = await latestRoute.GET(request("GET", "https://operations.scaledai.org/api/exec/briefs/latest"));
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ error: "unavailable" });
    expect(cacheOf(res)).toBe("private, no-store");
  });
});

describe("UI11: POST /api/exec/briefs/regenerate", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) => regenerateRoute.POST(request("POST", REGEN, body, headers));

  it("claimed → one exec.brief job keyed exec.brief:<p>:<d>:g<rev>.<regen_seq>, 202 { queued, rev }; the order of the gates", async () => {
    const res = await post({ expectedRev: 1 });
    expect(res.status).toBe(202);
    expect(await json(res)).toEqual({ status: "queued", rev: 1 });
    expect(cacheOf(res)).toBe("private, no-store");
    expect(calls).toEqual(["gate", "settings", "limit:brief_regenerate", "audit:brief.regenerate", "enqueue"]);
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["brief_regenerate", 6, 3_600_000]);
    expect(jobs).toEqual([
      {
        kind: "exec.brief", lane: "interactive", principalId: principal.id, maxAttempts: 1,
        dedupeKey: `exec.brief:${principal.id}:${TODAY}:g1.1`,
        payload: { local_date: TODAY, scheduled_at: "2026-11-09T13:00:00.000Z", trigger: "regenerate", brief_id: BRIEF_ID, expected_rev: 1 }
      }
    ]);
    expect(audits[0].entry).toEqual({ actor: "owner", action: "brief.regenerate", target: `exec_briefs:${TODAY}`, input: { expectedRev: 1 } });
    expect(audits[0].finished).toEqual({ ok: true, outcome: "queued" });
    // The claim holds the lock while the job runs (the RPC mirror's own row).
    expect(db.tables.exec_briefs[0].regen_lock_until).not.toBeNull();
    expect(db.tables.exec_briefs[0].regen_seq).toBe(1);
  });

  it("same-origin 403; a bad body 400 with no audit row; not installed 409; brief off 409", async () => {
    expect((await post({ expectedRev: 1 }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    for (const bad of [{}, { expectedRev: 0 }, { expectedRev: "1" }, { expectedRev: 1, extra: true }, "nope"]) {
      const res = await post(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(cacheOf(res)).toBe("private, no-store");
    }
    expect(audits).toEqual([]);
    db.missing.add("exec_briefs");
    __resetBriefStoreForTests();
    const missing = await post({ expectedRev: 1 });
    expect([missing.status, (await json(missing)).error]).toEqual([409, "not_installed"]);
    db.missing.delete("exec_briefs");
    __resetBriefStoreForTests();
    vi.mocked(loadSettings).mockResolvedValue(briefSettings({ briefEnabled: false }));
    const off = await post({ expectedRev: 1 });
    expect([off.status, (await json(off)).error]).toEqual([409, "brief_off"]);
    expect(audits).toEqual([]);
    expect(jobs).toEqual([]);
  });

  it("the rate limit (brief_regenerate, 6 an hour) answers 429 before any audit or claim", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ ok: false, response: jsonError(429, "rate_limited", { retryAfterSeconds: 120 }) });
    const res = await post({ expectedRev: 1 });
    expect(res.status).toBe(429);
    expect(cacheOf(res)).toBe("private, no-store");
    expect(audits).toEqual([]);
    expect(db.tables.exec_briefs[0].regen_seq).toBe(0);
  });

  it("claim busy → 409 busy; conflict → 409 with the current rev; no row → 404; no job in any of them", async () => {
    db.tables.exec_briefs[0].regen_lock_until = new Date(NOW.getTime() + 120_000).toISOString();
    const busy = await post({ expectedRev: 1 });
    expect([busy.status, await json(busy)]).toEqual([409, { error: "busy" }]);
    db.tables.exec_briefs[0].regen_lock_until = null;
    const conflict = await post({ expectedRev: 2 });
    expect([conflict.status, await json(conflict)]).toEqual([409, { error: "conflict", rev: 1 }]);
    db.tables.exec_briefs = [];
    const gone = await post({ expectedRev: 1 });
    expect([gone.status, await json(gone)]).toEqual([404, { error: "not_found" }]);
    expect(jobs).toEqual([]);
    expect(audits.map((a) => a.finished?.outcome)).toEqual(["busy", "conflict", "not_found"]);
  });

  it("intel-12: a regenerate whose job failed before bumping rev, then a second one at the same rev → a NEW key, inserted, 202", async () => {
    expect((await post({ expectedRev: 1 })).status).toBe(202);
    // The first job failed pre-model: the handler released the lock; rev is still 1.
    db.tables.exec_briefs[0].regen_lock_until = null;
    const again = await post({ expectedRev: 1 });
    expect(again.status).toBe(202);
    expect(jobs.map((j) => j.dedupeKey)).toEqual([`exec.brief:${principal.id}:${TODAY}:g1.1`, `exec.brief:${principal.id}:${TODAY}:g1.2`]);
  });

  it("intel-12: an enqueue that answers enqueued:false releases the lock and answers 409 busy, never 202; a throw releases it and 503", async () => {
    enqueueAnswer = "duplicate";
    const dup = await post({ expectedRev: 1 });
    expect([dup.status, await json(dup)]).toEqual([409, { error: "busy" }]);
    expect(db.tables.exec_briefs[0].regen_lock_until).toBeNull();
    enqueueAnswer = "throw";
    const thrown = await post({ expectedRev: 1 });
    expect(thrown.status).toBe(503);
    expect(db.tables.exec_briefs[0].regen_lock_until).toBeNull();
    expect(audits.map((a) => a.finished)).toEqual([{ ok: false, outcome: "busy" }, { ok: false }]);
  });

  it("UI24: the regenerate posts nothing to Slack (no network call at all)", async () => {
    expect((await post({ expectedRev: 1 })).status).toBe(202);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("UI12: POST …/regenerate?dryRun=1", () => {
  const dry = (body: unknown = {}) => regenerateRoute.POST(request("POST", `${REGEN}?dryRun=1`, body));

  it("bucket brief_dry_run (3 an hour), audit brief.dry_run, a build with dryRun and no claim, nothing persisted, the content screened", async () => {
    vi.mocked(runBriefBuild).mockResolvedValue({ outcome: "dry_run", content: content(), mode: "ai", modeReason: null });
    vi.mocked(screenBriefContent).mockResolvedValue({
      ok: true,
      screen: { ...NO_SCREEN, items: new Map([["b1", "restricted"]]), top3: new Set(["i1"]), withheldThreadIds: ["t_mail"], hideHeadline: true }
    });
    const res = await dry({});
    expect(res.status).toBe(200);
    expect(cacheOf(res)).toBe("private, no-store");
    const body = await json(res);
    expect(body.dryRun).toBe(true);
    expect(body.mode).toBe("ai");
    const c = body.content as { headline: string | null; sections: { key: string; lines: { text: string; withheld: string | null }[] }[] };
    expect(c.headline).toBeNull();
    expect(c.sections.find((s) => s.key === "emails")?.lines[0]).toMatchObject({ text: BRIEF_COPY.removedRestricted, withheld: "restricted" });
    expect(JSON.stringify(body)).not.toContain(BRIEF_TEXT_SENTINELS.emailSubject);
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["brief_dry_run", 3, 3_600_000]);
    expect(audits[0].entry).toEqual({ actor: "owner", action: "brief.dry_run", target: `exec_briefs:${TODAY}`, input: { expectedRev: null } });
    const req = vi.mocked(runBriefBuild).mock.calls[0][0];
    expect([req.dryRun, req.trigger, req.claimed, req.localDate, req.principal]).toEqual([true, "regenerate", null, TODAY, principal]);
    expect(req.signal).toBeInstanceOf(AbortSignal);
    expect(db.mutations()).toBe(0);
    expect(jobs).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skipped → 409 with its reason; failed → 409 failed with stage and code; an expectedRev is allowed, an unknown key isn't", async () => {
    vi.mocked(runBriefBuild).mockResolvedValue({ outcome: "skipped", reason: "legacy_owns" });
    const skipped = await dry({ expectedRev: 1 });
    expect([skipped.status, await json(skipped)]).toEqual([409, { error: "legacy_owns" }]);
    vi.mocked(runBriefBuild).mockResolvedValue({ outcome: "failed", stage: "pre_model", code: "gather" });
    const failed = await dry();
    expect([failed.status, await json(failed)]).toEqual([409, { error: "failed", stage: "pre_model", code: "gather" }]);
    expect((await dry({ nope: 1 })).status).toBe(400);
    expect(audits.map((a) => a.entry.input)).toEqual([{ expectedRev: 1 }, { expectedRev: null }]);
  });
});

describe("UI13 (route half): PATCH /api/exec/briefs/settings", () => {
  const SNAP: SettingsSnapshot = { settings: briefSettings({ supersedeLegacyBrief: true }), version: "2026-11-09T14:00:00.000Z" };
  const patch = (body: unknown, headers: Record<string, string> = {}) =>
    settingsRoute.PATCH(request("PATCH", "https://operations.scaledai.org/api/exec/briefs/settings", body, headers));

  beforeEach(() => {
    vi.mocked(updateBriefSettings).mockReset().mockImplementation(async () => {
      calls.push("update");
      return { outcome: "updated", snapshot: SNAP, sameDayDelivery: true };
    });
  });

  it("validation: time steps, the zone list, booleans, an empty or unknown patch → 400 { invalid, field }, with no audit row", async () => {
    const cases: [unknown, string][] = [
      [{ patch: { briefLocalTime: "08:10" }, expectedVersion: V1 }, "briefLocalTime"],
      [{ patch: { briefLocalTime: "24:00" }, expectedVersion: V1 }, "briefLocalTime"],
      [{ patch: { briefTimezone: "Mars/Olympus" }, expectedVersion: V1 }, "briefTimezone"],
      [{ patch: { briefTimezone: "Europe/Berlin" }, expectedVersion: V1 }, "briefTimezone"],
      [{ patch: { briefEnabled: "yes" }, expectedVersion: V1 }, "patch.briefEnabled"],
      [{ patch: {}, expectedVersion: V1 }, "patch"],
      [{ patch: { retentionDaysChat: 30 }, expectedVersion: V1 }, "patch.retentionDaysChat"],
      [{ patch: { briefEnabled: true }, expectedVersion: "yesterday" }, "expectedVersion"],
      [{ patch: { briefEnabled: true }, expectedVersion: V1, confirm: "yes" }, "confirm"]
    ];
    for (const [body, field] of cases) {
      const res = await patch(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await json(res), JSON.stringify(body)).toEqual({ error: "invalid", field });
      expect(cacheOf(res)).toBe("private, no-store");
    }
    expect(audits).toEqual([]);
    expect(updateBriefSettings).not.toHaveBeenCalled();
  });

  it("updated → 200 { settings, sameDayDelivery }; the audit row brief.settings.update with the changes and the confirm", async () => {
    const res = await patch({ patch: { supersedeLegacyBrief: true, briefLocalTime: "07:45" }, expectedVersion: V1, confirm: "supersede_legacy_brief" });
    expect(res.status).toBe(200);
    expect(cacheOf(res)).toBe("private, no-store");
    expect(await json(res)).toEqual({
      settings: { enabled: true, time: "08:00", timezone: null, effectiveTz: "America/New_York", workTz: "America/New_York", checkinsEnabled: true, supersede: true, version: SNAP.version },
      sameDayDelivery: true
    });
    expect(calls).toEqual(["gate", "limit:brief_settings", "audit:brief.settings.update", "update"]);
    expect(vi.mocked(rateLimit).mock.calls[0].slice(1)).toEqual(["brief_settings", 30, 600_000]);
    expect(audits[0].entry).toEqual({
      actor: "owner", action: "brief.settings.update", target: `exec_settings:${principal.id}`,
      input: { changes: { briefLocalTime: "07:45", supersedeLegacyBrief: true }, confirm: "supersede_legacy_brief" }
    });
    expect(vi.mocked(updateBriefSettings).mock.calls[0]).toEqual([principal, { briefLocalTime: "07:45", supersedeLegacyBrief: true }, { expectedVersion: V1, confirm: "supersede_legacy_brief" }]);
  });

  it("CAS conflict → 409 with the current settings; supersede without confirm → 400 confirmation_required; same-origin 403", async () => {
    vi.mocked(updateBriefSettings).mockResolvedValueOnce({ outcome: "conflict", snapshot: SNAP });
    const conflict = await patch({ patch: { briefEnabled: false }, expectedVersion: V1 });
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).error).toBe("conflict");
    vi.mocked(updateBriefSettings).mockResolvedValueOnce({ outcome: "confirmation_required" });
    const confirm = await patch({ patch: { supersedeLegacyBrief: true }, expectedVersion: V1 });
    expect([confirm.status, await json(confirm)]).toEqual([400, { error: "confirmation_required" }]);
    expect(audits.map((a) => a.entry.input)).toEqual([{ changes: { briefEnabled: false }, confirm: null }, { changes: { supersedeLegacyBrief: true }, confirm: null }]);
    expect((await patch({ patch: { briefEnabled: true }, expectedVersion: V1 }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  it("a write failure → 503 (the audit records the exception); the gate's refusal is passed through private", async () => {
    vi.mocked(updateBriefSettings).mockRejectedValueOnce(new Error("exec_settings update failed"));
    expect((await patch({ patch: { briefEnabled: true }, expectedVersion: V1 })).status).toBe(503);
    vi.mocked(requireExecPrincipal).mockResolvedValueOnce({ ok: false, response: jsonError(404, "not_found") } as never);
    const refused = await patch({ patch: { briefEnabled: true }, expectedVersion: V1 });
    expect([refused.status, cacheOf(refused)]).toEqual([404, "private, no-store"]);
  });
});

describe("UI23: no answer carries a check-in MAC or button value", () => {
  it("latest's body (with check-ins) has none", async () => {
    vi.mocked(getBriefPageView).mockResolvedValue(pageView({ checkins: [{ id: "ebc_1", firstName: "Dana", text: "x", status: "proposed", statusLine: "", sentAt: null }] }));
    const body = await (await latestRoute.GET(request("GET", "https://operations.scaledai.org/api/exec/briefs/latest"))).text();
    expect(body).not.toMatch(/"value"|c1\.ebc_/);
  });
});
