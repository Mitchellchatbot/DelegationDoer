import "server-only";

import { storedTurnPayload } from "@/lib/exec/agent/turn";
import { loadConversation, loadTurnByMessageId } from "@/lib/exec/chat-store";
import { SecretUnavailableError } from "@/lib/exec/crypto";
import { getDraftView } from "@/lib/exec/drafts";
import { enqueueJob } from "@/lib/exec/jobs";
import { loadSettings } from "@/lib/exec/principal";
import { getProposalView } from "@/lib/exec/proposals";
import type { ScheduledWork, SystemScheduledWork } from "@/lib/exec/scheduler";
import { listDmItems } from "@/lib/exec/sources/slack";
import { dmDelete, dmPost, dmRead, dmUpdate, errLabel, isSlackAuthError, ownSignal, slackCodeOf } from "@/lib/exec/slack-dm";
import {
  getActiveInstallation,
  isSlackSchemaMissing,
  listActiveInstallationsForSystem,
  listCardPostsForMessage,
  listOldSlackPosts,
  listOpenReplies,
  listRedactionFollowups,
  markPostFollowed,
  openActiveInstallation,
  openInstallationById,
  openInstallationForSystem,
  recordSlackError,
  replyStep,
  slackSchemaReady
} from "@/lib/exec/slack-install";
import { SLACK_JOB_KINDS, SLACK_LIMITS, SLACK_RE } from "@/lib/exec/slack-types";
import type { OpenInstallation, SlackMessageParts } from "@/lib/exec/slack-types";
import { renderAnswer, renderDraftCard, renderNote, renderProposalCard } from "@/lib/exec/slack-ui";
import type { ExecPrincipal, JobContext, JobHandler } from "@/lib/exec/types";

// The two scheduled Slack jobs (P6 contract §3.11.6-7; Area D), bulk lane,
// per enabled principal with an active installation.
//
// exec.slack-sweep (every 5 minutes, 60 s, one attempt):
//   1. Stale replies (C8 v2): an open reply whose LAST STATE CHANGE (updated_at,
//      never received_at) is over 10 minutes old is CAS'd to swept, then its
//      placeholder becomes the stale note (or the note is posted in its thread).
//      A lost CAS means the job finished it: nothing is posted. A note whose
//      Slack call fails after the CAS gets its own one-off retry (an
//      exec.slack-sweep job carrying the note, dedupe slack-stale:<event_id>,
//      three attempts), since no later sweep finds the closed row.
//   2. Redaction follow-ups (C42, security-1): answers P5b redacted after the bot
//      posted them, draft cards whose draft was restricted-purged, and proposal
//      cards whose proposal was redacted, are re-rendered from the stored state;
//      each post is marked followed with the timestamp RPC 7 READ (never now()),
//      only after its update landed.
// exec.slack-dm-purge (daily at 04:10 local, 120 s, two attempts; K12, C19):
//   the ledger's posts older than retention_days_chat first (replies under old
//   thread roots included), then a bounded history scan for posts the ledger
//   missed, deleting only messages whose bot_id is ours. ≤ 80 deletes and ≤ 5
//   listing calls per run; a rate limit ends the run early.
// Errors per item are logged by event id or ts; an auth-class Slack error stops
// a run (rethrown, recorded by slack-dm.ts). Returns counts only.
//
// P9 F16 (Area C): the DM purge is SYSTEM work now (slackDmPurgeSystemWork: daily at
// 04:10 UTC, principal_id null, runtime.ts's BUILT_IN_SYSTEM_SCHEDULE), as P8 made
// every DB retention step: a principal disabled by hand keeps an active
// installation, and the per-principal scheduler lists enabled principals only, so
// its bot DMs outlived retention_days_chat. The system pass purges every active
// installation (openInstallationForSystem) with its own principal's
// retention_days_chat; one failing installation doesn't stop the rest (the first
// failure is rethrown at the end). A per-principal row queued before P9 still runs
// once, for its principal, as before.

