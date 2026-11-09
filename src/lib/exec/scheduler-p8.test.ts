import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P8 contract §5.4 (SC06-SC16) and §5.15 OP02: the brief's zone, payload context and watchdog companion; the system
// registry (principal_id null) and its pass; the existing P2a behaviour unchanged. enqueueJob is mocked with the database's
// dedupe (exec_jobs.dedupe_key unique, ON CONFLICT DO NOTHING): the first row for a key stands.

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/jobs")>();
  return { ...actual, enqueueJob: vi.fn(), reapExpiredLeases: vi.fn() };
});
vi.mock("@/lib/exec/principal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/principal")>();
  return { ...actual, listEnabledPrincipals: vi.fn(), loadSettings: vi.fn() };
});

import { briefScheduledWork } from "@/lib/exec/handlers/brief";
import { briefHealthScheduledWork } from "@/lib/exec/handlers/brief-health";
import { briefPrepScheduledWork, briefPrepTime } from "@/lib/exec/handlers/brief-prep";
import { briefSweepScheduledWork } from "@/lib/exec/handlers/brief-sweep";
import { opsWatchSystemWork } from "@/lib/exec/handlers/ops-watch";
import { purgeSystemWork } from "@/lib/exec/handlers/purge";
import { enqueueJob, reapExpiredLeases } from "@/lib/exec/jobs";
import { listEnabledPrincipals, loadSettings, principalFromRows, settingsFromRow } from "@/lib/exec/principal";
import {
  __resetSchedulerForTests,
  __resetSystemSchedulerForTests,
  dueDedupeKey,
  dueSystemDedupeKey,
  getSystemScheduledWork,
  listScheduledWork,
  listSystemScheduledWork,
  registerScheduledWork,
  registerSystemScheduledWork,
  runSchedulerTick,
  type ScheduleContext,
  type ScheduledWork,
  type SystemScheduledWork
} from "@/lib/exec/scheduler";
import { intervalBucket } from "@/lib/exec/time";
import type { EnqueueJobInput, ExecPrincipal, ExecSettings } from "@/lib/exec/types";

const NY = "America/New_York";
const at = (iso: string) => new Date(iso);

function principal(id: string, tz: string): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: `u_${id}`, enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: `u_${id}`, email: `${id}@scaledai.org`, name: id, work_timezone: tz },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}
const p1 = principal("ep_1", NY);
/** A principal whose brief zone differs from its P2a timezone (they're equal today by construction; SC06 proves which one the brief reads). */
const split: ExecPrincipal = Object.freeze({ ...principal("ep_2", "Asia/Karachi"), briefTimezone: NY });

const settings = (principalId: string, o: Partial<ExecSettings> = {}): ExecSettings => ({ ...settingsFromRow(null, principalId), ...o });
const briefOn = (id: string, o: Partial<ExecSettings> = {}) => settings(id, { briefEnabled: true, ...o });

/** The rows exec_jobs holds, by dedupe key: the first enqueue of a key wins (ON CONFLICT DO NOTHING). */
let stored: Map<string, EnqueueJobInput>;
const enqueues = () => vi.mocked(enqueueJob).mock.calls.map(([input]) => input);
const byKind = (kind: string) => enqueues().filter((e) => e.kind === kind);

