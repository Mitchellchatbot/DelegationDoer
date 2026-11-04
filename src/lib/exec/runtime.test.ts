import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/principal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/principal")>();
  return { ...actual, listEnabledPrincipals: vi.fn(), loadSettings: vi.fn(), loadPrincipalById: vi.fn() };
});

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { listEnabledPrincipals, loadPrincipalById, loadSettings, principalFromRows, settingsFromRow } from "@/lib/exec/principal";
import { createFakeExecDb, jobRow, type FakeExecDb } from "@/lib/exec/__tests__/fake-exec-db";
import { PURGE_JOB_KIND, RETENTION_DAYS, purgeJobHandler, purgeScheduledWork, runPurge } from "@/lib/exec/handlers/purge";
import { __resetJobsForTests, getJobHandler, jobsInFlight, registerJobHandler } from "@/lib/exec/jobs";
import { __resetSchedulerForTests, dueDedupeKey, getScheduledWork, listScheduledWork, registerScheduledWork } from "@/lib/exec/scheduler";
import {
  __resetExecRuntimeForTests,
  ensureExecRuntime,
  runExecSchedulerTick,
  runExecTickForCron,
  runExecWorkerTick
} from "@/lib/exec/runtime";
import type { ExecPrincipal, JobContext } from "@/lib/exec/types";

let db: FakeExecDb;

const principal: ExecPrincipal = (() => {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
})();

const NOW = new Date("2026-11-04T12:00:00.000Z"); // 07:00 EST
const DAY_MS = 86_400_000;
const isoDaysBefore = (days: number) => new Date(NOW.getTime() - days * DAY_MS).toISOString();

function resetAll(): void {
  __resetExecRuntimeForTests();
  __resetJobsForTests();
  __resetSchedulerForTests();
}

beforeEach(() => {
  resetAll();
  db = createFakeExecDb();
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  vi.mocked(listEnabledPrincipals).mockResolvedValue([]);
  vi.mocked(loadSettings).mockImplementation(async (id: string) => settingsFromRow(null, id));
  vi.mocked(loadPrincipalById).mockResolvedValue(principal);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetAll();
});

// ---------------------------------------------------------------------------

describe("while EXEC_ENABLED is not 'true'", () => {
  it.each([undefined, "", "false", "1", "TRUE"])("EXEC_ENABLED=%j: every entry point is inert", async (value) => {
    if (value === undefined) vi.stubEnv("EXEC_ENABLED", undefined);
    else vi.stubEnv("EXEC_ENABLED", value);

    await expect(runExecWorkerTick()).resolves.toBe("disabled");
    await expect(runExecSchedulerTick()).resolves.toBe("disabled");
    await expect(runExecTickForCron(40_000)).resolves.toEqual({ ok: true, skipped: "disabled" });

    expect(db.rpcCalls).toEqual([]);
    expect(db.upserts).toEqual([]);
    expect(listEnabledPrincipals).not.toHaveBeenCalled();
    // Nothing was even registered.
    expect(getJobHandler(PURGE_JOB_KIND)).toBeUndefined();
    expect(listScheduledWork()).toEqual([]);
  });
});

describe("ensureExecRuntime", () => {
  it("registers the built-in handler and schedule once, however often it's called", () => {
    ensureExecRuntime();
    ensureExecRuntime();
    expect(getJobHandler(PURGE_JOB_KIND)).toBe(purgeJobHandler);
    expect(getScheduledWork(PURGE_JOB_KIND)).toBe(purgeScheduledWork);
    expect(listScheduledWork()).toHaveLength(1);
  });

  it("tolerates a kind another copy of the module already registered", () => {
    registerJobHandler(purgeJobHandler);
    expect(() => ensureExecRuntime()).not.toThrow();
    expect(getJobHandler(PURGE_JOB_KIND)).toBe(purgeJobHandler);
    expect(getScheduledWork(PURGE_JOB_KIND)).toBe(purgeScheduledWork);
  });

  it("tolerates a schedule that is already registered", () => {
    registerScheduledWork(purgeScheduledWork);
    expect(() => ensureExecRuntime()).not.toThrow();
    expect(listScheduledWork()).toEqual([purgeScheduledWork]);
    expect(getJobHandler(PURGE_JOB_KIND)).toBe(purgeJobHandler);
  });

  it("keeps its once-per-process flag on globalThis", () => {
    ensureExecRuntime();
    __resetJobsForTests();
    __resetSchedulerForTests();
    ensureExecRuntime(); // flag still set: no re-registration
    expect(getJobHandler(PURGE_JOB_KIND)).toBeUndefined();
    __resetExecRuntimeForTests();
    ensureExecRuntime();
    expect(getJobHandler(PURGE_JOB_KIND)).toBe(purgeJobHandler);
  });
});

