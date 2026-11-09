import "server-only";

import type { EaReadinessReason, SendTokenReason } from "@/lib/exec/drafts-types";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// exec_sync_state: small per-principal JSON cursors. Reconcile positions, the
// restricted-policy generation, socket and mailbox health, the shared triage
// stagger and the attention lease all live here, one row per
// (principal_id, source, key) (contract §2.3).
//
// Every cursor carries an integer `rev` that every write bumps. A writer that
// read rev N can compare-and-set on it (casSyncState) and loses cleanly when
// someone else wrote in between, instead of silently overwriting them.
//
// Rules:
//   - A failed read or write throws (SyncStateError). Nothing here turns a
//     database error into "no state", because callers decide what to re-do
//     (or re-enqueue) from what they read.
//   - A cursor that is there but doesn't parse comes back from getSyncState
//     as null, with its key logged, so the caller starts over instead of
//     acting on garbage. Starting over is a write that replaces the row
//     (putSyncState); casSyncState(null) only ever inserts.
//   - Values hold positions, ids, counts and codes, never message content,
//     and are at most 64 KB of JSON.
//   - The CAS token is the cursor's rev exactly as Postgres renders it
//     (cursor->>rev), read in the same select as the cursor. So a row whose
//     rev is missing or malformed can still be replaced rather than wedging
//     every writer behind it.
//   - Every write sets updated_at itself: the column default only applies to
//     an insert.

/**
 * mail (P3 reconcile), email (P3 attention), clone-ea (P4: the EA and send
 * token verdicts, §2.3), ddtext (P5a: the DD text triage's cursor and lease,
 * contract §2.5), slack (P7a: the reading jobs' leases, contract §3.20.1).
 */
export type SyncSource = "mail" | "email" | "clone-ea" | "ddtext" | "slack";

export interface SyncStateOptions {
  signal?: AbortSignal;
}

/** A read or write of exec_sync_state failed. Names the row; carries no values. */
export class SyncStateError extends Error {
  readonly source: string;
  readonly key: string;
  constructor(source: string, key: string, message: string) {
    super(`exec_sync_state ${source}/${key}: ${message}`);
    this.name = "SyncStateError";
    this.source = source;
    this.key = key;
  }
}

const TABLE = "exec_sync_state";
const MAX_VALUE_CHARS = 64 * 1024;
const MAX_KEY_CHARS = 200;
// putSyncState re-reads and retries when another writer lands between its read
// and its write. Only a writer that keeps losing (a hot loop elsewhere) runs
// out of attempts, and that is worth an error.
const PUT_ATTEMPTS = 5;
// releaseLease runs in a job's `finally`; it must not hold the job slot on a
// hung request. An unreleased lease simply expires.
const RELEASE_TIMEOUT_MS = 10_000;
const MAX_LEASE_TTL_MS = 24 * 60 * 60_000;

const REV_TEXT = /^[1-9]\d{0,15}$/;

/** cursor->>rev text → the rev, or null when it isn't a positive integer. */
function parseRev(text: string | null): number | null {
  if (text === null || !REV_TEXT.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

function checkRow(source: unknown, key: unknown): asserts source is SyncSource {
  if (source !== "mail" && source !== "email" && source !== "clone-ea" && source !== "ddtext" && source !== "slack") {
    throw new NonRetryableError(`exec_sync_state: unknown source ${JSON.stringify(source)}`);
  }
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_CHARS) {
    throw new NonRetryableError(`exec_sync_state: key must be 1-${MAX_KEY_CHARS} characters`);
  }
}

/**
 * The jsonb a write stores: the value plus its new rev, as plain JSON data.
 * A value that isn't a plain object, can't be serialized or is too big is a
 * programming error, so it is refused for good (NonRetryableError).
 */
function cursorFor(source: SyncSource, key: string, value: object, rev: number): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NonRetryableError(`exec_sync_state ${source}/${key}: the value must be a plain object`);
  }
  let json: string;
  try {
    json = JSON.stringify({ ...value, rev });
  } catch {
    throw new NonRetryableError(`exec_sync_state ${source}/${key}: the value is not JSON-serializable`);
  }
  if (json.length > MAX_VALUE_CHARS) {
    throw new NonRetryableError(`exec_sync_state ${source}/${key}: the value is ${json.length} characters (max ${MAX_VALUE_CHARS})`);
  }
  return JSON.parse(json) as Record<string, unknown>;
}

