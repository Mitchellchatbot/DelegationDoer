import "server-only";

import { parseReplyValue, SecretUnavailableError } from "@/lib/exec/crypto";
import { openInstallationById } from "@/lib/exec/slack-install";
import { P10_JOB_KINDS, P10_LIMITS } from "@/lib/exec/slack-p10-types";
import type { ReplyActionPayload } from "@/lib/exec/slack-p10-types";
import { sendSlackReply, sentNotRecorded } from "@/lib/exec/slack-reply-send";
import { rerenderReplyCards } from "@/lib/exec/slack-reply-view";
import { SLACK_RE, type OpenInstallation } from "@/lib/exec/slack-types";
import { NonRetryableError, type JobContext, type JobHandler } from "@/lib/exec/types";

// P10_JOB_KINDS.replySend (P10 contract §3.5.9, H2, B-P10-14; Area D): the DM card's Send. Interactive lane, 45 s,
// maxAttempts 1, key srd-send:<trigger_id>, payload ReplyActionPayload. Created ONLY by SQL exec_slack_accept_action_v3 from
// a verified click: no TypeScript enqueues this kind (B-P10-14 (a)); every sendSlackReply call here passes the literals
// path "dm" and actor "slack" (B-P10-14 (c)).
//
//   * The payload names the click (installation, draft, version, value, the DM message); it never carries a destination or a
//     text: sendSlackReply posts the STORED text into the STORED destination, after re-checking the MAC from the stored row
//     and the card the click came from (C38).
//   * The card is re-rendered with the outcome: dd_only / needs_ack show "Check and send in DD" with every reason in words,
//     prefixed "Not sent from Slack. Nothing was posted." (v1.1 product-8).
//   * The result carries ids and codes only (B-P10-6).

const DRAFT_ID = /^esr_[0-9a-f]{32}$/;
const CODE = /^[a-z0-9_]{1,60}$/;

export type ReplyClickResult = { skipped: string } | { draftId: string; outcome: string; reason: string | null };

/** The payload's shape (references only); null when malformed. Shared with exec.slack-rdraft-act (its own action set; a
 *  failed first generation's Try again carries version 0, so the act job accepts 0..9999 and the send job 1..9999). */
export function parseReplyActionPayload(raw: unknown, actions: readonly ReplyActionPayload["action"][], minVersion: 0 | 1): ReplyActionPayload | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.installation_id !== "string" || !SLACK_RE.installationId.test(p.installation_id)) return null;
  if (typeof p.action !== "string" || !(actions as readonly string[]).includes(p.action)) return null;
  if (typeof p.draft_id !== "string" || !DRAFT_ID.test(p.draft_id)) return null;
  if (typeof p.version !== "number" || !Number.isSafeInteger(p.version) || p.version < minVersion || p.version > 9999) return null;
  if (typeof p.value !== "string" || p.value.length === 0 || p.value.length > 200) return null;
  if (typeof p.channel_id !== "string" || !SLACK_RE.dm.test(p.channel_id)) return null;
  if (typeof p.message_ts !== "string" || !SLACK_RE.ts.test(p.message_ts)) return null;
  return {
    installation_id: p.installation_id, action: p.action as ReplyActionPayload["action"], draft_id: p.draft_id, version: p.version,
    value: p.value, channel_id: p.channel_id, message_ts: p.message_ts
  };
}

/** The click's installation, its DM (the payload's channel must be it) and the value (it must name this draft and version). */
export async function openClick(principal: Parameters<typeof openInstallationById>[0], payload: ReplyActionPayload, signal: AbortSignal):
  Promise<{ ok: true; inst: OpenInstallation; mac: string } | { ok: false; skipped: string }> {
  const parsed = parseReplyValue(payload.value);
  if (parsed === null || parsed.draftId !== payload.draft_id || parsed.version !== payload.version) return { ok: false, skipped: "bad_value" };
  let inst: OpenInstallation | null;
  try {
    inst = await openInstallationById(principal, payload.installation_id, { signal });
  } catch (err) {
    if (err instanceof SecretUnavailableError) return { ok: false, skipped: "token_unavailable" };
    throw err;
  }
  if (inst === null || payload.channel_id !== inst.row.dmChannelId) return { ok: false, skipped: "installation" };
  return { ok: true, inst, mac: parsed.mac };
}

async function runReplySend(ctx: JobContext): Promise<ReplyClickResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const payload = parseReplyActionPayload(ctx.job.payload, ["send"], 1);
  if (payload === null) throw new NonRetryableError("bad_payload");
  const now = new Date();
  const click = await openClick(principal, payload, ctx.signal);
  if (!click.ok) return { skipped: click.skipped };
  // B-P10-14 (c): the DM path, from Slack, always (literals).
  const out = await sendSlackReply(principal, {
    id: payload.draft_id, path: "dm", version: payload.version, mac: click.mac, clickMessageTs: payload.message_ts, actor: "slack", now,
    signal: ctx.signal
  });
  // The card shows the outcome. A post's own follow-ups already re-rendered after `sent`; every other outcome re-renders here.
  if (out.kind === "dd_only" || out.kind === "needs_ack") {
    await rerenderReplyCards(principal, payload.draft_id, { now: new Date(), clickOutcome: out.kind, blockers: out.blockers });
  }
  else if (out.kind !== "sent") await rerenderReplyCards(principal, payload.draft_id, { now: new Date() });
  const reason = out.kind === "refused" ? out.reason
    : out.kind === "unknown" || out.kind === "back_to_draft" ? (CODE.test(out.reason) ? out.reason : "slack_error")
      : out.kind === "sent" && sentNotRecorded(out) ? "not_recorded" : null;
  return { draftId: payload.draft_id, outcome: out.kind, reason };
}

export const slackRdraftSendJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: P10_JOB_KINDS.replySend,
  lane: "interactive",
  timeoutMs: P10_LIMITS.replySendJobTimeoutMs,
  run: (ctx) => runReplySend(ctx)
});
