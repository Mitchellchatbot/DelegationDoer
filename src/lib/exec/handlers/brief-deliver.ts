import "server-only";

import { deliverBrief, parseDeliverPayload, type BriefDeliverResult } from "@/lib/exec/brief-deliver";
import { briefSchemaReady } from "@/lib/exec/brief-store";
import { BRIEF_JOB_KINDS, BRIEF_LIMITS } from "@/lib/exec/brief-types";
import { NonRetryableError, type JobContext, type JobHandler } from "@/lib/exec/types";

// exec.brief-deliver (P8 contract §3.13.2, M2, C24, C34; Area D): posts a built brief to his assistant DM exactly once
// (modes full / same_day) or the late note after a watchdog fallback (late), through brief-deliver.ts deliverBrief.
// Interactive lane, maxAttempts 1, 60 s, key exec.brief-deliver:<p>:<localDate>:<rev>:<mode>. Codes only in its result.

export const BRIEF_DELIVER_JOB_KIND = BRIEF_JOB_KINDS.deliver;

async function runDeliver(ctx: JobContext): Promise<BriefDeliverResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const payload = parseDeliverPayload(ctx.job.payload);
  if (payload === null) throw new NonRetryableError("bad_payload");
  if (!(await briefSchemaReady({ signal: ctx.signal }))) return { skipped: "not_installed" };
  return deliverBrief(principal, payload, ctx.signal);
}

export const briefDeliverJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: BRIEF_DELIVER_JOB_KIND,
  lane: "interactive",
  timeoutMs: BRIEF_LIMITS.deliverTimeoutMs,
  run: (ctx) => runDeliver(ctx)
});
