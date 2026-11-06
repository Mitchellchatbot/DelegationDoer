import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/jobs")>();
  return { isValidJobKind: actual.isValidJobKind, enqueueJob: vi.fn(), reapExpiredLeases: vi.fn() };
});
vi.mock("@/lib/exec/principal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/principal")>();
  return { ...actual, listEnabledPrincipals: vi.fn(), loadSettings: vi.fn() };
});

import { enqueueJob, reapExpiredLeases } from "@/lib/exec/jobs";
import { listEnabledPrincipals, loadSettings, principalFromRows, settingsFromRow } from "@/lib/exec/principal";
import { __resetSchedulerForTests, registerScheduledWork, runSchedulerTick, type ScheduledWork } from "@/lib/exec/scheduler";
import type { ExecPrincipal } from "@/lib/exec/types";

// Y4 (P4 contract §3.15; §5.9 PX10): ScheduledWork.when, an asynchronous gate
// evaluated after `enabled` and a non-null dedupe key. false skips the tick, a
// throw is counted as an error and enqueues nothing, absent is P2a's behaviour.

function principal(id: string): ExecPrincipal {
  const p = principalFromRows(
    { id, user_id: `u_${id}`, enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: `u_${id}`, email: `${id}@scaledai.org`, name: id, work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
}

const P1 = principal("ep_1");
const NOW = new Date("2026-11-06T15:02:00.000Z");
const base: ScheduledWork = { kind: "test.when", lane: "bulk", cadence: { kind: "interval", minutes: 5 } };

beforeEach(() => {
  __resetSchedulerForTests();
  vi.stubEnv("EXEC_ENABLED", "true");
  vi.mocked(reapExpiredLeases).mockResolvedValue(0);
  vi.mocked(listEnabledPrincipals).mockResolvedValue([P1]);
  vi.mocked(loadSettings).mockImplementation(async (id: string) => settingsFromRow(null, id));
  vi.mocked(enqueueJob).mockResolvedValue({ enqueued: true, id: 1 });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  __resetSchedulerForTests();
});

describe("PX10 ScheduledWork.when", () => {
  it("false skips: nothing is enqueued and the tick stays idle", async () => {
    const when = vi.fn<NonNullable<ScheduledWork["when"]>>(async () => false);
    registerScheduledWork({ ...base, when });
    const r = await runSchedulerTick(NOW);
    expect(when).toHaveBeenCalledTimes(1);
    expect(when.mock.calls[0][0]).toBe(P1);
    expect(when.mock.calls[0][2]).toBe(NOW);
    expect(vi.mocked(enqueueJob)).not.toHaveBeenCalled();
    expect(r).toMatchObject({ enqueued: 0, summary: "idle" });
  });
  it("true enqueues with the scheduler's own dedupe key", async () => {
    registerScheduledWork({ ...base, when: async () => true, maxAttempts: 2 });
    const r = await runSchedulerTick(NOW);
    expect(r.enqueued).toBe(1);
    expect(vi.mocked(enqueueJob).mock.calls[0][0]).toMatchObject({ kind: "test.when", lane: "bulk", principalId: "ep_1", maxAttempts: 2 });
    expect(String(vi.mocked(enqueueJob).mock.calls[0][0].dedupeKey)).toMatch(/^test\.when:ep_1:/);
  });
  it("a throw is counted as an error, logged, and enqueues nothing; the next work still runs", async () => {
    registerScheduledWork({ ...base, when: async () => { throw new Error("exec_drafts down"); } });
    registerScheduledWork({ ...base, kind: "test.after" });
    const r = await runSchedulerTick(NOW);
    expect(r.summary).toContain("errors=1");
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueJob).mock.calls[0][0].kind).toBe("test.after");
  });
  it("runs only after `enabled` passes and a dedupe key is due", async () => {
    const when = vi.fn<NonNullable<ScheduledWork["when"]>>(async () => true);
    registerScheduledWork({ ...base, enabled: () => false, when });
    registerScheduledWork({ kind: "test.daily", lane: "bulk", cadence: { kind: "daily", at: () => "23:59" }, when });
    await runSchedulerTick(new Date("2026-11-06T12:00:00.000Z"));
    expect(when).not.toHaveBeenCalled();
  });
  it("absent: unchanged behaviour", async () => {
    registerScheduledWork(base);
    expect((await runSchedulerTick(NOW)).enqueued).toBe(1);
  });
});
