import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The exec additions to src/lib/cron-bootstrap.ts: the exec-worker (10 s) and
// exec-scheduler (60 s) loops, the `quiet` flag, the sub-minute interval log
// and the Node-only lazy import. Every runner the bootstrap imports is
// stubbed; timers are faked (setImmediate stays real so the lazy import can
// resolve).

vi.mock("@/lib/inactivity-runner", () => ({ runInactivitySweep: vi.fn(async () => ({ flagged: 0 })) }));
vi.mock("@/lib/eod-recap-runner", () => ({ runEodRecap: vi.fn(async () => ({ ok: true, skipped: "outside-window" })) }));
vi.mock("@/lib/daily-briefing-runner", () => ({ runDailyBriefing: vi.fn(async () => ({ ok: true, skipped: "outside-window" })) }));
vi.mock("@/lib/clients-emailed-push-runner", () => ({
  runClientsEmailedPush: vi.fn(async () => ({ ok: true, skipped: "outside-window" }))
}));
vi.mock("@/lib/scheduled-emails-runner", () => ({
  runScheduledEmails: vi.fn(async () => ({ replies: { sent: 0, considered: 0 }, drafts: { sent: 0, considered: 0 } }))
}));
vi.mock("@/lib/birthday-calendar-sync", () => ({
  syncBirthdaysForAllOwners: vi.fn(async () => ({ owners: 0, created: 0, updated: 0, deleted: 0 }))
}));
vi.mock("@/lib/outbound-sequence-runner", () => ({ runOutboundSequences: vi.fn(async () => ({ sent: 0, considered: 0, failed: 0 })) }));
vi.mock("@/lib/website-builder-integration", () => ({
  syncWebsiteBuildStatuses: vi.fn(async () => ({ scanned: 0, updated: 0, deployed: 0, completed: 0, errors: [] }))
}));
vi.mock("@/lib/support-inbox-poller", () => ({ runSupportInboxPoll: vi.fn(async () => ({ skipped: "inbound-disabled" })) }));
vi.mock("@/lib/exec/runtime", () => ({ runExecWorkerTick: vi.fn(), runExecSchedulerTick: vi.fn() }));
// P9 F19: the drain's lazy import of jobs.ts (inFlightCount), stubbed like the runtime.
vi.mock("@/lib/exec/jobs", () => ({ inFlightCount: vi.fn(() => 0) }));

import {
  bootstrapScheduledCrons,
  drainForShutdown,
  drainWaitMs,
  getCronHeartbeats,
  installShutdownDrain,
  stopScheduledCrons,
  type CronHeartbeat
} from "@/lib/cron-bootstrap";
import { inFlightCount } from "@/lib/exec/jobs";
import { runExecSchedulerTick, runExecWorkerTick } from "@/lib/exec/runtime";

type GlobalWithCron = typeof globalThis & {
  __ddCronBootstrap?: boolean;
  __ddCronHeartbeats?: unknown;
  __ddCronTimers?: unknown;
  __ddCronStopped?: boolean;
  __ddCronDrainInstalled?: boolean;
  __ddExecDraining?: boolean;
};

function resetBootstrap(): void {
  const g = globalThis as GlobalWithCron;
  delete g.__ddCronBootstrap;
  delete g.__ddCronHeartbeats;
  // P9 F19's state.
  delete g.__ddCronTimers;
  delete g.__ddCronStopped;
  delete g.__ddCronDrainInstalled;
  delete g.__ddExecDraining;
}

const heartbeat = (name: string): CronHeartbeat => {
  const hb = getCronHeartbeats().find((h) => h.name === name);
  if (!hb) throw new Error(`no heartbeat for ${name}`);
  return hb;
};

/** Let real event-loop turns pass (the lazy import resolves on them) until `cond` holds. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i += 1) await new Promise((r) => setImmediate(r));
  expect(cond()).toBe(true);
}

/** Let real event-loop turns pass, so any tick already started finishes and logs. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await new Promise((r) => setImmediate(r));
}

const logLines = () => vi.mocked(console.log).mock.calls.map((args) => args.map(String).join(" "));
/** The boot catch-up's log line: "complete — …", or "skipped — …" when it lands on a tick still in flight. */
const catchupLines = (name: string) => logLines().filter((l) => l.startsWith(`[cron:${name}] (boot-catchup)`));

beforeAll(async () => {
  // Warm the module cache so the bootstrap's lazy import resolves quickly.
  await import("@/lib/exec/runtime");
});

beforeEach(() => {
  resetBootstrap();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("VERCEL", "");
  vi.mocked(runExecWorkerTick).mockResolvedValue("idle");
  vi.mocked(runExecSchedulerTick).mockResolvedValue("idle");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetBootstrap();
});

