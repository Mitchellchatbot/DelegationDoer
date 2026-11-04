import "server-only";

import { isExecEnabled } from "@/lib/exec/access";
import { ddAttentionJobHandler, ddAttentionScheduledWork } from "@/lib/exec/handlers/dd-attention";
import { purgeJobHandler, purgeScheduledWork } from "@/lib/exec/handlers/purge";
import { JOB_LANES, getJobHandler, registerJobHandler, runWorkerPass, type WorkerPassSummary } from "@/lib/exec/jobs";
import { getScheduledWork, registerScheduledWork, runSchedulerTick, type ScheduledWork } from "@/lib/exec/scheduler";
import type { JobHandler, JobLane } from "@/lib/exec/types";

// Entry points the schedulers call: cron-bootstrap's exec-worker (10 s) and
// exec-scheduler (60 s) loops on Railway, and /api/cron/exec-tick for an
// external scheduler. Everything here is inert until EXEC_ENABLED=true.
//
// Both kinds of caller can run at once in one process, or in two processes
// during a deploy. That is safe: enqueues are deduped by key, claims are
// leased, and the in-flight limits are shared process-wide (jobs.ts).

const BUILT_IN_HANDLERS: readonly JobHandler[] = [purgeJobHandler, ddAttentionJobHandler];
const BUILT_IN_SCHEDULE: readonly ScheduledWork[] = [purgeScheduledWork, ddAttentionScheduledWork];

// The cron route's whole run has to fit well inside its 60 s maxDuration.
const MAX_CRON_BUDGET_MS = 45_000;

const READY_KEY = "__ddExecRuntimeReady" as const;
type GlobalWithRuntime = typeof globalThis & { [READY_KEY]?: boolean };

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Register the built-in job handlers and scheduled work, once per process
 * (the flag is on globalThis, like the registries it guards). Each one is
 * registered only if its kind is still missing, so a run that failed halfway
 * can be retried without tripping the duplicate checks.
 */
export function ensureExecRuntime(): void {
  const g = globalThis as GlobalWithRuntime;
  if (g[READY_KEY]) return;
  for (const handler of BUILT_IN_HANDLERS) {
    if (!getJobHandler(handler.kind)) registerJobHandler(handler);
  }
  for (const work of BUILT_IN_SCHEDULE) {
    if (!getScheduledWork(work.kind)) registerScheduledWork(work);
  }
  g[READY_KEY] = true;
}

/** Test seam: let ensureExecRuntime register again (pair it with the jobs/scheduler resets). */
export function __resetExecRuntimeForTests(): void {
  delete (globalThis as GlobalWithRuntime)[READY_KEY];
}

/**
 * cron-bootstrap's exec-worker tick: an interactive pass, then a bulk pass,
 * both dispatch-only (jobs keep running after this returns). Returns
 * "disabled", "idle" (nothing claimed) or the claim counts. Throws when a
 * lane's claim failed, after still trying the other lane.
 */
export async function runExecWorkerTick(): Promise<string> {
  if (!isExecEnabled()) return "disabled";
  ensureExecRuntime();

  const claimed: Record<JobLane, number> = { interactive: 0, bulk: 0 };
  const failures: string[] = [];
  for (const lane of JOB_LANES) {
    try {
      claimed[lane] = (await runWorkerPass({ lane })).claimed;
    } catch (err) {
      failures.push(`${lane}: ${errMessage(err)}`);
    }
  }

  const counts = `claimed interactive=${claimed.interactive} bulk=${claimed.bulk}`;
  if (failures.length > 0) throw new Error(`${failures.join("; ")} (${counts})`);
  return claimed.interactive === 0 && claimed.bulk === 0 ? "idle" : counts;
}

/** cron-bootstrap's exec-scheduler tick. Returns "disabled", "idle" or the tick's counts. */
export async function runExecSchedulerTick(): Promise<string> {
  if (!isExecEnabled()) return "disabled";
  ensureExecRuntime();
  return (await runSchedulerTick()).summary;
}

function cronBudgetMs(deadlineMs: number): number {
  if (Number.isNaN(deadlineMs)) return 0;
  return Math.min(MAX_CRON_BUDGET_MS, Math.max(0, deadlineMs));
}

/**
 * /api/cron/exec-tick: one scheduler pass, then both lanes, waiting for the
 * jobs they start until `deadlineMs` (capped at 45 s) has passed since the
 * call began. Jobs still running at the deadline keep running and are
 * reported as `running`; on a host that freezes the process after the
 * response, their leases expire and the reaper requeues them.
 *
 * Never throws for a failed part; `ok` is false and that part carries `error`.
 */
export async function runExecTickForCron(deadlineMs: number): Promise<Record<string, unknown>> {
  if (!isExecEnabled()) return { ok: true, skipped: "disabled" };
  ensureExecRuntime();

  const startedAt = Date.now();
  const budgetMs = cronBudgetMs(deadlineMs);
  let ok = true;

  let scheduler: Record<string, unknown>;
  try {
    const r = await runSchedulerTick();
    scheduler = { principals: r.principals, enqueued: r.enqueued, reaped: r.reaped, summary: r.summary };
  } catch (err) {
    ok = false;
    scheduler = { error: errMessage(err) };
    console.error(`[exec-runtime] cron tick: scheduler failed: ${errMessage(err)}`);
  }

  const remainingMs = Math.max(0, budgetMs - (Date.now() - startedAt));
  const lanes = await Promise.all(
    JOB_LANES.map(async (lane): Promise<WorkerPassSummary | { lane: JobLane; error: string }> => {
      try {
        return await runWorkerPass({ lane, awaitCompletion: true, deadlineMs: remainingMs });
      } catch (err) {
        ok = false;
        console.error(`[exec-runtime] cron tick: ${lane} lane failed: ${errMessage(err)}`);
        return { lane, error: errMessage(err) };
      }
    })
  );

  const out: Record<string, unknown> = { ok, scheduler };
  for (const pass of lanes) out[pass.lane] = pass;
  out.budgetMs = budgetMs;
  out.elapsedMs = Date.now() - startedAt;
  return out;
}
