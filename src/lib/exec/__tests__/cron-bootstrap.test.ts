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

import { bootstrapScheduledCrons, getCronHeartbeats, type CronHeartbeat } from "@/lib/cron-bootstrap";
import { runExecSchedulerTick, runExecWorkerTick } from "@/lib/exec/runtime";

type GlobalWithCron = typeof globalThis & { __ddCronBootstrap?: boolean; __ddCronHeartbeats?: unknown };

function resetBootstrap(): void {
  const g = globalThis as GlobalWithCron;
  delete g.__ddCronBootstrap;
  delete g.__ddCronHeartbeats;
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
