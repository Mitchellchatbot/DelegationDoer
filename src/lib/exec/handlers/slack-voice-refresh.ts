import "server-only";

import type { ScheduledWork } from "@/lib/exec/scheduler";
import { P10_JOB_KINDS, P10_LIMITS } from "@/lib/exec/slack-p10-types";
import { refreshSlackVoice } from "@/lib/exec/slack-voice";
import { NonRetryableError, type JobContext, type JobHandler } from "@/lib/exec/types";

// exec.slack-voice-refresh (P10 contract §3.5.6, §3.5.9, C25; Area C): his Slack style profile. Bulk lane, 240 s,
// maxAttempts 1; weekly (Sunday 04:40 local) or lazily (key srd-voice:<p>:<UTC date>, payload { reason: "lazy" }, queued by
// the generation when it finds no fresh profile). The result is a status, a count and a cost (B-P10-6: never a sample).

async function runVoiceRefresh(ctx: JobContext): Promise<{ status: string; samplesUsed: number; costUsd: number | null }> {
  const { job, principal, signal } = ctx;
  if (!principal) throw new NonRetryableError(`${P10_JOB_KINDS.voiceRefresh}: job ${job.id} has no principal`);
  const { status, samples: samplesUsed, costUsd } = await refreshSlackVoice(principal, { signal, now: new Date() });
  return { status, samplesUsed, costUsd };
}

export const slackVoiceRefreshJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: P10_JOB_KINDS.voiceRefresh,
  lane: "bulk",
  timeoutMs: P10_LIMITS.voiceTimeoutMs,
  run: (ctx) => runVoiceRefresh(ctx)
});

/** §3.10: weekly on ISO weekday 7 at 04:40 (principal.timezone), while the P10 schema, replies and style learning are on. */
export const slackVoiceRefreshScheduledWork: ScheduledWork = Object.freeze<ScheduledWork>({
  kind: P10_JOB_KINDS.voiceRefresh,
  lane: "bulk",
  cadence: { kind: "weekly", isoWeekday: P10_LIMITS.voiceIsoWeekday, at: P10_LIMITS.voiceLocalTime },
  enabled: (s) => s.slackP10SchemaReady && s.slackRepliesEnabled && s.slackVoiceEnabled,
  maxAttempts: 1
});
