import { randomUUID } from "node:crypto";

import type { FakeSlackDbError, Row } from "./fake-slack-db";

// P8 test fake: a standalone in-memory Supabase for brief-store.ts (P8 contract §5.19; Area A), in the style of P6's
// fake-slack-db.ts and P7b's fake-slack-intel-db.ts. The INTERFACE is frozen at stage 0 (lead); Area A wrote the body.
//
//   const db = createFakeBriefDb({ tables: { exec_briefs: [row] } });
//   vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
//
// What it does (ST08 keeps it equal to the SQL, 20261111100000_exec_brief.sql, on SQ05-SQ12's cases):
//   * from(table) builders for the tables below: insert, select, update, upsert (onConflict), delete().select(); filters
//     eq, neq, in, is, not, lt, lte, gt, gte, contains, overlaps, order, limit, range, count / head (count: "exact" counts
//     the matching rows before range / limit, as PostgREST does); the P8 DDL defaults (eb_/ebc_ ids, rev 1, status
//     'proposed', regen_seq 0, post_attempts 0, the ref arrays '{}'), the NOT NULLs (23502), the named CHECKs of
//     §2.1.1-§2.1.3 (23514 naming the first failing constraint in PostgreSQL's alphabetical order), the unique keys
//     (exec_briefs_day_key and the partial exec_brief_checkins_live_key, the primary keys, exec_jobs' dedupe_key → 23505),
//     the check-in → brief foreign key (23503) and its cascade (deleting a brief deletes its check-ins);
//   * rpc(name, args) for the ten P8 brief functions (§2.1.4-§2.1.10), bodies mirrored line for line from the migration:
//     RPC 1's insert-or-claim with the placeholder, retry and regenerate rules (the 'built' 10-minute rule, the lock and its
//     60..900 s clamp, the regen_seq bump), RPC 2's rev CAS, the regenerate's status rules and the novelty_marked_at guard
//     (a duplicate fingerprint → 21000), RPC 3's transition table and post count, RPC 4's insert-then-claim, RPCs 5/6's
//     content rewrite (the removed text, emptied refs, dropped pending lines and top-3 entries, the nulled headline with
//     headlineScrubbed, the recomputed ref arrays, scrubbed_at) and RPC 7's purge with its limit. A RAISE → P0001 with the
//     function's message; a whole RPC is atomic. exec_slack_accept_action_v2 is NOT here (P6's fake-slack-db.ts, Area D);
//   * missing tables / functions / columns: a name in `missing` → PGRST205 for a table, PGRST202 for an RPC, 42703 for a
//     "table.column" selected and PGRST204 for one written; failNext(op, code) makes the next matching request answer
//     that code once (op: a table or RPC name, or "<kind>:<table>", e.g. "update:exec_briefs");
//   * an aborted signal → postgrest-js's abort result (code ""), even while seed.before is still pending.
// Departures from the database, on purpose: pg_column_size(content) is approximated by the JSON's UTF-8 length; the FKs
// to exec_principals and users are not enforced (the fake holds no principals); timestamps compare to the millisecond.
// Rows in `tables` are plain snake_case objects; tests read and mutate them directly. Areas B-E consume this fake; none
// edits it. scrubBriefThreadRows (below) is the RPC 5 mirror, shared with fake-email-db.ts (the tombstone procedure's
// brief step, §3.21.1 X1).

/** The tables the fake holds (§5.19). */
export type FakeBriefTable =
  | "exec_briefs" | "exec_brief_checkins" | "exec_brief_mentions"
  | "daily_briefings" | "exec_jobs" | "exec_sync_state" | "exec_access_log" | "exec_ai_usage" | "users";

/** The ten P8 brief functions (§2.1.4-§2.1.10; exec_slack_accept_action_v2 is P6's fake's, Area D). */
export type FakeBriefRpc =
  | "exec_brief_item_hit" | "exec_brief_scrub_content" | "exec_brief_ref_array"
  | "exec_brief_claim_build" | "exec_brief_finish_build" | "exec_brief_delivery_step" | "exec_brief_claim_fallback"
  | "exec_brief_scrub_threads" | "exec_brief_scrub_slack" | "exec_brief_purge_expired";

export const FAKE_BRIEF_TABLES: readonly FakeBriefTable[] = Object.freeze([
  "exec_briefs", "exec_brief_checkins", "exec_brief_mentions",
  "daily_briefings", "exec_jobs", "exec_sync_state", "exec_access_log", "exec_ai_usage", "users"
] as FakeBriefTable[]);

export const FAKE_BRIEF_RPCS: readonly FakeBriefRpc[] = Object.freeze([
  "exec_brief_item_hit", "exec_brief_scrub_content", "exec_brief_ref_array",
  "exec_brief_claim_build", "exec_brief_finish_build", "exec_brief_delivery_step", "exec_brief_claim_fallback",
  "exec_brief_scrub_threads", "exec_brief_scrub_slack", "exec_brief_purge_expired"
] as FakeBriefRpc[]);

export type FakeBriefFilter =
  | { op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; column: string; value: unknown }
  | { op: "is"; column: string; value: unknown }
  | { op: "in"; column: string; values: unknown[] }
  | { op: "contains" | "overlaps"; column: string; values: unknown[] }
  | { op: "not"; column: string; inner: FakeBriefFilter };

/** One request the client received, in order (P6's / P7b's record shape). */
export interface FakeBriefDbCall {
  kind: "select" | "insert" | "upsert" | "update" | "delete" | "rpc";
  /** The table, or the RPC name. */
  target: string;
  /** select(...)'s column list (also delete().select(...)'s), else null. */
  columns: string | null;
  /** The insert / update / upsert values, or the RPC's arguments. */
  payload: unknown;
  /** upsert / insert options (onConflict, ignoreDuplicates, count), else null. */
  options: Record<string, unknown> | null;
  filters: FakeBriefFilter[];
  orders: { column: string; ascending: boolean }[];
  limit: number | null;
  range: [number, number] | null;
  single: "maybe" | "single" | null;
  signal: AbortSignal | null;
}

export interface FakeBriefDbSeed {
  /** Initial rows per table (copied). */
  tables?: Partial<Record<FakeBriefTable, Row[]>>;
  /** Tables, RPCs and "table.column" names that don't exist (see the header). */
  missing?: readonly string[];
  /** An error for this request, or null / undefined to run it. */
  fail?: (call: FakeBriefDbCall) => FakeSlackDbError | null | undefined;
  /** Runs just before a request executes: simulate another writer (a scrub during a build) or a delay here. */
  before?: (call: FakeBriefDbCall, db: FakeBriefDb) => void | Promise<void>;
  /** The clock now() / the RPCs use (default: the real clock). */
  now?: () => Date;
}

