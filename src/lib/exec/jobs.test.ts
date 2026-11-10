import { hostname } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/supabase-admin", () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({ getSupabaseServer: vi.fn() }));
vi.mock("@/lib/exec/ops", () => ({ notifyOps: vi.fn() }));
vi.mock("@/lib/exec/principal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exec/principal")>();
  return { ...actual, loadPrincipalById: vi.fn() };
});

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { notifyOps } from "@/lib/exec/ops";
import { loadPrincipalById, principalFromRows } from "@/lib/exec/principal";
import {
  EXEC_DRAINING_KEY,
  WORKER_ID,
  __resetJobsForTests,
  backoffMs,
  claimableJobKinds,
  classifyError,
  enqueueJob,
  getJobHandler,
  inFlightCount,
  isExecDraining,
  jobsInFlight,
  kickInteractive,
  purgeFinishedJobs,
  reapExpiredLeases,
  registerJobHandler,
  runWorkerPass,
  startExecDraining
} from "@/lib/exec/jobs";
import { draftGenerateJobHandler } from "@/lib/exec/handlers/draft-generate";
import { draftReconcileJobHandler } from "@/lib/exec/handlers/draft-reconcile";
import { createFakeExecDb, deferred, jobRow as baseJobRow, type FakeExecDb, type FakeResult } from "@/lib/exec/__tests__/fake-exec-db";
import {
  BudgetExceededError,
  NonRetryableError,
  type EnqueueJobInput,
  type ExecJobRow,
  type ExecPrincipal,
  type JobContext,
  type JobHandler,
  type JobLane
} from "@/lib/exec/types";

// The fake service-role client lives in __tests__/fake-exec-db.ts (shared
// with the runtime and cron-route tests). Rows default to this worker's id.

let db: FakeExecDb;

const callsTo = (fn: string) => db.callsTo(fn);
const finishCalls = () => callsTo("exec_finish_job");
const claimCalls = () => callsTo("exec_claim_jobs");
const heartbeatCalls = () => callsTo("exec_heartbeat_job");

function jobRow(over: Partial<ExecJobRow> = {}): ExecJobRow {
  return baseJobRow({ locked_by: WORKER_ID, ...over });
}

function queue(...rows: ExecJobRow[]): ExecJobRow[] {
  db.queue.push(...rows);
  return rows;
}

function handler(run: JobHandler["run"], over: Partial<JobHandler> = {}): JobHandler {
  const h: JobHandler = { kind: "test.job", lane: "bulk", timeoutMs: 60_000, run, ...over };
  registerJobHandler(h);
  return h;
}

