import "server-only";

import { createHash } from "node:crypto";

import { deleteEmailAttentionForThreads } from "@/lib/exec/attention";
import { listChatDraftIdsForThreads, redactChatForThreads } from "@/lib/exec/chat-store";
import { purgeDraftsByIds, purgeDraftsForThreads } from "@/lib/exec/drafts-store";
import {
  commitmentExpiresAt,
  planThreadWrite,
  toMs,
  type EmailThreadPatch,
  type ThreadProposal,
  type WritePlan
} from "@/lib/exec/email-state";
import type {
  CommitmentDirection,
  CommitmentStatus,
  EmailBucket,
  EmailSignalInput,
  EmailThreadState,
  ExecCommitment,
  ExecEmailSignal,
  ExecEmailThread,
  NewCommitment,
  OutlookImportance,
  ReplyArtifacts,
  ThreadScreenRow
} from "@/lib/exec/email-types";
import { loadScreeningPolicy, overlayAnswered } from "@/lib/exec/sources/mail";
import { TRIAGE_VERSION } from "@/lib/exec/triage/email";
import { NonRetryableError, type ExecPrincipal, type ExecSettings, type SourceRef } from "@/lib/exec/types";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// The store behind email intelligence (contract §3.9, v3.1 A1-A6, round-4
// addenda): exec_email_threads, exec_commitments, exec_email_signals.
//
// Every thread write goes through applyThreadProposal, which asks the pure
// state machine (email-state.ts) what it may do and does exactly that under a
// compare-and-set on the row's version. The restricted-sender rules and the
// policy hash H are reloaded for every attempt (A1), so a rule added while a
// job ran still turns its write into a tombstone. A tombstone runs the
// tombstone procedure: delete the thread's commitments, write the whitelist
// row, delete its commitments again (one may have landed in between), its
// signals, purge its assistant drafts (P4: content emptied, the row kept so
// an Outlook draft stays tracked), delete its email attention rows, and (P5b)
// redact every chat answer that drew on it and purge those answers' chat drafts.
//
// Reads fail closed: a database error throws, never an empty list, because
// an empty Email tab or commitments card must mean "nothing", not "couldn't
// read". The one exception is the migration not being applied yet (a missing
// table or function, 42P01/PGRST205/42883/PGRST202): every email path treats
// that as "not installed" and skips with zero (L1), so P2a/P2b keep working
// when P3 code ships before its hand-applied migration.
//
// Writes that the database refuses for their shape (a CHECK, NOT NULL, a
// value too long, a column that doesn't exist) are programming errors and
// throw NonRetryableError. Everything else (network, timeouts, 5xx) throws a
// plain Error, which the job runner retries.
//
// Nothing here logs message content: log lines carry ids and counts only.

// ---------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------

const THREADS = "exec_email_threads";
const COMMITMENTS = "exec_commitments";
const SIGNALS = "exec_email_signals";
const ATTENTION = "exec_attention_items";

/** Compare-and-set attempts for an ordinary write before giving up as a skip. */
export const WRITE_ATTEMPTS = 3;
/** A write that is, or becomes, a tombstone never ends as a skip: it retries this long, then throws (addenda §1.5). */
export const TOMBSTONE_ATTEMPTS = 10;
/** Rows per RPC call and per insert/upsert batch. */
export const WRITE_CHUNK = 200;

const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
// A `.in(...)` list travels in the URL; keep each under this many characters.
const URL_LIST_BUDGET = 6_000;
const DAY_MS = 86_400_000;
const HEX64 = /^[0-9a-f]{64}$/;

/** Reply / waiting / producer window (L12). */
export const ACTIVE_WINDOW_DAYS = 30;
const URGENT_DAYS = 14;
const IMPORTANT_DAYS = 7;
const FILTERED_DAYS = 7;
const WAITING_MIN_DAYS = 2;

type DbError = { code?: string | null; message?: string | null };

const db = () => getSupabaseAdmin();
function sel(table: string, columns: string, options?: { count: "exact"; head: true }) {
  return db().from(table).select(columns, options);
}
type Query = ReturnType<typeof sel>;

/** The migration isn't applied: the table (or RPC) doesn't exist yet. */
function isNotInstalled(error: DbError): boolean {
  const code = error.code ?? "";
  if (code === "42P01" || code === "PGRST205" || code === "42883" || code === "PGRST202") return true;
  const m = error.message ?? "";
  return /relation ".*exec_(email_threads|commitments|email_signals|attention_items)" does not exist/i.test(m) ||
    /could not find the (table|function) '?public\.exec_(email|commitments|attention)/i.test(m);
}

/** The database refused the request's shape: a bug, not a transient failure. */
function isRefusal(error: DbError): boolean {
  const code = error.code ?? "";
  return (
    code === "23514" || // check_violation
    code === "23502" || // not_null_violation
    code === "22001" || // string too long
    code === "22P02" || // invalid text representation
    code === "22007" || // invalid datetime format
    code === "22008" || // datetime out of range
    code === "22023" || // invalid parameter value
    code === "42703" || // undefined column
    code === "PGRST204" || // column not in the schema cache
    code === "P0001" // raise exception (an RPC's own guard)
  );
}

/**
 * The error to throw for a failed request. An aborted signal (timeout, lost
 * lease) wins: postgrest-js reports an AbortError result instead of throwing.
 */
function failure(what: string, error: DbError, signal: AbortSignal | undefined): Error {
  signal?.throwIfAborted();
  const text = `exec email store: ${what} failed: ${error.message ?? "unknown error"}${error.code ? ` (${error.code})` : ""}`;
  return isRefusal(error) ? new NonRetryableError(text) : new Error(text);
}

function refuse(message: string): never {
  throw new NonRetryableError(`exec email store: ${message}`);
}

function checkId(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 200 || /[\x00-\x1f\x7f]/.test(v)) refuse(`${field} is malformed`);
  return v;
}

function checkIds(ids: readonly unknown[], field: string): string[] {
  if (!Array.isArray(ids)) refuse(`${field} must be a list`);
  return [...new Set(ids.map((id) => checkId(id, field)))];
}

/** Lists for `.in(...)`: at most WRITE_CHUNK ids and URL_LIST_BUDGET characters each. */
function urlListChunks(values: readonly string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const value of values) {
    const cost = encodeURIComponent(value).length + 3;
    if (current.length > 0 && (current.length >= WRITE_CHUNK || size + cost > URL_LIST_BUDGET)) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(value);
    size += cost;
  }
  if (current.length > 0) out.push(current);
  return out;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const isoMinusDays = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();

function validNow(now: Date): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) refuse("a valid `now` is required");
  return now;
}

/**
 * Every row of a query, in pages ordered by `orderBy` (unique together).
 * Throws on any error and when there are more rows than MAX_PAGES pages: a
 * silently cut list would read as complete. `null` = not installed.
 */
async function pageAll(
  what: string,
  build: () => Query,
  orderBy: readonly string[],
  signal: AbortSignal | undefined
): Promise<Record<string, unknown>[] | null> {
  const rows: Record<string, unknown>[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    signal?.throwIfAborted();
    let query = build();
    for (const column of orderBy) query = query.order(column, { ascending: true });
    query = query.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) {
      if (isNotInstalled(error)) return null;
      throw failure(what, error, signal);
    }
    if (!Array.isArray(data)) throw new Error(`exec email store: ${what} failed: the response carried no rows`);
    for (const row of data) rows.push(row as unknown as Record<string, unknown>);
    if (data.length < PAGE_SIZE) return rows;
  }
  throw new Error(`exec email store: ${what} failed: more than ${MAX_PAGES * PAGE_SIZE} rows`);
}

// ---------------------------------------------------------------------------
// Row mapping (snake_case columns ↔ camelCase fields), fail closed
// ---------------------------------------------------------------------------

