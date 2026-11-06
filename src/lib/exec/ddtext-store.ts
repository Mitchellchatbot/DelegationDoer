import "server-only";

import {
  DDTEXT_ATTENTION_KINDS,
  DDTEXT_LIVE_DAYS,
  type DdtextConfidence,
  type DdtextFailure,
  type DdtextItemRow,
  type DdtextKind,
  type DdtextOutcome,
  type DdtextSignalRow,
  type DdtextSourceType
} from "@/lib/exec/ddtext-types";
import { ddFingerprintKey } from "@/lib/exec/producers/dd";
import { parseDdtextFingerprint } from "@/lib/exec/producers/ddtext";
import { casSyncState, getSyncState, putSyncState } from "@/lib/exec/sync-state";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// The DD text triage store (P5a contract §3.12.4, A5, C17; Area D): items,
// signals (the AI summary, at most 200 characters, the one stored copy), the
// cursor, and the deletions that keep the attention copy from outliving its
// signal (a-correct-1, a-build-12). Only this file and handlers/purge.ts name
// the ddtext tables (boundary rule 14).
//
// Reads fail closed: a database error throws, never an empty list. The one
// exception is the P5a migration not being applied (a missing table or RPC:
// 42P01 / PGRST205 / 42883 / PGRST202), which reads as "nothing stored" and
// purges as 0, so P5a code can ship ahead of its hand-applied migration.
// Writes the database refuses for their shape (a CHECK, NOT NULL, a value too
// long) are bugs and throw NonRetryableError; everything else throws a plain
// Error, which the job runner retries. Nothing here logs.

const ITEMS = "exec_ddtext_items";
const SIGNALS = "exec_ddtext_signals";
const REPLACE_ITEM = "exec_ddtext_replace_item";
const ATTENTION = "exec_attention_items";

const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
const IN_CHUNK = 200;
const DAY_MS = 86_400_000;

const SOURCE_TYPES: readonly DdtextSourceType[] = ["comment", "status_comment", "handoff_note", "extension_reason", "eod_note", "sod_note"];
const KINDS: readonly DdtextKind[] = ["blocker", "waiting", "decision", "mention"];
const OUTCOMES: readonly DdtextOutcome[] = ["signals", "none", "failed", "deferred"];
const FAILURES: readonly DdtextFailure[] = ["refusal", "truncated", "invalid_output", "input_too_large"];
const CONFIDENCES: readonly DdtextConfidence[] = ["high", "medium", "deterministic"];
const HEX64 = /^[0-9a-f]{64}$/;

export interface DdtextItemWrite {
  sourceType: DdtextSourceType;
  sourceId: string;
  activityLogId: string | null;
  eodNoteId: string | null;
  sodNoteId: string | null;
  taskId: string | null;
  authorUserId: string;
  sourceCreatedAt: string;
  noteDate: string | null;
  outcome: DdtextOutcome;
  failure: DdtextFailure | null;
  contentHash: string;
  model: string | null;
  triageVersion: string;
  expiresAt: string;
}

export interface DdtextSignalWrite {
  kind: DdtextKind;
  summary: string | null;
  confidence: DdtextConfidence;
}

export interface DdtextCursor {
  comments: { at: string | null; id: string | null };
  eod: { at: string | null };
  sod: { at: string | null };
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

type DbError = { code?: string | null; message?: string | null };

const db = () => getSupabaseAdmin();
function sel(table: string, columns: string) {
  return db().from(table).select(columns);
}
type Query = ReturnType<typeof sel>;

/** The P5a migration isn't applied: its table (or RPC) doesn't exist yet. */
function isNotInstalled(error: DbError): boolean {
  const code = error.code ?? "";
  if (code === "42P01" || code === "PGRST205" || code === "42883" || code === "PGRST202") return true;
  const m = error.message ?? "";
  return (
    /relation ".*exec_(ddtext_items|ddtext_signals|attention_items)" does not exist/i.test(m) ||
    /could not find the (table|function) '?public\.exec_(ddtext|attention)/i.test(m)
  );
}

/** The database refused the request's shape: a bug, not a transient failure. */
function isRefusal(error: DbError): boolean {
  const code = error.code ?? "";
  return ["23514", "23502", "22001", "22P02", "22007", "22008", "22023", "42703", "PGRST204", "P0001"].includes(code);
}

/** The error to throw. An aborted signal wins: postgrest-js reports an AbortError result instead of throwing. */
function failure(what: string, error: DbError, signal: AbortSignal | undefined): Error {
  signal?.throwIfAborted();
  const text = `exec ddtext store: ${what} failed: ${error.message ?? "unknown error"}${error.code ? ` (${error.code})` : ""}`;
  return isRefusal(error) ? new NonRetryableError(text) : new Error(text);
}

function refuse(message: string): never {
  throw new NonRetryableError(`exec ddtext store: ${message}`);
}

function chunked<T>(items: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
}

function isoParam(name: string, value: string | Date): string {
  const ms = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) refuse(`${name} must be a valid timestamp`);
  return new Date(ms).toISOString();
}

