// Orchestrator for the per-message satisfaction backfill + daily cron.
//
// One-time backfill flow (kicked from /admin/mail-satisfaction):
//   1. Walk every client. For each, find threads matching its
//      participant signals scoped to a date range (default last 3
//      months) via missiveclone.
//   2. For each thread, pull every message; skip ones already scored.
//   3. Send unscored messages to Claude Haiku in batches of ~20.
//   4. Upsert per-message rows into email_satisfaction_scores.
//   5. After a client's messages finish, recompute that client's
//      median + health_label and write back to clients.
//
// Chunked execution: processChunk() runs until either the work is
// done or the time budget elapses (default 45s), then returns
// progress. The admin endpoint polls in a loop. State lives in the
// satisfaction_scan_runs row so a crash mid-run resumes cleanly.

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getThread, listThreadsPaged, type MissiveMessage } from "@/lib/missive-client";
import {
  buildClientSignals, threadMatchesClient, parseEmail
} from "@/lib/client-thread-match";
import {
  scoreMessages, medianScore, scoreToLabel,
  type MessageToScore
} from "@/lib/client-health";

const BATCH_SIZE = 18; // messages per Claude call

export interface ScanOptions {
  // ISO dates bounding the message scan. Inclusive of `from`, exclusive of `to`.
  scopeFrom?: string;
  scopeTo?: string;
  // Max wall-clock the call will spend before returning progress.
  timeBudgetMs?: number;
}

export interface ScanProgress {
  runId: string;
  status: "running" | "completed" | "failed" | "paused";
  totalThreads: number;
  processedThreads: number;
  totalMessages: number;
  scoredMessages: number;
  skippedMessages: number;
  erroredMessages: number;
  startedAt: string;
  finishedAt: string | null;
  scopeFrom: string | null;
  scopeTo: string | null;
  lastError: string | null;
  done: boolean;
}

interface ClientShape {
  id: string;
  name: string;
  website: string | null;
  websites: string[];
  contact_emails: string[];
}

interface CursorShape {
  clientIndex: number;
  threadOffset: number;
  // Which folder we're paging for the current client. We walk INBOX
  // first (catches every thread with an inbound reply), then SENT
  // (catches outbound-only threads where we sent something but never
  // got a response). A pure-SENT thread never shows up in INBOX, so
  // omitting this step misses every outbound that didn't get a reply.
  folder?: "INBOX" | "SENT";
}