type ColumnKind = "text" | "text?" | "int" | "bool" | "bool?" | "ts" | "ts?" | "text[]" | "object";

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Every column of exec_email_threads and its shape (mirrors the migration). */
export const THREAD_COLUMNS = Object.freeze({
  principal_id: "text",
  thread_id: "text",
  account_id: "text",
  state: "text",
  version: "int",
  snapshot_identity_count: "int",
  snapshot_max_created_at: "ts?",
  snapshot_max_sent_at: "ts?",
  snapshot_read_started_at: "ts?",
  snapshot_read_done_at: "ts?",
  gone_at: "ts?",
  screen_hashes: "text[]",
  screen_truncated: "bool",
  screened_policy_hash: "text?",
  subject: "text?",
  counterpart_name: "text?",
  counterpart_email: "text?",
  correspondents: "text[]",
  message_count: "int",
  newest_message_id: "text?",
  newest_inbound_message_id: "text?",
  newest_outbound_message_id: "text?",
  last_inbound_at: "ts?",
  last_outbound_at: "ts?",
  newest_is_outbound: "bool?",
  answered_state: "text?",
  answered_at: "ts?",
  answered_message_id: "text?",
  partial_thread: "bool",
  outbound_automated_only: "bool",
  client_id: "text?",
  client_name: "text?",
  client_match_via: "text?",
  match_confidence: "text?",
  client_candidates: "int",
  summary: "text?",
  reason: "text?",
  category: "text?",
  urgency: "text?",
  importance: "text?",
  needs_reply: "bool?",
  mitchell_personally: "bool?",
  awaiting_reply_from_others: "bool?",
  decision_question: "text?",
  decision_message_id: "text?",
  client_signal: "text?",
  automated: "bool?",
  injection_suspected: "bool",
  filter_reason: "text?",
  triage_error: "text?",
  refusal_category: "text?",
  content_hash: "text?",
  model: "text?",
  triage_version: "text?",
  attempted_version: "text?",
  input_watermark: "ts?",
  outcome_watermark: "ts?",
  input_truncated: "bool",
  body_source: "text?",
  triaged_at: "ts?",
  deferred_at: "ts?",
  last_attempt_at: "ts?",
  last_attempt_error: "text?",
  first_seen_at: "ts",
  updated_at: "ts",
  expires_at: "ts"
} satisfies Record<string, ColumnKind>);

const COMMITMENT_COLUMNS = Object.freeze({
  id: "text",
  principal_id: "text",
  fingerprint: "text",
  source: "text",
  thread_id: "text",
  message_id: "text",
  account_id: "text",
  direction: "text",
  text: "text",
  counterparty: "text?",
  due_at: "ts?",
  due_text: "text?",
  status: "text",
  followed_up_at: "ts?",
  evidence_excerpt: "text",
  source_ref: "object",
  message_sent_at: "ts",
  message_created_at: "ts?",
  created_at: "ts",
  updated_at: "ts",
  expires_at: "ts"
} satisfies Record<string, ColumnKind>);

const SIGNAL_COLUMNS = Object.freeze({
  principal_id: "text",
  message_id: "text",
  thread_id: "text",
  account_id: "text",
  direction: "text",
  flagged: "bool?",
  importance: "text?",
  unread: "bool?",
  removed_at: "ts?",
  web_link: "text?",
  signals_at: "ts",
  expires_at: "ts"
} satisfies Record<string, ColumnKind>);

const STATES: readonly EmailThreadState[] = ["triaged", "filtered", "triage_failed", "deferred_budget", "restricted_hidden", "gone"];

function cell(row: Record<string, unknown>, column: string, kind: ColumnKind, table: string): unknown {
  const v = row[column];
  const bad = () => new Error(`exec email store: ${table} read failed: column ${column} is malformed`);
  switch (kind) {
    case "text":
      if (typeof v !== "string") throw bad();
      return v;
    case "text?":
      if (v !== null && typeof v !== "string") throw bad();
      return v;
    case "int":
      if (typeof v !== "number" || !Number.isSafeInteger(v)) throw bad();
      return v;
    case "bool":
      if (typeof v !== "boolean") throw bad();
      return v;
    case "bool?":
      if (v !== null && typeof v !== "boolean") throw bad();
      return v;
    case "ts":
      if (typeof v !== "string" || toMs(v) === null) throw bad();
      return v;
    case "ts?":
      if (v !== null && (typeof v !== "string" || toMs(v) === null)) throw bad();
      return v;
    case "text[]":
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw bad();
      return [...v];
    case "object":
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw bad();
      return v;
  }
}

function mapRow<T>(raw: unknown, columns: Readonly<Record<string, ColumnKind>>, selected: readonly string[], table: string): T {
  if (typeof raw !== "object" || raw === null) throw new Error(`exec email store: ${table} read failed: a row is not an object`);
  const row = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const column of selected) out[camel(column)] = cell(row, column, columns[column], table);
  if ("state" in out && !STATES.includes(out.state as EmailThreadState)) {
    throw new Error(`exec email store: ${table} read failed: column state is malformed`);
  }
  return out as T;
}

const ALL_THREAD_COLUMNS = Object.keys(THREAD_COLUMNS);
const ALL_COMMITMENT_COLUMNS = Object.keys(COMMITMENT_COLUMNS);
const ALL_SIGNAL_COLUMNS = Object.keys(SIGNAL_COLUMNS);

const threadFrom = (raw: unknown) => mapRow<ExecEmailThread>(raw, THREAD_COLUMNS, ALL_THREAD_COLUMNS, THREADS);
const commitmentFrom = (raw: unknown) => mapRow<ExecCommitment>(raw, COMMITMENT_COLUMNS, ALL_COMMITMENT_COLUMNS, COMMITMENTS);
const signalFrom = (raw: unknown) => mapRow<ExecEmailSignal>(raw, SIGNAL_COLUMNS, ALL_SIGNAL_COLUMNS, SIGNALS);

function threadColumnsOf<K extends keyof ExecEmailThread>(keys: readonly K[]): string[] {
  return keys.map((k) => {
    const column = snake(k);
    if (!(column in THREAD_COLUMNS)) refuse(`unknown thread field ${k}`);
    return column;
  });
}

/** A plan's camelCase patch → the columns it writes. */
function patchColumns(patch: EmailThreadPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    const column = snake(k);
    if (!(column in THREAD_COLUMNS) || column === "principal_id" || column === "thread_id" || column === "version" || column === "updated_at") {
      refuse(`a plan may not write ${k}`);
    }
    out[column] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Threads: single reads
// ---------------------------------------------------------------------------

export interface StoreOptions {
  signal?: AbortSignal;
}

type ThreadRead = { installed: true; row: ExecEmailThread | null } | { installed: false };

async function readThread(principal: ExecPrincipal, threadId: string, signal: AbortSignal | undefined): Promise<ThreadRead> {
  let query = sel(THREADS, ALL_THREAD_COLUMNS.join(",")).eq("principal_id", principal.id).eq("thread_id", threadId);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query.maybeSingle();
  if (error) {
    if (isNotInstalled(error)) return { installed: false };
    throw failure(`${THREADS} read`, error, signal);
  }
  return { installed: true, row: data ? threadFrom(data) : null };
}

/** The stored row of one thread, or null (none, or the migration isn't applied). Throws on a database error. */
export async function getEmailThread(principal: ExecPrincipal, threadId: string, opts: StoreOptions = {}): Promise<ExecEmailThread | null> {
  checkId(threadId, "threadId");
  const read = await readThread(principal, threadId, opts.signal);
  return read.installed ? read.row : null;
}

// ---------------------------------------------------------------------------
// applyThreadProposal: the CAS loop and the tombstone procedure
// ---------------------------------------------------------------------------

export interface ApplyContext {
  now: Date;
  /** exec_settings.retention_days_email. */
  retentionDays: number;
}

export type ScreeningPolicyLoader = () => Promise<{ rules: RestrictedSenderRule[]; hash: string }>;

export interface ApplyOptions extends StoreOptions {
  /**
   * Loads the applicable restricted-sender rules and the current policy hash
   * H. Called for every compare-and-set attempt of a triage, stamp or hashes
   * proposal (A1), once for a gone proposal, never for a tombstone (it needs
   * none). Default: loadScreeningPolicy (strict; a failure throws, and the job
   * retries).
   */
  loadRules?: ScreeningPolicyLoader;
}

export interface ApplyResult {
  result: "inserted" | "updated" | "tombstoned" | "skipped";
  /** Why a write was skipped: the planner's reason, "conflict" or "not_installed". */
  reason?: string;
  /** The commitments this write inserted (none on a tombstone). */
  commitments: ExecCommitment[];
}

type CasOutcome = "ok" | "conflict" | "not_installed";

async function casWrite(
  principal: ExecPrincipal,
  threadId: string,
  current: ExecEmailThread | null,
  plan: Exclude<WritePlan, { action: "skip" }>,
  now: Date,
  signal: AbortSignal | undefined
): Promise<CasOutcome> {
  const columns = patchColumns(plan.patch);
  const updatedAt = now.toISOString();
  if (plan.insert) {
    if (current !== null) refuse("an insert plan for a row that exists");
    // Insert-if-absent: a row another writer created meanwhile is a conflict,
    // and the loop re-plans against it.
    let query = db()
      .from(THREADS)
      .upsert({ principal_id: principal.id, thread_id: threadId, version: 1, updated_at: updatedAt, ...columns }, {
        onConflict: "principal_id,thread_id",
        ignoreDuplicates: true
      })
      .select("thread_id");
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) {
      if (isNotInstalled(error)) return "not_installed";
      throw failure(`${THREADS} insert`, error, signal);
    }
    return Array.isArray(data) && data.length > 0 ? "ok" : "conflict";
  }
  if (current === null) refuse("an update plan without a row");
  let query = db()
    .from(THREADS)
    .update({ ...columns, version: current.version + 1, updated_at: updatedAt })
    .eq("principal_id", principal.id)
    .eq("thread_id", threadId)
    .eq("version", current.version)
    .select("thread_id");
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) {
    if (isNotInstalled(error)) return "not_installed";
    throw failure(`${THREADS} update`, error, signal);
  }
  return Array.isArray(data) && data.length > 0 ? "ok" : "conflict";
}