function principalIdOf(principal: ExecPrincipal): string {
  if (!principal || typeof principal.id !== "string" || principal.id.length === 0) refuse("an ExecPrincipal is required");
  return principal.id;
}

function oneOf<T extends string>(values: readonly T[], v: unknown, what: string): T {
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) refuse(`${what} is not one of ${values.join(", ")}`);
  return v as T;
}

type Row = Record<string, unknown>;
type Page = { data: unknown; error: DbError | null };

/** Every row a query selects, in pages of 1000 by the given unique order; null when the table isn't there. */
async function pageAll(
  what: string,
  build: () => Query,
  orderBy: readonly string[],
  signal: AbortSignal | undefined
): Promise<Row[] | null> {
  const rows: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let query = build();
    for (const column of orderBy) query = query.order(column, { ascending: true });
    query = query.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = (await query) as Page;
    if (error) {
      if (isNotInstalled(error)) return null;
      throw failure(what, error, signal);
    }
    if (!Array.isArray(data)) throw new Error(`exec ddtext store: ${what} failed: no rows array in the response`);
    for (const row of data) rows.push(row as Row);
    if (data.length < PAGE_SIZE) return rows;
  }
  throw new Error(`exec ddtext store: ${what} failed: more than ${MAX_PAGES * PAGE_SIZE} rows`);
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function checkItem(item: DdtextItemWrite): void {
  oneOf(SOURCE_TYPES, item.sourceType, "sourceType");
  oneOf(OUTCOMES, item.outcome, "outcome");
  if (item.failure !== null) oneOf(FAILURES, item.failure, "failure");
  if (typeof item.sourceId !== "string" || item.sourceId.length < 1 || item.sourceId.length > 200) refuse("sourceId must be 1-200 characters");
  if (typeof item.authorUserId !== "string" || item.authorUserId.length === 0) refuse("authorUserId is required");
  if (typeof item.contentHash !== "string" || !HEX64.test(item.contentHash)) refuse("contentHash must be 64 hex characters");
  if (typeof item.triageVersion !== "string" || item.triageVersion.length < 1 || item.triageVersion.length > 40) refuse("triageVersion must be 1-40 characters");
  if (item.model !== null && (typeof item.model !== "string" || item.model.length < 1 || item.model.length > 64)) refuse("model must be 1-64 characters or null");
}

function checkSignal(s: DdtextSignalWrite): void {
  oneOf(KINDS, s.kind, "signal kind");
  oneOf(CONFIDENCES, s.confidence, "signal confidence");
  if (s.kind === "mention") {
    if (s.summary !== null || s.confidence !== "deterministic") refuse("a mention signal has no summary and is deterministic");
  } else if (typeof s.summary !== "string" || s.summary.length < 1 || s.summary.length > 200 || s.confidence === "deterministic") {
    refuse("an AI signal needs a 1-200 character summary and high or medium confidence");
  }
}

/**
 * One item and its signals through exec_ddtext_replace_item (one transaction;
 * a re-triage replaces the signals). "written" | "source_gone" (the DD row was
 * deleted since it was read: nothing is written). A CHECK violation (or an
 * input this function already refuses) throws NonRetryableError: the handler
 * counts it as rejected and goes on.
 */
