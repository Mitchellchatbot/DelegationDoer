import "server-only";

import { BRIEF_JOB_KINDS, BRIEF_LIMITS } from "@/lib/exec/brief-types";
import { loadSettings } from "@/lib/exec/principal";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import type { SlackIntelState } from "@/lib/exec/slack-intel-types";
import { enqueueSlackSweepNow } from "@/lib/exec/slack-reading";
import { parseLocalTime } from "@/lib/exec/time";
import type { JobContext, JobHandler } from "@/lib/exec/types";

// exec.brief-prep (P8 contract §3.13.4, C39; Area C): BRIEF_LIMITS.prepLeadMinutes before the brief, when slackIntelState is
// "ok", P7a's enqueueSlackSweepNow(principal, "brief") so the brief reads a fresh Slack picture. Bulk lane, 15 s. Every
// other state is skipped with its name (a state, never content). Returns codes and a boolean only.
//
// The registration data (§3.6 table) is the stage-0 seed.

export const BRIEF_PREP_JOB_KIND = BRIEF_JOB_KINDS.prep;

const pad = (n: number) => String(n).padStart(2, "0");

/** brief_local_time − prepLeadMinutes, clamped to 00:00 (an invalid time stays invalid, so the work is never due). */
export function briefPrepTime(briefLocalTime: string): string {
  const m = parseLocalTime(briefLocalTime);
  if (m === null) return briefLocalTime;
  const at = Math.max(0, m - BRIEF_LIMITS.prepLeadMinutes);
  return `${pad(Math.floor(at / 60))}:${pad(at % 60)}`;
}

export type BriefPrepResult = { skipped: SlackIntelState | "no_principal" | "brief_off" } | { swept: boolean };

/** One exec.brief-prep run. `now` is the clock (tests pass one). */
export async function runBriefPrep(ctx: JobContext, now: Date = new Date()): Promise<BriefPrepResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const settings = await loadSettings(principal.id);
  if (settings.briefEnabled !== true) return { skipped: "brief_off" };
  const state = await slackIntelState(principal, settings, { signal: ctx.signal });
  if (state !== "ok") return { skipped: state };
  return { swept: await enqueueSlackSweepNow(principal, "brief", now) };
}

export const briefPrepJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: BRIEF_PREP_JOB_KIND,
  lane: "bulk",
  timeoutMs: BRIEF_LIMITS.prepTimeoutMs,
  run: (ctx: JobContext) => runBriefPrep(ctx)
});

/** §3.6: daily at brief_local_time − 15 min (clamped to 00:00) in the brief zone, gated on brief_enabled; payload { local_date }. */
export const briefPrepScheduledWork: ScheduledWork = Object.freeze<ScheduledWork>({
  kind: BRIEF_PREP_JOB_KIND,
  lane: "bulk",
  cadence: { kind: "daily", at: (s) => briefPrepTime(s.briefLocalTime) },
  enabled: (s) => s.briefEnabled,
  maxAttempts: 1,
  zone: (p) => p.briefTimezone,
  payload: (_p, ctx) => ({ local_date: ctx.localDate })
});
