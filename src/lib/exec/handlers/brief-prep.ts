import "server-only";

import { BRIEF_JOB_KINDS, BRIEF_LIMITS } from "@/lib/exec/brief-types";
import { loadSettings } from "@/lib/exec/principal";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import type { SlackIntelState } from "@/lib/exec/slack-intel-types";
import { enqueueSlackSweepNow } from "@/lib/exec/slack-reading";
import { enqueueJob } from "@/lib/exec/jobs";
import { P10_JOB_KINDS } from "@/lib/exec/slack-p10-types";
import { localDateString, parseLocalTime } from "@/lib/exec/time";
import type { JobContext, JobHandler } from "@/lib/exec/types";

// exec.brief-prep (P8 contract §3.13.4, C39; Area C): BRIEF_LIMITS.prepLeadMinutes before the brief, when slackIntelState is
// "ok", P7a's enqueueSlackSweepNow(principal, "brief") so the brief reads a fresh Slack picture. Bulk lane, 15 s. Every
// other state is skipped with its name (a state, never content). Returns codes and a boolean only.
//
// The registration data (§3.6 table) is the stage-0 seed.
//
// P10 (contract §3.8 item 5, C16): with lead counts on, the same run also forces exec.slack-lead-count { reason: "brief" }
// (one per brief local date), so the brief's lead block reads fresh counts. Best effort: a failed enqueue is logged by code.

export const BRIEF_PREP_JOB_KIND = BRIEF_JOB_KINDS.prep;

const pad = (n: number) => String(n).padStart(2, "0");

/** brief_local_time − prepLeadMinutes, clamped to 00:00 (an invalid time stays invalid, so the work is never due). */
export function briefPrepTime(briefLocalTime: string): string {
  const m = parseLocalTime(briefLocalTime);
  if (m === null) return briefLocalTime;
  const at = Math.max(0, m - BRIEF_LIMITS.prepLeadMinutes);
  return `${pad(Math.floor(at / 60))}:${pad(at % 60)}`;
}

export type BriefPrepResult = { skipped: SlackIntelState | "no_principal" | "brief_off" } | { swept: boolean; leads?: boolean };

/** One exec.brief-prep run. `now` is the clock (tests pass one). */
export async function runBriefPrep(ctx: JobContext, now: Date = new Date()): Promise<BriefPrepResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const settings = await loadSettings(principal.id);
  if (settings.briefEnabled !== true) return { skipped: "brief_off" };
  const state = await slackIntelState(principal, settings, { signal: ctx.signal });
  if (state !== "ok") return { skipped: state };
  const swept = await enqueueSlackSweepNow(principal, "brief", now);
  if (settings.slackP10SchemaReady !== true || settings.slackLeadCountsEnabled !== true) return { swept };
  let leads = false;
  try {
    await enqueueJob({
      kind: P10_JOB_KINDS.leadCount,
      lane: "bulk",
      principalId: principal.id,
      payload: { reason: "brief" },
      dedupeKey: `slack-lead-count:${principal.id}:brief:${localDateString(now, principal.briefTimezone)}`,
      maxAttempts: 1
    });
    leads = true;
  } catch (err) {
    console.warn(`[exec-brief] principal ${principal.id} lead_count_not_enqueued (${err instanceof Error ? err.name : "error"})`);
  }
  return { swept, leads };
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