// Start a new scan run. Returns the runId the caller should poll
// processChunk(runId) with.
export async function startScanRun(opts: {
  startedBy: string | null;
  scopeFrom?: string;
  scopeTo?: string;
}): Promise<string> {
  const supabase = getSupabaseAdmin();
  const id = `ssr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const scopeFrom = opts.scopeFrom ?? defaultScopeFrom();
  const scopeTo = opts.scopeTo ?? new Date().toISOString();

  await supabase.from("satisfaction_scan_runs").insert({
    id,
    started_by: opts.startedBy,
    scope_from: scopeFrom,
    scope_to: scopeTo,
    status: "running",
    cursor: { clientIndex: 0, threadOffset: 0, folder: "INBOX" } satisfies CursorShape
  });
  return id;
}

export function defaultScopeFrom(): string {
  // 3 months back per spec.
  const d = new Date();
  d.setMonth(d.getMonth() - 3);
  return d.toISOString();
}

// Continue processing an in-progress run. Returns the latest progress
// snapshot. Safe to call repeatedly — each call resumes from the
// stored cursor and times out at the budget.
export async function processChunk(
  runId: string,
  opts: ScanOptions = {}
): Promise<ScanProgress> {
  const supabase = getSupabaseAdmin();
  const timeBudget = opts.timeBudgetMs ?? 45_000;
  const deadline = Date.now() + timeBudget;

  const { data: runRow, error: runErr } = await supabase
    .from("satisfaction_scan_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (runErr || !runRow) {
    throw new Error(`scan run ${runId} not found`);
  }
  if (runRow.status === "completed") {
    return rowToProgress(runRow);
  }

  // Load every client once. The cursor indexes into this list.
  const { data: clientRows } = await supabase
    .from("clients")
    .select("id, name, website, websites, contact_emails")
    .order("name", { ascending: true });
  const clients = ((clientRows ?? []) as ClientShape[]).map((c) => ({
    ...c,
    websites: c.websites ?? [],
    contact_emails: c.contact_emails ?? []
  }));

  let cursor: CursorShape = (runRow.cursor as CursorShape | null) ?? {
    clientIndex: 0,
    threadOffset: 0,
    folder: "INBOX"
  };
  // Older runs (before the SENT pass was added) stored cursors without
  // the folder field. Default them to INBOX so they pick up where they
  // left off; the SENT pass kicks in once the INBOX walk completes.
  if (!cursor.folder) cursor.folder = "INBOX";
  let totalThreads = runRow.total_threads ?? 0;
  let processedThreads = runRow.processed_threads ?? 0;
  let totalMessages = runRow.total_messages ?? 0;
  let scoredMessages = runRow.scored_messages ?? 0;
  let skippedMessages = runRow.skipped_messages ?? 0;
  let erroredMessages = runRow.errored_messages ?? 0;
  let lastError: string | null = runRow.last_error ?? null;
  const scopeFromMs = new Date(runRow.scope_from).getTime();
  const scopeToMs = new Date(runRow.scope_to).getTime();

  // Recompute medians only for clients we just touched, so callers
  // don't pay for a full sweep on every chunk.
  const touchedClients = new Set<string>();

  try {
    while (cursor.clientIndex < clients.length && Date.now() < deadline) {
      const client = clients[cursor.clientIndex];
      const signals = buildClientSignals({
        website: client.website,
        websites: client.websites,
        contactEmails: client.contact_emails
      });
      if (signals.emailSet.size === 0 && signals.domainSet.size === 0) {
        // Client has nothing to match on — skip both folder passes.
        cursor = { clientIndex: cursor.clientIndex + 1, threadOffset: 0, folder: "INBOX" };
        continue;
      }

      // Pull threads in chunks of 100, paginating via offset. We stop
      // walking a folder when we get a page where the *oldest* thread
      // is older than scopeFrom — anything past that is out of scope.
      // When INBOX is exhausted, we switch to SENT for the same client
      // to catch outbound-only threads.
      const PAGE = 100;
      const page = await listThreadsPaged({
        folder: cursor.folder,
        limit: PAGE,
        offset: cursor.threadOffset
      });
      if (page.threads.length === 0) {
        cursor = advanceCursor(cursor);
        continue;
      }

      // Filter to threads belonging to this client AND within scope.
      const matched = page.threads.filter((t) => {
        const lastMs = new Date(t.last_message_at).getTime();
        if (Number.isNaN(lastMs)) return false;
        if (lastMs < scopeFromMs) return false;
        if (lastMs >= scopeToMs) return false;
        return threadMatchesClient(t.participants, signals);
      });

      totalThreads += matched.length;

      for (const thread of matched) {
        if (Date.now() >= deadline) break;
        try {
          const detail = await getThread(thread.id);
          const inScope = detail.messages.filter((m) => {
            const t = new Date(m.sent_at).getTime();
            return !Number.isNaN(t) && t >= scopeFromMs && t < scopeToMs;
          });
          totalMessages += inScope.length;

          // Skip messages we've already scored for THIS client. The PK
          // is now composite (message_id, client_id), so a message
          // scored under another client (shared CSM email) still needs
          // its own row here.
          const ids = inScope.map((m) => m.id);
          const { data: existing } = ids.length === 0
            ? { data: [] as { message_id: string }[] }
            : await supabase
                .from("email_satisfaction_scores")
                .select("message_id")
                .in("message_id", ids)
                .eq("client_id", client.id);
          const have = new Set(
            ((existing ?? []) as { message_id: string }[]).map((r) => r.message_id)
          );
          const toScore = inScope.filter((m) => !have.has(m.id));
          skippedMessages += inScope.length - toScore.length;

          // Batch-call Claude.
          for (let i = 0; i < toScore.length; i += BATCH_SIZE) {
            if (Date.now() >= deadline) break;
            const batch = toScore.slice(i, i + BATCH_SIZE);
            try {
              const inputs: MessageToScore[] = batch.map((m) => ({
                id: m.id,
                direction: m.direction,
                fromName: m.from_addr,
                subject: m.subject ?? "",
                body: (m.body_text ?? "").slice(0, 1800)
              }));
              const scored = await scoreMessages(inputs);
              const scoredById = new Map(scored.map((s) => [s.id, s]));

              const rows = batch.map((m) => {
                const s = scoredById.get(m.id);
                return {
                  message_id: m.id,
                  thread_id: m.thread_id,
                  client_id: client.id,
                  account_id: m.account_id,
                  direction: m.direction,
                  from_address: m.from_addr,
                  subject: m.subject ?? null,
                  delivered_at: m.sent_at || null,
                  satisfaction_score: s?.score ?? 75,
                  reason: s?.reason ?? "(model returned no score)",
                  scored_at: new Date().toISOString(),
                  scored_by: "claude-haiku-4-5"
                };
              });
              const { error: insErr } = await supabase
                .from("email_satisfaction_scores")
                .upsert(rows, { onConflict: "message_id,client_id" });
              if (insErr) {
                erroredMessages += rows.length;
                lastError = insErr.message;
              } else {
                scoredMessages += rows.length;
                touchedClients.add(client.id);
              }
            } catch (err) {
              erroredMessages += batch.length;
              lastError = err instanceof Error ? err.message : String(err);
            }
          }
          processedThreads += 1;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      // Decide whether to keep paging this folder, switch folder, or
      // move to the next client. If the page hasMore AND the oldest
      // thread is still in scope, keep paging; otherwise step the
      // cursor forward (INBOX → SENT → next client).
      const oldest = page.threads.reduce((min, t) => {
        const ms = new Date(t.last_message_at).getTime();
        return Math.min(min, Number.isNaN(ms) ? min : ms);
      }, Number.POSITIVE_INFINITY);
      const shouldContinue = page.hasMore && oldest >= scopeFromMs;
      cursor = shouldContinue
        ? {
            clientIndex: cursor.clientIndex,
            threadOffset: cursor.threadOffset + PAGE,
            folder: cursor.folder
          }
        : advanceCursor(cursor);
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  const done = cursor.clientIndex >= clients.length;

  // Persist progress + recompute medians for touched clients.
  await supabase
    .from("satisfaction_scan_runs")
    .update({
      total_threads: totalThreads,
      processed_threads: processedThreads,
      total_messages: totalMessages,
      scored_messages: scoredMessages,
      skipped_messages: skippedMessages,
      errored_messages: erroredMessages,
      cursor: cursor,
      status: done ? "completed" : "running",
      finished_at: done ? new Date().toISOString() : null,
      last_error: lastError
    })
    .eq("id", runId);

  for (const cid of touchedClients) {
    await recomputeClientHealth(cid).catch(() => { /* best-effort */ });
  }

  return {
    runId,
    status: done ? "completed" : "running",
    totalThreads,
    processedThreads,
    totalMessages,
    scoredMessages,
    skippedMessages,
    erroredMessages,
    startedAt: runRow.started_at,
    finishedAt: done ? new Date().toISOString() : null,
    scopeFrom: runRow.scope_from,
    scopeTo: runRow.scope_to,
    lastError,
    done
  };
}

// Cursor state machine: INBOX → SENT → next client. Walking both
// folders is what lets us pick up outbound-only threads (we sent, no
// reply) that wouldn't otherwise show up in INBOX. A thread that
// appears in both folders gets visited twice, but the message-level
// dedupe via the email_satisfaction_scores PK skips the second pass.
function advanceCursor(c: CursorShape): CursorShape {
  if (c.folder !== "SENT") {
    return { clientIndex: c.clientIndex, threadOffset: 0, folder: "SENT" };
  }
  return { clientIndex: c.clientIndex + 1, threadOffset: 0, folder: "INBOX" };
}

// Reads every stored score for a client, computes the median, maps to
// a HealthLabel, and writes back to clients.health_label/score/etc.
// Idempotent — safe to call after any scoring change.
export async function recomputeClientHealth(clientId: string): Promise<{
  score: number | null;
  label: import("@/lib/client-health").HealthLabel | null;
  sampleSize: number;
} | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("email_satisfaction_scores")
    .select("satisfaction_score, reason, delivered_at")
    .eq("client_id", clientId)
    .order("delivered_at", { ascending: false })
    .limit(500);
  if (error) return null;
  const rows = (data ?? []) as Array<{
    satisfaction_score: number;
    reason: string | null;
    delivered_at: string | null;
  }>;
  const scores = rows.map((r) => r.satisfaction_score);
  const sampleSize = scores.length;
  const median = medianScore(scores);
  const label = median === null ? null : scoreToLabel(median);

  // Build a short, human-readable summary: top reason from the most
  // recent low-scored message, if any, else most recent reason.
  const lowest = rows.find((r) => r.satisfaction_score < 60);
  const recent = rows[0];
  const summary = (lowest?.reason || recent?.reason || "").slice(0, 220) || null;

  await supabase
    .from("clients")
    .update({
      health_label: label,
      health_score: median, // 0..100 — UI displays as percentile
      health_sample_size: sampleSize,
      health_summary: summary,
      health_computed_at: new Date().toISOString()
    })
    .eq("id", clientId);

  return { score: median, label, sampleSize };
}

// Recompute every client's health from stored scores. Used after a
// big backfill or when changing the thresholds.
export async function recomputeAllClientHealth(): Promise<{ updated: number }> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("clients")
    .select("id");
  const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
  let updated = 0;
  for (const id of ids) {
    const r = await recomputeClientHealth(id).catch(() => null);
    if (r) updated += 1;
  }
  return { updated };
}

function rowToProgress(row: Record<string, unknown>): ScanProgress {
  return {
    runId: row.id as string,
    status: row.status as ScanProgress["status"],
    totalThreads: (row.total_threads as number) ?? 0,
    processedThreads: (row.processed_threads as number) ?? 0,
    totalMessages: (row.total_messages as number) ?? 0,
    scoredMessages: (row.scored_messages as number) ?? 0,
    skippedMessages: (row.skipped_messages as number) ?? 0,
    erroredMessages: (row.errored_messages as number) ?? 0,
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
    scopeFrom: (row.scope_from as string | null) ?? null,
    scopeTo: (row.scope_to as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    done: row.status === "completed"
  };
}

// Light helper used by the daily incremental cron: scores any
// MissiveMessage rows passed in, attributing them to a client by
// looking at participants.
export async function scoreAndStore(
  messages: Array<MissiveMessage & { clientId: string | null }>
): Promise<{ scored: number; errored: number }> {
  const supabase = getSupabaseAdmin();
  let scored = 0;
  let errored = 0;
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    try {
      const inputs: MessageToScore[] = batch.map((m) => ({
        id: m.id,
        direction: m.direction,
        fromName: m.from_addr,
        subject: m.subject ?? "",
        body: (m.body_text ?? "").slice(0, 1800)
      }));
      const results = await scoreMessages(inputs);
      const byId = new Map(results.map((r) => [r.id, r]));
      const rows = batch.map((m) => {
        const r = byId.get(m.id);
        return {
          message_id: m.id,
          thread_id: m.thread_id,
          client_id: m.clientId,
          account_id: m.account_id,
          direction: m.direction,
          from_address: m.from_addr,
          subject: m.subject ?? null,
          delivered_at: m.sent_at || null,
          satisfaction_score: r?.score ?? 75,
          reason: r?.reason ?? "(model returned no score)",
          scored_at: new Date().toISOString(),
          scored_by: "claude-haiku-4-5"
        };
      });
      const { error } = await supabase
        .from("email_satisfaction_scores")
        .upsert(rows, { onConflict: "message_id,client_id" });
      if (error) errored += rows.length;
      else scored += rows.length;
    } catch {
      errored += batch.length;
    }
  }
  return { scored, errored };
}

// Exported for tests / debug — flag a thread address as a client.
export { parseEmail };
