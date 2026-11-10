import "server-only";

import { purgeOldFeedback } from "@/lib/exec/attention-feedback";
import { auditEvent } from "@/lib/exec/audit";
import {
  listFallbackDmsDue,
  listPrincipalIdsWithSlackLines,
  markFallbackDmDeleted,
  purgeExpiredBriefs,
  scrubBriefsForSlackSystem
} from "@/lib/exec/brief-store";
import { BRIEF_LIMITS } from "@/lib/exec/brief-types";
import { purgeExpiredChatRows } from "@/lib/exec/chat-store";
import { deleteDdBotDm } from "@/lib/exec/dd-bot";
import { purgeExpiredDdtext, purgeOrphanDdtextAttention } from "@/lib/exec/ddtext-store";
import { purgeExpiredDrafts } from "@/lib/exec/drafts-store";
import { purgeExpiredEmailRows } from "@/lib/exec/email-store";
import { purgeFinishedJobs } from "@/lib/exec/jobs";
import type { SystemScheduledWork } from "@/lib/exec/scheduler";
import { purgeUnpurgedRevocations } from "@/lib/exec/handlers/slack-uninstall";
import { deleteExpiredOAuthStates, deleteOldSlackEvents, installationFactsForSystem, listRevokedReadingInstallations } from "@/lib/exec/slack-install";
import { purgeExpiredSlackIntel } from "@/lib/exec/slack-intel-store";
import { purgeExpiredSlack } from "@/lib/exec/slack-read-store";
import { purgeReading } from "@/lib/exec/slack-reading";
import { resealSlackTokens } from "@/lib/exec/slack-token-reseal";
import { SLACK_LIMITS, SLACK_RE } from "@/lib/exec/slack-types";
import type { JobHandler } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// exec.purge: the daily retention sweep for the exec tables.
//
//   exec_jobs             finished (succeeded / dead / cancelled) more than 14 days ago
//   exec_access_log       older than 90 days (plan §5)
//   exec_audit_log        older than 400 days
//   exec_ai_usage         older than 400 days
//   exec_attention_items  resolved, and last seen, more than 90 days ago
//   email (P3)            exec_email_threads / exec_commitments / exec_email_signals
//                         past their own expires_at (activity + retention_days_email,
//                         set when written), and email attention rows whose thread
//                         or commitment is gone: see purgeExpiredEmailRows. Tolerates
//                         the P3 migration not being applied yet (counts 0).
//   drafts (P4)           exec_drafts: content 30 days after a terminal status, whole
//                         rows retention_days_email after it, idle DD-only drafts closed
//                         and idle linked ones re-checked after 30 days: see
//                         purgeExpiredDrafts (exec_drafts_purge_expired). Tolerates the
//                         P4 migration not being applied yet (counts 0). The voice
//                         profile has no purge (one row per principal, replaced weekly).
//   DD text (P5a)         in this order (contract §3.12.8, a-correct-1):
//                         1. ddtext items past their own expires_at (source time +
//                            retention_days_ddtext, set when written); their signals,
//                            the stored AI summaries, go with them: purgeExpiredDdtext;
//                         2. then, for every principal, the ddtext Needs Attention rows
//                            (exec_attention_items, source dd, kinds ddtext_*) of any
//                            status that no stored signal backs any more or whose
//                            occurred_at is past the 14-day liveness window:
//                            purgeOrphanDdtextAttention. Running it after step 1 takes
//                            the rows of items that expired in this same run. So a
//                            ddtext attention row leaves with its signal or after 14
//                            days, never by the 90-day resolved-row rule above (which
//                            would only ever find nothing of theirs left).
//   attention feedback    his thumbs on Needs Attention items, older than 365 days
//   (P5a)                 (purgeOldFeedback; they outlive the items they rate).
//                         All three tolerate the P5a migration not being applied yet
//                         (counts 0).
//   chat (P5b)            exec_conversations past their expires_at (the newest turn +
//                         retention_days_chat; their messages and staged tasks cascade),
//                         exec_messages past their own expires_at, and answers still
//                         "running" 10 minutes after they began marked failed/stale (a
//                         process that died mid-answer): purgeExpiredChatRows. Tolerates
//                         the P5b migration not being applied yet (counts 0).
//   Slack (P6)            exec_slack_events older than 25 hours (SLACK_LIMITS.eventRetentionHours,
//                         K16: past Slack's Delayed Events window, so a redelivery still
//                         dedupes), in chunks of 1,000 by event_id: deleteOldSlackEvents;
//                         exec_oauth_states past their expires_at: deleteExpiredOAuthStates.
//                         Both tolerate the P6 migration not being applied yet (counts 0).
//                         Slack conversations expire with the chat purge above (their own
//                         expires_at) and go on uninstall (RPC 4); feedback cascades with its
//                         message; the post ledger is emptied by the DM purge and the
//                         uninstall purge (exec.slack-dm-purge, RPC 4). C18 backstop: an
//                         installation revoked over an hour ago whose purge job never ran
//                         (purged_at null) is purged here through the same step:
//                         purgeUnpurgedRevocations (tolerates the P6 migration missing).
//   Slack reading (P7a)   one step after P6's (contract §3.15, N13, M10): exec_slack_items,
//                         exec_slack_messages and exec_slack_threads past their own expires_at
//                         (5,000 per table per run), deleted markers past 26 h, purge-log rows
//                         past 7 days, left conversations 30 days after left_at, and every Slack
//                         message attention row no message row backs any more:
//                         purgeExpiredSlack (exec_slack_purge_expired, principal-agnostic so P8
//                         moves it to its system purge unchanged). Tolerates the P7a migration not
//                         being applied yet (counts 0).
//   Slack intel (P7b)     one step after P7a's (contract §2.3): exec_slack_digests past their own
//                         expires_at (the end of the digest's local day + retention_days_slack, set by
//                         the app), in chunks of 1,000 by id, and digests still 'building' 30 minutes
//                         after they were requested marked 'failed' (a crashed build; the nightly plan
//                         retries them): purgeExpiredSlackIntel. Channel and message links have no TTL
//                         of their own: message links cascade with P7a's message rows, channel links
//                         and digests with P7a's channel rows. Tolerates the P7b migration not being
//                         applied yet (counts 0).
//   briefs (P8)           after P7b's step (P8 contract §3.14.1, M9, C28): exec_briefs.content nulled 30
//                         days after its local date ends (content_expires_at, set by the app), whole
//                         rows 180 days after it (expires_at; their check-ins cascade), check-ins 30
//                         days after creation (purge_at), mentions 90 days after the last one:
//                         purgeExpiredBriefs (exec_brief_purge_expired, 1,000 per batch, up to 10
//                         rounds). Tolerates the P8 migration not being applied yet (counts 0).
//   revokedReading (P8)   M10's daily re-check, principal-agnostic (intel-15, coherence-8): every
//                         installation whose reading half was revoked and not yet purged, whatever its
//                         principal's state (a disabled principal's included), ≤ 50 a day, gets P7a's
//                         purgeReading (RPC 14, idempotent; it appends the 'reading' purge-log row P7b
//                         and the brief sweep follow) and P7a's slack.read_purged audit row (ids and
//                         counts only). P7a not installed (null) → the step stops. The revoked
//                         INSTALLATIONS are P6's backstop above (slackRevocationsPurged: purgeReading
//                         then purgeInstallation, P7a's order; p8-bindings.md AM-P8-16).
//   briefSlack (P8)       then every brief that still cites Slack, of a principal with no live reading
//                         half (installationFactsForSystem), loses its Slack-derived lines
//                         (exec_brief_scrub_slack all := true). Slack-derived data goes within 24 h.
//   ddBotFallbackDms (P8) the watchdog's mini-brief DMs (posted by the DD bot, outside P6's ledger and
//                         token) past their fallback_delete_after (retention_days_chat at post time) are
//                         deleted with the DD bot token (dd-bot.ts deleteDdBotDm), ≤ 50 a day;
//                         message_not_found / channel_not_found count as done, other errors are tried
//                         again the next day (C49, intel-18).
//   slackReseal (P9 F13)  every active installation's Slack bot / user token sealed under an older key is re-sealed under
//                         EXEC_TOKEN_KEY (slack-token-reseal.ts: open, seal, CAS on the old blob, one slack.token_resealed
//                         audit row each), so EXEC_TOKEN_KEY_PREVIOUS can be removed once the System card shows 0 on the
//                         previous key. A blob under an unknown key is counted, never overwritten. Fails alone.
//   briefs (P9 §3.1)      RPC 7 v2 keeps a purged brief's refs while its DM may still be in Slack and releases them after
//                         (briefRefsReleased); v1 (P9's migration not applied) as before.
//
// The deletes are global, not per principal. Rows with no principal (system
// jobs, access attempts that never resolved to a principal) have to age out
// too, and so does a disabled principal's mail. P8 (M10, C17): the job is
// system-scoped (principal_id null): purgeSystemWork runs it daily at 03:30
// UTC, key exec.purge:system:<UTC date>, while EXEC_ENABLED=true, whether or
// not any principal is enabled. Per-principal exec.purge:<principal>:<date>
// rows queued before P8 still run once; every delete is idempotent, so an
// extra run finds nothing to delete.

