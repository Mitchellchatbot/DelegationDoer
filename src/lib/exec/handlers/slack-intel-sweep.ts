import "server-only";

import { loadSettings } from "@/lib/exec/principal";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import { slackIntelSchemaReady, slackIntelState } from "@/lib/exec/slack-intel-store";
import { SLACK_INTEL_JOB_KINDS, SLACK_INTEL_LIMITS } from "@/lib/exec/slack-intel-types";
import { followSlackPurges } from "@/lib/exec/slack-redact";
import type { JobContext, JobHandler } from "@/lib/exec/types";

// exec.slack-intel-sweep (P7b contract §3.11.4, C32, C33, N13, N20; Area D): the deletion feed. Bulk lane, 90 s, three
// attempts; every 10 minutes while the P7a schema is applied (only that: it removes data, so it runs with reading off,
// paused, revoked or not connected), and kicked after a failed post-finish recheck.
//
//   1  Either schema missing (P7a's settings flag, P7b's tables) or the intel state "not_installed" → skipped, nothing read.
//      Every other state runs the follow-ups: P7a keeps appending to its outbox while reading is paused.
//   2-5 followSlackPurges within a 60 s box: the outbox (an id cursor), the scan arm, the author opt-outs, the backstop.
// A throw (a store or redaction failure) fails the run, so the runner retries; the cursor never moved past the batch.
// The result is counts and a boolean only (§0.3 rule 4/5): no ids, keys, ts values or names.

const KIND = SLACK_INTEL_JOB_KINDS.sweep;
const INTERVAL_MINUTES = 10;
const MAX_ATTEMPTS = 3;
export const SLACK_INTEL_SWEEP_TIMEOUT_MS = 90_000;

export type SlackIntelSweepResult =
  | { skipped: string }
  | { logRows: number; digestsBlanked: number; channelsForgotten: number; redacted: number; rebuildsQueued: number; optoutsActed: boolean };

/** One sweep for the job's principal. `now` is the clock (tests pass one). */
export async function runSlackIntelSweep(ctx: JobContext, now: Date = new Date()): Promise<SlackIntelSweepResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const signal = ctx.signal;
  const settings = await loadSettings(principal.id);
  if (!settings.slackReadingSchemaReady || !(await slackIntelSchemaReady({ signal }))) return { skipped: "not_installed" };
  const state = await slackIntelState(principal, settings, { signal });
  if (state === "not_installed") return { skipped: "not_installed" };
  const r = await followSlackPurges(principal, { now, signal, deadlineMs: SLACK_INTEL_LIMITS.sweepTimeBoxMs });
  return {
    logRows: r.logRows,
    digestsBlanked: r.digestsBlanked,
    channelsForgotten: r.channelsForgotten,
    redacted: r.redacted,
    rebuildsQueued: r.rebuildsQueued,
    optoutsActed: r.optoutsActed
  };
}

export const slackIntelSweepJobHandler: JobHandler = {
  kind: KIND,
  lane: "bulk",
  timeoutMs: SLACK_INTEL_SWEEP_TIMEOUT_MS,
  run: (ctx: JobContext) => runSlackIntelSweep(ctx)
};

/** Every 10 minutes, gated ONLY on the P7a schema (C32, SW05): the deletion follow-ups run with reading off. */
export const slackIntelSweepScheduledWork: ScheduledWork = {
  kind: KIND,
  lane: "bulk",
  cadence: { kind: "interval", minutes: INTERVAL_MINUTES },
  enabled: (s) => s.slackReadingSchemaReady,
  payload: () => ({ reason: "schedule" }),
  maxAttempts: MAX_ATTEMPTS
};