const SWEEP_KIND = SLACK_JOB_KINDS.sweep;
const PURGE_KIND = SLACK_JOB_KINDS.dmPurge;
const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
/** §3.11.6: a sweep starts no new item after 40 s (the rest waits for the next sweep). */
export const SWEEP_ITEM_BUDGET_MS = 40_000;
const OPEN_REPLY_LIMIT = 20;
/** chat.update / chat.delete answers for a message that no longer exists in Slack: done, nothing left to change. */
const MESSAGE_GONE_CODES: ReadonlySet<string> = new Set(["message_not_found", "cant_update_message"]);

export type SlackSweepResult = { skipped: string } | { swept: number; followed: number; noted?: number };
/** A stale note that failed after the swept CAS is retried by its own one-off sweep job: first at +30 s, three attempts. */
export const STALE_NOTE_RETRY_DELAY_MS = 30_000;
export const STALE_NOTE_RETRY_ATTEMPTS = 3;
export type SlackDmPurgeResult = { skipped: string } | { deleted: number; ledger: number; scanned: number; stoppedEarly: boolean }
  /** P9 F16: the system pass's totals over every active installation. */
  | { installations: number; deleted: number; ledger: number; scanned: number; stoppedEarly: number; tokenUnavailable: number; failed: number };
/** P9 F16: the most active installations one system pass purges (one per principal: a bound, not a quota). */
const SYSTEM_PURGE_INSTALLATIONS = 50;

/** The scheduler's gate for both schedules (Y4): an active installation exists. Schema missing → false; other errors throw. */
export async function slackWorkDue(principal: ExecPrincipal): Promise<boolean> {
  try {
    return (await getActiveInstallation(principal)) !== null;
  } catch (err) {
    if (isSlackSchemaMissing(err)) return false;
    throw err;
  }
}

/** Both handlers: the schema and the active installation, cheaply; null → skipped. */
async function activeInstallation(principal: ExecPrincipal): Promise<OpenInstallation | null | "not_installed" | "token_unavailable"> {
  if (!(await slackSchemaReady())) return "not_installed";
  try {
    return await openActiveInstallation(principal);
  } catch (err) {
    if (!(err instanceof SecretUnavailableError)) throw err;
    return "token_unavailable";
  }
}

const isMessageGone = (err: unknown): boolean => {
  const code = slackCodeOf(err);
  return code !== null && MESSAGE_GONE_CODES.has(code);
};

/** One follow-up update: true when it landed or the message is gone from Slack; false when it failed (retried next sweep). */
async function followUpdate(inst: OpenInstallation, ts: string, parts: SlackMessageParts): Promise<boolean> {
  try {
    await dmUpdate(inst, ts, parts, { signal: ownSignal() });
    return true;
  } catch (err) {
    if (isSlackAuthError(err)) throw err;
    if (isMessageGone(err)) return true;
    console.warn(`[exec-slack] follow-up not written (ts ${ts}): ${errLabel(err)}`);
    return false;
  }
}

