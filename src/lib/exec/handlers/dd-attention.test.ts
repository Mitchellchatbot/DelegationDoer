import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// exec.dd-attention: produce, then sync within the DD scope, returning counts
// only. The producer and the sync are mocked here (each has its own suite);
// the last block runs the handler through the real job runner.

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/principal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/principal")>();
  return { ...actual, loadPrincipalById: vi.fn() };
});
vi.mock("@/lib/exec/producers/dd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/producers/dd")>();
  return { ...actual, produceDdAttention: vi.fn() };
});
vi.mock("@/lib/exec/attention", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/attention")>();
  return { ...actual, syncAttention: vi.fn() };
});

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { createFakeExecDb, jobRow, type FakeExecDb } from "@/lib/exec/__tests__/fake-exec-db";
import { syncAttention } from "@/lib/exec/attention";
import type { AttentionCandidate } from "@/lib/exec/attention-types";
import { DD_ATTENTION_JOB_KIND, ddAttentionJobHandler, ddAttentionScheduledWork } from "@/lib/exec/handlers/dd-attention";
import { __resetJobsForTests, classifyError, registerJobHandler, runWorkerPass } from "@/lib/exec/jobs";
import { loadPrincipalById, principalFromRows, settingsFromRow } from "@/lib/exec/principal";
import { DD_ATTENTION_KINDS, produceDdAttention } from "@/lib/exec/producers/dd";
import { dueDedupeKey } from "@/lib/exec/scheduler";
import { intervalBucket } from "@/lib/exec/time";
import { NonRetryableError, type ExecPrincipal, type JobContext } from "@/lib/exec/types";

const NOW = new Date("2026-11-04T17:03:00.000Z");