/**
 * Steps 3-6 of the tombstone procedure: whatever about the thread could have
 * landed or survived around the CAS. Step 5 (P4 contract §2.7, X4) empties the
 * thread's assistant drafts through exec_drafts_purge_restricted: a null
 * answer means the P4 migration isn't applied and is fine; any other failure
 * throws (retryable), so the procedure never finishes without it. Step 6 is
 * Area E's deleteEmailAttentionForThreads (attention.ts, contract §3.13),
 * which parses email:thread:/email:commitment: fingerprints and hard-deletes
 * the thread's email attention rows in every status. A step that fails throws
 * after the tombstone has landed; on a transient failure the job retries, and
 * the retry finds the tombstone already in place and runs these steps again
 * (applyThreadProposal's noop branch).
 *
 * P5b (contract §3.18, B7, C19, C20): then, as the last steps, every chat
 * answer that consulted or cited the thread, and every later answer of the
 * same conversation, is redacted (principal-wide: a tombstone is a verified
 * verdict), and the chat-written drafts on those answers' cards are purged by
 * id (P4's exec_drafts_purge_by_ids, origin = 'chat' rows only), because a
 * chat draft can quote a thread other than its own. Before the P5b migration
 * both answer nothing (0 / []); any other failure throws (retryable), like
 * the steps above.
 */
async function deleteTombstoneLeftovers(principal: ExecPrincipal, threadId: string, signal: AbortSignal | undefined): Promise<void> {
  await deleteCommitmentsForThreads(principal, [threadId], { signal });
  await deleteSignalsForThreads(principal, [threadId], { signal });
  await purgeDraftsForThreads(principal, [threadId], { signal });
  await deleteEmailAttentionForThreads(principal, [threadId], { signal });
  await redactChatForThreads(principal, [threadId], { signal });
  const chatDraftIds = await listChatDraftIdsForThreads(principal, [threadId], { signal });
  if (chatDraftIds.length > 0) await purgeDraftsByIds(principal, chatDraftIds, { signal });
}

/**
 * The tombstone procedure (coherence-18): (1) delete the thread's
 * commitments, (2) write the whitelist row by CAS, (3) delete its commitments
 * again (a write plan's insert may have raced the CAS), (4) delete its signal
 * rows, (5) purge its assistant drafts (P4), (6) delete its email attention
 * rows (Area E), then (P5b) redact its chat answers and purge their chat
 * drafts. Steps 3-6 run only after the CAS landed.
 */
async function tombstoneProcedure(
  principal: ExecPrincipal,
  threadId: string,
  current: ExecEmailThread | null,
  plan: Exclude<WritePlan, { action: "skip" }>,
  now: Date,
  signal: AbortSignal | undefined
): Promise<CasOutcome> {
  if ((await deleteCommitmentsForThreads(principal, [threadId], { signal })) === null) return "not_installed";
  const cas = await casWrite(principal, threadId, current, plan, now, signal);
  if (cas !== "ok") return cas;
  await deleteTombstoneLeftovers(principal, threadId, signal);
  return "ok";
}

function checkPolicy(policy: { rules: RestrictedSenderRule[]; hash: string }): void {
  if (!policy || !Array.isArray(policy.rules) || typeof policy.hash !== "string" || !HEX64.test(policy.hash)) {
    refuse("the rules loader returned no usable policy");
  }
}

/**
 * Apply one proposal to one thread row (contract §3.9 as amended).
 *
 * Each attempt reads the row, reloads the rules (per the proposal kind, see
 * ApplyOptions.loadRules), plans, and writes under a compare-and-set on the
 * version it read. A lost race re-reads and re-plans. An ordinary write that
 * keeps losing ends as { skipped, reason: "conflict" } after WRITE_ATTEMPTS;
 * a tombstone or gone proposal, or any plan that turned into a tombstone,
 * keeps going to TOMBSTONE_ATTEMPTS and then throws a retryable error, so the
 * fail-closed direction never quietly gives up.
 *
 * A write plan inserts its commitments (exec_email_insert_commitments) after
 * its CAS, then re-reads the row: if a tombstone landed in between, those
 * commitments are deleted again (A6.3).
 *
 * The migration not being applied yet → { skipped, reason: "not_installed" }.
 */
export async function applyThreadProposal(
  principal: ExecPrincipal,
  settings: ExecSettings,
  threadId: string,
  proposal: ThreadProposal,
  ctx: ApplyContext,
  opts: ApplyOptions = {}
): Promise<ApplyResult> {
  checkId(threadId, "threadId");
  if (settings.principalId !== principal.id) refuse("the settings belong to another principal");
  if (proposal.kind === "triage" && Array.isArray(proposal.commitments) && proposal.commitments.some((c) => c?.threadId !== threadId)) {
    refuse("a commitment of another thread rode on this thread's write");
  }
  const now = validNow(ctx.now);
  const signal = opts.signal;
  const loadRules: ScreeningPolicyLoader = opts.loadRules ?? (() => loadScreeningPolicy(principal, { signal }));
  const failClosed = proposal.kind === "tombstone" || proposal.kind === "gone";
  let budget = failClosed ? TOMBSTONE_ATTEMPTS : WRITE_ATTEMPTS;
  let sawTombstone = failClosed;

  // A tombstone needs no rules, and a gone proposal screens the stored row
  // once (addenda §1.5): neither reloads per attempt.
  let fixedPolicy: { rules: RestrictedSenderRule[]; hash: string } | null = null;
  if (proposal.kind === "tombstone") fixedPolicy = { rules: [], hash: proposal.policyHash };
  else if (proposal.kind === "gone") {
    fixedPolicy = await loadRules();
    checkPolicy(fixedPolicy);
  }

  for (let attempt = 1; attempt <= budget; attempt += 1) {
    signal?.throwIfAborted();
    const read = await readThread(principal, threadId, signal);
    if (!read.installed) return { result: "skipped", reason: "not_installed", commitments: [] };
    const current = read.row;
    let policy = fixedPolicy;
    if (policy === null) {
      policy = await loadRules();
      checkPolicy(policy);
    }
    const plan = planThreadWrite(current, proposal, {
      rules: policy.rules,
      currentPolicyHash: policy.hash,
      now,
      retentionDays: ctx.retentionDays
    });

    if (plan.action === "skip") {
      // A tombstone-direction proposal that finds the tombstone already in
      // place re-runs the procedure's last steps: a retry after a failed
      // delete must still finish them.
      if (plan.reason === "noop" && current?.state === "restricted_hidden") {
        await deleteTombstoneLeftovers(principal, threadId, signal);
      }
      return { result: "skipped", reason: plan.reason, commitments: [] };
    }

    const endsAsTombstone = plan.action === "tombstone" || (plan.patch.state ?? current?.state) === "restricted_hidden";
    if (endsAsTombstone) {
      sawTombstone = true;
      budget = Math.max(budget, TOMBSTONE_ATTEMPTS);
      const outcome = await tombstoneProcedure(principal, threadId, current, plan, now, signal);
      if (outcome === "not_installed") return { result: "skipped", reason: "not_installed", commitments: [] };
      if (outcome === "conflict") continue;
      return { result: "tombstoned", commitments: [] };
    }

    const outcome = await casWrite(principal, threadId, current, plan, now, signal);
    if (outcome === "not_installed") return { result: "skipped", reason: "not_installed", commitments: [] };
    if (outcome === "conflict") continue;

    let commitments: ExecCommitment[] = [];
    if (plan.action === "write" && plan.commitmentsToUpsert.length > 0) {
      commitments = await upsertCommitments(principal, settings, plan.commitmentsToUpsert, { signal, retentionDays: ctx.retentionDays });
      if (commitments.length > 0) {
        // A6.3: a tombstone (or a delete) that landed after our CAS must not
        // be left holding the commitments we just inserted.
        const after = await getEmailThread(principal, threadId, { signal });
        if (after === null || after.state === "restricted_hidden") {
          await deleteCommitmentsForThreads(principal, [threadId], { signal });
          commitments = [];
        }
      }
    }
    return { result: plan.insert ? "inserted" : "updated", commitments };
  }

  if (sawTombstone) {
    // Retryable on purpose (a plain Error): the version only moves forward,
    // so a later attempt lands.
    throw new Error(`exec email store: thread ${threadId} kept changing under a tombstone write (${budget} attempts)`);
  }
  return { result: "skipped", reason: "conflict", commitments: [] };
}

