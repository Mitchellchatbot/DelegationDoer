import "server-only";

import { purgeFinishedJobs } from "@/lib/exec/jobs";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import type { JobHandler } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// exec.purge: the daily retention sweep for the P2a tables.
//
//   exec_jobs        finished (succeeded / dead / cancelled) more than 14 days ago
//   exec_access_log  older than 90 days (plan §5)
//   exec_audit_log   older than 400 days
//   exec_ai_usage    older than 400 days
//
// The deletes are global, not per principal. Rows with no principal (system
// jobs, access attempts that never resolved to a principal) have to age out
// too. The schedule is per principal (key exec.purge:<principal>:<local date>),
// so with several principals it runs several times a day; every delete is
// idempotent, so the extra runs find nothing to delete.
//
// Later phases add the principal-scoped retention (Slack, email and chat days
// from exec_settings) to this job.

export const PURGE_JOB_KIND = "exec.purge";

export const RETENTION_DAYS = Object.freeze({
  finishedJobs: 14,
  accessLog: 90,
  auditLog: 400,
  aiUsage: 400
});

const PURGE_TIMEOUT_MS = 120_000;
// Local time, in the principal's zone: overnight, clear of the 08:00 brief.
const PURGE_LOCAL_TIME = "03:30";
const DAY_MS = 86_400_000;

export interface PurgeCounts {
  finishedJobs: number;
  accessLog: number;
  auditLog: number;
  aiUsage: number;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function deleteCreatedBefore(table: string, days: number, now: Date, signal?: AbortSignal): Promise<number> {
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  let query = getSupabaseAdmin().from(table).delete({ count: "exact" }).lt("created_at", cutoff);
  if (signal) query = query.abortSignal(signal);
  const { count, error } = await query;
  if (error) throw new Error(`${table} purge failed: ${error.message}`);
  return count ?? 0;
}

/**
 * Run every retention delete and return how many rows each removed.
 *
 * A failing step doesn't stop the others (one broken table must not keep the
 * rest growing), but the run still throws at the end so the job retries and,
 * if the failure persists, dead-letters to ops. An aborted signal (timeout,
 * lost lease) stops it between steps.
 */
export async function runPurge(signal?: AbortSignal, now: Date = new Date()): Promise<PurgeCounts> {
  const counts: PurgeCounts = { finishedJobs: 0, accessLog: 0, auditLog: 0, aiUsage: 0 };
  const steps: readonly [keyof PurgeCounts, () => Promise<number>][] = [
    ["finishedJobs", () => purgeFinishedJobs(RETENTION_DAYS.finishedJobs, signal)],
    ["accessLog", () => deleteCreatedBefore("exec_access_log", RETENTION_DAYS.accessLog, now, signal)],
    ["auditLog", () => deleteCreatedBefore("exec_audit_log", RETENTION_DAYS.auditLog, now, signal)],
    ["aiUsage", () => deleteCreatedBefore("exec_ai_usage", RETENTION_DAYS.aiUsage, now, signal)]
  ];

  const failures: string[] = [];
  for (const [name, step] of steps) {
    signal?.throwIfAborted();
    try {
      counts[name] = await step();
    } catch (err) {
      failures.push(`${name}: ${errMessage(err)}`);
      console.error(`[exec-purge] ${name} step failed: ${errMessage(err)}`);
    }
  }

  console.log(
    `[exec-purge] deleted finishedJobs=${counts.finishedJobs} accessLog=${counts.accessLog} ` +
      `auditLog=${counts.auditLog} aiUsage=${counts.aiUsage}${failures.length > 0 ? ` failed=${failures.length}` : ""}`
  );
  if (failures.length > 0) {
    throw new Error(`exec.purge: ${failures.length} of ${steps.length} steps failed: ${failures.join("; ")}`);
  }
  return counts;
}

export const purgeJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: PURGE_JOB_KIND,
  lane: "bulk",
  timeoutMs: PURGE_TIMEOUT_MS,
  run: ({ signal }) => runPurge(signal)
});

export const purgeScheduledWork: ScheduledWork = Object.freeze<ScheduledWork>({
  kind: PURGE_JOB_KIND,
  lane: "bulk",
  cadence: { kind: "daily", at: () => PURGE_LOCAL_TIME }
});
