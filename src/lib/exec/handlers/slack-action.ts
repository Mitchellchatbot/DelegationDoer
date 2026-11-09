import "server-only";

import { storedTurnPayload } from "@/lib/exec/agent/turn";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import { loadConversation, loadTurnByMessageId } from "@/lib/exec/chat-store";
import type { ProposalView } from "@/lib/exec/chat/view-types";
import { SecretUnavailableError } from "@/lib/exec/crypto";
import { DraftRouteError, getDraftView, requestRegeneration, saveDraft } from "@/lib/exec/drafts";
import type { DraftErrorCode, DraftView, ExecDraftStatus } from "@/lib/exec/drafts-types";
import { rateLimit } from "@/lib/exec/http";
import { loadSettings } from "@/lib/exec/principal";
import { confirmProposal, dismissProposal, getProposalView } from "@/lib/exec/proposals";
import { dmUpdate, errLabel, isSlackAuthError, ownSignal, scheduleCardRefresh, slackCodeOf } from "@/lib/exec/slack-dm";
import { findAnswerBySlackTs, openInstallationById, recordChatFeedback, recordSlackError, resetPostFollowed } from "@/lib/exec/slack-install";
import { SLACK_ACTION_IDS, SLACK_JOB_KINDS, SLACK_LIMITS, SLACK_RE, SLACK_VALUE_RE } from "@/lib/exec/slack-types";
import type { OpenInstallation, SlackActionId, SlackActionPayload, SlackMessageParts } from "@/lib/exec/slack-types";
import { draftNeedsDdCheck, renderAnswer, renderDraftCard, renderProposalCard, type DraftCardStatus, type ProposalCardStatus } from "@/lib/exec/slack-ui";
import { AuditUnavailableError, NonRetryableError, type ExecPrincipal, type JobContext, type JobHandler } from "@/lib/exec/types";

// exec.slack-action (P6 contract §3.11.2, K8, C11-C16, C41, C46; Area D):
// one button click on a card or an answer in his DM. Interactive lane,
// 420 s, one attempt (RPC 2 enqueues it, dedupe slack-act:<trigger_id>).
// The value carries id + version (or the content hash); the job re-reads the
// row and acts through P4's and P5b's own functions, which are idempotent by
// CAS. Every card update is chat.update on the container message's ts (C12:
// never the interaction's reply URL). Nothing here sends an email (K8): Save writes a
// draft to his Outlook Drafts, never Send, and a draft that read other
// email, team notes or other clients' records is saved only in DD (C15).
// Returns ids, counts and codes only (rule 9, B-P6-5).

export type SlackActionResult = { skipped: string } | { action: SlackActionId; outcome: string; cardUpdated: boolean } | { action: SlackActionId; failed: string };

const KIND = SLACK_JOB_KINDS.action;
/** C11 v2 (reuse-7): Save refreshes its card at +30 s and +120 s; Regenerate at +20 s, +60 s and +180 s. */
export const SAVE_REFRESH_DELAYS_MS: readonly number[] = Object.freeze([30_000, 120_000]);
export const REGENERATE_REFRESH_DELAYS_MS: readonly number[] = Object.freeze([20_000, 60_000, 180_000]);
/** C46: P5b's proposal gate, as its routes use it. */
const PROPOSAL_RATE_LIMIT = 30;
const PROPOSAL_RATE_WINDOW_MS = 600_000;

type Family = "draft" | "proposal" | "feedback";
// P8 (stage-0 seed, §3.21.3): the check-in buttons are SlackActionIds too, but they never reach exec.slack-action (P8's
// RPC 2 v2 enqueues exec.checkin-send / exec.checkin-rewrite), so they have no family here and a payload naming one is
// refused like an unknown action.
const FAMILY: Readonly<Record<SlackActionId, Family | null>> = Object.freeze({
  ea_draft_save: "draft",
  ea_draft_regen: "draft",
  ea_card_refresh: "draft",
  ea_task_create: "proposal",
  ea_task_dismiss: "proposal",
  ea_fb_up: "feedback",
  ea_fb_down: "feedback",
  ea_ci_send: null,
  ea_ci_rewrite: null
});

