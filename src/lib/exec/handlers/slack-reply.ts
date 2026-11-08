import "server-only";

import { logAccess } from "@/lib/exec/access";
import { newConversationTitle, prepareChatTurn, runPreparedTurn, type ChatTurnRequest, type PreparedTurn } from "@/lib/exec/agent/turn";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import { SecretUnavailableError } from "@/lib/exec/crypto";
import { loadSettings } from "@/lib/exec/principal";
import { readDmMessage } from "@/lib/exec/sources/slack";
import { abortedSignal, asSlackApiError, dmDelete, dmPost, dmRead, dmUpdate, errLabel, ownSignal, postCards } from "@/lib/exec/slack-dm";
import { conversationForThread, openInstallationById, recordSlackError, replyStep } from "@/lib/exec/slack-install";
import { slackTextToPlain } from "@/lib/exec/slack-text";
import { SLACK_JOB_KINDS, SLACK_LIMITS, SLACK_RE, slackClientTurnId } from "@/lib/exec/slack-types";
import type { OpenInstallation, ReplyState, SlackReplyPayload } from "@/lib/exec/slack-types";
import { renderAnswer, renderNote, renderPlaceholder, type SlackNoteKey } from "@/lib/exec/slack-ui";
import { AuditUnavailableError, NonRetryableError, type ExecPrincipal, type ExecSettings, type JobContext, type JobHandler } from "@/lib/exec/types";

// exec.slack-reply (P6 contract §3.11.1, K9, C6-C10, C39, C40; Area D):
// one DM from Mitchell → one P5b chat turn → the answer in his thread.
// Interactive lane, 300 s, one attempt (RPC 1 enqueues it with max_attempts
// 1, dedupe slack-reply:<event_id>). The payload holds references only; the
// DM text is re-read from Slack here and never stored outside P5b's own rows.
//
// The job keeps local state (reuse-2) and its `finally` acts on it, not only
// on the database: every exit leaves a fixed note in the thread, the prepared
// turn is always finished (an already-aborted signal when the model never
// ran, C9 / P5b C55), and the audit row is always closed. A lost CAS means
// the sweep owns the reply (C8): the job then cleans up what it posted and
// posts nothing else. Returns ids, counts and codes only (rule 9, B-P6-5).

export type SlackReplyResult =
  | { skipped: string }
  | { late: true }
  | { status: string; cards: number; cardsFailed: number };

const KIND = SLACK_JOB_KINDS.reply;
type Started = Extract<PreparedTurn, { kind: "started" }>;

/** The payload RPC 1 wrote, shape-checked; null for anything else. */
export function parseReplyPayload(raw: unknown): SlackReplyPayload | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const str = (v: unknown, re: RegExp): v is string => typeof v === "string" && re.test(v);
  if (!str(p.event_id, SLACK_RE.eventId) || !str(p.installation_id, SLACK_RE.installationId) || !str(p.channel, SLACK_RE.dm)) return null;
  if (!str(p.ts, SLACK_RE.ts)) return null;
  const threadTs = p.thread_ts === undefined || p.thread_ts === null ? null : p.thread_ts;
  if (threadTs !== null && !str(threadTs, SLACK_RE.ts)) return null;
  const eventTime = p.event_time;
  if (typeof eventTime !== "number" || !Number.isSafeInteger(eventTime) || eventTime <= 0) return null;
  return { event_id: p.event_id, installation_id: p.installation_id, channel: p.channel, ts: p.ts, thread_ts: threadTs, event_time: eventTime };
}

/** Code points, as the begin RPC's char_length CHECK counts them. */
const charCount = (s: string): number => {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
};