export async function writeDdtextItem(
  principal: ExecPrincipal,
  item: DdtextItemWrite,
  signals: readonly DdtextSignalWrite[],
  opts: { signal?: AbortSignal } = {}
): Promise<"written" | "source_gone"> {
  const principalId = principalIdOf(principal);
  checkItem(item);
  if (!Array.isArray(signals) || signals.length > 4) refuse("signals must be a list of at most 4");
  const kinds = new Set<string>();
  for (const s of signals) {
    checkSignal(s);
    if (kinds.has(s.kind)) refuse("two signals of one kind");
    kinds.add(s.kind);
  }
  const pItem = {
    source_type: item.sourceType,
    source_id: item.sourceId,
    activity_log_id: item.activityLogId,
    eod_note_id: item.eodNoteId,
    sod_note_id: item.sodNoteId,
    task_id: item.taskId,
    author_user_id: item.authorUserId,
    source_created_at: isoParam("sourceCreatedAt", item.sourceCreatedAt),
    note_date: item.noteDate,
    outcome: item.outcome,
    failure: item.failure,
    content_hash: item.contentHash,
    model: item.model,
    triage_version: item.triageVersion,
    expires_at: isoParam("expiresAt", item.expiresAt)
  };
  const pSignals = signals.map((s) => ({ kind: s.kind, summary: s.summary, confidence: s.confidence }));
  let query = db().rpc(REPLACE_ITEM, { p_principal: principalId, p_item: pItem, p_signals: pSignals });
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { data, error } = (await query) as Page;
  if (error) throw failure("replace item", error, opts.signal);
  if (data === "written" || data === "source_gone") return data;
  throw new Error("exec ddtext store: replace item failed: unexpected result");
}

/** `${type}:${id}` → { contentHash, outcome } for these keys (absent: never triaged). Not installed: empty. */
export async function listDdtextItemsByKeys(
  principal: ExecPrincipal,
  keys: readonly { sourceType: DdtextSourceType; sourceId: string }[],
  opts: { signal?: AbortSignal } = {}
): Promise<Map<string, { contentHash: string; outcome: DdtextOutcome }>> {
  const principalId = principalIdOf(principal);
  const out = new Map<string, { contentHash: string; outcome: DdtextOutcome }>();
  const byType = new Map<DdtextSourceType, string[]>();
  for (const k of keys) {
    const t = oneOf(SOURCE_TYPES, k.sourceType, "sourceType");
    byType.set(t, [...(byType.get(t) ?? []), k.sourceId]);
  }
  for (const [type, ids] of byType) {
    for (const chunk of chunked(unique(ids))) {
      const rows = await pageAll(
        "read items",
        () => sel(ITEMS, "source_type,source_id,content_hash,outcome").eq("principal_id", principalId).eq("source_type", type).in("source_id", chunk),
        ["source_id"],
        opts.signal
      );
      if (rows === null) return new Map();
      for (const r of rows) {
        const id = str(r.source_id);
        const hash = str(r.content_hash);
        if (id === null || hash === null) throw new Error("exec ddtext store: read items failed: malformed row");
        out.set(`${type}:${id}`, { contentHash: hash, outcome: oneOf(OUTCOMES, r.outcome, "outcome") });
      }
    }
  }
  return out;
}

const ITEM_COLS =
  "principal_id,source_type,source_id,task_id,author_user_id,source_created_at,note_date,outcome,failure,content_hash,model,triage_version,triaged_at,expires_at";

function itemRowFrom(r: Row): DdtextItemRow {
  const principalId = str(r.principal_id);
  const sourceId = str(r.source_id);
  const authorUserId = str(r.author_user_id);
  const sourceCreatedAt = str(r.source_created_at);
  const contentHash = str(r.content_hash);
  const triageVersion = str(r.triage_version);
  const triagedAt = str(r.triaged_at);
  const expiresAt = str(r.expires_at);
  if (!principalId || !sourceId || !authorUserId || !sourceCreatedAt || !contentHash || !triageVersion || !triagedAt || !expiresAt) {
    throw new Error("exec ddtext store: read items failed: malformed row");
  }
  return {
    principalId,
    sourceType: oneOf(SOURCE_TYPES, r.source_type, "source_type"),
    sourceId,
    taskId: str(r.task_id),
    authorUserId,
    sourceCreatedAt,
    noteDate: str(r.note_date),
    outcome: oneOf(OUTCOMES, r.outcome, "outcome"),
    failure: r.failure === null || r.failure === undefined ? null : oneOf(FAILURES, r.failure, "failure"),
    contentHash,
    model: str(r.model),
    triageVersion,
    triagedAt,
    expiresAt
  };
}