describe("runExecWorkerTick", () => {
  beforeEach(() => vi.stubEnv("EXEC_ENABLED", "true"));

  it("is idle with an empty queue, after an interactive then a bulk pass", async () => {
    await expect(runExecWorkerTick()).resolves.toBe("idle");
    expect(db.callsTo("exec_claim_jobs").map((c) => c.p_lane)).toEqual(["interactive", "bulk"]);
    expect(getJobHandler(PURGE_JOB_KIND)).toBe(purgeJobHandler);
  });

  it("reports claims and doesn't wait for the jobs", async () => {
    db.queue.push(jobRow({ kind: PURGE_JOB_KIND, lane: "bulk", principal_id: "ep_1" }));
    let release!: () => void;
    db.deleteResult = () => ({ count: 0, error: null });
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(loadPrincipalById).mockImplementation(async () => {
      await gate;
      return principal;
    });

    await expect(runExecWorkerTick()).resolves.toBe("claimed interactive=0 bulk=1");
    expect(jobsInFlight().bulk).toBe(1);
    release();
    await vi.waitFor(() => expect(jobsInFlight().bulk).toBe(0));
    expect(db.callsTo("exec_finish_job")).toEqual([expect.objectContaining({ p_outcome: "succeeded" })]);
  });

  it("still runs the bulk lane when the interactive claim fails, then throws", async () => {
    db.rpc.set("exec_claim_jobs", (args) =>
      args.p_lane === "interactive" ? { data: null, error: { message: "connection reset" } } : { data: [], error: null }
    );
    await expect(runExecWorkerTick()).rejects.toThrow(
      "interactive: exec_claim_jobs failed (interactive): connection reset (claimed interactive=0 bulk=0)"
    );
    expect(db.callsTo("exec_claim_jobs").map((c) => c.p_lane)).toEqual(["interactive", "bulk"]);
  });
});