// ---------------------------------------------------------------------------
// Threads: list reads
// ---------------------------------------------------------------------------

const activityFilter = (sinceIso: string) => `last_inbound_at.gte.${sinceIso},last_outbound_at.gte.${sinceIso}`;

/** The columns the Email tab needs for buckets, the render-time screen and display. */
export const BUCKET_ROW_KEYS = [
  "threadId",
  "accountId",
  "state",
  "screenHashes",
  "screenTruncated",
  "screenedPolicyHash",
  "subject",
  "counterpartName",
  "counterpartEmail",
  "messageCount",
  "newestMessageId",
  "newestInboundMessageId",
  "newestOutboundMessageId",
  "lastInboundAt",
  "lastOutboundAt",
  "newestIsOutbound",
  "answeredState",
  "answeredAt",
  "partialThread",
  "outboundAutomatedOnly",
  "clientId",
  "clientName",
  "clientMatchVia",
  "matchConfidence",
  "summary",
  "reason",
  "category",
  "urgency",
  "importance",
  "needsReply",
  "mitchellPersonally",
  "awaitingReplyFromOthers",
  "decisionQuestion",
  "clientSignal",
  "injectionSuspected",
  "filterReason",
  "triageError",
  "lastAttemptError",
  "triagedAt",
  "deferredAt",
  "updatedAt"
] as const satisfies readonly (keyof ExecEmailThread)[];
export type BucketRow = Pick<ExecEmailThread, (typeof BUCKET_ROW_KEYS)[number]>;

/** The columns the attention producers need, the screen included. */
export const PRODUCER_ROW_KEYS = [
  "threadId",
  "accountId",
  "state",
  "version",
  "screenHashes",
  "screenTruncated",
  "screenedPolicyHash",
  "subject",
  "counterpartName",
  "counterpartEmail",
  "newestMessageId",
  "newestInboundMessageId",
  "newestOutboundMessageId",
  "lastInboundAt",
  "lastOutboundAt",
  "newestIsOutbound",
  "answeredState",
  "answeredAt",
  "outboundAutomatedOnly",
  "clientId",
  "clientName",
  "clientMatchVia",
  "matchConfidence",
  "clientCandidates",
  "summary",
  "reason",
  "category",
  "urgency",
  "importance",
  "needsReply",
  "mitchellPersonally",
  "awaitingReplyFromOthers",
  "decisionQuestion",
  "decisionMessageId",
  "clientSignal",
  "automated",
  "injectionSuspected",
  "triagedAt"
] as const satisfies readonly (keyof ExecEmailThread)[];
export type ProducerThreadRow = Pick<ExecEmailThread, (typeof PRODUCER_ROW_KEYS)[number]>;

/** A row the attention pass re-screens (the stamp proposal / bulk stamp). */
export type RescreenRow = Pick<
  ExecEmailThread,
  "threadId" | "version" | "state" | "screenHashes" | "screenTruncated" | "accountId" | "screenedPolicyHash"
>;
const RESCREEN_KEYS = ["threadId", "version", "state", "screenHashes", "screenTruncated", "accountId", "screenedPolicyHash"] as const;
const SCREEN_ROW_KEYS = ["threadId", "accountId", "state", "screenHashes", "screenTruncated", "screenedPolicyHash"] as const;

async function listThreadRows<T>(
  what: string,
  keys: readonly (keyof ExecEmailThread)[],
  filter: (q: Query) => Query,
  signal: AbortSignal | undefined
): Promise<T[]> {
  const columns = threadColumnsOf(keys);
  const rows = await pageAll(what, () => filter(sel(THREADS, columns.join(","))), ["thread_id"], signal);
  if (rows === null) return [];
  return rows.map((r) => mapRow<T>(r, THREAD_COLUMNS, columns, THREADS));
}

/**
 * Every row the Email tab may show: not a tombstone, not gone, with activity
 * (inbound or outbound) in the last ACTIVE_WINDOW_DAYS. Narrow columns; the
 * caller runs screenStoredRow on each before using it, then bucketOf.
 */
export async function listBucketRows(principal: ExecPrincipal, now: Date, opts: StoreOptions = {}): Promise<BucketRow[]> {
  const since = isoMinusDays(validNow(now), ACTIVE_WINDOW_DAYS);
  return listThreadRows<BucketRow>(
    `${THREADS} bucket read`,
    BUCKET_ROW_KEYS,
    (q) => q.eq("principal_id", principal.id).not("state", "in", "(restricted_hidden,gone)").or(activityFilter(since)),
    opts.signal
  );
}

/** The rows the attention producers read: triaged, activity in the last ACTIVE_WINDOW_DAYS, screen columns included. */
export async function listProducerThreads(principal: ExecPrincipal, now: Date, opts: StoreOptions = {}): Promise<ProducerThreadRow[]> {
  const since = isoMinusDays(validNow(now), ACTIVE_WINDOW_DAYS);
  return listThreadRows<ProducerThreadRow>(
    `${THREADS} producer read`,
    PRODUCER_ROW_KEYS,
    (q) => q.eq("principal_id", principal.id).eq("state", "triaged").or(activityFilter(since)),
    opts.signal
  );
}

/**
 * One batch of rows screened under a policy other than `currentHash` (or
 * never screened), keyset-paged by thread id. tier "producer" = the rows the
 * producers read (triaged, active in the window); "rest" = every state and
 * age. Ordered by thread_id; pass the last thread id as afterThreadId.
 */
export async function listRescreenBatch(
  principal: ExecPrincipal,
  currentHash: string,
  q: { tier: "producer" | "rest"; afterThreadId: string | null; limit: number; now?: Date },
  opts: StoreOptions = {}
): Promise<RescreenRow[]> {
  if (!HEX64.test(currentHash)) refuse("listRescreenBatch needs a sha256 policy hash");
  if (!Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > PAGE_SIZE) refuse(`listRescreenBatch limit must be 1-${PAGE_SIZE}`);
  if (q.tier !== "producer" && q.tier !== "rest") refuse("listRescreenBatch tier is unknown");
  const columns = threadColumnsOf(RESCREEN_KEYS);
  let query = sel(THREADS, columns.join(",")).eq("principal_id", principal.id);
  const unstamped = [`screened_policy_hash.is.null`, `screened_policy_hash.neq.${currentHash}`];
  if (q.tier === "producer") {
    // (unstamped) ∧ (active), spelled as one `or` of `and`s: a single logic
    // tree per request, the form the P2b store already relies on.
    const since = isoMinusDays(validNow(q.now ?? new Date()), ACTIVE_WINDOW_DAYS);
    const active = [`last_inbound_at.gte.${since}`, `last_outbound_at.gte.${since}`];
    query = query.eq("state", "triaged").or(unstamped.flatMap((u) => active.map((a) => `and(${u},${a})`)).join(","));
  } else {
    query = query.or(unstamped.join(","));
  }
  if (q.afterThreadId !== null) query = query.gt("thread_id", checkId(q.afterThreadId, "afterThreadId"));
  query = query.order("thread_id", { ascending: true }).limit(q.limit);
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { data, error } = await query;
  if (error) {
    if (isNotInstalled(error)) return [];
    throw failure(`${THREADS} rescreen read`, error, opts.signal);
  }
  if (!Array.isArray(data)) throw new Error(`exec email store: ${THREADS} rescreen read failed: the response carried no rows`);
  return data.map((r) => mapRow<RescreenRow>(r, THREAD_COLUMNS, columns, THREADS));
}

/** Every tombstoned thread id of the principal (the attention pass's safety nets, the restricted count). */
export async function listTombstonedThreadIds(principal: ExecPrincipal, opts: StoreOptions = {}): Promise<string[]> {
  const rows = await listThreadRows<{ threadId: string }>(
    `${THREADS} tombstone read`,
    ["threadId"],
    (q) => q.eq("principal_id", principal.id).eq("state", "restricted_hidden"),
    opts.signal
  );
  return rows.map((r) => r.threadId);
}

/**
 * Rows a reconcile sweep re-triages, keyset-paged by thread id:
 *   version: triaged rows last attempted under another TRIAGE_VERSION;
 *   deferred_budget: rows deferred by the budget (or whose last attempt hit
 *   it) before `before`, the start of the principal's local day.
 */