/** Deferred items with source_created_at >= sinceIso, oldest first, at most `limit` (exec_ddtext_items_deferred_idx). */
export async function listDeferredDdtextItems(
  principal: ExecPrincipal,
  sinceIso: string,
  limit: number,
  opts: { signal?: AbortSignal } = {}
): Promise<DdtextItemRow[]> {
  const principalId = principalIdOf(principal);
  const since = isoParam("sinceIso", sinceIso);
  const n = Math.min(PAGE_SIZE, Math.max(0, Math.floor(Number.isFinite(limit) ? limit : 0)));
  if (n === 0) return [];
  let query = db()
    .from(ITEMS)
    .select(ITEM_COLS)
    .eq("principal_id", principalId)
    .eq("outcome", "deferred")
    .gte("source_created_at", since)
    .order("source_created_at", { ascending: true })
    .order("source_type", { ascending: true })
    .order("source_id", { ascending: true })
    .limit(n);
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { data, error } = (await query) as Page;
  if (error) {
    if (isNotInstalled(error)) return [];
    throw failure("read deferred items", error, opts.signal);
  }
  if (!Array.isArray(data)) throw new Error("exec ddtext store: read deferred items failed: no rows array in the response");
  return (data as Row[]).map(itemRowFrom);
}

const SIGNAL_COLS = "source_type,source_id,kind,summary,confidence,task_id,author_user_id,source_created_at,created_at";

function signalRowFrom(r: Row): DdtextSignalRow {
  const sourceId = str(r.source_id);
  const authorUserId = str(r.author_user_id);
  const sourceCreatedAt = str(r.source_created_at);
  const createdAt = str(r.created_at);
  if (!sourceId || !authorUserId || !sourceCreatedAt || !createdAt) throw new Error("exec ddtext store: read signals failed: malformed row");
  return {
    sourceType: oneOf(SOURCE_TYPES, r.source_type, "source_type"),
    sourceId,
    kind: oneOf(KINDS, r.kind, "kind"),
    summary: str(r.summary),
    confidence: oneOf(CONFIDENCES, r.confidence, "confidence"),
    taskId: str(r.task_id),
    authorUserId,
    sourceCreatedAt,
    createdAt
  };
}

async function readSignals(
  principalId: string,
  q: { sinceIso: string; taskIds?: readonly string[]; kinds?: readonly DdtextKind[] },
  signal: AbortSignal | undefined
): Promise<DdtextSignalRow[] | null> {
  const since = isoParam("sinceIso", q.sinceIso);
  if (q.kinds !== undefined) {
    if (q.kinds.length === 0) return [];
    for (const k of q.kinds) oneOf(KINDS, k, "kind");
  }
  const build = (chunk: readonly string[] | null) => () => {
    let query = sel(SIGNALS, SIGNAL_COLS).eq("principal_id", principalId).gte("source_created_at", since);
    if (chunk) query = query.in("task_id", chunk);
    if (q.kinds !== undefined) query = query.in("kind", [...q.kinds]);
    return query;
  };
  const order = ["source_created_at", "source_type", "source_id", "kind"];
  const out: DdtextSignalRow[] = [];
  const chunks = q.taskIds === undefined ? [null] : chunked(unique(q.taskIds));
  for (const chunk of chunks) {
    const rows = await pageAll("read signals", build(chunk), order, signal);
    if (rows === null) return null;
    out.push(...rows.map(signalRowFrom));
  }
  return out;
}