async function runSweep(ctx: JobContext): Promise<SlackSweepResult> {
  const principal = ctx.principal;
  if (!principal) return { skipped: "no_principal" };
  // A one-off retry of a stale note (enqueueStaleNoteRetry) rather than the scheduled sweep.
  const retry = parseStaleNotePayload(ctx.job.payload);
  if (retry) return runStaleNoteRetry(principal, retry);
  const opened = await activeInstallation(principal);
  if (opened === null) return { skipped: "no_installation" };
  if (typeof opened === "string") {
    if (opened === "token_unavailable") {
      // The token can't be opened with our key: record it on the row (C34) and stop; nothing can be posted.
      const row = await getActiveInstallation(principal).catch(() => null);
      if (row) await recordSlackError(row.id, "token_unavailable");
    }
    return { skipped: opened };
  }
  const inst = opened;
  const startedMs = Date.now();
  const inBudget = () => Date.now() - startedMs < SWEEP_ITEM_BUDGET_MS;
  const now = new Date();
  let swept = 0;
  let followed = 0;

  // 1. Stale replies, by updated_at (C8 v2).
  const rows = await listOpenReplies(principal, {
    before: new Date(now.getTime() - SLACK_LIMITS.stalePlaceholderMs).toISOString(),
    since: new Date(now.getTime() - SLACK_LIMITS.eventRetentionHours * HOUR_MS).toISOString(),
    limit: OPEN_REPLY_LIMIT
  });
  for (const row of rows) {
    if (!inBudget()) break;
    let note: StaleNote | null = null;
    try {
      if (!(await replyStep(row.eventId, [row.replyState], "swept"))) continue;
      swept += 1;
      // Only into this installation's DM (a row of an earlier installation is closed, not posted to).
      if (row.installationId !== inst.row.id || row.channelId !== inst.row.dmChannelId) continue;
      note = { event_id: row.eventId, installation_id: inst.row.id, channel_id: inst.row.dmChannelId, placeholder_ts: row.placeholderTs, root_ts: row.threadTs ?? row.messageTs };
      await writeStaleNote(principal, inst, note);
    } catch (err) {
      if (isSlackAuthError(err)) throw err;
      console.error(`[exec-slack] sweep: reply ${row.eventId} not closed (${errLabel(err)})`);
      // The row is no longer open, so no later sweep finds it: the note gets its own retries (K9: every failure path
      // leaves a fixed note).
      if (note) await enqueueStaleNoteRetry(principal, note);
    }
  }

  // 2. Redaction follow-ups (C42).
  const f = await listRedactionFollowups(principal, inst.row.id, SLACK_LIMITS.followupsPerSweep);
  if (f !== null) {
    for (const a of f.answers) {
      if (!inBudget()) break;
      try {
        const turn = await loadTurnByMessageId(principal, a.messageId);
        const loaded = turn?.assistant ? await loadConversation(principal, a.conversationId, { maxTurns: 1, surface: "slack" }) : null;
        const parts =
          turn && turn.assistant && turn.assistant.id === a.messageId && loaded
            ? renderAnswer(await storedTurnPayload(principal, loaded.conversation, turn, now), { feedback: null, redacted: true })
            : renderNote("removed");
        if (!(await followUpdate(inst, a.ts, parts))) continue;
        // Every card of that answer, from its current view (withdrawn / redacted → removed; purged drafts → hidden / gone).
        let cardsDone = true;
        for (const card of await listCardPostsForMessage(principal, inst.row.id, a.messageId)) {
          const cardParts =
            card.kind === "proposal"
              ? renderProposalCard(await getProposalView(principal, card.refId, now), { proposalId: card.refId })
              : renderDraftCard(await getDraftView(principal, card.refId), { draftId: card.refId });
          if (!(await followUpdate(inst, card.ts, cardParts))) cardsDone = false;
        }
        if (!cardsDone) continue;
        await markPostFollowed(inst.row.id, a.ts, a.changedAt);
        followed += 1;
      } catch (err) {
        if (isSlackAuthError(err)) throw err;
        console.error(`[exec-slack] sweep: answer follow-up ${a.ts} failed (${errLabel(err)})`);
      }
    }
    for (const d of f.drafts) {
      if (!inBudget()) break;
      try {
        if (!(await followUpdate(inst, d.ts, renderDraftCard(await getDraftView(principal, d.draftId), { draftId: d.draftId })))) continue;
        await markPostFollowed(inst.row.id, d.ts, d.changedAt);
        followed += 1;
      } catch (err) {
        if (isSlackAuthError(err)) throw err;
        console.error(`[exec-slack] sweep: draft follow-up ${d.ts} failed (${errLabel(err)})`);
      }
    }
    // (c) Proposal cards on their own: a card the reply job posted after (a) had followed its answer.
    for (const t of f.proposals ?? []) {
      if (!inBudget()) break;
      try {
        const parts = renderProposalCard(await getProposalView(principal, t.proposalId, now), { proposalId: t.proposalId });
        if (!(await followUpdate(inst, t.ts, parts))) continue;
        await markPostFollowed(inst.row.id, t.ts, t.changedAt);
        followed += 1;
      } catch (err) {
        if (isSlackAuthError(err)) throw err;
        console.error(`[exec-slack] sweep: proposal follow-up ${t.ts} failed (${errLabel(err)})`);
      }
    }
  }
  return { swept, followed };
}

