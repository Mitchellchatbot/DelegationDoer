import { randomUUID } from "node:crypto";

// P6 test fake: a standalone in-memory Supabase for slack-install.ts (contract
// §5.11, build-10; Area A). In the style of P4's fake-drafts-db.ts, not an
// extension of fake-postgrest.ts (which has no insert, delete or rpc).
//
//   const db = createFakeSlackDb({ tables: { exec_slack_installations: [row] } });
//   vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
//
// It supports insert (a simulated 23505 on exec_slack_installations_active_key,
// exec_slack_installations_dm_key and the exec_slack_posts primary key, with the
// SQL's predicates), select, update, upsert, delete().select() (consumeOAuthState),
// the filters eq, is, in, not, lt, lte, gt, gte, order, limit, and rpc(...) for the
// seven P6 RPCs with bodies mirrored from §2.1 (the routing rule of §2.4
// included). RT-F and ST keep it equal to the SQL.
//
// What it mirrors, beyond the list above:
//   * the DDL defaults of the five P6 tables (ids esi_…, timestamps = now()) and of
//     the exec_jobs / exec_conversations / exec_access_log rows the RPCs and the
//     store write;
//   * the CHECK constraints of the five P6 tables and of exec_access_log's three
//     Slack CHECKs (23514 naming the first failing constraint, in PostgreSQL's
//     alphabetical order), every unique key the store and the RPCs can hit
//     (23505), and the foreign keys the store relies on (23503:
//     exec_chat_feedback.message_id, exec_slack_posts.installation_id);
//   * an unknown column on a P6 table or exec_access_log -> PGRST204, an unknown
//     selected column -> 42703; a missing table -> PGRST205, a missing RPC ->
//     PGRST202 (seed.missing / db.missing);
//   * a RAISE inside an RPC -> P0001 with the function's message;
//   * an abort signal: a request whose signal fires before it settles resolves
//     with postgrest-js's abort result (code ""), even while seed.before is still
//     pending, so a "slow database" test sees the 2 s controller win.
// Filters follow SQL: a comparison with NULL is never true; timestamps compare
// as instants (to the millisecond: the fake doesn't keep microseconds).
// Rows in `tables` are plain snake_case objects; tests read and mutate them directly.
//
// Areas C, D and E consume this fake; none edits it.

export type Row = Record<string, unknown>;
export type FakeSlackDbError = { message: string; code?: string; details?: string };

/** The tables the fake holds: the five P6 tables, the P5b / P4 / P2a rows the RPCs touch, and the access log. */
export type FakeSlackTable =
  | "exec_slack_installations" | "exec_slack_events" | "exec_oauth_states" | "exec_chat_feedback" | "exec_slack_posts"
  | "exec_jobs" | "exec_conversations" | "exec_messages" | "exec_drafts" | "exec_access_log"
  | "exec_task_proposals";                                                       // RPC 7 (c): P5b's staged tasks

export type FakeSlackFilter =
  | { op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; column: string; value: unknown }
  | { op: "is"; column: string; value: unknown }
  | { op: "in"; column: string; values: unknown[] }
  | { op: "not"; column: string; inner: FakeSlackFilter };

/** One request the client received, in order. */
export interface FakeSlackDbCall {
  kind: "select" | "insert" | "upsert" | "update" | "delete" | "rpc";
  /** The table, or the RPC name. */
  target: string;
  /** select(...)'s column list (also delete().select(...)'s), else null. */
  columns: string | null;
  /** The insert / update / upsert values, or the RPC's arguments. */
  payload: unknown;
  /** upsert / insert options (onConflict, ignoreDuplicates, count), else null. */
  options: Record<string, unknown> | null;
  filters: FakeSlackFilter[];
  orders: { column: string; ascending: boolean }[];
  limit: number | null;
  range: [number, number] | null;
  single: "maybe" | "single" | null;
  signal: AbortSignal | null;
}

export interface FakeSlackDbSeed {
  /** Initial rows per table (copied). */
  tables?: Partial<Record<FakeSlackTable, Row[]>>;
  /** Tables and RPCs that don't exist (the migration isn't applied): a table → 42P01 / PGRST205, an RPC → PGRST202. */
  missing?: readonly string[];
  /** An error for this request, or null / undefined to run it. */
  fail?: (call: FakeSlackDbCall) => FakeSlackDbError | null | undefined;
  /** Runs just before a request executes: simulate another writer or a delay here. */
  before?: (call: FakeSlackDbCall, db: FakeSlackDb) => void | Promise<void>;
  /** The clock now() / the RPCs use (default: the real clock). */
  now?: () => Date;
}

export interface FakeSlackDb {
  /** A Supabase-shaped client (from(table) builders and rpc(name, args)) for vi.mock("@/lib/supabase-admin"). */
  client: unknown;
  /** Every table of FakeSlackTable, always present (empty when unseeded); tests read and mutate rows directly. */
  tables: Record<FakeSlackTable, Row[]>;
  /** Every request, in order. */
  calls: FakeSlackDbCall[];
  /** The tables and RPCs currently missing (mutable). */
  missing: Set<string>;
}

const TABLES: readonly FakeSlackTable[] = [
  "exec_slack_installations", "exec_slack_events", "exec_oauth_states", "exec_chat_feedback", "exec_slack_posts",
  "exec_jobs", "exec_conversations", "exec_messages", "exec_drafts", "exec_access_log", "exec_task_proposals"
];

const SI = "exec_slack_installations";
const SE = "exec_slack_events";
const OS = "exec_oauth_states";
const CF = "exec_chat_feedback";
const SP = "exec_slack_posts";
const JOBS = "exec_jobs";
const CV = "exec_conversations";
const MS = "exec_messages";
const D = "exec_drafts";
const TP = "exec_task_proposals";
const AL = "exec_access_log";

const TS = /^[0-9]{1,12}\.[0-9]{1,8}$/;
const USER = /^[UW][A-Z0-9]{2,30}$/;
const DM = /^D[A-Z0-9]{2,30}$/;
const EVENT_ID = /^Ev[A-Za-z0-9]{2,40}$/;

const isNull = (v: unknown) => v === null || v === undefined;
const ms = (v: unknown) => (typeof v === "string" ? Date.parse(v) : v instanceof Date ? v.getTime() : Number.NaN);
const hex32 = () => randomUUID().replace(/-/g, "");
const len = (v: unknown) => (typeof v === "string" ? v.length : -1);
const matches = (v: unknown, re: RegExp) => typeof v === "string" && re.test(v);