/** Signals with source_created_at >= sinceIso, optionally for some tasks and kinds (exec_ddtext_signals_recent_idx). Not installed: []. */
export async function listLiveDdtextSignals(
  principal: ExecPrincipal,
  q: { sinceIso: string; taskIds?: readonly string[]; kinds?: readonly DdtextKind[] },
  opts: { signal?: AbortSignal } = {}
): Promise<DdtextSignalRow[]> {
  return (await readSignals(principalIdOf(principal), q, opts.signal)) ?? [];
}

/**
 * The distinct task ids behind ANY stored signal of his, whatever its age
 * (review security-4): the restricted-sender screen must reach signals older
 * than the 14-day live window too, since they stay stored (and readable
 * through listLiveDdtextSignals with any sinceIso) until retention. Paged by
 * the primary key; ids only, never a summary. Not installed: [].
 */
export async function listDdtextSignalTaskIds(principal: ExecPrincipal, opts: { signal?: AbortSignal } = {}): Promise<string[]> {
  const principalId = principalIdOf(principal);
  const rows = await pageAll(
    "read signal task ids",
    () => sel(SIGNALS, "task_id,source_type,source_id,kind").eq("principal_id", principalId),
    ["source_type", "source_id", "kind"],
    opts.signal
  );
  if (rows === null) return [];
  return unique(rows.map((r) => str(r.task_id)).filter((id): id is string => id !== null));
}

// ---------------------------------------------------------------------------
// Deletions and purges
// ---------------------------------------------------------------------------

type DeleteReply = { count: number | null; error: DbError | null };

async function deleted(what: string, query: PromiseLike<unknown>, signal: AbortSignal | undefined): Promise<number | null> {
  const { count, error } = (await query) as DeleteReply;
  if (error) {
    if (isNotInstalled(error)) return null;
    throw failure(what, error, signal);
  }
  return count ?? 0;
}

/** Items whose retention has run out (expires_at < now), every principal; signals cascade. Missing table → 0. */
export async function purgeExpiredDdtext(now: Date, opts: { signal?: AbortSignal } = {}): Promise<number> {
  const at = isoParam("now", now);
  let query = db().from(ITEMS).delete({ count: "exact" }).lt("expires_at", at);
  if (opts.signal) query = query.abortSignal(opts.signal);
  return (await deleted("purge expired items", query, opts.signal)) ?? 0;
}

const ATTENTION_KINDS: readonly string[] = DDTEXT_ATTENTION_KINDS;

/**
 * a-correct-1, a-build-12. Deletes ddtext attention rows (exec_attention_items,
 * source "dd", kind ∈ DDTEXT_ATTENTION_KINDS, ANY status) that (a) no stored
 * signal backs: the fingerprint, parsed as dd:ddtext:<kind>:<source_type>:<key>,
 * matches no exec_ddtext_signals row (principal, source_type, kind) whose
 * ddFingerprintKey(source_id) is <key>, which covers an item purged at
 * retention, a DD row deleted (task hard delete, off-boarding cascade), a
 * restricted-sender deletion and a re-triage that dropped the signal; or (b)
 * whose occurred_at is older than DDTEXT_LIVE_DAYS (no ddtext signal can be
 * live past it, so nothing can reopen them); or (c) whose fingerprint doesn't
 * parse. Reads id, principal_id, fingerprint, occurred_at of those rows (paged
 * by id) and the principal's signals with source_created_at >= now − 14 d
 * (exec_ddtext_signals_recent_idx); `backing` lets the ddtext run pass the
 * signals it just read. Every principal when `principal` is omitted (the purge
 * job). Missing tables → 0.
 */
