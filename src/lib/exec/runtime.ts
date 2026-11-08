import "server-only";

import { isExecEnabled } from "@/lib/exec/access";
import { ddAttentionJobHandler, ddAttentionScheduledWork } from "@/lib/exec/handlers/dd-attention";
import { ddtextJobHandler, ddtextScheduledWork } from "@/lib/exec/handlers/ddtext-triage";
import { draftGenerateJobHandler } from "@/lib/exec/handlers/draft-generate";
import { draftReconcileJobHandler, draftReconcileScheduledWork } from "@/lib/exec/handlers/draft-reconcile";
import { emailAttentionJobHandler, emailAttentionScheduledWork } from "@/lib/exec/handlers/email-attention";
import { emailReconcileJobHandler, emailReconcileScheduledWork } from "@/lib/exec/handlers/email-reconcile";
import { emailTriageJobHandler } from "@/lib/exec/handlers/email-triage";
import { purgeJobHandler, purgeScheduledWork } from "@/lib/exec/handlers/purge";
import { slackActionJobHandler } from "@/lib/exec/handlers/slack-action";
import { slackAttentionJobHandler, slackAttentionScheduledWork } from "@/lib/exec/handlers/slack-attention";
import { slackCardJobHandler } from "@/lib/exec/handlers/slack-card";
import { slackClassifyJobHandler } from "@/lib/exec/handlers/slack-classify";
import { slackDiscoverJobHandler, slackDiscoverScheduledWork } from "@/lib/exec/handlers/slack-discover";
import { slackHomeJobHandler } from "@/lib/exec/handlers/slack-home";
import { slackProbeJobHandler, slackProbeScheduledWork } from "@/lib/exec/handlers/slack-probe";
import {
  slackReadPurgeJobHandler,
  slackReadRecheckJobHandler,
  slackReadRecheckScheduledWork
} from "@/lib/exec/handlers/slack-read-purge";
import { slackReadSweepJobHandler, slackReadSweepScheduledWork } from "@/lib/exec/handlers/slack-read-sweep";
import { slackRekeyJobHandler } from "@/lib/exec/handlers/slack-rekey";
import { slackReplyJobHandler } from "@/lib/exec/handlers/slack-reply";
import {
  slackDmPurgeJobHandler,
  slackDmPurgeScheduledWork,
  slackSweepJobHandler,
  slackSweepScheduledWork
} from "@/lib/exec/handlers/slack-sweep";
import { slackTriageJobHandler } from "@/lib/exec/handlers/slack-triage";
import { slackUninstallJobHandler } from "@/lib/exec/handlers/slack-uninstall";
import { slackUserCheckJobHandler } from "@/lib/exec/handlers/slack-user-check";
import { voiceRefreshJobHandler, voiceRefreshScheduledWork } from "@/lib/exec/handlers/voice-refresh";
import { JOB_LANES, getJobHandler, registerJobHandler, runWorkerPass, type WorkerPassSummary } from "@/lib/exec/jobs";
import { ensureMailHook, recordSocketHealth } from "@/lib/exec/mail-hook";
import { getScheduledWork, registerScheduledWork, runSchedulerTick, type ScheduledWork } from "@/lib/exec/scheduler";
import { refreshGateCache } from "@/lib/exec/slack-gate-cache";
import type { JobHandler, JobLane } from "@/lib/exec/types";

// Entry points the schedulers call: cron-bootstrap's exec-worker (10 s) and
// exec-scheduler (60 s) loops on Railway, and /api/cron/exec-tick for an
// external scheduler. Everything here is inert until EXEC_ENABLED=true.
//
// Both kinds of caller can run at once in one process, or in two processes
// during a deploy. That is safe: enqueues are deduped by key, claims are
// leased, and the in-flight limits are shared process-wide (jobs.ts).