class PgError extends Error {
  readonly code: string;
  readonly details?: string;
  constructor(code: string, message: string, details?: string) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
const raise = (message: string) => new PgError("P0001", message);

// ---------------------------------------------------------------------------
// The columns, DDL defaults and CHECKs of the P6 tables (§2.1)
// ---------------------------------------------------------------------------

const COLUMNS: Partial<Record<FakeSlackTable, readonly string[]>> = {
  [SI]: ["id", "principal_id", "team_id", "app_id", "bot_user_id", "bot_id", "bot_token_enc", "key_id", "bot_scopes", "user_id", "user_token_enc",
    "user_scopes", "slack_dm_channel_id", "installed_at", "updated_at", "revoked_at", "revoke_reason", "last_dm_at", "last_error_code", "last_error_at", "purged_at"],
  [SE]: ["event_id", "installation_id", "principal_id", "team_id", "api_app_id", "event_type", "decision", "drop_reason", "channel_id", "message_ts",
    "thread_ts", "slack_user_id", "event_time", "retry_num", "job_id", "reply_state", "placeholder_ts", "conversation_id", "assistant_message_id",
    "received_at", "updated_at"],
  [OS]: ["nonce_hash", "provider", "principal_id", "auth_user_id", "session_id", "created_at", "expires_at"],
  [CF]: ["principal_id", "message_id", "vote", "surface", "created_at", "updated_at"],
  [SP]: ["installation_id", "principal_id", "channel_id", "ts", "thread_ts", "kind", "message_id", "ref_id", "posted_at", "followed_at"],
  [AL]: ["id", "principal_id", "auth_user_id", "session_id", "ip", "user_agent", "route", "surface", "created_at", "slack_user_id", "slack_event_id"]
};

function defaults(table: string, nowIso: string, nextJobId: () => number, nextLogId: () => number): Row {
  switch (table) {
    case SI:
      return {
        id: `esi_${hex32()}`, bot_token_enc: null, key_id: null, bot_scopes: [], user_token_enc: null, user_scopes: [], installed_at: nowIso,
        updated_at: nowIso, revoked_at: null, revoke_reason: null, last_dm_at: null, last_error_code: null, last_error_at: null, purged_at: null
      };
    case SE:
      return {
        installation_id: null, principal_id: null, drop_reason: null, channel_id: null, message_ts: null, thread_ts: null, slack_user_id: null,
        retry_num: 0, job_id: null, reply_state: null, placeholder_ts: null, conversation_id: null, assistant_message_id: null, received_at: nowIso,
        updated_at: nowIso
      };
    case OS:
      return { created_at: nowIso };
    case CF:
      return { created_at: nowIso, updated_at: nowIso };
    case SP:
      return { thread_ts: null, message_id: null, ref_id: null, posted_at: nowIso, followed_at: null };
    case JOBS:
      return {
        id: nextJobId(), principal_id: null, payload: {}, dedupe_key: null, status: "queued", attempts: 0, max_attempts: 6, run_after: nowIso,
        locked_by: null, locked_until: null, heartbeat_at: null, last_error: null, result: null, created_at: nowIso, started_at: null, finished_at: null
      };
    case CV:
      return {
        id: `ecv_${hex32()}`, slack_channel_id: null, slack_thread_ts: null, ref_seq: 0, turn_count: 0, last_message_at: nowIso, created_at: nowIso,
        updated_at: nowIso
      };
    case AL:
      return {
        id: nextLogId(), principal_id: null, auth_user_id: null, session_id: null, ip: null, user_agent: null, created_at: nowIso, slack_user_id: null,
        slack_event_id: null
      };
    default:
      return {};
  }
}

/** The CHECK constraints a snake_case row of `table` violates, by name, in PostgreSQL's (alphabetical) evaluation order. */
function violatedChecks(table: string, r: Row): string[] {
  const bad: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) bad.push(name);
  };
  const optional = (v: unknown, re: RegExp) => isNull(v) || matches(v, re);
  if (table === SI) {
    check("exec_slack_installations_active_token_check", !isNull(r.revoked_at) || (!isNull(r.bot_token_enc) && !isNull(r.key_id)));
    check("exec_slack_installations_app_check", matches(r.app_id, /^A[A-Z0-9]{2,30}$/));
    check("exec_slack_installations_bot_id_check", matches(r.bot_id, /^B[A-Z0-9]{2,30}$/));
    check("exec_slack_installations_bot_scopes_check", Array.isArray(r.bot_scopes) && r.bot_scopes.length <= 50);
    check("exec_slack_installations_bot_user_check", matches(r.bot_user_id, USER));
    check("exec_slack_installations_dm_check", matches(r.slack_dm_channel_id, DM));
    check("exec_slack_installations_error_code_check", optional(r.last_error_code, /^[a-z_]{1,60}$/));
    check("exec_slack_installations_error_pair_check", isNull(r.last_error_code) === isNull(r.last_error_at));
    check("exec_slack_installations_key_id_check", optional(r.key_id, /^[0-9a-f]{8}$/));
    check("exec_slack_installations_no_user_scopes", Array.isArray(r.user_scopes) && r.user_scopes.length === 0);
    check("exec_slack_installations_no_user_token", isNull(r.user_token_enc));
    check("exec_slack_installations_purged_check", isNull(r.purged_at) || (!isNull(r.revoked_at) && isNull(r.bot_token_enc) && isNull(r.key_id)));
    check("exec_slack_installations_reason_check", isNull(r.revoke_reason) || ["app_uninstalled", "tokens_revoked", "disconnected"].includes(String(r.revoke_reason)));
    check("exec_slack_installations_revoke_pair_check", isNull(r.revoked_at) === isNull(r.revoke_reason));
    check("exec_slack_installations_team_check", matches(r.team_id, /^T[A-Z0-9]{2,30}$/));
    check("exec_slack_installations_token_shape_check", optional(r.bot_token_enc, /^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/));
    check("exec_slack_installations_user_check", matches(r.user_id, USER));
  } else if (table === SE) {
    const reply = r.decision === "reply";
    check("exec_slack_events_app_check", len(r.api_app_id) >= 1 && len(r.api_app_id) <= 40);
    check("exec_slack_events_channel_check", optional(r.channel_id, DM));
    check("exec_slack_events_decision_check", ["reply", "home", "revoke", "revoke_check", "drop"].includes(String(r.decision)));
    check("exec_slack_events_drop_check", (r.decision === "drop") === !isNull(r.drop_reason));
    check("exec_slack_events_id_check", matches(r.event_id, EVENT_ID));
    check("exec_slack_events_placeholder_check", optional(r.placeholder_ts, TS));
    check("exec_slack_events_placeholder_state_check", isNull(r.placeholder_ts) || ["placeholder", "answered", "failed", "swept"].includes(String(r.reply_state)));
    check("exec_slack_events_reason_check", optional(r.drop_reason, /^[a-z_]{1,40}$/));
    check("exec_slack_events_reply_refs_check", !reply || (!isNull(r.channel_id) && !isNull(r.message_ts) && !isNull(r.principal_id) && !isNull(r.installation_id)));
    check("exec_slack_events_reply_state_check", reply === !isNull(r.reply_state));
    check("exec_slack_events_retry_check", typeof r.retry_num === "number" && r.retry_num >= 0 && r.retry_num <= 100);
    check("exec_slack_events_state_check", isNull(r.reply_state) || ["queued", "started", "placeholder", "answered", "failed", "skipped", "swept"].includes(String(r.reply_state)));
    check("exec_slack_events_team_check", len(r.team_id) >= 1 && len(r.team_id) <= 40);
    check("exec_slack_events_thread_check", optional(r.thread_ts, TS));
    check("exec_slack_events_ts_check", optional(r.message_ts, TS));
    check("exec_slack_events_type_check", matches(r.event_type, /^[a-z_.]{1,60}$/));
    check("exec_slack_events_user_check", optional(r.slack_user_id, USER));
  } else if (table === OS) {
    check("exec_oauth_states_auth_user_check", len(r.auth_user_id) >= 1 && len(r.auth_user_id) <= 128);
    check("exec_oauth_states_hash_check", matches(r.nonce_hash, /^[0-9a-f]{64}$/));
    check("exec_oauth_states_provider_check", r.provider === "slack");
    check("exec_oauth_states_session_check", len(r.session_id) >= 1 && len(r.session_id) <= 128);
    const created = ms(r.created_at);
    const expires = ms(r.expires_at);
    check("exec_oauth_states_ttl_check", expires > created && expires <= created + 600_000);
  } else if (table === CF) {
    check("exec_chat_feedback_surface_check", r.surface === "web" || r.surface === "slack");
    check("exec_chat_feedback_vote_check", r.vote === 1 || r.vote === -1);
  } else if (table === SP) {
    const card = r.kind === "draft" || r.kind === "proposal";
    check("exec_slack_posts_channel_check", matches(r.channel_id, DM));
    check("exec_slack_posts_kind_check", ["answer", "note", "draft", "proposal"].includes(String(r.kind)));
    check("exec_slack_posts_ref_check", card === !isNull(r.ref_id));
    check("exec_slack_posts_ref_kind_check", isNull(r.ref_id) || (r.kind === "draft") === String(r.ref_id).startsWith("ed_"));
    check("exec_slack_posts_ref_shape_check", optional(r.ref_id, /^(ed|etp)_[0-9a-f]{32}$/));
    check("exec_slack_posts_thread_check", optional(r.thread_ts, TS));
    check("exec_slack_posts_ts_check", matches(r.ts, TS));
  } else if (table === AL) {
    check("exec_access_log_slack_event_check", optional(r.slack_event_id, EVENT_ID));
    check("exec_access_log_slack_surface_check", r.surface === "slack" || (isNull(r.slack_user_id) && isNull(r.slack_event_id)));
    check("exec_access_log_slack_user_check", optional(r.slack_user_id, USER));
    check("exec_access_log_surface_check", ["web", "slack", "cron", "job"].includes(String(r.surface)));
  }
  return bad;
}

