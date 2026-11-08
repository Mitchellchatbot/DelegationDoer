import "server-only";

import type { CardView, ProposalView } from "@/lib/exec/chat/view-types";
import { getDraftView } from "@/lib/exec/drafts";
import type { DraftView } from "@/lib/exec/drafts-types";
import { enqueueJob } from "@/lib/exec/jobs";
import { getProposalView } from "@/lib/exec/proposals";
import { deleteInDm, postInDm, setHomeView, SlackApiError, updateInDm, type SlackCallOptions } from "@/lib/exec/sources/slack";
import { clearSlackError, deleteSlackPostRecord, enqueueRevokeCheck, recordSlackError, recordSlackPost } from "@/lib/exec/slack-install";
import { SLACK_JOB_KINDS, SLACK_LIMITS, SLACK_RE } from "@/lib/exec/slack-types";
import type { DmTarget, OpenInstallation, SlackCardPayload, SlackHomeView, SlackMessageParts, SlackPostLedger } from "@/lib/exec/slack-types";
import { renderDraftCard, renderProposalCard } from "@/lib/exec/slack-ui";
import type { ExecPrincipal } from "@/lib/exec/types";

// P6 job-side Slack glue (contract §3.11.0; Area D; server-only): post /
// update / delete in his DM with health recording and the post ledger, card
// posting and card refresh scheduling.
//
//   * Every Slack write goes through sources/slack.ts's DM-only senders, always
//     to the installation's own DM channel (K11): no caller names a channel.
//   * A SlackApiError of class "auth" records the installation's health
//     (C34) and, for the four codes that mean the token is dead, enqueues the
//     revocation check (C17 v2, security-2), then is rethrown unchanged. A
//     successful post or update clears a recorded error once per job.
//   * Every successful post is written to the ledger (C43); a failed ledger
//     write is logged by ts and never fails the post (the DM purge's history
//     scan is the backstop).
//   * Logs carry ids, ts values and codes only (§0.3 rule 4).

/** C17 v2: the auth codes that mean the bot token itself is dead (the check job confirms with auth.test). */
const DEAD_TOKEN_CODES: ReadonlySet<string> = new Set(["invalid_auth", "token_revoked", "account_inactive", "not_authed"]);
/** C11: a draft card posted while its draft is still generating is refreshed at +20 s, +60 s and +180 s. */
export const GENERATING_REFRESH_DELAYS_MS: readonly number[] = Object.freeze([20_000, 60_000, 180_000]);

/** Installations whose recorded error this process already cleared (a job clears at most once). */
const cleared = new WeakSet<OpenInstallation>();

/** A SlackApiError from this module copy or another (duck-typed on its frozen shape). */
export function asSlackApiError(err: unknown): SlackApiError | null {
  if (err instanceof SlackApiError) return err;
  if (typeof err !== "object" || err === null) return null;
  const e = err as { name?: unknown; code?: unknown; errorClass?: unknown; method?: unknown };
  return e.name === "SlackApiError" && typeof e.code === "string" && typeof e.errorClass === "string" && typeof e.method === "string"
    ? (err as SlackApiError)
    : null;
}

/** True for a SlackApiError of class "auth" (the token or its grant is bad). */
export function isSlackAuthError(err: unknown): boolean {
  return asSlackApiError(err)?.errorClass === "auth";
}

/** The Slack error code of err, or null when it isn't a SlackApiError. */
export function slackCodeOf(err: unknown): string | null {
  return asSlackApiError(err)?.code ?? null;
}

/** A name for a log line: the Slack code, else the error's class name (never a message). */
export function errLabel(err: unknown): string {
  const code = slackCodeOf(err);
  if (code !== null && /^[a-z0-9_]{1,64}$/.test(code)) return code;
  if (err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name)) return err.name;
  return "error";
}

const logTs = (ts: unknown): string => (typeof ts === "string" && SLACK_RE.ts.test(ts) ? ts : "(malformed)");
const logRef = (id: unknown): string => (typeof id === "string" && /^[a-z]{2,4}_[0-9a-f]{32}$/.test(id) ? id : "(malformed)");

/** C34 / C17 v2: what an auth-class failure records. Never throws (both store calls never throw). */
async function onSlackFailure(inst: OpenInstallation, err: unknown): Promise<void> {
  const e = asSlackApiError(err);
  if (!e || e.errorClass !== "auth") return;
  await recordSlackError(inst.row.id, e.code);
  if (DEAD_TOKEN_CODES.has(e.code)) await enqueueRevokeCheck(inst.row.id, new Date());
}