beforeEach(() => {
  __resetSchedulerForTests();
  stored = new Map();
  vi.stubEnv("EXEC_ENABLED", "true");
  vi.mocked(reapExpiredLeases).mockResolvedValue(0);
  vi.mocked(listEnabledPrincipals).mockResolvedValue([]);
  vi.mocked(loadSettings).mockImplementation(async (id: string) => settings(id));
  vi.mocked(enqueueJob).mockImplementation(async (input) => {
    const key = input.dedupeKey ?? `${input.kind}:${stored.size}`;
    if (stored.has(key)) return { enqueued: false, id: null };
    stored.set(key, input);
    return { enqueued: true, id: stored.size };
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetSchedulerForTests();
});

// ---------------------------------------------------------------------------------------------------------------------

describe("the morning brief's schedule (M3, C3)", () => {
  beforeEach(() => registerScheduledWork(briefScheduledWork));

  it("SC06 exec.brief is due at 08:00 in the brief zone, keyed exec.brief:<p>:<date>; the zone is the brief zone, not timezone", async () => {
    const s = briefOn("ep_2");
    expect(split.timezone).toBe("Asia/Karachi");
    // 07:59 / 08:00 in New York (12:59Z / 13:00Z); in Karachi (UTC+5) it is long past 08:00 either way.
    expect(dueDedupeKey(briefScheduledWork, split, s, at("2026-11-06T12:59:00Z"))).toBeNull();
    expect(dueDedupeKey(briefScheduledWork, split, s, at("2026-11-06T13:00:00Z"))).toBe("exec.brief:ep_2:2026-11-06");
    expect(dueDedupeKey(briefScheduledWork, p1, briefOn("ep_1"), at("2026-11-06T13:00:00Z"))).toBe("exec.brief:ep_1:2026-11-06");
    // Off → never enqueued.
    vi.mocked(listEnabledPrincipals).mockResolvedValue([p1]);
    await runSchedulerTick(at("2026-11-06T13:00:00Z"));
    expect(byKind("exec.brief")).toEqual([]);
    vi.mocked(loadSettings).mockImplementation(async (id: string) => briefOn(id));
    vi.mocked(listEnabledPrincipals).mockResolvedValue([split]);
    await runSchedulerTick(at("2026-11-06T13:00:00Z"));
    expect(byKind("exec.brief").map((e) => [e.dedupeKey, e.lane, e.principalId, e.maxAttempts])).toEqual([["exec.brief:ep_2:2026-11-06", "interactive", "ep_2", 1]]);
  });

  it("SC07 the payload carries local_date and scheduled_at = dueAt; a 10:12 catch-up tick still carries 08:00's", async () => {
    vi.mocked(loadSettings).mockImplementation(async (id: string) => briefOn(id));
    vi.mocked(listEnabledPrincipals).mockResolvedValue([p1]);
    await runSchedulerTick(at("2026-11-06T15:12:00Z"));   // 10:12 EST
    expect(byKind("exec.brief")[0].payload).toEqual({ local_date: "2026-11-06", scheduled_at: "2026-11-06T13:00:00.000Z", trigger: "schedule" });
    // In the brief zone, across the date line: a 23:30 brief time.
    vi.mocked(enqueueJob).mockClear();
    stored.clear();
    vi.mocked(loadSettings).mockImplementation(async (id: string) => briefOn(id, { briefLocalTime: "23:30" }));
    await runSchedulerTick(at("2026-11-07T04:31:00Z"));   // 23:31 EST on 11-06
    expect(byKind("exec.brief")[0].payload).toEqual({ local_date: "2026-11-06", scheduled_at: "2026-11-07T04:30:00.000Z", trigger: "schedule" });
  });

  it("SC08 the watchdog companion is enqueued in the same tick, keyed exec.brief-fallback:<p>:<date>, runAfter max(dueAt, now) + 45 min", async () => {
    vi.mocked(loadSettings).mockImplementation(async (id: string) => briefOn(id));
    vi.mocked(listEnabledPrincipals).mockResolvedValue([p1]);
    const r = await runSchedulerTick(at("2026-11-06T13:00:30Z"));
    const fallback = byKind("exec.brief-fallback");
    expect(fallback).toEqual([{
      kind: "exec.brief-fallback",
      lane: "interactive",
      principalId: "ep_1",
      payload: { local_date: "2026-11-06", scheduled_at: "2026-11-06T13:00:00.000Z" },
      dedupeKey: "exec.brief-fallback:ep_1:2026-11-06",
      runAfter: at("2026-11-06T13:45:30Z"),
      maxAttempts: 1
    }]);
    // The build first, then its companion, in the one tick.
    const kinds = enqueues().map((e) => e.kind);
    expect(kinds.indexOf("exec.brief")).toBeLessThan(kinds.indexOf("exec.brief-fallback"));
    expect(r.enqueued).toBe(2);   // the build and its watchdog (the companion counts as an enqueued job)
    expect(r.summary).toBe("principals=1 enqueued=2 reaped=0");
    // A second tick: both are duplicates and the first runAfter stands.
    const again = await runSchedulerTick(at("2026-11-06T15:12:00Z"));
    expect(byKind("exec.brief")).toHaveLength(2);
    expect(byKind("exec.brief-fallback")).toHaveLength(2);
    expect(byKind("exec.brief-fallback")[1].runAfter).toEqual(at("2026-11-06T15:57:00Z"));
    expect(stored.get("exec.brief-fallback:ep_1:2026-11-06")?.runAfter).toEqual(at("2026-11-06T13:45:30Z"));
    expect(again.enqueued).toBe(0);
    expect(again.summary).toBe("idle");
  });

  it("SC09 a 23:30 brief: the watchdog runs 00:15 the next day and its key keeps the brief's date", async () => {
    vi.mocked(loadSettings).mockImplementation(async (id: string) => briefOn(id, { briefLocalTime: "23:30" }));
    vi.mocked(listEnabledPrincipals).mockResolvedValue([p1]);
    await runSchedulerTick(at("2026-11-07T04:30:00Z"));   // 23:30 EST on 11-06
    const [w] = byKind("exec.brief-fallback");
    expect(w.dedupeKey).toBe("exec.brief-fallback:ep_1:2026-11-06");
    expect(w.runAfter).toEqual(at("2026-11-07T05:15:00Z"));   // 00:15 EST on 11-07
    expect(w.payload).toEqual({ local_date: "2026-11-06", scheduled_at: "2026-11-07T04:30:00.000Z" });
  });

  it("a companion's failure is counted and logged; the work itself was enqueued", async () => {
    vi.mocked(loadSettings).mockImplementation(async (id: string) => briefOn(id));
    vi.mocked(listEnabledPrincipals).mockResolvedValue([p1]);
    vi.mocked(enqueueJob).mockImplementation(async (input) => {
      if (input.kind === "exec.brief-fallback") throw new Error("exec_jobs enqueue failed (exec.brief-fallback): timeout");
      return { enqueued: true, id: 1 };
    });
    const r = await runSchedulerTick(at("2026-11-06T13:00:00Z"));
    expect(r.summary).toBe("principals=1 enqueued=1 reaped=0 errors=1");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("exec.brief-fallback (companion of exec.brief) for principal ep_1 failed"));
  });

  it("no companion when the work's own enqueue throws (the next tick retries both)", async () => {
    vi.mocked(loadSettings).mockImplementation(async (id: string) => briefOn(id));
    vi.mocked(listEnabledPrincipals).mockResolvedValue([p1]);
    vi.mocked(enqueueJob).mockRejectedValue(new Error("exec_jobs enqueue failed: timeout"));
    const r = await runSchedulerTick(at("2026-11-06T13:00:00Z"));
    expect(enqueues().map((e) => e.kind)).toEqual(["exec.brief"]);
    expect(r.summary).toBe("principals=1 enqueued=0 reaped=0 errors=1");
  });
});

describe("registerScheduledWork: companions (SC10)", () => {
  const companion = () => [{ kind: "test.companion", lane: "bulk" as const, runAfter: new Date(), payload: {}, maxAttempts: 1 }];

  it("SC10 a companion on an interval cadence throws at registration", () => {
    expect(() => registerScheduledWork({ kind: "test.interval", lane: "bulk", cadence: { kind: "interval", minutes: 5 }, companions: companion })).toThrow(
      "only a daily or weekly cadence may declare companions"
    );
    expect(listScheduledWork()).toEqual([]);
    registerScheduledWork({ kind: "test.daily", lane: "bulk", cadence: { kind: "daily", at: () => "08:00" }, companions: companion });
    registerScheduledWork({ kind: "test.weekly", lane: "bulk", cadence: { kind: "weekly", isoWeekday: 1, at: "08:00" }, companions: companion });
    expect(listScheduledWork().map((w) => w.kind)).toEqual(["test.daily", "test.weekly"]);
  });

  it("refuses a companions or zone that isn't a function", () => {
    expect(() => registerScheduledWork({ kind: "test.x", lane: "bulk", cadence: { kind: "daily", at: () => "08:00" }, companions: [] as never })).toThrow("companions must be a function");
    expect(() => registerScheduledWork({ kind: "test.y", lane: "bulk", cadence: { kind: "daily", at: () => "08:00" }, zone: "UTC" as never })).toThrow("zone must be a function");
  });

  it("a weekly work's companions get its ISO-week key's local date; an interval work's payload gets localDate and dueAt null", async () => {
    const seen: ScheduleContext[] = [];
    registerScheduledWork({ kind: "test.interval", lane: "bulk", cadence: { kind: "interval", minutes: 5 }, payload: (_p, ctx) => (seen.push(ctx), {}) });
    registerScheduledWork({
      kind: "test.weekly", lane: "bulk", cadence: { kind: "weekly", isoWeekday: 5, at: "08:00" },
      payload: (_p, ctx) => (seen.push(ctx), {}), companions: (_p, ctx) => [{ kind: "test.after", lane: "bulk", runAfter: ctx.now, payload: { d: ctx.localDate }, maxAttempts: 1 }]
    });
    vi.mocked(listEnabledPrincipals).mockResolvedValue([p1]);
    await runSchedulerTick(at("2026-11-06T14:00:00Z"));   // Friday 09:00 EST
    expect(seen.map((c) => [c.localDate, c.dueAt, c.zone])).toEqual([[null, null, NY], ["2026-11-06", null, NY]]);
    expect(seen[0].dueKey).toBe(`test.interval:ep_1:i${intervalBucket(at("2026-11-06T14:00:00Z"), 5)}`);
    expect(byKind("test.after")[0]).toMatchObject({ dedupeKey: "test.after:ep_1:2026-11-06", payload: { d: "2026-11-06" } });
  });
});

describe("the system registry and its pass (M10, C17, C18)", () => {
  beforeEach(() => {
    registerSystemScheduledWork(purgeSystemWork);
    registerSystemScheduledWork(opsWatchSystemWork);
  });

  it("SC11 exec.purge is enqueued with principal_id null, keyed exec.purge:system:<UTC date>, once 03:30 UTC passed, with no enabled principal", async () => {
    expect(dueSystemDedupeKey(purgeSystemWork, at("2026-11-06T03:29:59Z"))).toBeNull();
    expect(dueSystemDedupeKey(purgeSystemWork, at("2026-11-06T03:30:00Z"))).toBe("exec.purge:system:2026-11-06");
    expect(dueSystemDedupeKey(purgeSystemWork, at("2026-11-06T23:59:00Z"))).toBe("exec.purge:system:2026-11-06");
    await runSchedulerTick(at("2026-11-06T03:29:00Z"));
    expect(byKind("exec.purge")).toEqual([]);
    const r = await runSchedulerTick(at("2026-11-06T03:30:00Z"));
    expect(byKind("exec.purge")).toEqual([{ kind: "exec.purge", lane: "bulk", principalId: null, payload: {}, dedupeKey: "exec.purge:system:2026-11-06", maxAttempts: 3 }]);
    expect(r.principals).toBe(0);
    expect(r.system).toBe(2);   // the purge and this bucket's ops-watch
    expect(r.summary).toBe("principals=0 enqueued=0 reaped=0 system=2");
    // The same UTC day again: the key dedupes; the next UTC day is a new key.
    await runSchedulerTick(at("2026-11-06T20:00:00Z"));
    expect(stored.has("exec.purge:system:2026-11-07")).toBe(false);
    await runSchedulerTick(at("2026-11-07T03:31:00Z"));
    expect(stored.has("exec.purge:system:2026-11-07")).toBe(true);
    expect([...stored.keys()].filter((k) => k.startsWith("exec.purge:"))).toEqual(["exec.purge:system:2026-11-06", "exec.purge:system:2026-11-07"]);
  });

  it("SC11 listEnabledPrincipals throwing still leaves the system work enqueued (the tick throws after)", async () => {
    vi.mocked(listEnabledPrincipals).mockRejectedValue(new Error("exec_principals read failed: timeout"));
    await expect(runSchedulerTick(at("2026-11-06T04:00:00Z"))).rejects.toThrow("exec_principals read failed");
    expect(byKind("exec.purge").map((e) => e.dedupeKey)).toEqual(["exec.purge:system:2026-11-06"]);
    expect(byKind("exec.ops-watch")).toHaveLength(1);
  });

  it("SC12 exec.ops-watch is keyed exec.ops-watch:system:i<bucket>; payload.bucket is that bucket", async () => {
    const now = at("2026-11-06T13:07:00Z");
    const bucket = intervalBucket(now, 15);
    expect(dueSystemDedupeKey(opsWatchSystemWork, now)).toBe(`exec.ops-watch:system:i${bucket}`);
    await runSchedulerTick(now);
    expect(byKind("exec.ops-watch")).toEqual([{ kind: "exec.ops-watch", lane: "bulk", principalId: null, payload: { bucket }, dedupeKey: `exec.ops-watch:system:i${bucket}`, maxAttempts: 1 }]);
  });

  it("OP02 the same bucket twice → one job (the system key dedupes)", async () => {
    await runSchedulerTick(at("2026-11-06T13:00:00Z"));
    const second = await runSchedulerTick(at("2026-11-06T13:14:59Z"));
    expect(byKind("exec.ops-watch").map((e) => e.dedupeKey)).toEqual([
      `exec.ops-watch:system:i${intervalBucket(at("2026-11-06T13:00:00Z"), 15)}`,
      `exec.ops-watch:system:i${intervalBucket(at("2026-11-06T13:00:00Z"), 15)}`
    ]);
    expect([...stored.keys()].filter((k) => k.startsWith("exec.ops-watch:"))).toHaveLength(1);
    expect(second.system).toBeUndefined();
    expect(second.summary).toBe("idle");
    await runSchedulerTick(at("2026-11-06T13:15:00Z"));
    expect([...stored.keys()].filter((k) => k.startsWith("exec.ops-watch:"))).toHaveLength(2);
  });

  it("SC13 a kind in both registries: the second registration throws, either way round", () => {
    const sameKindDaily: ScheduledWork = { kind: "exec.purge", lane: "bulk", cadence: { kind: "daily", at: () => "03:30" } };
    expect(() => registerScheduledWork(sameKindDaily)).toThrow('kind "exec.purge" is registered as system work');
    __resetSystemSchedulerForTests();
    registerScheduledWork(sameKindDaily);
    expect(() => registerSystemScheduledWork(purgeSystemWork)).toThrow('kind "exec.purge" is registered as per-principal work');
    expect(() => registerSystemScheduledWork(opsWatchSystemWork)).not.toThrow();
    expect(() => registerSystemScheduledWork(opsWatchSystemWork)).toThrow('system work already registered for kind "exec.ops-watch"');
  });

  it("registration validates kind, lane and cadence; the registry lives on globalThis", () => {
    __resetSystemSchedulerForTests();
    const bad = (w: Partial<SystemScheduledWork>) => () => registerSystemScheduledWork({ kind: "test.sys", lane: "bulk", cadence: { kind: "interval", minutes: 5 }, ...w } as SystemScheduledWork);
    expect(bad({ kind: "has space" })).toThrow("invalid job kind");
    expect(bad({ lane: "fast" as never })).toThrow("unknown lane");
    expect(bad({ cadence: { kind: "interval", minutes: 0 } })).toThrow("positive integer");
    expect(bad({ cadence: { kind: "daily", atUtc: "3:30" } })).toThrow('"HH:MM"');
    expect(bad({ cadence: { kind: "weekly" } as never })).toThrow("unknown cadence");
    expect(bad({ payload: {} as never })).toThrow("payload must be a function");
    registerSystemScheduledWork({ kind: "test.sys", lane: "bulk", cadence: { kind: "interval", minutes: 5 } });
    expect(getSystemScheduledWork("test.sys")?.kind).toBe("test.sys");
    expect(listSystemScheduledWork().map((w) => w.kind)).toEqual(["test.sys"]);
    expect(Reflect.get(globalThis, "__ddExecSystemScheduledWork")).toBeInstanceOf(Map);
  });

  it("SC14 EXEC_ENABLED off → no system enqueue, nothing at all", async () => {
    vi.stubEnv("EXEC_ENABLED", "false");
    await expect(runSchedulerTick(at("2026-11-06T04:00:00Z"))).resolves.toEqual({ principals: 0, enqueued: 0, reaped: 0, summary: "disabled" });
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(reapExpiredLeases).not.toHaveBeenCalled();
  });

  it("a failing system enqueue is counted and logged; the other system work and the principals still run", async () => {
    vi.mocked(enqueueJob).mockImplementation(async (input) => {
      if (input.kind === "exec.purge") throw new Error("exec_jobs enqueue failed (exec.purge): timeout");
      return { enqueued: true, id: 1 };
    });
    vi.mocked(listEnabledPrincipals).mockResolvedValue([p1]);
    const r = await runSchedulerTick(at("2026-11-06T04:00:00Z"));
    expect(r.system).toBe(1);
    expect(r.summary).toBe("principals=1 enqueued=0 reaped=0 system=1 errors=1");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("system work exec.purge failed"));
  });
});