export interface FakeBriefDb {
  /** A Supabase-shaped client (from(table) builders and rpc(name, args)) for vi.mock("@/lib/supabase-admin"). */
  client: unknown;
  /** Every table of FakeBriefTable, always present (empty when unseeded). */
  tables: Record<FakeBriefTable, Row[]>;
  /** Every request, in order. */
  calls: FakeBriefDbCall[];
  /** The tables, RPCs and columns currently missing (mutable). */
  missing: Set<string>;
  /** One of the ten P8 functions, called directly with its p_* arguments (the client's rpc() goes through it too). */
  rpc(name: FakeBriefRpc, args: Record<string, unknown>): Promise<{ data: unknown; error: FakeSlackDbError | null }>;
  /** The next request whose op matches (a table or RPC name, or "<kind>:<table>") answers { code, message } once. */
  failNext(op: string, code: string, message?: string): void;
  /** How many writes ran (insert / update / upsert / delete, and the RPCs that write: 1, 2, 3, 4, 5, 6, 7). BB11 / BS04 / UI12
   *  assert 0 ("nothing persisted"). */
  mutations(): number;
}

const EB = "exec_briefs";
const CK = "exec_brief_checkins";
const MN = "exec_brief_mentions";
const DB_ = "daily_briefings";
const JOBS = "exec_jobs";
const AL = "exec_access_log";
const AU = "exec_ai_usage";
const SS = "exec_sync_state";

const WRITE_RPCS: ReadonlySet<string> = new Set([
  "exec_brief_claim_build", "exec_brief_finish_build", "exec_brief_delivery_step", "exec_brief_claim_fallback",
  "exec_brief_scrub_threads", "exec_brief_scrub_slack", "exec_brief_purge_expired"
]);

const TS = /^[0-9]{1,12}\.[0-9]{1,8}$/;
const DM = /^D[A-Z0-9]{2,30}$/;
const REASON40 = /^[a-z_]{1,40}$/;
const CODE60 = /^[a-z0-9_]{1,60}$/;