export async function listStaleThreads(
  principal: ExecPrincipal,
  q: { kind: "deferred_budget" | "version"; before?: string; afterThreadId?: string | null; limit: number },
  opts: StoreOptions = {}
): Promise<{ threadId: string; accountId: string }[]> {
  if (!Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > PAGE_SIZE) refuse(`listStaleThreads limit must be 1-${PAGE_SIZE}`);
  let query = sel(THREADS, "thread_id,account_id").eq("principal_id", principal.id);
  if (q.kind === "version") {
    query = query.eq("state", "triaged").or(`attempted_version.is.null,attempted_version.neq.${TRIAGE_VERSION}`);
  } else if (q.kind === "deferred_budget") {
    const before = q.before;
    if (typeof before !== "string" || toMs(before) === null) refuse("the budget sweep needs `before` (the local day start)");
    const at = new Date(toMs(before) as number).toISOString();
    query = query
      .not("state", "in", "(restricted_hidden,gone)")
      .or(`and(state.eq.deferred_budget,deferred_at.lt.${at}),and(last_attempt_error.eq.budget,last_attempt_at.lt.${at})`);
  } else {
    refuse("listStaleThreads kind is unknown");
  }
  if (q.afterThreadId) query = query.gt("thread_id", checkId(q.afterThreadId, "afterThreadId"));
  query = query.order("thread_id", { ascending: true }).limit(q.limit);
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { data, error } = await query;
  if (error) {
    if (isNotInstalled(error)) return [];
    throw failure(`${THREADS} stale read`, error, opts.signal);
  }
  if (!Array.isArray(data)) throw new Error(`exec email store: ${THREADS} stale read failed: the response carried no rows`);
  return data.map((r) => {
    const row = mapRow<{ threadId: string; accountId: string }>(r, THREAD_COLUMNS, ["thread_id", "account_id"], THREADS);
    return { threadId: row.threadId, accountId: row.accountId };
  });
}

/**
 * The screen columns of these threads' rows, any state and age (A2): what
 * screenStoredRow needs to decide whether a commitment or an email attention
 * item may be shown. A thread with no row is absent from the map (the caller
 * drops what hangs off it). Throws on a database error.
 */
export async function listThreadScreenRows(
  principal: ExecPrincipal,
  threadIds: readonly string[],
  opts: StoreOptions = {}
): Promise<Map<string, ThreadScreenRow>> {
  const ids = checkIds(threadIds, "threadIds");
  const columns = threadColumnsOf(SCREEN_ROW_KEYS);
  const out = new Map<string, ThreadScreenRow>();
  for (const chunk of urlListChunks(ids)) {
    const rows = await pageAll(
      `${THREADS} screen read`,
      () => sel(THREADS, columns.join(",")).eq("principal_id", principal.id).in("thread_id", chunk),
      ["thread_id"],
      opts.signal
    );
    if (rows === null) return new Map();
    for (const r of rows) {
      const row = mapRow<ThreadScreenRow>(r, THREAD_COLUMNS, columns, THREADS);
      out.set(row.threadId, row);
    }
  }
  return out;
}

const CORRESPONDENT_ROW_KEYS = ["threadId", "accountId", "state", "screenHashes", "screenTruncated", "screenedPolicyHash", "correspondents"] as const;

/**
 * P4 (contract §3.14 X4 (b)): every non-tombstone row of the principal with
 * its screen columns and `correspondents`. Callers screen each row with
 * screenStoredRow and use the survivors' correspondents as the "screened P3
 * correspondents" a new draft may address (L8). Not installed -> []. Throws
 * on a database error.
 */
export async function listCorrespondentRows(
  principal: ExecPrincipal,
  opts: StoreOptions = {}
): Promise<Array<ThreadScreenRow & { correspondents: string[] }>> {
  const columns = threadColumnsOf(CORRESPONDENT_ROW_KEYS);
  const rows = await pageAll(
    `${THREADS} correspondents read`,
    () => sel(THREADS, columns.join(",")).eq("principal_id", principal.id).neq("state", "restricted_hidden"),
    ["thread_id"],
    opts.signal
  );
  if (rows === null) return [];
  return rows.map((r) => mapRow<ThreadScreenRow & { correspondents: string[] }>(r, THREAD_COLUMNS, columns, THREADS));
}

/**
 * Stamp rows as screened under `hash` (exec_email_stamp_screened), CAS on each
 * row's version, in chunks of WRITE_CHUNK. Returns how many were stamped; a
 * row that changed since it was planned is left for the next pass.
 */
export async function stampScreened(
  principal: ExecPrincipal,
  items: readonly { threadId: string; version: number }[],
  hash: string,
  opts: StoreOptions = {}
): Promise<number> {
  if (!HEX64.test(hash)) refuse("stampScreened needs a sha256 policy hash");
  const payload = items.map((it) => {
    checkId(it.threadId, "threadId");
    if (!Number.isSafeInteger(it.version) || it.version < 1) refuse("stampScreened item version is malformed");
    return { thread_id: it.threadId, version: it.version };
  });
  let stamped = 0;
  for (const chunk of chunks(payload, WRITE_CHUNK)) {
    opts.signal?.throwIfAborted();
    let call = db().rpc("exec_email_stamp_screened", { p_principal: principal.id, p_items: chunk, p_hash: hash });
    if (opts.signal) call = call.abortSignal(opts.signal);
    const { data, error } = await call;
    if (error) {
      if (isNotInstalled(error)) return stamped;
      throw failure("exec_email_stamp_screened", error, opts.signal);
    }
    if (typeof data !== "number" || !Number.isSafeInteger(data) || data < 0) throw new Error("exec email store: exec_email_stamp_screened returned no count");
    stamped += data;
  }
  return stamped;
}

// ---------------------------------------------------------------------------
// Buckets (L12): pure
// ---------------------------------------------------------------------------

function ageDays(iso: string | null, now: Date): number | null {
  const t = toMs(iso);
  return t === null ? null : (now.getTime() - t) / DAY_MS;
}

const within = (age: number | null, max: number) => age !== null && age <= max;

/**
 * Which buckets a stored row (already through the render-time screen) is in;
 * a row can be in several. `signals` holds the CL1 signals by message id:
 * the newest inbound message's row says whether he archived it
 * (handled_in_outlook, never "needs reply"), and the anchor's (newest
 * inbound, else newest message) whether it is flagged. Importance is the AI
 * field; Outlook's own importance is stored only.
 *
 *   reply      needs_reply ∧ shown as awaiting reply ∧ last inbound ≤ 30 d
 *   urgent     urgency critical/high ∧ awaiting reply ∧ last inbound ≤ 14 d
 *   important  (importance high ∨ flagged) ∧ last activity ≤ 7 d
 *   waiting    awaiting_reply_from_others ∧ his outbound is newest ∧ not
 *              automated-only ∧ 2 d ≤ since his last outbound ≤ 30 d
 *   filtered   filtered / triage_failed / deferred_budget ∧ last activity ≤ 7 d
 *
 * Tombstones and gone rows are in none.
 */
