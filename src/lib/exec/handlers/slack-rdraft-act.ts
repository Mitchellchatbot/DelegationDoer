import "server-only";

import { auditEvent } from "@/lib/exec/audit";
import { SecretUnavailableError, verifyReplyMac } from "@/lib/exec/crypto";
import { openClick, parseReplyActionPayload, type ReplyClickResult } from "@/lib/exec/handlers/slack-rdraft-send";
import { rateLimit } from "@/lib/exec/http";
import { P10_JOB_KINDS, P10_LIMITS } from "@/lib/exec/slack-p10-types";
import { regenerateSlackReplyDraft } from "@/lib/exec/slack-reply-create";
import { getReplyCard, getReplyDraft, stepReplyDraft } from "@/lib/exec/slack-reply-store";
import { rerenderReplyCards } from "@/lib/exec/slack-reply-view";
import { NonRetryableError, type JobContext, type JobHandler } from "@/lib/exec/types";

// exec.slack-rdraft-act (P10 contract §3.5.9, C38; Area D): the DM card's Rewrite and Discard. Interactive lane, 30 s,
// maxAttempts 1, key srd-act:<trigger_id> (v3), payload ReplyActionPayload; the MAC verified against the stored row.
//
//   * The same click checks as the send job: the payload, the value names this draft and version, the installation and its
//     DM, the card the click came from (getReplyCard), then the version and the MAC recomputed from the STORED row.
//   * Rewrite = regenerateSlackReplyDraft with no instruction (the last one is kept, C51) from origin "slack"; Discard = X1.
//     Each is one audit event (actor slack, ids and codes) and counts against the route's bucket (C49): Rewrite with create,
//     Discard with edit. The card is re-rendered with the result.
//   * Nothing here posts as him and nothing here sends: this job never reaches the send path (RS23).

async function runReplyAct(ctx: JobContext): Promise<ReplyClickResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const payload = parseReplyActionPayload(ctx.job.payload, ["rewrite", "discard"], 0);
  if (payload === null) throw new NonRetryableError("bad_payload");
  const signal = ctx.signal;
  const now = new Date();
  const click = await openClick(principal, payload, signal);
  if (!click.ok) return { skipped: click.skipped };
  const id = payload.draft_id;
  const done = async (outcome: string, reason: string | null): Promise<ReplyClickResult> => {
    await rerenderReplyCards(principal, id, { now: new Date() });
    return { draftId: id, outcome, reason };
  };

  // The card the click came from must be this draft's (C38): a value pasted onto another message is refused.
  const card = await getReplyCard(payload.installation_id, payload.message_ts);
  if (card === null || card.draftId !== id || card.principalId !== principal.id) return { skipped: "card" };
  const row = await getReplyDraft(principal, id, { signal });
  if (row === null) return done("refused", "not_found");
  // Rewrite and Discard act on an open draft only (RPC 14 / X1); anything else is the card catching up.
  if (row.status !== "draft" && row.status !== "generation_failed") return done("refused", "not_draft");
  if (row.version !== payload.version) return done("refused", "stale");
  let macOk: boolean;
  try {
    macOk = verifyReplyMac({ draftId: row.id, version: row.version, channelId: row.channelId, replyThreadTs: row.replyThreadTs, text: row.text ?? "" }, click.mac);
  } catch (err) {
    if (err instanceof SecretUnavailableError) return done("refused", "key_unavailable");
    throw err;
  }
  if (!macOk) {
    console.warn(`[exec-slack-reply] ${id}: mac_mismatch`);
    return done("refused", "mac_mismatch");
  }

  if (payload.action === "rewrite") {
    const limited = await rateLimit(principal, "slack_reply_create", P10_LIMITS.replyCreateLimit, P10_LIMITS.replyRouteWindowMs, { now });
    if (!limited.ok) return done("refused", "rate_limited");
    const r = await regenerateSlackReplyDraft(principal, { id, version: row.version, instruction: null, origin: "slack" }, { now, signal });
    await auditEvent(principal, {
      actor: "slack", action: "slack_reply.regenerate", target: `exec_slack_reply_drafts:${id}`,
      input: { draftId: id, version: row.version, origin: "slack" }, result: { outcome: r.outcome }, ok: r.outcome === "queued"
    });
    return done(r.outcome, null);
  }

  const limited = await rateLimit(principal, "slack_reply_edit", P10_LIMITS.replyEditLimit, P10_LIMITS.replyRouteWindowMs, { now });
  if (!limited.ok) return done("refused", "rate_limited");
  const moved = await stepReplyDraft(principal, id, { t: "discard", version: row.version }, now);
  await auditEvent(principal, {
    actor: "slack", action: "slack_reply.discard", target: `exec_slack_reply_drafts:${id}`,
    input: { draftId: id, version: row.version }, result: { outcome: moved ? "discarded" : "conflict" }, ok: moved
  });
  return done(moved ? "discarded" : "conflict", null);
}

export const slackRdraftActJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: P10_JOB_KINDS.replyAct,
  lane: "interactive",
  timeoutMs: P10_LIMITS.replyActJobTimeoutMs,
  run: (ctx) => runReplyAct(ctx)
});