describe("runExecSchedulerTick", () => {
  beforeEach(() => {
    vi.stubEnv("EXEC_ENABLED", "true");
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  it("is idle when nothing is due", async () => {
    vi.setSystemTime(new Date("2026-11-04T07:00:00Z")); // 02:00 EST, before the 03:30 purge
    vi.mocked(listEnabledPrincipals).mockResolvedValue([principal]);
    await expect(runExecSchedulerTick()).resolves.toBe("idle");
    expect(db.upserts).toEqual([]);
    expect(db.callsTo("exec_reap_expired_leases")).toHaveLength(1);
  });

  it("enqueues the daily purge once its local time has passed, deduped by local date", async () => {
    vi.mocked(listEnabledPrincipals).mockResolvedValue([principal]);

    vi.setSystemTime(new Date("2026-11-04T08:29:00Z")); // 03:29 EST
    await expect(runExecSchedulerTick()).resolves.toBe("idle");
    expect(db.upserts).toEqual([]);

    vi.setSystemTime(new Date("2026-11-04T08:30:00Z")); // 03:30 EST
    await expect(runExecSchedulerTick()).resolves.toBe("principals=1 enqueued=1 reaped=0");
    expect(db.upserts.map((u) => u.row)).toEqual([
      { kind: PURGE_JOB_KIND, lane: "bulk", principal_id: "ep_1", payload: {}, dedupe_key: "exec.purge:ep_1:2026-11-04" }
    ]);

    vi.setSystemTime(new Date("2026-11-04T20:00:00Z")); // later the same local day
    await expect(runExecSchedulerTick()).resolves.toBe("idle");
    expect(db.upserts).toHaveLength(2);
    expect(db.upserts[1].row.dedupe_key).toBe("exec.purge:ep_1:2026-11-04");
  });

  it("reports reaped leases", async () => {
    vi.setSystemTime(NOW);
    db.rpc.set("exec_reap_expired_leases", () => ({ data: 2, error: null }));
    await expect(runExecSchedulerTick()).resolves.toBe("principals=0 enqueued=0 reaped=2");
  });
});

describe("runExecTickForCron", () => {
  beforeEach(() => vi.stubEnv("EXEC_ENABLED", "true"));

  it("runs the scheduler, then both lanes, and reports each part", async () => {
    const out = await runExecTickForCron(40_000);
    expect(out).toEqual({
      ok: true,
      scheduler: { principals: 0, enqueued: 0, reaped: 0, summary: "idle" },
      interactive: {
        lane: "interactive",
        skipped: null,
        claimed: 0,
        succeeded: 0,
        retried: 0,
        dead: 0,
        cancelled: 0,
        leaseLost: 0,
        finishFailed: 0,
        running: 0
      },
      bulk: {
        lane: "bulk",
        skipped: null,
        claimed: 0,
        succeeded: 0,
        retried: 0,
        dead: 0,
        cancelled: 0,
        leaseLost: 0,
        finishFailed: 0,
        running: 0
      },
      budgetMs: 40_000,
      elapsedMs: expect.any(Number)
    });
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(["exec_reap_expired_leases", "exec_claim_jobs", "exec_claim_jobs"]);
  });

  it("waits for the jobs it starts and runs a purge end to end", async () => {
    db.queue.push(jobRow({ kind: PURGE_JOB_KIND, lane: "bulk", principal_id: "ep_1" }));
    db.deleteResult = (d) => ({ count: d.table === "exec_jobs" ? 5 : 1, error: null });
    const out = await runExecTickForCron(40_000);
    expect(out.ok).toBe(true);
    expect(out.bulk).toMatchObject({ claimed: 1, succeeded: 1, running: 0 });
    expect(db.deletes.map((d) => d.table)).toEqual(["exec_jobs", "exec_access_log", "exec_audit_log", "exec_ai_usage"]);
    expect(db.callsTo("exec_finish_job")).toEqual([
      expect.objectContaining({
        p_outcome: "succeeded",
        p_result: { finishedJobs: 5, accessLog: 1, auditLog: 1, aiUsage: 1 }
      })
    ]);
  });

  it("caps the budget at 45 s and floors it at 0", async () => {
    await expect(runExecTickForCron(120_000)).resolves.toMatchObject({ budgetMs: 45_000 });
    await expect(runExecTickForCron(-5)).resolves.toMatchObject({ budgetMs: 0 });
    await expect(runExecTickForCron(Number.NaN)).resolves.toMatchObject({ budgetMs: 0 });
  });

  it("returns at the deadline while a job is still running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    db.queue.push(jobRow({ kind: PURGE_JOB_KIND, lane: "bulk", principal_id: "ep_1" }));
    db.deleteResult = () => ({ count: 0, error: null });
    // The principal lookup stalls past the 1 s budget.
    vi.mocked(loadPrincipalById).mockImplementation(() => new Promise((r) => setTimeout(() => r(principal), 5_000)));

    const tick = runExecTickForCron(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(tick).resolves.toMatchObject({ ok: true, bulk: expect.objectContaining({ claimed: 1, running: 1 }) });
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(jobsInFlight().bulk).toBe(0));
  });

  it("still runs the lanes when the scheduler fails, and reports ok: false", async () => {
    vi.mocked(listEnabledPrincipals).mockRejectedValue(new Error("exec_principals read failed: timeout"));
    const out = await runExecTickForCron(40_000);
    expect(out.ok).toBe(false);
    expect(out.scheduler).toEqual({ error: "exec_principals read failed: timeout" });
    expect(out.interactive).toMatchObject({ claimed: 0 });
    expect(out.bulk).toMatchObject({ claimed: 0 });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("scheduler failed"));
  });

  it("reports a lane whose claim failed, and keeps the other", async () => {
    db.rpc.set("exec_claim_jobs", (args) =>
      args.p_lane === "bulk" ? { data: null, error: { message: "permission denied" } } : { data: [], error: null }
    );
    const out = await runExecTickForCron(40_000);
    expect(out.ok).toBe(false);
    expect(out.bulk).toEqual({ lane: "bulk", error: "exec_claim_jobs failed (bulk): permission denied" });
    expect(out.interactive).toMatchObject({ lane: "interactive", claimed: 0 });
  });
});

// ---------------------------------------------------------------------------