export const PURGE_JOB_KIND = "exec.purge";

export const RETENTION_DAYS = Object.freeze({
  finishedJobs: 14,
  accessLog: 90,
  auditLog: 400,
  aiUsage: 400,
  resolvedAttention: 90,
  /** P5a (§2.6): his feedback votes (purgeOldFeedback applies it). */
  attentionFeedback: 365
});

/** P8 (C17): five minutes (the brief, revoked-reading and DD-bot steps make Slack and RPC calls of their own). */
const PURGE_TIMEOUT_MS = BRIEF_LIMITS.purgeTimeoutMs;
const DAY_MS = 86_400_000;
const REVOKED_READING_PER_DAY = BRIEF_LIMITS.revokedReadingPerDay;     // 50
const FALLBACK_DM_DELETES_PER_DAY = BRIEF_LIMITS.fallbackDmDeletesPerDay; // 50
const BRIEF_SLACK_PRINCIPALS = 100;

export interface PurgeCounts {
  finishedJobs: number;
  accessLog: number;
  auditLog: number;
  aiUsage: number;
  resolvedAttention: number;
  /** P3 email retention (purgeExpiredEmailRows). */
  emailThreads: number;
  emailCommitments: number;
  emailSignals: number;
  emailAttentionRows: number;
  /** P4 drafts retention (purgeExpiredDrafts, contract §2.8). */
  draftsContentPurged: number;
  draftsDeleted: number;
  draftsClosedIdle: number;
  draftsChecksScheduled: number;
  /** P5a DD text retention (purgeExpiredDdtext): expired items; their signals cascade. */
  ddtextItems: number;
  /** P5a (purgeOrphanDdtextAttention): ddtext attention rows with no backing signal, or past 14 days. */
  ddtextAttention: number;
  /** P5a (purgeOldFeedback): feedback votes older than 365 days. */
  attentionFeedback: number;
  /** P5b (purgeExpiredChatRows, contract §3.21): expired conversations (cascading), expired messages, stale running answers. */
  chatConversations: number;
  chatMessages: number;
  chatStaleFailed: number;
  /** P6 (deleteOldSlackEvents, contract §2.6): Events API dedupe rows older than 25 hours. */
  slackEvents: number;
  /** P6 (deleteExpiredOAuthStates): OAuth state nonces past their expires_at. */
  oauthStates: number;
  /** P6 C18 backstop (purgeUnpurgedRevocations): revoked installations whose own purge never ran, purged now. */
  slackRevocationsPurged: number;
  /** P7a (purgeExpiredSlack, contract §3.15): expired Slack items, message rows, thread rows, deleted markers, purge-log
   *  rows, left conversations past 30 days, and orphaned Slack attention rows. */
  slackItems: number;
  slackMessages: number;
  slackThreads: number;
  slackMarkers: number;
  slackLog: number;
  slackChannels: number;
  slackAttention: number;
  /** P7b (purgeExpiredSlackIntel, contract §2.3): expired digests deleted, and stale 'building' digests marked failed. */
  slackDigests: number;
  slackDigestsFailed: number;
  /** P8 (purgeExpiredBriefs, §2.5): brief content nulled, brief rows deleted, check-ins deleted, mentions deleted. */
  briefContentPurged: number;
  briefsDeleted: number;
  briefCheckinsDeleted: number;
  briefMentionsDeleted: number;
  /** P9 (§3.1): purged briefs whose kept refs RPC 7 v2 released (their DM can't be in Slack any more). */
  briefRefsReleased: number;
  /** P8 (M10 step 1): revoked reading halves purged with P7a's purgeReading (the revoked installations are slackRevocationsPurged). */
  revokedReadingPurged: number;
  /** P8 (M10 step 3): briefs whose Slack-derived lines were removed (the principal's reading half is gone). */
  briefSlackScrubbed: number;
  /** P8 (C49): the watchdog's DD-bot mini-brief DMs deleted, and the ones left for the next day. */
  fallbackDmsDeleted: number;
  fallbackDmsRetry: number;
  /** P9 F13 (resealSlackTokens): Slack token blobs moved to the current key; left on an unknown key; lost to a concurrent write;
   *  not openable for another reason. */
  slackResealed: number;
  slackResealUnknownKey: number;
  slackResealLost: number;
  slackResealFailed: number;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function deleteCreatedBefore(table: string, days: number, now: Date, signal?: AbortSignal): Promise<number> {
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  let query = getSupabaseAdmin().from(table).delete({ count: "exact" }).lt("created_at", cutoff);
  if (signal) query = query.abortSignal(signal);
  const { count, error } = await query;
  if (error) throw new Error(`${table} purge failed: ${error.message}`);
  return count ?? 0;
}

// Needs Attention rows age out only once resolved, and only once their
// situation has been gone for the whole window too. An open, seen, snoozed or
// dismissed row still stands for a live situation, whatever its age, and
// deleting it would bring the situation back as a new item. So would deleting
// a row he resolved himself while its situation is still there: each refresh
// that still finds it moves last_seen_at, and a deleted row would come back
// as a brand-new open item although nothing changed. An auto-resolved row was
// last seen before it was resolved, so last_seen_at changes nothing for those.
// The partial index exec_attention_items_purge_idx (resolved_at, where
// status = 'resolved') serves the delete; last_seen_at is checked on its rows.
async function deleteResolvedAttention(days: number, now: Date, signal?: AbortSignal): Promise<number> {
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  let query = getSupabaseAdmin()
    .from("exec_attention_items")
    .delete({ count: "exact" })
    .eq("status", "resolved")
    .lt("resolved_at", cutoff)
    .lt("last_seen_at", cutoff);
  if (signal) query = query.abortSignal(signal);
  const { count, error } = await query;
  if (error) throw new Error(`exec_attention_items purge failed: ${error.message}`);
  return count ?? 0;
}

/** Counts only: the keys a purgeReading answer may carry, finite non-negative numbers (P7a's audit shape). */
function readingCounts(raw: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) if (/^[a-z_]{1,40}$/i.test(k) && typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
  return out;
}

const errName = (err: unknown) => (err instanceof Error ? err.name : "error");

/**
 * P8 M10 step 1 (intel-15, coherence-8): purge every revoked reading half with P7a's purgeReading, principal-agnostic, ≤ 50 a
 * day, oldest revoke first, and write P7a's slack.read_purged audit row (ids and counts only). null (P7a not installed) ends
 * the step. One failing installation doesn't stop the rest; the first failure is rethrown at the end (the run reports it).
 */
async function purgeRevokedReading(signal: AbortSignal | undefined): Promise<number> {
  const ids = (await listRevokedReadingInstallations()).filter((id) => SLACK_RE.installationId.test(id)).slice(0, REVOKED_READING_PER_DAY);
  let purged = 0;
  let firstError: unknown = null;
  for (const id of ids) {
    signal?.throwIfAborted();
    try {
      const raw = await purgeReading(id);
      if (raw === null) break;
      await auditEvent(null, {
        actor: "system",
        action: "slack.read_purged",
        target: "exec_slack_installations:" + id,
        input: { reason: "system_purge", ...readingCounts(raw) }
      });
      purged += 1;
    } catch (err) {
      console.error("[exec-purge] revoked reading purge of " + id + " failed (" + errName(err) + ")");
      firstError ??= err;
    }
  }
  if (firstError !== null) throw firstError;
  return purged;
}

/**
 * P8 M10 step 3: every brief that still cites Slack, of a principal whose reading half isn't live, loses its Slack-derived
 * lines (exec_brief_scrub_slack, all). The principal's installation facts are booleans only. One failing principal doesn't
 * stop the rest; the first failure is rethrown at the end.
 */
async function scrubBriefSlackForRevoked(signal: AbortSignal | undefined): Promise<number> {
  const ids = await listPrincipalIdsWithSlackLines(BRIEF_SLACK_PRINCIPALS, { signal });
  let scrubbed = 0;
  let firstError: unknown = null;
  for (const id of ids) {
    signal?.throwIfAborted();
    try {
      const facts = await installationFactsForSystem(id, { signal });
      if (facts.readingActive) continue;
      scrubbed += (await scrubBriefsForSlackSystem(id, { signal })) ?? 0;
    } catch (err) {
      console.error("[exec-purge] brief Slack scrub of " + id + " failed (" + errName(err) + ")");
      firstError ??= err;
    }
  }
  if (firstError !== null) throw firstError;
  return scrubbed;
}

/**
 * P8 C49 (intel-18): the watchdog's mini-brief DMs past fallback_delete_after, deleted with the DD bot token through
 * dd-bot.ts (≤ 50 a day). "deleted" (message_not_found / channel_not_found included) → marked; "retry" or a throw → left for
 * the next day and counted. A store error marking a row fails the step.
 */
async function deleteFallbackDms(now: Date, signal: AbortSignal | undefined): Promise<{ deleted: number; retry: number }> {
  const due = await listFallbackDmsDue(now, FALLBACK_DM_DELETES_PER_DAY);
  let deleted = 0;
  let retry = 0;
  for (const dm of due) {
    signal?.throwIfAborted();
    let outcome: "deleted" | "retry";
    try {
      outcome = await deleteDdBotDm({ channel: dm.channel, ts: dm.ts }, { signal: signal ?? new AbortController().signal });
    } catch (err) {
      console.error("[exec-purge] DD-bot mini-brief " + dm.id + " not deleted (" + errName(err) + ")");
      outcome = "retry";
    }
    if (outcome === "deleted") {
      await markFallbackDmDeleted(dm.id);
      deleted += 1;
    } else {
      retry += 1;
    }
  }
  return { deleted, retry };
}

/**
 * Run every retention delete and return how many rows each removed.
 *
 * A failing step doesn't stop the others (one broken table must not keep the
 * rest growing), but the run still throws at the end so the job retries and,
 * if the failure persists, dead-letters to ops. An aborted signal (timeout,
 * lost lease) stops it between steps.
 */
export async function runPurge(signal?: AbortSignal, now: Date = new Date()): Promise<PurgeCounts> {
  const counts: PurgeCounts = {
    finishedJobs: 0,
    accessLog: 0,
    auditLog: 0,
    aiUsage: 0,
    resolvedAttention: 0,
    emailThreads: 0,
    emailCommitments: 0,
    emailSignals: 0,
    emailAttentionRows: 0,
    draftsContentPurged: 0,
    draftsDeleted: 0,
    draftsClosedIdle: 0,
    draftsChecksScheduled: 0,
    ddtextItems: 0,
    ddtextAttention: 0,
    attentionFeedback: 0,
    chatConversations: 0,
    chatMessages: 0,
    chatStaleFailed: 0,
    slackEvents: 0,
    oauthStates: 0,
    slackRevocationsPurged: 0,
    slackItems: 0,
    slackMessages: 0,
    slackThreads: 0,
    slackMarkers: 0,
    slackLog: 0,
    slackChannels: 0,
    slackAttention: 0,
    slackDigests: 0,
    slackDigestsFailed: 0,
    briefContentPurged: 0,
    briefsDeleted: 0,
    briefCheckinsDeleted: 0,
    briefMentionsDeleted: 0,
    briefRefsReleased: 0,
    revokedReadingPurged: 0,
    briefSlackScrubbed: 0,
    fallbackDmsDeleted: 0,
    fallbackDmsRetry: 0,
    slackResealed: 0,
    slackResealUnknownKey: 0,
    slackResealLost: 0,
    slackResealFailed: 0
  };
  const one = (key: keyof PurgeCounts, run: () => Promise<number>) => async (): Promise<Partial<PurgeCounts>> => ({ [key]: await run() });
  const steps: readonly [string, () => Promise<Partial<PurgeCounts>>][] = [
    ["finishedJobs", one("finishedJobs", () => purgeFinishedJobs(RETENTION_DAYS.finishedJobs, signal))],
    ["accessLog", one("accessLog", () => deleteCreatedBefore("exec_access_log", RETENTION_DAYS.accessLog, now, signal))],
    ["auditLog", one("auditLog", () => deleteCreatedBefore("exec_audit_log", RETENTION_DAYS.auditLog, now, signal))],
    ["aiUsage", one("aiUsage", () => deleteCreatedBefore("exec_ai_usage", RETENTION_DAYS.aiUsage, now, signal))],
    ["resolvedAttention", one("resolvedAttention", () => deleteResolvedAttention(RETENTION_DAYS.resolvedAttention, now, signal))],
    [
      "email",
      async () => {
        const c = await purgeExpiredEmailRows(now, { signal });
        return { emailThreads: c.threads, emailCommitments: c.commitments, emailSignals: c.signals, emailAttentionRows: c.attentionRows };
      }
    ],
    [
      "drafts",
      async () => {
        const c = await purgeExpiredDrafts(now, { signal });
        return { draftsContentPurged: c.contentPurged, draftsDeleted: c.deleted, draftsClosedIdle: c.closedIdle, draftsChecksScheduled: c.checksScheduled };
      }
    ],
    // P5a: expiry first, then the orphan sweep over every principal, so an
    // attention row whose item expired just now goes in this same run.
    ["ddtextItems", one("ddtextItems", () => purgeExpiredDdtext(now, { signal }))],
    ["ddtextAttention", one("ddtextAttention", () => purgeOrphanDdtextAttention(now, { signal }))],
    ["attentionFeedback", one("attentionFeedback", () => purgeOldFeedback(now, { signal }))],
    [
      "chat",
      async () => {
        const c = await purgeExpiredChatRows(now, { signal });
        return { chatConversations: c.conversations, chatMessages: c.messages, chatStaleFailed: c.staleFailed };
      }
    ],
    // P6 (§2.6): after every earlier phase's step.
    ["slackEvents", one("slackEvents", () => deleteOldSlackEvents(now, SLACK_LIMITS.eventRetentionHours, { signal }))],
    ["oauthStates", one("oauthStates", () => deleteExpiredOAuthStates(now, { signal }))],
    ["slackRevocationsPurged", one("slackRevocationsPurged", () => purgeUnpurgedRevocations(now, { signal }))],
    // P7a (§3.15): after P6's steps; the RPC answers zeros when the P7a migration isn't applied.
    [
      "slack",
      async () => {
        const c = await purgeExpiredSlack(now, { signal });
        const n = (k: string) => (typeof c[k] === "number" && Number.isSafeInteger(c[k]) && c[k] > 0 ? c[k] : 0);
        return {
          slackItems: n("items"),
          slackMessages: n("messages"),
          slackThreads: n("threads"),
          slackMarkers: n("markers"),
          slackLog: n("log"),
          slackChannels: n("channels"),
          slackAttention: n("attention")
        };
      }
    ],
    // P7b (§2.3): after P7a's step; the store answers zeros when the P7b migration isn't applied.
    [
      "slackIntel",
      async () => {
        const c = await purgeExpiredSlackIntel(now, { signal });
        const n = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0);
        return { slackDigests: n(c?.digests), slackDigestsFailed: n(c?.failedBuilds) };
      }
    ],
    // P8 (C49): the DD bot's mini-brief DMs at chat retention, BEFORE the briefs step (P8 fixer security-2): a mini-brief's
    // deletion time is capped at its row's expiry, so on the run where both are due the DM is deleted while its row still holds
    // the channel and ts (RPC 7 also keeps an undeleted one's row up to 7 more days, for a "retry").
    [
      "ddBotFallbackDms",
      async () => {
        const c = await deleteFallbackDms(now, signal);
        return { fallbackDmsDeleted: c.deleted, fallbackDmsRetry: c.retry };
      }
    ],
    // P8 (§3.14.1): after P7b's step. The store answers zeros when the P8 migration isn't applied.
    [
      "briefs",
      async () => {
        const c = await purgeExpiredBriefs(now, { signal });
        return {
          briefContentPurged: c.contentPurged,
          briefsDeleted: c.briefsDeleted,
          briefCheckinsDeleted: c.checkinsDeleted,
          briefMentionsDeleted: c.mentionsDeleted,
          briefRefsReleased: c.refsReleased
        };
      }
    ],
    // P8 (M10's re-check, principal-agnostic): revoked reading halves, then the briefs of principals with no live reading half.
    ["revokedReading", one("revokedReadingPurged", () => purgeRevokedReading(signal))],
    ["briefSlack", one("briefSlackScrubbed", () => scrubBriefSlackForRevoked(signal))],
    // P9 F13: the Slack token re-seal (an EXEC_TOKEN_KEY rotation finishes here), after every delete; fails alone.
    [
      "slackReseal",
      async () => {
        const c = await resealSlackTokens({ signal });
        return { slackResealed: c.resealed, slackResealUnknownKey: c.unknownKey, slackResealLost: c.lost, slackResealFailed: c.failed };
      }
    ]
  ];

