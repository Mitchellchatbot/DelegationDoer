import "server-only";

import { runDraftGeneration, type GenerationResult } from "@/lib/exec/drafts-generate";
import { DRAFT_JOB_KINDS, DRAFT_LIMITS } from "@/lib/exec/drafts-types";
import { NonRetryableError, type EnqueueJobInput, type ExecPrincipal, type JobContext, type JobHandler } from "@/lib/exec/types";

// exec.draft-generate (P4 contract §3.11; Area C): interactive lane, 150 s
// (the model call has its own 120 s deadline, C72), one attempt (L6), enqueued
// by create/regenerate with payload { draftId, seq } and dedupe key
// draft-gen:<p>:<draftId>:s<seq>. The handler is thin: the body lives in
// drafts-generate.ts and never throws for a content outcome (C55); what the
// job returns is ids, a code and a cost. Registered in runtime.ts by Area D (Y5).

/** 150 000 ms: the job's hard ceiling (the model call's own deadline is DRAFT_LIMITS.generationDeadlineMs). */
export const DRAFT_GENERATE_TIMEOUT_MS = DRAFT_LIMITS.generationDeadlineMs + 30_000;

const KIND = DRAFT_JOB_KINDS.generate;
const DRAFT_ID_RE = /^ed_[0-9a-f]{32}$/;

export interface DraftGeneratePayload { draftId: string; seq: number }

/** { draftId, seq } as draftGenerateJob wrote it; null for anything else. */
export function parseDraftGeneratePayload(raw: unknown): DraftGeneratePayload | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { draftId, seq } = raw as { draftId?: unknown; seq?: unknown };
  if (typeof draftId !== "string" || !DRAFT_ID_RE.test(draftId)) return null;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return null;
  return { draftId, seq };
}

async function runGenerate(ctx: JobContext): Promise<GenerationResult> {
  const { job, principal, signal } = ctx;
  if (!principal) throw new NonRetryableError(`${KIND}: job ${job.id} has no principal`);
  const payload = parseDraftGeneratePayload(job.payload);
  if (payload === null) throw new NonRetryableError(`${KIND}: job ${job.id} has a malformed payload`);
  return runDraftGeneration({ principal, draftId: payload.draftId, seq: payload.seq, signal });
}

export const draftGenerateJobHandler: JobHandler = {
  kind: KIND,
  lane: "interactive",
  timeoutMs: DRAFT_GENERATE_TIMEOUT_MS,
  run: (ctx: JobContext) => runGenerate(ctx)
};

/** The enqueue input for one generation request (T01, T04, T10-T12): references only. */
export function draftGenerateJob(principal: ExecPrincipal, draftId: string, seq: number): EnqueueJobInput {
  if (typeof draftId !== "string" || !DRAFT_ID_RE.test(draftId)) throw new NonRetryableError(`${KIND}: the draft id is malformed`);
  if (!Number.isInteger(seq) || seq < 1) throw new NonRetryableError(`${KIND}: the generation seq must be a positive integer`);
  return {
    kind: KIND,
    lane: "interactive",
    principalId: principal.id,
    payload: { draftId, seq },
    dedupeKey: `draft-gen:${principal.id}:${draftId}:s${seq}`,
    maxAttempts: 1
  };
}