describe("exec.purge", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  it("is a bulk job with a 120 s ceiling, scheduled daily at 03:30 local", () => {
    expect(purgeJobHandler).toMatchObject({ kind: "exec.purge", lane: "bulk", timeoutMs: 120_000 });
    expect(purgeScheduledWork).toMatchObject({ kind: "exec.purge", lane: "bulk", cadence: { kind: "daily" } });
    expect(purgeScheduledWork.enabled).toBeUndefined();
    const settings = settingsFromRow(null, "ep_1");
    expect(dueDedupeKey(purgeScheduledWork, principal, settings, new Date("2026-11-04T08:29:59Z"))).toBeNull();
    expect(dueDedupeKey(purgeScheduledWork, principal, settings, new Date("2026-11-04T08:30:00Z"))).toBe("exec.purge:ep_1:2026-11-04");
    // Ignores the brief time: it's not tied to any setting.
    const briefAtFour = { ...settings, briefLocalTime: "04:00" };
    expect(dueDedupeKey(purgeScheduledWork, principal, briefAtFour, new Date("2026-11-04T08:30:00Z"))).toBe("exec.purge:ep_1:2026-11-04");
    expect(Object.isFrozen(purgeJobHandler)).toBe(true);
    expect(Object.isFrozen(purgeScheduledWork)).toBe(true);
  });

  it("deletes past each table's retention and returns the counts", async () => {
    expect(RETENTION_DAYS).toEqual({ finishedJobs: 14, accessLog: 90, auditLog: 400, aiUsage: 400 });
    const counts: Record<string, number> = { exec_jobs: 7, exec_access_log: 30, exec_audit_log: 2, exec_ai_usage: 11 };
    db.deleteResult = (d) => ({ count: counts[d.table], error: null });
    const signal = new AbortController().signal;

    await expect(runPurge(signal)).resolves.toEqual({ finishedJobs: 7, accessLog: 30, auditLog: 2, aiUsage: 11 });

    expect(db.deletes).toEqual([
      {
        table: "exec_jobs",
        opts: { count: "exact" },
        filters: [
          ["in", "status", ["succeeded", "dead", "cancelled"]],
          ["lt", "finished_at", isoDaysBefore(14)]
        ],
        signal
      },
      { table: "exec_access_log", opts: { count: "exact" }, filters: [["lt", "created_at", isoDaysBefore(90)]], signal },
      { table: "exec_audit_log", opts: { count: "exact" }, filters: [["lt", "created_at", isoDaysBefore(400)]], signal },
      { table: "exec_ai_usage", opts: { count: "exact" }, filters: [["lt", "created_at", isoDaysBefore(400)]], signal }
    ]);
    expect(console.log).toHaveBeenCalledWith("[exec-purge] deleted finishedJobs=7 accessLog=30 auditLog=2 aiUsage=11");
  });

  it("runs every step even when one fails, then fails the run", async () => {
    db.deleteResult = (d) =>
      d.table === "exec_access_log" ? { count: null, error: { message: "statement timeout" } } : { count: 1, error: null };
    await expect(runPurge()).rejects.toThrow("exec.purge: 1 of 4 steps failed: accessLog: exec_access_log purge failed: statement timeout");
    expect(db.deletes.map((d) => d.table)).toEqual(["exec_jobs", "exec_access_log", "exec_audit_log", "exec_ai_usage"]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("accessLog step failed"));
  });

  it("stops between steps once its signal aborts", async () => {
    const controller = new AbortController();
    db.deleteResult = (d) => {
      if (d.table === "exec_jobs") controller.abort(new Error("lease lost"));
      return { count: 1, error: null };
    };
    await expect(runPurge(controller.signal)).rejects.toThrow("lease lost");
    expect(db.deletes.map((d) => d.table)).toEqual(["exec_jobs"]);
  });

  it("does nothing with an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("timed out"));
    await expect(runPurge(controller.signal)).rejects.toThrow("timed out");
    expect(db.deletes).toEqual([]);
  });

  it("passes the job's signal through when the runner calls it", async () => {
    const controller = new AbortController();
    const ctx = { job: jobRow({ kind: PURGE_JOB_KIND }), principal, signal: controller.signal, workerId: "w" } satisfies JobContext;
    await expect(purgeJobHandler.run(ctx)).resolves.toEqual({ finishedJobs: 0, accessLog: 0, auditLog: 0, aiUsage: 0 });
    expect(db.deletes.every((d) => d.signal === controller.signal)).toBe(true);
  });
});
