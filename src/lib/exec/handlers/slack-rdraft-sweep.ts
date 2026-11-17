import "server-only";

import type { ScheduledWork } from "@/lib/exec/scheduler";
import { P10_JOB_KINDS, P10_LIMITS } from "@/lib/exec/slack-p10-types";
import { openReader, paced } from "@/lib/exec/slack-read";
import { noteFromHim } from "@/lib/exec/slack-read-store";
import { tsToMs } from "@/lib/exec/slack-read-types";
import { latestAuthorOptoutAt, listAuthorOptouts, listPurgeLog } from "@/lib/exec/slack-reading";
import { findOwnPostByHash } from "@/lib/exec/slack-reply-pack";
import {
  blankReplyDrafts,
  deleteSlackVoiceProfile,
  listOrphanReplyCards,
  listStaleGenerating,
  listStaleReplyCards,
  listStaleSending,
  listUnknownDue,
  replySchemaReady,
  stepReplyDraft,
  voiceProfileUses
} from "@/lib/exec/slack-reply-store";
import { removeReplyCard, replyCardsOutOfDate, rerenderReplyCards } from "@/lib/exec/slack-reply-view";
import { getPermalink } from "@/lib/exec/sources/slack";
import { getSyncState, parseOptoutSeen, parseReplyCursor, putSyncState } from "@/lib/exec/sync-state";
import type { ExecPrincipal, JobContext, JobHandler } from "@/lib/exec/types";

// exec.slack-rdraft-sweep (P10 contract §3.5.9, H7, C37, C44, C61; Area D): the purge log, opt-outs, stale generating (X12),
// stale sending (X6), the read-only unknown checks and the cards. Bulk lane, 120 s, maxAttempts 1, every 5 minutes whatever
// the switches (deletions are never gated).
//
//   * P7a's purge log, by an id cursor in exec_sync_state (slack-reply / purge-cursor) that never passes a row younger than
//     purgeLogSettleMs (ids are allocated at insert, not commit: P8's rule, AM-P8-9). Every row above the cursor is applied
//     again on every pass (idempotent; RPC 18's `before` fence keeps a re-applied row off drafts created after it was logged,
//     v1.1 correctness-6). A message row blanks the drafts resting on it and drops a voice profile that sampled it; a
//     conversation row blanks NO draft (P7a's purge already cascaded them away; a draft found there later was created after
//     it, or renamed into that id by a re-key) and drops a voice profile that sampled the channel; a reading row drops the
//     voice profile.
//   * Nothing here ever posts as him: `unknown` rows are checked read-only (findOwnPostByHash: the exact hash or the word key)
//     at +1, +5 and +30 minutes after sending_at; found → sent (X7) and stamped as his answer, not found → one check used (X8),
//     a failed read → nothing (C37, v1.1 correctness-7).
//   * Every draft changed above, every orphan card and every stale card is re-rendered, so a Slack card never keeps text DD has
//     dropped (§3.5.9 step 6).
//   * The result carries counts only (B-P10-6); logs carry ids and codes.

const ORPHAN_CARDS = 20;
const STALE_CARDS = 20;
/** C29: a follow-up's own signal. */
const FOLLOW_UP_MS = 10_000;

export interface ReplySweepResult {
  skipped?: string;
  purgeRows: number; blanked: number; voiceDropped: number; optoutBlanked: number; staleGenerating: number; staleSending: number;
  verified: number; missed: number; unchecked: number; cardsUpdated: number;
}

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(err.name) ? err.name : "error");

function emptyResult(): ReplySweepResult {
  return { purgeRows: 0, blanked: 0, voiceDropped: 0, optoutBlanked: 0, staleGenerating: 0, staleSending: 0, verified: 0, missed: 0, unchecked: 0, cardsUpdated: 0 };
}