  const failures: string[] = [];
  for (const [name, step] of steps) {
    signal?.throwIfAborted();
    try {
      Object.assign(counts, await step());
    } catch (err) {
      failures.push(`${name}: ${errMessage(err)}`);
      console.error(`[exec-purge] ${name} step failed: ${errMessage(err)}`);
    }
  }

  console.log(
    `[exec-purge] deleted finishedJobs=${counts.finishedJobs} accessLog=${counts.accessLog} ` +
      `auditLog=${counts.auditLog} aiUsage=${counts.aiUsage} resolvedAttention=${counts.resolvedAttention} ` +
      `emailThreads=${counts.emailThreads} emailCommitments=${counts.emailCommitments} emailSignals=${counts.emailSignals} ` +
      `emailAttentionRows=${counts.emailAttentionRows} ` +
      `draftsContentPurged=${counts.draftsContentPurged} draftsDeleted=${counts.draftsDeleted} ` +
      `draftsClosedIdle=${counts.draftsClosedIdle} draftsChecksScheduled=${counts.draftsChecksScheduled} ` +
      `ddtextItems=${counts.ddtextItems} ddtextAttention=${counts.ddtextAttention} attentionFeedback=${counts.attentionFeedback} ` +
      `chatConversations=${counts.chatConversations} chatMessages=${counts.chatMessages} chatStaleFailed=${counts.chatStaleFailed} ` +
      `slackEvents=${counts.slackEvents} oauthStates=${counts.oauthStates} slackRevocationsPurged=${counts.slackRevocationsPurged} ` +
      `slackItems=${counts.slackItems} slackMessages=${counts.slackMessages} slackThreads=${counts.slackThreads} ` +
      `slackMarkers=${counts.slackMarkers} slackLog=${counts.slackLog} slackChannels=${counts.slackChannels} slackAttention=${counts.slackAttention} ` +
      `slackDigests=${counts.slackDigests} slackDigestsFailed=${counts.slackDigestsFailed} ` +
      `briefContentPurged=${counts.briefContentPurged} briefsDeleted=${counts.briefsDeleted} briefCheckinsDeleted=${counts.briefCheckinsDeleted} ` +
      `briefMentionsDeleted=${counts.briefMentionsDeleted} briefRefsReleased=${counts.briefRefsReleased} revokedReadingPurged=${counts.revokedReadingPurged} ` +
      `briefSlackScrubbed=${counts.briefSlackScrubbed} fallbackDmsDeleted=${counts.fallbackDmsDeleted} fallbackDmsRetry=${counts.fallbackDmsRetry} ` +
      `slackResealed=${counts.slackResealed} slackResealUnknownKey=${counts.slackResealUnknownKey} slackResealLost=${counts.slackResealLost} ` +
      `slackResealFailed=${counts.slackResealFailed}` +
      `${failures.length > 0 ? ` failed=${failures.length}` : ""}`
  );
  if (failures.length > 0) {
    throw new Error(`exec.purge: ${failures.length} of ${steps.length} steps failed: ${failures.join("; ")}`);
  }
  return counts;
}

export const purgeJobHandler: JobHandler = Object.freeze<JobHandler>({
  kind: PURGE_JOB_KIND,
  lane: "bulk",
  timeoutMs: PURGE_TIMEOUT_MS,
  run: ({ signal }) => runPurge(signal)
});

/**
 * P8 (contract §3.14.1, M10, C17): exec.purge as a SYSTEM job (principal_id null), daily at 03:30 UTC, key
 * exec.purge:system:<UTC date>, maxAttempts 3, the handler's 300 s timeout. Registered by runtime.ts's
 * BUILT_IN_SYSTEM_SCHEDULE (Area B); the scheduler's EXEC_ENABLED gate is the only one (no principal needs to be enabled).
 */
export const purgeSystemWork: SystemScheduledWork = Object.freeze<SystemScheduledWork>({
  kind: PURGE_JOB_KIND,
  lane: "bulk",
  cadence: { kind: "daily", atUtc: "03:30" },
  maxAttempts: 3
});