/** The unique keys the store and the RPCs can hit: name, columns, and a partial index's predicate. */
const UNIQUE: Partial<Record<FakeSlackTable, { name: string; cols: string[]; where?: (r: Row) => boolean }[]>> = {
  [SI]: [
    { name: "exec_slack_installations_pkey", cols: ["id"] },
    { name: "exec_slack_installations_active_key", cols: ["principal_id"], where: (r) => isNull(r.revoked_at) },
    { name: "exec_slack_installations_dm_key", cols: ["slack_dm_channel_id"], where: (r) => isNull(r.revoked_at) }
  ],
  [SE]: [{ name: "exec_slack_events_pkey", cols: ["event_id"] }],
  [OS]: [{ name: "exec_oauth_states_pkey", cols: ["nonce_hash"] }],
  [CF]: [{ name: "exec_chat_feedback_pkey", cols: ["principal_id", "message_id"] }],
  [SP]: [{ name: "exec_slack_posts_pkey", cols: ["installation_id", "ts"] }],
  [JOBS]: [{ name: "exec_jobs_dedupe_key_key", cols: ["dedupe_key"], where: (r) => !isNull(r.dedupe_key) }],
  [CV]: [
    { name: "exec_conversations_pkey", cols: ["id"] },
    { name: "exec_conversations_create_turn_key", cols: ["principal_id", "create_client_turn_id"] },
    { name: "exec_conversations_slack_thread_key", cols: ["principal_id", "slack_channel_id", "slack_thread_ts"], where: (r) => !isNull(r.slack_thread_ts) }
  ],
  [MS]: [{ name: "exec_messages_slack_ts_key", cols: ["principal_id", "slack_ts"], where: (r) => !isNull(r.slack_ts) }]
};

// ---------------------------------------------------------------------------
// Filters (SQL semantics)
// ---------------------------------------------------------------------------

function isTimeText(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) && Number.isFinite(Date.parse(v));
}

function compare(a: unknown, b: unknown): number | null {
  if (isNull(a) || isNull(b)) return null;
  if (isTimeText(a) && isTimeText(b)) return Date.parse(a) - Date.parse(b);
  if (typeof a === "number" && (typeof b === "number" || (typeof b === "string" && b.trim() !== "" && Number.isFinite(Number(b))))) return a - Number(b);
  if (typeof a === "boolean") return a === (b === true || b === "true") ? 0 : 1;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function test(row: Row, f: FakeSlackFilter): boolean {
  switch (f.op) {
    case "not": {
      if (f.inner.op === "is") return !test(row, f.inner);
      const v = row[f.inner.column];
      return !isNull(v) && !test(row, f.inner);
    }
    case "is": {
      const v = row[f.column];
      if (f.value === null || f.value === "null") return isNull(v);
      return v === (f.value === true || f.value === "true");
    }
    case "in": {
      const v = row[f.column];
      return !isNull(v) && f.values.some((x) => compare(v, x) === 0);
    }
    default: {
      const c = compare(row[f.column], f.value);
      if (c === null) return false;
      return { eq: c === 0, neq: c !== 0, lt: c < 0, lte: c <= 0, gt: c > 0, gte: c >= 0 }[f.op];
    }
  }
}

function parseNot(column: string, operator: string, value: unknown): FakeSlackFilter {
  if (operator === "is") return { op: "not", column, inner: { op: "is", column, value: value === "null" ? null : value } };
  if (operator === "in") {
    const values = Array.isArray(value) ? value : String(value).replace(/^\(|\)$/g, "").split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
    return { op: "not", column, inner: { op: "in", column, values } };
  }
  if (["eq", "neq", "lt", "lte", "gt", "gte"].includes(operator)) {
    return { op: "not", column, inner: { op: operator as "eq", column, value } };
  }
  throw new Error(`fake slack db: unsupported not() operator ${operator}`);
}

function project(row: Row, columns: string, table: string): Row {
  if (columns.trim() === "*") return structuredClone(row);
  const out: Row = {};
  for (const c of columns.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!(c in row)) throw new PgError("42703", `column ${table}.${c} does not exist`);
    out[c] = structuredClone(row[c]);
  }
  return out;
}