async function runReply(ctx: JobContext): Promise<SlackReplyResult> {
  const principal: ExecPrincipal | null = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  const p = parseReplyPayload(ctx.job.payload);
  if (!p) throw new NonRetryableError("bad payload");
  const eventId = p.event_id;
  const root = p.thread_ts ?? p.ts;
  const jobSignal = ctx.signal;

  // Local state (reuse-2).
  let owned = false;
  let inst: OpenInstallation | null = null;
  let phTs: string | null = null;
  let prepared: Started | null = null;
  let turnRan = false;
  let answerPosted = false;
  let notePosted = false;
  let auditId: number | null = null;
  let auditDone = false;
  let settings: ExecSettings | null = null;
  let req: ChatTurnRequest | null = null;

  const log = (what: string, err: unknown) => console.error(`[exec-slack] reply ${eventId}: ${what} (${errLabel(err)})`);

  /** A terminal or job-side CAS; any answer (won or lost) hands the reply over (owned = false). */
  const settle = async (from: readonly ReplyState[], to: ReplyState): Promise<boolean> => {
    const won = await replyStep(eventId, from, to);
    owned = false;
    return won;
  };
  const note = async (key: SlackNoteKey, vars?: Record<string, number>): Promise<void> => {
    if (!inst) return;
    await dmPost(principal, inst, root, renderNote(key, vars), { kind: "note" }, { signal: ownSignal() });
    notePosted = true;
  };
  const finishAudit = async (ok: boolean, result: Record<string, unknown>): Promise<void> => {
    if (auditId === null || auditDone) return;
    auditDone = true;
    await auditFinish(auditId, { ok, result });
  };

  // 2. The sweep may have taken the row first (C8).
  if (!(await replyStep(eventId, ["queued"], "started"))) return { skipped: "state" };
  owned = true;

  try {
    // 3. His installation, by id, still active, with the DM this event came from.
    try {
      inst = await openInstallationById(principal, p.installation_id);
    } catch (err) {
      if (err instanceof SecretUnavailableError) {
        await recordSlackError(p.installation_id, "token_unavailable");
        await settle(["started"], "failed");
        throw new NonRetryableError("slack token unavailable", "auth");
      }
      throw err;
    }
    if (!inst || inst.row.dmChannelId !== p.channel) {
      inst = null;
      await settle(["started"], "skipped");
      return { skipped: "installation" };
    }
    const open = inst;

    // 4. C40: one access-log row per handled DM.
    await logAccess({
      principalId: principal.id,
      authUserId: null,
      sessionId: null,
      ip: null,
      userAgent: null,
      route: "slack:message.im",
      surface: "slack",
      slackUserId: open.row.userId,
      slackEventId: eventId
    });

    // 5. Stale guard (security-4): the older of the envelope's dispatch time and the message's own post time.
    const sentSec = Math.min(p.event_time, Math.floor(Number(p.ts)));
    if (Date.now() - 1000 * sentSec > SLACK_LIMITS.staleEventMs) {
      await note("late");
      await settle(["started"], "skipped");
      return { late: true };
    }

    // 6. Re-read the message (the payload holds no text, K7).
    const msg = await dmRead(open, (target) => readDmMessage(target, { channel: p.channel, ts: p.ts, threadTs: p.thread_ts }, { signal: jobSignal }));
    if (!msg) {
      await settle(["started"], "skipped");
      return { skipped: "message_gone" };
    }
    if (msg.user !== open.row.userId || msg.botId || msg.appId || msg.subtype || msg.hidden || typeof msg.text !== "string") {
      await settle(["started"], "skipped");
      return { skipped: "not_his_message" };
    }

    // 7. The question.
    const question = slackTextToPlain(msg.text);
    if (question.trim().length === 0) {
      await settle(["started"], "skipped");
      return { skipped: "empty" };
    }
    if (charCount(question) > SLACK_LIMITS.questionChars) {
      await note("tooLong");
      await settle(["started"], "skipped");
      return { skipped: "too_long" };
    }

    // 8. Chat on.
    settings = await loadSettings(principal.id);
    if (!(settings.chatSchemaReady && settings.chatEnabled)) {
      await note("chatOff");
      await settle(["started"], "skipped");
      return { skipped: "chat_off" };
    }

    // 9. C39: the turn's audit row (ids and counts only).
    try {
      auditId = await auditStart(principal, {
        actor: "slack",
        action: "chat.turn",
        target: `exec_slack_events:${eventId}`,
        input: { surface: "slack", textChars: question.length }
      });
    } catch (err) {
      if (!(err instanceof AuditUnavailableError)) throw err;
      await note("failed");
      await settle(["started"], "failed");
      return { skipped: "audit_unavailable" };
    }

    // 10. One conversation per thread (C6), then P5b's begin (C7).
    const conversationId = await conversationForThread(principal, {
      channel: p.channel,
      rootTs: root,
      title: newConversationTitle(question),
      retentionDays: settings.retentionDaysChat
    });
    req = { conversationId, clientTurnId: slackClientTurnId(p.ts), surface: "slack", text: question, context: null };
    const prep = await prepareChatTurn(principal, settings, req, new Date(), { timeoutMs: 10_000 });
    switch (prep.kind) {
      case "replay":
        await settle(["started"], "skipped");
        await finishAudit(true, { outcome: "replay" });
        return { skipped: "replay" };
      case "busy":
      case "busy_principal":
      case "rate_limited": {
        if (prep.kind === "busy") await note("busyThread");
        else if (prep.kind === "busy_principal") await note("busyPrincipal");
        else await note("rateLimited", { minutes: Math.max(1, Math.ceil(prep.retryAfterSeconds / 60)) });
        await settle(["started"], "skipped");
        await finishAudit(false, { outcome: prep.kind });
        return { skipped: prep.kind };
      }
      case "not_found":
      case "context_unavailable":
        await note("failed");
        await settle(["started"], "failed");
        await finishAudit(false, { outcome: prep.kind });
        return { skipped: prep.kind };
      case "started":
        prepared = prep;
        break;
      default:
        throw new Error("unknown prepare outcome");
    }
    const started: Started = prepared;
    const begin = started.begin;

    // 11. The placeholder, then its ts on the event row and the exec_messages row BEFORE the model call (K9).
    const ph = await dmPost(principal, open, root, renderPlaceholder(), { kind: "answer", messageId: begin.assistantMessageId }, { signal: jobSignal });
    phTs = ph.ts;
    const placed = await replyStep(eventId, ["started"], "placeholder", {
      placeholderTs: phTs,
      conversationId: begin.conversationId,
      assistantMessageId: begin.assistantMessageId
    });
    if (!placed) {
      // The sweep took the row (reuse-1, build-5): take the placeholder back, post nothing else.
      owned = false;
      try {
        await dmDelete(open, phTs, { signal: ownSignal() });
      } catch (err) {
        log("placeholder not deleted", err);
        try {
          await dmUpdate(open, phTs, renderNote("stale"), { signal: ownSignal() });
        } catch (err2) {
          log("placeholder not updated", err2);
        }
      }
      await finishAudit(false, { outcome: "swept" });
      return { skipped: "swept" };
    }

    // 12. The turn, on the job's signal (C10: the 300 s job timeout bounds it), no sink.
    turnRan = true;
    const { done, audit } = await runPreparedTurn(principal, settings, started, req, { signal: jobSignal, now: new Date() });

    // 13. The answer replaces the placeholder, on the own controller (the job's may have fired).
    const parts = done.status === "aborted" ? renderNote("timedOut") : renderAnswer(done, { feedback: null });
    try {
      await dmUpdate(open, phTs, parts, { signal: ownSignal() });
    } catch (err) {
      const e = asSlackApiError(err);
      if (!e || e.errorClass !== "fatal") throw err;
      // msg_too_long, invalid_blocks and the like: a fixed note instead.
      await dmUpdate(open, phTs, renderNote("unrenderable"), { signal: ownSignal() });
    }
    answerPosted = true;

    // 13b. The answer CAS, directly after the answer update and before any card (C8).
    if (!(await settle(["placeholder"], "answered"))) {
      try {
        await dmUpdate(open, phTs, renderNote("stale"), { signal: ownSignal() });
      } catch (err) {
        log("late stale note not written", err);
      }
      await finishAudit(false, { outcome: "swept_late" });
      return { skipped: "swept_late" };
    }

    // 14. The cards (C11), then the audit.
    const cards = await postCards(principal, open, root, begin.assistantMessageId, done.cards, String(ctx.job.id));
    await finishAudit(done.status !== "failed", {
      status: done.status,
      statusReason: done.statusReason,
      modelCalls: audit.modelCalls,
      toolCalls: audit.toolCalls,
      costUsd: audit.costUsd,
      cards: cards.posted,
      ...(typeof audit.slackVerbatimClipped === "number" && audit.slackVerbatimClipped > 0 ? { slackVerbatimClipped: audit.slackVerbatimClipped } : {})
    });
    return { status: done.status, cards: cards.posted, cardsFailed: cards.failed };
  } finally {
    // 15.1 C9: a prepared turn whose model never ran is finished aborted, with no model call.
    if (prepared && !turnRan && settings && req) {
      try {
        await runPreparedTurn(principal, settings, prepared, req, { signal: abortedSignal(), now: new Date() });
      } catch (err) {
        log("prepared turn not finished", err);
      }
    }
    // 15.2 Every exit leaves a fixed note, driven by what this job knows locally.
    if (owned) {
      const target = inst;
      if (answerPosted) {
        try {
          await replyStep(eventId, ["placeholder"], "answered");
        } catch (err) {
          log("answered state not written", err);
        }
      } else {
        if (target && phTs) {
          try {
            await dmUpdate(target, phTs, renderNote(jobSignal.aborted ? "timedOut" : "failed"), { signal: ownSignal() });
          } catch (err) {
            log("failure note not written", err);
          }
        } else if (target && !notePosted) {
          try {
            await dmPost(principal, target, root, renderNote("failed"), { kind: "note" }, { signal: ownSignal() });
          } catch (err) {
            log("failure note not posted", err);
          }
        }
        try {
          await replyStep(eventId, ["started", "placeholder"], "failed");
        } catch (err) {
          log("failed state not written", err);
        }
      }
      owned = false;
    }
    // 15.3
    if (auditId !== null && !auditDone) {
      auditDone = true;
      await auditFinish(auditId, { ok: false, error: "internal" });
    }
  }
}

export const SLACK_REPLY_TIMEOUT_MS = SLACK_LIMITS.replyTimeoutMs;

export const slackReplyJobHandler: JobHandler = {
  kind: KIND,
  lane: "interactive",
  timeoutMs: SLACK_REPLY_TIMEOUT_MS,
  run: (ctx: JobContext) => runReply(ctx)
};
