import "server-only";

import { BRIEF_OPS } from "@/lib/exec/brief-copy";
import { BRIEF_JOB_KINDS, BRIEF_LIMITS } from "@/lib/exec/brief-types";
import { listReapedJobs } from "@/lib/exec/jobs";
import { notifyOps } from "@/lib/exec/ops";
import type { SystemScheduledWork } from "@/lib/exec/scheduler";
import { intervalBucket } from "@/lib/exec/time";
import { NonRetryableError, type JobContext, type JobHandler } from "@/lib/exec/types";

// exec.ops-watch (P8 contract §3.13.9, C18, M12; Area B; a SYSTEM job, principal_id null): every 15 minutes, dead jobs the
// lease reaper killed in the previous full 15-minute bucket → one notifyOps per kind (BRIEF_OPS.reaped). Ids, kinds and
// counts only.
//
// Why a separate alert: a job the reaper kills (its worker died holding the lease, out of attempts) goes dead in SQL, so the
// runner's own job-dead alert (jobs.ts killJob) never fires for it. Jobs killJob ended carry a different last_error and are
// not counted here (their alert already went out). The window is the bucket BEFORE the payload's, so a reap that lands at
// the bucket's end is in exactly one window; the system job key (exec.ops-watch:system:i<bucket>) makes one run per bucket
// across processes, and notifyOps's 15-minute per-key window keeps a repeat in one process quiet.

export const OPS_WATCH_JOB_KIND = BRIEF_JOB_KINDS.opsWatch;

const BUCKET_MS = BRIEF_LIMITS.opsWatchMinutes * 60_000;
const REAPED_READ_LIMIT = 200;

/** The bucket the payload names (the dedupe key's), or a NonRetryableError: references only, never anything else. */
function payloadBucket(ctx: JobContext): number {
  const bucket = (ctx.job.payload as { bucket?: unknown } | null)?.bucket;
  if (typeof bucket !== "number" || !Number.isSafeInteger(bucket) || bucket < 1) throw new NonRetryableError("bad_payload");
  return bucket;
}

async function runOpsWatch(ctx: JobContext): Promise<Record<string, unknown>> {
  const bucket = payloadBucket(ctx);
  const toMs = bucket * BUCKET_MS;
  const fromMs = toMs - BUCKET_MS;
  const rows = await listReapedJobs(new Date(fromMs).toISOString(), new Date(toMs).toISOString(), REAPED_READ_LIMIT);
  const byKind = new Map<string, { count: number; firstId: number }>();
  for (const row of rows) {
    const seen = byKind.get(row.kind);
    if (seen) seen.count += 1;
    else byKind.set(row.kind, { count: 1, firstId: row.id });
  }
  for (const [kind, { count, firstId }] of byKind) {
    await notifyOps({ key: BRIEF_OPS.reaped.key(kind), title: BRIEF_OPS.reaped.title, detail: `${kind}: ${count} job(s), first ${firstId}` });
  }
  return { bucket, reaped: rows.length, kinds: byKind.size };
}

export const opsWatchJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: OPS_WATCH_JOB_KIND,
  lane: "bulk",
  timeoutMs: BRIEF_LIMITS.opsWatchTimeoutMs,
  run: (ctx) => runOpsWatch(ctx)
});

/** §3.6: system work, interval 15 minutes, payload { bucket } (the bucket the dedupe key names), maxAttempts 1. */
export const opsWatchSystemWork: SystemScheduledWork = Object.freeze<SystemScheduledWork>({
  kind: OPS_WATCH_JOB_KIND,
  lane: "bulk",
  cadence: { kind: "interval", minutes: BRIEF_LIMITS.opsWatchMinutes },
  payload: (ctx) => ({ bucket: intervalBucket(ctx.now, BRIEF_LIMITS.opsWatchMinutes) }),
  maxAttempts: 1
});