/** C34: a successful post or update clears the recorded health error (at most once per installation object). */
async function onSlackSuccess(inst: OpenInstallation): Promise<void> {
  if (inst.row.lastErrorCode === null || cleared.has(inst)) return;
  cleared.add(inst);
  await clearSlackError(inst.row.id);
}

/** chat.postMessage in his DM (in the thread when threadTs is set), then the ledger row (C43). */
export async function dmPost(principal: ExecPrincipal, inst: OpenInstallation, threadTs: string | null, parts: SlackMessageParts,
  ledger: SlackPostLedger, opts?: SlackCallOptions): Promise<{ ts: string }> {
  const channel = inst.row.dmChannelId;
  let posted: { ts: string };
  try {
    posted = await postInDm(inst.target, { channel, threadTs, blocks: parts.blocks, text: parts.text }, opts);
  } catch (err) {
    await onSlackFailure(inst, err);
    throw err;
  }
  await recordSlackPost(principal, {
    installationId: inst.row.id,
    channelId: channel,
    ts: posted.ts,
    threadTs: threadTs ?? null,
    kind: ledger.kind,
    messageId: ledger.messageId ?? null,
    refId: ledger.refId ?? null
  });
  await onSlackSuccess(inst);
  return posted;
}

/** chat.update of one of the bot's messages in his DM. */
export async function dmUpdate(inst: OpenInstallation, ts: string, parts: SlackMessageParts, opts?: SlackCallOptions): Promise<void> {
  try {
    await updateInDm(inst.target, { channel: inst.row.dmChannelId, ts, blocks: parts.blocks, text: parts.text }, opts);
  } catch (err) {
    await onSlackFailure(inst, err);
    throw err;
  }
  await onSlackSuccess(inst);
}

/** deleteInDm with the same auth handling; "deleted" / "gone" also remove the ledger row (a failed removal is logged:
 *  the message is gone from Slack either way, and the next purge finds the row and drops it). */
export async function dmDelete(inst: OpenInstallation, ts: string, opts?: SlackCallOptions): Promise<"deleted" | "gone"> {
  let outcome: "deleted" | "gone";
  try {
    outcome = await deleteInDm(inst.target, { channel: inst.row.dmChannelId, ts }, opts);
  } catch (err) {
    await onSlackFailure(inst, err);
    throw err;
  }
  try {
    await deleteSlackPostRecord(inst.row.id, ts);
  } catch (err) {
    console.error(`[exec-slack] ledger row not removed (installation ${inst.row.id}, ts ${logTs(ts)}): ${errLabel(err)}`);
  }
  return outcome;
}

/** A read in his DM (readDmMessage, listDmItems) with the writers' auth handling (C17 v2: any job's Slack call that finds the
 *  token dead reaches the check), then rethrown. */
export async function dmRead<T>(inst: OpenInstallation, read: (target: DmTarget) => Promise<T>): Promise<T> {
  try {
    return await read(inst.target);
  } catch (err) {
    await onSlackFailure(inst, err);
    throw err;
  }
}

/** K13: views.publish for one user with the same auth handling (no ledger: a Home view isn't a DM post). */
export async function dmSetHome(inst: OpenInstallation, userId: string, view: SlackHomeView, opts?: SlackCallOptions): Promise<void> {
  try {
    await setHomeView(inst.target.token, userId, view, opts);
  } catch (err) {
    await onSlackFailure(inst, err);
    throw err;
  }
}

/** The 10 s own controller (SLACK_LIMITS.ownTimeoutMs), never the job's signal (which may already be aborted). */
export function ownSignal(): AbortSignal {
  return AbortSignal.timeout(SLACK_LIMITS.ownTimeoutMs);
}

/** An already-aborted signal (C9: finishes a prepared turn as aborted with no model call). */
export function abortedSignal(): AbortSignal {
  const c = new AbortController();
  c.abort(new DOMException("The Slack reply ended before the turn ran", "AbortError"));
  return c.signal;
}

/** One draft card as it should be posted now: from its current view, or "unavailable" when the view can't be read. */
async function draftCardParts(principal: ExecPrincipal, draftId: string): Promise<{ parts: SlackMessageParts; view: DraftView | null; readFailed: boolean }> {
  try {
    const view = await getDraftView(principal, draftId);
    return { parts: renderDraftCard(view, { draftId }), view, readFailed: false };
  } catch (err) {
    console.warn(`[exec-slack] draft card ${logRef(draftId)}: view unavailable (${errLabel(err)})`);
    return { parts: renderDraftCard(null, { draftId, status: "unavailable" }), view: null, readFailed: true };
  }
}

