import "server-only";

import { ATTENTION_ITEM_ID, getAttentionItemIdentity } from "@/lib/exec/attention";
import type { FeedbackReason } from "@/lib/exec/attention-types";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";
import type { FeedbackTotals } from "@/lib/exec/view-types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Needs Attention feedback (P5a contract §3.5, A1, C10): one vote per item,
// kept 365 days, surviving item purges (no foreign key to the item); v1
// stores and counts it only. A row holds ids and enums: the item's id,
// fingerprint and kind, the vote and a reason code, never an item's text.
// The only file that names the feedback table (boundary rule 14).
//
// Reads fail closed (an error throws); a missing table (the P5a migration not
// applied yet) is null for the totals and 0 for the purge, like P3's purges.

const TABLE = "exec_attention_feedback";
export const FEEDBACK_RETENTION_DAYS = 365;
const DAY_MS = 86_400_000;
const PAGE_SIZE = 1_000;
const MAX_PAGES = 50;

/** C10: the reason codes, in the order Settings lists them. "useful" goes with +1 only, the rest with -1 only. */
export const FEEDBACK_REASONS: readonly FeedbackReason[] = Object.freeze([
  "useful",
  "not_relevant",
  "wrong_priority",
  "already_handled",
  "duplicate",
  "wrong_facts",
  "other"
]);
const REASONS: ReadonlySet<string> = new Set(FEEDBACK_REASONS);

export type FeedbackResult =
  | { outcome: "recorded"; itemId: string; vote: 1 | -1; reason: FeedbackReason | null }
  | { outcome: "not_found" };

type DbError = { message: string; code?: string };

/** The table isn't there: 42P01 from Postgres, PGRST205 from PostgREST's schema cache. */
function isMissingTable(error: DbError): boolean {
  return error.code === "42P01" || error.code === "PGRST205" || (/exec_attention_feedback/.test(error.message ?? "") && /does not exist|schema cache/i.test(error.message ?? ""));
}

function failure(what: string, error: DbError, signal: AbortSignal | undefined): Error {
  signal?.throwIfAborted();
  return new Error(`${TABLE} ${what} failed: ${error.code ?? "error"}`);
}

/**
 * C10's pairing: +1 with no reason or "useful"; -1 with no reason or any
 * reason but "useful". True when the pair may be stored (the DB checks it too).
 */
export function isValidFeedback(vote: unknown, reason: unknown): vote is 1 | -1 {
  if (vote !== 1 && vote !== -1) return false;
  if (reason === null) return true;
  if (typeof reason !== "string" || !REASONS.has(reason)) return false;
  return vote === 1 ? reason === "useful" : reason !== "useful";
}

function validNow(now: Date | undefined): Date {
  const at = now ?? new Date();
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new NonRetryableError("exec feedback: now must be a valid Date");
  return at;
}

/**
 * Reads the item's identity (fingerprint, kind), then upserts his one vote on
 * it, keyed (principal_id, item_id): a re-vote replaces the vote, the reason
 * and created_at (C10). The row always has the same keys. A malformed id or a
 * missing item → not_found. Throws NonRetryableError on a bad vote/reason
 * pair (before any read) and an Error on a database error.
 */
export async function recordAttentionFeedback(
  principal: ExecPrincipal,
  itemId: string,
  input: { vote: 1 | -1; reason: FeedbackReason | null },
  opts: { now?: Date; signal?: AbortSignal } = {}
): Promise<FeedbackResult> {
  if (typeof input !== "object" || input === null || !isValidFeedback(input.vote, input.reason)) {
    throw new NonRetryableError("exec feedback: the vote and reason don't pair (useful goes with +1, the other reasons with -1)");
  }
  const now = validNow(opts.now);
  if (typeof itemId !== "string" || !ATTENTION_ITEM_ID.test(itemId)) return { outcome: "not_found" };
  const item = await getAttentionItemIdentity(principal, itemId, { signal: opts.signal });
  if (item === null) return { outcome: "not_found" };

  opts.signal?.throwIfAborted();
  const row = {
    principal_id: principal.id,
    item_id: item.id,
    fingerprint: item.fingerprint,
    kind: item.kind,
    vote: input.vote,
    reason: input.reason,
    created_at: now.toISOString()
  };
  let query = getSupabaseAdmin().from(TABLE).upsert(row, { onConflict: "principal_id,item_id" });
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { error } = await query;
  if (error) throw failure("write", error, opts.signal);
  return { outcome: "recorded", itemId: item.id, vote: input.vote, reason: input.reason };
}

