import "server-only";

import { auditEvent } from "@/lib/exec/audit";
import { SecretUnavailableError } from "@/lib/exec/crypto";
import { notifyOps } from "@/lib/exec/ops";
import { slackErrorOf } from "@/lib/exec/slack-read";
import { clearUserTokenError, getInstallationReading, openReadingForSystem } from "@/lib/exec/slack-install";
import { userRevoke } from "@/lib/exec/slack-read-store";
import { SLACK_READ_JOB_KINDS, SLACK_READ_LIMITS } from "@/lib/exec/slack-read-types";
import { SLACK_RE } from "@/lib/exec/slack-types";
import { authTest } from "@/lib/exec/sources/slack";
import { NonRetryableError, type JobContext, type JobHandler } from "@/lib/exec/types";

// exec.slack-user-check (P7a contract §3.11.8, C25; Area D): a system job
// (principal null), bulk lane, 30 s, three attempts. tokens_revoked naming his
// user id, or a P7a job's auth-class failure on the user token, asks Slack
// with auth.test whether the reading token still works. Only invalid_auth,
// token_revoked, account_inactive and not_authed (or an auth.test answering
// for another team or user) stop reading: RPC 15 marks the user half revoked
// and purges every reading row in one transaction. A check dated before the
// reading half was (re)installed is stale: a re-consent's fresh token is never
// killed by a late event, and a re-consent while auth.test is in flight is
// caught by a re-read right before the revoke (the old token's death never
// revokes the fresh reading half). Anything retryable is rethrown. The audit
// row and the ops alert carry ids, the reason and counts only.

const KIND = SLACK_READ_JOB_KINDS.userCheck;
const DEAD_TOKEN_CODES: ReadonlySet<string> = new Set(["invalid_auth", "token_revoked", "account_inactive", "not_authed"]);

export type SlackUserCheckResult = { skipped: string } | { stillValid: true } | { revoked: boolean; purged: Record<string, number> | null };

function parsePayload(raw: unknown): { installationId: string; eventTime: number | null } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.installation_id !== "string" || !SLACK_RE.installationId.test(p.installation_id)) return null;
  if (p.event_time !== undefined && p.event_time !== null && (typeof p.event_time !== "number" || !Number.isFinite(p.event_time))) return null;
  return { installationId: p.installation_id, eventTime: typeof p.event_time === "number" ? p.event_time : null };
}

async function revoke(installationId: string, installedAt: string | null, signal: AbortSignal): Promise<SlackUserCheckResult> {
  // P7a fixer correctness-10: he may have re-consented while auth.test ran (saveReadingConsent rewrites this row in place);
  // the token we checked is then no longer the stored one, so nothing is revoked.
  const now = await getInstallationReading(installationId, { signal });
  if (!now || now.reading.installedAt !== installedAt || (now.reading.state !== "discovering" && now.reading.state !== "ready")) {
    return { skipped: "stale" };
  }
  const r = await userRevoke(installationId, "tokens_revoked");
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.purge ?? {})) if (/^[a-z_]{1,40}$/i.test(k) && typeof v === "number" && Number.isFinite(v)) counts[k] = v;
  await auditEvent(null, {
    actor: "system",
    action: "slack.read_revoked",
    target: `exec_slack_installations:${installationId}`,
    input: { reason: "tokens_revoked", ...counts }
  });
  await notifyOps({
    key: "exec-slack-read-revoked",
    title: "Executive Assistant stopped reading Slack",
    detail: `installation ${installationId}: the reading token was revoked; reading data purged`
  });
  return { revoked: r.revoked, purged: r.purge === null ? null : counts };
}

async function runUserCheck(ctx: JobContext): Promise<SlackUserCheckResult> {
  const p = parsePayload(ctx.job.payload);
  if (!p) throw new NonRetryableError("bad payload");
  let ri;
  try {
    ri = await openReadingForSystem(p.installationId, { signal: ctx.signal });
  } catch (err) {
    // Our own key can't open the token: not Slack's revocation, so nothing is revoked (the runner raises the auth alert).
    if (err instanceof SecretUnavailableError) throw new NonRetryableError("slack reading token unavailable", "auth");
    throw err;
  }
  if (!ri) return { skipped: "not_reading" };
  const installedMs = ri.reading.installedAt !== null ? Date.parse(ri.reading.installedAt) : Number.NaN;
  if (p.eventTime !== null && Number.isFinite(installedMs) && p.eventTime * 1000 < installedMs) return { skipped: "stale" };
  let who;
  try {
    who = await authTest(ri.target.userToken, { signal: ctx.signal });
  } catch (err) {
    const e = slackErrorOf(err);
    if (e && DEAD_TOKEN_CODES.has(e.code)) return revoke(p.installationId, ri.reading.installedAt, ctx.signal);
    // Retryable (ratelimited, 5xx, network) → the runner retries; anything else ends the check.
    throw err;
  }
  if (who.teamId !== ri.row.teamId || who.userId !== ri.row.userId) return revoke(p.installationId, ri.reading.installedAt, ctx.signal);
  await clearUserTokenError(p.installationId);
  return { stillValid: true };
}

export const SLACK_USER_CHECK_TIMEOUT_MS = SLACK_READ_LIMITS.userCheckTimeoutMs;

export const slackUserCheckJobHandler: JobHandler = {
  kind: KIND,
  lane: "bulk",
  timeoutMs: SLACK_USER_CHECK_TIMEOUT_MS,
  run: (ctx: JobContext) => runUserCheck(ctx)
};
