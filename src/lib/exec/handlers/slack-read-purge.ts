import "server-only";

import { auditEvent } from "@/lib/exec/audit";
import { enqueueJob } from "@/lib/exec/jobs";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import { readErrLabel } from "@/lib/exec/slack-read";
import { listRevokedReadingInstallations } from "@/lib/exec/slack-install";
import { purgeReading } from "@/lib/exec/slack-read-store";
import { SLACK_READ_JOB_KINDS, SLACK_READ_LIMITS } from "@/lib/exec/slack-read-types";
import { SLACK_RE } from "@/lib/exec/slack-types";
import { NonRetryableError, type JobContext, type JobHandler } from "@/lib/exec/types";

// The reading purges (P7a contract §3.11.9-10, N13, M10; Area D).
//
// exec.slack-read-purge (system job, principal null; bulk, 120 s, six
//   attempts): RPC 14 deletes every reading row of one installation (channels,
//   threads, messages, items, markers, Slack attention rows, reading events)
//   and stamps reading_purged_at. Idempotent: a second purge deletes nothing.
//   Enqueued by v2 on app_uninstalled, by P6's uninstall purge (first, before
//   P6's own) and by the daily recheck. The P7a schema missing → dead.
// exec.slack-read-recheck (bulk, 60 s, two attempts; daily at 04:20 local):
//   the backstop for a purge that never ran (an exhausted job, a lost event).
//   Its listing is GLOBAL: every revoked installation still holding reading
//   data, whichever principal it belongs to (a disabled principal's included,
//   N13/M10). Each gets a principal-null purge job keyed by installation and
//   UTC date, so two principals' ticks the same day enqueue one job per
//   installation. P8 moves it to its system scheduler unchanged.
// The audit row carries ids, the reason and counts only.

const PURGE_KIND = SLACK_READ_JOB_KINDS.readPurge;
const RECHECK_KIND = SLACK_READ_JOB_KINDS.recheck;
const REASONS = new Set(["app_uninstalled", "recheck", "uninstall_job"]);

export type SlackReadPurgeResult = Record<string, number>;
export type SlackReadRecheckResult = { skipped: string } | { enqueued: number; listed: number };

function parsePayload(raw: unknown): { installationId: string; reason: "app_uninstalled" | "recheck" | "uninstall_job" } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.installation_id !== "string" || !SLACK_RE.installationId.test(p.installation_id)) return null;
  if (typeof p.reason !== "string" || !REASONS.has(p.reason)) return null;
  return { installationId: p.installation_id, reason: p.reason as "app_uninstalled" | "recheck" | "uninstall_job" };
}

/** Counts only: keys a store answer may carry, finite numbers. */
function countsOf(raw: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) if (/^[a-z_]{1,40}$/i.test(k) && typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
}

async function runReadPurge(ctx: JobContext): Promise<SlackReadPurgeResult> {
  const p = parsePayload(ctx.job.payload);
  if (!p) throw new NonRetryableError("bad payload");
  const raw = await purgeReading(p.installationId);
  if (raw === null) throw new NonRetryableError("not_installed");
  const counts = countsOf(raw);
  await auditEvent(null, {
    actor: "system",
    action: "slack.read_purged",
    target: `exec_slack_installations:${p.installationId}`,
    input: { reason: p.reason, ...counts }
  });
  return counts;
}

/** "YYYY-MM-DD" in UTC: the recheck's per-day key, the same for every principal's tick. */
const utcDate = (now: Date): string => now.toISOString().slice(0, 10);

/** The recheck's purge job for one installation (principal null; one per installation per UTC date). */
export function recheckPurgeJob(installationId: string, now: Date) {
  return {
    kind: PURGE_KIND,
    lane: "bulk" as const,
    principalId: null,
    payload: { installation_id: installationId, reason: "recheck" },
    dedupeKey: `slack-read-purge:${installationId}:recheck:${utcDate(now)}`,
    maxAttempts: 6
  };
}

async function runRecheck(ctx: JobContext): Promise<SlackReadRecheckResult> {
  void ctx;
  const ids = await listRevokedReadingInstallations();
  const now = new Date();
  let enqueued = 0;
  let firstError: unknown = null;
  for (const id of ids) {
    if (!SLACK_RE.installationId.test(id)) continue;
    try {
      if ((await enqueueJob(recheckPurgeJob(id, now))).enqueued) enqueued += 1;
    } catch (err) {
      console.error(`[exec-slack] recheck: purge of ${id} not enqueued (${readErrLabel(err)})`);
      firstError ??= err;
    }
  }
  if (firstError !== null) throw firstError;
  return { enqueued, listed: ids.length };
}

export const SLACK_READ_PURGE_TIMEOUT_MS = SLACK_READ_LIMITS.readPurgeTimeoutMs;
export const SLACK_READ_RECHECK_TIMEOUT_MS = SLACK_READ_LIMITS.recheckTimeoutMs;

export const slackReadPurgeJobHandler: JobHandler = {
  kind: PURGE_KIND,
  lane: "bulk",
  timeoutMs: SLACK_READ_PURGE_TIMEOUT_MS,
  run: (ctx: JobContext) => runReadPurge(ctx)
};

export const slackReadRecheckJobHandler: JobHandler = {
  kind: RECHECK_KIND,
  lane: "bulk",
  timeoutMs: SLACK_READ_RECHECK_TIMEOUT_MS,
  run: (ctx: JobContext) => runRecheck(ctx)
};

/** Daily at 04:20 local of any enabled principal with the P7a schema (the listing itself is global). */
export const slackReadRecheckScheduledWork: ScheduledWork = {
  kind: RECHECK_KIND,
  lane: "bulk",
  cadence: { kind: "daily", at: () => "04:20" },
  enabled: (s) => s.slackReadingSchemaReady,
  maxAttempts: 2
};