/** A proposal card's view re-read by id (getProposalView): a withdrawn or redacted proposal then renders "removed". A read that
 *  fails, or finds no row, falls back to the turn's own view (RPC 7 (c) follows a redaction that lands after the post). */
async function proposalCardView(principal: ExecPrincipal, fromTurn: ProposalView): Promise<ProposalView> {
  try {
    return (await getProposalView(principal, fromTurn.id, new Date())) ?? fromTurn;
  } catch (err) {
    console.warn(`[exec-slack] proposal card ${logRef(fromTurn?.id)}: view unavailable (${errLabel(err)})`);
    return fromTurn;
  }
}

/** Post every card of an answer in the thread (C11), each recorded in the ledger with kind draft/proposal, messageId and refId,
 *  and schedule draft refreshes (sched = the calling job's id). Never throws: a card that fails is logged by id. After an
 *  auth-class failure the remaining cards are not tried (the token is dead; they count as failed). */
export async function postCards(principal: ExecPrincipal, inst: OpenInstallation, rootTs: string, messageId: string,
  cards: readonly CardView[], sched: string): Promise<{ posted: number; failed: number }> {
  let posted = 0;
  let failed = 0;
  let dead = false;
  for (const card of Array.isArray(cards) ? cards : []) {
    if (dead) {
      failed += 1;
      continue;
    }
    const refId = card?.kind === "task_proposal" ? card.proposal?.id : card?.kind === "draft" ? card.draftId : null;
    try {
      if (card.kind === "task_proposal") {
        // C42: from the proposal as it is now (a redaction may have landed since the turn built its card), else the turn's own view.
        const parts = renderProposalCard(await proposalCardView(principal, card.proposal), { proposalId: card.proposal.id });
        await dmPost(principal, inst, rootTs, parts, { kind: "proposal", messageId, refId: card.proposal.id }, { signal: ownSignal() });
        posted += 1;
      } else if (card.kind === "draft") {
        const { parts, view, readFailed } = await draftCardParts(principal, card.draftId);
        const { ts } = await dmPost(principal, inst, rootTs, parts, { kind: "draft", messageId, refId: card.draftId }, { signal: ownSignal() });
        posted += 1;
        // C11: a card still drafting (or one whose view couldn't be read yet) is refreshed until the draft settles.
        if (readFailed || view?.status === "generating") {
          await scheduleCardRefresh(principal, inst, { id: card.draftId, ts }, GENERATING_REFRESH_DELAYS_MS, sched);
        }
      } else {
        failed += 1;
      }
    } catch (err) {
      failed += 1;
      if (isSlackAuthError(err)) dead = true;
      console.error(`[exec-slack] card not posted (message ${logRef(messageId)}, card ${logRef(refId)}): ${errLabel(err)}`);
    }
  }
  return { posted, failed };
}

/** Enqueue exec.slack-card refreshes (C11 v2, reuse-7): for each delay i in delaysMs, dedupe `slack-card:<ts>:<sched>:<i>`
 *  (sched = the scheduling job's id, so a second Regenerate or Save on the same card always gets fresh keys even though
 *  exec_jobs keeps finished rows' unique keys for 14 days), runAfter = now + delay, maxAttempts 1. Never throws (logged by ts). */
export async function scheduleCardRefresh(principal: ExecPrincipal, inst: OpenInstallation, card: { id: string; ts: string },
  delaysMs: readonly number[], sched: string): Promise<void> {
  const nowMs = Date.now();
  const delays = Array.isArray(delaysMs) ? delaysMs : [];
  for (let i = 0; i < delays.length; i++) {
    try {
      const delay = delays[i];
      if (!Number.isFinite(delay) || delay < 0) throw new TypeError("refresh delay must be a non-negative number");
      const payload: SlackCardPayload = {
        installation_id: inst.row.id,
        kind: "draft",
        id: card.id,
        channel_id: inst.row.dmChannelId,
        message_ts: card.ts,
        sched,
        i
      };
      await enqueueJob({
        kind: SLACK_JOB_KINDS.card,
        lane: "interactive",
        principalId: principal.id,
        payload: { ...payload },
        dedupeKey: `slack-card:${card.ts}:${sched}:${i}`,
        runAfter: new Date(nowMs + delay),
        maxAttempts: 1
      });
    } catch (err) {
      console.error(`[exec-slack] card refresh ${i} not scheduled (ts ${logTs(card?.ts)}): ${errLabel(err)}`);
    }
  }
}