export function bucketOf(
  row: BucketRow,
  signals: ReadonlyMap<string, Pick<ExecEmailSignal, "messageId" | "flagged" | "removedAt">>,
  artifacts: ReplyArtifacts | undefined,
  now: Date
): EmailBucket[] {
  if (row.state === "restricted_hidden" || row.state === "gone") return [];
  const out: EmailBucket[] = [];
  const inboundSignal = row.newestInboundMessageId ? signals.get(row.newestInboundMessageId) : undefined;
  const awaiting = overlayAnswered(row, inboundSignal, artifacts) === "awaiting_reply";
  const anchor = row.newestInboundMessageId ?? row.newestMessageId;
  const flagged = anchor !== null && signals.get(anchor)?.flagged === true;
  const inboundAge = ageDays(row.lastInboundAt, now);
  const outboundAge = ageDays(row.lastOutboundAt, now);
  const activityAges = [inboundAge, outboundAge].filter((a): a is number => a !== null);
  const activityAge = activityAges.length > 0 ? Math.min(...activityAges) : null;

  if (row.needsReply === true && awaiting && within(inboundAge, ACTIVE_WINDOW_DAYS)) out.push("reply");
  if ((row.urgency === "critical" || row.urgency === "high") && awaiting && within(inboundAge, URGENT_DAYS)) out.push("urgent");
  if ((row.importance === "high" || flagged) && within(activityAge, IMPORTANT_DAYS)) out.push("important");
  if (
    row.awaitingReplyFromOthers === true &&
    row.newestIsOutbound === true &&
    !row.outboundAutomatedOnly &&
    outboundAge !== null &&
    outboundAge >= WAITING_MIN_DAYS &&
    outboundAge <= ACTIVE_WINDOW_DAYS
  ) {
    out.push("waiting");
  }
  if ((row.state === "filtered" || row.state === "triage_failed" || row.state === "deferred_budget") && within(activityAge, FILTERED_DAYS)) {
    out.push("filtered");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commitments
// ---------------------------------------------------------------------------

/** One promise's identity: direction, the message it was found in, and its evidence, normalized. */
export function commitmentFingerprint(c: { direction: CommitmentDirection; messageId: string; evidenceExcerpt: string }): string {
  const evidence = c.evidenceExcerpt.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(JSON.stringify(["exec-commitment-v1", c.direction, c.messageId, evidence]), "utf8").digest("hex");
}

// Text from the model, already clipped by triage/email.ts; clipped again by
// code point and cleaned so a stray character can't fail the whole insert.
function cleanClip(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/\u0000/g, "").replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
  const points = Array.from(cleaned);
  const s = (points.length > max ? points.slice(0, max) : points).join("").trim();
  return s.length > 0 ? s : null;
}

const SOURCE_CLASSES = ["public", "private", "internal", "finance", "restricted"];
const SOURCE_SYSTEMS = ["dd", "outlook", "slack", "meeting", "web"];

/** A commitment's SourceRef as stored: never with an excerpt (the evidence stays out of refs). */
function storedRef(ref: SourceRef): Record<string, unknown> {
  if (typeof ref !== "object" || ref === null) refuse("commitment.sourceRef is missing");
  if (!SOURCE_SYSTEMS.includes(ref.system) || !SOURCE_CLASSES.includes(ref.class)) refuse("commitment.sourceRef is malformed");
  if (typeof ref.id !== "string" || ref.id.length === 0 || typeof ref.label !== "string") refuse("commitment.sourceRef is malformed");
  return { system: ref.system, id: ref.id, url: typeof ref.url === "string" ? ref.url : null, label: cleanClip(ref.label, 200) ?? "", class: ref.class };
}

function isoField(v: unknown, field: string): string {
  if (typeof v !== "string" || toMs(v) === null) refuse(`${field} is not a timestamp`);
  return new Date(toMs(v) as number).toISOString();
}

function isoFieldOrNull(v: unknown, field: string): string | null {
  return v === null || v === undefined ? null : isoField(v, field);
}

/** The RPC row for one commitment: always the same keys (contract §0, identical key sets). */
function commitmentRow(principal: ExecPrincipal, c: NewCommitment, retentionDays: number): Record<string, unknown> | null {
  const threadId = checkId(c.threadId, "commitment.threadId");
  const messageId = checkId(c.messageId, "commitment.messageId");
  const accountId = checkId(c.accountId, "commitment.accountId");
  if (!principal.mailAccountIds.includes(accountId)) refuse("a commitment from an account outside his pin");
  if (c.direction !== "mitchell_owes" && c.direction !== "owed_to_mitchell") refuse("commitment.direction is unknown");
  if (c.source !== "email" && c.source !== "slack") refuse("commitment.source is unknown");
  const text = cleanClip(c.text, 200);
  const evidence = cleanClip(c.evidenceExcerpt, 280);
  // An empty promise or quote can't be stored or shown; drop it rather than fail the others.
  if (text === null || evidence === null) return null;
  const messageSentAt = isoField(c.messageSentAt, "commitment.messageSentAt");
  const dueAt = isoFieldOrNull(c.dueAt, "commitment.dueAt");
  const followedUpAt = isoFieldOrNull(c.bornFollowedUpAt, "commitment.bornFollowedUpAt");
  const created = c.messageCreatedAtMs;
  if (created !== null && (typeof created !== "number" || !Number.isFinite(created))) refuse("commitment.messageCreatedAtMs is malformed");
  return {
    fingerprint: commitmentFingerprint({ direction: c.direction, messageId, evidenceExcerpt: evidence }),
    source: c.source,
    thread_id: threadId,
    message_id: messageId,
    account_id: accountId,
    direction: c.direction,
    text,
    counterparty: cleanClip(c.counterparty, 120),
    due_at: dueAt,
    due_text: cleanClip(c.dueText, 60),
    // A promise already kept when it was found is stored as followed up.
    status: followedUpAt === null ? "open" : "followed_up",
    followed_up_at: followedUpAt,
    evidence_excerpt: evidence,
    source_ref: storedRef(c.sourceRef),
    message_sent_at: messageSentAt,
    message_created_at: created === null ? null : new Date(created).toISOString(),
    expires_at: commitmentExpiresAt({ messageSentAt, dueAt }, retentionDays)
  };
}

/**
 * Insert-if-absent: store new commitments through exec_email_insert_commitments,
 * one call per thread. A row is inserted only when its message has no
 * commitment on the thread yet and its fingerprint is new, and never onto a
 * missing, tombstoned or gone thread row; the thread's expiry is raised to
 * cover a long-dated promise. A commitment already followed up at birth
 * (bornFollowedUpAt) is stored as followed_up. Returns the inserted rows.
 */
export async function upsertCommitments(
  principal: ExecPrincipal,
  settings: ExecSettings,
  rows: readonly NewCommitment[],
  opts: StoreOptions & { retentionDays?: number } = {}
): Promise<ExecCommitment[]> {
  if (settings.principalId !== principal.id) refuse("the settings belong to another principal");
  const retentionDays = opts.retentionDays ?? settings.retentionDaysEmail;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) refuse("retention days are out of range");
  const byThread = new Map<string, Record<string, unknown>[]>();
  let dropped = 0;
  for (const c of rows) {
    const row = commitmentRow(principal, c, retentionDays);
    if (row === null) {
      dropped += 1;
      continue;
    }
    const list = byThread.get(row.thread_id as string) ?? [];
    list.push(row);
    byThread.set(row.thread_id as string, list);
  }
  if (dropped > 0) console.warn(`[exec-email-store] dropped ${dropped} commitment(s) with no text or evidence for ${principal.id}`);

  const out: ExecCommitment[] = [];
  for (const [threadId, list] of byThread) {
    for (const chunk of chunks(list, WRITE_CHUNK)) {
      opts.signal?.throwIfAborted();
      let call = db().rpc("exec_email_insert_commitments", { p_principal: principal.id, p_thread_id: threadId, p_rows: chunk });
      if (opts.signal) call = call.abortSignal(opts.signal);
      const { data, error } = await call;
      if (error) {
        if (isNotInstalled(error)) return out;
        throw failure("exec_email_insert_commitments", error, opts.signal);
      }
      if (!Array.isArray(data)) throw new Error("exec email store: exec_email_insert_commitments returned no rows array");
      for (const raw of data) out.push(commitmentFrom(raw));
    }
  }
  return out;
}

export interface CommitmentQuery {
  /** Default: open only. */
  statuses?: readonly CommitmentStatus[];
  /** Only these threads' commitments. */
  threadIds?: readonly string[];
  /** Only those due before this instant (ISO); undated ones are left out. */
  dueBefore?: string | null;
  /** Stop after this many (ordered by due date, undated last, then id). */
  limit?: number;
}

const COMMITMENT_STATUSES: readonly CommitmentStatus[] = ["open", "followed_up", "expired"];