export async function purgeOrphanDdtextAttention(
  now: Date,
  opts: { principal?: ExecPrincipal; backing?: readonly DdtextSignalRow[]; signal?: AbortSignal } = {}
): Promise<number> {
  const nowMs = Date.parse(isoParam("now", now));
  const floorMs = nowMs - DDTEXT_LIVE_DAYS * DAY_MS;
  const sinceIso = new Date(floorMs).toISOString();
  const onlyPrincipal = opts.principal === undefined ? null : principalIdOf(opts.principal);

  const rows = await pageAll(
    "read ddtext attention rows",
    () => {
      let query = sel(ATTENTION, "id,principal_id,fingerprint,occurred_at").eq("source", "dd").in("kind", [...ATTENTION_KINDS]);
      if (onlyPrincipal !== null) query = query.eq("principal_id", onlyPrincipal);
      return query;
    },
    ["id"],
    opts.signal
  );
  if (rows === null || rows.length === 0) return 0;

  // The backing keys per principal: "<source_type>|<kind>|<key>".
  const backingByPrincipal = new Map<string, Set<string>>();
  const backingOf = async (principalId: string): Promise<Set<string> | null> => {
    const known = backingByPrincipal.get(principalId);
    if (known) return known;
    const signals =
      opts.backing !== undefined && onlyPrincipal === principalId ? [...opts.backing] : await readSignals(principalId, { sinceIso }, opts.signal);
    if (signals === null) return null;
    const keys = new Set(signals.map((s) => `${s.sourceType}|${s.kind}|${ddFingerprintKey(s.sourceId)}`));
    backingByPrincipal.set(principalId, keys);
    return keys;
  };

  const doomed = new Map<string, string[]>();
  for (const r of rows) {
    const id = str(r.id);
    const principalId = str(r.principal_id);
    if (id === null || principalId === null) throw new Error("exec ddtext store: read ddtext attention rows failed: malformed row");
    const occurred = typeof r.occurred_at === "string" ? Date.parse(r.occurred_at) : Number.NaN;
    const parsed = parseDdtextFingerprint(str(r.fingerprint) ?? "");
    let doom = parsed === null || !Number.isFinite(occurred) || occurred < floorMs;
    if (!doom && parsed !== null) {
      const backing = await backingOf(principalId);
      if (backing === null) return 0;
      doom = !backing.has(`${parsed.sourceType}|${parsed.kind}|${parsed.key}`);
    }
    if (doom) doomed.set(principalId, [...(doomed.get(principalId) ?? []), id]);
  }

  let total = 0;
  for (const [principalId, ids] of doomed) {
    for (const chunk of chunked(ids)) {
      let query = db()
        .from(ATTENTION)
        .delete({ count: "exact" })
        .eq("principal_id", principalId)
        .eq("source", "dd")
        .in("kind", [...ATTENTION_KINDS])
        .in("id", chunk);
      if (opts.signal) query = query.abortSignal(opts.signal);
      total += (await deleted("delete ddtext attention rows", query, opts.signal)) ?? 0;
    }
  }
  return total;
}

/** Deletes these items (signals cascade): edited-after-submit deferred notes (K28) and restricted-sender tasks' items. */
export async function deleteDdtextItems(
  principal: ExecPrincipal,
  keys: readonly { sourceType: DdtextSourceType; sourceId: string }[],
  opts: { signal?: AbortSignal } = {}
): Promise<number> {
  const principalId = principalIdOf(principal);
  const byType = new Map<DdtextSourceType, string[]>();
  for (const k of keys) {
    const t = oneOf(SOURCE_TYPES, k.sourceType, "sourceType");
    byType.set(t, [...(byType.get(t) ?? []), k.sourceId]);
  }
  let total = 0;
  for (const [type, ids] of byType) {
    for (const chunk of chunked(unique(ids))) {
      let query = db().from(ITEMS).delete({ count: "exact" }).eq("principal_id", principalId).eq("source_type", type).in("source_id", chunk);
      if (opts.signal) query = query.abortSignal(opts.signal);
      total += (await deleted("delete items", query, opts.signal)) ?? 0;
    }
  }
  return total;
}

/** Every item of these tasks (signals cascade), through exec_ddtext_items_task_idx. */
export async function deleteDdtextItemsForTasks(principal: ExecPrincipal, taskIds: readonly string[], opts: { signal?: AbortSignal } = {}): Promise<number> {
  const principalId = principalIdOf(principal);
  let total = 0;
  for (const chunk of chunked(unique(taskIds))) {
    let query = db().from(ITEMS).delete({ count: "exact" }).eq("principal_id", principalId).in("task_id", chunk);
    if (opts.signal) query = query.abortSignal(opts.signal);
    total += (await deleted("delete task items", query, opts.signal)) ?? 0;
  }
  return total;
}