const principal: ExecPrincipal = (() => {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_owner", enabled: true, mail_account_ids: [], slack_team_id: null, slack_user_id: null },
    { id: "u_owner", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
})();

const candidates = [{ fingerprint: "dd:approval:email_drafts" }] as unknown as AttentionCandidate[];
const counts = { inserted: 2, updated: 1, reopened: 1, resolved: 3, unchanged: 7 };

function context(over: Partial<JobContext> = {}): JobContext {
  return {
    job: jobRow({ kind: DD_ATTENTION_JOB_KIND, principal_id: "ep_1" }),
    principal,
    signal: new AbortController().signal,
    workerId: "w",
    ...over
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(produceDdAttention).mockResolvedValue(candidates);
  vi.mocked(syncAttention).mockResolvedValue(counts);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the job and its schedule", () => {
  it("is a bulk job with a 5-minute ceiling", () => {
    expect(ddAttentionJobHandler).toMatchObject({ kind: "exec.dd-attention", lane: "bulk", timeoutMs: 300_000 });
    expect(Object.isFrozen(ddAttentionJobHandler)).toBe(true);
  });

  it("runs every 10 minutes for every principal, retrying at most twice", () => {
    expect(ddAttentionScheduledWork).toEqual({
      kind: DD_ATTENTION_JOB_KIND,
      lane: "bulk",
      cadence: { kind: "interval", minutes: 10 },
      maxAttempts: 3
    });
    expect(Object.isFrozen(ddAttentionScheduledWork)).toBe(true);
    const settings = settingsFromRow(null, "ep_1");
    const key = (at: string) => dueDedupeKey(ddAttentionScheduledWork, principal, settings, new Date(at));
    expect(key("2026-11-04T17:03:00Z")).toBe(`exec.dd-attention:ep_1:i${intervalBucket(NOW, 10)}`);
    expect(key("2026-11-04T17:09:59Z")).toBe(key("2026-11-04T17:00:00Z"));
    expect(key("2026-11-04T17:10:00Z")).not.toBe(key("2026-11-04T17:09:59Z"));
  });
});

describe("a run", () => {
  it("produces, then syncs the DD scope at the same instant, with the job's signal", async () => {
    const ctx = context();
    await expect(ddAttentionJobHandler.run(ctx)).resolves.toEqual(counts);

    expect(produceDdAttention).toHaveBeenCalledTimes(1);
    const [p, produceNow, produceOpts] = vi.mocked(produceDdAttention).mock.calls[0];
    expect(p).toBe(principal);
    expect(produceNow).toEqual(NOW);
    expect(produceOpts).toEqual({ signal: ctx.signal });

    expect(syncAttention).toHaveBeenCalledTimes(1);
    const [syncPrincipal, scope, synced, syncNow, syncOpts] = vi.mocked(syncAttention).mock.calls[0];
    expect(syncPrincipal).toBe(principal);
    expect(scope).toEqual({ source: "dd", kinds: DD_ATTENTION_KINDS });
    expect(synced).toBe(candidates);
    expect(syncNow).toBe(produceNow);
    expect(syncOpts).toEqual({ signal: ctx.signal });
  });

  it("returns the five counts and nothing else", async () => {
    vi.mocked(syncAttention).mockResolvedValue({ ...counts, extra: "x" } as unknown as typeof counts);
    const result = await ddAttentionJobHandler.run(context());
    expect(result).toEqual(counts);
    expect(Object.keys(result as object)).toEqual(["inserted", "updated", "reopened", "resolved", "unchanged"]);
  });

  it("dies at once, touching nothing, when the job has no principal", async () => {
    const err = await ddAttentionJobHandler.run(context({ principal: null })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(err).toMatchObject({ errorClass: "fatal", message: "exec.dd-attention: the job has no principal" });
    expect(classifyError(err)).toBe("fatal");
    expect(produceDdAttention).not.toHaveBeenCalled();
    expect(syncAttention).not.toHaveBeenCalled();
  });

  // An empty sync would resolve every DD item: a failed read must stop the run first.
  it("never syncs when producing fails", async () => {
    const failure = new Error("DD read failed (tasks): statement timeout");
    vi.mocked(produceDdAttention).mockRejectedValue(failure);
    await expect(ddAttentionJobHandler.run(context())).rejects.toBe(failure);
    expect(syncAttention).not.toHaveBeenCalled();
  });

  it("fails when the sync fails", async () => {
    const failure = new Error("exec_attention_items update failed: deadlock detected");
    vi.mocked(syncAttention).mockRejectedValue(failure);
    await expect(ddAttentionJobHandler.run(context())).rejects.toBe(failure);
  });
});

describe("through the job runner", () => {
  let db: FakeExecDb;

  beforeEach(() => {
    vi.useRealTimers();
    vi.stubEnv("EXEC_ENABLED", "true");
    __resetJobsForTests();
    db = createFakeExecDb();
    vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
    vi.mocked(loadPrincipalById).mockResolvedValue(principal);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    registerJobHandler(ddAttentionJobHandler);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetJobsForTests();
  });

  it("records the counts as the job's result", async () => {
    db.queue.push(jobRow({ kind: DD_ATTENTION_JOB_KIND, lane: "bulk", principal_id: "ep_1" }));
    await expect(runWorkerPass({ lane: "bulk", awaitCompletion: true, deadlineMs: 5_000 })).resolves.toMatchObject({
      claimed: 1,
      succeeded: 1
    });
    expect(loadPrincipalById).toHaveBeenCalledWith("ep_1");
    expect(produceDdAttention).toHaveBeenCalledWith(principal, expect.any(Date), { signal: expect.any(AbortSignal) });
    expect(db.callsTo("exec_finish_job")).toEqual([expect.objectContaining({ p_outcome: "succeeded", p_result: counts })]);
  });

  it("dead-letters a job enqueued without a principal instead of retrying it", async () => {
    db.queue.push(jobRow({ kind: DD_ATTENTION_JOB_KIND, lane: "bulk", principal_id: null }));
    await expect(runWorkerPass({ lane: "bulk", awaitCompletion: true, deadlineMs: 5_000 })).resolves.toMatchObject({
      claimed: 1,
      dead: 1
    });
    expect(produceDdAttention).not.toHaveBeenCalled();
    expect(db.callsTo("exec_finish_job")).toEqual([expect.objectContaining({ p_outcome: "dead" })]);
  });
});
