import "server-only";

import { runBriefBuild, type BuildResult } from "@/lib/exec/brief-build";
import { BRIEF_OPS } from "@/lib/exec/brief-copy";
import { watchdogRunAfter } from "@/lib/exec/brief-ownership";
import { releaseRegenLock } from "@/lib/exec/brief-store";
import { BRIEF_JOB_KINDS, BRIEF_LIMITS, briefRetryKey } from "@/lib/exec/brief-types";
import type { BriefBuildPayload, BriefTrigger } from "@/lib/exec/brief-types";
import { enqueueJob } from "@/lib/exec/jobs";
import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import { NonRetryableError, type JobContext, type JobHandler } from "@/lib/exec/types";

// exec.brief (P8 contract §3.13.1, M3, C3, C5, C47; Area C): one build of the day's brief (schedule, a pre-model retry, or a
// regenerate the route claimed), interactive lane, maxAttempts 1 (one Opus run per trigger), 240 s. Returns codes only.
//
//   1 the payload, shape-checked (a bad one → NonRetryableError "bad_payload")
//   2 settings; a scheduled or retried build with the brief off → skipped
//   3 runBriefBuild (brief-build.ts)
//   4 a pre-model failure of a schedule/retry build re-enqueues itself (+2 min, :r1 then :r2); the second retry's failure alerts
//     ops; a regenerate that didn't build releases its lock (C47)
//   5 { outcome, status?, mode?, deliver?, checkins? } plus the skip reason or the failure's stage and code
//
// The registration data (§3.6 and §3.13 tables: briefScheduledWork with its zone, payload and the watchdog companion, C3) is the
// stage-0 seed.

export const BRIEF_JOB_KIND = BRIEF_JOB_KINDS.build;

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const BRIEF_ID = /^eb_[0-9a-f]{32}$/;
const TRIGGERS: ReadonlySet<string> = new Set<BriefTrigger>(["schedule", "retry", "regenerate"]);

/** The payload, or null when anything is off (§3.13.1 step 1). */
export function parseBriefPayload(raw: unknown): BriefBuildPayload | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.local_date !== "string" || !LOCAL_DATE.test(p.local_date)) return null;
  if (typeof p.scheduled_at !== "string" || !Number.isFinite(Date.parse(p.scheduled_at))) return null;
  if (typeof p.trigger !== "string" || !TRIGGERS.has(p.trigger)) return null;
  const trigger = p.trigger as BriefTrigger;
  const out: BriefBuildPayload = { local_date: p.local_date, scheduled_at: p.scheduled_at, trigger };
  if (trigger === "retry") {
    if (p.retry !== 1 && p.retry !== 2) return null;
    out.retry = p.retry;
  } else if (p.retry !== undefined) return null;
  if (trigger === "regenerate") {
    if (typeof p.brief_id !== "string" || !BRIEF_ID.test(p.brief_id)) return null;
    if (typeof p.expected_rev !== "number" || !Number.isSafeInteger(p.expected_rev) || p.expected_rev < 1) return null;
    out.brief_id = p.brief_id;
    out.expected_rev = p.expected_rev;
  } else if (p.brief_id !== undefined || p.expected_rev !== undefined) return null;
  return out;
}

export type BriefJobResult =
  | { skipped: "brief_off" | "no_principal" }
  | { outcome: BuildResult["outcome"]; status?: string; mode?: string; deliver?: string | null; checkins?: number; reason?: string;
      stage?: string; code?: string; retry?: number };

/** One exec.brief run. `now` is the clock (tests pass one). */
export async function runBriefJob(ctx: JobContext, now: Date = new Date()): Promise<BriefJobResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const payload = parseBriefPayload(ctx.job.payload);
  if (payload === null) throw new NonRetryableError("bad_payload");
  const settings = await loadSettings(principal.id);
  if (payload.trigger !== "regenerate" && settings.briefEnabled !== true) return { skipped: "brief_off" };

  const regenerate = payload.trigger === "regenerate";
  let r: BuildResult;
  try {
    r = await runBriefBuild({
      principal, settings, localDate: payload.local_date, scheduledAt: new Date(payload.scheduled_at), trigger: payload.trigger,
      claimed: regenerate ? { id: payload.brief_id as string, rev: payload.expected_rev as number } : null,
      dryRun: false, now, signal: ctx.signal
    });
  } catch (err) {
    if (regenerate) await releaseRegenLock(principal, payload.brief_id as string, payload.expected_rev as number);
    throw err;
  }

  if (regenerate && r.outcome !== "built") await releaseRegenLock(principal, payload.brief_id as string, payload.expected_rev as number);

  switch (r.outcome) {
    case "built":
      return { outcome: "built", status: r.status, mode: r.mode, deliver: r.deliver, checkins: r.checkins };
    case "dry_run":
      return { outcome: "dry_run", mode: r.mode };
    case "skipped":
      return { outcome: "skipped", reason: r.reason };
    case "failed": {
      const out: BriefJobResult = { outcome: "failed", stage: r.stage, code: r.code };
      if (r.stage !== "pre_model" || regenerate) return out;
      const n = payload.trigger === "retry" ? (payload.retry ?? 0) : 0;
      if (n < BRIEF_LIMITS.preModelRetries) {
        const next = n + 1;
        try {
          await enqueueJob({
            kind: BRIEF_JOB_KIND, lane: "interactive", principalId: principal.id,
            payload: { local_date: payload.local_date, scheduled_at: payload.scheduled_at, trigger: "retry", retry: next },
            dedupeKey: briefRetryKey(principal.id, payload.local_date, next),
            runAfter: new Date(now.getTime() + BRIEF_LIMITS.preModelRetryDelayMs), maxAttempts: 1
          });
          return { ...out, retry: next };
        } catch (err) {
          console.warn(`[exec-brief] principal ${principal.id} retry_enqueue_failed (${err instanceof Error ? err.name : "error"})`);
        }
      }
      await notifyOps({ key: BRIEF_OPS.failed.key(principal.id), title: BRIEF_OPS.failed.title, detail: `principal ${principal.id}, ${payload.local_date}: ${r.code}` });
      return out;
    }
  }
}

export const briefJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: BRIEF_JOB_KIND,
  lane: "interactive",
  timeoutMs: BRIEF_LIMITS.buildTimeoutMs,
  run: (ctx: JobContext) => runBriefJob(ctx)
});

/** §3.6: daily at brief_local_time in the brief zone, gated on brief_enabled; payload { local_date, scheduled_at: dueAt,
 *  trigger: "schedule" }; the watchdog (exec.brief-fallback) is its companion (C3), runAfter = max(dueAt, now) + 45 min. */
export const briefScheduledWork: ScheduledWork = Object.freeze<ScheduledWork>({
  kind: BRIEF_JOB_KIND,
  lane: "interactive",
  cadence: { kind: "daily", at: (s) => s.briefLocalTime },
  enabled: (s) => s.briefEnabled,
  maxAttempts: 1,
  zone: (p) => p.briefTimezone,
  payload: (_p, ctx) => ({ local_date: ctx.localDate, scheduled_at: ctx.dueAt?.toISOString() ?? null, trigger: "schedule" }),
  companions: (_p, ctx) =>
    ctx.dueAt === null || ctx.localDate === null
      ? []
      : [{
          kind: BRIEF_JOB_KINDS.fallback,
          lane: "interactive",
          runAfter: watchdogRunAfter(ctx.dueAt, ctx.now),
          payload: { local_date: ctx.localDate, scheduled_at: ctx.dueAt.toISOString() },
          maxAttempts: 1
        }]
});