const isNull = (v: unknown) => v === null || v === undefined;
const ms = (v: unknown) => (typeof v === "string" ? Date.parse(v) : v instanceof Date ? v.getTime() : Number.NaN);
const hex32 = () => randomUUID().replace(/-/g, "");
const len = (v: unknown) => (typeof v === "string" ? [...v].length : -1);
const matches = (v: unknown, re: RegExp) => typeof v === "string" && re.test(v);
const optional = (v: unknown, re: RegExp) => isNull(v) || matches(v, re);
const card = (v: unknown) => (Array.isArray(v) ? v.length : 0);
/** A date column's value as YYYY-MM-DD (a Date or an ISO string is cut to its date). */
const ymd = (v: unknown): string | null => {
  if (isNull(v)) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const isoOf = (v: unknown): string | null => {
  if (isNull(v)) return null;
  const t = ms(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : (v as string);
};

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
// The columns, DDL defaults, NOT NULLs and CHECKs of the P8 tables (§2.1.1-§2.1.3)
// ---------------------------------------------------------------------------

const COLUMNS: Partial<Record<FakeBriefTable, readonly string[]>> = {
  [EB]: ["id", "principal_id", "local_date", "tz", "scheduled_at", "rev", "status", "status_reason", "owner", "owner_reason", "mode", "mode_reason",
    "content", "ref_thread_ids", "ref_slack_keys", "ref_slack_channels", "build_started_at", "built_at", "regen_lock_until", "regen_seq",
    "novelty_marked_at", "delivery_started_at", "post_attempts", "delivered_at", "slack_channel_id", "slack_ts", "checkins_ts", "late_note_ts",
    "fallback_sent_at", "fallback_slack_ts", "fallback_channel_id", "fallback_delete_after", "fallback_deleted_at", "fallback_error_code", "scrubbed_at",
    "dm_followed_at", "error_code", "content_expires_at", "content_purged_at", "expires_at", "created_at", "updated_at"],
  [CK]: ["id", "brief_id", "principal_id", "local_date", "brief_rev", "rev", "recipient_user_id", "recipient_slack_id", "text", "status", "status_reason",
    "sending_at", "sent_at", "slack_channel_id", "slack_ts", "audit_id", "expires_at", "purge_at", "created_at", "updated_at"],
  [MN]: ["principal_id", "fingerprint", "last_state_hash", "last_band", "last_mentioned_on", "created_at", "updated_at"],
  [DB_]: ["id", "brief_date", "created_at", "delivered_at", "slack_channel", "slack_ts", "update_text", "needle_mover", "messages", "meta"]
};

const NOT_NULL: Partial<Record<FakeBriefTable, readonly string[]>> = {
  [EB]: ["id", "principal_id", "local_date", "tz", "scheduled_at", "rev", "status", "ref_thread_ids", "ref_slack_keys", "ref_slack_channels", "regen_seq",
    "post_attempts", "content_expires_at", "expires_at", "created_at", "updated_at"],
  [CK]: ["id", "brief_id", "principal_id", "local_date", "brief_rev", "rev", "recipient_user_id", "recipient_slack_id", "text", "status", "expires_at",
    "purge_at", "created_at", "updated_at"],
  [MN]: ["principal_id", "fingerprint", "last_state_hash", "last_band", "last_mentioned_on", "created_at", "updated_at"],
  [DB_]: ["id", "brief_date", "created_at", "update_text", "messages", "meta"]
};

function defaults(table: string, nowIso: string, seq: { job: () => number; log: () => number; usage: () => number }): Row {
  switch (table) {
    case EB: {
      const row: Row = Object.fromEntries((COLUMNS[EB] ?? []).map((c) => [c, null]));
      return {
        ...row, id: `eb_${hex32()}`, rev: 1, ref_thread_ids: [], ref_slack_keys: [], ref_slack_channels: [], regen_seq: 0, post_attempts: 0,
        created_at: nowIso, updated_at: nowIso
      };
    }
    case CK: {
      const row: Row = Object.fromEntries((COLUMNS[CK] ?? []).map((c) => [c, null]));
      return { ...row, id: `ebc_${hex32()}`, rev: 1, status: "proposed", created_at: nowIso, updated_at: nowIso };
    }
    case MN:
      return { created_at: nowIso, updated_at: nowIso };
    case DB_:
      return { created_at: nowIso, delivered_at: null, slack_channel: null, slack_ts: null, update_text: "", needle_mover: null, messages: [], meta: {} };
    case JOBS:
      return {
        id: seq.job(), principal_id: null, payload: {}, dedupe_key: null, status: "queued", attempts: 0, max_attempts: 6, run_after: nowIso,
        locked_by: null, locked_until: null, heartbeat_at: null, last_error: null, result: null, created_at: nowIso, started_at: null, finished_at: null
      };
    case AL:
      return { id: seq.log(), principal_id: null, auth_user_id: null, session_id: null, ip: null, user_agent: null, created_at: nowIso };
    case AU:
      return { id: seq.usage(), created_at: nowIso };
    case SS:
      return { updated_at: nowIso };
    default:
      return {};
  }
}

/** The CHECK constraints a snake_case row of `table` violates, by name, in PostgreSQL's (alphabetical) evaluation order. */
function violatedChecks(table: string, r: Row): string[] {
  const checks: [string, boolean][] = [];
  const check = (name: string, ok: boolean) => checks.push([name, ok]);
  if (table === EB) {
    const status = r.status;
    check("exec_briefs_id_check", matches(r.id, /^eb_[0-9a-f]{32}$/));
    check("exec_briefs_tz_check", len(r.tz) >= 1 && len(r.tz) <= 64);
    check("exec_briefs_rev_check", typeof r.rev === "number" && r.rev >= 1 && r.rev <= 10000);
    check("exec_briefs_status_check", ["building", "built", "delivering", "delivered", "delivery_unknown", "page_only", "failed"].includes(String(status)));
    check("exec_briefs_status_reason_check", optional(r.status_reason, REASON40));
    check("exec_briefs_owner_check", isNull(r.owner) || ["exec", "legacy", "exec_page_only"].includes(String(r.owner)));
    check("exec_briefs_owner_reason_check", optional(r.owner_reason, REASON40));
    check("exec_briefs_mode_check", isNull(r.mode) || ["ai", "deterministic"].includes(String(r.mode)));
    check("exec_briefs_mode_reason_check",
      isNull(r.mode_reason) || ["refused", "truncated", "budget", "invalid_output", "model_error", "timeout"].includes(String(r.mode_reason)));
    check("exec_briefs_content_check", isNull(r.content)
      || (typeof r.content === "object" && !Array.isArray(r.content) && Buffer.byteLength(JSON.stringify(r.content), "utf8") <= 262144));
    check("exec_briefs_ref_threads_check", card(r.ref_thread_ids) <= 400);
    check("exec_briefs_ref_slack_keys_check", card(r.ref_slack_keys) <= 400);
    check("exec_briefs_ref_slack_channels_check", card(r.ref_slack_channels) <= 200);
    check("exec_briefs_regen_seq_check", typeof r.regen_seq === "number" && r.regen_seq >= 0 && r.regen_seq <= 100000);
    check("exec_briefs_post_attempts_check", typeof r.post_attempts === "number" && r.post_attempts >= 0 && r.post_attempts <= 2);
    check("exec_briefs_channel_check", optional(r.slack_channel_id, DM));
    check("exec_briefs_ts_check", optional(r.slack_ts, TS));
    check("exec_briefs_checkins_ts_check", optional(r.checkins_ts, TS));
    check("exec_briefs_late_ts_check", optional(r.late_note_ts, TS));
    check("exec_briefs_fallback_ts_check", optional(r.fallback_slack_ts, TS));
    check("exec_briefs_fallback_channel_check", optional(r.fallback_channel_id, DM));
    check("exec_briefs_fallback_error_check", optional(r.fallback_error_code, CODE60));
    check("exec_briefs_error_code_check", optional(r.error_code, CODE60));
    check("exec_briefs_delivered_check", (status === "delivered") === !isNull(r.delivered_at));
    check("exec_briefs_delivered_refs_check", isNull(r.delivered_at) || (!isNull(r.slack_ts) && !isNull(r.slack_channel_id)));
    check("exec_briefs_delivering_check",
      !["delivering", "delivery_unknown"].includes(String(status)) || (!isNull(r.delivery_started_at) && Number(r.post_attempts) >= 1));
    check("exec_briefs_content_presence_check", !isNull(r.content) || ["building", "failed"].includes(String(status)) || !isNull(r.content_purged_at));
    check("exec_briefs_content_purged_check", isNull(r.content_purged_at) || isNull(r.content));
    check("exec_briefs_mode_pair_check", isNull(r.mode) === isNull(r.built_at));
    check("exec_briefs_fallback_pair_check", (isNull(r.fallback_slack_ts) && isNull(r.fallback_error_code)) || !isNull(r.fallback_sent_at));
    check("exec_briefs_fallback_dm_check", isNull(r.fallback_slack_ts) === isNull(r.fallback_channel_id)
      && isNull(r.fallback_slack_ts) === isNull(r.fallback_delete_after) && (isNull(r.fallback_deleted_at) || !isNull(r.fallback_slack_ts)));
    check("exec_briefs_late_note_check", isNull(r.late_note_ts) || !isNull(r.fallback_sent_at));
    check("exec_briefs_checkins_msg_check", isNull(r.checkins_ts) || !isNull(r.delivered_at) || !isNull(r.late_note_ts));
    check("exec_briefs_expiry_check", ms(r.expires_at) >= ms(r.content_expires_at));
  } else if (table === CK) {
    const status = r.status;
    check("exec_brief_checkins_id_check", matches(r.id, /^ebc_[0-9a-f]{32}$/));
    check("exec_brief_checkins_brief_rev_check", typeof r.brief_rev === "number" && r.brief_rev >= 1 && r.brief_rev <= 10000);
    check("exec_brief_checkins_rev_check", typeof r.rev === "number" && r.rev >= 1 && r.rev <= 1000);
    check("exec_brief_checkins_slack_user_check", matches(r.recipient_slack_id, /^[UW][A-Z0-9]{2,30}$/));
    check("exec_brief_checkins_text_check", len(r.text) >= 1 && len(r.text) <= 600);
    check("exec_brief_checkins_status_check", ["proposed", "sending", "sent", "unknown", "failed", "expired"].includes(String(status)));
    check("exec_brief_checkins_reason_check", optional(r.status_reason, CODE60));
    check("exec_brief_checkins_channel_check", optional(r.slack_channel_id, DM));
    check("exec_brief_checkins_ts_check", optional(r.slack_ts, TS));
    check("exec_brief_checkins_sent_check", (status === "sent") === !isNull(r.sent_at));
    check("exec_brief_checkins_sent_refs_check", status !== "sent" || (!isNull(r.slack_ts) && !isNull(r.slack_channel_id)));
    check("exec_brief_checkins_sending_check", !["sending", "sent", "unknown"].includes(String(status)) || (!isNull(r.sending_at) && !isNull(r.audit_id)));
    check("exec_brief_checkins_window_check", ms(r.expires_at) > ms(r.created_at) && ms(r.purge_at) >= ms(r.expires_at));
  } else if (table === MN) {
    check("exec_brief_mentions_fp_check", len(r.fingerprint) >= 1 && len(r.fingerprint) <= 300);
    check("exec_brief_mentions_state_check", len(r.last_state_hash) >= 1 && len(r.last_state_hash) <= 128);
    check("exec_brief_mentions_band_check", ["critical", "high", "normal"].includes(String(r.last_band)));
  }
  return checks.filter(([, ok]) => !ok).map(([name]) => name).sort();
}

/** The unique keys: name, columns, and a partial index's predicate. */
const UNIQUE: Partial<Record<FakeBriefTable, { name: string; cols: string[]; where?: (r: Row) => boolean }[]>> = {
  [EB]: [{ name: "exec_briefs_pkey", cols: ["id"] }, { name: "exec_briefs_day_key", cols: ["principal_id", "local_date"] }],
  [CK]: [
    { name: "exec_brief_checkins_pkey", cols: ["id"] },
    { name: "exec_brief_checkins_live_key", cols: ["brief_id", "recipient_user_id"], where: (r) => r.status !== "expired" }
  ],
  [MN]: [{ name: "exec_brief_mentions_pkey", cols: ["principal_id", "fingerprint"] }],
  [DB_]: [{ name: "daily_briefings_pkey", cols: ["id"] }],
  [JOBS]: [{ name: "exec_jobs_dedupe_key_key", cols: ["dedupe_key"], where: (r) => !isNull(r.dedupe_key) }]
};

// ---------------------------------------------------------------------------
// The scrub helpers (§2.1.4), mirrored: pure functions over the content JSON
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const textList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);

/** exec_brief_item_hit: jsonb ?| on the three ref lists, or any Slack channel when allSlack. */
export function briefItemHit(item: unknown, threadIds: readonly string[] | null, slackKeys: readonly string[] | null, channels: readonly string[] | null,
  allSlack: boolean | null): boolean {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
  const it = item as Json;
  const any = (list: unknown, wanted: readonly string[] | null) => {
    const l = textList(list);
    return l !== null && (wanted?.length ?? 0) > 0 && l.some((x) => (wanted as readonly string[]).includes(x));
  };
  if (any(it.threadIds, threadIds)) return true;
  if (any(it.slackKeys, slackKeys)) return true;
  if (any(it.slackChannels, channels)) return true;
  return allSlack === true && Array.isArray(it.slackChannels) && it.slackChannels.length > 0;
}

/** exec_brief_scrub_content (intel-14 included). */
export function briefScrubContent(content: unknown, threadIds: readonly string[] | null, slackKeys: readonly string[] | null,
  channels: readonly string[] | null, allSlack: boolean | null, text: string): Json | null {
  if (content === null || content === undefined) return null;
  const c = content as Json;
  const removed: string[] = [];
  let dropped = false;
  const sections: unknown[] = [];
  for (const s of Array.isArray(c.sections) ? (c.sections as Json[]) : []) {
    const items: unknown[] = [];
    for (const it of Array.isArray(s?.items) ? (s.items as Json[]) : []) {
      if (briefItemHit(it, threadIds, slackKeys, channels, allSlack)) {
        removed.push(typeof it.id === "string" ? it.id : String(it.id ?? ""));
        items.push({
          id: it.id ?? null, text, kind: "fact", basis: "basis" in it ? it.basis : "record", band: "band" in it ? it.band : "normal",
          aliases: [], fps: [], refs: [], threadIds: [], slackKeys: [], slackChannels: [], scrubbed: true
        });
      } else {
        items.push(it);
      }
    }
    const pending: unknown[] = [];
    for (const p of Array.isArray(s?.pending) ? (s.pending as Json[]) : []) {
      if (!briefItemHit(p, threadIds, slackKeys, channels, allSlack)) pending.push(p);
      else dropped = true;
    }
    sections.push({ ...s, items, pending });
  }
  const top3: unknown[] = [];
  for (const t of Array.isArray(c.top3) ? (c.top3 as Json[]) : []) {
    if (!briefItemHit(t, threadIds, slackKeys, channels, allSlack) && !(typeof t?.itemId === "string" && removed.includes(t.itemId))) top3.push(t);
    else dropped = true;
  }
  if (removed.length > 0 || dropped || allSlack === true) {
    return { ...c, sections, top3, scrubbed: true, headline: null, headlineScrubbed: true };
  }
  return { ...c, sections, top3, scrubbed: true };
}

/** exec_brief_ref_array: the sorted distinct union of one key's strings over items, pending lines and the top 3. */
export function briefRefArray(content: unknown, key: string): string[] {
  const c = (content ?? {}) as Json;
  const out = new Set<string>();
  const take = (x: unknown) => {
    if (x === null || typeof x !== "object") return;
    const v = (x as Json)[key];
    if (!Array.isArray(v)) return;
    for (const e of v) if (typeof e === "string") out.add(e);
      else if (typeof e === "number" || typeof e === "boolean") out.add(String(e));
  };
  for (const s of Array.isArray(c.sections) ? (c.sections as Json[]) : []) {
    for (const it of Array.isArray(s?.items) ? (s.items as unknown[]) : []) take(it);
    for (const p of Array.isArray(s?.pending) ? (s.pending as unknown[]) : []) take(p);
  }
  for (const t of Array.isArray(c.top3) ? (c.top3 as unknown[]) : []) take(t);
  return [...out].sort();
}

const ARR = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The shared scrub rewrite of RPCs 5 and 6 over a briefs table: the rows hit, rewritten in place; returns how many. */
function scrubRows(rows: Row[], principal: unknown, select: (b: Row) => boolean, scrub: (content: unknown) => Json | null, nowIso: string): number {
  let n = 0;
  for (const b of rows) {
    if (b.principal_id !== principal || isNull(b.content) || !select(b)) continue;
    const c = scrub(b.content);
    b.content = c;
    b.ref_thread_ids = briefRefArray(c, "threadIds");
    b.ref_slack_keys = briefRefArray(c, "slackKeys");
    b.ref_slack_channels = briefRefArray(c, "slackChannels");
    b.scrubbed_at = nowIso;
    b.updated_at = nowIso;
    n += 1;
  }
  return n;
}

/** RPC 5 (exec_brief_scrub_threads), over any table set holding exec_briefs rows (this fake's, or fake-email-db's). */
export function scrubBriefThreadRows(tables: Record<string, Row[] | undefined>, args: Row, now: Date): number {
  const principal = args.p_principal;
  if (isNull(principal)) throw raise("exec_brief_scrub_threads: p_principal is required");
  const ids = ARR(args.p_thread_ids);
  if (isNull(args.p_thread_ids) || ids.length === 0) return 0;
  if (ids.length > 500) throw raise("exec_brief_scrub_threads: at most 500 thread ids per call");
  return scrubRows(tables[EB] ?? [], principal, (b) => ARR(b.ref_thread_ids).some((t) => ids.includes(t)),
    (c) => briefScrubContent(c, ids, [], [], false, "[Removed: restricted sender]"), now.toISOString());
}

// ---------------------------------------------------------------------------
// Filters (SQL semantics)
// ---------------------------------------------------------------------------

function isTimeText(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v) && Number.isFinite(Date.parse(v));
}

