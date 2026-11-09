import "server-only";

import { purgeOldFeedback } from "@/lib/exec/attention-feedback";
import { purgeExpiredChatRows } from "@/lib/exec/chat-store";
import { purgeExpiredDdtext, purgeOrphanDdtextAttention } from "@/lib/exec/ddtext-store";
import { purgeExpiredDrafts } from "@/lib/exec/drafts-store";
import { purgeExpiredEmailRows } from "@/lib/exec/email-store";
import { purgeFinishedJobs } from "@/lib/exec/jobs";
import type { ScheduledWork } from "@/lib/exec/scheduler";
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
//
// The deletes are global, not per principal. Rows with no principal (system
// jobs, access attempts that never resolved to a principal) have to age out
// too, and so does a disabled principal's mail. The schedule is per principal
// (key exec.purge:<principal>:<local date>), so with several principals it
// runs several times a day; every delete is idempotent, so the extra runs
// find nothing to delete.
//
// Later phases add the Slack retention to this job.

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

const PURGE_TIMEOUT_MS = 120_000;
// Local time, in the principal's zone: overnight, clear of the 08:00 brief.
const PURGE_LOCAL_TIME = "03:30";
const DAY_MS = 86_400_000;

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
    chatStaleFailed: 0
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
      `chatConversations=${counts.chatConversations} chatMessages=${counts.chatMessages} chatStaleFailed=${counts.chatStaleFailed}` +
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

export const purgeScheduledWork: ScheduledWork = Object.freeze<ScheduledWork>({
  kind: PURGE_JOB_KIND,
  lane: "bulk",
  cadence: { kind: "daily", at: () => PURGE_LOCAL_TIME }
});