/** The payload RPC 2 wrote, shape-checked; null for anything else. */
export function parseActionPayload(raw: unknown): SlackActionPayload | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.installation_id !== "string" || !SLACK_RE.installationId.test(p.installation_id)) return null;
  if (typeof p.action_id !== "string" || !(SLACK_ACTION_IDS as readonly string[]).includes(p.action_id)) return null;
  if (FAMILY[p.action_id as SlackActionId] === null) return null;
  if (typeof p.value !== "string" || typeof p.channel_id !== "string" || !SLACK_RE.dm.test(p.channel_id)) return null;
  if (typeof p.message_ts !== "string" || !SLACK_RE.ts.test(p.message_ts)) return null;
  return { installation_id: p.installation_id, action_id: p.action_id as SlackActionId, value: p.value, channel_id: p.channel_id, message_ts: p.message_ts };
}

type ParsedValue =
  | { family: "draft"; id: string; version: number }
  | { family: "proposal"; id: string; hash: string }
  | { family: "feedback"; id: string };

/** C14: the button value for the action's family; anything else (incl. v1's ".p" suffix, over 200 characters) is null. */
export function parseActionValue(actionId: SlackActionId, value: string): ParsedValue | null {
  if (typeof value !== "string" || value.length === 0 || value.length > SLACK_LIMITS.actionValueChars) return null;
  const family = FAMILY[actionId];
  if (family === null) return null;
  if (family === "draft") {
    const m = SLACK_VALUE_RE.draft.exec(value);
    if (!m) return null;
    const version = Number(m[2]);
    return Number.isSafeInteger(version) ? { family, id: m[1], version } : null;
  }
  if (family === "proposal") {
    const m = SLACK_VALUE_RE.proposal.exec(value);
    return m ? { family, id: m[1], hash: m[2] } : null;
  }
  const m = SLACK_VALUE_RE.feedback.exec(value);
  return m ? { family: "feedback", id: m[1] } : null;
}

/** AX03 (AM7): saveDraft's returned { status, code } → the card's status; undefined = the view's own. Never draftStatus.failed. */
export function savedCardStatus(status: ExecDraftStatus, code: string | null): DraftCardStatus | undefined {
  if (status === "saved") return "saved";
  if (status === "saving") return "saving";
  if (status !== "draft") return undefined;
  switch (code) {
    case "outlook_changed":
      return "outlookChanged";
    case "throttled":
      return "rateLimited";
    case "ea_auth":
    case "mailbox_reconnect":
    case "mailbox_not_connected":
      return "unavailable";
    default:
      return "saveFailed";
  }
}

/** AX03: a thrown DraftRouteError's code → the card's status. catchAll: saveFailed (Save) or failed (Regenerate). */
export function refusalCardStatus(code: DraftErrorCode | string, catchAll: "saveFailed" | "failed"): DraftCardStatus {
  switch (code) {
    case "version_conflict":
    case "state_conflict":
      return "changed";
    case "placeholders":
    case "empty_body":
    case "subject_required":
    case "unsafe_markup":
      return "needsEdit";
    case "recipients_blocked":
      return "recipients";
    case "review_required":
    case "review_expired":
    case "acks_missing":
    case "hold":
    case "sent_copy_found":
      return "checkInDd";
    case "rate_limited":
      return "rateLimited";
    case "drafts_off":
    case "drafts_unavailable":
    case "mailbox_problem":
    case "send_off":
    case "send_unavailable":
    case "thread_unavailable":
    case "audit_unavailable":
    case "unavailable":
      return "unavailable";
    case "not_found":
    case "forbidden":
      return "gone";
    case "private_refs_unconfirmed":
      return "privateRefs";
    default:
      return catchAll;
  }
}