describe("the brief's other schedules (§3.6)", () => {
  it("SC15 exec.brief-prep at 07:45 for an 08:00 brief; a 00:10 brief → prep at 00:00", () => {
    expect(briefPrepTime("08:00")).toBe("07:45");
    expect(briefPrepTime("00:10")).toBe("00:00");
    expect(briefPrepTime("00:15")).toBe("00:00");
    expect(briefPrepTime("23:30")).toBe("23:15");
    const s = briefOn("ep_1");
    expect(dueDedupeKey(briefPrepScheduledWork, p1, s, at("2026-11-06T12:44:00Z"))).toBeNull();
    expect(dueDedupeKey(briefPrepScheduledWork, p1, s, at("2026-11-06T12:45:00Z"))).toBe("exec.brief-prep:ep_1:2026-11-06");
    expect(dueDedupeKey(briefPrepScheduledWork, split, briefOn("ep_2"), at("2026-11-06T12:45:00Z"))).toBe("exec.brief-prep:ep_2:2026-11-06");
    expect(dueDedupeKey(briefPrepScheduledWork, p1, settings("ep_1"), at("2026-11-06T12:45:00Z"))).toBe("exec.brief-prep:ep_1:2026-11-06");
    expect(briefPrepScheduledWork.enabled?.(settings("ep_1"))).toBe(false);
    expect(briefPrepScheduledWork).toMatchObject({ lane: "bulk", maxAttempts: 1, cadence: { kind: "daily" } });
  });

  it("the §3.6 table: lanes, cadences, zones, gates and attempts of the four principal works", () => {
    expect(briefScheduledWork).toMatchObject({ kind: "exec.brief", lane: "interactive", maxAttempts: 1, cadence: { kind: "daily" } });
    expect(briefScheduledWork.zone?.(split)).toBe(NY);
    expect(briefScheduledWork.enabled?.(briefOn("ep_1"))).toBe(true);
    expect(briefScheduledWork.enabled?.(settings("ep_1"))).toBe(false);
    expect(briefSweepScheduledWork).toMatchObject({ kind: "exec.brief-sweep", lane: "bulk", maxAttempts: 1, cadence: { kind: "interval", minutes: 5 } });
    expect(briefHealthScheduledWork).toMatchObject({ kind: "exec.brief-health", lane: "bulk", maxAttempts: 2, cadence: { kind: "daily" } });
    expect(briefHealthScheduledWork.cadence.kind === "daily" && briefHealthScheduledWork.cadence.at(settings("ep_1"))).toBe("06:00");
    expect(briefHealthScheduledWork.zone?.(split)).toBe(NY);
    expect(briefHealthScheduledWork.enabled?.(briefOn("ep_1", { checkinsEnabled: true }))).toBe(true);
    expect(briefHealthScheduledWork.enabled?.(briefOn("ep_1", { checkinsEnabled: false }))).toBe(false);
    expect(purgeSystemWork).toMatchObject({ kind: "exec.purge", lane: "bulk", maxAttempts: 3, cadence: { kind: "daily", atUtc: "03:30" } });
    expect(opsWatchSystemWork).toMatchObject({ kind: "exec.ops-watch", lane: "bulk", maxAttempts: 1, cadence: { kind: "interval", minutes: 15 } });
    for (const w of [briefScheduledWork, briefPrepScheduledWork, briefSweepScheduledWork, briefHealthScheduledWork]) expect(() => registerScheduledWork(w)).not.toThrow();
  });
});

