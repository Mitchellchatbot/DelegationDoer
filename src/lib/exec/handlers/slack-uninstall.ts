import "server-only";

import { auditEvent } from "@/lib/exec/audit";
import { SecretUnavailableError } from "@/lib/exec/crypto";
import { notifyOps } from "@/lib/exec/ops";
import { authTest } from "@/lib/exec/sources/slack";
import { asSlackApiError } from "@/lib/exec/slack-dm";
import {
  getInstallationForSystem,
  listUnpurgedRevokedInstallations,
  openInstallationForSystem,
  purgeInstallation,
  revokeInstallation
} from "@/lib/exec/slack-install";
import { SLACK_JOB_KINDS, SLACK_LIMITS, SLACK_RE } from "@/lib/exec/slack-types";
import type { SlackUninstallPayload } from "@/lib/exec/slack-types";
import { NonRetryableError, type JobContext, type JobHandler } from "@/lib/exec/types";

// exec.slack-uninstall (P6 contract §3.11.5, C17, C18, K16; Area D): a system
// job (principal null) on the bulk lane, 60 s.
//
//   mode "check" (C17): tokens_revoked naming our bot user, or any job whose
//     Slack call failed with a dead-token code (slack-dm.ts), asks Slack with
//     auth.test whether the bot token still works. Only the four dead-token
//     codes revoke (RPC 3, which enqueues the purge); an event or failure
//     dated before the row's installed_at is stale (a reinstall in between).
//   mode "purge" (C18): RPC 4 nulls the token and deletes the installation's
//     events, ledger and Slack conversations; the first purge of a row raises
//     the ops alert and the system audit row (ids and counts only).

export type SlackUninstallResult =
  | { skipped: string }
  | { stillValid: true }
  | { revoked: boolean }
  | { purged: boolean; events: number; posts: number; conversations: number };

const KIND = SLACK_JOB_KINDS.uninstall;
const DEAD_TOKEN_CODES: ReadonlySet<string> = new Set(["invalid_auth", "token_revoked", "account_inactive", "not_authed"]);

export function parseUninstallPayload(raw: unknown): SlackUninstallPayload | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.installation_id !== "string" || !SLACK_RE.installationId.test(p.installation_id)) return null;
  if (p.mode !== "purge" && p.mode !== "check") return null;
  if (p.event_time !== undefined && p.event_time !== null && (typeof p.event_time !== "number" || !Number.isFinite(p.event_time))) return null;
  return {
    installation_id: p.installation_id,
    mode: p.mode,
    ...(typeof p.event_time === "number" ? { event_time: p.event_time } : {})
  };
}

async function check(id: string, eventTime: number | undefined, signal: AbortSignal): Promise<SlackUninstallResult> {
  let inst;
  try {
    inst = await openInstallationForSystem(id);
  } catch (err) {
    // Our own key can't open the token: not Slack's revocation, so nothing is revoked (the runner raises the auth alert).
    if (err instanceof SecretUnavailableError) throw new NonRetryableError("slack token unavailable", "auth");
    throw err;
  }
  if (!inst) return { skipped: "not_active" };
  const installedMs = Date.parse(inst.row.installedAt);
  if (typeof eventTime === "number" && Number.isFinite(installedMs) && eventTime * 1000 < installedMs) return { skipped: "stale" };
  try {
    await authTest(inst.target.token, { signal });
    return { stillValid: true };
  } catch (err) {
    const e = asSlackApiError(err);
    if (e && DEAD_TOKEN_CODES.has(e.code)) return revokeInstallation(id, "tokens_revoked");
    // Retryable (ratelimited, 5xx, network) → the runner retries (maxAttempts 3); anything else ends the check.
    throw err;
  }
}

async function purge(id: string): Promise<SlackUninstallResult> {
  const before = await getInstallationForSystem(id);
  const counts = await purgeInstallation(id);
  if (counts === null) throw new NonRetryableError("not_installed");
  // Only the purge that actually ran on a revoked row, the first time, raises the alert and the audit row (UN06).
  if (counts.purged && before !== null && before.revokedAt !== null && before.purgedAt === null) {
    const reason = before.revokeReason ?? "unknown";
    await notifyOps({
      key: "exec-slack-revoked",
      title: "Executive Assistant Slack app disconnected",
      detail: `installation ${id}: ${reason}; events ${counts.events}, posts ${counts.posts}, conversations ${counts.conversations}`
    });
    await auditEvent(null, {
      actor: "system",
      action: "slack.revoked",
      target: `exec_slack_installations:${id}`,
      input: { reason, events: counts.events, posts: counts.posts, conversations: counts.conversations }
    });
  }
  return { purged: counts.purged, events: counts.events, posts: counts.posts, conversations: counts.conversations };
}

/** C18's backstop: a revocation is this old before the daily purge finishes its purge (the job's six attempts take ~15 min). */
export const UNPURGED_REVOCATION_GRACE_MS = 60 * 60_000;
const BACKSTOP_LIMIT = 20;

/**
 * C18 backstop (exec.purge, daily): the purge job RPC 3 enqueues is the only other path that nulls a revoked row's token
 * and deletes its events, ledger and Slack conversations, and its unique dedupe key blocks a second one for 14 days. So
 * every installation revoked over an hour ago whose purge never ran (purged_at null) is purged here, through the same
 * step (RPC 4 is idempotent; the ops alert and the audit row stay with whichever purge runs first). Returns how many
 * were purged; the schema missing → 0. One failing installation doesn't stop the rest; the first failure is rethrown
 * at the end so the daily job reports it.
 */
export async function purgeUnpurgedRevocations(now: Date, opts?: { signal?: AbortSignal }): Promise<number> {
  const ids = await listUnpurgedRevokedInstallations(new Date(now.getTime() - UNPURGED_REVOCATION_GRACE_MS).toISOString(), BACKSTOP_LIMIT, opts);
  let purged = 0;
  let firstError: unknown = null;
  for (const id of ids) {
    opts?.signal?.throwIfAborted();
    try {
      const r = await purge(id);
      if ("purged" in r && r.purged) purged += 1;
    } catch (err) {
      console.error(`[exec-slack] backstop purge of ${id} failed (${err instanceof Error ? err.name : "error"})`);
      firstError ??= err;
    }
  }
  if (firstError !== null) throw firstError;
  return purged;
}

async function runUninstall(ctx: JobContext): Promise<SlackUninstallResult> {
  const p = parseUninstallPayload(ctx.job.payload);
  if (!p) throw new NonRetryableError("bad payload");
  return p.mode === "check" ? check(p.installation_id, p.event_time, ctx.signal) : purge(p.installation_id);
}

export const SLACK_UNINSTALL_TIMEOUT_MS = SLACK_LIMITS.uninstallTimeoutMs;

export const slackUninstallJobHandler: JobHandler = {
  kind: KIND,
  lane: "bulk",
  timeoutMs: SLACK_UNINSTALL_TIMEOUT_MS,
  run: (ctx: JobContext) => runUninstall(ctx)
};
