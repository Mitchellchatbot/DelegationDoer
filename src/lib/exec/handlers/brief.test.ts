import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/exec/brief-build", () => ({ runBriefBuild: vi.fn() }));
vi.mock("@/lib/exec/brief-store", () => ({ releaseRegenLock: vi.fn() }));
vi.mock("@/lib/exec/jobs", () => ({ enqueueJob: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/principal", async (orig) => ({ ...(await orig<typeof import("@/lib/exec/principal")>()), loadSettings: vi.fn() }));
vi.mock("@/lib/exec/slack-intel-store", () => ({ slackIntelState: vi.fn() }));
vi.mock("@/lib/exec/slack-reading", () => ({ enqueueSlackSweepNow: vi.fn() }));

import { BRIEF_TEXT_SENTINELS, assertNoBriefText, captureConsole } from "@/lib/exec/__tests__/brief-assert";
import { runBriefBuild, type BuildResult } from "@/lib/exec/brief-build";
import { BRIEF_OPS } from "@/lib/exec/brief-copy";
import { releaseRegenLock } from "@/lib/exec/brief-store";
import { BRIEF_LIMITS } from "@/lib/exec/brief-types";
import { BRIEF_JOB_KIND, briefJobHandler, briefScheduledWork, parseBriefPayload, runBriefJob } from "@/lib/exec/handlers/brief";
import { BRIEF_PREP_JOB_KIND, briefPrepJobHandler, briefPrepScheduledWork, briefPrepTime, runBriefPrep } from "@/lib/exec/handlers/brief-prep";
import { enqueueJob } from "@/lib/exec/jobs";
import { notifyOps } from "@/lib/exec/ops";
import { DEFAULT_SETTINGS, loadSettings, principalFromRows } from "@/lib/exec/principal";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import { enqueueSlackSweepNow } from "@/lib/exec/slack-reading";
import { NonRetryableError, type ExecSettings, type JobContext } from "@/lib/exec/types";

// P8 contract §5.8 BB07 (the retry chain), BB13, BB14 and §3.13.1 / §3.13.4 (Area C): the exec.brief and exec.brief-prep handlers,
// runBriefBuild and every store / job / Slack module mocked at their boundaries.

const principal = principalFromRows(
  { id: "ep_owner", user_id: "u_mitchell", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
  { id: "u_mitchell", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
  null
)!;
const settings: ExecSettings = { ...DEFAULT_SETTINGS, principalId: principal.id, briefEnabled: true };
const NOW = new Date("2026-11-06T13:05:00.000Z");
const BRIEF_ID = `eb_${"a".repeat(32)}`;
const ctx = (payload: unknown, over: Partial<JobContext> = {}): JobContext =>
  ({ job: { id: 1, kind: BRIEF_JOB_KIND, payload } as unknown as JobContext["job"], principal, signal: new AbortController().signal, workerId: "w1", ...over });
const schedule = { local_date: "2026-11-06", scheduled_at: "2026-11-06T13:00:00.000Z", trigger: "schedule" };
const built: BuildResult = { outcome: "built", briefId: BRIEF_ID, rev: 1, status: "built", statusReason: null, mode: "ai", modeReason: null, deliver: "full", checkins: 2 };

let consoleSpy: ReturnType<typeof captureConsole>;
beforeEach(() => {
  consoleSpy = captureConsole();
  vi.mocked(loadSettings).mockResolvedValue(settings);
  vi.mocked(runBriefBuild).mockResolvedValue(built);
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 2 });
  vi.mocked(notifyOps).mockResolvedValue(true);
  vi.mocked(releaseRegenLock).mockResolvedValue(undefined);
  vi.mocked(slackIntelState).mockResolvedValue("ok");
  vi.mocked(enqueueSlackSweepNow).mockResolvedValue(true);
});
afterEach(() => {
  assertNoBriefText([consoleSpy.calls(), vi.mocked(notifyOps), vi.mocked(enqueueJob)], { label: "logs, alerts and job payloads" });
});

describe("BB13 exec.brief: the payload, the switch, codes only", () => {
  it("a bad payload → NonRetryableError(bad_payload)", async () => {
    const bad = [null, [], {}, { ...schedule, local_date: "2026-11-6" }, { ...schedule, scheduled_at: "never" }, { ...schedule, trigger: "now" },
      { ...schedule, trigger: "retry" }, { ...schedule, trigger: "retry", retry: 3 }, { ...schedule, retry: 1 },
      { ...schedule, trigger: "regenerate" }, { ...schedule, trigger: "regenerate", brief_id: BRIEF_ID, expected_rev: 0 },
      { ...schedule, trigger: "regenerate", brief_id: "eb_x", expected_rev: 1 }, { ...schedule, brief_id: BRIEF_ID }];
    for (const p of bad) {
      expect(parseBriefPayload(p), JSON.stringify(p)).toBeNull();
      await expect(runBriefJob(ctx(p), NOW)).rejects.toThrow(NonRetryableError);
      await expect(runBriefJob(ctx(p), NOW)).rejects.toThrow("bad_payload");
    }
    expect(runBriefBuild).not.toHaveBeenCalled();
    expect(parseBriefPayload({ ...schedule, trigger: "retry", retry: 2 })).toEqual({ ...schedule, trigger: "retry", retry: 2 });
    expect(parseBriefPayload({ ...schedule, trigger: "regenerate", brief_id: BRIEF_ID, expected_rev: 4 }))
      .toEqual({ ...schedule, trigger: "regenerate", brief_id: BRIEF_ID, expected_rev: 4 });
  });

  it("the brief off → skipped brief_off for schedule and retry (a regenerate runs); no principal → skipped", async () => {
    vi.mocked(loadSettings).mockResolvedValue({ ...settings, briefEnabled: false });
    expect(await runBriefJob(ctx(schedule), NOW)).toEqual({ skipped: "brief_off" });
    expect(await runBriefJob(ctx({ ...schedule, trigger: "retry", retry: 1 }), NOW)).toEqual({ skipped: "brief_off" });
    expect(runBriefBuild).not.toHaveBeenCalled();
    await runBriefJob(ctx({ ...schedule, trigger: "regenerate", brief_id: BRIEF_ID, expected_rev: 3 }), NOW);
    expect(runBriefBuild).toHaveBeenCalledTimes(1);
    expect(await runBriefJob(ctx(schedule, { principal: null }), NOW)).toEqual({ skipped: "no_principal" });
  });

  it("runs the build with the payload's facts and returns codes and counts only", async () => {
    const job = new AbortController();
    const r = await runBriefJob(ctx(schedule, { signal: job.signal }), NOW);
    expect(r).toEqual({ outcome: "built", status: "built", mode: "ai", deliver: "full", checkins: 2 });
    expect(vi.mocked(runBriefBuild).mock.calls[0][0]).toEqual({
      principal, settings, localDate: "2026-11-06", scheduledAt: new Date("2026-11-06T13:00:00.000Z"), trigger: "schedule", claimed: null, dryRun: false,
      now: NOW, signal: job.signal
    });
    vi.mocked(runBriefBuild).mockResolvedValueOnce({ outcome: "skipped", reason: "exists" });
    expect(await runBriefJob(ctx(schedule), NOW)).toEqual({ outcome: "skipped", reason: "exists" });
    assertNoBriefText(r);
    expect(JSON.stringify(r)).not.toContain(BRIEF_TEXT_SENTINELS.briefLine);
  });

  it("the handler's registration: interactive, 240 s, the daily schedule in the brief zone with the watchdog companion", () => {
    expect(briefJobHandler).toMatchObject({ kind: "exec.brief", lane: "interactive", timeoutMs: 240_000 });
    expect(briefScheduledWork).toMatchObject({ kind: "exec.brief", lane: "interactive", maxAttempts: 1 });
    expect(briefScheduledWork.zone?.(principal)).toBe("America/New_York");
    const dueAt = new Date("2026-11-06T13:00:00.000Z");
    const c = { now: NOW, settings, zone: "America/New_York", localDate: "2026-11-06", dueAt, dueKey: "k" };
    expect(briefScheduledWork.payload?.(principal, c)).toEqual({ local_date: "2026-11-06", scheduled_at: dueAt.toISOString(), trigger: "schedule" });
    expect(briefScheduledWork.companions?.(principal, c)).toEqual([{ kind: "exec.brief-fallback", lane: "interactive",
      runAfter: new Date(NOW.getTime() + 45 * 60_000), payload: { local_date: "2026-11-06", scheduled_at: dueAt.toISOString() }, maxAttempts: 1 }]);
  });
});

describe("BB07 the pre-model retry chain (C5)", () => {
  const preModel: BuildResult = { outcome: "failed", stage: "pre_model", code: "mentions_read" };

  it("schedule fails → :r1 in 2 minutes; r1 fails → :r2; r2 fails → no more retries and BRIEF_OPS.failed", async () => {
    vi.mocked(runBriefBuild).mockResolvedValue(preModel);
    expect(await runBriefJob(ctx(schedule), NOW)).toEqual({ outcome: "failed", stage: "pre_model", code: "mentions_read", retry: 1 });
    expect(vi.mocked(enqueueJob).mock.calls[0][0]).toEqual({
      kind: "exec.brief", lane: "interactive", principalId: principal.id,
      payload: { local_date: "2026-11-06", scheduled_at: schedule.scheduled_at, trigger: "retry", retry: 1 },
      dedupeKey: `exec.brief:${principal.id}:2026-11-06:r1`, runAfter: new Date(NOW.getTime() + BRIEF_LIMITS.preModelRetryDelayMs), maxAttempts: 1
    });
    expect(await runBriefJob(ctx({ ...schedule, trigger: "retry", retry: 1 }), NOW)).toMatchObject({ retry: 2 });
    expect(vi.mocked(enqueueJob).mock.calls[1][0]).toMatchObject({ dedupeKey: `exec.brief:${principal.id}:2026-11-06:r2`, payload: { retry: 2 } });
    expect(notifyOps).not.toHaveBeenCalled();
    expect(await runBriefJob(ctx({ ...schedule, trigger: "retry", retry: 2 }), NOW)).toEqual({ outcome: "failed", stage: "pre_model", code: "mentions_read" });
    expect(enqueueJob).toHaveBeenCalledTimes(2);
    expect(vi.mocked(notifyOps).mock.calls[0][0]).toEqual({ key: BRIEF_OPS.failed.key(principal.id), title: BRIEF_OPS.failed.title,
      detail: `principal ${principal.id}, 2026-11-06: mentions_read` });
  });

  it("a post-model failure is final (no retry; the build already alerted); a regenerate's failure or skip releases its lock", async () => {
    vi.mocked(runBriefBuild).mockResolvedValueOnce({ outcome: "failed", stage: "post_model", code: "finish_write" });
    expect(await runBriefJob(ctx(schedule), NOW)).toEqual({ outcome: "failed", stage: "post_model", code: "finish_write" });
    expect(enqueueJob).not.toHaveBeenCalled();
    const regen = { ...schedule, trigger: "regenerate", brief_id: BRIEF_ID, expected_rev: 3 };
    vi.mocked(runBriefBuild).mockResolvedValueOnce(preModel);
    await runBriefJob(ctx(regen), NOW);
    expect(enqueueJob).not.toHaveBeenCalled();
    vi.mocked(runBriefBuild).mockResolvedValueOnce({ outcome: "skipped", reason: "legacy_owns" });
    await runBriefJob(ctx(regen), NOW);
    vi.mocked(runBriefBuild).mockResolvedValueOnce({ ...built, status: "delivered", deliver: null });
    await runBriefJob(ctx(regen), NOW);
    expect(vi.mocked(releaseRegenLock).mock.calls).toEqual([[principal, BRIEF_ID, 3], [principal, BRIEF_ID, 3]]);
    // The job's abort releases it too, and propagates.
    const reason = new Error("timeout");
    vi.mocked(runBriefBuild).mockRejectedValueOnce(reason);
    await expect(runBriefJob(ctx(regen), NOW)).rejects.toBe(reason);
    expect(releaseRegenLock).toHaveBeenCalledTimes(3);
  });
});

describe("BB14 exec.brief-prep (C39)", () => {
  it("state ok → one enqueueSlackSweepNow(principal, 'brief'); any other state → skipped with it", async () => {
    expect(await runBriefPrep(ctx({ local_date: "2026-11-06" }, { job: { kind: BRIEF_PREP_JOB_KIND } as never }), NOW)).toEqual({ swept: true });
    expect(vi.mocked(enqueueSlackSweepNow).mock.calls).toEqual([[principal, "brief", NOW]]);
    for (const state of ["not_installed", "not_connected", "reading_revoked", "reading_off", "discovering"] as const) {
      vi.mocked(slackIntelState).mockResolvedValueOnce(state);
      expect(await runBriefPrep(ctx({ local_date: "2026-11-06" }), NOW)).toEqual({ skipped: state });
    }
    expect(enqueueSlackSweepNow).toHaveBeenCalledTimes(1);
    vi.mocked(loadSettings).mockResolvedValueOnce({ ...settings, briefEnabled: false });
    expect(await runBriefPrep(ctx({}), NOW)).toEqual({ skipped: "brief_off" });
    expect(await runBriefPrep(ctx({}, { principal: null }), NOW)).toEqual({ skipped: "no_principal" });
  });

  it("registration: bulk, 15 s, daily 15 minutes before the brief (clamped to 00:00) in the brief zone", () => {
    expect(briefPrepJobHandler).toMatchObject({ kind: "exec.brief-prep", lane: "bulk", timeoutMs: 15_000 });
    expect(briefPrepTime("08:00")).toBe("07:45");
    expect(briefPrepTime("00:10")).toBe("00:00");
    expect(briefPrepTime("bad")).toBe("bad");
    expect(briefPrepScheduledWork.zone?.(principal)).toBe("America/New_York");
    expect(briefPrepScheduledWork.cadence).toMatchObject({ kind: "daily" });
  });
});