const principal: ExecPrincipal = (() => {
  const p = principalFromRows(
    { id: "ep_1", user_id: "u_1", enabled: true, mail_account_ids: ["acc_1"], slack_team_id: null, slack_user_id: null },
    { id: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", work_timezone: "America/New_York" },
    null
  );
  if (!p) throw new Error("fixture principal did not mint");
  return p;
})();

const opsKeys = () => vi.mocked(notifyOps).mock.calls.map(([alert]) => alert.key);
const NOW = new Date("2026-11-04T12:00:00.000Z");

beforeEach(() => {
  __resetJobsForTests();
  db = createFakeExecDb();
  vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
  vi.stubEnv("EXEC_ENABLED", "true");
  vi.mocked(notifyOps).mockResolvedValue(true);
  vi.mocked(loadPrincipalById).mockResolvedValue(principal);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  __resetJobsForTests();
});

// ---------------------------------------------------------------------------

describe("WORKER_ID", () => {
  it("is hostname:pid:6 hex and survives a state reset", () => {
    expect(WORKER_ID.startsWith(`${hostname()}:${process.pid}:`)).toBe(true);
    expect(WORKER_ID).toMatch(/:[0-9a-f]{6}$/);
    __resetJobsForTests();
    expect(WORKER_ID.startsWith(`${hostname()}:${process.pid}:`)).toBe(true);
  });
});

describe("registerJobHandler", () => {
  it("registers by kind and rejects a duplicate", () => {
    const h = handler(async () => null);
    expect(getJobHandler("test.job")).toBe(h);
    expect(getJobHandler("other.job")).toBeUndefined();
    expect(() => handler(async () => null)).toThrow(/already registered for kind "test.job"/);
  });

  it.each<[string, Partial<JobHandler> & Record<string, unknown>]>([
    ["an empty kind", { kind: "" }],
    ["a kind with spaces", { kind: "bad kind" }],
    ["an unknown lane", { lane: "urgent" as JobLane }],
    ["a non-function run", { run: "nope" as unknown as JobHandler["run"] }],
    ["a zero timeout", { timeoutMs: 0 }],
    ["a NaN timeout", { timeoutMs: Number.NaN }],
    ["an infinite timeout", { timeoutMs: Number.POSITIVE_INFINITY }],
    ["a timeout setTimeout would clamp to 1 ms", { timeoutMs: 2 ** 31 }]
  ])("rejects %s", (_label, over) => {
    const h = { kind: "test.job", lane: "bulk", timeoutMs: 1000, run: async () => null, ...over } as JobHandler;
    expect(() => registerJobHandler(h)).toThrow();
    expect(getJobHandler(String(over.kind ?? "test.job"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("enqueueJob", () => {
  const input: EnqueueJobInput = { kind: "test.job", lane: "bulk", principalId: "ep_1", payload: { threadId: "t_1" }, dedupeKey: "test.job:ep_1:x" };

  it("upserts on dedupe_key ignoring duplicates and returns the new id", async () => {
    await expect(enqueueJob(input)).resolves.toEqual({ enqueued: true, id: 41 });
    expect(db.upserts).toEqual([
      {
        table: "exec_jobs",
        row: { kind: "test.job", lane: "bulk", principal_id: "ep_1", payload: { threadId: "t_1" }, dedupe_key: "test.job:ep_1:x" },
        opts: { onConflict: "dedupe_key", ignoreDuplicates: true },
        select: "id"
      }
    ]);
  });

  it("leaves run_after and max_attempts to the column defaults unless given", async () => {
    await enqueueJob({ kind: "test.job", lane: "bulk", principalId: null });
    expect(db.upserts[0].row).toEqual({ kind: "test.job", lane: "bulk", principal_id: null, payload: {}, dedupe_key: null });

    await enqueueJob({ ...input, runAfter: new Date("2026-11-04T13:00:00Z"), maxAttempts: 3 });
    expect(db.upserts[1].row).toMatchObject({ run_after: "2026-11-04T13:00:00.000Z", max_attempts: 3 });
  });

  it("reports a dedupe hit as not enqueued", async () => {
    db.upsertResult = () => ({ data: [], error: null });
    await expect(enqueueJob(input)).resolves.toEqual({ enqueued: false, id: null });
  });

  it("accepts a numeric-string id", async () => {
    db.upsertResult = () => ({ data: [{ id: "9007" }], error: null });
    await expect(enqueueJob(input)).resolves.toEqual({ enqueued: true, id: 9007 });
  });

  it("throws when the insert fails", async () => {
    db.upsertResult = () => ({ data: null, error: { message: "permission denied for table exec_jobs" } });
    await expect(enqueueJob(input)).rejects.toThrow("exec_jobs enqueue failed (test.job): permission denied for table exec_jobs");
  });

  it.each<[string, Partial<EnqueueJobInput> & Record<string, unknown>]>([
    ["an empty kind", { kind: "" }],
    ["a kind with spaces", { kind: "test job" }],
    ["an unknown lane", { lane: "urgent" as JobLane }],
    ["an empty principal id", { principalId: "" }],
    ["an array payload", { payload: [] as unknown as Record<string, unknown> }],
    ["a non-JSON payload", { payload: { n: BigInt(1) } }],
    ["an oversized payload (content, not references)", { payload: { body: "x".repeat(5_000) } }],
    ["an empty dedupe key", { dedupeKey: "" }],
    ["a huge dedupe key", { dedupeKey: "k".repeat(301) }],
    ["an invalid runAfter", { runAfter: new Date("nope") }],
    ["maxAttempts 0", { maxAttempts: 0 }],
    ["maxAttempts 21", { maxAttempts: 21 }],
    ["fractional maxAttempts", { maxAttempts: 1.5 }]
  ])("refuses %s without touching the database", async (_label, over) => {
    await expect(enqueueJob({ ...input, ...over } as EnqueueJobInput)).rejects.toThrow(/enqueueJob/);
    expect(db.upserts).toEqual([]);
  });

  it("kicks the interactive lane after inserting interactive work", async () => {
    handler(async () => null);
    await enqueueJob({ ...input, lane: "interactive" });
    await vi.waitFor(() => expect(claimCalls()).toHaveLength(1));
    expect(claimCalls()[0]).toMatchObject({ p_lane: "interactive", p_limit: 4 });
  });

  // Each case registers a handler and keeps EXEC_ENABLED on while the event
  // loop turns, so a wrong kick would really reach exec_claim_jobs.
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  };

  it("doesn't kick for bulk work", async () => {
    handler(async () => null);
    await enqueueJob({ ...input, lane: "bulk" });
    await flush();
    expect(claimCalls()).toEqual([]);
  });

  it("doesn't kick for a dedupe hit (the job was already queued)", async () => {
    handler(async () => null);
    db.upsertResult = () => ({ data: [], error: null });
    await expect(enqueueJob({ ...input, lane: "interactive" })).resolves.toEqual({ enqueued: false, id: null });
    await flush();
    expect(claimCalls()).toEqual([]);
  });

  it("doesn't kick while disabled", async () => {
    handler(async () => null);
    vi.stubEnv("EXEC_ENABLED", "false");
    await enqueueJob({ ...input, lane: "interactive" });
    await flush();
    expect(claimCalls()).toEqual([]);
  });

  it("(control) the same flush does see a real kick", async () => {
    handler(async () => null);
    await enqueueJob({ ...input, lane: "interactive" });
    await flush();
    expect(claimCalls()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("classifyError", () => {
  const httpError = (status: number) => Object.assign(new Error(`http ${status}`), { status });

  it.each<[string, unknown, string]>([
    ["NonRetryableError", new NonRetryableError("bad data"), "fatal"],
    ["NonRetryableError(auth)", new NonRetryableError("token revoked", "auth"), "auth"],
    ["errorClass beats status", { errorClass: "retryable", status: 400 }, "retryable"],
    ["LlmCallError-shaped fatal", { name: "LlmCallError", errorClass: "fatal", status: 529 }, "fatal"],
    ["an unknown errorClass is ignored", { errorClass: "maybe", status: 401 }, "auth"],
    ["BudgetExceededError", new BudgetExceededError(15.2, 15), "fatal"],
    ["BudgetExceededError by name", { name: "BudgetExceededError", message: "cap" }, "fatal"],
    ["401", httpError(401), "auth"],
    ["403", httpError(403), "auth"],
    ["408", httpError(408), "retryable"],
    ["409", httpError(409), "retryable"],
    ["425", httpError(425), "retryable"],
    ["429", httpError(429), "retryable"],
    ["500", httpError(500), "retryable"],
    ["502", httpError(502), "retryable"],
    ["503", httpError(503), "retryable"],
    ["529", httpError(529), "retryable"],
    ["400", httpError(400), "fatal"],
    ["404", httpError(404), "fatal"],
    ["413", httpError(413), "fatal"],
    ["422", httpError(422), "fatal"],
    ["statusCode 403", { statusCode: 403 }, "auth"],
    ["status as a string", { status: "429" }, "retryable"],
    ["a 2xx status says nothing", { status: 200 }, "retryable"],
    ["AbortError", new DOMException("aborted", "AbortError"), "retryable"],
    ["TimeoutError", new DOMException("timed out", "TimeoutError"), "retryable"],
    ["ECONNRESET", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), "retryable"],
    ["ETIMEDOUT", { code: "ETIMEDOUT" }, "retryable"],
    ["undici fetch failed", new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }), "retryable"],
    ["socket hang up", new Error("socket hang up"), "retryable"],
    ["a wrapped 401 keeps its class", new Error("brief failed", { cause: httpError(401) }), "auth"],
    ["a wrapped 400 keeps its class", new Error("triage failed", { cause: { cause: httpError(400) } }), "fatal"],
    ["AggregateError children", new AggregateError([new Error("x"), httpError(403)], "both failed"), "auth"],
    ["a plain Error", new Error("boom"), "retryable"],
    ["a thrown string", "boom", "retryable"],
    ["null", null, "retryable"],
    ["undefined", undefined, "retryable"]
  ])("%s → %s", (_label, err, expected) => {
    expect(classifyError(err)).toBe(expected);
  });

  it("terminates on a cyclic cause chain", () => {
    const a: Record<string, unknown> = { message: "a" };
    const b: Record<string, unknown> = { message: "b", cause: a };
    a.cause = b;
    expect(classifyError(a)).toBe("retryable");
  });
});

describe("backoffMs", () => {
  it("doubles from 30 s per attempt", () => {
    const mid = () => 0.5;
    expect(backoffMs(1, mid)).toBe(30_000);
    expect(backoffMs(2, mid)).toBe(60_000);
    expect(backoffMs(3, mid)).toBe(120_000);
    expect(backoffMs(6, mid)).toBe(960_000);
    expect(backoffMs(7, mid)).toBe(1_920_000);
  });

  it("jitters ±20%", () => {
    expect(backoffMs(1, () => 0)).toBe(24_000);
    expect(backoffMs(1, () => 1)).toBe(36_000);
    expect(backoffMs(3, () => 0.25)).toBe(108_000);
  });

  it("caps at one hour, jitter included", () => {
    expect(backoffMs(8, () => 0.5)).toBe(3_600_000);
    expect(backoffMs(8, () => 1)).toBe(3_600_000);
    expect(backoffMs(8, () => 0)).toBe(2_880_000);
    expect(backoffMs(10_000, () => 0.5)).toBe(3_600_000);
  });

  it("treats a missing or nonsensical attempt as the first", () => {
    for (const attempt of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) expect(backoffMs(attempt, () => 0.5)).toBe(30_000);
    expect(backoffMs(2.9, () => 0.5)).toBe(60_000);
  });

  it("clamps a misbehaving random source", () => {
    expect(backoffMs(1, () => -1)).toBe(24_000);
    expect(backoffMs(1, () => 2)).toBe(36_000);
    expect(backoffMs(1, () => Number.NaN)).toBe(30_000);
  });

  it("stays within [1 s, 1 h] for any attempt and random", () => {
    for (let attempt = -2; attempt <= 40; attempt += 1) {
      for (const r of [0, 0.1, 0.5, 0.9, 1]) {
        const ms = backoffMs(attempt, () => r);
        expect(ms).toBeGreaterThanOrEqual(1_000);
        expect(ms).toBeLessThanOrEqual(3_600_000);
      }
    }
  });

  it("defaults to Math.random", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(backoffMs(1)).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------

describe("runWorkerPass: claiming", () => {
  beforeEach(() => {
    handler(async () => null);
  });

  it("does nothing while EXEC_ENABLED is not 'true'", async () => {
    vi.stubEnv("EXEC_ENABLED", "");
    await expect(runWorkerPass({ lane: "bulk" })).resolves.toMatchObject({ lane: "bulk", skipped: "disabled", claimed: 0 });
    expect(db.rpcCalls).toEqual([]);
  });

  it("rejects an unknown lane or a bad concurrency", async () => {
    await expect(runWorkerPass({ lane: "urgent" as JobLane })).rejects.toThrow(/unknown lane/);
    await expect(runWorkerPass({ lane: "bulk", concurrency: -1 })).rejects.toThrow(/concurrency/);
    await expect(runWorkerPass({ lane: "bulk", concurrency: 1.5 })).rejects.toThrow(/concurrency/);
    expect(db.rpcCalls).toEqual([]);
  });

  it("claims into the lane's default slots with this worker's id and a 120 s lease", async () => {
    await runWorkerPass({ lane: "bulk" });
    await runWorkerPass({ lane: "interactive" });
    expect(claimCalls()).toEqual([
      { p_worker: WORKER_ID, p_lane: "bulk", p_limit: 2, p_lease_seconds: 120, p_kinds: ["test.job"] },
      { p_worker: WORKER_ID, p_lane: "interactive", p_limit: 4, p_lease_seconds: 120, p_kinds: ["test.job"] }
    ]);
  });

  it("asks only for the kinds this process has handlers for, whatever their lane", async () => {
    handler(async () => null, { kind: "other.job", lane: "interactive" });
    // A kind only a newer release knows (a deploy overlap) stays queued for it.
    const [ghost] = queue(jobRow({ kind: "ghost.job" }));
    const summary = await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    expect(claimCalls()[0].p_kinds).toEqual(["test.job", "other.job"]);
    expect(summary).toMatchObject({ claimed: 0 });
    expect(db.queue).toEqual([ghost]);
    expect(finishCalls()).toEqual([]);
  });

  it("clamps the lease to whole seconds between 5 s and 1 h, like the RPCs", async () => {
    await runWorkerPass({ lane: "bulk", leaseSeconds: 2 });
    await runWorkerPass({ lane: "bulk", leaseSeconds: 45.7 });
    await runWorkerPass({ lane: "bulk", leaseSeconds: 7_200 });
    await runWorkerPass({ lane: "bulk", leaseSeconds: Number.NaN });
    expect(claimCalls().map((c) => c.p_lease_seconds)).toEqual([5, 45, 3_600, 120]);
  });

  it("returns an empty summary when nothing is due", async () => {
    await expect(runWorkerPass({ lane: "bulk", awaitCompletion: true })).resolves.toEqual({
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
    });
    expect(jobsInFlight()).toEqual({ interactive: 0, bulk: 0 });
  });

  it("throws when the claim fails and gives the reserved slots back", async () => {
    db.rpc.set("exec_claim_jobs", () => ({ data: null, error: { message: "connection refused" } }));
    await expect(runWorkerPass({ lane: "bulk" })).rejects.toThrow("exec_claim_jobs failed (bulk): connection refused");
    expect(jobsInFlight()).toEqual({ interactive: 0, bulk: 0 });
  });

  it("treats a claim with no rows array as nothing claimed", async () => {
    db.rpc.set("exec_claim_jobs", () => ({ data: null, error: null }));
    await expect(runWorkerPass({ lane: "bulk" })).resolves.toMatchObject({ claimed: 0, skipped: null });
    expect(jobsInFlight()).toEqual({ interactive: 0, bulk: 0 });
  });

  it("claims nothing until the runtime has registered a handler in this process", async () => {
    __resetJobsForTests();
    queue(jobRow());
    await expect(runWorkerPass({ lane: "bulk", awaitCompletion: true })).resolves.toMatchObject({ skipped: "no-handlers", claimed: 0 });
    expect(db.rpcCalls).toEqual([]);
    expect(db.queue).toHaveLength(1);
  });
});

describe("runWorkerPass: running a job", () => {
  it("runs the handler with the job, principal, signal and worker id, then records success", async () => {
    const [job] = queue(jobRow({ principal_id: "ep_1", payload: { threadId: "t_1" } }));
    let seen: JobContext | null = null;
    handler(async (ctx) => {
      seen = ctx;
      return { processed: 3 };
    });

    const summary = await runWorkerPass({ lane: "bulk", awaitCompletion: true });

    expect(loadPrincipalById).toHaveBeenCalledWith("ep_1");
    expect(seen).not.toBeNull();
    const ctx = seen as unknown as JobContext;
    expect(ctx.job).toEqual(job);
    expect(ctx.principal).toBe(principal);
    expect(ctx.workerId).toBe(WORKER_ID);
    expect(ctx.signal.aborted).toBe(false);
    expect(finishCalls()).toEqual([
      {
        p_id: job.id,
        p_worker: WORKER_ID,
        p_attempt: 1,
        p_outcome: "succeeded",
        p_error: null,
        p_result: { processed: 3 },
        p_retry_at: null
      }
    ]);
    expect(summary).toMatchObject({ claimed: 1, succeeded: 1, running: 0 });
    expect(jobsInFlight().bulk).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`test\\.job#${job.id}: succeeded in \\d+ ms`)));
  });

  it("runs a system job (no principal) without loading one", async () => {
    queue(jobRow({ principal_id: null }));
    let p: ExecPrincipal | null | undefined;
    handler(async (ctx) => {
      p = ctx.principal;
    });
    await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    expect(loadPrincipalById).not.toHaveBeenCalled();
    expect(p).toBeNull();
    expect(finishCalls()[0]).toMatchObject({ p_outcome: "succeeded", p_result: null });
  });

  /** Run one job whose handler returns `value`; give back the stored p_result. */
  async function storedResult(value: unknown): Promise<unknown> {
    queue(jobRow());
    handler(async () => value);
    await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    return finishCalls()[0].p_result;
  }

  it("keeps the stored result small: no bodies, no secrets, no bulk", async () => {
    queue(jobRow(), jobRow());
    let call = 0;
    handler(async () => {
      call += 1;
      return call === 1
        ? { count: 2, body: "the full email text", accessToken: "xoxb-123" }
        : { ids: Array.from({ length: 100 }, (_, i) => `thread-${"x".repeat(30)}-${i}`) };
    });
    await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    const results = finishCalls().map((c) => c.p_result);
    expect(results).toContainEqual({ count: 2, body: { omitted: true, chars: 19 }, accessToken: "[redacted]" });
    expect(results).toContainEqual({ truncated: true, chars: expect.any(Number) });
  });

  it("drops prose whatever its key is called, keeping counts, flags and ids", async () => {
    expect(
      await storedResult({
        reply: "Hi Sam - the acquisition terms are attached, call me",
        draft: { subject: "Re: terms", ok: true },
        threadId: "AAMkAGI2THVSAAA=",
        sent: 3,
        when: "2026-11-04T08:00:00.000Z",
        to: "sam@example.com",
        ratio: Number.NaN
      })
    ).toEqual({
      reply: { omitted: true, chars: 52 },
      draft: { subject: { omitted: true, chars: 9 }, ok: true },
      threadId: "AAMkAGI2THVSAAA=",
      sent: 3,
      when: "2026-11-04T08:00:00.000Z",
      to: "sam@example.com",
      ratio: null
    });
  });

  it("drops a bare prose result", async () => {
    expect(await storedResult("Here is the full answer I wrote for Mitchell")).toEqual({ omitted: true, chars: 44 });
  });

  it("keeps a bare id-like result", async () => {
    expect(await storedResult("done")).toBe("done");
  });

  it("stops at three levels deep", async () => {
    expect(await storedResult({ a: { b: { c: { d: 1 } } } })).toEqual({ a: { b: { c: { omitted: true } } } });
  });

  it("keeps at most 100 entries of an array", async () => {
    expect(await storedResult(Array.from({ length: 150 }, (_, i) => i))).toHaveLength(100);
  });

  it("cancels the job when its principal is disabled or gone, without running it", async () => {
    vi.mocked(loadPrincipalById).mockResolvedValue(null);
    queue(jobRow({ principal_id: "ep_9" }));
    const run = vi.fn(async () => null);
    handler(run);
    const summary = await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    expect(run).not.toHaveBeenCalled();
    expect(finishCalls()).toEqual([expect.objectContaining({ p_outcome: "cancelled", p_error: "principal disabled or missing" })]);
    expect(summary).toMatchObject({ cancelled: 1 });
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("retries when the principal lookup itself fails", async () => {
    vi.mocked(loadPrincipalById).mockRejectedValue(new Error("exec_principals read failed: timeout"));
    queue(jobRow({ principal_id: "ep_1" }));
    const run = vi.fn(async () => null);
    handler(run);
    await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    expect(run).not.toHaveBeenCalled();
    expect(finishCalls()[0]).toMatchObject({ p_outcome: "retry", p_error: "retryable: exec_principals read failed: timeout" });
  });

  /** A database whose exec_claim_jobs ignores p_kinds: the only way a handler-less kind can be claimed now. */
  function claimIgnoringKinds(row: ExecJobRow): void {
    db.rpc.set("exec_claim_jobs", () => ({ data: [row], error: null }));
  }

  it("sends a job with no registered handler back to the queue, for a release that has one", async () => {
    // Defence in depth behind the p_kinds filter. Dead-lettering it would
    // lose the work (its dedupe key stays taken).
    handler(async () => null); // other kinds are registered, just not this one
    claimIgnoringKinds(jobRow({ kind: "ghost.job", attempts: 1 }));
    const summary = await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    expect(finishCalls()).toEqual([
      expect.objectContaining({
        p_outcome: "retry",
        p_error: 'retryable: no handler registered for job kind "ghost.job"',
        p_retry_at: expect.any(String)
      })
    ]);
    expect(notifyOps).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ retried: 1, dead: 0 });
  });

  it("dead-letters a kind no release handles once its attempts are used up, and alerts ops", async () => {
    handler(async () => null);
    const job = jobRow({ kind: "ghost.job", attempts: 6, max_attempts: 6 });
    claimIgnoringKinds(job);
    const summary = await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    expect(finishCalls()).toEqual([
      expect.objectContaining({ p_outcome: "dead", p_error: 'retryable: no handler registered for job kind "ghost.job"', p_retry_at: null })
    ]);
    expect(opsKeys()).toEqual(["job-dead:ghost.job"]);
    expect(vi.mocked(notifyOps).mock.calls[0][0].detail).toContain(`job ${job.id}`);
    expect(summary).toMatchObject({ dead: 1 });
  });

  it("decides a missing handler without looking the principal up", async () => {
    handler(async () => null);
    claimIgnoringKinds(jobRow({ kind: "ghost.job", principal_id: "ep_1" }));
    await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    expect(loadPrincipalById).not.toHaveBeenCalled();
    expect(heartbeatCalls()).toEqual([]);
    expect(finishCalls()[0]).toMatchObject({ p_outcome: "retry" });
  });
});

describe("runWorkerPass: failures", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  it("retries a retryable error with exponential backoff", async () => {
    queue(jobRow({ attempts: 1 }), jobRow({ attempts: 3 }));
    handler(async () => {
      throw Object.assign(new Error("upstream overloaded"), { status: 529 });
    });
    const summary = await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    const byAttempt = new Map(finishCalls().map((c) => [c.p_attempt, c]));
    expect(byAttempt.get(1)).toMatchObject({
      p_outcome: "retry",
      p_error: "retryable: upstream overloaded",
      p_retry_at: new Date(NOW.getTime() + 30_000).toISOString(),
      p_result: null
    });
    expect(byAttempt.get(3)).toMatchObject({ p_outcome: "retry", p_retry_at: new Date(NOW.getTime() + 120_000).toISOString() });
    expect(summary).toMatchObject({ claimed: 2, retried: 2 });
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("waits at least as long as an upstream Retry-After hint, capped at an hour", async () => {
    queue(jobRow({ attempts: 1 }), jobRow({ attempts: 2 }));
    handler(async (ctx) => {
      const retryAfterMs = ctx.job.attempts === 1 ? 120_000 : 5 * 3_600_000;
      throw Object.assign(new Error("rate limited"), { status: 429, retryAfterMs });
    });
    await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    const byAttempt = new Map(finishCalls().map((c) => [c.p_attempt, c.p_retry_at]));
    expect(byAttempt.get(1)).toBe(new Date(NOW.getTime() + 120_000).toISOString());
    expect(byAttempt.get(2)).toBe(new Date(NOW.getTime() + 3_600_000).toISOString());
  });

  it("dead-letters a retryable error on the last attempt", async () => {
    queue(jobRow({ attempts: 6, max_attempts: 6 }));
    handler(async () => {
      throw new Error("still failing");
    });
    const summary = await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    expect(finishCalls()).toEqual([expect.objectContaining({ p_outcome: "dead", p_error: "retryable: still failing", p_retry_at: null })]);
    expect(opsKeys()).toEqual(["job-dead:test.job"]);
    expect(summary).toMatchObject({ dead: 1 });
  });

  it("dead-letters a fatal error at once with one ops alert", async () => {
    queue(jobRow({ attempts: 1 }));
    handler(async () => {
      throw Object.assign(new Error("invalid_request_error: bad schema"), { status: 400 });
    });
    const summary = await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    expect(finishCalls()).toEqual([expect.objectContaining({ p_outcome: "dead", p_error: "fatal: invalid_request_error: bad schema" })]);
    expect(opsKeys()).toEqual(["job-dead:test.job"]);
    expect(summary).toMatchObject({ dead: 1, retried: 0 });
  });

  it("dead-letters an auth error with a dead-letter alert AND an auth alert", async () => {
    queue(jobRow({ attempts: 1 }));
    handler(async () => {
      throw Object.assign(new Error("invalid_auth"), { status: 401 });
    });
    await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    expect(finishCalls()[0]).toMatchObject({ p_outcome: "dead", p_error: "auth: invalid_auth" });
    expect(opsKeys()).toEqual(["job-dead:test.job", "auth:test.job"]);
  });

  it("treats NonRetryableError as fatal, or auth when it says so", async () => {
    queue(jobRow({ kind: "a.job" }), jobRow({ kind: "b.job" }));
    handler(
      async () => {
        throw new NonRetryableError("thread is not in the principal's mailbox");
      },
      { kind: "a.job" }
    );
    handler(
      async () => {
        throw new NonRetryableError("slack token revoked", "auth");
      },
      { kind: "b.job" }
    );
    await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    const byKind = new Map(db.rpcCalls.filter((c) => c.fn === "exec_finish_job").map((c) => [c.args.p_id, c.args]));
    expect([...byKind.values()].map((c) => c.p_outcome)).toEqual(["dead", "dead"]);
    expect(finishCalls().map((c) => c.p_error).sort()).toEqual([
      "auth: NonRetryableError: slack token revoked",
      "fatal: NonRetryableError: thread is not in the principal's mailbox"
    ]);
    expect(opsKeys().sort()).toEqual(["auth:b.job", "job-dead:a.job", "job-dead:b.job"]);
  });

  it("does not retry past the daily AI budget", async () => {
    queue(jobRow({ attempts: 1 }));
    handler(async () => {
      throw new BudgetExceededError(15.4, 15);
    });
    await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    expect(finishCalls()[0]).toMatchObject({ p_outcome: "dead" });
    expect(String(finishCalls()[0].p_error)).toContain("fatal: BudgetExceededError: daily AI cost cap reached");
  });

  it("treats a synchronous throw like a rejection", async () => {
    queue(jobRow({ attempts: 1 }));
    handler((() => {
      throw new Error("sync boom");
    }) as unknown as JobHandler["run"]);
    await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    expect(finishCalls()[0]).toMatchObject({ p_outcome: "retry", p_error: "retryable: sync boom" });
  });

  it("scrubs credentials out of the stored error", async () => {
    queue(jobRow({ attempts: 1 }));
    handler(async () => {
      throw new Error("upstream rejected Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123");
    });
    await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    const stored = String(finishCalls()[0].p_error);
    expect(stored).toContain("[redacted]");
    expect(stored).not.toContain("abcdefghijklmnop");
  });

  it("caps the stored error at 1,000 characters", async () => {
    queue(jobRow({ attempts: 1 }));
    handler(async () => {
      throw new Error("e".repeat(5_000));
    });
    await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    const stored = String(finishCalls()[0].p_error);
    expect(stored.length).toBe(1_000);
    expect(stored.endsWith("…")).toBe(true);
  });

  it("never splits a surrogate pair when it cuts the stored error", async () => {
    queue(jobRow({ attempts: 1 }));
    // "retryable: " is 11 characters, so the emoji's high half lands on the last kept index.
    handler(async () => {
      throw new Error(`${"a".repeat(987)}😀${"b".repeat(100)}`);
    });
    await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    const stored = String(finishCalls()[0].p_error);
    expect(stored.length).toBe(999);
    expect(stored.endsWith("a…")).toBe(true);
    expect(stored).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it.each<[string, unknown, string]>([
    ["a thrown string", "upstream said no", "retryable: upstream said no"],
    ["a thrown plain object", { message: "postgrest: connection reset", code: "PGRST000" }, "retryable: postgrest: connection reset"],
    ["a value whose toString throws", { [Symbol.toPrimitive]: () => { throw new Error("no"); } }, "retryable: non-Error value thrown"]
  ])("describes %s in the stored error", async (_label, thrown, expected) => {
    queue(jobRow({ attempts: 1 }));
    handler(async () => {
      throw thrown;
    });
    await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    expect(finishCalls()[0]).toMatchObject({ p_outcome: "retry", p_error: expected });
  });

  it("counts a retry whose finish fails as finishFailed", async () => {
    db.rpc.set("exec_finish_job", () => ({ data: null, error: { message: "timeout" } }));
    queue(jobRow({ attempts: 1 }));
    handler(async () => {
      throw new Error("transient");
    });
    await expect(runWorkerPass({ lane: "bulk", awaitCompletion: true })).resolves.toMatchObject({ retried: 0, finishFailed: 1 });
  });

  it("counts a cancel whose finish fails as finishFailed", async () => {
    db.rpc.set("exec_finish_job", () => ({ data: false, error: null }));
    vi.mocked(loadPrincipalById).mockResolvedValue(null);
    queue(jobRow({ principal_id: "ep_9" }));
    handler(async () => null);
    await expect(runWorkerPass({ lane: "bulk", awaitCompletion: true })).resolves.toMatchObject({ cancelled: 0, finishFailed: 1 });
  });

  it("logs a failed finish instead of throwing, and frees the slot", async () => {
    db.rpc.set("exec_finish_job", () => ({ data: null, error: { message: "statement timeout" } }));
    queue(jobRow());
    handler(async () => "ok");
    const summary = await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    expect(summary).toMatchObject({ succeeded: 0, finishFailed: 1 });
    expect(jobsInFlight().bulk).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("the reaper requeues it once the lease expires: statement timeout"));
  });

  it("logs a finish that throws", async () => {
    db.rpc.set("exec_finish_job", () => {
      throw new Error("fetch failed");
    });
    queue(jobRow());
    handler(async () => "ok");
    const summary = await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    expect(summary).toMatchObject({ finishFailed: 1 });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("fetch failed"));
  });

  it("reports a fenced-off finish (lease gone) and sends no alert", async () => {
    db.rpc.set("exec_finish_job", () => ({ data: false, error: null }));
    queue(jobRow());
    handler(async () => {
      throw Object.assign(new Error("bad"), { status: 400 });
    });
    const summary = await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    expect(summary).toMatchObject({ dead: 0, finishFailed: 1 });
    expect(notifyOps).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("the lease is gone"));
  });

  it("keeps the dead-letter when ops alerting itself throws", async () => {
    vi.mocked(notifyOps).mockRejectedValue(new Error("slack down"));
    queue(jobRow());
    handler(async () => {
      throw Object.assign(new Error("bad"), { status: 422 });
    });
    const summary = await runWorkerPass({ lane: "bulk", awaitCompletion: true });
    expect(summary).toMatchObject({ dead: 1 });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("ops alert job-dead:test.job failed: slack down"));
  });
});

describe("runWorkerPass: leases and timeouts", () => {
  beforeEach(() => {
    // performance too: the runner's lease clock reads performance.now().
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    vi.setSystemTime(NOW);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  const neverSettles = () => new Promise<never>(() => {});
  const rejectOnAbort = (signal: AbortSignal) =>
    new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  const heartbeatRequests = () => db.rpcCalls.filter((c) => c.fn === "exec_heartbeat_job");
  const warnings = () => vi.mocked(console.warn).mock.calls.map(([line]) => String(line));

  it("heartbeats every min(30 s, lease/3) while the handler runs, then clears its timers", async () => {
    queue(jobRow({ attempts: 2 }));
    handler(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 65_000)), { timeoutMs: 120_000 });
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(65_000);
    const summary = await pass;
    expect(heartbeatCalls()).toHaveLength(2); // at 30 s and 60 s
    expect(heartbeatCalls()[0]).toEqual({ p_id: expect.any(Number), p_worker: WORKER_ID, p_attempt: 2, p_lease_seconds: 120 });
    // Each renewal can be cut off (see "cuts off a heartbeat that never answers").
    expect(heartbeatRequests().every((c) => c.signal instanceof AbortSignal)).toBe(true);
    expect(summary).toMatchObject({ succeeded: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("heartbeats faster for a short lease", async () => {
    queue(jobRow());
    handler(() => new Promise((resolve) => setTimeout(resolve, 6_500)));
    const pass = runWorkerPass({ lane: "bulk", leaseSeconds: 9, awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(6_500);
    await pass;
    expect(heartbeatCalls()).toHaveLength(2); // every 3 s
    expect(heartbeatCalls()[0]).toMatchObject({ p_lease_seconds: 9 });
  });

  it("aborts the handler and records nothing when the lease is lost", async () => {
    db.rpc.set("exec_heartbeat_job", () => ({ data: false, error: null }));
    queue(jobRow());
    let signal: AbortSignal | null = null;
    handler((ctx) => {
      signal = ctx.signal;
      return rejectOnAbort(ctx.signal);
    });
    const pass = runWorkerPass({ lane: "bulk", leaseSeconds: 6, awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(2_000);
    const summary = await pass;
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(((signal as AbortSignal | null)?.reason as Error).name).toBe("LeaseLostError");
    expect(finishCalls()).toEqual([]);
    expect(summary).toMatchObject({ leaseLost: 1, succeeded: 0, retried: 0 });
    expect(jobsInFlight().bulk).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(notifyOps).not.toHaveBeenCalled();
  });

  it("stops waiting on a handler that ignores its signal once the lease is lost", async () => {
    db.rpc.set("exec_heartbeat_job", () => ({ data: false, error: null }));
    queue(jobRow());
    handler(neverSettles);
    const pass = runWorkerPass({ lane: "bulk", leaseSeconds: 6, awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pass).resolves.toMatchObject({ leaseLost: 1 });
    expect(finishCalls()).toEqual([]);
  });

  it("keeps running through a failed or malformed heartbeat", async () => {
    let beat = 0;
    db.rpc.set("exec_heartbeat_job", () => {
      beat += 1;
      return beat === 1 ? { data: null, error: { message: "timeout" } } : { data: null, error: null };
    });
    queue(jobRow());
    handler(() => new Promise((resolve) => setTimeout(() => resolve("done"), 65_000)), { timeoutMs: 120_000 });
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(65_000);
    await expect(pass).resolves.toMatchObject({ succeeded: 1, leaseLost: 0 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("heartbeat failed, lease not extended: timeout"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("heartbeat returned null, expected a boolean"));
  });

  it("keeps running when the heartbeat call itself throws", async () => {
    db.rpc.set("exec_heartbeat_job", () => {
      throw new TypeError("fetch failed");
    });
    queue(jobRow());
    handler(() => new Promise((resolve) => setTimeout(() => resolve("done"), 35_000)), { timeoutMs: 120_000 });
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(35_000);
    await expect(pass).resolves.toMatchObject({ succeeded: 1 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("heartbeat failed, lease not extended: TypeError: fetch failed"));
  });

  it("cuts off a slow heartbeat at half the interval, so the next renewal still goes out on time", async () => {
    // Answers after 45 s: far past the 15 s a heartbeat gets (half of 30 s).
    db.rpc.set("exec_heartbeat_job", () => new Promise<FakeResult>((resolve) => setTimeout(() => resolve({ data: true, error: null }), 45_000)));
    queue(jobRow());
    handler(() => new Promise((resolve) => setTimeout(resolve, 95_000)), { timeoutMs: 120_000 });
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(95_000);
    // 95 s is inside the trusted 108 s, so the run still succeeds.
    await expect(pass).resolves.toMatchObject({ succeeded: 1, leaseLost: 0 });
    // Sent at 30, 60 and 90 s; none of them blocked the next one.
    expect(heartbeatCalls()).toHaveLength(3);
    // Cut off at 45 and 75 s; the one sent at 90 s when the run ended at 95 s.
    expect(heartbeatRequests().map((c) => c.signal?.aborted)).toEqual([true, true, true]);
    expect(warnings().filter((l) => l.includes("heartbeat got no answer within 15000 ms"))).toHaveLength(2);
    // The late answers land on nothing: no renewal, no new timers, no more beats.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(heartbeatCalls()).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a run whose heartbeats keep failing, before its lease can expire, and records nothing", async () => {
    db.rpc.set("exec_heartbeat_job", () => ({ data: null, error: { message: "upstream connect error" } }));
    queue(jobRow());
    let signal: AbortSignal | null = null;
    handler(
      (ctx) => {
        signal = ctx.signal;
        return rejectOnAbort(ctx.signal);
      },
      { timeoutMs: 600_000 }
    );
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    // A 120 s lease is trusted for 108 s after the claim was sent.
    await vi.advanceTimersByTimeAsync(107_999);
    expect((signal as AbortSignal | null)?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    const summary = await pass;
    const reason = (signal as AbortSignal | null)?.reason as Error;
    expect(reason.name).toBe("LeaseLostError");
    expect(reason.message).toContain("no renewal confirmed within 108000 ms of the last one (lease 120 s)");
    expect(heartbeatCalls()).toHaveLength(3); // 30, 60 and 90 s, all failed
    expect(finishCalls()).toEqual([]);
    expect(summary).toMatchObject({ leaseLost: 1, succeeded: 0, retried: 0, dead: 0 });
    expect(jobsInFlight().bulk).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(notifyOps).not.toHaveBeenCalled();
    expect(warnings()).toContainEqual(expect.stringContaining("No outcome recorded: the reaper requeues the job"));
  });

  it("cuts off a heartbeat that never answers, then aborts at the lease deadline", async () => {
    db.rpc.set("exec_heartbeat_job", () => new Promise<FakeResult>(() => {}));
    queue(jobRow());
    let signal: AbortSignal | null = null;
    handler(
      (ctx) => {
        signal = ctx.signal;
        return neverSettles(); // ignores its signal, too
      },
      { timeoutMs: 600_000 }
    );
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(108_000);
    expect(((signal as AbortSignal | null)?.reason as Error | undefined)?.name).toBe("LeaseLostError");
    await expect(pass).resolves.toMatchObject({ leaseLost: 1 });
    // A hung request no longer holds back the ones after it: 30, 60 and 90 s all went out.
    expect(heartbeatCalls()).toHaveLength(3);
    expect(heartbeatRequests().every((c) => c.signal?.aborted)).toBe(true);
    expect(finishCalls()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    // Nothing more goes out for an abandoned run.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(heartbeatCalls()).toHaveLength(3);
  });

  it("trusts the lease from the last confirmed heartbeat's send time", async () => {
    let beat = 0;
    db.rpc.set("exec_heartbeat_job", () => {
      beat += 1;
      // The one renewal that works answers 10 s after it was sent.
      if (beat === 1) return new Promise<FakeResult>((resolve) => setTimeout(() => resolve({ data: true, error: null }), 10_000));
      return { data: null, error: { message: "timeout" } };
    });
    queue(jobRow());
    let signal: AbortSignal | null = null;
    handler(
      (ctx) => {
        signal = ctx.signal;
        return rejectOnAbort(ctx.signal);
      },
      { timeoutMs: 600_000 }
    );
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    // Renewed by the beat SENT at 30 s (answered at 40 s), so trusted until
    // 30 + 108 = 138 s: not 108 s, and not 40 + 108 = 148 s.
    await vi.advanceTimersByTimeAsync(137_999);
    expect((signal as AbortSignal | null)?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    await expect(pass).resolves.toMatchObject({ leaseLost: 1 });
    expect(heartbeatCalls()).toHaveLength(4); // 30 (ok), 60, 90, 120 s (failed)
  });

  it("keeps a run alive past its first lease while slow heartbeats keep confirming it", async () => {
    // Every renewal takes 10 s to come back, inside the 15 s it is allowed.
    db.rpc.set("exec_heartbeat_job", () => new Promise<FakeResult>((resolve) => setTimeout(() => resolve({ data: true, error: null }), 10_000)));
    queue(jobRow());
    handler(() => new Promise((resolve) => setTimeout(() => resolve("done"), 200_000)), { timeoutMs: 300_000 });
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(200_000);
    await expect(pass).resolves.toMatchObject({ succeeded: 1, leaseLost: 0 });
    expect(heartbeatCalls()).toHaveLength(6); // 30 … 180 s
    expect(warnings().filter((l) => l.includes("heartbeat"))).toEqual([]);
  });

  it("doesn't start a job whose claim answered too late to trust its lease", async () => {
    // The claim's answer takes 110 s; a 120 s lease is only trusted for 108 s.
    db.rpc.set(
      "exec_claim_jobs",
      () => new Promise<FakeResult>((resolve) => setTimeout(() => resolve({ data: [jobRow({ principal_id: "ep_1" })], error: null }), 110_000))
    );
    const run = vi.fn(async () => "never");
    handler(run);
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(110_000);
    await expect(pass).resolves.toMatchObject({ claimed: 1, leaseLost: 1, running: 0 });
    expect(run).not.toHaveBeenCalled();
    expect(loadPrincipalById).not.toHaveBeenCalled();
    expect(heartbeatCalls()).toEqual([]);
    expect(finishCalls()).toEqual([]);
    expect(jobsInFlight().bulk).toBe(0);
    expect(warnings()).toContainEqual(expect.stringContaining("the claim took 110000 ms to answer, too long to trust its 120 s lease"));
  });

  it("renews sooner after a slow claim: the first heartbeat is due 30 s after the claim was sent", async () => {
    db.rpc.set(
      "exec_claim_jobs",
      () => new Promise<FakeResult>((resolve) => setTimeout(() => resolve({ data: [jobRow()], error: null }), 20_000))
    );
    handler(() => new Promise((resolve) => setTimeout(() => resolve("done"), 15_000)));
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(heartbeatCalls()).toHaveLength(1); // at 30 s, 10 s into the run
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pass).resolves.toMatchObject({ succeeded: 1 });
  });

  it("cuts off a heartbeat still waiting for its answer when the run ends", async () => {
    db.rpc.set("exec_heartbeat_job", () => new Promise<FakeResult>(() => {}));
    queue(jobRow());
    handler(() => new Promise((resolve) => setTimeout(() => resolve("done"), 35_000)));
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(35_000);
    await expect(pass).resolves.toMatchObject({ succeeded: 1 });
    expect(heartbeatRequests().map((c) => c.signal?.aborted)).toEqual([true]);
    // The run ended first, which isn't a missed answer.
    expect(warnings().filter((l) => l.includes("no answer"))).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts and retries a job that runs past its timeout", async () => {
    queue(jobRow({ attempts: 1 }));
    let signal: AbortSignal | null = null;
    handler(
      (ctx) => {
        signal = ctx.signal;
        return rejectOnAbort(ctx.signal);
      },
      { timeoutMs: 1_000 }
    );
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(1_000);
    const summary = await pass;
    expect(((signal as AbortSignal | null)?.reason as Error).name).toBe("JobTimeoutError");
    expect(finishCalls()).toEqual([
      expect.objectContaining({
        p_outcome: "retry",
        p_error: "retryable: JobTimeoutError: job timed out after 1000 ms",
        p_retry_at: new Date(NOW.getTime() + 1_000 + 30_000).toISOString()
      })
    ]);
    expect(summary).toMatchObject({ retried: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("frees the slot from a handler that ignores its timeout, and notes when it finally settles", async () => {
    queue(jobRow({ attempts: 1 }));
    const late = deferred<never>();
    handler(() => late.promise, { timeoutMs: 1_000 });
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pass).resolves.toMatchObject({ retried: 1 });
    expect(jobsInFlight().bulk).toBe(0);
    late.reject(new Error("finally gave up"));
    await vi.advanceTimersByTimeAsync(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("abandoned run (timeout) failed later: finally gave up"));
  });

  it("scrubs credentials from a late failure's log line, like every other job error", async () => {
    queue(jobRow({ attempts: 1 }));
    const late = deferred<never>();
    handler(() => late.promise, { timeoutMs: 1_000 });
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(1_000);
    await pass;
    late.reject(new Error("upstream said: Authorization: Bearer xoxb-1234567890-abcdefghij rejected"));
    await vi.advanceTimersByTimeAsync(0);
    const line = warnings().find((l) => l.includes("failed later"));
    expect(line).toBeDefined();
    expect(line).not.toContain("xoxb-1234567890-abcdefghij");
    expect(line).toContain("[redacted]");
  });

  it("notes a handler that ignored its timeout and completed anyway", async () => {
    queue(jobRow({ attempts: 1 }));
    const late = deferred<string>();
    handler(() => late.promise, { timeoutMs: 1_000 });
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pass).resolves.toMatchObject({ retried: 1 });
    late.resolve("sent the reply anyway");
    await vi.advanceTimersByTimeAsync(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("abandoned run (timeout) completed anyway (result discarded)"));
    expect(finishCalls()).toHaveLength(1); // the retry; the late result is never recorded
  });

  it("says nothing more about a handler that stopped when its signal aborted", async () => {
    queue(jobRow({ attempts: 1 }));
    handler((ctx) => rejectOnAbort(ctx.signal), { timeoutMs: 1_000 });
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pass).resolves.toMatchObject({ retried: 1 });
    expect(warnings().filter((l) => l.includes("abandoned run"))).toEqual([]);
  });

  it("dead-letters a timeout on the last attempt", async () => {
    queue(jobRow({ attempts: 6, max_attempts: 6 }));
    handler(neverSettles, { timeoutMs: 500 });
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(500);
    await expect(pass).resolves.toMatchObject({ dead: 1 });
    expect(finishCalls()[0]).toMatchObject({ p_outcome: "dead" });
    expect(opsKeys()).toEqual(["job-dead:test.job"]);
  });

  it("keeps the lease alive while a slow principal lookup runs", async () => {
    vi.mocked(loadPrincipalById).mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(principal), 40_000)));
    queue(jobRow({ principal_id: "ep_1" }));
    let seen: ExecPrincipal | null = null;
    handler(async (ctx) => {
      seen = ctx.principal;
      return "done";
    });
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(40_000);
    await expect(pass).resolves.toMatchObject({ succeeded: 1 });
    expect(heartbeatCalls()).toHaveLength(1); // at 30 s, mid-lookup
    expect(seen).toBe(principal);
  });

  it("times out a hung principal lookup and retries without running the handler", async () => {
    vi.mocked(loadPrincipalById).mockImplementation(() => new Promise(() => {}));
    queue(jobRow({ principal_id: "ep_1", attempts: 1 }));
    const run = vi.fn(async () => "never");
    handler(run, { timeoutMs: 2_000 });
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pass).resolves.toMatchObject({ retried: 1 });
    expect(run).not.toHaveBeenCalled();
    expect(finishCalls()[0]).toMatchObject({ p_outcome: "retry", p_error: "retryable: JobTimeoutError: job timed out after 2000 ms" });
    expect(jobsInFlight().bulk).toBe(0);
  });

  it("drops a cancel for a disabled principal when the lease was lost during the lookup", async () => {
    db.rpc.set("exec_heartbeat_job", () => ({ data: false, error: null }));
    vi.mocked(loadPrincipalById).mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(null), 10_000)));
    queue(jobRow({ principal_id: "ep_1" }));
    handler(async () => "never");
    const pass = runWorkerPass({ lane: "bulk", leaseSeconds: 6, awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pass).resolves.toMatchObject({ leaseLost: 1, cancelled: 0 });
    expect(finishCalls()).toEqual([]);
  });

  it("never starts the handler when the lookup returns a principal after the run timed out", async () => {
    // The lookup outlives the 100 ms timeout. The runner records the retry
    // and frees the slot; the handler must not start once the lookup returns.
    vi.mocked(loadPrincipalById).mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(principal), 300)));
    queue(jobRow({ principal_id: "ep_1", attempts: 1 }));
    const run = vi.fn(async () => "sent");
    handler(run, { timeoutMs: 100 });
    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(100);
    await expect(pass).resolves.toMatchObject({ retried: 1, running: 0 });
    expect(jobsInFlight().bulk).toBe(0);

    await vi.advanceTimersByTimeAsync(200); // the lookup returns now
    expect(run).not.toHaveBeenCalled();
    expect(finishCalls()).toEqual([expect.objectContaining({ p_outcome: "retry", p_error: "retryable: JobTimeoutError: job timed out after 100 ms" })]);
    expect(warnings()).toContainEqual(expect.stringContaining("run abandoned before the handler started (JobTimeoutError: job timed out after 100 ms)"));
    // It stopped as told; no second "abandoned run" line for the same thing.
    expect(warnings().filter((l) => l.includes("abandoned run ("))).toEqual([]);
  });

  it("never starts the handler when the lookup returns a principal after the lease was lost", async () => {
    db.rpc.set("exec_heartbeat_job", () => ({ data: false, error: null }));
    vi.mocked(loadPrincipalById).mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(principal), 3_000)));
    queue(jobRow({ principal_id: "ep_1" }));
    const run = vi.fn(async () => "sent");
    handler(run);
    const pass = runWorkerPass({ lane: "bulk", leaseSeconds: 6, awaitCompletion: true });
    await vi.advanceTimersByTimeAsync(2_000); // heartbeat at 2 s: lease lost
    await expect(pass).resolves.toMatchObject({ leaseLost: 1, running: 0 });

    await vi.advanceTimersByTimeAsync(1_000); // the lookup returns now
    expect(run).not.toHaveBeenCalled();
    expect(finishCalls()).toEqual([]);
    expect(warnings()).toContainEqual(expect.stringContaining("run abandoned before the handler started (LeaseLostError"));
  });
});

describe("runWorkerPass: concurrency and waiting", () => {
  it("claims only into free slots and skips a full lane without a round trip", async () => {
    queue(jobRow(), jobRow(), jobRow(), jobRow(), jobRow());
    const gates = new Map<number, ReturnType<typeof deferred<void>>>();
    handler((ctx) => {
      const gate = deferred<void>();
      gates.set(ctx.job.id, gate);
      return gate.promise;
    });

    const first = await runWorkerPass({ lane: "bulk" });
    expect(first).toMatchObject({ claimed: 2, running: 2 });
    await vi.waitFor(() => expect(gates.size).toBe(2));
    expect(jobsInFlight().bulk).toBe(2);

    await expect(runWorkerPass({ lane: "bulk" })).resolves.toMatchObject({ skipped: "at-capacity", claimed: 0 });
    expect(claimCalls()).toHaveLength(1);

    [...gates.values()][0].resolve();
    await vi.waitFor(() => expect(jobsInFlight().bulk).toBe(1));
    const third = await runWorkerPass({ lane: "bulk" });
    expect(third.claimed).toBe(1);
    expect(claimCalls().map((c) => c.p_limit)).toEqual([2, 1]);

    for (const gate of gates.values()) gate.resolve();
    await vi.waitFor(() => expect(jobsInFlight().bulk).toBe(0));
  });

  it("reserves slots during the claim so a concurrent pass can't over-claim", async () => {
    const claim = deferred<FakeResult>();
    db.rpc.set("exec_claim_jobs", () => claim.promise);
    handler(async () => null);

    const a = runWorkerPass({ lane: "bulk" });
    await vi.waitFor(() => expect(claimCalls()).toHaveLength(1));
    await expect(runWorkerPass({ lane: "bulk" })).resolves.toMatchObject({ skipped: "at-capacity" });
    expect(claimCalls()).toHaveLength(1);
    expect(jobsInFlight().bulk).toBe(2);

    claim.resolve({ data: [jobRow()], error: null });
    await expect(a).resolves.toMatchObject({ claimed: 1 });
    await vi.waitFor(() => expect(jobsInFlight().bulk).toBe(0));
  });

  it("honours an explicit concurrency, including 0", async () => {
    handler(async () => null);
    await expect(runWorkerPass({ lane: "interactive", concurrency: 0 })).resolves.toMatchObject({ skipped: "at-capacity" });
    await runWorkerPass({ lane: "interactive", concurrency: 1 });
    expect(claimCalls()).toEqual([expect.objectContaining({ p_lane: "interactive", p_limit: 1 })]);
  });

  it("keeps each lane's budget separate", async () => {
    queue(jobRow({ lane: "bulk" }), jobRow({ lane: "bulk" }));
    const gate = deferred();
    handler(() => gate.promise);
    await runWorkerPass({ lane: "bulk" });
    await vi.waitFor(() => expect(jobsInFlight().bulk).toBe(2));
    await runWorkerPass({ lane: "interactive" });
    expect(claimCalls().at(-1)).toMatchObject({ p_lane: "interactive", p_limit: 4 });
    gate.resolve();
    await vi.waitFor(() => expect(jobsInFlight().bulk).toBe(0));
  });

  it("with awaitCompletion, stops waiting at the deadline and counts what is still running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    queue(jobRow({ kind: "fast.job" }), jobRow({ kind: "slow.job" }));
    handler(async () => "fast", { kind: "fast.job" });
    handler(() => new Promise((resolve) => setTimeout(() => resolve("slow"), 10_000)), { kind: "slow.job" });

    const pass = runWorkerPass({ lane: "bulk", awaitCompletion: true, deadlineMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pass).resolves.toMatchObject({ claimed: 2, succeeded: 1, running: 1 });
    expect(jobsInFlight().bulk).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(jobsInFlight().bulk).toBe(0);
    expect(finishCalls()).toHaveLength(2);
  });

  it("with a zero deadline, returns right after dispatching", async () => {
    queue(jobRow());
    const gate = deferred();
    handler(() => gate.promise);
    await expect(runWorkerPass({ lane: "bulk", awaitCompletion: true, deadlineMs: 0 })).resolves.toMatchObject({ claimed: 1, running: 1 });
    gate.resolve();
    await vi.waitFor(() => expect(jobsInFlight().bulk).toBe(0));
  });
});

// ---------------------------------------------------------------------------

describe("kickInteractive", () => {
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  };

  it("does nothing while disabled", async () => {
    handler(async () => null);
    vi.stubEnv("EXEC_ENABLED", "false");
    expect(kickInteractive()).toBeUndefined();
    await flush();
    expect(claimCalls()).toEqual([]);
  });

  it("leaves the job for the worker tick, with a warning, until handlers are registered", async () => {
    queue(jobRow({ lane: "interactive" }));
    kickInteractive();
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("interactive kick skipped: no job handlers")));
    expect(claimCalls()).toEqual([]);
    expect(db.queue).toHaveLength(1);
  });

  it("coalesces kicks that arrive before the pass starts", async () => {
    handler(async () => null);
    for (let i = 0; i < 5; i += 1) kickInteractive();
    await flush();
    expect(claimCalls()).toEqual([expect.objectContaining({ p_lane: "interactive" })]);
  });

  it("runs exactly one follow-up pass for kicks that land mid-claim", async () => {
    handler(async () => null);
    const claim = deferred<FakeResult>();
    let calls = 0;
    db.rpc.set("exec_claim_jobs", () => {
      calls += 1;
      return calls === 1 ? claim.promise : { data: [], error: null };
    });
    kickInteractive();
    await vi.waitFor(() => expect(calls).toBe(1));
    kickInteractive();
    kickInteractive();
    kickInteractive();
    claim.resolve({ data: [], error: null });
    await vi.waitFor(() => expect(calls).toBe(2));
    await flush();
    expect(calls).toBe(2);
  });

  it("logs a failed kick and recovers for the next one", async () => {
    handler(async () => null);
    db.rpc.set("exec_claim_jobs", () => ({ data: null, error: { message: "connection refused" } }));
    kickInteractive();
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(expect.stringContaining("interactive kick failed")));
    db.rpc.set("exec_claim_jobs", () => ({ data: [], error: null }));
    kickInteractive();
    await vi.waitFor(() => expect(claimCalls()).toHaveLength(2));
  });

  it("starts the claimed interactive job", async () => {
    queue(jobRow({ lane: "interactive", kind: "test.interactive" }));
    const ran = deferred();
    handler(
      async () => {
        ran.resolve();
      },
      { kind: "test.interactive", lane: "interactive" }
    );
    kickInteractive();
    await ran.promise;
    await vi.waitFor(() => expect(finishCalls()).toEqual([expect.objectContaining({ p_outcome: "succeeded" })]));
  });
});

// ---------------------------------------------------------------------------

describe("reapExpiredLeases", () => {
  it("returns the RPC's count", async () => {
    db.rpc.set("exec_reap_expired_leases", () => ({ data: 3, error: null }));
    await expect(reapExpiredLeases()).resolves.toBe(3);
    db.rpc.set("exec_reap_expired_leases", () => ({ data: "4", error: null }));
    await expect(reapExpiredLeases()).resolves.toBe(4);
    db.rpc.set("exec_reap_expired_leases", () => ({ data: null, error: null }));
    await expect(reapExpiredLeases()).resolves.toBe(0);
    expect(callsTo("exec_reap_expired_leases")).toEqual([{}, {}, {}]);
  });

  it("throws on an RPC error", async () => {
    db.rpc.set("exec_reap_expired_leases", () => ({ data: null, error: { message: "permission denied" } }));
    await expect(reapExpiredLeases()).rejects.toThrow("exec_reap_expired_leases failed: permission denied");
  });
});

describe("purgeFinishedJobs", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  it("deletes only finished rows older than the cutoff and returns the count", async () => {
    db.deleteResult = () => ({ count: 12, error: null });
    const signal = new AbortController().signal;
    await expect(purgeFinishedJobs(14, signal)).resolves.toBe(12);
    expect(db.deletes).toEqual([
      {
        table: "exec_jobs",
        opts: { count: "exact" },
        filters: [
          ["in", "status", ["succeeded", "dead", "cancelled"]],
          ["lt", "finished_at", "2026-10-21T12:00:00.000Z"]
        ],
        signal
      }
    ]);
  });

  it("returns 0 when PostgREST gives no count, and works without a signal", async () => {
    db.deleteResult = () => ({ count: null, error: null });
    await expect(purgeFinishedJobs(1)).resolves.toBe(0);
    expect(db.deletes[0].signal).toBeNull();
  });

  it("rejects a retention under a day", async () => {
    for (const days of [0, 0.5, -1, Number.NaN]) await expect(purgeFinishedJobs(days)).rejects.toThrow(/at least 1/);
    expect(db.deletes).toEqual([]);
  });

  it("throws on a delete error", async () => {
    db.deleteResult = () => ({ count: null, error: { message: "canceling statement due to statement timeout" } });
    await expect(purgeFinishedJobs(14)).rejects.toThrow("exec_jobs purge failed: canceling statement due to statement timeout");
  });
});

// ---------------------------------------------------------------------------
// P9 F18 (contract §1, lead decision L1): a kind this process can't run is left out of p_kinds, so it stays queued
// for a process that can (the two draft kinds need the EA token).
// ---------------------------------------------------------------------------

describe("P9 F18 claimable kinds", () => {
  it("JC01 the real draft handlers: EA token unset → p_kinds lacks exec.draft-generate and exec.draft-reconcile; set → both there", async () => {
    handler(async () => null);
    registerJobHandler(draftGenerateJobHandler);
    registerJobHandler(draftReconcileJobHandler);
    vi.stubEnv("MISSIVE_EA_TOKEN", "");
    await runWorkerPass({ lane: "interactive" });
    vi.stubEnv("MISSIVE_EA_TOKEN", "   ");
    await runWorkerPass({ lane: "bulk" });
    vi.stubEnv("MISSIVE_EA_TOKEN", "an-ea-draft-token");
    await runWorkerPass({ lane: "bulk" });
    expect(claimCalls().map((c) => c.p_kinds)).toEqual([
      ["test.job"],
      ["test.job"],
      ["test.job", "exec.draft-generate", "exec.draft-reconcile"]
    ]);
    expect(claimableJobKinds()).toEqual(["test.job", "exec.draft-generate", "exec.draft-reconcile"]);
  });

  it("JC02 a queued draft job stays queued on a process without the token: nothing claimed, no attempt spent, no outcome", async () => {
    registerJobHandler(draftGenerateJobHandler);
    handler(async () => null, { lane: "interactive" });
    vi.stubEnv("MISSIVE_EA_TOKEN", "");
    const [draftJob] = queue(jobRow({ kind: "exec.draft-generate", lane: "interactive" }));
    const pass = await runWorkerPass({ lane: "interactive", awaitCompletion: true });
    expect(pass).toMatchObject({ skipped: null, claimed: 0 });
    expect(db.queue).toEqual([draftJob]);
    expect(finishCalls()).toEqual([]);
  });

  it("JC03 claimable absent = claimable; false = left out; a throw = left out, logged by kind and error name only", async () => {
    handler(async () => null);
    handler(async () => null, { kind: "never.job", claimable: () => false });
    const secret = new TypeError("token sk-live-0123456789 leaked into a message");
    handler(async () => null, { kind: "throws.job", claimable: () => { throw secret; } });
    handler(async () => null, { kind: "odd.job", claimable: () => "yes" as unknown as boolean });
    await runWorkerPass({ lane: "bulk" });
    expect(claimCalls()[0].p_kinds).toEqual(["test.job"]);
    const warned = vi.mocked(console.warn).mock.calls.map((c) => c.map(String).join(" "));
    expect(warned).toContain("[exec-jobs] throws.job: claimable() threw (TypeError); not claiming it this pass");
    expect(warned.join("\n")).not.toContain("sk-live");
  });

  it("JC04 no claimable kind left → skipped no-handlers, no claim RPC, no slot reserved", async () => {
    handler(async () => null, { claimable: () => false });
    await expect(runWorkerPass({ lane: "bulk" })).resolves.toMatchObject({ skipped: "no-handlers", claimed: 0 });
    expect(claimCalls()).toEqual([]);
    expect(jobsInFlight()).toEqual({ interactive: 0, bulk: 0 });
  });

  it("JC05 registration refuses a claimable that isn't a function", () => {
    expect(() => registerJobHandler({ kind: "bad.claim", lane: "bulk", timeoutMs: 1000, run: async () => null, claimable: true as unknown as () => boolean }))
      .toThrow(/claimable must be a function/);
    expect(getJobHandler("bad.claim")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P9 F19 (contract §1, AM-P9-23): the shutdown drain. Once the flag is set a pass claims nothing and a kick is a no-op,
// while runs already claimed finish and record; inFlightCount is what the SIGTERM handler waits on.
// ---------------------------------------------------------------------------

describe("P9 F19 draining", () => {
  it("JD01 after the flag a pass claims nothing (skipped draining) on either lane, and a kick starts no pass", async () => {
    handler(async () => null);
    const [row] = queue(jobRow());
    startExecDraining();
    expect(isExecDraining()).toBe(true);
    await expect(runWorkerPass({ lane: "bulk", awaitCompletion: true })).resolves.toMatchObject({ skipped: "draining", claimed: 0 });
    await expect(runWorkerPass({ lane: "interactive" })).resolves.toMatchObject({ skipped: "draining", claimed: 0 });
    const scheduled = vi.spyOn(globalThis, "setImmediate");
    kickInteractive();
    // The kick returns before scheduling anything: no pass starts at all (not merely one that then claims nothing).
    expect(scheduled).not.toHaveBeenCalled();
    scheduled.mockRestore();
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    expect(claimCalls()).toEqual([]);
    expect(db.queue).toEqual([row]);
    expect(inFlightCount()).toBe(0);
  });

  it("JD02 runs claimed before the flag keep going, finish and record their outcome; inFlightCount drops to 0", async () => {
    const gate = deferred();
    handler(async () => {
      await gate.promise;
      return { done: 1 };
    });
    queue(jobRow(), jobRow());
    const pass = await runWorkerPass({ lane: "bulk" });
    expect(pass).toMatchObject({ claimed: 2, running: 2 });
    expect(inFlightCount()).toBe(2);
    startExecDraining();
    await expect(runWorkerPass({ lane: "bulk" })).resolves.toMatchObject({ skipped: "draining" });
    expect(inFlightCount()).toBe(2);
    gate.resolve();
    await vi.waitFor(() => expect(inFlightCount()).toBe(0));
    expect(finishCalls().map((c) => c.p_outcome)).toEqual(["succeeded", "succeeded"]);
    expect(claimCalls()).toHaveLength(1);
  });

  it("JD03 the flag lives on globalThis under the key cron-bootstrap sets; __resetJobsForTests clears it", () => {
    expect(EXEC_DRAINING_KEY).toBe("__ddExecDraining");
    expect(isExecDraining()).toBe(false);
    Reflect.set(globalThis, EXEC_DRAINING_KEY, true);
    expect(isExecDraining()).toBe(true);
    __resetJobsForTests();
    expect(isExecDraining()).toBe(false);
    expect(Reflect.get(globalThis, EXEC_DRAINING_KEY)).toBeUndefined();
  });
});