/** A stale note's references (rule 5: ids and ts values only): the sweep's own write, and its retry job's payload. */
export interface StaleNote { event_id: string; installation_id: string; channel_id: string; placeholder_ts: string | null; root_ts: string }

/** The stale note itself: the placeholder becomes the note, or (no placeholder yet) the note is posted in his thread. */
async function writeStaleNote(principal: ExecPrincipal, inst: OpenInstallation, note: StaleNote): Promise<void> {
  if (note.placeholder_ts) await dmUpdate(inst, note.placeholder_ts, renderNote("stale"), { signal: ownSignal() });
  else await dmPost(principal, inst, note.root_ts, renderNote("stale"), { kind: "note" }, { signal: ownSignal() });
}

/** The retry of a stale note whose write failed after the swept CAS: a one-off exec.slack-sweep job carrying the note,
 *  maxAttempts 3 (the runner's backoff), dedupe slack-stale:<event_id>. Never throws (logged by event id). */
async function enqueueStaleNoteRetry(principal: ExecPrincipal, note: StaleNote): Promise<void> {
  try {
    await enqueueJob({
      kind: SWEEP_KIND,
      lane: "bulk",
      principalId: principal.id,
      payload: { stale_note: { ...note } },
      dedupeKey: `slack-stale:${note.event_id}`,
      runAfter: new Date(Date.now() + STALE_NOTE_RETRY_DELAY_MS),
      maxAttempts: STALE_NOTE_RETRY_ATTEMPTS
    });
  } catch (err) {
    console.error(`[exec-slack] sweep: reply ${note.event_id} stale note retry not enqueued (${errLabel(err)})`);
  }
}

/** A sweep job's payload naming one stale note to (re)write; null for the scheduled sweep (or anything malformed). */
export function parseStaleNotePayload(raw: unknown): StaleNote | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const n = (raw as Record<string, unknown>).stale_note;
  if (typeof n !== "object" || n === null || Array.isArray(n)) return null;
  const p = n as Record<string, unknown>;
  const is = (v: unknown, re: RegExp): v is string => typeof v === "string" && re.test(v);
  if (!is(p.event_id, SLACK_RE.eventId) || !is(p.installation_id, SLACK_RE.installationId) || !is(p.channel_id, SLACK_RE.dm)) return null;
  if (!is(p.root_ts, SLACK_RE.ts)) return null;
  const placeholder = p.placeholder_ts === null || p.placeholder_ts === undefined ? null : p.placeholder_ts;
  if (placeholder !== null && !is(placeholder, SLACK_RE.ts)) return null;
  return { event_id: p.event_id, installation_id: p.installation_id, channel_id: p.channel_id, placeholder_ts: placeholder, root_ts: p.root_ts };
}

/** The retry job: the same note, into the same installation's DM only; a Slack failure throws so the runner retries it. */
async function runStaleNoteRetry(principal: ExecPrincipal, note: StaleNote): Promise<SlackSweepResult> {
  let inst: OpenInstallation | null;
  try {
    inst = await openInstallationById(principal, note.installation_id);
  } catch (err) {
    if (err instanceof SecretUnavailableError) return { skipped: "token_unavailable" };
    throw err;
  }
  if (!inst || inst.row.dmChannelId !== note.channel_id) return { skipped: "installation" };
  try {
    await writeStaleNote(principal, inst, note);
  } catch (err) {
    // The placeholder no longer exists in Slack (deleted by him or the DM purge): nothing left to change.
    if (isMessageGone(err)) return { skipped: "message_gone" };
    throw err;
  }
  return { swept: 0, followed: 0, noted: 1 };
}

