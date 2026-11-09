import "server-only";

import { BRIEF_OPS } from "@/lib/exec/brief-copy";
import { briefSchemaReady } from "@/lib/exec/brief-store";
import { BRIEF_JOB_KINDS, BRIEF_LIMITS } from "@/lib/exec/brief-types";
import type { OwnerTokenVerdict, TokenHealthState } from "@/lib/exec/brief-types";
import { verifyOwnerUserToken } from "@/lib/exec/checkin-post";
import { notifyOps } from "@/lib/exec/ops";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import { getActiveInstallation } from "@/lib/exec/slack-install";
import { putSyncState } from "@/lib/exec/sync-state";
import type { JobContext, JobHandler } from "@/lib/exec/types";

// exec.brief-health (P8 contract §3.13.6, C19; Area D): daily at 06:00 brief-local, auth.test of his DD Slack user token
// through checkin-post.ts verifyOwnerUserToken (B-P8-2: one of its two importers); the verdict lands in exec_sync_state
// brief/token-health for the System card; a mismatch raises BRIEF_OPS.tokenMismatch. Bulk lane, maxAttempts 2, 30 s.
// It never posts and never logs or returns a token.

export const BRIEF_HEALTH_JOB_KIND = BRIEF_JOB_KINDS.health;

type HealthResult = { skipped: string } | { state: OwnerTokenVerdict["state"] | "no_installation" };

async function runHealth(ctx: JobContext): Promise<HealthResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  if (!(await briefSchemaReady({ signal: ctx.signal }))) return { skipped: "not_installed" };
  const now = new Date();
  const inst = await getActiveInstallation(principal, { signal: ctx.signal });
  if (inst === null) {
    const health: TokenHealthState = { state: "no_installation", checkedAt: now.toISOString() };
    await putSyncState(principal, "brief", "token-health", health);
    return { state: "no_installation" };
  }
  const verdict = await verifyOwnerUserToken(principal, inst, now, { signal: ctx.signal });
  if (verdict.state === "mismatch") {
    await notifyOps({ key: BRIEF_OPS.tokenMismatch.key(principal.id), title: BRIEF_OPS.tokenMismatch.title, detail: `principal ${principal.id}: health check` });
  }
  return { state: verdict.state };
}

export const briefHealthJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: BRIEF_HEALTH_JOB_KIND,
  lane: "bulk",
  timeoutMs: BRIEF_LIMITS.healthTimeoutMs,
  run: (ctx) => runHealth(ctx)
});

/** §3.6: daily at 06:00 in the brief zone while the brief and check-ins are on; payload { local_date }; maxAttempts 2. */
export const briefHealthScheduledWork: ScheduledWork = Object.freeze<ScheduledWork>({
  kind: BRIEF_HEALTH_JOB_KIND,
  lane: "bulk",
  cadence: { kind: "daily", at: () => BRIEF_LIMITS.healthLocalTime },
  enabled: (s) => s.briefEnabled && s.checkinsEnabled,
  maxAttempts: 2,
  zone: (p) => p.briefTimezone,
  payload: (_p, ctx) => ({ local_date: ctx.localDate })
});
