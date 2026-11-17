import "server-only";

import { P10_JOB_KINDS, P10_LIMITS, type ReplyGeneratePayload } from "@/lib/exec/slack-p10-types";
import { generateSlackReply } from "@/lib/exec/slack-reply-generate";
import { NonRetryableError, type JobContext, type JobHandler } from "@/lib/exec/types";

// exec.slack-rdraft-generate (P10 contract §3.5.9; Area C): interactive lane, 90 s, maxAttempts 1, key
// srd-gen:<p>:<id>:s<seq>, payload { draft_id, seq } (ReplyGeneratePayload) → generateSlackReply. Enqueued only by
// enqueueReplyGeneration (slack-reply-create.ts). The body never throws for a content outcome (every outcome is written through
// RPC 15); only the job's own abort propagates. The result carries ids, a code and a cost only (B-P10-6).

const DRAFT_ID = /^esr_[0-9a-f]{32}$/;

/** { draft_id, seq } as enqueueReplyGeneration wrote it; null for anything else. */
export function parseReplyGeneratePayload(raw: unknown): ReplyGeneratePayload | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.draft_id !== "string" || !DRAFT_ID.test(p.draft_id)) return null;
  if (typeof p.seq !== "number" || !Number.isInteger(p.seq) || p.seq < 1 || p.seq > 1000) return null;
  return { draft_id: p.draft_id, seq: p.seq };
}

async function runGenerate(ctx: JobContext): Promise<{ draftId: string; outcome: string; error?: string; costUsd?: number }> {
  const { job, principal, signal } = ctx;
  if (!principal) throw new NonRetryableError(`${P10_JOB_KINDS.replyGenerate}: job ${job.id} has no principal`);
  const payload = parseReplyGeneratePayload(job.payload);
  if (payload === null) throw new NonRetryableError(`${P10_JOB_KINDS.replyGenerate}: job ${job.id} has a malformed payload`);
  const r = await generateSlackReply(principal, payload.draft_id, payload.seq, { signal, now: new Date() });
  return {
    draftId: payload.draft_id,
    outcome: r.outcome,
    ...(typeof r.error === "string" ? { error: r.error } : {}),
    ...(typeof r.costUsd === "number" ? { costUsd: r.costUsd } : {})
  };
}

export const slackRdraftGenerateJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: P10_JOB_KINDS.replyGenerate,
  lane: "interactive",
  timeoutMs: P10_LIMITS.replyGenerateTimeoutMs,
  run: (ctx) => runGenerate(ctx)
});