/** Step 2: P7a's purge log after the stored cursor; the cursor moves only past rows older than purgeLogSettleMs. */
async function followPurgeLog(principal: ExecPrincipal, now: Date, signal: AbortSignal, changed: Set<string>, r: ReplySweepResult): Promise<void> {
  const stored = await getSyncState(principal, "slack-reply", "purge-cursor", parseReplyCursor, { signal });
  const afterId = stored?.value.afterId ?? 0;
  const limitMs = now.getTime() - P10_LIMITS.purgeLogSettleMs;
  let readFrom = afterId;
  let passable = afterId;
  let blocked = false;
  let voiceGone = false;
  try {
    for (let batch = 0; batch < P10_LIMITS.sweepPurgeLogBatches; batch++) {
      signal.throwIfAborted();
      const rows = [...(await listPurgeLog(principal, readFrom, P10_LIMITS.sweepPurgeLogBatch))].sort((a, b) => a.id - b.id);
      if (rows.length === 0) break;
      for (const row of rows) {
        r.purgeRows += 1;
        if (row.scope === "message" && row.channelId !== null && row.ts !== null) {
          const ids = await blankReplyDrafts(principal, {
            channelId: row.channelId, ts: [row.ts], authors: null, reason: row.reason === "author_optout" ? "author_optout" : "deleted",
            before: row.createdAt
          });
          for (const id of ids) changed.add(id);
          r.blanked += ids.length;
          if (!voiceGone && (await voiceProfileUses(principal, { refs: [`${row.channelId}:${row.ts}`] }))) voiceGone = await dropVoice(principal, r);
        } else if (row.scope === "conversation" && row.channelId !== null) {
          // v1.1 correctness-6: no draft is blanked by conversation (the FK cascade already removed that channel's drafts).
          if (!voiceGone && (await voiceProfileUses(principal, { channelId: row.channelId }))) voiceGone = await dropVoice(principal, r);
        } else if (row.scope === "reading") {
          if (!voiceGone) voiceGone = await dropVoice(principal, r);
        }
        if (blocked) continue;
        const created = Date.parse(row.createdAt);
        if (Number.isFinite(created) && created < limitMs && row.id > passable) passable = row.id;
        else blocked = true;
      }
      readFrom = rows[rows.length - 1].id;
      if (rows.length < P10_LIMITS.sweepPurgeLogBatch) break;
    }
  } finally {
    if (passable > afterId) await putSyncState(principal, "slack-reply", "purge-cursor", { afterId: passable }, { signal });
  }
}

/** The voice profile goes (its samples rest on a message or a conversation DD may no longer read). True once deleted or gone. */
async function dropVoice(principal: ExecPrincipal, r: ReplySweepResult): Promise<boolean> {
  if (await deleteSlackVoiceProfile(principal)) r.voiceDropped += 1;
  return true;
}

/** RPC 18 takes at most this many authors a call (its TS check and exec_slack_user_array_ok both cap the array at 200). */
const OPTOUT_AUTHORS_PER_CALL = 200;

/** Step 3: a new author opt-out blanks every draft whose context holds that author. P10 fixer correctness-4: the opt-out list is
 *  sent to RPC 18 in chunks of ≤ 200 authors (one call with his 201st opt-out threw on every pass, forever); optout-seen moves
 *  only after every chunk was applied. */
async function followOptouts(principal: ExecPrincipal, signal: AbortSignal, changed: Set<string>, r: ReplySweepResult): Promise<void> {
  const latest = await latestAuthorOptoutAt(principal, { signal });
  if (latest === null) return;
  const seen = await getSyncState(principal, "slack-reply", "optout-seen", parseOptoutSeen, { signal });
  if (seen !== null && Date.parse(seen.value.at) >= Date.parse(latest)) return;
  const authors = [...new Set(await listAuthorOptouts(principal))];
  for (let i = 0; i < authors.length; i += OPTOUT_AUTHORS_PER_CALL) {
    signal.throwIfAborted();
    const part = authors.slice(i, i + OPTOUT_AUTHORS_PER_CALL);
    const ids = await blankReplyDrafts(principal, { channelId: null, ts: null, authors: part, reason: "author_optout", before: null });
    for (const id of ids) changed.add(id);
    r.optoutBlanked += ids.length;
  }
  await putSyncState(principal, "slack-reply", "optout-seen", { at: latest }, { signal });
}

/** Step 5: one read-only check of an `unknown` row; found → X7 + his answer stamp + the permalink, not found → X8. */
async function verifyUnknown(principal: ExecPrincipal, now: Date, signal: AbortSignal, changed: Set<string>, r: ReplySweepResult): Promise<void> {
  const due = await listUnknownDue(principal, now, P10_LIMITS.replyVerifyDelaysMs);
  for (const row of due) {
    signal.throwIfAborted();
    const found = await findOwnPostByHash(principal, row, { signal });
    if (found === null) {
      r.unchecked += 1;
      continue;
    }
    if (!found.found) {
      if (await stepReplyDraft(principal, row.id, { t: "miss", checks: row.verifyChecks }, now)) {
        r.missed += 1;
        changed.add(row.id);
      }
      continue;
    }
    const sentAt = new Date(tsToMs(found.ts)).toISOString();
    if (!(await stepReplyDraft(principal, row.id, { t: "verified", checks: row.verifyChecks, sentAt, postedTs: found.ts }, now))) continue;
    r.verified += 1;
    changed.add(row.id);
    try {
      await noteFromHim(principal, row.channelId, [{ ts: found.ts, thread_ts: row.replyThreadTs, mentions: [] }]);
    } catch (err) {
      console.warn(`[exec-slack-reply] ${row.id}: not stamped as answered (${errName(err)})`);
    }
    try {
      const own = AbortSignal.timeout(FOLLOW_UP_MS);
      const ri = await openReader(principal, row.installationId, { signal: own });
      const url = ri === null ? null : await paced(ri, "chat.getPermalink", "triage", () => getPermalink(ri.target, row.channelId, found.ts, { signal: own }), { signal: own });
      if (url !== null) await stepReplyDraft(principal, row.id, { t: "permalink", url }, now);
    } catch (err) {
      console.warn(`[exec-slack-reply] ${row.id}: no permalink (${errName(err)})`);
    }
  }
}