describe("P2a's scheduler is unchanged (SC16)", () => {
  it("SC16 a one-argument payload function still type-checks and runs; dueDedupeKey defaults to principal.timezone", async () => {
    const oneArg: ScheduledWork = { kind: "test.legacy", lane: "bulk", cadence: { kind: "daily", at: () => "08:00" }, payload: (p) => ({ who: p.id }) };
    registerScheduledWork(oneArg);
    // No zone: evaluated in principal.timezone (Karachi for the split fixture), as P2a did.
    expect(dueDedupeKey(oneArg, split, settings("ep_2"), at("2026-11-06T03:00:00Z"))).toBe("test.legacy:ep_2:2026-11-06");
    vi.mocked(listEnabledPrincipals).mockResolvedValue([split]);
    const r = await runSchedulerTick(at("2026-11-06T03:00:00Z"));
    expect(byKind("test.legacy")).toEqual([{ kind: "test.legacy", lane: "bulk", principalId: "ep_2", payload: { who: "ep_2" }, dedupeKey: "test.legacy:ep_2:2026-11-06", maxAttempts: undefined }]);
    expect(r).toEqual({ principals: 1, enqueued: 1, reaped: 0, summary: "principals=1 enqueued=1 reaped=0" });
    expect("system" in r).toBe(false);
  });

  it("an idle tick with no system work registered stays idle (the summary only grows when system work was enqueued)", async () => {
    await expect(runSchedulerTick(at("2026-11-06T03:00:00Z"))).resolves.toEqual({ principals: 0, enqueued: 0, reaped: 0, summary: "idle" });
  });

  it("__resetSchedulerForTests forgets both registries", () => {
    registerScheduledWork({ kind: "test.a", lane: "bulk", cadence: { kind: "interval", minutes: 5 } });
    registerSystemScheduledWork({ kind: "test.b", lane: "bulk", cadence: { kind: "interval", minutes: 5 } });
    __resetSchedulerForTests();
    expect(listScheduledWork()).toEqual([]);
    expect(listSystemScheduledWork()).toEqual([]);
  });
});