/** A Slack ts for an instant: "<epoch seconds>.000000". */
export function slackTsOf(ms: number): string {
  return `${Math.floor(ms / 1000)}.000000`;
}

async function runDmPurge(ctx: JobContext): Promise<SlackDmPurgeResult> {
  const principal = ctx.principal;
  // P9 F16: the system job (principal_id null) purges every active installation.
  if (!principal) return runSystemDmPurge(ctx.signal);
  // A per-principal row queued before P9 (the old per-principal schedule) runs once, for its principal, as before.
  const opened = await activeInstallation(principal);
  if (opened === null) return { skipped: "no_installation" };
  if (typeof opened === "string") return { skipped: opened };
  const settings = await loadSettings(principal.id);
  return purgeInstallationDms(opened, settings.retentionDaysChat, ctx.signal);
}

/**
 * P9 F16: the system pass. Every active installation (its principal enabled or not; listActiveInstallationsForSystem), opened
 * by id without a principal (openInstallationForSystem), purged with ITS principal's retention_days_chat. A token our key can't
 * open is recorded on the row (C34) and counted; any other failure is logged by installation id, counted, and the first one is
 * rethrown after the rest ran (the job retries; every delete is idempotent). Counts only.
 */
async function runSystemDmPurge(signal: AbortSignal): Promise<SlackDmPurgeResult> {
  if (!(await slackSchemaReady())) return { skipped: "not_installed" };
  const out = { installations: 0, deleted: 0, ledger: 0, scanned: 0, stoppedEarly: 0, tokenUnavailable: 0, failed: 0 };
  let firstError: unknown = null;
  for (const row of await listActiveInstallationsForSystem(SYSTEM_PURGE_INSTALLATIONS, { signal })) {
    signal.throwIfAborted();
    try {
      let inst: OpenInstallation | null;
      try {
        inst = await openInstallationForSystem(row.id, { signal });
      } catch (err) {
        if (!(err instanceof SecretUnavailableError)) throw err;
        out.tokenUnavailable += 1;
        await recordSlackError(row.id, "token_unavailable");
        continue;
      }
      if (inst === null) continue;
      const settings = await loadSettings(row.principalId);
      const r = await purgeInstallationDms(inst, settings.retentionDaysChat, signal);
      out.installations += 1;
      out.deleted += r.deleted;
      out.ledger += r.ledger;
      out.scanned += r.scanned;
      if (r.stoppedEarly) out.stoppedEarly += 1;
    } catch (err) {
      if (signal.aborted) throw err;
      out.failed += 1;
      console.error(`[exec-slack] system dm purge: installation ${row.id} failed (${errLabel(err)})`);
      firstError ??= err;
    }
  }
  console.info(`[exec-slack] system dm purge installations=${out.installations} deleted=${out.deleted} ledger=${out.ledger} scanned=${out.scanned}`);
  if (firstError !== null) throw firstError;
  return out;
}