interface FeedbackRow {
  id: number;
  kind: string;
  vote: 1 | -1;
  reason: FeedbackReason | null;
}

function rowFrom(raw: unknown): FeedbackRow {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const id = typeof r.id === "string" && /^\d+$/.test(r.id) ? Number(r.id) : r.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || typeof r.kind !== "string" || !isValidFeedback(r.vote, r.reason ?? null)) {
    throw new Error(`${TABLE} read failed: malformed row`);
  }
  return { id, kind: r.kind, vote: r.vote as 1 | -1, reason: (r.reason ?? null) as FeedbackReason | null };
}

/**
 * His feedback of the last 365 days, counted: thumbs up and down overall, by
 * item kind (most votes first, then by kind) and by reason (in
 * FEEDBACK_REASONS order, reasons with no votes left out). Paged reads of
 * (id, kind, vote, reason) by id, at most MAX_PAGES pages. Throws on a read
 * error; null when the table is missing (the P5a migration isn't applied).
 */
export async function feedbackTotals(principal: ExecPrincipal, now?: Date, opts: { signal?: AbortSignal } = {}): Promise<FeedbackTotals | null> {
  const at = validNow(now);
  const sinceIso = new Date(at.getTime() - FEEDBACK_RETENTION_DAYS * DAY_MS).toISOString();
  const rows: FeedbackRow[] = [];
  let afterId: number | null = null;
  for (let page = 0; ; page += 1) {
    if (page === MAX_PAGES) throw new Error(`${TABLE} read failed: more than ${MAX_PAGES * PAGE_SIZE} rows`);
    opts.signal?.throwIfAborted();
    let query = getSupabaseAdmin().from(TABLE).select("id,kind,vote,reason").eq("principal_id", principal.id).gte("created_at", sinceIso);
    if (afterId !== null) query = query.gt("id", afterId);
    let ordered = query.order("id", { ascending: true }).limit(PAGE_SIZE);
    if (opts.signal) ordered = ordered.abortSignal(opts.signal);
    const { data, error } = await ordered;
    if (error) {
      if (isMissingTable(error)) return null;
      throw failure("read", error, opts.signal);
    }
    if (!Array.isArray(data)) throw new Error(`${TABLE} read failed: no rows array in the response`);
    const pageRows = data.map(rowFrom);
    rows.push(...pageRows);
    if (pageRows.length < PAGE_SIZE) break;
    afterId = pageRows[pageRows.length - 1].id;
  }

  let up = 0;
  let down = 0;
  const byKind = new Map<string, { kind: string; up: number; down: number }>();
  const byReason = new Map<FeedbackReason, number>();
  for (const r of rows) {
    const k = byKind.get(r.kind) ?? { kind: r.kind, up: 0, down: 0 };
    if (r.vote === 1) {
      up += 1;
      k.up += 1;
    } else {
      down += 1;
      k.down += 1;
    }
    byKind.set(r.kind, k);
    if (r.reason !== null) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  }
  return {
    sinceIso,
    up,
    down,
    byKind: [...byKind.values()].sort((a, b) => b.up + b.down - (a.up + a.down) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)),
    byReason: FEEDBACK_REASONS.filter((reason) => byReason.has(reason)).map((reason) => ({ reason, count: byReason.get(reason) ?? 0 }))
  };
}

/**
 * The purge step (§2.6): feedback whose created_at is older than 365 days,
 * every principal. Returns how many rows went; 0 when the table is missing.
 * Throws on any other error.
 */
export async function purgeOldFeedback(now: Date, opts: { signal?: AbortSignal } = {}): Promise<number> {
  const at = validNow(now);
  const cutoff = new Date(at.getTime() - FEEDBACK_RETENTION_DAYS * DAY_MS).toISOString();
  opts.signal?.throwIfAborted();
  let query = getSupabaseAdmin().from(TABLE).delete({ count: "exact" }).lt("created_at", cutoff);
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { count, error } = await query;
  if (error) {
    if (isMissingTable(error)) return 0;
    throw failure("purge", error, opts.signal);
  }
  return count ?? 0;
}
