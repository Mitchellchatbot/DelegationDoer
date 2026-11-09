import "server-only";

import { auditEvent } from "@/lib/exec/audit";
import { rewriteCheckinText } from "@/lib/exec/brief-checkins";
import { rewriteCheckin } from "@/lib/exec/brief-store";
import { BRIEF_JOB_KINDS, BRIEF_LIMITS } from "@/lib/exec/brief-types";
import type { CheckinCandidate } from "@/lib/exec/brief-types";
import { gateClick, loadClick, type CheckinResult } from "@/lib/exec/handlers/checkin-send";
import { errLabel } from "@/lib/exec/slack-dm";
import { listDepartments, listUsers } from "@/lib/exec/sources/dd";
import type { ExecPrincipal, JobContext, JobHandler } from "@/lib/exec/types";

// exec.checkin-rewrite (P8 contract §3.13.8, M6, C10; intel-17; Area D): one Rewrite click (key checkin-rewrite:<trigger_id>):
// a new note from DD data only (brief-checkins.ts rewriteCheckinText), rev + 1 by CAS, the check-ins message re-rendered (the
// new button carries the new rev and MAC, so every earlier button is stale). Interactive lane, maxAttempts 1, 60 s. A failed
// rewrite leaves the row as it was (a later click works: no dead button). Codes only in its result.

export const CHECKIN_REWRITE_JOB_KIND = BRIEF_JOB_KINDS.checkinRewrite;

/** The person as the check-in model may see them (C10): first name, departments, role label. DD rows only. */
async function candidateFor(principal: ExecPrincipal, userId: string, signal: AbortSignal):
  Promise<Pick<CheckinCandidate, "firstName" | "departments" | "role"> | null> {
  const [users, departments] = await Promise.all([listUsers(principal, { signal }), listDepartments(principal, { signal })]);
  const user = users.find((u) => u.id === userId);
  if (!user) return null;
  const names = new Map(departments.map((d) => [d.id, d.name]));
  const isHead = user.role === "department_head" || departments.some((d) => d.headUserId === user.id);
  return {
    firstName: (typeof user.name === "string" ? user.name.trim().split(/\s+/)[0] ?? "" : "").slice(0, 40),
    departments: user.departmentIds.map((id) => names.get(id)).filter((n): n is string => typeof n === "string").slice(0, 3),
    role: isHead ? "department_head" : "worker"
  };
}

async function runRewrite(ctx: JobContext): Promise<CheckinResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const signal = ctx.signal;
  const now = new Date();
  // 1.-3.
  const loaded = await loadClick(principal, ctx.job.payload, now, signal);
  if ("skipped" in loaded) return loaded;
  const click = loaded;
  const { row } = click;
  // A sending row (a send in flight or crashed) only re-renders; its text can't change under the send.
  if (row.status === "sending") {
    await click.render();
    return { status: row.status, reason: "in_flight" };
  }
  // 5.-8.
  const gated = await gateClick(principal, click, now, signal);
  if (gated !== null) return gated;
  let candidate: Pick<CheckinCandidate, "firstName" | "departments" | "role"> | null;
  try {
    candidate = await candidateFor(principal, row.recipientUserId, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    console.warn(`[exec-brief] checkin ${row.id} rewrite: people unavailable (${errLabel(err)})`);
    candidate = null;
  }
  if (candidate === null) {
    await click.render("busy");
    return { status: row.status, reason: "recipient_unavailable" };
  }
  const rewritten = await rewriteCheckinText(principal, row, candidate, { signal: AbortSignal.timeout(BRIEF_LIMITS.checkinDeadlineMs) });
  if (rewritten === null) {
    await click.render("busy");
    return { status: row.status, reason: "model_failed" };
  }
  // rev + 1 by CAS: a concurrent send (now sending) or a second rewrite (rev moved) leaves this one without effect.
  if (!(await rewriteCheckin(principal, row.id, row.rev, rewritten))) {
    await click.render();
    return { status: row.status, reason: "lost_race" };
  }
  await auditEvent(principal, { actor: "slack", action: "brief.checkin.rewrite", target: `exec_brief_checkins:${row.id}`, input: { checkinId: row.id, rev: row.rev } });
  await click.render();
  return { status: "proposed", reason: "rewritten" };
}

export const checkinRewriteJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: CHECKIN_REWRITE_JOB_KIND,
  lane: "interactive",
  timeoutMs: BRIEF_LIMITS.checkinRewriteTimeoutMs,
  run: (ctx) => runRewrite(ctx)
});