/** One installation's DM purge (K12, C19, C43): the ledger first, then the bounded backstop scan. */
async function purgeInstallationDms(inst: OpenInstallation, retentionDaysChat: number, signal: AbortSignal):
  Promise<{ deleted: number; ledger: number; scanned: number; stoppedEarly: boolean }> {
  const cutoffMs = Date.now() - retentionDaysChat * DAY_MS;
  const budget = SLACK_LIMITS.dmPurgeMaxDeletes;
  let deleted = 0;
  let ledger = 0;
  let scanned = 0;
  let listings = 0;
  let stoppedEarly = false;

  const remove = async (ts: string): Promise<void> => {
    await dmDelete(inst, ts, { signal: ownSignal() });
    deleted += 1;
  };

  try {
    // 1. The ledger first (C43): every recorded bot post older than the cutoff, replies under old roots included.
    for (const row of await listOldSlackPosts(inst.row.id, new Date(cutoffMs).toISOString(), budget)) {
      if (deleted >= budget) break;
      await remove(row.ts);
      ledger += 1;
    }
    // 2. The backstop scan (C19 v1) with what's left of the budget: only messages whose bot_id is ours.
    const cutoffTs = slackTsOf(cutoffMs);
    let cursor: string | null = null;
    while (deleted < budget && listings < SLACK_LIMITS.dmPurgeMaxPages) {
      const page = await dmRead(inst, (target) => listDmItems(target, { latest: cutoffTs, cursor, limit: 200 }, { signal }));
      listings += 1;
      for (const item of page.items) {
        if (deleted >= budget) break;
        scanned += 1;
        // A thread's replies first (his own stay: no user token), then its root if it is ours.
        if (item.replyCount > 0 && listings < SLACK_LIMITS.dmPurgeMaxPages) {
          const replies = await dmRead(inst, (target) => listDmItems(target, { latest: cutoffTs, rootTs: item.ts, limit: 200 }, { signal }));
          listings += 1;
          for (const reply of replies.items) {
            if (deleted >= budget) break;
            if (reply.ts === item.ts) continue;
            scanned += 1;
            if (reply.botId !== null && reply.botId === inst.row.botId) await remove(reply.ts);
          }
        }
        if (deleted < budget && item.botId !== null && item.botId === inst.row.botId) await remove(item.ts);
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
  } catch (err) {
    if (slackCodeOf(err) !== "ratelimited") throw err;
    // Tomorrow's run continues.
    stoppedEarly = true;
    console.warn(`[exec-slack] dm purge rate limited after ${deleted} deletes`);
  }
  console.info(`[exec-slack] dm purge deleted=${deleted} ledger=${ledger} scanned=${scanned}`);
  return { deleted, ledger, scanned, stoppedEarly };
}

export const SLACK_SWEEP_TIMEOUT_MS = SLACK_LIMITS.sweepTimeoutMs;
export const SLACK_DM_PURGE_TIMEOUT_MS = SLACK_LIMITS.dmPurgeTimeoutMs;

export const slackSweepJobHandler: JobHandler = {
  kind: SWEEP_KIND,
  lane: "bulk",
  timeoutMs: SLACK_SWEEP_TIMEOUT_MS,
  run: (ctx: JobContext) => runSweep(ctx)
};

export const slackDmPurgeJobHandler: JobHandler = {
  kind: PURGE_KIND,
  lane: "bulk",
  timeoutMs: SLACK_DM_PURGE_TIMEOUT_MS,
  run: (ctx: JobContext) => runDmPurge(ctx)
};

export const slackSweepScheduledWork: ScheduledWork = {
  kind: SWEEP_KIND,
  lane: "bulk",
  cadence: { kind: "interval", minutes: 5 },
  maxAttempts: 1,
  when: (principal) => slackWorkDue(principal)
};

/** P9 F16: the DM purge as SYSTEM work (principal_id null), daily at 04:10 UTC, two attempts, the handler's 120 s; keyed
 *  exec.slack-dm-purge:system:<UTC date> by the scheduler, whose EXEC_ENABLED gate is the only one (a disabled principal's
 *  installation is purged too). Replaces P6's per-principal schedule (daily at 04:10 local, enabled principals only). */
export const slackDmPurgeSystemWork: SystemScheduledWork = Object.freeze<SystemScheduledWork>({
  kind: PURGE_KIND,
  lane: "bulk",
  cadence: { kind: "daily", atUtc: "04:10" },
  maxAttempts: 2
});