/** Turning triage off (a-build-12): every item of the principal (signals cascade) and every ddtext attention row, any status. */
export async function deleteAllDdtextData(principal: ExecPrincipal, opts: { signal?: AbortSignal } = {}): Promise<{ items: number; attentionRows: number }> {
  const principalId = principalIdOf(principal);
  let items = db().from(ITEMS).delete({ count: "exact" }).eq("principal_id", principalId);
  if (opts.signal) items = items.abortSignal(opts.signal);
  const itemCount = (await deleted("delete all items", items, opts.signal)) ?? 0;
  let rows = db().from(ATTENTION).delete({ count: "exact" }).eq("principal_id", principalId).eq("source", "dd").in("kind", [...ATTENTION_KINDS]);
  if (opts.signal) rows = rows.abortSignal(opts.signal);
  const rowCount = (await deleted("delete all ddtext attention rows", rows, opts.signal)) ?? 0;
  return { items: itemCount, attentionRows: rowCount };
}

// ---------------------------------------------------------------------------
// The cursor (exec_sync_state ddtext/cursor, contract §2.5)
// ---------------------------------------------------------------------------

const CURSOR_SOURCE = "ddtext" as const;
const CURSOR_KEY = "cursor";
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;
const CURSOR_ID = /^[A-Za-z0-9_.:@-]{1,200}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function timeOrNull(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === "string" && CURSOR_TIME.test(v) && Number.isFinite(Date.parse(v.replace(" ", "T"))) ? v : undefined;
}

/** The stored cursor (rev ignored), or null when anything present is malformed. Positions are raw timestamps, microseconds kept. */
export function parseDdtextCursor(raw: unknown): DdtextCursor | null {
  if (!isObj(raw) || !isObj(raw.comments) || !isObj(raw.eod) || !isObj(raw.sod)) return null;
  const commentsAt = timeOrNull(raw.comments.at);
  const eodAt = timeOrNull(raw.eod.at);
  const sodAt = timeOrNull(raw.sod.at);
  const startedAt = timeOrNull(raw.startedAt);
  const id = raw.comments.id;
  if (commentsAt === undefined || eodAt === undefined || sodAt === undefined || !startedAt) return null;
  if (id !== null && id !== undefined && (typeof id !== "string" || !CURSOR_ID.test(id))) return null;
  return { comments: { at: commentsAt, id: typeof id === "string" ? id : null }, eod: { at: eodAt }, sod: { at: sodAt }, startedAt };
}

/** The saved cursor and its rev; null before the first run (or when the stored one doesn't parse). Errors throw. */
export async function getDdtextCursor(principal: ExecPrincipal, opts: { signal?: AbortSignal } = {}): Promise<{ value: DdtextCursor; rev: number } | null> {
  return getSyncState(principal, CURSOR_SOURCE, CURSOR_KEY, parseDdtextCursor, opts);
}

/**
 * Save the cursor: compare-and-set on the rev that was read, or (no usable
 * cursor was read) an unconditional write that also replaces an unparseable
 * row. false = another writer got there first (the caller logs and goes on).
 */
export async function saveDdtextCursor(
  principal: ExecPrincipal,
  expectedRev: number | null,
  cursor: DdtextCursor,
  opts: { signal?: AbortSignal } = {}
): Promise<boolean> {
  const value = { comments: { at: cursor.comments.at, id: cursor.comments.id }, eod: { at: cursor.eod.at }, sod: { at: cursor.sod.at }, startedAt: cursor.startedAt };
  if (parseDdtextCursor(value) === null) refuse("the cursor is malformed");
  if (expectedRev === null) {
    await putSyncState(principal, CURSOR_SOURCE, CURSOR_KEY, value, opts);
    return true;
  }
  return casSyncState(principal, CURSOR_SOURCE, CURSOR_KEY, expectedRev, value, opts);
}

/** The cursor's startedAt: when the triage last completed a run ("DD text checked …", a-correct-16); null before the first run. */
export async function ddtextLastRunAt(principal: ExecPrincipal, opts: { signal?: AbortSignal } = {}): Promise<string | null> {
  return (await getDdtextCursor(principal, opts))?.value.startedAt ?? null;
}