function asDraftRouteError(err: unknown): { code: string } | null {
  if (err instanceof DraftRouteError) return err;
  if (typeof err !== "object" || err === null) return null;
  const e = err as { name?: unknown; code?: unknown; httpStatus?: unknown };
  return e.name === "DraftRouteError" && typeof e.code === "string" && typeof e.httpStatus === "number" ? { code: e.code } : null;
}

/** Create task on a proposal another job is confirming: re-read every second for up to 10 s (the job's budget is 420 s). */
export const PROPOSAL_SETTLE_POLL_MS = 1_000;
export const PROPOSAL_SETTLE_MAX_MS = 10_000;

/** The proposal's view once it is no longer "confirming" (or the last read after PROPOSAL_SETTLE_MAX_MS, or null when gone). */
async function settledProposalView(principal: ExecPrincipal, id: string, signal: AbortSignal): Promise<ProposalView | null> {
  const startedMs = Date.now();
  for (;;) {
    const view = await getProposalView(principal, id, new Date());
    if (view === null || view.status !== "confirming" || signal.aborted || Date.now() - startedMs >= PROPOSAL_SETTLE_MAX_MS) return view;
    await new Promise<void>((resolve) => setTimeout(resolve, PROPOSAL_SETTLE_POLL_MS));
  }
}

