import "server-only";

import { loadSettings } from "@/lib/exec/principal";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import { buildDigest, runDigestPlan } from "@/lib/exec/slack-digests";
import { slackIntelState } from "@/lib/exec/slack-intel-store";
import { SLACK_INTEL_JOB_KINDS, SLACK_INTEL_LIMITS, type SlackDigestPayload } from "@/lib/exec/slack-intel-types";
import type { JobContext, JobHandler } from "@/lib/exec/types";

// exec.slack-digest and exec.slack-digest-plan (P7b contract §3.11.2–3, N19, N20, C6, C14, C15; Area C). Both run on the
// bulk lane. The handlers are thin: every Slack read, the model call and the store writes live in slack-digests.ts (the
// one P7b file besides slack-search.ts that may read Slack live, B-P7b-7); this file parses the payload, computes the
// intel state (C1: anything but "ok" skips before any read) and returns counts and codes only (§0.3 rule 4).
//
//   exec.slack-digest       120 s, 2 attempts (set at enqueue). Enqueued by the plan, the slack_digest tool, the digest
//                           route, the sweep's rebuilds after deletes and opt-outs, and the plan's nightly retry.
//                           An auth-class Slack answer is rethrown by buildDigest with its errorClass, so it isn't retried.
//   exec.slack-digest-plan  60 s, 2 attempts; daily from 00:30 local while Slack reading is on and its schema is applied:
//                           yesterday for every watched conversation with activity (≤ 60), then the nightly retry.
// runtime.ts registration is Area D's (§3.11.5).

const DIGEST_KIND = SLACK_INTEL_JOB_KINDS.digest;
const PLAN_KIND = SLACK_INTEL_JOB_KINDS.digestPlan;
export const SLACK_DIGEST_TIMEOUT_MS = SLACK_INTEL_LIMITS.digestTimeoutMs;
export const SLACK_DIGEST_PLAN_TIMEOUT_MS = 60_000;
const PLAN_MAX_ATTEMPTS = 2;
const PLAN_AT = "00:30";

const CHANNEL_RE = /^[CGD][A-Z0-9]{2,30}$/;
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MODES: ReadonlySet<string> = new Set(["plan", "today", "rebuild"]);

export type SlackDigestJobResult =
  | { skipped: string }
  | { outcome: string; humanCount: number; partial: boolean; fullDay: boolean; costUsd: number | null; code?: string };
export type SlackDigestPlanResult = { skipped: string } | { eligible: number; planned: number; retried: number };

/** The job payload (references only: a channel id, a local date, a mode); anything else → null. */
export function parseDigestPayload(raw: unknown): SlackDigestPayload | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.channel_id !== "string" || !CHANNEL_RE.test(p.channel_id)) return null;
  if (typeof p.local_date !== "string" || !LOCAL_DATE_RE.test(p.local_date)) return null;
  if (typeof p.mode !== "string" || !MODES.has(p.mode)) return null;
  return { channel_id: p.channel_id, local_date: p.local_date, mode: p.mode as SlackDigestPayload["mode"] };
}

/** One exec.slack-digest job. `now` is the clock (tests pass one). */
export async function runSlackDigestJob(ctx: JobContext, now: Date = new Date()): Promise<SlackDigestJobResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const payload = parseDigestPayload(ctx.job.payload);
  if (!payload) return { skipped: "bad_payload" };
  const settings = await loadSettings(principal.id);
  const state = await slackIntelState(principal, settings, { signal: ctx.signal });
  if (state !== "ok") return { skipped: state };
  const r = await buildDigest(principal, settings, payload, { signal: ctx.signal, now });
  return {
    outcome: r.outcome,
    humanCount: r.humanCount ?? 0,
    partial: r.partial === true,
    fullDay: r.fullDay === true,
    costUsd: r.costUsd,
    ...(typeof r.code === "string" ? { code: r.code } : {})
  };
}

/** One exec.slack-digest-plan job. `now` is the clock (tests pass one). */
export async function runSlackDigestPlanJob(ctx: JobContext, now: Date = new Date()): Promise<SlackDigestPlanResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const settings = await loadSettings(principal.id);
  const state = await slackIntelState(principal, settings, { signal: ctx.signal });
  if (state !== "ok") return { skipped: state };
  return runDigestPlan(principal, state, now, { signal: ctx.signal });
}

export const slackDigestJobHandler: JobHandler = {
  kind: DIGEST_KIND,
  lane: "bulk",
  timeoutMs: SLACK_DIGEST_TIMEOUT_MS,
  run: (ctx: JobContext) => runSlackDigestJob(ctx)
};

export const slackDigestPlanJobHandler: JobHandler = {
  kind: PLAN_KIND,
  lane: "bulk",
  timeoutMs: SLACK_DIGEST_PLAN_TIMEOUT_MS,
  run: (ctx: JobContext) => runSlackDigestPlanJob(ctx)
};

/** Daily from 00:30 local while reading is on and its schema is applied (§3.11). D registers it in runtime.ts. */
export const slackDigestPlanScheduledWork: ScheduledWork = {
  kind: PLAN_KIND,
  lane: "bulk",
  cadence: { kind: "daily", at: () => PLAN_AT },
  enabled: (s) => s.slackReadingEnabled && s.slackReadingSchemaReady,
  maxAttempts: PLAN_MAX_ATTEMPTS
};
