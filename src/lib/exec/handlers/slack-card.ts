import "server-only";

import { SecretUnavailableError } from "@/lib/exec/crypto";
import { getDraftView } from "@/lib/exec/drafts";
import { dmUpdate, ownSignal, slackCodeOf } from "@/lib/exec/slack-dm";
import { openInstallationById, recordSlackError, resetPostFollowed } from "@/lib/exec/slack-install";
import { SLACK_JOB_KINDS, SLACK_LIMITS, SLACK_RE } from "@/lib/exec/slack-types";
import type { SlackCardPayload } from "@/lib/exec/slack-types";
import { renderDraftCard } from "@/lib/exec/slack-ui";
import { NonRetryableError, type JobContext, type JobHandler } from "@/lib/exec/types";

// exec.slack-card (P6 contract §3.11.3, C11; Area D): one scheduled refresh of
// a draft card in his DM, re-rendered from the draft's current view. It never
// posts a new message (CD03): chat.update on the card's own ts only.
// Interactive lane, 30 s, one attempt; enqueued by slack-dm.ts's
// scheduleCardRefresh with dedupe slack-card:<ts>:<sched>:<i>.

export type SlackCardResult = { skipped: string } | { status: string; i: number };

const KIND = SLACK_JOB_KINDS.card;
const DRAFT_ID = /^ed_[0-9a-f]{32}$/;
/** The card's message no longer exists in Slack (deleted by the DM purge, or never ours): nothing left to refresh. */
const MESSAGE_GONE_CODES: ReadonlySet<string> = new Set(["message_not_found", "cant_update_message", "channel_not_found"]);

export function parseCardPayload(raw: unknown): SlackCardPayload | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.installation_id !== "string" || !SLACK_RE.installationId.test(p.installation_id)) return null;
  if (p.kind !== "draft" || typeof p.id !== "string" || !DRAFT_ID.test(p.id)) return null;
  if (typeof p.channel_id !== "string" || !SLACK_RE.dm.test(p.channel_id)) return null;
  if (typeof p.message_ts !== "string" || !SLACK_RE.ts.test(p.message_ts)) return null;
  if (typeof p.sched !== "string" || !/^[0-9A-Za-z_-]{1,40}$/.test(p.sched)) return null;
  if (typeof p.i !== "number" || !Number.isInteger(p.i) || p.i < 0 || p.i > 20) return null;
  return { installation_id: p.installation_id, kind: "draft", id: p.id, channel_id: p.channel_id, message_ts: p.message_ts, sched: p.sched, i: p.i };
}

async function runCard(ctx: JobContext): Promise<SlackCardResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const p = parseCardPayload(ctx.job.payload);
  if (!p) return { skipped: "bad_payload" };
  let inst;
  try {
    inst = await openInstallationById(principal, p.installation_id);
  } catch (err) {
    if (err instanceof SecretUnavailableError) {
      await recordSlackError(p.installation_id, "token_unavailable");
      throw new NonRetryableError("slack token unavailable", "auth");
    }
    throw err;
  }
  if (!inst || inst.row.dmChannelId !== p.channel_id) return { skipped: "installation" };
  const view = await getDraftView(principal, p.id);
  try {
    await dmUpdate(inst, p.message_ts, renderDraftCard(view, { draftId: p.id }), { signal: ownSignal() });
    // C42: this render read the draft before the update landed; the next sweep re-checks the card (resetPostFollowed).
    await resetPostFollowed(inst.row.id, p.message_ts);
  } catch (err) {
    const code = slackCodeOf(err);
    if (code !== null && MESSAGE_GONE_CODES.has(code)) return { skipped: "message_gone" };
    throw err;
  }
  return { status: view?.status ?? "gone", i: p.i };
}

export const SLACK_CARD_TIMEOUT_MS = SLACK_LIMITS.cardTimeoutMs;

export const slackCardJobHandler: JobHandler = {
  kind: KIND,
  lane: "interactive",
  timeoutMs: SLACK_CARD_TIMEOUT_MS,
  run: (ctx: JobContext) => runCard(ctx)
};
