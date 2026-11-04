import "server-only";

import { syncAttention, type AttentionSyncResult } from "@/lib/exec/attention";
import { DD_ATTENTION_KINDS, produceDdAttention } from "@/lib/exec/producers/dd";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import { NonRetryableError, type JobHandler } from "@/lib/exec/types";

// exec.dd-attention: the 10-minute Needs Attention refresh from DD (plan §7,
// "DD attention refresh"). produceDdAttention recomputes every DD rule, and
// syncAttention reconciles the result with the stored items of source "dd"
// and the DD kinds only, so email and Slack items are never touched.
//
// A failed read throws before the sync starts. Nothing is resolved on a
// partial picture: the items stay as they were and the job retries.

export const DD_ATTENTION_JOB_KIND = "exec.dd-attention";

const DD_ATTENTION_TIMEOUT_MS = 300_000;
const DD_ATTENTION_EVERY_MINUTES = 10;
// Three attempts, then the job is dead and the next bucket's refresh carries
// on; a refresh that keeps failing holds the bulk lane, which the purge (and
// later the brief) shares, for three timeouts at most. They don't fit in one
// bucket: each attempt can run to the 5-minute timeout, with about 30 s and
// 60 s of backoff between them, so a retry can still be running when the next
// bucket's refresh for the same principal starts. Nothing serializes the two
// (exec_claim_jobs leases jobs, not principals). That is safe because
// syncAttention orders overlapping syncs: a row the later refresh has already
// stamped is never written by the earlier one.
const DD_ATTENTION_MAX_ATTEMPTS = 3;

export const ddAttentionJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: DD_ATTENTION_JOB_KIND,
  lane: "bulk",
  timeoutMs: DD_ATTENTION_TIMEOUT_MS,
  run: async ({ principal, signal }): Promise<AttentionSyncResult> => {
    // The scheduler always enqueues this for a principal (a disabled one is
    // cancelled by the runner). A job with none is a bug a retry won't fix.
    if (!principal) throw new NonRetryableError(`${DD_ATTENTION_JOB_KIND}: the job has no principal`);
    // One instant for the whole run: the rules are evaluated, and the items
    // stamped, at the same now.
    const now = new Date();
    const candidates = await produceDdAttention(principal, now, { signal });
    const r = await syncAttention(principal, { source: "dd", kinds: DD_ATTENTION_KINDS }, candidates, now, { signal });
    // Counts only: exec_jobs.result is a summary, never item content.
    return { inserted: r.inserted, updated: r.updated, reopened: r.reopened, resolved: r.resolved, unchanged: r.unchanged };
  }
});

export const ddAttentionScheduledWork: ScheduledWork = Object.freeze<ScheduledWork>({
  kind: DD_ATTENTION_JOB_KIND,
  lane: "bulk",
  cadence: { kind: "interval", minutes: DD_ATTENTION_EVERY_MINUTES },
  maxAttempts: DD_ATTENTION_MAX_ATTEMPTS
});