async function runReplySweep(ctx: JobContext): Promise<ReplySweepResult> {
  const principal = ctx.principal;
  const r = emptyResult();
  if (!principal) return { ...r, skipped: "no_principal" };
  const signal = ctx.signal;
  const now = new Date();
  // 1. The P10 tables only: no switch gates a deletion.
  if (!(await replySchemaReady({ signal }))) return { ...r, skipped: "not_installed" };
  const changed = new Set<string>();
  // P10 fixer correctness-4: each step on its own: a step that fails (logged by its name and an error class) never keeps the
  // later ones from running (X12, X6, the read-only checks, the cards). The job's abort still ends the pass. The failed
  // steps' names are in the result (codes only), and the job fails after the last step when any did (its last_error says so).
  const failed: SweepStep[] = [];
  const step = async (code: SweepStep, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      if (signal.aborted) throw err;
      failed.push(code);
      console.warn(`[exec-slack-reply] sweep ${principal.id}: step ${code} failed (${errName(err)})`);
    }
  };
  // 2.
  await step("purge_log", () => followPurgeLog(principal, now, signal, changed, r));
  // 3.
  await step("optouts", () => followOptouts(principal, signal, changed, r));
  // 3b. v1.1 correctness-1: a draft never stays `generating`.
  await step("stale_generating", async () => {
    const staleBefore = new Date(now.getTime() - P10_LIMITS.replyGeneratingStaleMs).toISOString();
    for (const g of await listStaleGenerating(principal, staleBefore)) {
      if (await stepReplyDraft(principal, g.id, { t: "stale_generating", seq: g.generationSeq, before: staleBefore }, now)) {
        r.staleGenerating += 1;
        changed.add(g.id);
      }
    }
  });
  // 4. A `sending` row older than 60 s is `unknown` (never posted again).
  await step("stale_sending", async () => {
    const sendingBefore = new Date(now.getTime() - P10_LIMITS.replySendingStaleMs).toISOString();
    for (const s of await listStaleSending(principal, sendingBefore)) {
      if (await stepReplyDraft(principal, s.id, { t: "stale", before: sendingBefore }, now)) {
        r.staleSending += 1;
        changed.add(s.id);
      }
    }
  });
  // 5.
  await step("unknown", () => verifyUnknown(principal, now, signal, changed, r));
  // 6. The cards: every draft changed above, the orphans (their draft is gone) and the stale ones; P10 fixer security-1 (H9):
  //    and every card whose conversation turned finance-class (or a live card that can't send now), though the draft didn't
  //    change, so the assistant DM never keeps a finance conversation's draft text, summary or Send.
  await step("orphan_cards", async () => {
    for (const c of await listOrphanReplyCards(principal, ORPHAN_CARDS)) {
      if (await removeReplyCard(principal, c)) r.cardsUpdated += 1;
    }
  });
  await step("stale_cards", async () => {
    for (const s of await listStaleReplyCards(principal, STALE_CARDS)) changed.add(s.draftId);
  });
  await step("card_class", async () => {
    for (const id of await replyCardsOutOfDate(principal, now)) changed.add(id);
  });
  await step("cards", async () => {
    for (const id of changed) r.cardsUpdated += await rerenderReplyCards(principal, id, { now });
  });
  if (failed.length > 0) throw new ReplySweepStepsFailed(failed);
  return r;
}

type SweepStep = "purge_log" | "optouts" | "stale_generating" | "stale_sending" | "unknown" | "orphan_cards" | "stale_cards" | "card_class" | "cards";

/** The pass ran every step, but these failed (their names only: codes, never content). The runner records it as the job's
 *  error, so a step failing on every pass shows in exec_jobs instead of passing silently. */
export class ReplySweepStepsFailed extends Error {
  constructor(readonly steps: readonly SweepStep[]) {
    super(`reply sweep steps failed: ${steps.join(",")}`);
    this.name = "ReplySweepStepsFailed";
  }
}

export const slackRdraftSweepJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: P10_JOB_KINDS.replySweep,
  lane: "bulk",
  timeoutMs: P10_LIMITS.sweepTimeoutMs,
  run: (ctx) => runReplySweep(ctx)
});

/** §3.10: interval 5, gated on the P10 schema only (purges run whatever the switches). */
export const slackRdraftSweepScheduledWork: ScheduledWork = Object.freeze<ScheduledWork>({
  kind: P10_JOB_KINDS.replySweep,
  lane: "bulk",
  cadence: { kind: "interval", minutes: P10_LIMITS.sweepMinutes },
  enabled: (s) => s.slackP10SchemaReady,
  maxAttempts: 1
});
