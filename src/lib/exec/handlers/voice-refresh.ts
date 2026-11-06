import "server-only";

import { DRAFT_JOB_KINDS } from "@/lib/exec/drafts-types";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import { NonRetryableError, type EnqueueJobInput, type ExecPrincipal, type JobContext, type JobHandler } from "@/lib/exec/types";
import { refreshVoiceProfile, type VoiceRefreshResult } from "@/lib/exec/voice";

// exec.voice-refresh (P4 contract §3.11, §3.10; Area C): the weekly style
// profile rebuild. Bulk lane, 300 s (no new thread read after 230 s, C72), 2
// attempts; weekly on Sunday at 04:00 (after the 03:30 purge), enabled only
// with the drafts schema, drafts, voice and email all on. The scheduler's key
// is exec.voice-refresh:<p>:<YYYY-Www> (§1.3 K10); the lazy first build the
// generation job queues uses exec.voice-refresh:<p>:now:<YYYY-MM-DD>. The job
// returns a status, a sample count and a cost: never sample text or ids.
// Registered in runtime.ts by Area D (Y5).

export const VOICE_REFRESH_TIMEOUT_MS = 300_000;

const KIND = DRAFT_JOB_KINDS.voice;
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function runRefresh(ctx: JobContext): Promise<VoiceRefreshResult> {
  const { job, principal, signal } = ctx;
  if (!principal) throw new NonRetryableError(`${KIND}: job ${job.id} has no principal`);
  return refreshVoiceProfile(principal, { signal });
}

export const voiceRefreshJobHandler: JobHandler = {
  kind: KIND,
  lane: "bulk",
  timeoutMs: VOICE_REFRESH_TIMEOUT_MS,
  run: (ctx: JobContext) => runRefresh(ctx)
};

export const voiceRefreshScheduledWork: ScheduledWork = {
  kind: KIND,
  lane: "bulk",
  cadence: { kind: "weekly", isoWeekday: 7, at: "04:00" },
  enabled: (s) => s.draftsSchemaReady && s.draftsEnabled && s.voiceEnabled && s.emailSchemaReady && s.emailEnabled,
  maxAttempts: 2
};

/** The lazy first build (§3.10 step 11): one job per principal and local day. */
export function voiceRefreshNow(principal: ExecPrincipal, localDate: string): EnqueueJobInput {
  if (typeof localDate !== "string" || !LOCAL_DATE_RE.test(localDate)) throw new NonRetryableError(`${KIND}: the local date must be YYYY-MM-DD`);
  return {
    kind: KIND,
    lane: "bulk",
    principalId: principal.id,
    payload: {},
    dedupeKey: `${KIND}:${principal.id}:now:${localDate}`,
    maxAttempts: 2
  };
}