/** A PostgREST array literal ("{a,b}", "{}") or a JS array, as a string list. */
function arrayValue(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string" || !/^\{.*\}$/s.test(v)) return null;
  const inner = v.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((x) => x.trim().replace(/^"(.*)"$/s, "$1"));
}

function compare(a: unknown, b: unknown): number | null {
  if (isNull(a) || isNull(b)) return null;
  if (Array.isArray(a)) {
    const bb = arrayValue(b);
    if (bb === null) return null;
    return a.length === bb.length && a.every((x, i) => String(x) === String(bb[i])) ? 0 : 1;
  }
  if (a instanceof Date) a = a.toISOString();
  if (b instanceof Date) b = b.toISOString();
  if (isTimeText(a) && isTimeText(b)) return Date.parse(a) - Date.parse(b);
  if (typeof a === "number" && (typeof b === "number" || (typeof b === "string" && b.trim() !== "" && Number.isFinite(Number(b))))) return a - Number(b);
  if (typeof a === "boolean") return a === (b === true || b === "true") ? 0 : 1;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function test(row: Row, f: FakeBriefFilter): boolean {
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
    case "contains": {
      const v = row[f.column];
      return Array.isArray(v) && f.values.every((x) => v.some((y) => compare(y, x) === 0));
    }
    case "overlaps": {
      const v = row[f.column];
      return Array.isArray(v) && f.values.some((x) => v.some((y) => compare(y, x) === 0));
    }
    default: {
      const c = compare(row[f.column], f.value);
      if (c === null) return false;
      return { eq: c === 0, neq: c !== 0, lt: c < 0, lte: c <= 0, gt: c > 0, gte: c >= 0 }[f.op];
    }
  }
}