// P3 email intelligence: triage (event, reconcile, re-triage), reconcile
// (every 5 minutes, only once email is installed and on) and the attention
// pass (every 10 minutes, ungated: off resolves, not installed skips; L24).
// P4 drafts (contract §3.11, §3.15 Y5): generation (event, interactive), the
// draft reconcile sweep (every 5 minutes while the drafts schema is installed
// and a row is due; kicks run interactive) and the weekly voice refresh.
// P5a DD text triage (contract §3.12.6, K17): its own kind on the same
// 10-minute buckets as the DD attention refresh, bulk lane, ungated (turned
// off, it deletes its own items and attention rows; not installed, it skips).
// P6 Slack (contract §3.11.8, C35): the DM reply, button actions, card
// refreshes, App Home, the uninstall check and purge, the 5-minute stale and
// redaction sweep and the daily DM purge. Registered unconditionally: a
// service without EXEC_TOKEN_KEY fails the jobs with the runner's ops alert.
// Both schedules are gated (Y4 `when`) on an active installation, so a
// principal without Slack enqueues nothing.
// P7a Slack reading (contract §3.11.12): discovery, classify, the sweep, the
// probe, triage, the attention pass, the re-key, the user check, the reading
// purge and its daily recheck. Registered unconditionally (P6 C35); the
// schedules are gated on the P7a schema (and the sweep and probe on the
// reading switch, the probe also on active_public).
const BUILT_IN_HANDLERS: readonly JobHandler[] = [
  purgeJobHandler,
  ddAttentionJobHandler,
  emailTriageJobHandler,
  emailReconcileJobHandler,
  emailAttentionJobHandler,
  draftGenerateJobHandler,
  draftReconcileJobHandler,
  voiceRefreshJobHandler,
  ddtextJobHandler,
  slackReplyJobHandler,
  slackActionJobHandler,
  slackCardJobHandler,
  slackHomeJobHandler,
  slackUninstallJobHandler,
  slackSweepJobHandler,
  slackDmPurgeJobHandler,
  slackDiscoverJobHandler,
  slackClassifyJobHandler,
  slackReadSweepJobHandler,
  slackProbeJobHandler,
  slackTriageJobHandler,
  slackAttentionJobHandler,
  slackRekeyJobHandler,
  slackUserCheckJobHandler,
  slackReadPurgeJobHandler,
  slackReadRecheckJobHandler
];
const BUILT_IN_SCHEDULE: readonly ScheduledWork[] = [
  purgeScheduledWork,
  ddAttentionScheduledWork,
  emailReconcileScheduledWork,
  emailAttentionScheduledWork,
  draftReconcileScheduledWork,
  voiceRefreshScheduledWork,
  ddtextScheduledWork,
  slackSweepScheduledWork,
  slackDmPurgeScheduledWork,
  slackDiscoverScheduledWork,
  slackReadSweepScheduledWork,
  slackProbeScheduledWork,
  slackAttentionScheduledWork,
  slackReadRecheckScheduledWork
];

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
  // The mail hook (L19). Installed here and nowhere else: this tick runs in
  // the instrumentation layer, whose inbox-bus copy the socket bridge
  // publishes into. /api/cron/exec-tick runs in a route bundle whose bus
  // copy only hears webhooks, and ensureExecRuntime's globalThis flag could
  // let that copy claim the install first. Both calls never throw, and the
  // health write is throttled to once a minute.
  ensureMailHook();
  recordSocketHealth();
  // P7a (§3.11.12): the events route's gate cache, refreshed off the ack path. Not awaited, never fails the tick.
  refreshSlackGate();

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

/** The gate-cache refresh, fire-and-forget: a throw (sync or async) is logged by its name only. */
function refreshSlackGate(): void {
  const label = (err: unknown) => (err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "error");
  try {
    void Promise.resolve(refreshGateCache()).catch((err: unknown) => {
      console.warn(`[exec-runtime] slack gate cache refresh failed (${label(err)})`);
    });
  } catch (err) {
    console.warn(`[exec-runtime] slack gate cache refresh failed (${label(err)})`);
  }
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