function sortRows(rows: Row[], orders: FakeSlackDbCall["orders"]): Row[] {
  return [...rows].sort((a, b) => {
    for (const { column, ascending } of orders) {
      const x = a[column];
      const y = b[column];
      if (isNull(x) && isNull(y)) continue;
      if (isNull(x)) return ascending ? 1 : -1;
      if (isNull(y)) return ascending ? -1 : 1;
      const c = compare(x, y) ?? 0;
      if (c !== 0) return ascending ? c : -c;
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------

type Result = { data: unknown; count: number | null; error: FakeSlackDbError | null };

const ABORTED: FakeSlackDbError = { message: "AbortError: This operation was aborted", code: "", details: "" };

export function createFakeSlackDb(seed?: FakeSlackDbSeed): FakeSlackDb {
  const cfg = seed ?? {};
  const tables = {} as Record<FakeSlackTable, Row[]>;
  for (const t of TABLES) tables[t] = (cfg.tables?.[t] ?? []).map((r) => structuredClone(r));
  const fdb: FakeSlackDb = { client: null, tables, calls: [], missing: new Set(cfg.missing ?? []) };
  const now = () => (cfg.now ? cfg.now() : new Date());
  const rowsOf = (t: string): Row[] => ((tables as Record<string, Row[]>)[t] ??= []);
  let jobSeq = tables.exec_jobs.reduce((m, j) => Math.max(m, typeof j.id === "number" ? j.id : 0), 0);
  let logSeq = tables.exec_access_log.reduce((m, j) => Math.max(m, typeof j.id === "number" ? j.id : 0), 0);
  const nextJobId = () => ++jobSeq;
  const nextLogId = () => ++logSeq;

  // --- the table's own refusals ------------------------------------------------

  /** fkColumns: the columns whose foreign keys to check (every one on an insert; on an update, only the columns it sets). */
  function refusal(table: string, candidates: Row[], others: Row[], fkColumns: ReadonlySet<string> | "all" = "all"): PgError | null {
    const fk = (col: string) => fkColumns === "all" || fkColumns.has(col);
    for (const c of candidates) {
      const bad = violatedChecks(table, c);
      if (bad.length > 0) return new PgError("23514", `new row for relation "${table}" violates check constraint "${bad[0]}"`);
    }
    for (const key of UNIQUE[table as FakeSlackTable] ?? []) {
      const all = [...others, ...candidates];
      for (const c of candidates) {
        if (key.where && !key.where(c)) continue;
        if (key.cols.some((col) => isNull(c[col]))) continue;
        const twin = all.find((o) => o !== c && (!key.where || key.where(o)) && key.cols.every((col) => compare(o[col], c[col]) === 0));
        if (twin) return new PgError("23505", `duplicate key value violates unique constraint "${key.name}"`, `Key (${key.cols.join(", ")}) already exists.`);
      }
    }
    for (const c of candidates) {
      if (table === CF && fk("message_id") && !rowsOf(MS).some((m) => m.id === c.message_id)) {
        return new PgError("23503", 'insert or update on table "exec_chat_feedback" violates foreign key constraint "exec_chat_feedback_message_id_fkey"');
      }
      if (table === SP && fk("installation_id") && !rowsOf(SI).some((i) => i.id === c.installation_id)) {
        return new PgError("23503", 'insert or update on table "exec_slack_posts" violates foreign key constraint "exec_slack_posts_installation_id_fkey"');
      }
    }
    return null;
  }

  function unknownColumn(table: string, payload: Row): PgError | null {
    const cols = COLUMNS[table as FakeSlackTable];
    if (!cols) return null;
    for (const k of Object.keys(payload)) {
      if (!cols.includes(k)) return new PgError("PGRST204", `Could not find the '${k}' column of '${table}' in the schema cache`);
    }
    return null;
  }

  /** Insert rows (with the DDL defaults) the way the RPCs do: refusals raise. */
  function insertRows(table: string, payloads: Row[], opts: { onConflictDoNothing?: boolean } = {}): Row[] {
    const nowIso = now().toISOString();
    const table$ = rowsOf(table);
    const inserted: Row[] = [];
    for (const p of payloads) {
      const row = { ...defaults(table, nowIso, nextJobId, nextLogId), ...structuredClone(p) };
      const err = refusal(table, [row], table$);
      if (err) {
        if (opts.onConflictDoNothing && err.code === "23505") continue;
        throw err;
      }
      table$.push(row);
      inserted.push(row);
    }
    return inserted;
  }

  function updateRows(table: string, rows: Row[], patch: Row): void {
    const table$ = rowsOf(table);
    const next = rows.map((r) => Object.assign(structuredClone(r), structuredClone(patch)));
    const err = refusal(table, next, table$.filter((r) => !rows.includes(r)), new Set(Object.keys(patch)));
    if (err) throw err;
    rows.forEach((r, i) => Object.assign(r, next[i]));
  }

  function insertJob(job: Row): number | null {
    const [row] = insertRows(JOBS, [job], { onConflictDoNothing: true });
    return row ? Number(row.id) : null;
  }

  // --- the seven RPCs, line for line with §2.1 --------------------------------

  function revokeInstallation(a: Row): Row {
    const id = a.p_installation_id;
    const reason = a.p_reason;
    if (isNull(reason) || !["app_uninstalled", "tokens_revoked", "disconnected"].includes(String(reason))) {
      throw raise(`exec_slack_revoke_installation: bad reason ${isNull(reason) ? "<NULL>" : String(reason)}`);
    }
    const nowIso = now().toISOString();
    const active = rowsOf(SI).filter((i) => i.id === id && isNull(i.revoked_at));
    updateRows(SI, active, { revoked_at: nowIso, revoke_reason: reason, updated_at: nowIso });
    if (rowsOf(SI).some((i) => i.id === id && !isNull(i.revoked_at) && isNull(i.purged_at))) {
      insertJob({ kind: "exec.slack-uninstall", lane: "bulk", principal_id: null, payload: { installation_id: id, mode: "purge" }, dedupe_key: `slack-uninstall:${String(id)}`, max_attempts: 6 });
    }
    return { revoked: active.length > 0 };
  }

  function acceptEvent(a: Row): Row {
    const eventId = a.p_event_id;
    if (typeof eventId !== "string" || !EVENT_ID.test(eventId)) throw raise("exec_slack_accept_event: bad event_id");
    if (isNull(a.p_team_id) || isNull(a.p_api_app_id) || isNull(a.p_event_type)) throw raise("exec_slack_accept_event: team, app and type are required");
    const eventTime = a.p_event_time;
    if (typeof eventTime !== "number" || eventTime <= 0 || eventTime > 4102444800) throw raise("exec_slack_accept_event: bad event_time");
    const team = a.p_team_id;
    const app = a.p_api_app_id;
    const type = String(a.p_event_type);
    const timeMs = eventTime * 1000;
    const nowDate = now();
    const user = a.p_user;
    const byInstalled = (rows: Row[]) => [...rows].sort((x, y) => ms(x.installed_at) - ms(y.installed_at));
    const active = () => byInstalled(rowsOf(SI).filter((i) => isNull(i.revoked_at) && i.team_id === team && i.app_id === app));
    let inst: Row | null = null;
    let found = false;
    let decision = "drop";
    let reason: string | null = null;
    let kind: string | null = null;
    let attempts: number | null = null;
    let dedupe: string | null = null;
    let payload: Row | null = null;
    let ids: string[] | null = null;
    const revokedBots = Array.isArray(a.p_revoked_bot_ids) ? (a.p_revoked_bot_ids as unknown[]) : [];
    const revokedUsers = Array.isArray(a.p_revoked_user_ids) ? (a.p_revoked_user_ids as unknown[]) : [];

    if (type === "message") {
      inst = active().find((i) => !isNull(a.p_channel) && i.slack_dm_channel_id === a.p_channel) ?? null;
      found = inst !== null;
      const ts = a.p_ts;
      const threadTs = a.p_thread_ts;
      if (!inst) reason = active().length > 0 ? "other_channel" : "not_installed";
      else if (a.p_channel_type !== "im") reason = "not_im";
      else if (user !== inst.user_id) reason = "other_user";
      else if ((a.p_has_bot_id ?? true) === true) reason = "bot_message";
      else if ((a.p_has_app_id ?? true) === true) reason = "app_message";
      else if (!isNull(a.p_subtype)) reason = "subtype";
      else if ((a.p_hidden ?? true) === true) reason = "hidden";
      else if ((a.p_text_is_string ?? false) !== true) reason = "no_text";
      else if ((a.p_has_message ?? true) === true) reason = "nested_message";
      else if (isNull(ts) || !matches(ts, TS) || (!isNull(threadTs) && !matches(threadTs, TS))) reason = "bad_ts";
      else {
        decision = "reply";
        kind = "exec.slack-reply";
        attempts = 1;
        dedupe = `slack-reply:${eventId}`;
        payload = { event_id: eventId, installation_id: inst.id, channel: a.p_channel, ts, thread_ts: isNull(threadTs) ? null : threadTs, event_time: eventTime };
      }
    } else if (type === "app_home_opened") {
      inst = active().find((i) => !isNull(user) && i.user_id === user) ?? active()[0] ?? null;
      found = inst !== null;
      if (!inst) reason = "not_installed";
      else if (isNull(user) || !matches(user, USER)) reason = "bad_user";
      else if (a.p_tab !== "home") reason = "messages_tab";
      else {
        decision = "home";
        kind = "exec.slack-home";
        attempts = 2;
        dedupe = `slack-home:${String(inst.id)}:${String(user)}:${Math.floor(nowDate.getTime() / 60_000)}`;
        payload = { installation_id: inst.id, slack_user_id: user };
      }
    } else if (type === "app_uninstalled") {
      const hits = active().filter((i) => ms(i.installed_at) <= timeMs);
      if (hits.length === 0) reason = active().length > 0 ? "stale_revoke" : "not_installed";
      else {
        decision = "revoke";
        ids = hits.map((i) => String(i.id));
      }
    } else if (type === "tokens_revoked") {
      if (revokedBots.length === 0) reason = revokedUsers.length > 0 ? "user_tokens_only" : "empty_revoke";
      else {
        const named = active().filter((i) => revokedBots.includes(i.bot_user_id));
        const hits = named.filter((i) => ms(i.installed_at) <= timeMs);
        if (hits.length === 0) reason = named.length > 0 ? "stale_revoke" : "not_installed";
        else {
          decision = "revoke_check";
          ids = hits.map((i) => String(i.id));
        }
      }
    } else {
      reason = "unsupported_type";
    }

    if ((decision === "revoke" || decision === "revoke_check") && ids) {
      inst = rowsOf(SI).find((i) => i.id === ids?.[0]) ?? null;
      found = inst !== null;
    }

    // Insert first (K7).
    if (rowsOf(SE).some((e) => e.event_id === eventId)) return { outcome: "duplicate" };
    const reply = decision === "reply";
    const [eventRow] = insertRows(SE, [{
      event_id: eventId,
      installation_id: found && inst ? inst.id : null,
      principal_id: found && inst ? inst.principal_id : null,
      team_id: String(team).slice(0, 40),
      api_app_id: String(app).slice(0, 40),
      event_type: /^[a-z_.]{1,60}$/.test(type) ? type : "unknown",
      decision,
      drop_reason: reason,
      channel_id: reply ? a.p_channel : null,
      message_ts: reply ? a.p_ts : null,
      thread_ts: reply ? (a.p_thread_ts ?? null) : null,
      // C47: only the owner's id is kept.
      slack_user_id: found && inst && matches(user, USER) && user === inst.user_id ? user : null,
      event_time: new Date(timeMs).toISOString(),
      retry_num: Math.min(Math.max(typeof a.p_retry_num === "number" ? Math.trunc(a.p_retry_num) : 0, 0), 100),
      reply_state: reply ? "queued" : null
    }]);

    let job: number | null = null;
    if ((decision === "reply" || decision === "home") && inst) {
      job = insertJob({ kind, lane: "interactive", principal_id: inst.principal_id, payload, dedupe_key: dedupe, max_attempts: attempts });
      if (job !== null) eventRow.job_id = job;
    } else if (decision === "revoke" && ids) {
      for (const id of ids) revokeInstallation({ p_installation_id: id, p_reason: "app_uninstalled" });
    } else if (decision === "revoke_check" && ids) {
      for (const id of ids) {
        insertJob({
          kind: "exec.slack-uninstall", lane: "bulk", principal_id: null, payload: { installation_id: id, mode: "check", event_time: eventTime },
          dedupe_key: `slack-revoke-check:${eventId}:${id}`, max_attempts: 3
        });
      }
    }
    return { outcome: "accepted", decision, reason, enqueued: job !== null, interactive: job !== null };
  }

  function acceptAction(a: Row): Row {
    const inst = [...rowsOf(SI)]
      .filter((i) => isNull(i.revoked_at) && i.team_id === a.p_team_id && i.app_id === a.p_api_app_id && !isNull(a.p_user_id) && i.user_id === a.p_user_id)
      .sort((x, y) => ms(x.installed_at) - ms(y.installed_at))[0];
    const ignored = (why: string) => ({ outcome: "ignored", reason: why });
    if (!inst) return ignored("not_owner");
    if (a.p_container_type !== "message") return ignored("container");
    if (a.p_channel_id !== inst.slack_dm_channel_id) return ignored("other_channel");
    if (!matches(a.p_message_ts, TS)) return ignored("bad_ts");
    if (!["ea_draft_save", "ea_draft_regen", "ea_card_refresh", "ea_task_create", "ea_task_dismiss", "ea_fb_up", "ea_fb_down"].includes(String(a.p_action_id))) {
      return ignored("unknown_action");
    }
    if (typeof a.p_value !== "string" || a.p_value.length > 200 || !/^[a-z][0-9]\.[A-Za-z0-9_.]+$/.test(a.p_value)) return ignored("bad_value");
    if (!matches(a.p_trigger_id, /^[A-Za-z0-9.]{1,200}$/)) return ignored("bad_trigger");
    const job = insertJob({
      kind: "exec.slack-action", lane: "interactive", principal_id: inst.principal_id,
      payload: { installation_id: inst.id, action_id: a.p_action_id, value: a.p_value, channel_id: a.p_channel_id, message_ts: a.p_message_ts },
      dedupe_key: `slack-act:${String(a.p_trigger_id)}`, max_attempts: 1
    });
    return { outcome: job === null ? "duplicate" : "enqueued" };
  }

  /** P8 (§2.1.12, C43; Area D): exec_slack_accept_action_v2, mirrored from 20261111100000_exec_brief.sql: P6's checks in P6's
   *  order with the allow-list widened by the two check-in buttons, then one exec.checkin-* job per CLICK (dedupe
   *  checkin-send:<trigger_id> / checkin-rewrite:<trigger_id>, intel-17), else P6's own insert. The PGRST202 seam is `missing`
   *  (db.missing.add("exec_slack_accept_action_v2")), as for any RPC. */
  function acceptActionV2(a: Row): Row {
    const inst = [...rowsOf(SI)]
      .filter((i) => isNull(i.revoked_at) && i.team_id === a.p_team_id && i.app_id === a.p_api_app_id && !isNull(a.p_user_id) && i.user_id === a.p_user_id)
      .sort((x, y) => ms(x.installed_at) - ms(y.installed_at))[0];
    const ignored = (why: string) => ({ outcome: "ignored", reason: why });
    if (!inst) return ignored("not_owner");
    if (a.p_container_type !== "message") return ignored("container");
    if (a.p_channel_id !== inst.slack_dm_channel_id) return ignored("other_channel");
    if (!matches(a.p_message_ts, TS)) return ignored("bad_ts");
    if (!["ea_draft_save", "ea_draft_regen", "ea_card_refresh", "ea_task_create", "ea_task_dismiss", "ea_fb_up", "ea_fb_down", "ea_ci_send", "ea_ci_rewrite"]
      .includes(String(a.p_action_id))) {
      return ignored("unknown_action");
    }
    if (typeof a.p_value !== "string" || a.p_value.length > 200 || !/^[a-z][0-9]\.[A-Za-z0-9_.]+$/.test(a.p_value)) return ignored("bad_value");
    if (!matches(a.p_trigger_id, /^[A-Za-z0-9.]{1,200}$/)) return ignored("bad_trigger");
    if (a.p_action_id === "ea_ci_send" || a.p_action_id === "ea_ci_rewrite") {
      if (!/^c1\.ebc_[0-9a-f]{32}\.[0-9]{1,4}\.[0-9a-f]{32}$/.test(a.p_value)) return ignored("bad_value");
      const parts = a.p_value.split(".");
      const send = a.p_action_id === "ea_ci_send";
      const ciJob = insertJob({
        kind: send ? "exec.checkin-send" : "exec.checkin-rewrite", lane: "interactive", principal_id: inst.principal_id,
        payload: { installation_id: inst.id, checkin_id: parts[1], rev: Number(parts[2]), value: a.p_value, channel_id: a.p_channel_id, message_ts: a.p_message_ts },
        dedupe_key: `${send ? "checkin-send:" : "checkin-rewrite:"}${String(a.p_trigger_id)}`, max_attempts: 1
      });
      return { outcome: ciJob === null ? "duplicate" : "enqueued" };
    }
    const job = insertJob({
      kind: "exec.slack-action", lane: "interactive", principal_id: inst.principal_id,
      payload: { installation_id: inst.id, action_id: a.p_action_id, value: a.p_value, channel_id: a.p_channel_id, message_ts: a.p_message_ts },
      dedupe_key: `slack-act:${String(a.p_trigger_id)}`, max_attempts: 1
    });
    return { outcome: job === null ? "duplicate" : "enqueued" };
  }

  function purgeInstallation(a: Row): Row {
    const id = a.p_installation_id;
    const inst = rowsOf(SI).find((i) => i.id === id && !isNull(i.revoked_at));
    if (!inst) return { purged: false };
    const nowIso = now().toISOString();
    const events = rowsOf(SE).filter((e) => e.installation_id === id);
    tables.exec_slack_events = rowsOf(SE).filter((e) => e.installation_id !== id);
    const posts = rowsOf(SP).filter((p) => p.installation_id === id);
    tables.exec_slack_posts = rowsOf(SP).filter((p) => p.installation_id !== id);
    updateRows(SI, [inst], { bot_token_enc: null, key_id: null, purged_at: inst.purged_at ?? nowIso, updated_at: nowIso });
    const revokedMs = ms(inst.revoked_at);
    const doomed = rowsOf(CV).filter((c) => c.principal_id === inst.principal_id && c.surface === "slack" && ms(c.created_at) <= revokedMs);
    deleteConversations(doomed);
    return { purged: true, events: events.length, posts: posts.length, conversations: doomed.length };
  }

  /** exec_conversations delete with its cascades (messages, their feedback) and SET NULLs (events, ledger). */
  function deleteConversations(doomed: Row[]): void {
    const convIds = new Set(doomed.map((c) => c.id));
    const goneMessages = new Set(rowsOf(MS).filter((m) => convIds.has(m.conversation_id)).map((m) => m.id));
    tables.exec_conversations = rowsOf(CV).filter((c) => !convIds.has(c.id));
    tables.exec_messages = rowsOf(MS).filter((m) => !goneMessages.has(m.id));
    tables.exec_chat_feedback = rowsOf(CF).filter((f) => !goneMessages.has(f.message_id));
    for (const e of rowsOf(SE)) {
      if (convIds.has(e.conversation_id)) e.conversation_id = null;
      if (goneMessages.has(e.assistant_message_id)) e.assistant_message_id = null;
    }
    for (const p of rowsOf(SP)) if (goneMessages.has(p.message_id)) p.message_id = null;
  }

  function conversationForThread(a: Row): string {
    const channel = a.p_channel;
    const rootTs = a.p_root_ts;
    if (!matches(channel, DM)) throw raise("exec_slack_conversation_for_thread: bad channel");
    if (!matches(rootTs, TS)) throw raise("exec_slack_conversation_for_thread: bad ts");
    const daysIn = typeof a.p_retention_days === "number" ? Math.trunc(a.p_retention_days) : 90;
    const days = Math.min(Math.max(daysIn, 1), 3650);
    const title = typeof a.p_title === "string" && a.p_title.trim() !== "" ? a.p_title.trim() : "Slack conversation";
    const nowDate = now();
    // C18: a thread's conversation from before a revocation still waiting for its purge goes now; the turn gets a fresh one.
    const pending = rowsOf(SI)
      .filter((i) => i.principal_id === a.p_principal && !isNull(i.revoked_at) && isNull(i.purged_at))
      .reduce((m, i) => Math.max(m, ms(i.revoked_at)), Number.NEGATIVE_INFINITY);
    if (pending > Number.NEGATIVE_INFINITY) {
      deleteConversations(rowsOf(CV).filter((c) => c.principal_id === a.p_principal && c.surface === "slack" && c.slack_channel_id === channel &&
        c.slack_thread_ts === rootTs && ms(c.created_at) <= pending));
    }
    insertRows(CV, [{
      principal_id: a.p_principal,
      surface: "slack",
      title: title.slice(0, 120),
      create_client_turn_id: `slkc_${String(channel)}_${String(rootTs).replace(".", "_")}`,
      slack_channel_id: channel,
      slack_thread_ts: rootTs,
      expires_at: new Date(nowDate.getTime() + days * 86_400_000).toISOString()
    }], { onConflictDoNothing: true });
    const row = rowsOf(CV).find((c) => c.principal_id === a.p_principal && c.slack_channel_id === channel && c.slack_thread_ts === rootTs);
    if (!row) throw raise("exec_slack_conversation_for_thread: no conversation after insert");
    return String(row.id);
  }

  function replyStep(a: Row): boolean {
    const to = a.p_to;
    const from = Array.isArray(a.p_from) ? (a.p_from as unknown[]) : null;
    if (isNull(to) || !["started", "placeholder", "answered", "failed", "skipped", "swept"].includes(String(to))) {
      throw raise(`exec_slack_reply_step: bad target ${isNull(to) ? "<NULL>" : String(to)}`);
    }
    const within = (allowed: string[]) => from !== null && from.every((s) => allowed.includes(String(s)));
    const allowed =
      (to === "started" && within(["queued"])) ||
      (to === "placeholder" && within(["started"])) ||
      ((to === "answered" || to === "failed") && within(["started", "placeholder"])) ||
      (to === "skipped" && within(["queued", "started"])) ||
      (to === "swept" && within(["queued", "started", "placeholder"]));
    if (!allowed) throw raise("exec_slack_reply_step: transition not allowed");
    if (to === "placeholder" && !matches(a.p_placeholder_ts, TS)) throw raise("exec_slack_reply_step: placeholder ts required");
    const ev = rowsOf(SE).find((e) => e.event_id === a.p_event_id && e.decision === "reply" && from !== null && from.includes(e.reply_state));
    if (!ev) return false;
    const nowIso = now().toISOString();
    updateRows(SE, [ev], {
      reply_state: to,
      placeholder_ts: a.p_placeholder_ts ?? ev.placeholder_ts,
      conversation_id: a.p_conversation_id ?? ev.conversation_id,
      assistant_message_id: a.p_assistant_message_id ?? ev.assistant_message_id,
      updated_at: nowIso
    });
    if (to === "placeholder" && !isNull(a.p_assistant_message_id)) {
      const m = rowsOf(MS).filter((x) => x.id === a.p_assistant_message_id && x.principal_id === ev.principal_id && x.role === "assistant" && isNull(x.slack_ts));
      updateRows(MS, m, { slack_ts: a.p_placeholder_ts, updated_at: nowIso });
    }
    // (The installation exists in SQL whenever the event names one: its FK. A test that seeds no installation row skips this.)
    if (to === "placeholder" && !isNull(ev.installation_id) && !isNull(ev.principal_id) && !isNull(ev.channel_id) && !isNull(ev.message_ts) &&
        rowsOf(SI).some((i) => i.id === ev.installation_id)) {
      // C43: the answer post's ledger row lands with the transition (a conflict with dmPost's own row is a no-op).
      const m = rowsOf(MS).find((x) => x.id === a.p_assistant_message_id && x.principal_id === ev.principal_id && x.role === "assistant");
      insertRows(SP, [{
        installation_id: ev.installation_id, principal_id: ev.principal_id, channel_id: ev.channel_id, ts: a.p_placeholder_ts,
        thread_ts: ev.thread_ts ?? ev.message_ts, kind: "answer", message_id: m ? m.id : null
      }], { onConflictDoNothing: true });
    }
    if (to === "answered") {
      updateRows(SI, rowsOf(SI).filter((i) => i.id === ev.installation_id), { last_dm_at: nowIso, last_error_code: null, last_error_at: null, updated_at: nowIso });
    }
    return true;
  }

  function redactionFollowups(a: Row): Row {
    const principal = a.p_principal;
    const installation = a.p_installation_id;
    if (isNull(principal) || isNull(installation)) throw raise("exec_slack_redaction_followups: principal and installation are required");
    const limitIn = typeof a.p_limit === "number" ? Math.trunc(a.p_limit) : 20;
    const limit = Math.min(Math.max(limitIn, 1), 100);
    const open = new Set(["queued", "started", "placeholder"]);
    const answers: Row[] = [];
    for (const p of rowsOf(SP)) {
      if (p.principal_id !== principal || p.installation_id !== installation || p.kind !== "answer") continue;
      const m = rowsOf(MS).find((x) => x.id === p.message_id);
      if (!m || m.principal_id !== principal || isNull(m.redacted_at)) continue;
      if (!isNull(p.followed_at) && !(ms(m.updated_at) > ms(p.followed_at))) continue;
      if (rowsOf(SE).some((e) => e.assistant_message_id === m.id && open.has(String(e.reply_state)))) continue;
      answers.push({ ts: p.ts, message_id: m.id, conversation_id: m.conversation_id, changed_at: m.updated_at });
    }
    const drafts: Row[] = [];
    for (const p of rowsOf(SP)) {
      if (p.principal_id !== principal || p.installation_id !== installation || p.kind !== "draft") continue;
      const d = rowsOf(D).find((x) => x.id === p.ref_id);
      if (!d || d.principal_id !== principal || d.restricted_purged !== true) continue;
      if (!isNull(p.followed_at) && !(ms(d.updated_at) > ms(p.followed_at))) continue;
      drafts.push({ ts: p.ts, draft_id: p.ref_id, changed_at: d.updated_at });
    }
    const proposals: Row[] = [];
    for (const p of rowsOf(SP)) {
      if (p.principal_id !== principal || p.installation_id !== installation || p.kind !== "proposal") continue;
      const t = rowsOf(TP).find((x) => x.id === p.ref_id);
      if (!t || t.principal_id !== principal || isNull(t.redacted_at)) continue;
      if (!isNull(p.followed_at) && !(ms(t.updated_at) > ms(p.followed_at))) continue;
      proposals.push({ ts: p.ts, proposal_id: p.ref_id, changed_at: t.updated_at });
    }
    const byChanged = (x: Row, y: Row) => ms(x.changed_at) - ms(y.changed_at);
    return {
      answers: answers.sort(byChanged).slice(0, limit),
      drafts: drafts.sort(byChanged).slice(0, limit),
      proposals: proposals.sort(byChanged).slice(0, limit)
    };
  }

  const rpcs: Record<string, (args: Row) => unknown> = {
    exec_slack_accept_event: acceptEvent,
    exec_slack_accept_action: acceptAction,
    exec_slack_accept_action_v2: acceptActionV2,
    exec_slack_revoke_installation: revokeInstallation,
    exec_slack_purge_installation: purgeInstallation,
    exec_slack_conversation_for_thread: conversationForThread,
    exec_slack_reply_step: replyStep,
    exec_slack_redaction_followups: redactionFollowups
  };

  // --- one request ------------------------------------------------------------

  function errorOf(err: unknown): FakeSlackDbError {
    if (err instanceof PgError) return { message: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) };
    const e = err as { message?: string; code?: string };
    return { message: typeof e?.message === "string" ? e.message : String(err), ...(typeof e?.code === "string" ? { code: e.code } : {}) };
  }

  /** A whole request is atomic: on any refusal the tables go back to how they were (one statement, one transaction). */
  function atomically<T>(fn: () => T): T {
    const snapshot = structuredClone(tables);
    const seqs = [jobSeq, logSeq];
    try {
      return fn();
    } catch (err) {
      for (const t of TABLES) tables[t] = snapshot[t];
      [jobSeq, logSeq] = seqs;
      throw err;
    }
  }

  function run(r: FakeSlackDbCall): Result {
    const opts = r.options ?? {};
    const wantCount = opts.count === "exact";
    if (r.kind === "rpc") {
      const impl = rpcs[r.target];
      if (!impl) return { data: null, count: null, error: { code: "PGRST202", message: `Could not find the function public.${r.target} in the schema cache` } };
      return { data: structuredClone(atomically(() => impl((r.payload ?? {}) as Row))), count: null, error: null };
    }
    const table = r.target;
    let affected: Row[];
    if (r.kind === "insert" || r.kind === "upsert") {
      const payloads = (Array.isArray(r.payload) ? r.payload : [r.payload]) as Row[];
      for (const p of payloads) {
        const bad = unknownColumn(table, p);
        if (bad) throw bad;
      }
      affected = atomically(() => {
        if (r.kind === "insert") return insertRows(table, payloads);
        const keys = String(opts.onConflict ?? "id").split(",").map((s) => s.trim());
        const out: Row[] = [];
        for (const p of payloads) {
          const existing = rowsOf(table).find((row) => keys.every((k) => compare(row[k], p[k]) === 0));
          if (existing) {
            if (opts.ignoreDuplicates) continue;
            updateRows(table, [existing], p);
            out.push(existing);
          } else {
            out.push(...insertRows(table, [p]));
          }
        }
        return out;
      });
    } else {
      const rows = rowsOf(table).filter((row) => r.filters.every((f) => test(row, f)));
      if (r.kind === "update") {
        const bad = unknownColumn(table, (r.payload ?? {}) as Row);
        if (bad) throw bad;
        atomically(() => updateRows(table, rows, (r.payload ?? {}) as Row));
        affected = rows;
      } else if (r.kind === "delete") {
        (tables as Record<string, Row[]>)[table] = rowsOf(table).filter((row) => !rows.includes(row));
        affected = rows;
      } else {
        affected = sortRows(rows, r.orders);
        if (r.range) affected = affected.slice(r.range[0], r.range[1] + 1);
        if (r.limit !== null) affected = affected.slice(0, r.limit);
      }
    }
    const count = wantCount ? affected.length : null;
    if (opts.head === true || r.columns === null) return { data: null, count, error: null };
    const out = affected.map((row) => project(row, r.columns as string, table));
    if (r.single === "single") {
      if (out.length !== 1) return { data: null, count, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
      return { data: out[0], count, error: null };
    }
    if (r.single === "maybe") {
      if (out.length > 1) return { data: null, count, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
      return { data: out[0] ?? null, count, error: null };
    }
    return { data: out, count, error: null };
  }

  async function execute(r: FakeSlackDbCall): Promise<Result> {
    fdb.calls.push(r);
    await cfg.before?.(r, fdb);
    if (r.signal?.aborted) return { data: null, count: null, error: { ...ABORTED } };
    if (fdb.missing.has(r.target)) {
      return r.kind === "rpc"
        ? { data: null, count: null, error: { code: "PGRST202", message: `Could not find the function public.${r.target} in the schema cache` } }
        : { data: null, count: null, error: { code: "PGRST205", message: `Could not find the table 'public.${r.target}' in the schema cache` } };
    }
    const failed = cfg.fail?.(r);
    if (failed) return { data: null, count: null, error: failed };
    try {
      return run(r);
    } catch (err) {
      return { data: null, count: null, error: errorOf(err) };
    }
  }

  /** Like postgrest-js: a request whose signal fires before it settles resolves with the abort result. */
  function settle(r: FakeSlackDbCall): Promise<Result> {
    const signal = r.signal;
    if (signal?.aborted) {
      fdb.calls.push(r);
      return Promise.resolve({ data: null, count: null, error: { ...ABORTED } });
    }
    const pending = execute(r);
    if (!signal) return pending;
    return new Promise<Result>((resolve, reject) => {
      const onAbort = () => resolve({ data: null, count: null, error: { ...ABORTED } });
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  function builder(r: FakeSlackDbCall) {
    let settled: Promise<Result> | null = null;
    const b = {
      select(columns: string = "*", options?: { count?: string; head?: boolean }) {
        r.columns = columns;
        if (options) r.options = { ...(r.options ?? {}), ...options };
        return b;
      },
      eq: (column: string, value: unknown) => (r.filters.push({ op: "eq", column, value }), b),
      neq: (column: string, value: unknown) => (r.filters.push({ op: "neq", column, value }), b),
      lt: (column: string, value: unknown) => (r.filters.push({ op: "lt", column, value }), b),
      lte: (column: string, value: unknown) => (r.filters.push({ op: "lte", column, value }), b),
      gt: (column: string, value: unknown) => (r.filters.push({ op: "gt", column, value }), b),
      gte: (column: string, value: unknown) => (r.filters.push({ op: "gte", column, value }), b),
      is: (column: string, value: unknown) => (r.filters.push({ op: "is", column, value }), b),
      in: (column: string, values: readonly unknown[]) => (r.filters.push({ op: "in", column, values: [...values] }), b),
      not: (column: string, operator: string, value: unknown) => (r.filters.push(parseNot(column, operator, value)), b),
      order(column: string, options?: { ascending?: boolean }) {
        r.orders.push({ column, ascending: options?.ascending !== false });
        return b;
      },
      range(from: number, to: number) {
        r.range = [from, to];
        return b;
      },
      limit(n: number) {
        r.limit = n;
        return b;
      },
      maybeSingle() {
        r.single = "maybe";
        return b;
      },
      single() {
        r.single = "single";
        return b;
      },
      abortSignal(signal: AbortSignal) {
        r.signal = signal;
        return b;
      },
      then<A, B>(onFulfilled?: (v: Result) => A, onRejected?: (e: unknown) => B) {
        settled ??= Promise.resolve().then(() => settle(r));
        return settled.then(onFulfilled, onRejected);
      }
    };
    return b;
  }

  const request = (kind: FakeSlackDbCall["kind"], target: string, payload: unknown = null, options: Record<string, unknown> | null = null): FakeSlackDbCall => ({
    kind, target, columns: null, payload: structuredClone(payload), options, filters: [], orders: [], limit: null, range: null, single: null, signal: null
  });

  fdb.client = {
    from(table: string) {
      return {
        select: (columns = "*", options?: { count?: string; head?: boolean }) => builder(request("select", table, null, options ? { ...options } : null)).select(columns, options),
        insert: (rows: unknown, options?: Record<string, unknown>) => builder(request("insert", table, rows, options ? { ...options } : null)),
        upsert: (row: unknown, options?: Record<string, unknown>) => builder(request("upsert", table, row, options ? { ...options } : {})),
        update: (patch: Row, options?: { count?: string }) => builder(request("update", table, patch, options ? { ...options } : null)),
        delete: (options?: { count?: string }) => builder(request("delete", table, null, options ? { ...options } : null))
      };
    },
    rpc(fn: string, args: Row = {}) {
      return builder(request("rpc", fn, args));
    }
  };
  return fdb;
}