function parseNot(column: string, operator: string, value: unknown): FakeBriefFilter {
  if (operator === "is") return { op: "not", column, inner: { op: "is", column, value: value === "null" ? null : value } };
  if (operator === "in") {
    const values = Array.isArray(value) ? value : String(value).replace(/^\(|\)$/g, "").split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
    return { op: "not", column, inner: { op: "in", column, values } };
  }
  if (["eq", "neq", "lt", "lte", "gt", "gte"].includes(operator)) {
    return { op: "not", column, inner: { op: operator as "eq", column, value } };
  }
  throw new Error(`fake brief db: unsupported not() operator ${operator}`);
}

function sortRows(rows: Row[], orders: FakeBriefDbCall["orders"]): Row[] {
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

export function createFakeBriefDb(seed?: FakeBriefDbSeed): FakeBriefDb {
  const cfg = seed ?? {};
  const now = () => (cfg.now ? cfg.now() : new Date());
  const tables = {} as Record<FakeBriefTable, Row[]>;
  let jobSeq = 0;
  let logSeq = 0;
  let usageSeq = 0;
  const seqs = { job: () => ++jobSeq, log: () => ++logSeq, usage: () => ++usageSeq };
  for (const t of FAKE_BRIEF_TABLES) {
    const seeded = (cfg.tables?.[t] ?? []).map((r) => structuredClone(r));
    // The P8 tables and daily_briefings get their DDL defaults under the seeded values (a seed may name only what it needs).
    tables[t] = COLUMNS[t] ? seeded.map((r) => ({ ...defaults(t, now().toISOString(), { job: () => 0, log: () => 0, usage: () => 0 }), ...r })) : seeded;
  }
  jobSeq = tables.exec_jobs.reduce((m, j) => Math.max(m, typeof j.id === "number" ? j.id : 0), 0);
  logSeq = tables.exec_access_log.reduce((m, j) => Math.max(m, typeof j.id === "number" ? j.id : 0), 0);
  usageSeq = tables.exec_ai_usage.reduce((m, j) => Math.max(m, typeof j.id === "number" ? j.id : 0), 0);
  const failQueue: { op: string; code: string; message: string }[] = [];
  let writes = 0;
  const rowsOf = (t: string): Row[] => ((tables as Record<string, Row[]>)[t] ??= []);

  const fdb: FakeBriefDb = {
    client: null,
    tables,
    calls: [],
    missing: new Set(cfg.missing ?? []),
    rpc: (name, args) => settle(request("rpc", name, args)).then((r) => ({ data: r.data, error: r.error })),
    failNext(op, code, message) {
      failQueue.push({ op, code, message: message ?? `fake brief db: forced ${code}` });
    },
    mutations: () => writes
  };

  // --- the table's own refusals ------------------------------------------------

  function refusal(table: string, candidates: Row[], others: Row[], fkColumns: ReadonlySet<string> | "all" = "all"): PgError | null {
    for (const c of candidates) {
      const nn = (NOT_NULL[table as FakeBriefTable] ?? []).find((col) => isNull(c[col]));
      if (nn) return new PgError("23502", `null value in column "${nn}" of relation "${table}" violates not-null constraint`);
      const bad = violatedChecks(table, c);
      if (bad.length > 0) return new PgError("23514", `new row for relation "${table}" violates check constraint "${bad[0]}"`);
    }
    for (const key of UNIQUE[table as FakeBriefTable] ?? []) {
      const all = [...others, ...candidates];
      for (const c of candidates) {
        if (key.where && !key.where(c)) continue;
        if (key.cols.some((col) => isNull(c[col]))) continue;
        const twin = all.find((o) => o !== c && (!key.where || key.where(o)) && key.cols.every((col) => compare(o[col], c[col]) === 0));
        if (twin) return new PgError("23505", `duplicate key value violates unique constraint "${key.name}"`, `Key (${key.cols.join(", ")}) already exists.`);
      }
    }
    if (table === CK && (fkColumns === "all" || fkColumns.has("brief_id"))) {
      for (const c of candidates) {
        if (!rowsOf(EB).some((b) => b.id === c.brief_id)) {
          return new PgError("23503", 'insert or update on table "exec_brief_checkins" violates foreign key constraint "exec_brief_checkins_brief_id_fkey"');
        }
      }
    }
    return null;
  }

  function unknownColumn(table: string, payload: Row): PgError | null {
    const cols = COLUMNS[table as FakeBriefTable];
    for (const k of Object.keys(payload)) {
      if (fdb.missing.has(`${table}.${k}`) || (cols && !cols.includes(k))) {
        return new PgError("PGRST204", `Could not find the '${k}' column of '${table}' in the schema cache`);
      }
    }
    return null;
  }

  function project(row: Row, columns: string, table: string): Row {
    const cols = COLUMNS[table as FakeBriefTable];
    if (columns.trim() === "*") {
      const all = structuredClone(row);
      for (const k of Object.keys(all)) if (fdb.missing.has(`${table}.${k}`)) delete all[k];
      return all;
    }
    const out: Row = {};
    for (const c of columns.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (fdb.missing.has(`${table}.${c}`) || (cols && !cols.includes(c))) throw new PgError("42703", `column ${table}.${c} does not exist`);
      out[c] = c in row ? structuredClone(row[c]) : null;
    }
    return out;
  }

  /** Insert rows (with the DDL defaults) the way the RPCs and the client do: refusals raise. */
  function insertRows(table: string, payloads: Row[], opts: { onConflictDoNothing?: boolean } = {}): Row[] {
    const nowIso = now().toISOString();
    const table$ = rowsOf(table);
    const inserted: Row[] = [];
    for (const p of payloads) {
      const row = { ...defaults(table, nowIso, seqs), ...structuredClone(p) };
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

  function deleteRows(table: string, rows: Row[]): void {
    (tables as Record<string, Row[]>)[table] = rowsOf(table).filter((row) => !rows.includes(row));
    // exec_brief_checkins.brief_id references exec_briefs on delete cascade.
    if (table === EB) {
      const ids = new Set(rows.map((r) => r.id));
      tables[CK] = rowsOf(CK).filter((c) => !ids.has(c.brief_id));
    }
  }

  // --- the ten functions, line for line with §2.1 -------------------------------

  const briefOf = (principal: unknown, date: unknown) => rowsOf(EB).find((b) => b.principal_id === principal && ymd(b.local_date) === ymd(date)) ?? null;

  function claimBuild(a: Row): Row {
    const p = a.p_principal;
    const d = ymd(a.p_local_date);
    const trigger = a.p_trigger;
    if (isNull(p) || isNull(d)) throw raise("exec_brief_claim_build: principal and date are required");
    if (isNull(trigger) || !["schedule", "retry", "regenerate"].includes(String(trigger))) {
      throw raise(`exec_brief_claim_build: bad trigger ${isNull(trigger) ? "<NULL>" : String(trigger)}`);
    }
    const nowIso = now().toISOString();
    const nowMs = ms(nowIso);
    if (trigger !== "regenerate") {
      let v = briefOf(p, d);
      if (!v) {
        [v] = insertRows(EB, [{
          principal_id: p, local_date: d, tz: a.p_tz ?? null, scheduled_at: isoOf(a.p_scheduled_at), status: "building", build_started_at: nowIso,
          content_expires_at: isoOf(a.p_content_expires_at), expires_at: isoOf(a.p_expires_at)
        }]);
        return { outcome: "claimed", id: v.id, rev: v.rev, first: true, fallback_sent: false };
      }
      if (v.status === "building" && isNull(v.build_started_at)) {
        updateRows(EB, [v], { build_started_at: nowIso, tz: a.p_tz ?? null, scheduled_at: isoOf(a.p_scheduled_at), updated_at: nowIso });
        return { outcome: "claimed", id: v.id, rev: v.rev, first: true, fallback_sent: !isNull(v.fallback_sent_at) };
      }
      if (trigger === "retry" && v.status === "failed" && v.status_reason === "pre_model" && isNull(v.built_at)) {
        updateRows(EB, [v], { status: "building", status_reason: null, error_code: null, build_started_at: nowIso, updated_at: nowIso });
        return { outcome: "claimed", id: v.id, rev: v.rev, first: true, fallback_sent: !isNull(v.fallback_sent_at) };
      }
      return { outcome: "exists", id: v.id, rev: v.rev, status: v.status };
    }
    const v = briefOf(p, d);
    if (!v) return { outcome: "not_found" };
    if (isNull(a.p_expected_rev) || Number(v.rev) !== Number(a.p_expected_rev)) return { outcome: "conflict", rev: v.rev };
    if (["building", "delivering"].includes(String(v.status))
        || (v.status === "built" && isNull(v.fallback_sent_at) && ms(v.built_at) > nowMs - 600_000)
        || (!isNull(v.regen_lock_until) && ms(v.regen_lock_until) > nowMs)) {
      return { outcome: "busy", rev: v.rev, status: v.status };
    }
    const asked = isNull(a.p_regen_lock_seconds) ? 300 : Number(a.p_regen_lock_seconds);
    const secs = Math.min(Math.max(asked, 60), 900);
    updateRows(EB, [v], { regen_lock_until: new Date(nowMs + secs * 1000).toISOString(), regen_seq: Number(v.regen_seq) + 1, updated_at: nowIso });
    return {
      outcome: "claimed", id: v.id, rev: v.rev, first: isNull(v.built_at), fallback_sent: !isNull(v.fallback_sent_at), status: v.status,
      regen_seq: v.regen_seq
    };
  }

  function finishBuild(a: Row): Row {
    const status = a.p_status;
    const trigger = a.p_trigger;
    if (isNull(status) || !["built", "page_only"].includes(String(status))) throw raise(`exec_brief_finish_build: bad status ${isNull(status) ? "<NULL>" : String(status)}`);
    if (isNull(trigger) || !["schedule", "retry", "regenerate"].includes(String(trigger))) throw raise("exec_brief_finish_build: bad trigger");
    if (isNull(a.p_expected_rev)) throw raise("exec_brief_finish_build: the expected rev is required");
    const content = a.p_content;
    if (isNull(content) || typeof content !== "object" || Array.isArray(content)) throw raise("exec_brief_finish_build: content must be an object");
    const mentions = a.p_mentions;
    if (!Array.isArray(mentions) || mentions.length > 400) throw raise("exec_brief_finish_build: mentions must be an array of at most 400");
    const v = rowsOf(EB).find((b) => b.id === a.p_id);
    if (!v) return { outcome: "lost" };
    if (Number(v.rev) !== Number(a.p_expected_rev)) return { outcome: "conflict", rev: v.rev, status: v.status };
    let rev: number;
    let newStatus: unknown;
    let reason: unknown;
    let threads = ARR(a.p_thread_ids);
    let keys = ARR(a.p_slack_keys);
    let channels = ARR(a.p_slack_channels);
    let follow = false;
    if (trigger === "regenerate") {
      // P8 fixer correctness-1: the claim's busy rule again at the finish (a retry claimed or finished the row meanwhile).
      if (["building", "delivering"].includes(String(v.status))
          || (v.status === "built" && isNull(v.fallback_sent_at) && ms(v.built_at) > ms(now().toISOString()) - 600_000)) {
        return { outcome: "conflict", rev: v.rev, status: v.status };
      }
      // P8 fixer security-1: a delivered (or delivery_unknown) row keeps the DM's refs: the sorted distinct union; past a CHECK the
      // DM is followed up now (scrubbed_at) on the new refs.
      if (!isNull(v.delivered_at) || v.status === "delivery_unknown") {
        const union = (old: unknown, add: string[]) => [...new Set([...ARR(old), ...add])].sort();
        threads = union(v.ref_thread_ids, threads);
        keys = union(v.ref_slack_keys, keys);
        channels = union(v.ref_slack_channels, channels);
        if (threads.length > 400 || keys.length > 400 || channels.length > 200) {
          threads = ARR(a.p_thread_ids);
          keys = ARR(a.p_slack_keys);
          channels = ARR(a.p_slack_channels);
          follow = true;
        }
      }
      rev = Number(v.rev) + 1;
      newStatus = ["failed", "built"].includes(String(v.status)) ? "page_only" : v.status;
      reason = v.status === "failed" ? "regenerated"
        : v.status === "built" ? (!isNull(v.fallback_sent_at) ? "after_fallback" : "delivery_failed")
          : v.status_reason;
    } else {
      if (v.status !== "building") return { outcome: "conflict", rev: v.rev, status: v.status };
      rev = Number(v.rev);
      newStatus = status;
      reason = a.p_status_reason ?? null;
    }
    const nowIso = now().toISOString();
    const markedBefore = v.novelty_marked_at;
    updateRows(EB, [v], {
      rev, status: newStatus, status_reason: reason, owner: a.p_owner ?? null, owner_reason: a.p_owner_reason ?? null, mode: a.p_mode ?? null,
      mode_reason: a.p_mode_reason ?? null, content: structuredClone(content), content_purged_at: null,
      ref_thread_ids: threads, ref_slack_keys: keys, ref_slack_channels: channels, scrubbed_at: follow ? nowIso : v.scrubbed_at,
      built_at: v.built_at ?? nowIso, regen_lock_until: null, error_code: null, novelty_marked_at: v.novelty_marked_at ?? nowIso, updated_at: nowIso
    });
    let marked = 0;
    if (isNull(markedBefore)) {
      const seen = new Set<string>();
      for (const m of mentions as Row[]) {
        const fp = m?.fp as string;
        if (seen.has(fp)) throw new PgError("21000", "ON CONFLICT DO UPDATE command cannot affect row a second time");
        seen.add(fp);
        const on = ymd(a.p_mentioned_on);
        const existing = rowsOf(MN).find((x) => x.principal_id === v.principal_id && x.fingerprint === fp);
        if (existing) {
          updateRows(MN, [existing], {
            last_state_hash: m.state ?? null, last_band: m.band ?? null,
            last_mentioned_on: on !== null && String(existing.last_mentioned_on) > on ? existing.last_mentioned_on : on, updated_at: nowIso
          });
        } else {
          insertRows(MN, [{ principal_id: v.principal_id, fingerprint: fp ?? null, last_state_hash: m.state ?? null, last_band: m.band ?? null, last_mentioned_on: on }]);
        }
        marked += 1;
      }
    }
    return { outcome: "ok", id: a.p_id, rev, status: newStatus, marked };
  }

  function deliveryStep(a: Row): boolean {
    const to = a.p_to;
    const from = Array.isArray(a.p_from) ? (a.p_from as unknown[]) : null;
    const countPost = a.p_count_post === true;
    if (isNull(to) || !["delivering", "delivered", "delivery_unknown", "page_only"].includes(String(to))) {
      throw raise(`exec_brief_delivery_step: bad target ${isNull(to) ? "<NULL>" : String(to)}`);
    }
    if (!from || from.length === 0 || !from.every((s) => ["built", "page_only", "delivering"].includes(String(s)))) {
      throw raise("exec_brief_delivery_step: bad source");
    }
    if ((to === "delivering") !== countPost) throw raise("exec_brief_delivery_step: a post is counted exactly on the way into delivering");
    if (to === "delivered" && (isNull(a.p_ts) || isNull(a.p_channel))) throw raise("exec_brief_delivery_step: delivered needs the channel and ts");
    const v = rowsOf(EB).find((b) => b.id === a.p_id);
    if (!v) return false;
    const ok = from.includes(v.status)
      && isNull(v.delivered_at)
      && (!countPost || Number(v.post_attempts) < 2)
      && (!["delivered", "delivery_unknown"].includes(String(to)) || v.status === "delivering")
      && (to !== "delivering" || isNull(v.fallback_sent_at))
      && (to !== "delivering" || v.status !== "page_only" || ["not_superseding", "no_installation"].includes(String(v.status_reason)));
    if (!ok) return false;
    const nowIso = now().toISOString();
    updateRows(EB, [v], {
      status: to,
      post_attempts: Number(v.post_attempts) + (countPost ? 1 : 0),
      delivery_started_at: to === "delivering" ? v.delivery_started_at ?? nowIso : v.delivery_started_at,
      delivered_at: to === "delivered" ? nowIso : v.delivered_at,
      slack_channel_id: to === "delivered" ? a.p_channel : v.slack_channel_id,
      slack_ts: to === "delivered" ? a.p_ts : v.slack_ts,
      status_reason: to === "page_only" || to === "delivery_unknown" ? a.p_reason ?? null : null,
      error_code: a.p_error_code ?? v.error_code,
      updated_at: nowIso
    });
    return true;
  }

  function claimFallback(a: Row): Row {
    const p = a.p_principal;
    const d = ymd(a.p_local_date);
    if (isNull(p) || isNull(d)) throw raise("exec_brief_claim_fallback: principal and date are required");
    let v = briefOf(p, d);
    if (!v) {
      [v] = insertRows(EB, [{
        principal_id: p, local_date: d, tz: a.p_tz ?? null, scheduled_at: isoOf(a.p_scheduled_at), status: "building",
        content_expires_at: isoOf(a.p_content_expires_at), expires_at: isoOf(a.p_expires_at)
      }]);
    }
    if (!isNull(v.delivered_at)) return { outcome: "delivered", id: v.id };
    if (["delivering", "delivery_unknown"].includes(String(v.status))) return { outcome: "in_flight", id: v.id, status: v.status };
    if (!isNull(v.fallback_sent_at)) return { outcome: "already", id: v.id };
    const nowIso = now().toISOString();
    updateRows(EB, [v], { fallback_sent_at: nowIso, updated_at: nowIso });
    return { outcome: "claimed", id: v.id, status: v.status };
  }

  function scrubSlack(a: Row): number {
    const p = a.p_principal;
    if (isNull(p)) throw raise("exec_brief_scrub_slack: p_principal is required");
    const keys = ARR(a.p_slack_keys);
    const channels = ARR(a.p_channels);
    const all = a.p_all === true;
    if (keys.length > 500 || channels.length > 500) throw raise("exec_brief_scrub_slack: at most 500 keys and 500 channels per call");
    if (!all && keys.length === 0 && channels.length === 0) return 0;
    return scrubRows(rowsOf(EB), p,
      (b) => ARR(b.ref_slack_keys).some((k) => keys.includes(k)) || ARR(b.ref_slack_channels).some((c) => channels.includes(c))
        || (all && card(b.ref_slack_channels) > 0),
      (c) => briefScrubContent(c, [], keys, channels, all, "[Removed: no longer available in Slack]"), now().toISOString());
  }

  function purgeExpired(a: Row): Row {
    if (isNull(a.p_now) || isNull(a.p_mention_cutoff)) throw raise("exec_brief_purge_expired: now and the mention cutoff are required");
    const lim = Math.min(Math.max(isNull(a.p_limit) ? 1000 : Number(a.p_limit), 1), 5000);
    const nowMs = ms(isoOf(a.p_now));
    const cutoff = ymd(a.p_mention_cutoff) as string;
    const stamp = now().toISOString();
    const byTime = (col: string) => (x: Row, y: Row) => ms(x[col]) - ms(y[col]);
    const c = rowsOf(EB).filter((b) => !isNull(b.content) && ms(b.content_expires_at) < nowMs).sort(byTime("content_expires_at")).slice(0, lim);
    updateRows(EB, c, { content: null, content_purged_at: isoOf(a.p_now), ref_thread_ids: [], ref_slack_keys: [], ref_slack_channels: [], updated_at: stamp });
    // P8 fixer security-2: a still-posted DD-bot mini-brief keeps its row up to 7 more days (the purge's ddBotFallbackDms step).
    const d = rowsOf(EB).filter((b) => ms(b.expires_at) < nowMs
      && (isNull(b.fallback_slack_ts) || !isNull(b.fallback_deleted_at) || ms(b.expires_at) < nowMs - 7 * 86_400_000))
      .sort(byTime("expires_at")).slice(0, lim);
    deleteRows(EB, d);
    const k = rowsOf(CK).filter((x) => ms(x.purge_at) < nowMs).sort(byTime("purge_at")).slice(0, lim);
    deleteRows(CK, k);
    const m = rowsOf(MN).filter((x) => String(ymd(x.last_mentioned_on)) < cutoff).slice(0, lim);
    deleteRows(MN, m);
    return { contentPurged: c.length, briefsDeleted: d.length, checkinsDeleted: k.length, mentionsDeleted: m.length };
  }

  const rpcs: Record<FakeBriefRpc, (args: Row) => unknown> = {
    exec_brief_item_hit: (a) => briefItemHit(a.p_item, isNull(a.p_thread_ids) ? null : ARR(a.p_thread_ids), isNull(a.p_slack_keys) ? null : ARR(a.p_slack_keys),
      isNull(a.p_channels) ? null : ARR(a.p_channels), a.p_all_slack === true),
    exec_brief_scrub_content: (a) => briefScrubContent(a.p_content, ARR(a.p_thread_ids), ARR(a.p_slack_keys), ARR(a.p_channels), a.p_all_slack === true,
      String(a.p_text ?? "")),
    exec_brief_ref_array: (a) => briefRefArray(a.p_content, String(a.p_key ?? "")),
    exec_brief_claim_build: claimBuild,
    exec_brief_finish_build: finishBuild,
    exec_brief_delivery_step: deliveryStep,
    exec_brief_claim_fallback: claimFallback,
    exec_brief_scrub_threads: (a) => scrubBriefThreadRows(tables as Record<string, Row[]>, a, now()),
    exec_brief_scrub_slack: scrubSlack,
    exec_brief_purge_expired: purgeExpired
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
    const saved = [jobSeq, logSeq, usageSeq];
    try {
      return fn();
    } catch (err) {
      for (const t of FAKE_BRIEF_TABLES) tables[t] = snapshot[t];
      [jobSeq, logSeq, usageSeq] = saved;
      throw err;
    }
  }

  function run(r: FakeBriefDbCall): Result {
    const opts = r.options ?? {};
    const wantCount = opts.count === "exact";
    if (r.kind === "rpc") {
      const impl = rpcs[r.target as FakeBriefRpc];
      if (!impl) return { data: null, count: null, error: { code: "PGRST202", message: `Could not find the function public.${r.target} in the schema cache` } };
      if (WRITE_RPCS.has(r.target)) writes += 1;
      return { data: structuredClone(atomically(() => impl((r.payload ?? {}) as Row))), count: null, error: null };
    }
    const table = r.target;
    let affected: Row[];
    let total: number | null = null;
    if (r.kind === "insert" || r.kind === "upsert") {
      writes += 1;
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
        writes += 1;
        const bad = unknownColumn(table, (r.payload ?? {}) as Row);
        if (bad) throw bad;
        atomically(() => updateRows(table, rows, (r.payload ?? {}) as Row));
        affected = rows;
      } else if (r.kind === "delete") {
        writes += 1;
        atomically(() => deleteRows(table, rows));
        affected = rows;
      } else {
        affected = sortRows(rows, r.orders);
        total = affected.length;
        if (r.range) affected = affected.slice(r.range[0], r.range[1] + 1);
        if (r.limit !== null) affected = affected.slice(0, r.limit);
      }
    }
    const count = wantCount ? total ?? affected.length : null;
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

  async function execute(r: FakeBriefDbCall): Promise<Result> {
    fdb.calls.push(r);
    await cfg.before?.(r, fdb);
    if (r.signal?.aborted) return { data: null, count: null, error: { ...ABORTED } };
    if (fdb.missing.has(r.target)) {
      return r.kind === "rpc"
        ? { data: null, count: null, error: { code: "PGRST202", message: `Could not find the function public.${r.target} in the schema cache` } }
        : { data: null, count: null, error: { code: "PGRST205", message: `Could not find the table 'public.${r.target}' in the schema cache` } };
    }
    const forced = failQueue.findIndex((f) => f.op === r.target || f.op === `${r.kind}:${r.target}`);
    if (forced >= 0) {
      const [f] = failQueue.splice(forced, 1);
      return { data: null, count: null, error: { code: f.code, message: f.message } };
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
  function settle(r: FakeBriefDbCall): Promise<Result> {
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

  function builder(r: FakeBriefDbCall) {
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
      contains: (column: string, values: readonly unknown[]) => (r.filters.push({ op: "contains", column, values: [...values] }), b),
      overlaps: (column: string, values: readonly unknown[]) => (r.filters.push({ op: "overlaps", column, values: [...values] }), b),
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

  function request(kind: FakeBriefDbCall["kind"], target: string, payload: unknown = null, options: Record<string, unknown> | null = null): FakeBriefDbCall {
    return { kind, target, columns: null, payload: structuredClone(payload), options, filters: [], orders: [], limit: null, range: null, single: null, signal: null };
  }

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