interface RawRow {
  cursor: unknown;
  /** cursor->>rev as Postgres renders it; null when absent. */
  revText: string | null;
}

async function readRaw(principalId: string, source: SyncSource, key: string, signal?: AbortSignal): Promise<RawRow | null> {
  let query = getSupabaseAdmin()
    .from(TABLE)
    .select("cursor, rev:cursor->>rev")
    .eq("principal_id", principalId)
    .eq("source", source)
    .eq("key", key);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query.maybeSingle();
  if (error) throw new SyncStateError(source, key, `read failed: ${error.message}`);
  if (!data) return null;
  const row = data as { cursor?: unknown; rev?: unknown };
  const rev = row.rev;
  return {
    cursor: row.cursor ?? null,
    revText: typeof rev === "string" ? rev : rev === null || rev === undefined ? null : String(rev)
  };
}

/** INSERT … ON CONFLICT DO NOTHING. true = this call created the row. */
async function insertIfAbsent(
  principalId: string,
  source: SyncSource,
  key: string,
  cursor: Record<string, unknown>,
  signal?: AbortSignal
): Promise<boolean> {
  let query = getSupabaseAdmin()
    .from(TABLE)
    .upsert(
      { principal_id: principalId, source, key, cursor, updated_at: new Date().toISOString() },
      { onConflict: "principal_id,source,key", ignoreDuplicates: true }
    )
    .select("key");
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw new SyncStateError(source, key, `insert failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/** UPDATE … WHERE cursor->>rev IS NOT DISTINCT FROM revText. true = this call wrote the row. */
async function updateIfRev(
  principalId: string,
  source: SyncSource,
  key: string,
  revText: string | null,
  cursor: Record<string, unknown>,
  signal?: AbortSignal
): Promise<boolean> {
  let query = getSupabaseAdmin()
    .from(TABLE)
    .update({ cursor, updated_at: new Date().toISOString() })
    .eq("principal_id", principalId)
    .eq("source", source)
    .eq("key", key);
  query = revText === null ? query.is("cursor->>rev", null) : query.eq("cursor->>rev", revText);
  let selected = query.select("key");
  if (signal) selected = selected.abortSignal(signal);
  const { data, error } = await selected;
  if (error) throw new SyncStateError(source, key, `update failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/** Read the row, then write rev+1 against what was read; again on a lost race. */
async function putRow(principalId: string, source: SyncSource, key: string, value: object, signal?: AbortSignal): Promise<void> {
  // Validated once up front, so a bad value fails before any read.
  cursorFor(source, key, value, 1);
  for (let attempt = 1; attempt <= PUT_ATTEMPTS; attempt += 1) {
    const raw = await readRaw(principalId, source, key, signal);
    if (!raw) {
      if (await insertIfAbsent(principalId, source, key, cursorFor(source, key, value, 1), signal)) return;
      continue;
    }
    const rev = parseRev(raw.revText);
    // A row whose rev is unusable restarts the count at 1; its own rev text is
    // still the token, so this write replaces exactly what was read.
    const next = rev === null ? 1 : rev + 1;
    if (await updateIfRev(principalId, source, key, raw.revText, cursorFor(source, key, value, next), signal)) return;
  }
  throw new SyncStateError(source, key, `another writer kept updating the row (${PUT_ATTEMPTS} attempts)`);
}

/**
 * The cursor and its rev, or null when there is no row or the row doesn't
 * parse (its key is logged). `parse` gets the stored object, rev included,
 * and returns null for anything it doesn't accept; a parser that throws is
 * treated the same way. DB errors throw.
 */
export async function getSyncState<T>(
  principal: ExecPrincipal,
  source: SyncSource,
  key: string,
  parse: (raw: unknown) => T | null,
  opts: SyncStateOptions = {}
): Promise<{ value: T; rev: number } | null> {
  checkRow(source, key);
  const raw = await readRaw(principal.id, source, key, opts.signal);
  if (!raw) return null;
  const rev = parseRev(raw.revText);
  let value: T | null = null;
  if (rev !== null) {
    try {
      value = parse(raw.cursor);
    } catch {
      value = null;
    }
  }
  if (rev === null || value === null) {
    console.warn(`[exec-sync-state] ${source}/${key}: the stored cursor does not parse; treating it as absent`);
    return null;
  }
  return { value, rev };
}

/**
 * Write `value` unconditionally, as rev = previous + 1 (1 for a new row, or
 * for a row whose rev is unusable). Re-reads and retries when another writer
 * lands in between, so the rev still only moves forward. DB errors throw.
 */
export async function putSyncState(
  principal: ExecPrincipal,
  source: SyncSource,
  key: string,
  value: object,
  opts: SyncStateOptions = {}
): Promise<void> {
  checkRow(source, key);
  await putRow(principal.id, source, key, value, opts.signal);
}

/**
 * Compare-and-set. expectedRev null: insert, only if no row exists (rev 1).
 * Otherwise update only while the stored rev is still expectedRev, writing
 * expectedRev + 1. true = written; false = someone else got there first
 * (re-read and decide again). DB errors throw.
 */
export async function casSyncState(
  principal: ExecPrincipal,
  source: SyncSource,
  key: string,
  expectedRev: number | null,
  value: object,
  opts: SyncStateOptions = {}
): Promise<boolean> {
  checkRow(source, key);
  if (expectedRev === null) {
    return insertIfAbsent(principal.id, source, key, cursorFor(source, key, value, 1), opts.signal);
  }
  if (!Number.isSafeInteger(expectedRev) || expectedRev < 1) {
    throw new NonRetryableError(`exec_sync_state ${source}/${key}: expectedRev must be a positive integer or null`);
  }
  return updateIfRev(principal.id, source, key, String(expectedRev), cursorFor(source, key, value, expectedRev + 1), opts.signal);
}

/**
 * putSyncState by a raw principal id, for the one caller that has no
 * ExecPrincipal: the mail hook's socket-health writer (mail/socket), which
 * runs from the bus listener outside any job. boundary.test.ts allows only
 * src/lib/exec/mail-hook.ts to import it.
 */
export async function putSyncStateByPrincipalId(principalId: string, source: "mail", key: "socket", value: object): Promise<void> {
  if (typeof principalId !== "string" || principalId.length === 0) {
    throw new NonRetryableError("exec_sync_state: principalId must be a non-empty string");
  }
  if (source !== "mail" || key !== "socket") {
    throw new NonRetryableError("exec_sync_state: the raw-id writer only writes mail/socket");
  }
  await putRow(principalId, source, key, value);
}

// ---------------------------------------------------------------------------
// Leases: one holder at a time, taken over on expiry. email/attention-lease
// (P3's attention pass) and ddtext/ddtext-lease (P5a's DD text triage).
// ---------------------------------------------------------------------------

/** The leases there are, each stored under its own source (P5a §3.12.8). P7a (§3.20.1) adds the three Slack reading leases. */
export type LeaseKey = "attention-lease" | "ddtext-lease" | "slack-discover-lease" | "slack-sweep-lease" | "slack-attention-lease";

const LEASE_SOURCES: Readonly<Record<LeaseKey, SyncSource>> = Object.freeze({
  "attention-lease": "email",
  "ddtext-lease": "ddtext",
  "slack-discover-lease": "slack",
  "slack-sweep-lease": "slack",
  "slack-attention-lease": "slack"
});

/** The source a lease is stored under; an unknown key is a bug (NonRetryableError). */
function leaseSource(key: unknown): SyncSource {
  if (typeof key !== "string" || !Object.hasOwn(LEASE_SOURCES, key)) {
    throw new NonRetryableError(`exec_sync_state: unknown lease ${JSON.stringify(key)}`);
  }
  return LEASE_SOURCES[key as LeaseKey];
}

/**
 * Take the lease for `holder` until now + ttlMs. true when it is now ours: no
 * lease yet, the lease is free or expired, it is already ours (this extends
 * it), or the stored lease is unreadable (taken over rather than wedging the
 * pass forever). false when someone else holds an unexpired lease, or another
 * writer won the race. DB errors throw.
 */
export async function tryAcquireLease(
  principal: ExecPrincipal,
  key: LeaseKey,
  holder: string,
  ttlMs: number,
  now: Date = new Date()
): Promise<boolean> {
  const source = leaseSource(key);
  checkRow(source, key);
  if (typeof holder !== "string" || holder.length === 0 || holder.length > 200) {
    throw new NonRetryableError("tryAcquireLease: holder must be 1-200 characters");
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_LEASE_TTL_MS) {
    throw new NonRetryableError(`tryAcquireLease: ttlMs must be between 1 and ${MAX_LEASE_TTL_MS}`);
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new NonRetryableError("tryAcquireLease: now must be a valid Date");
  const mine: LeaseState = { holder, leaseUntil: new Date(nowMs + ttlMs).toISOString() };

  const raw = await readRaw(principal.id, source, key);
  if (!raw) return insertIfAbsent(principal.id, source, key, cursorFor(source, key, mine, 1));

  const rev = parseRev(raw.revText);
  const lease = rev === null ? null : parseLeaseState(raw.cursor);
  if (lease && lease.holder !== null && lease.holder !== holder && lease.leaseUntil !== null && Date.parse(lease.leaseUntil) > nowMs) {
    return false;
  }
  return updateIfRev(principal.id, source, key, raw.revText, cursorFor(source, key, mine, rev === null ? 1 : rev + 1));
}

/**
 * Give the lease back, but only if `holder` still holds it (a holder whose
 * lease expired and was taken over must not release the new holder's).
 * Never throws: a failure is logged and the lease expires on its own.
 */
export async function releaseLease(principal: ExecPrincipal, key: LeaseKey, holder: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("releaseLease timed out")), RELEASE_TIMEOUT_MS);
  let source: SyncSource | "?" = "?";
  try {
    const leased = leaseSource(key);
    source = leased;
    checkRow(leased, key);
    const raw = await readRaw(principal.id, leased, key, controller.signal);
    if (!raw) return;
    const rev = parseRev(raw.revText);
    const lease = rev === null ? null : parseLeaseState(raw.cursor);
    if (!lease || lease.holder !== holder) return;
    const free: LeaseState = { holder: null, leaseUntil: null };
    await updateIfRev(principal.id, leased, key, raw.revText, cursorFor(leased, key, free, (rev as number) + 1), controller.signal);
  } catch (err) {
    const why = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
    console.warn(`[exec-sync-state] could not release ${source}/${key}; it will expire on its own: ${why}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Parsers. Each takes the stored cursor (rev included, ignored) and returns
// the value, or null when anything present is malformed. Fields added after
// the first release are optional and get defaults, so an older row still
// parses; unknown keys are dropped.
// ---------------------------------------------------------------------------

class Unparseable extends Error {}
const reject = (): never => {
  throw new Unparseable();
};

type Obj = Record<string, unknown>;

function objectOf(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : reject();
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const absent = (v: unknown) => v === undefined || v === null;

function iso(v: unknown): string {
  return typeof v === "string" && ISO_TIME.test(v) && Number.isFinite(Date.parse(v)) ? v : reject();
}
const isoOrNull = (v: unknown): string | null => (absent(v) ? null : iso(v));

function text(v: unknown, max: number): string {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : reject();
}
const textOrNull = (v: unknown, max: number): string | null => (absent(v) ? null : text(v, max));

function whole(v: unknown, min: number, fallback?: number): number {
  if (v === undefined && fallback !== undefined) return fallback;
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min ? v : reject();
}

function bool(v: unknown): boolean {
  return typeof v === "boolean" ? v : reject();
}

function listOf<T>(v: unknown, max: number, item: (x: unknown) => T): T[] {
  if (absent(v)) return [];
  if (!Array.isArray(v) || v.length > max) return reject();
  return v.map(item);
}

function parsed<T>(raw: unknown, build: (o: Obj) => T): T | null {
  try {
    return build(objectOf(raw));
  } catch (err) {
    if (err instanceof Unparseable) return null;
    throw err;
  }
}

// Ids and cursors from the clone, thread ids, holders: short opaque strings.
const ID_MAX = 512;

// --- mail / recon:<accountId> ------------------------------------------------

/** One feed pass's position: CL1's opaque next_cursor, or `since` before the first page. */
export interface FeedPassState {
  cursor: string | null;
  since: string | null;
}

/** List-mode reconcile (pre-CL1 clones): the high-water mark and the window being walked. */
export interface ListModeState {
  hwm: string | null;
  windowFrom: string | null;
  windowTo: string | null;
  lastSyncedAtAtStart: string | null;
  offset: number;
  lastDeepAt: string | null;
  /** Which of the two list passes the offset belongs to (the clone hides snoozed threads unless asked). */
  pass: "normal" | "snoozed";
}

export interface BackfillState {
  from: string;
  startedAt: string;
  /** Set once the whole window has been enqueued. */
  enqueuedAt: string | null;
}

/** listDeadJobs keyset position, ascending (finished_at, id). */
export interface DeadLetterCursor {
  finishedAt: string;
  id: number;
}

export interface ReconState {
  /** null until the feed probe has decided. */
  mode: "feed" | "list" | null;
  created: FeedPassState;
  changed: FeedPassState;
  list: ListModeState;
  /** null before the first run starts its backfill. */
  backfill: BackfillState | null;
  versionCursor: string | null;
  deadCursor: DeadLetterCursor | null;
}

/** A reconcile state with nothing done yet. */
export function initialReconState(): ReconState {
  return {
    mode: null,
    created: { cursor: null, since: null },
    changed: { cursor: null, since: null },
    list: { hwm: null, windowFrom: null, windowTo: null, lastSyncedAtAtStart: null, offset: 0, lastDeepAt: null, pass: "normal" },
    backfill: null,
    versionCursor: null,
    deadCursor: null
  };
}

function feedPass(v: unknown): FeedPassState {
  if (absent(v)) return { cursor: null, since: null };
  const o = objectOf(v);
  return { cursor: textOrNull(o.cursor, ID_MAX), since: isoOrNull(o.since) };
}

function listMode(v: unknown): ListModeState {
  if (absent(v)) return initialReconState().list;
  const o = objectOf(v);
  const pass = o.pass === undefined ? "normal" : o.pass === "normal" || o.pass === "snoozed" ? o.pass : reject();
  return {
    hwm: isoOrNull(o.hwm),
    windowFrom: isoOrNull(o.windowFrom),
    windowTo: isoOrNull(o.windowTo),
    lastSyncedAtAtStart: isoOrNull(o.lastSyncedAtAtStart),
    offset: whole(o.offset, 0, 0),
    lastDeepAt: isoOrNull(o.lastDeepAt),
    pass
  };
}

export function parseReconState(raw: unknown): ReconState | null {
  return parsed(raw, (o) => {
    const mode = absent(o.mode) ? null : o.mode === "feed" || o.mode === "list" ? o.mode : reject();
    let backfill: BackfillState | null = null;
    if (!absent(o.backfill)) {
      const b = objectOf(o.backfill);
      backfill = { from: iso(b.from), startedAt: iso(b.startedAt), enqueuedAt: isoOrNull(b.enqueuedAt) };
    }
    let deadCursor: DeadLetterCursor | null = null;
    if (!absent(o.deadCursor)) {
      const d = objectOf(o.deadCursor);
      deadCursor = { finishedAt: iso(d.finishedAt), id: whole(d.id, 1) };
    }
    return {
      mode,
      created: feedPass(o.created),
      changed: feedPass(o.changed),
      list: listMode(o.list),
      backfill,
      versionCursor: textOrNull(o.versionCursor, ID_MAX),
      deadCursor
    };
  });
}

// --- mail / restricted-policy ------------------------------------------------

export interface PolicyState {
  /** restrictedPolicyHash of the rules last applied. */
  hash: string;
  /** Bumped whenever the hash changes; keys policy re-triages (g<generation>). */
  generation: number;
  appliedAt: string;
  /** The rest tier's keyset position (a thread id); null = start of a lap. */
  rescreenAfter: string | null;
  /** Bumped each time rescreenAfter wraps; keys policy re-triages (l<lap>). */
  lap: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function parsePolicyState(raw: unknown): PolicyState | null {
  return parsed(raw, (o) => ({
    hash: typeof o.hash === "string" && HEX64.test(o.hash) ? o.hash : reject(),
    generation: whole(o.generation, 0),
    appliedAt: iso(o.appliedAt),
    rescreenAfter: textOrNull(o.rescreenAfter, ID_MAX),
    lap: whole(o.lap, 0, 0)
  }));
}

// --- mail / socket -------------------------------------------------------------

export interface SocketState {
  connected: boolean;
  lastEventAt: string | null;
  observedAt: string;
}

export function parseSocketState(raw: unknown): SocketState | null {
  return parsed(raw, (o) => ({
    connected: bool(o.connected),
    lastEventAt: isoOrNull(o.lastEventAt),
    observedAt: iso(o.observedAt)
  }));
}

// --- mail / accounts -------------------------------------------------------------

/** One pinned mailbox as the clone last reported it. */
export interface MailAccountStatus {
  id: string;
  /** The mailbox's own address (his), trimmed and lowercased. */
  email: string;
  lastSyncedAt: string | null;
  /** The clone's sync error, secret-scrubbed and clipped to 200 characters. */
  lastSyncError: string | null;
  lastSyncErrorAt: string | null;
}

/**
 * Why a pinned account is unusable: it isn't in the clone any more, it is a
 * different person's mailbox, or it isn't the Microsoft (Graph) connection
 * the pin was made for. A stored reason this code doesn't know still marks
 * the account as a problem.
 */
export type MailAccountProblemReason = "not_found" | "email_mismatch" | "not_microsoft";

export interface MailAccountProblem {
  accountId: string;
  reason: MailAccountProblemReason | (string & {});
}

export interface AccountsState {
  checkedAt: string;
  accounts: MailAccountStatus[];
  problems: MailAccountProblem[];
}

const PROBLEM_REASON = /^[a-z][a-z_]{0,39}$/;

export function parseAccountsState(raw: unknown): AccountsState | null {
  return parsed(raw, (o) => ({
    checkedAt: iso(o.checkedAt),
    accounts: listOf(o.accounts, 100, (v) => {
      const a = objectOf(v);
      return {
        id: text(a.id, 200),
        email: text(a.email, 320),
        lastSyncedAt: isoOrNull(a.lastSyncedAt),
        lastSyncError: textOrNull(a.lastSyncError, 400),
        lastSyncErrorAt: isoOrNull(a.lastSyncErrorAt)
      };
    }),
    problems: listOf(o.problems, 100, (v) => {
      const p = objectOf(v);
      return {
        accountId: text(p.accountId, 200),
        reason: typeof p.reason === "string" && PROBLEM_REASON.test(p.reason) ? p.reason : reject()
      };
    })
  }));
}

/** The problem account ids of a stored accounts state, for usableAccounts. */
export function problemAccountIds(state: AccountsState | null): ReadonlySet<string> {
  return new Set((state?.problems ?? []).map((p) => p.accountId));
}

// --- mail / stagger --------------------------------------------------------------

/** The shared bulk-lane stagger position: the last run_after handed out. */
export interface StaggerState {
  lastRunAfter: string | null;
}

export function parseStaggerState(raw: unknown): StaggerState | null {
  return parsed(raw, (o) => ({ lastRunAfter: isoOrNull(o.lastRunAfter) }));
}

// --- email / client-health -------------------------------------------------------

export interface HealthLabelState {
  label: string;
  droppedFrom: string | null;
  droppedAt: string | null;
}

export interface HealthState {
  takenAt: string;
  /** By client id. A null-prototype record: a client id can never reach Object.prototype. */
  labels: Readonly<Record<string, HealthLabelState>>;
}

const MAX_HEALTH_CLIENTS = 10_000;

export function parseHealthState(raw: unknown): HealthState | null {
  return parsed(raw, (o) => {
    const source = objectOf(o.labels);
    const entries = Object.entries(source);
    if (entries.length > MAX_HEALTH_CLIENTS) reject();
    const labels = Object.create(null) as Record<string, HealthLabelState>;
    for (const [clientId, v] of entries) {
      text(clientId, 200);
      const l = objectOf(v);
      Object.defineProperty(labels, clientId, {
        value: { label: text(l.label, 40), droppedFrom: textOrNull(l.droppedFrom, 40), droppedAt: isoOrNull(l.droppedAt) },
        enumerable: true,
        writable: true,
        configurable: true
      });
    }
    return { takenAt: iso(o.takenAt), labels };
  });
}

// --- email / attention-lease -------------------------------------------------------

export interface LeaseState {
  holder: string | null;
  leaseUntil: string | null;
}

export function parseLeaseState(raw: unknown): LeaseState | null {
  return parsed(raw, (o) => ({ holder: textOrNull(o.holder, 200), leaseUntil: isoOrNull(o.leaseUntil) }));
}

// --- clone-ea / ea-token, clone-ea / send-token (P4, contract §2.3; Area B) ------------

/**
 * The last EA (draft) token readiness verdict, written by sources/mail.ts's
 * getEaReadiness on each fresh check. Codes and timestamps only: never a token,
 * a claim other than the expiry, or content. As with every state here, `rev`
 * is added by the write and isn't part of the value.
 */
export interface EaTokenState {
  ok: boolean;
  reason: EaReadinessReason | null;
  checkedAt: string;
  cl2Ready: boolean | null;
  cl2Send: "off" | "all" | "some" | null;
  sendEnabled: boolean | null;
  expiresAt: string | null;
  /** First 12 hex of sha256(token), or null. */
  tokenFp: string | null;
}

/** The last send-token readiness verdict, written by send.ts's sendTokenReadiness on each call. */
export interface SendTokenState {
  ok: boolean;
  reason: SendTokenReason | null;
  checkedAt: string;
  expiresAt: string | null;
  tokenFp: string | null;
}

const EA_READINESS_REASONS: ReadonlySet<string> = new Set<EaReadinessReason>([
  "no_pin", "multiple_principals", "token_missing", "base_url_missing", "clone_unreachable", "cl2_missing", "cl2_not_ready",
  "me_failed", "me_no_auth", "not_scoped", "wrong_scopes", "wrong_accounts", "token_expired"
]);
const SEND_TOKEN_REASONS: ReadonlySet<string> = new Set<SendTokenReason>([
  "token_missing", "malformed", "not_scoped", "wrong_scopes", "wrong_accounts", "token_expired"
]);
const TOKEN_FP = /^[0-9a-f]{12}$/;

const eaReason = (v: unknown): EaReadinessReason | null =>
  absent(v) ? null : typeof v === "string" && EA_READINESS_REASONS.has(v) ? (v as EaReadinessReason) : reject();
const sendReason = (v: unknown): SendTokenReason | null =>
  absent(v) ? null : typeof v === "string" && SEND_TOKEN_REASONS.has(v) ? (v as SendTokenReason) : reject();
const boolOrNull = (v: unknown): boolean | null => (absent(v) ? null : bool(v));
const tokenFpOrNull = (v: unknown): string | null => (absent(v) ? null : typeof v === "string" && TOKEN_FP.test(v) ? v : reject());
const cl2SendOrNull = (v: unknown): "off" | "all" | "some" | null =>
  absent(v) ? null : v === "off" || v === "all" || v === "some" ? v : reject();

/** The stored ea-token verdict, or null when anything present is malformed (an unknown reason included). */
export function parseEaTokenState(raw: unknown): EaTokenState | null {
  return parsed(raw, (o) => ({
    ok: bool(o.ok),
    reason: eaReason(o.reason),
    checkedAt: iso(o.checkedAt),
    cl2Ready: boolOrNull(o.cl2Ready),
    cl2Send: cl2SendOrNull(o.cl2Send),
    sendEnabled: boolOrNull(o.sendEnabled),
    expiresAt: isoOrNull(o.expiresAt),
    tokenFp: tokenFpOrNull(o.tokenFp)
  }));
}

/** The stored send-token verdict, or null when anything present is malformed. */
export function parseSendTokenState(raw: unknown): SendTokenState | null {
  return parsed(raw, (o) => ({
    ok: bool(o.ok),
    reason: sendReason(o.reason),
    checkedAt: iso(o.checkedAt),
    expiresAt: isoOrNull(o.expiresAt),
    tokenFp: tokenFpOrNull(o.tokenFp)
  }));
}