describe("exec loops in cron-bootstrap", () => {
  it("schedules exec-worker every 10 s and exec-scheduler every 60 s", () => {
    bootstrapScheduledCrons();
    expect(heartbeat("exec-worker")).toMatchObject({ intervalMs: 10_000, schedulerActive: true, disabledReason: null });
    expect(heartbeat("exec-scheduler")).toMatchObject({ intervalMs: 60_000, schedulerActive: true, disabledReason: null });
  });

  it("logs sub-minute intervals in seconds and leaves the minute-based lines as they were", () => {
    bootstrapScheduledCrons();
    const lines = logLines();
    expect(lines).toContain("[cron:exec-worker] internal loop scheduled (every 10 s)");
    expect(lines).toContain("[cron:exec-scheduler] internal loop scheduled (every 1 min)");
    expect(lines).toContain("[cron:inactivity] internal loop scheduled (every 60 min)");
    expect(lines).toContain("[cron:birthday-sync] internal loop scheduled (every 1440 min)");
    expect(lines).toContain("[cron:scheduled-emails] internal loop scheduled (every 1 min)");
  });

  it.each([
    ["idle", "ok"],
    ["disabled", "disabled"]
  ])("doesn't log a quiet loop's %s tick, but records it (heartbeat shows %s)", async (summary, shown) => {
    vi.mocked(runExecWorkerTick).mockResolvedValue(summary);
    bootstrapScheduledCrons();
    await vi.advanceTimersByTimeAsync(10_000);
    await until(() => heartbeat("exec-worker").runCount === 1);
    expect(heartbeat("exec-worker")).toMatchObject({ lastRunOk: true, lastRunSummary: shown, lastRunError: null });
    expect(logLines().filter((l) => l.startsWith("[cron:exec-worker] (interval)"))).toEqual([]);
  });

  it("logs a quiet loop's tick when it did something, but keeps the counts out of the shared heartbeat", async () => {
    vi.mocked(runExecWorkerTick).mockResolvedValue("claimed interactive=1 bulk=0");
    bootstrapScheduledCrons();
    await vi.advanceTimersByTimeAsync(10_000);
    await until(() => heartbeat("exec-worker").runCount === 1);
    expect(logLines()).toContain("[cron:exec-worker] (interval) complete — claimed interactive=1 bulk=0");
    // /api/cron/status is open to every signed-in user: an idle tick and a
    // busy one must look the same there.
    expect(heartbeat("exec-worker").lastRunSummary).toBe("ok");
  });

  it("keeps the scheduler's counts out of the shared heartbeat too", async () => {
    vi.mocked(runExecSchedulerTick).mockResolvedValue("principals=1 enqueued=2 reaped=0");
    bootstrapScheduledCrons();
    await vi.advanceTimersByTimeAsync(60_000);
    await until(() => heartbeat("exec-scheduler").runCount >= 1);
    expect(heartbeat("exec-scheduler").lastRunSummary).toBe("ok");
    expect(logLines().some((l) => l.includes("principals=1 enqueued=2 reaped=0"))).toBe(true);
  });

  it("always reports a failed tick, with the detail in the server log only", async () => {
    vi.mocked(runExecWorkerTick).mockRejectedValue(new Error("exec_claim_jobs failed (interactive): connection refused"));
    bootstrapScheduledCrons();
    await vi.advanceTimersByTimeAsync(10_000);
    await until(() => heartbeat("exec-worker").runCount === 1);
    expect(heartbeat("exec-worker")).toMatchObject({
      lastRunOk: false,
      lastRunError: "failed (details in the server log)"
    });
    expect(console.error).toHaveBeenCalledWith("[cron:exec-worker] (interval) failed:", expect.any(Error));
  });

  it("still logs the other loops' summaries", async () => {
    bootstrapScheduledCrons();
    await vi.advanceTimersByTimeAsync(30_000); // inactivity's boot catch-up
    await until(() => heartbeat("inactivity").runCount === 1);
    expect(logLines()).toContain("[cron:inactivity] (boot-catchup) complete — flagged=0");
  });

  it("runs the scheduler on its interval and its boot catch-up at 65 s, not before", async () => {
    vi.mocked(runExecSchedulerTick).mockResolvedValue("principals=1 enqueued=1 reaped=0");
    bootstrapScheduledCrons();
    await vi.advanceTimersByTimeAsync(60_000);
    await until(() => heartbeat("exec-scheduler").runCount === 1);
    expect(logLines()).toContain("[cron:exec-scheduler] (interval) complete — principals=1 enqueued=1 reaped=0");
    await vi.advanceTimersByTimeAsync(4_999);
    await settle();
    expect(catchupLines("exec-scheduler")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => heartbeat("exec-scheduler").runCount === 2);
    expect(catchupLines("exec-scheduler")).toEqual(["[cron:exec-scheduler] (boot-catchup) complete — principals=1 enqueued=1 reaped=0"]);
  });

  it("runs the worker's boot catch-up at 40 s, not before", async () => {
    // A summary the quiet flag doesn't swallow, so a completed catch-up logs.
    vi.mocked(runExecWorkerTick).mockResolvedValue("claimed interactive=1 bulk=0");
    bootstrapScheduledCrons();
    await vi.advanceTimersByTimeAsync(39_999);
    await until(() => heartbeat("exec-worker").runCount === 3); // intervals at 10, 20, 30 s
    await settle();
    expect(catchupLines("exec-worker")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    // 40 s: the interval and the catch-up are both due. The catch-up runs, or
    // is skipped because the interval's run is still in flight; either logs.
    await until(() => catchupLines("exec-worker").length === 1);
    expect(catchupLines("exec-worker")[0]).toMatch(
      /^\[cron:exec-worker\] \(boot-catchup\) (complete — claimed interactive=1 bulk=0|skipped — previous run still in flight)$/
    );
  });

  it.each([
    ["exec-worker", "EXEC_WORKER_INTERNAL_CRON"],
    ["exec-scheduler", "EXEC_SCHEDULER_INTERNAL_CRON"]
  ])("lets %s be switched off with %s=false", async (name, env) => {
    vi.stubEnv(env, "false");
    bootstrapScheduledCrons();
    expect(heartbeat(name)).toMatchObject({ schedulerActive: false, disabledReason: `${env}=false` });
    await vi.advanceTimersByTimeAsync(70_000);
    const tick = name === "exec-worker" ? runExecWorkerTick : runExecSchedulerTick;
    expect(tick).not.toHaveBeenCalled();
  });

  it("stands down on Vercel like the other loops", () => {
    vi.stubEnv("VERCEL", "1");
    bootstrapScheduledCrons();
    expect(heartbeat("exec-worker").schedulerActive).toBe(false);
    expect(heartbeat("exec-scheduler").schedulerActive).toBe(false);
  });

  it("never loads the exec runtime outside the Node.js runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    bootstrapScheduledCrons();
    await vi.advanceTimersByTimeAsync(10_000);
    await until(() => heartbeat("exec-worker").runCount === 1);
    expect(heartbeat("exec-worker").lastRunSummary).toBe("disabled");
    expect(runExecWorkerTick).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// P9 F19 (contract §1, L5, AM-P9-23): the SIGTERM drain. Inert unless NEXT_MANUAL_SIG_HANDLE is set (Next's own handler
// exits); "true" waits for the in-flight exec runs, bounded by RAILWAY_DEPLOYMENT_DRAINING_SECONDS; any other non-empty
// value exits at once (Next registered no handler for it either).
// ---------------------------------------------------------------------------

describe("P9 F19 the SIGTERM drain", () => {
  /** The SIGTERM listeners this test added (installShutdownDrain's), removed after each test. */
  let before: ((...args: unknown[]) => void)[] = [];
  beforeEach(() => {
    vi.stubEnv("NEXT_MANUAL_SIG_HANDLE", "");
    vi.stubEnv("RAILWAY_DEPLOYMENT_DRAINING_SECONDS", "");
    vi.mocked(inFlightCount).mockReset().mockReturnValue(0);
    before = process.listeners("SIGTERM") as ((...args: unknown[]) => void)[];
  });
  afterEach(() => {
    for (const l of process.listeners("SIGTERM")) if (!before.includes(l as (...args: unknown[]) => void)) process.removeListener("SIGTERM", l);
  });

  it("SG01 SIGTERM stops both exec loops: no exec tick after it, the heartbeats say why, and the exec draining flag is set", async () => {
    bootstrapScheduledCrons();
    await vi.advanceTimersByTimeAsync(10_000);
    await until(() => heartbeat("exec-worker").runCount === 1);
    const exit = vi.fn();
    await expect(drainForShutdown({ exit })).resolves.toBe("next-exits");
    await vi.advanceTimersByTimeAsync(130_000);
    await settle();
    expect(runExecWorkerTick).toHaveBeenCalledTimes(1);
    expect(runExecSchedulerTick).not.toHaveBeenCalled();
    for (const name of ["exec-worker", "exec-scheduler", "inactivity", "scheduled-emails"]) {
      expect(heartbeat(name)).toMatchObject({ schedulerActive: false, disabledReason: "shutting down (SIGTERM)" });
    }
    expect((globalThis as GlobalWithCron).__ddExecDraining).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    // Idempotent: a second stop clears nothing more.
    expect(stopScheduledCrons("again")).toBe(0);
  });

  it("SG02 without NEXT_MANUAL_SIG_HANDLE the installed handler never calls process.exit (Next's own handler exits)", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    expect(installShutdownDrain()).toBe(true);
    const ours = process.listeners("SIGTERM").filter((l) => !before.includes(l as (...args: unknown[]) => void));
    expect(ours).toHaveLength(1);
    (ours[0] as () => void)();
    await settle();
    await vi.advanceTimersByTimeAsync(200_000);
    await settle();
    expect(exit).not.toHaveBeenCalled();
    expect((globalThis as GlobalWithCron).__ddExecDraining).toBe(true);
    expect(inFlightCount).not.toHaveBeenCalled();
  });

  it("SG03 NEXT_MANUAL_SIG_HANDLE=true: waits for the in-flight exec runs (re-counting), then exits 0", async () => {
    vi.stubEnv("NEXT_MANUAL_SIG_HANDLE", "true");
    vi.stubEnv("RAILWAY_DEPLOYMENT_DRAINING_SECONDS", "120");
    vi.mocked(inFlightCount).mockReturnValueOnce(2).mockReturnValueOnce(2).mockReturnValueOnce(1).mockReturnValue(0);
    const exit = vi.fn();
    const done = drainForShutdown({ exit });
    await settle(); // the lazy import of jobs.ts resolves on real event-loop turns
    expect(inFlightCount).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await expect(done).resolves.toBe("exited");
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(inFlightCount).toHaveBeenCalledTimes(4);
  });

  it("SG04 the wait is bounded: RAILWAY_DEPLOYMENT_DRAINING_SECONDS=120 → at most 110 s, then it exits with runs still going", async () => {
    vi.stubEnv("NEXT_MANUAL_SIG_HANDLE", "true");
    vi.stubEnv("RAILWAY_DEPLOYMENT_DRAINING_SECONDS", "120");
    vi.mocked(inFlightCount).mockReturnValue(1);
    const exit = vi.fn();
    const done = drainForShutdown({ exit });
    await settle();
    await vi.advanceTimersByTimeAsync(109_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBe("exited");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("SG05 NEXT_MANUAL_SIG_HANDLE set to anything else ('1'): Next registered no handler, so it exits at once without waiting", async () => {
    vi.stubEnv("NEXT_MANUAL_SIG_HANDLE", "1");
    vi.stubEnv("RAILWAY_DEPLOYMENT_DRAINING_SECONDS", "120");
    vi.mocked(inFlightCount).mockReturnValue(3);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await expect(drainForShutdown()).resolves.toBe("exited");
    expect(exit).toHaveBeenCalledWith(0);
    expect(inFlightCount).not.toHaveBeenCalled();
  });

  it("SG06 \"true\" with no draining window (Railway's default 0): exits at once", async () => {
    vi.stubEnv("NEXT_MANUAL_SIG_HANDLE", "true");
    vi.mocked(inFlightCount).mockReturnValue(1);
    const exit = vi.fn();
    await expect(drainForShutdown({ exit })).resolves.toBe("exited");
    expect(exit).toHaveBeenCalledWith(0);
    expect(inFlightCount).not.toHaveBeenCalled();
  });

  it("SG07 drainWaitMs: seconds x 1000 - 5000, clamped to 0..110 000; unset, blank or garbage → 0", () => {
    expect([undefined, "", "  ", "abc", "-30", "3", "5"].map(drainWaitMs)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(drainWaitMs("60")).toBe(55_000);
    expect(drainWaitMs(" 120 ")).toBe(110_000);
    expect(drainWaitMs("600")).toBe(110_000);
    expect(drainWaitMs("5.5")).toBe(500);
  });

  it("SG08 installShutdownDrain registers one SIGTERM listener, once per process, and only on the Node.js runtime", () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    expect(installShutdownDrain()).toBe(false);
    expect(process.listeners("SIGTERM")).toHaveLength(before.length);
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    expect(installShutdownDrain()).toBe(true);
    expect(installShutdownDrain()).toBe(false);
    expect(process.listeners("SIGTERM")).toHaveLength(before.length + 1);
  });

  it("SG09 a stopped bootstrap starts no tick even from a timer that had already fired", async () => {
    bootstrapScheduledCrons();
    stopScheduledCrons("test stop");
    await vi.advanceTimersByTimeAsync(70_000);
    await settle();
    expect(getCronHeartbeats().every((h) => h.runCount === 0 && !h.schedulerActive)).toBe(true);
  });
});
