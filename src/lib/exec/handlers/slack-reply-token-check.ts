import "server-only";

import { notifyOps } from "@/lib/exec/ops";
import { loadSettings } from "@/lib/exec/principal";
import type { ScheduledWork } from "@/lib/exec/scheduler";
import { getActiveInstallation } from "@/lib/exec/slack-install";
import { SLACK_P10_OPS } from "@/lib/exec/slack-p10-copy";
import { P10_JOB_KINDS, P10_LIMITS } from "@/lib/exec/slack-p10-types";
import { verifyReplyToken, type ReplyTokenVerdict } from "@/lib/exec/slack-reply-post";
import { putSyncState } from "@/lib/exec/sync-state";
import type { JobContext, JobHandler } from "@/lib/exec/types";

// exec.slack-reply-token-check (P10 contract §3.5.9, C60, v1.1 product-4; Area D): auth.test of his DD token only (never a
// post); writes slack-reply/token-health { state, checkedAt }; a mismatch raises SLACK_P10_OPS.tokenMismatch. Bulk lane, 30 s,
// maxAttempts 2; daily at tokenCheckLocalTime in principal.timezone, or key slack-reply-token-check:<p>:settings:<minute>.
// It imports only verifyReplyToken and the ReplyTokenVerdict type from slack-reply-post.ts (B-P10-11).
//
//   * So the DM card's Send (C32) and the System card's "Slack connection" have a verdict before his first send.
//   * The result is { state } (an enum); logs and the ops alert carry the principal id and codes only, never a token.

export type TokenCheckResult = { skipped: string } | { state: ReplyTokenVerdict["state"] | "no_installation" };

/** The one ops alert this job raises (fixed copy, C39): a key with the principal id, a fixed title, a fixed detail. */
const MISMATCH_ALERT = SLACK_P10_OPS.tokenMismatch;

async function runTokenCheck(ctx: JobContext): Promise<TokenCheckResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const signal = ctx.signal;
  const settings = await loadSettings(principal.id);
  if (!(settings.slackP10SchemaReady && settings.slackRepliesEnabled && settings.slackReplySendEnabled)) return { skipped: "off" };
  const installation = await getActiveInstallation(principal, { signal });
  const state: ReplyTokenVerdict["state"] | "no_installation" = installation === null
    ? "no_installation"
    : (await verifyReplyToken(principal, installation, { signal })).state;
  await putSyncState(principal, "slack-reply", "token-health", { state, checkedAt: new Date().toISOString() }, { signal });
  if (state === "mismatch") {
    await notifyOps({ key: MISMATCH_ALERT.key(principal.id), title: MISMATCH_ALERT.title, detail: "token check: mismatch" });
  }
  return { state };
}

export const slackReplyTokenCheckJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: P10_JOB_KINDS.replyTokenCheck,
  lane: "bulk",
  timeoutMs: P10_LIMITS.tokenCheckTimeoutMs,
  run: (ctx) => runTokenCheck(ctx)
});

/** §3.10: daily at 06:10 (tokenCheckLocalTime) in principal.timezone while replies and sending are on; maxAttempts 2 (P8's
 *  briefHealthScheduledWork shape). */
export const slackReplyTokenCheckScheduledWork: ScheduledWork = Object.freeze<ScheduledWork>({
  kind: P10_JOB_KINDS.replyTokenCheck,
  lane: "bulk",
  cadence: { kind: "daily", at: () => P10_LIMITS.tokenCheckLocalTime },
  enabled: (s) => s.slackP10SchemaReady && s.slackRepliesEnabled && s.slackReplySendEnabled,
  maxAttempts: 2
});