function dueOrder(a: ExecCommitment, b: ExecCommitment): number {
  const da = toMs(a.dueAt);
  const dbm = toMs(b.dueAt);
  if (da !== dbm) {
    if (da === null) return 1;
    if (dbm === null) return -1;
    return da - dbm;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The principal's commitments, due date first (undated last). Throws on a
 * database error. The caller screens each through its thread row
 * (listThreadScreenRows + screenStoredRow) before showing it (A2).
 */
export async function listCommitments(principal: ExecPrincipal, q: CommitmentQuery = {}, opts: StoreOptions = {}): Promise<ExecCommitment[]> {
  const statuses = q.statuses ?? ["open"];
  if (!Array.isArray(statuses) || statuses.length === 0 || statuses.some((s) => !COMMITMENT_STATUSES.includes(s))) {
    refuse("listCommitments needs known statuses");
  }
  const dueBefore = q.dueBefore === null || q.dueBefore === undefined ? null : isoField(q.dueBefore, "dueBefore");
  if (q.limit !== undefined && (!Number.isSafeInteger(q.limit) || q.limit < 1)) refuse("listCommitments limit must be a positive whole number");
  const threadChunks = q.threadIds === undefined ? [null] : urlListChunks(checkIds(q.threadIds, "threadIds"));
  const found = new Map<string, ExecCommitment>();
  for (const chunk of threadChunks) {
    const rows = await pageAll(
      `${COMMITMENTS} read`,
      () => {
        let query = sel(COMMITMENTS, ALL_COMMITMENT_COLUMNS.join(",")).eq("principal_id", principal.id).in("status", [...statuses]);
        if (chunk !== null) query = query.in("thread_id", chunk);
        if (dueBefore !== null) query = query.lt("due_at", dueBefore);
        return query;
      },
      ["id"],
      opts.signal
    );
    if (rows === null) return [];
    for (const raw of rows) {
      const c = commitmentFrom(raw);
      found.set(c.id, c);
    }
  }
  const list = [...found.values()].sort(dueOrder);
  return q.limit === undefined ? list : list.slice(0, q.limit);
}

/** The message ids that already have a commitment on this thread, any status (a prompt hint only; the insert RPC dedupes). */
export async function listCommitmentMessageIds(principal: ExecPrincipal, threadId: string, opts: StoreOptions = {}): Promise<Set<string>> {
  checkId(threadId, "threadId");
  const rows = await pageAll(
    `${COMMITMENTS} message read`,
    () => sel(COMMITMENTS, "id,message_id").eq("principal_id", principal.id).eq("thread_id", threadId),
    ["id"],
    opts.signal
  );
  const out = new Set<string>();
  for (const r of rows ?? []) {
    if (typeof r.message_id !== "string") throw new Error(`exec email store: ${COMMITMENTS} read failed: column message_id is malformed`);
    out.add(r.message_id);
  }
  return out;
}

/**
 * Move one commitment to a status. followed_up needs its time; the others
 * clear it. A missing row is a no-op. `expectStatus` makes it a
 * compare-and-set on the current status (the expiry sweep moves only open
 * ones, so it can't overwrite a follow-up recorded meanwhile).
 */
export async function setCommitmentStatus(
  principal: ExecPrincipal,
  id: string,
  status: CommitmentStatus,
  followedUpAt: string | null,
  opts: StoreOptions & { now?: Date; expectStatus?: CommitmentStatus } = {}
): Promise<void> {
  checkId(id, "commitment id");
  if (!COMMITMENT_STATUSES.includes(status)) refuse("unknown commitment status");
  if (opts.expectStatus !== undefined && !COMMITMENT_STATUSES.includes(opts.expectStatus)) refuse("unknown expected commitment status");
  const at = status === "followed_up" ? isoField(followedUpAt, "followedUpAt") : null;
  let query = db()
    .from(COMMITMENTS)
    .update({ status, followed_up_at: at, updated_at: validNow(opts.now ?? new Date()).toISOString() })
    .eq("principal_id", principal.id)
    .eq("id", id);
  if (opts.expectStatus !== undefined) query = query.eq("status", opts.expectStatus);
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { error } = await query;
  if (error && !isNotInstalled(error)) throw failure(`${COMMITMENTS} status update`, error, opts.signal);
}

/** Delete a table's rows of these threads for one principal id. null = not installed. */
async function deleteByThreads(
  table: string,
  principalId: string,
  threadIds: readonly string[],
  signal: AbortSignal | undefined
): Promise<number | null> {
  const ids = checkIds(threadIds, "threadIds");
  let deleted = 0;
  for (const chunk of urlListChunks(ids)) {
    signal?.throwIfAborted();
    let query = db().from(table).delete({ count: "exact" }).eq("principal_id", principalId).in("thread_id", chunk);
    if (signal) query = query.abortSignal(signal);
    const { count, error } = await query;
    if (error) {
      if (isNotInstalled(error)) return null;
      throw failure(`${table} delete`, error, signal);
    }
    deleted += count ?? 0;
  }
  return deleted;
}

/** Delete every commitment of these threads (the tombstone procedure, the safety nets). Returns how many. */
export async function deleteCommitmentsForThreads(principal: ExecPrincipal, threadIds: readonly string[], opts: StoreOptions = {}): Promise<number> {
  return (await deleteByThreads(COMMITMENTS, principal.id, threadIds, opts.signal)) ?? 0;
}

// ---------------------------------------------------------------------------
// Signals (A3)
// ---------------------------------------------------------------------------

const IMPORTANCE: readonly OutlookImportance[] = ["low", "normal", "high"];

/**
 * Upsert one feed page's signals through exec_email_upsert_signals, which
 * only ever moves a message's row forward (strictly newer signals_at), skips
 * threads that are tombstones, and sets expires_at from the principal's
 * retention. Rows repeat a message id keep the newest stamp. A row with a
 * malformed optional field is kept with that field nulled (importance outside
 * low/normal/high, a web link that isn't https or is too long); one without a
 * usable id, direction or stamp is dropped. Every row must be one of his
 * pinned accounts'. Returns how many rows were written.
 */
export async function upsertEmailSignals(principal: ExecPrincipal, rows: readonly EmailSignalInput[], opts: StoreOptions = {}): Promise<number> {
  const newest = new Map<string, Record<string, unknown> & { signalsMs: number }>();
  let dropped = 0;
  for (const r of rows) {
    if (typeof r?.accountId === "string" && r.accountId.length > 0 && !principal.mailAccountIds.includes(r.accountId)) {
      refuse("a signal from an account outside his pin");
    }
    const ok =
      typeof r?.messageId === "string" && r.messageId.length > 0 && r.messageId.length <= 200 &&
      typeof r.threadId === "string" && r.threadId.length > 0 && r.threadId.length <= 200 &&
      typeof r.accountId === "string" && r.accountId.length > 0 && r.accountId.length <= 200 &&
      (r.direction === "inbound" || r.direction === "outbound") &&
      toMs(r.signalsAt) !== null;
    if (!ok) {
      dropped += 1;
      continue;
    }
    const signalsMs = toMs(r.signalsAt) as number;
    const prev = newest.get(r.messageId);
    if (prev && prev.signalsMs >= signalsMs) continue;
    const webLink = typeof r.webLink === "string" && r.webLink.startsWith("https://") && r.webLink.length <= 2048 ? r.webLink : null;
    newest.set(r.messageId, {
      signalsMs,
      message_id: r.messageId,
      thread_id: r.threadId,
      account_id: r.accountId,
      direction: r.direction,
      flagged: typeof r.flagged === "boolean" ? r.flagged : null,
      importance: IMPORTANCE.includes(r.importance as OutlookImportance) ? r.importance : null,
      unread: typeof r.unread === "boolean" ? r.unread : null,
      removed_at: toMs(r.removedAt) === null ? null : new Date(toMs(r.removedAt) as number).toISOString(),
      web_link: webLink,
      signals_at: new Date(signalsMs).toISOString()
    });
  }
  if (dropped > 0) console.warn(`[exec-email-store] dropped ${dropped} malformed signal row(s) for ${principal.id}`);
  const payload = [...newest.values()].map(({ signalsMs: _ms, ...row }) => {
    void _ms;
    return row;
  });
  let written = 0;
  for (const chunk of chunks(payload, WRITE_CHUNK)) {
    opts.signal?.throwIfAborted();
    let call = db().rpc("exec_email_upsert_signals", { p_principal: principal.id, p_rows: chunk });
    if (opts.signal) call = call.abortSignal(opts.signal);
    const { data, error } = await call;
    if (error) {
      if (isNotInstalled(error)) return written;
      throw failure("exec_email_upsert_signals", error, opts.signal);
    }
    if (typeof data !== "number" || !Number.isSafeInteger(data) || data < 0) throw new Error("exec email store: exec_email_upsert_signals returned no count");
    written += data;
  }
  return written;
}

/** The stored signals of these messages, by message id. Throws on a database error; not installed → none. */
export async function listSignalsForMessages(
  principal: ExecPrincipal,
  messageIds: readonly string[],
  opts: StoreOptions = {}
): Promise<Map<string, ExecEmailSignal>> {
  const ids = checkIds(messageIds, "messageIds");
  const out = new Map<string, ExecEmailSignal>();
  for (const chunk of urlListChunks(ids)) {
    const rows = await pageAll(
      `${SIGNALS} read`,
      () => sel(SIGNALS, ALL_SIGNAL_COLUMNS.join(",")).eq("principal_id", principal.id).in("message_id", chunk),
      ["message_id"],
      opts.signal
    );
    if (rows === null) return new Map();
    for (const raw of rows) {
      const s = signalFrom(raw);
      out.set(s.messageId, s);
    }
  }
  return out;
}

/** Delete every signal row of these threads (the tombstone procedure, the safety nets). Returns how many. */
export async function deleteSignalsForThreads(principal: ExecPrincipal, threadIds: readonly string[], opts: StoreOptions = {}): Promise<number> {
  return (await deleteByThreads(SIGNALS, principal.id, threadIds, opts.signal)) ?? 0;
}

// ---------------------------------------------------------------------------
// Retention: the purge step (global, every principal)
// ---------------------------------------------------------------------------

export interface EmailPurgeCounts {
  threads: number;
  commitments: number;
  attentionRows: number;
  signals: number;
}

/** Most expired thread rows one purge run handles; the rest wait for the next run. */
export const PURGE_MAX_THREADS = 5_000;

/**
 * The thread id an email attention fingerprint hangs off, for
 * email:thread:<threadId>:<anchorId> and email:commitment:<threadId>:<commitmentId>
 * (L4), plus the commitment id; null for any other email fingerprint
 * (satisfaction, health). The last segment is a clone message id or a
 * commitment id, neither of which holds a ":".
 */
function attentionTarget(fingerprint: string): { threadId: string; commitmentId: string | null } | null {
  for (const [prefix, isCommitment] of [
    ["email:thread:", false],
    ["email:commitment:", true]
  ] as const) {
    if (!fingerprint.startsWith(prefix)) continue;
    const rest = fingerprint.slice(prefix.length);
    const cut = rest.lastIndexOf(":");
    if (cut <= 0 || cut === rest.length - 1) return null;
    return { threadId: rest.slice(0, cut), commitmentId: isCommitment ? rest.slice(cut + 1) : null };
  }
  return null;
}

async function deleteGlobal(table: string, column: string, beforeIso: string, signal: AbortSignal | undefined): Promise<number> {
  let query = db().from(table).delete({ count: "exact" }).lt(column, beforeIso);
  if (signal) query = query.abortSignal(signal);
  const { count, error } = await query;
  if (error) {
    if (isNotInstalled(error)) return 0;
    throw failure(`${table} purge`, error, signal);
  }
  return count ?? 0;
}

/** Which of these ids exist in `table` for the principal (ids are `idColumn`). Not installed → none. */
async function existingIds(
  table: string,
  idColumn: string,
  principalId: string,
  ids: readonly string[],
  signal: AbortSignal | undefined
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const chunk of urlListChunks([...new Set(ids)])) {
    const rows = await pageAll(`${table} read`, () => sel(table, idColumn).eq("principal_id", principalId).in(idColumn, chunk), [idColumn], signal);
    if (rows === null) return out;
    for (const r of rows) if (typeof r[idColumn] === "string") out.add(r[idColumn] as string);
  }
  return out;
}

/**
 * Email retention, for every principal (P2b's purge pass runs it daily):
 *   - expired thread rows, except one that still has an unexpired commitment
 *     (a promise due long after the thread went quiet keeps its thread, so it
 *     can still be screened and shown: amendments-10), up to PURGE_MAX_THREADS
 *     a run; then the purged threads' commitments and signal rows;
 *   - every expired commitment and every expired signal row;
 *   - email attention rows of a thread (email:thread:, email:commitment:)
 *     whose thread row no longer exists, or of a commitment that no longer
 *     exists: they carry the subject or the promise, which must not outlive
 *     the rows they came from.
 * A missing table counts 0 (the migration isn't applied). Any other error
 * throws, and the purge job retries.
 */
export async function purgeExpiredEmailRows(now: Date, opts: StoreOptions = {}): Promise<EmailPurgeCounts> {
  const nowIso = validNow(now).toISOString();
  const signal = opts.signal;
  const counts: EmailPurgeCounts = { threads: 0, commitments: 0, attentionRows: 0, signals: 0 };

  // 1. Expired thread rows, read first (offset paging over a fixed result).
  const expired = await pageAll(
    `${THREADS} purge read`,
    () => sel(THREADS, "principal_id,thread_id").lt("expires_at", nowIso),
    ["principal_id", "thread_id"],
    signal
  );
  if (expired === null) return counts; // not installed: nothing email exists
  const byPrincipal = new Map<string, string[]>();
  for (const r of expired.slice(0, PURGE_MAX_THREADS)) {
    if (typeof r.principal_id !== "string" || typeof r.thread_id !== "string") throw new Error(`exec email store: ${THREADS} purge read failed: a row is malformed`);
    const list = byPrincipal.get(r.principal_id) ?? [];
    list.push(r.thread_id);
    byPrincipal.set(r.principal_id, list);
  }

  for (const [principalId, threadIds] of byPrincipal) {
    for (const chunk of urlListChunks(threadIds)) {
      signal?.throwIfAborted();
      // Keep a thread that still has a commitment that hasn't expired.
      const keep = new Set<string>();
      const live = await pageAll(
        `${COMMITMENTS} purge read`,
        () => sel(COMMITMENTS, "id,thread_id").eq("principal_id", principalId).in("thread_id", chunk).gte("expires_at", nowIso),
        ["id"],
        signal
      );
      for (const r of live ?? []) if (typeof r.thread_id === "string") keep.add(r.thread_id);
      const doomed = chunk.filter((id) => !keep.has(id));
      if (doomed.length === 0) continue;
      // Re-checked in the delete itself: a row a writer refreshed (or whose
      // expiry a new commitment raised) since the read stays.
      let del = db()
        .from(THREADS)
        .delete({ count: "exact" })
        .eq("principal_id", principalId)
        .in("thread_id", doomed)
        .lt("expires_at", nowIso)
        .select("thread_id");
      if (signal) del = del.abortSignal(signal);
      const { data, error } = await del;
      if (error) throw failure(`${THREADS} purge`, error, signal);
      const purged = (Array.isArray(data) ? data : []).map((r) => (r as { thread_id?: unknown }).thread_id).filter((t): t is string => typeof t === "string");
      counts.threads += purged.length;
      if (purged.length === 0) continue;
      counts.commitments += (await deleteByThreads(COMMITMENTS, principalId, purged, signal)) ?? 0;
      counts.signals += (await deleteByThreads(SIGNALS, principalId, purged, signal)) ?? 0;
    }
  }

  // 2. Expired commitments and signal rows, whatever their thread.
  counts.commitments += await deleteGlobal(COMMITMENTS, "expires_at", nowIso, signal);
  counts.signals += await deleteGlobal(SIGNALS, "expires_at", nowIso, signal);

  // 3. Email attention rows whose thread row or commitment is gone.
  counts.attentionRows = await purgeOrphanEmailAttention(signal);

  console.log(
    `[exec-email-store] purge: threads=${counts.threads} commitments=${counts.commitments} signals=${counts.signals} ` +
      `attentionRows=${counts.attentionRows}${expired.length > PURGE_MAX_THREADS ? ` more=${expired.length - PURGE_MAX_THREADS}` : ""}`
  );
  return counts;
}

async function purgeOrphanEmailAttention(signal: AbortSignal | undefined): Promise<number> {
  const rows = await pageAll(
    `${ATTENTION} purge read`,
    () => sel(ATTENTION, "id,principal_id,fingerprint").eq("source", "email"),
    ["id"],
    signal
  );
  if (rows === null) return 0;
  const byPrincipal = new Map<string, { id: string; threadId: string; commitmentId: string | null }[]>();
  for (const r of rows) {
    if (typeof r.id !== "string" || typeof r.principal_id !== "string" || typeof r.fingerprint !== "string") {
      throw new Error(`exec email store: ${ATTENTION} purge read failed: a row is malformed`);
    }
    const target = attentionTarget(r.fingerprint);
    if (target === null) continue;
    const list = byPrincipal.get(r.principal_id) ?? [];
    list.push({ id: r.id, ...target });
    byPrincipal.set(r.principal_id, list);
  }
  let deleted = 0;
  for (const [principalId, items] of byPrincipal) {
    const threads = await existingIds(THREADS, "thread_id", principalId, items.map((i) => i.threadId), signal);
    const commitmentIds = items.map((i) => i.commitmentId).filter((c): c is string => c !== null);
    const commitments = commitmentIds.length > 0 ? await existingIds(COMMITMENTS, "id", principalId, commitmentIds, signal) : new Set<string>();
    const orphans = items
      .filter((i) => !threads.has(i.threadId) || (i.commitmentId !== null && !commitments.has(i.commitmentId)))
      .map((i) => i.id);
    for (const chunk of urlListChunks(orphans)) {
      signal?.throwIfAborted();
      let query = db().from(ATTENTION).delete({ count: "exact" }).eq("principal_id", principalId).eq("source", "email").in("id", chunk);
      if (signal) query = query.abortSignal(signal);
      const { count, error } = await query;
      if (error) {
        if (isNotInstalled(error)) return deleted;
        throw failure(`${ATTENTION} purge`, error, signal);
      }
      deleted += count ?? 0;
    }
  }
  return deleted;
}