const isAuditUnavailable = (err: unknown): boolean =>
  err instanceof AuditUnavailableError || (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AuditUnavailableError");

/** What the final chat.update shows. */
type CardPlan =
  | { kind: "draft"; id: string; view: DraftView | null; status?: DraftCardStatus }
  | { kind: "proposal"; id: string; view: ProposalView | null; status?: ProposalCardStatus }
  | { kind: "answer"; parts: SlackMessageParts }
  | { kind: "leave" };

interface Outcome { outcome: string; ok: boolean; plan: CardPlan }

function partsOf(plan: CardPlan): SlackMessageParts | null {
  switch (plan.kind) {
    case "draft":
      return renderDraftCard(plan.view, { draftId: plan.id, ...(plan.status ? { status: plan.status } : {}) });
    case "proposal":
      return renderProposalCard(plan.view, { proposalId: plan.id, ...(plan.status ? { status: plan.status } : {}) });
    case "answer":
      return plan.parts;
    default:
      return null;
  }
}

async function runAction(ctx: JobContext): Promise<SlackActionResult> {
  const principal: ExecPrincipal | null = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  // 1. Shape, installation, the DM this click came from.
  const p = parseActionPayload(ctx.job.payload);
  if (!p) return { skipped: "bad_payload" };
  let inst: OpenInstallation | null;
  try {
    inst = await openInstallationById(principal, p.installation_id);
  } catch (err) {
    if (err instanceof SecretUnavailableError) {
      await recordSlackError(p.installation_id, "token_unavailable");
      throw new NonRetryableError("slack token unavailable", "auth");
    }
    throw err;
  }
  if (!inst || p.channel_id !== inst.row.dmChannelId) return { skipped: "installation" };
  const open: OpenInstallation = inst;
  const action = p.action_id;
  const messageTs = p.message_ts;
  const sched = String(ctx.job.id);
  const log = (what: string, err: unknown) => console.error(`[exec-slack] action ${action} job ${sched}: ${what} (${errLabel(err)})`);

  // 2. The value, for the action's family.
  const v = parseActionValue(action, p.value);
  if (!v) return { skipped: "bad_value" };
  const id = v.id;

  // Reads for a card re-render that must not fail the job (a failed read renders the status line alone).
  const draftViewOrNull = async (): Promise<DraftView | null> => {
    try {
      return await getDraftView(principal, id);
    } catch (err) {
      log("draft view unavailable", err);
      return null;
    }
  };
  const proposalViewOrNull = async (): Promise<ProposalView | null> => {
    try {
      return await getProposalView(principal, id, new Date());
    } catch (err) {
      log("proposal view unavailable", err);
      return null;
    }
  };
  /** The card as it is now, with a failure status: saveFailed for Save, failed for the rest (build-7). */
  const failurePlan = async (): Promise<CardPlan> => {
    if (v.family === "draft") return { kind: "draft", id, view: await draftViewOrNull(), status: action === "ea_draft_save" ? "saveFailed" : "failed" };
    if (v.family === "proposal") return { kind: "proposal", id, view: await proposalViewOrNull(), status: "failed" };
    return { kind: "leave" };
  };
  /** The final card update, on the own controller. An auth-class error is rethrown (slack-dm.ts recorded it). The update
   *  rendered rows read before it landed, so the post's follow marker is reset (C42): a redaction the sweep followed in
   *  between is re-checked by the next sweep. */
  const show = async (plan: CardPlan): Promise<boolean> => {
    const parts = partsOf(plan);
    if (parts === null) return false;
    try {
      await dmUpdate(open, messageTs, parts, { signal: ownSignal() });
      await resetPostFollowed(open.row.id, messageTs);
      return true;
    } catch (err) {
      if (isSlackAuthError(err)) throw err;
      log("card not updated", err);
      return false;
    }
  };

  // 3. Gates and audit.
  let auditId: number;
  try {
    if (v.family === "proposal") {
      // C46 (reuse-4), in P5b's route order: chat on, the proposal limiter, then the audit.
      const settings = await loadSettings(principal.id);
      if (!(settings.chatSchemaReady && settings.chatEnabled)) {
        const cardUpdated = await show({ kind: "proposal", id, view: await proposalViewOrNull(), status: "chatOff" });
        return { action, outcome: "chat_off", cardUpdated };
      }
      const limited = await rateLimit(principal, "proposal", PROPOSAL_RATE_LIMIT, PROPOSAL_RATE_WINDOW_MS);
      if (!limited.ok) {
        const status: ProposalCardStatus = limited.response.status === 429 ? "rateLimited" : "failed";
        const cardUpdated = await show({ kind: "proposal", id, view: await proposalViewOrNull(), status });
        return { action, outcome: status === "rateLimited" ? "rate_limited" : "limiter_unavailable", cardUpdated };
      }
      auditId = await auditStart(principal, {
        actor: "slack",
        action: action === "ea_task_create" ? "chat.proposal.confirm" : "chat.proposal.dismiss",
        target: `exec_task_proposals:${id}`,
        input: { proposalId: id }
      });
    } else {
      auditId = await auditStart(principal, { actor: "slack", action: "slack.action", target: `${action}:${id}`, input: { actionId: action, id } });
    }
  } catch (err) {
    if (!isAuditUnavailable(err)) throw err;
    // The card, never a renderNote sentence (build-7); a feedback click leaves the message as it is.
    await show(await failurePlan());
    return { action, failed: "audit_unavailable" };
  }

  /** The Save card's interim "saving" line: best effort, so a Slack hiccup never stops the save (auth errors rethrow). */
  const interim = async (view: DraftView): Promise<void> => {
    try {
      await dmUpdate(open, messageTs, renderDraftCard(view, { draftId: id, status: "saving" }), { signal: ownSignal() });
    } catch (err) {
      if (isSlackAuthError(err)) throw err;
      log("saving line not shown", err);
    }
  };
  /** A refusal from P4 (DraftRouteError) or its audit outage → the mapped status on a fresh view. Anything else rethrows. */
  const refusal = async (err: unknown, catchAll: "saveFailed" | "failed"): Promise<Outcome> => {
    const routeError = asDraftRouteError(err);
    if (!routeError && !isAuditUnavailable(err)) throw err;
    const status: DraftCardStatus = routeError ? refusalCardStatus(routeError.code, catchAll) : "unavailable";
    const fresh = await getDraftView(principal, id);
    // AM7: "gone" is forced only when the row really is gone; a restricted row renders "hidden" from its own view.
    const plan: CardPlan = fresh === null ? { kind: "draft", id, view: null, status: "gone" } : status === "gone" ? { kind: "draft", id, view: fresh } : { kind: "draft", id, view: fresh, status };
    return { outcome: routeError ? routeError.code : "audit_unavailable", ok: false, plan };
  };

  // 4. By action. Every DD-side failure lands in the catch-all (5).
  let result: Outcome;
  try {
    switch (action) {
      case "ea_draft_save": {
        if (v.family !== "draft") throw new TypeError("value family");
        const view = await getDraftView(principal, id);
        if (!view) result = { outcome: "gone", ok: false, plan: { kind: "draft", id, view: null, status: "gone" } };
        else if (view.restricted) result = { outcome: "restricted", ok: false, plan: { kind: "draft", id, view } };
        else if (view.version !== v.version) result = { outcome: "changed", ok: false, plan: { kind: "draft", id, view, status: "changed" } };
        else if (view.usesPrivateRefs) result = { outcome: "private_refs", ok: false, plan: { kind: "draft", id, view, status: "privateRefs" } };
        // DD shows its injection and "check before sending" warnings next to the draft; Slack shows neither, so it isn't saved here.
        else if (draftNeedsDdCheck(view)) result = { outcome: "check_in_dd", ok: false, plan: { kind: "draft", id, view, status: "checkInDd" } };
        else {
          // reuse-7: the refreshes first, so a save that outlives this job still refreshes its card.
          await scheduleCardRefresh(principal, open, { id, ts: messageTs }, SAVE_REFRESH_DELAYS_MS, sched);
          await interim(view);
          try {
            // C15: never confirmPrivate.
            const saved = await saveDraft(principal, id, { version: v.version });
            const status = savedCardStatus(saved.status, saved.code);
            result = {
              outcome: saved.status === "draft" ? (saved.code ?? "save_failed") : saved.status,
              ok: saved.status === "saved" || saved.status === "saving",
              plan: { kind: "draft", id, view: saved.view, ...(status ? { status } : {}) }
            };
          } catch (err) {
            result = await refusal(err, "saveFailed");
          }
        }
        break;
      }
      case "ea_draft_regen": {
        if (v.family !== "draft") throw new TypeError("value family");
        const view = await getDraftView(principal, id);
        if (!view) result = { outcome: "gone", ok: false, plan: { kind: "draft", id, view: null, status: "gone" } };
        else if (view.restricted) result = { outcome: "restricted", ok: false, plan: { kind: "draft", id, view } };
        else if (view.version !== v.version) result = { outcome: "changed", ok: false, plan: { kind: "draft", id, view, status: "changed" } };
        else {
          await scheduleCardRefresh(principal, open, { id, ts: messageTs }, REGENERATE_REFRESH_DELAYS_MS, sched);
          try {
            const next = await requestRegeneration(principal, id, { version: v.version });
            result = { outcome: "regenerating", ok: true, plan: { kind: "draft", id, view: next, status: "drafting" } };
          } catch (err) {
            result = await refusal(err, "failed");
          }
        }
        break;
      }
      case "ea_card_refresh": {
        const view = await getDraftView(principal, id);
        result = { outcome: view ? "refreshed" : "gone", ok: view !== null, plan: { kind: "draft", id, view } };
        break;
      }
      case "ea_task_create": {
        if (v.family !== "proposal") throw new TypeError("value family");
        const out = await confirmProposal(principal, id, new Date(), { contentHash: v.hash });
        if (out.kind === "changed") {
          result = { outcome: "changed", ok: false, plan: { kind: "proposal", id, view: out.proposal, status: "changed" } };
        } else if (out.kind === "not_found") {
          result = { outcome: "not_found", ok: false, plan: { kind: "proposal", id, view: null, status: "removed" } };
        } else if (out.kind === "in_progress") {
          // Another click holds the confirm (a double click enqueues two jobs). Wait for it to settle and show the proposal's
          // own state (confirmed → created with its link), so this job's update can't leave "Creating…" over a created task.
          const view = await settledProposalView(principal, id, ctx.signal);
          result = { outcome: out.kind, ok: false, plan: { kind: "proposal", id, view, ...(view === null ? { status: "creating" as const } : {}) } };
        } else {
          const status: ProposalCardStatus | undefined =
            out.kind === "confirmed" ? "created"
            : out.kind === "expired" ? "expired"
            : out.kind === "assignee_unavailable" ? "assignee"
            : undefined;
          const view = await getProposalView(principal, id, new Date());
          result = { outcome: out.kind, ok: out.kind === "confirmed", plan: { kind: "proposal", id, view, ...(status ? { status } : {}) } };
        }
        break;
      }
      case "ea_task_dismiss": {
        if (v.family !== "proposal") throw new TypeError("value family");
        const view = await getProposalView(principal, id, new Date());
        if (!view) result = { outcome: "not_found", ok: false, plan: { kind: "proposal", id, view: null, status: "removed" } };
        else if (view.contentHash !== v.hash) result = { outcome: "changed", ok: false, plan: { kind: "proposal", id, view, status: "changed" } };
        else {
          const out = await dismissProposal(principal, id, new Date());
          if (out.kind === "not_found") result = { outcome: "not_found", ok: false, plan: { kind: "proposal", id, view: null, status: "removed" } };
          else {
            const fresh = await getProposalView(principal, id, new Date());
            result = {
              outcome: out.kind,
              ok: out.kind === "dismissed",
              plan: { kind: "proposal", id, view: fresh, ...(out.kind === "dismissed" ? { status: "dismissed" as const } : {}) }
            };
          }
        }
        break;
      }
      case "ea_fb_up":
      case "ea_fb_down": {
        const vote: 1 | -1 = action === "ea_fb_up" ? 1 : -1;
        const found = await findAnswerBySlackTs(principal, messageTs);
        if (!found || found.messageId !== id) {
          result = { outcome: "not_answer", ok: false, plan: { kind: "leave" } };
          break;
        }
        if ((await recordChatFeedback(principal, id, vote, "slack")) === "not_found") {
          result = { outcome: "not_found", ok: false, plan: { kind: "leave" } };
          break;
        }
        // C41 (AM10): re-render from the stored turn, as P5b's replay does.
        const turn = await loadTurnByMessageId(principal, id);
        const loaded = turn ? await loadConversation(principal, found.conversationId, { maxTurns: 1, surface: "slack" }) : null;
        if (!turn || !turn.assistant || turn.assistant.id !== id || !loaded) {
          result = { outcome: "recorded", ok: true, plan: { kind: "leave" } };
          break;
        }
        const payload = await storedTurnPayload(principal, loaded.conversation, turn, new Date());
        result = { outcome: "recorded", ok: true, plan: { kind: "answer", parts: renderAnswer(payload, { feedback: vote, redacted: turn.assistant.redactedAt !== null }) } };
        break;
      }
      default:
        throw new TypeError("unknown action");
    }
  } catch (err) {
    // 5. Catch-all (build-7): an auth-class Slack error is rethrown; anything else re-renders the card with the failure
    //    status, so the buttons are never left live with no message.
    if (isSlackAuthError(err)) {
      await auditFinish(auditId, { ok: false, error: "slack_auth" });
      throw err;
    }
    log("action failed", err);
    try {
      await show(await failurePlan());
    } finally {
      await auditFinish(auditId, { ok: false, error: "internal" });
    }
    return { action, failed: slackCodeOf(err) ?? "internal" };
  }

  let cardUpdated: boolean;
  try {
    cardUpdated = await show(result.plan);
  } catch (err) {
    await auditFinish(auditId, { ok: false, result: { outcome: result.outcome }, error: "slack_auth" });
    throw err;
  }
  await auditFinish(auditId, { ok: result.ok, result: { outcome: result.outcome } });
  return { action, outcome: result.outcome, cardUpdated };
}

export const SLACK_ACTION_TIMEOUT_MS = SLACK_LIMITS.actionTimeoutMs;

export const slackActionJobHandler: JobHandler = {
  kind: KIND,
  lane: "interactive",
  timeoutMs: SLACK_ACTION_TIMEOUT_MS,
  run: (ctx: JobContext) => runAction(ctx)
};
