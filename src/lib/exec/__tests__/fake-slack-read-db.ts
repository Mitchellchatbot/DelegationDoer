import { randomUUID } from "node:crypto";

import { compareTs, tsToMs } from "@/lib/exec/slack-read-types";
import { createFakeSlackDb, type FakeSlackDb, type FakeSlackDbCall, type FakeSlackDbError, type FakeSlackDbSeed, type FakeSlackFilter, type FakeSlackTable, type Row } from "./fake-slack-db";

// P7a test fake: a standalone in-memory Supabase for slack-read-store.ts and
// the P7a parts of slack-install.ts (P7a contract §5.15; Area A). The
// interface is frozen at stage -1 (lead); Area A wrote the body.
//
//   const db = createFakeSlackReadDb({ tables: { exec_slack_channels: [row] }, slack: { tables: { exec_slack_installations: [inst] } } });
//   vi.mocked(getSupabaseAdmin).mockReturnValue(db.client as SupabaseClient);
//
// What it does (RQ13 keeps it equal to the SQL, 20261109100000_exec_slack_reading.sql):
//   * from(table) builders for the nine P7a tables, exec_attention_items, exec_settings, fb_onboarding,
//     exec_brief_checkins and the three P6 tables P7a extends (exec_slack_installations, exec_slack_events,
//     exec_oauth_states, with their P7a columns and the relaxed / added CHECKs): insert, select, update, upsert,
//     delete().select(), the filters eq, neq, is, in, not, lt, lte, gt, gte, order (nullsFirst too), limit, range,
//     count / head; the P7a DDL defaults, CHECKs (23514 naming the first failing constraint in PostgreSQL's
//     alphabetical order), unique keys (23505) and foreign keys (23503), with ON UPDATE / ON DELETE CASCADE mirrored
//     for the re-key and the purges;
//   * rpc(name, args) for the twenty-five P7a functions, bodies mirrored line for line from the migration: v2's step
//     order (C43: deletes and edits right after the live-reading-half check), the C45 source_class derivation, the C50
//     lock order (recorded in `locks`), exec_slack_purge_author, and v2 delegating every P6 event to P6's v1 in the
//     composed P6 fake (`p6`) in the same "transaction" (a throw rolls back both fakes' writes);
//   * every other P6 table and RPC (exec_chat_feedback, exec_slack_posts, exec_jobs, exec_conversations,
//     exec_messages, exec_drafts, exec_access_log, exec_task_proposals, P6's seven RPCs) delegated to the composed P6
//     fake, so `tables` shares their row arrays with `p6.tables`. While a P6 RPC runs, the installation rows' user
//     half is masked (P6's fake still enforces P6's bot-only CHECKs) and put back after;
//   * missing tables / functions / columns: a table → PGRST205, an RPC → PGRST202, a column named "table.column" in
//     `missing` → 42703 when selected, PGRST204 when written; a missing "fb_onboarding" makes v2's rename branch see
//     42P01 and exec_slack_fb_lead_channels answer 42P01; "exec_brief_checkins" is missing unless seeded;
//   * a RAISE inside an RPC → P0001 with the function's message; an aborted signal → postgrest-js's abort result;
//   * the DM03 race hooks: inside exec_slack_write_items, beforeWriteLock runs before the writer takes its locks and
//     afterWriteLock between taking them and the marker / opt-out / class checks (a delete committed there is seen).
//   * Job rows the P7a functions insert get ids from 1,000,000,001 up (P6's fake numbers its own from 1), so the two
//     never collide in the shared exec_jobs array.
// Rows in `tables` are plain snake_case objects; tests read and mutate them directly. Areas C, D and E consume this
// fake; none edits it.

/** The nine P7a tables (§2.6). */
export type FakeSlackReadP7aTable =
  | "exec_slack_channels" | "exec_slack_threads" | "exec_slack_messages" | "exec_slack_items" | "exec_slack_deleted"
  | "exec_slack_rate" | "exec_slack_dd_bot" | "exec_slack_purge_log" | "exec_slack_author_optouts";

/** Every table the fake holds: the nine P7a tables, the rows the P7a functions touch outside them, and P6's (shared with `p6`). */
export type FakeSlackReadTable =
  | FakeSlackReadP7aTable
  | "exec_attention_items" | "exec_settings"
  | "fb_onboarding"                                                     // v2's rename branch (C23); absent when listed in `missing`
  | "exec_brief_checkins"                                               // C21's check-in exclusion; absent unless seeded / un-missed
  | FakeSlackTable;

/** One request the client received, in order (P6's record shape). */
export type FakeSlackReadDbCall = FakeSlackDbCall;

/** C50: one row lock a mirrored RPC took, in order. key = "<principal>:<channel>" for a channel row, "<principal>:<channel>:<ts>" for a message row. */
export interface FakeSlackReadLock {
  rpc: string;
  table: "exec_slack_channels" | "exec_slack_messages";
  key: string;
  mode: "update" | "share";
}

/** The DM03 race hook's view of the write in progress. */
export interface FakeSlackWriteHookContext { rpc: "exec_slack_write_items"; principalId: string; channelId: string; ts: readonly string[] }

export interface FakeSlackReadDbSeed {
  /** Initial rows per table (copied). P6's tables may be seeded here or through `slack.tables`. */
  tables?: Partial<Record<FakeSlackReadTable, Row[]>>;
  /** The composed P6 fake's own seed (its tables, missing, fail, before, now); `now` defaults to this seed's `now`. */
  slack?: FakeSlackDbSeed;
  /** Tables and RPCs (P7a or P6) that don't exist: a table → 42P01 / PGRST205, an RPC → PGRST202. */
  missing?: readonly string[];
  /** An error for this request, or null / undefined to run it. */
  fail?: (call: FakeSlackReadDbCall) => FakeSlackDbError | null | undefined;
  /** Runs just before a request executes: simulate another writer or a delay here. */
  before?: (call: FakeSlackReadDbCall, db: FakeSlackReadDb) => void | Promise<void>;
  /** The clock now() / the RPCs use (default: the real clock). */
  now?: () => Date;
  /** DM03: inside exec_slack_write_items, before the writer takes its locks. */
  beforeWriteLock?: (ctx: FakeSlackWriteHookContext, db: FakeSlackReadDb) => void | Promise<void>;
  /** DM03: inside exec_slack_write_items, after the locks and before the marker / opt-out / class checks. */
  afterWriteLock?: (ctx: FakeSlackWriteHookContext, db: FakeSlackReadDb) => void | Promise<void>;
}

export interface FakeSlackReadDb {
  /** A Supabase-shaped client (from(table) builders and rpc(name, args)) for vi.mock("@/lib/supabase-admin"). */
  client: unknown;
  /** Every table of FakeSlackReadTable, always present (empty when unseeded); P6's arrays are p6.tables' own. */
  tables: Record<FakeSlackReadTable, Row[]>;
  /** The composed P6 fake: v1 (exec_slack_accept_event) and P6's store calls run there. */
  p6: FakeSlackDb;
  /** Every request, in order (P6's delegated ones included). */
  calls: FakeSlackReadDbCall[];
  /** The tables and RPCs currently missing (mutable; shared with p6.missing). */
  missing: Set<string>;
  /** C50: every row lock the mirrored RPCs took, in order. */
  locks: FakeSlackReadLock[];
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const CH = "exec_slack_channels";
const TH = "exec_slack_threads";
const SM = "exec_slack_messages";
const IT = "exec_slack_items";
const DL = "exec_slack_deleted";
const RT = "exec_slack_rate";
const DB = "exec_slack_dd_bot";
const PL = "exec_slack_purge_log";
const OO = "exec_slack_author_optouts";
const AI = "exec_attention_items";
const ST = "exec_settings";
const FB = "fb_onboarding";
const BC = "exec_brief_checkins";
const SI = "exec_slack_installations";
const SE = "exec_slack_events";
const OS = "exec_oauth_states";
const JOBS = "exec_jobs";

const P6_TABLES: readonly FakeSlackTable[] = [
  "exec_slack_installations", "exec_slack_events", "exec_oauth_states", "exec_chat_feedback", "exec_slack_posts",
  "exec_jobs", "exec_conversations", "exec_messages", "exec_drafts", "exec_access_log", "exec_task_proposals"
];
const OWN_TABLES: readonly FakeSlackReadTable[] = [CH, TH, SM, IT, DL, RT, DB, PL, OO, AI, ST, FB, BC];
/** P6 tables whose from() requests this fake handles itself (they carry P7a columns); every other P6 table goes to `p6`. */
const ENGINE_P6: ReadonlySet<string> = new Set([SI, SE, OS]);
const P6_RPCS: ReadonlySet<string> = new Set([
  "exec_slack_accept_event", "exec_slack_accept_action", "exec_slack_revoke_installation", "exec_slack_purge_installation",
  "exec_slack_conversation_for_thread", "exec_slack_reply_step", "exec_slack_redaction_followups"
]);

const TS = /^[0-9]{1,12}\.[0-9]{1,8}$/;
const USER = /^[UW][A-Z0-9]{2,30}$/;
const CHAN = /^[CGD][A-Z0-9]{2,30}$/;
const DM = /^D[A-Z0-9]{2,30}$/;
const EVENT_ID = /^Ev[A-Za-z0-9]{2,40}$/;
const SEALED = /^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;
/** The FB list's name form (P7a fixer security-8): channelSlug's, as exec_slack_fb_lead_channels returns it. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const slugOf = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const NINE = ["channels:history", "groups:history", "channels:read", "groups:read", "users:read", "im:history", "im:read", "mpim:history", "mpim:read"];
const REQUIRED = ["channels:history", "groups:history", "channels:read", "groups:read", "users:read"];
const DD_PATH = /^\/(?:tasks|clients|projects)\/[A-Za-z0-9_-]{1,100}$|^\/inboxes\/[A-Za-z0-9_-]{1,100}\?(?:[^#\s]*&)?thread=[A-Za-z0-9_.:-]{1,200}(?:&[^#\s]*)?$/;
const PERMALINK = /^https:\/\/[a-z0-9][a-z0-9-]*\.slack\.com\/archives\/[CGD][A-Z0-9]{2,30}\/p[0-9]{10,20}/;
const READING_TYPES = [
  "message", "channel_created", "channel_rename", "channel_archive", "channel_unarchive", "channel_deleted", "channel_left",
  "channel_shared", "channel_unshared", "channel_id_changed", "group_rename", "group_archive", "group_unarchive", "group_deleted",
  "group_left"
];
const JOB_ID_BASE = 1_000_000_000;
const H = 3_600_000;
const DAY = 86_400_000;

const isNull = (v: unknown) => v === null || v === undefined;
const ms = (v: unknown) => (typeof v === "string" ? Date.parse(v) : v instanceof Date ? v.getTime() : Number.NaN);
const hex32 = () => randomUUID().replace(/-/g, "");
const len = (v: unknown) => (typeof v === "string" ? [...v].length : -1);
const matches = (v: unknown, re: RegExp) => typeof v === "string" && re.test(v);
const optional = (v: unknown, re: RegExp) => isNull(v) || matches(v, re);
const truthy = (v: unknown) => v === true;
/** `to_timestamp(ts::numeric)` (to the millisecond: the fake doesn't keep microseconds). */
const tsTime = (ts: string) => new Date(tsToMs(ts)).toISOString();
const tsLt = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && TS.test(a) && TS.test(b) && compareTs(a, b) < 0;

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

/** C46: the SQL exec_slack_dd_paths_ok (and DD_PATH_RE). */
function ddPathsOk(p: unknown): boolean {
  if (!Array.isArray(p) || p.length > 20) return false;
  return p.every((x) => typeof x === "string" && [...x].length <= 400 && DD_PATH.test(x));
}

/** The token half of N1's name rule (exec_slack_lead_name). */
function leadName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  return (
    /(^|[-_.])(vob|nonvob|calendly|failsafe)([-_.]|$)/.test(name) ||
    /(^|[-_.])zap[-_.]errors?([-_.]|$)/.test(name) ||
    /(^|[-_.])fb[-_.]leads?([-_.]|$)/.test(name) ||
    /(^|[-_.])leads?[-_.]fb([-_.]|$)/.test(name)
  );
}

/** exec_slack_finance_name. */
function financeName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  return /(^|[-_.])(finance|financial|payroll|accounting|bookkeeping|invoices?|billing|tax(es)?|hr|people-?ops|legal|contracts?|compliance|salary|salaries)([-_.]|$)/.test(name);
}

/** C45: exec_slack_item_source_class. */
function sourceClass(convType: unknown, cls: unknown, isPrivate: unknown, extEver: unknown, isExtShared: unknown, finance: unknown): string {
  if (cls === "finance" || finance === true) return "finance";
  if (convType === "channel" && cls === "standard" && isPrivate === false && extEver === false && isExtShared === false) return "public";
  return "private";
}

// ---------------------------------------------------------------------------
// Columns, defaults, CHECKs, keys
// ---------------------------------------------------------------------------

const P6_SI_COLS = ["id", "principal_id", "team_id", "app_id", "bot_user_id", "bot_id", "bot_token_enc", "key_id", "bot_scopes", "user_id", "user_token_enc",
  "user_scopes", "slack_dm_channel_id", "installed_at", "updated_at", "revoked_at", "revoke_reason", "last_dm_at", "last_error_code", "last_error_at", "purged_at"];
const P7A_SI_COLS = ["user_key_id", "user_installed_at", "user_revoked_at", "user_revoke_reason", "user_last_error_code", "user_last_error_at", "reading_state",
  "discovered_at", "reading_purged_at"];
const COLUMNS: Partial<Record<string, readonly string[]>> = {
  [SI]: [...P6_SI_COLS, ...P7A_SI_COLS],
  [SE]: ["event_id", "installation_id", "principal_id", "team_id", "api_app_id", "event_type", "decision", "drop_reason", "channel_id", "message_ts",
    "thread_ts", "slack_user_id", "event_time", "retry_num", "job_id", "reply_state", "placeholder_ts", "conversation_id", "assistant_message_id",
    "received_at", "updated_at", "ingest_outcome"],
  [OS]: ["nonce_hash", "provider", "principal_id", "auth_user_id", "session_id", "created_at", "expires_at", "purpose"],
  [CH]: ["principal_id", "installation_id", "channel_id", "conv_type", "class", "deny_reason", "hub_kind", "finance_name", "watch_state", "mute_source",
    "watch_set_by_owner_at", "name", "im_user_id", "is_member", "is_private", "is_ext_shared", "ext_ever", "is_archived", "hist_watermark_ts",
    "deep_swept_at", "swept_at", "last_event_ts", "last_activity_ts", "activity_30d", "probed_at", "classified_at", "seen_at", "left_at", "created_at",
    "updated_at"],
  [TH]: ["principal_id", "channel_id", "thread_ts", "he_posted_ts", "reply_watermark_ts", "latest_reply_seen_ts", "expires_at", "updated_at"],
  [SM]: ["principal_id", "channel_id", "ts", "thread_ts", "role", "author_user_id", "author_external", "is_dd_post", "dd_paths", "reasons", "triage_state",
    "content_hash", "edited_ts", "responded_ts", "responded_at", "acknowledged_at", "assessed_at", "expires_at", "created_at", "updated_at"],
  [IT]: ["id", "principal_id", "channel_id", "ts", "kind", "thread_ts", "author_user_id", "author_label", "author_external", "assessed", "addressed_to_you",
    "needs_response", "bypass_mute", "urgency", "summary", "excerpt", "due_text", "due_at", "commitment_direction", "source_class", "permalink",
    "responded_ts", "responded_at", "acknowledged_at", "expires_at", "created_at", "updated_at"],
  [DL]: ["principal_id", "channel_id", "ts", "reason", "deleted_at", "expires_at"],
  [RT]: ["team_id", "method", "window_start", "n_total", "n_triage", "n_sweep", "n_probe", "n_discovery", "blocked_until", "updated_at"],
  [DB]: ["team_id", "ok", "user_id", "bot_id", "app_id", "error_code", "checked_at"],
  [PL]: ["id", "principal_id", "scope", "channel_id", "ts", "reason", "created_at", "expires_at"],
  [OO]: ["principal_id", "author_user_id", "created_at"]
};

function violatedChecks(table: string, r: Row): string[] {
  const bad: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) bad.push(name);
  };
  const tsOpt = (v: unknown) => optional(v, TS);
  if (table === SI) {
    const scopes = Array.isArray(r.user_scopes) ? (r.user_scopes as unknown[]) : null;
    const live = r.reading_state === "discovering" || r.reading_state === "ready";
    check("exec_slack_installations_active_token_check", !isNull(r.revoked_at) || (!isNull(r.bot_token_enc) && !isNull(r.key_id)));
    check("exec_slack_installations_app_check", matches(r.app_id, /^A[A-Z0-9]{2,30}$/));
    check("exec_slack_installations_bot_id_check", matches(r.bot_id, /^B[A-Z0-9]{2,30}$/));
    check("exec_slack_installations_bot_scopes_check", Array.isArray(r.bot_scopes) && r.bot_scopes.length <= 50);
    check("exec_slack_installations_bot_user_check", matches(r.bot_user_id, USER));
    check("exec_slack_installations_dm_check", matches(r.slack_dm_channel_id, DM));
    check("exec_slack_installations_error_code_check", optional(r.last_error_code, /^[a-z_]{1,60}$/));
    check("exec_slack_installations_error_pair_check", isNull(r.last_error_code) === isNull(r.last_error_at));
    check("exec_slack_installations_key_id_check", optional(r.key_id, /^[0-9a-f]{8}$/));
    check("exec_slack_installations_no_user_scopes", scopes !== null && scopes.length <= 9 && scopes.every((s) => NINE.includes(String(s))));
    check("exec_slack_installations_no_user_token", optional(r.user_token_enc, SEALED));
    check("exec_slack_installations_purged_check", isNull(r.purged_at) || (!isNull(r.revoked_at) && isNull(r.bot_token_enc) && isNull(r.key_id)));
    check("exec_slack_installations_reading_state_check",
      ["none", "discovering", "ready", "revoked"].includes(String(r.reading_state)) && live === !isNull(r.user_token_enc)
        && (isNull(r.discovered_at) || live));
    check("exec_slack_installations_reason_check", isNull(r.revoke_reason) || ["app_uninstalled", "tokens_revoked", "disconnected"].includes(String(r.revoke_reason)));
    check("exec_slack_installations_revoke_pair_check", isNull(r.revoked_at) === isNull(r.revoke_reason));
    check("exec_slack_installations_team_check", matches(r.team_id, /^T[A-Z0-9]{2,30}$/));
    check("exec_slack_installations_token_shape_check", optional(r.bot_token_enc, SEALED));
    check("exec_slack_installations_user_check", matches(r.user_id, USER));
    check("exec_slack_installations_user_error_check",
      isNull(r.user_last_error_code) === isNull(r.user_last_error_at) && optional(r.user_last_error_code, /^[a-z_]{1,60}$/));
    check("exec_slack_installations_user_key_check", optional(r.user_key_id, /^[0-9a-f]{8}$/));
    check("exec_slack_installations_user_live_check",
      isNull(r.user_token_enc) || (!isNull(r.user_installed_at) && isNull(r.user_revoked_at) && scopes !== null && REQUIRED.every((s) => scopes.includes(s))));
    check("exec_slack_installations_user_pair_check", isNull(r.user_token_enc) === isNull(r.user_key_id));
    check("exec_slack_installations_user_revoke_check",
      isNull(r.user_revoked_at) === isNull(r.user_revoke_reason)
        && (isNull(r.user_revoke_reason) || ["stopped", "tokens_revoked", "disconnected", "app_uninstalled", "installation_revoked"].includes(String(r.user_revoke_reason))));
  } else if (table === SE) {
    const reply = r.decision === "reply";
    const reading = r.decision === "ingest" || r.decision === "lifecycle";
    check("exec_slack_events_app_check", len(r.api_app_id) >= 1 && len(r.api_app_id) <= 40);
    check("exec_slack_events_channel_check", optional(r.channel_id, DM));
    check("exec_slack_events_decision_check", ["reply", "home", "revoke", "revoke_check", "drop", "ingest", "lifecycle"].includes(String(r.decision)));
    check("exec_slack_events_drop_check", (r.decision === "drop") === !isNull(r.drop_reason));
    check("exec_slack_events_id_check", matches(r.event_id, EVENT_ID));
    check("exec_slack_events_ingest_check",
      reading === !isNull(r.ingest_outcome) && optional(r.ingest_outcome, /^[a-z_]{1,40}$/)
        && (!reading || (isNull(r.channel_id) && isNull(r.message_ts) && isNull(r.thread_ts) && isNull(r.reply_state))));
    check("exec_slack_events_placeholder_check", tsOpt(r.placeholder_ts));
    check("exec_slack_events_placeholder_state_check", isNull(r.placeholder_ts) || ["placeholder", "answered", "failed", "swept"].includes(String(r.reply_state)));
    check("exec_slack_events_reason_check", optional(r.drop_reason, /^[a-z_]{1,40}$/));
    check("exec_slack_events_reply_refs_check", !reply || (!isNull(r.channel_id) && !isNull(r.message_ts) && !isNull(r.principal_id) && !isNull(r.installation_id)));
    check("exec_slack_events_reply_state_check", reply === !isNull(r.reply_state));
    check("exec_slack_events_retry_check", typeof r.retry_num === "number" && r.retry_num >= 0 && r.retry_num <= 100);
    check("exec_slack_events_state_check", isNull(r.reply_state) || ["queued", "started", "placeholder", "answered", "failed", "skipped", "swept"].includes(String(r.reply_state)));
    check("exec_slack_events_team_check", len(r.team_id) >= 1 && len(r.team_id) <= 40);
    check("exec_slack_events_thread_check", tsOpt(r.thread_ts));
    check("exec_slack_events_ts_check", tsOpt(r.message_ts));
    check("exec_slack_events_type_check", matches(r.event_type, /^[a-z_.]{1,60}$/));
    check("exec_slack_events_user_check", optional(r.slack_user_id, USER));
  } else if (table === OS) {
    check("exec_oauth_states_auth_user_check", len(r.auth_user_id) >= 1 && len(r.auth_user_id) <= 128);
    check("exec_oauth_states_hash_check", matches(r.nonce_hash, /^[0-9a-f]{64}$/));
    check("exec_oauth_states_provider_check", r.provider === "slack");
    check("exec_oauth_states_purpose_check", r.purpose === "install" || r.purpose === "read");
    check("exec_oauth_states_session_check", len(r.session_id) >= 1 && len(r.session_id) <= 128);
    const created = ms(r.created_at);
    const expires = ms(r.expires_at);
    check("exec_oauth_states_ttl_check", expires > created && expires <= created + 600_000);
  } else if (table === CH) {
    const cls = r.class;
    const fin = r.finance_name === true;
    check("exec_slack_channels_activity_check", isNull(r.activity_30d) || (typeof r.activity_30d === "number" && r.activity_30d >= 0 && r.activity_30d <= 100_000));
    check("exec_slack_channels_activity_ts_check", tsOpt(r.last_activity_ts));
    check("exec_slack_channels_class_check", ["unclassified", "deny", "hub", "finance", "external", "standard"].includes(String(cls)));
    check("exec_slack_channels_deny_check", cls !== "deny" || (
      !isNull(r.deny_reason) && isNull(r.name) && isNull(r.im_user_id) && r.watch_state === "unwatched" && isNull(r.mute_source)
      && isNull(r.watch_set_by_owner_at) && r.is_ext_shared !== true && !fin && isNull(r.hist_watermark_ts) && isNull(r.deep_swept_at)
      && isNull(r.swept_at) && isNull(r.last_event_ts) && isNull(r.last_activity_ts) && isNull(r.activity_30d) && isNull(r.probed_at)));
    check("exec_slack_channels_event_ts_check", tsOpt(r.last_event_ts));
    check("exec_slack_channels_ext_ever_check", r.is_ext_shared !== true || r.ext_ever === true);
    check("exec_slack_channels_external_check", !(r.is_ext_shared === true && (cls === "standard" || cls === "finance")));
    check("exec_slack_channels_finance_name_check",
      (cls !== "finance" || fin) && (!fin || ((r.conv_type === "channel" || r.conv_type === "group") && (cls === "finance" || cls === "external"))));
    check("exec_slack_channels_hub_kind_check", isNull(r.hub_kind) || r.hub_kind === "outbound" || r.hub_kind === "client_email");
    check("exec_slack_channels_hub_pair_check", (cls === "hub") === !isNull(r.hub_kind));
    check("exec_slack_channels_id_check", matches(r.channel_id, CHAN));
    check("exec_slack_channels_im_check", isNull(r.im_user_id) || r.conv_type === "im");
    check("exec_slack_channels_im_user_check", optional(r.im_user_id, USER));
    check("exec_slack_channels_mute_pair_check", (r.watch_state === "muted") === !isNull(r.mute_source));
    check("exec_slack_channels_mute_source_check", isNull(r.mute_source) || ["owner", "default_finance", "slack"].includes(String(r.mute_source)));
    check("exec_slack_channels_name_check", optional(r.name, NAME));
    check("exec_slack_channels_private_check", r.conv_type === "channel" || r.is_private === true);
    check("exec_slack_channels_reason_check", isNull(r.deny_reason) || ["assistant_dm", "dd_bot_dm", "self_dm", "bot_im", "fb_list", "lead_name"].includes(String(r.deny_reason)));
    check("exec_slack_channels_reason_pair_check", (cls === "deny") === !isNull(r.deny_reason));
    check("exec_slack_channels_type_check", ["channel", "group", "im", "mpim"].includes(String(r.conv_type)));
    check("exec_slack_channels_unclassified_check", cls !== "unclassified" || (r.watch_state === "unwatched" && isNull(r.name) && !fin));
    check("exec_slack_channels_watch_check", ["watched", "muted", "unwatched"].includes(String(r.watch_state)));
    check("exec_slack_channels_wm_check", tsOpt(r.hist_watermark_ts));
  } else if (table === TH) {
    check("exec_slack_threads_he_check", tsOpt(r.he_posted_ts));
    check("exec_slack_threads_latest_check", tsOpt(r.latest_reply_seen_ts));
    check("exec_slack_threads_ts_check", matches(r.thread_ts, TS));
    check("exec_slack_threads_wm_check", tsOpt(r.reply_watermark_ts));
  } else if (table === SM) {
    const anchor = r.role === "anchor";
    const reasons = typeof r.reasons === "number" ? r.reasons : Number.NaN;
    check("exec_slack_messages_anchor_check", anchor === (r.is_dd_post === true));
    check("exec_slack_messages_anchor_state_check", !anchor || (reasons === 0 && r.triage_state === "none" && isNull(r.responded_ts) && isNull(r.author_user_id)));
    check("exec_slack_messages_author_check", optional(r.author_user_id, USER));
    check("exec_slack_messages_candidate_state_check", anchor || (r.triage_state !== "none" && reasons > 0));
    check("exec_slack_messages_dd_paths_check", ddPathsOk(r.dd_paths));
    check("exec_slack_messages_edited_check", tsOpt(r.edited_ts));
    check("exec_slack_messages_hash_check", optional(r.content_hash, /^[0-9a-f]{64}$/));
    check("exec_slack_messages_reasons_check", Number.isInteger(reasons) && reasons >= 0 && reasons <= 7);
    check("exec_slack_messages_responded_check", tsOpt(r.responded_ts));
    check("exec_slack_messages_responded_pair_check", isNull(r.responded_ts) === isNull(r.responded_at));
    check("exec_slack_messages_role_check", ["candidate", "item", "anchor"].includes(String(r.role)));
    check("exec_slack_messages_state_check", ["pending", "assessed", "unassessed", "refused", "failed", "skipped", "none"].includes(String(r.triage_state)));
    check("exec_slack_messages_thread_check", isNull(r.thread_ts) || (matches(r.thread_ts, TS) && r.thread_ts !== r.ts));
    check("exec_slack_messages_ts_check", matches(r.ts, TS));
  } else if (table === IT) {
    const between = (v: unknown, lo: number, hi: number) => isNull(v) || (len(v) >= lo && len(v) <= hi);
    check("exec_slack_items_author_check", optional(r.author_user_id, USER));
    check("exec_slack_items_class_check", ["public", "private", "finance"].includes(String(r.source_class)));
    check("exec_slack_items_commitment_check", (r.kind === "commitment") === !isNull(r.commitment_direction));
    check("exec_slack_items_direction_check", isNull(r.commitment_direction) || r.commitment_direction === "mitchell_owes" || r.commitment_direction === "owed_to_mitchell");
    check("exec_slack_items_due_check", isNull(r.due_at) || r.kind === "commitment");
    check("exec_slack_items_due_text_check", between(r.due_text, 1, 60));
    check("exec_slack_items_excerpt_check", between(r.excerpt, 1, 280));
    check("exec_slack_items_external_check", r.author_external !== true || isNull(r.excerpt));
    check("exec_slack_items_kind_check", ["request", "question", "decision", "commitment", "action_item", "fyi"].includes(String(r.kind)));
    check("exec_slack_items_label_check", between(r.author_label, 1, 80));
    check("exec_slack_items_permalink_check", isNull(r.permalink) || (len(r.permalink) <= 500 && matches(r.permalink, PERMALINK)));
    check("exec_slack_items_responded_check", tsOpt(r.responded_ts));
    check("exec_slack_items_responded_pair_check", isNull(r.responded_ts) === isNull(r.responded_at));
    check("exec_slack_items_summary_check", between(r.summary, 1, 200));
    check("exec_slack_items_thread_check", tsOpt(r.thread_ts));
    check("exec_slack_items_unassessed_check", r.assessed === true || (r.kind === "request" && isNull(r.summary) && isNull(r.excerpt) && isNull(r.due_text)));
    check("exec_slack_items_urgency_check", ["critical", "high", "normal", "low"].includes(String(r.urgency)));
  } else if (table === DL) {
    check("exec_slack_deleted_channel_check", matches(r.channel_id, CHAN));
    check("exec_slack_deleted_reason_check", r.reason === "event" || r.reason === "absent" || r.reason === "tombstone");
    check("exec_slack_deleted_ts_check", matches(r.ts, TS));
    check("exec_slack_deleted_ttl_check", ms(r.expires_at) >= ms(r.deleted_at) + 25 * H);
  } else if (table === RT) {
    const n = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : Number.NaN);
    check("exec_slack_rate_method_check", ["conversations.history", "conversations.replies", "conversations.info", "users.conversations",
      "conversations.list", "users.list", "users.info", "chat.getPermalink"].includes(String(r.method)));
    check("exec_slack_rate_sum_check", n("n_triage") + n("n_sweep") + n("n_probe") + n("n_discovery") === n("n_total"));
    check("exec_slack_rate_team_check", matches(r.team_id, /^T[A-Z0-9]{2,30}$/));
    check("exec_slack_rate_total_check", n("n_total") >= 0 && n("n_total") <= 1000);
  } else if (table === DB) {
    check("exec_slack_dd_bot_app_check", optional(r.app_id, /^A[A-Z0-9]{2,30}$/));
    check("exec_slack_dd_bot_bot_check", optional(r.bot_id, /^B[A-Z0-9]{2,30}$/));
    check("exec_slack_dd_bot_error_check", optional(r.error_code, /^[a-z_]{1,60}$/));
    check("exec_slack_dd_bot_ok_check", (r.ok === true) === (!isNull(r.user_id) && !isNull(r.bot_id) && isNull(r.error_code)));
    check("exec_slack_dd_bot_team_check", matches(r.team_id, /^T[A-Z0-9]{2,30}$/));
    check("exec_slack_dd_bot_user_check", optional(r.user_id, USER));
  } else if (table === PL) {
    check("exec_slack_purge_log_channel_check", optional(r.channel_id, CHAN));
    check("exec_slack_purge_log_reason_check", matches(r.reason, /^[a-z_]{1,40}$/));
    check("exec_slack_purge_log_scope_check", r.scope === "message" || r.scope === "conversation" || r.scope === "reading");
    check("exec_slack_purge_log_shape_check",
      (r.scope === "message" && !isNull(r.channel_id) && !isNull(r.ts)) || (r.scope === "conversation" && !isNull(r.channel_id) && isNull(r.ts))
        || (r.scope === "reading" && isNull(r.channel_id) && isNull(r.ts)));
    check("exec_slack_purge_log_ts_check", tsOpt(r.ts));
  } else if (table === OO) {
    check("exec_slack_author_optouts_author_check", matches(r.author_user_id, USER));
  } else if (table === ST) {
    if (!isNull(r.slack_daily_cap_usd)) {
      const cap = Number(r.slack_daily_cap_usd);
      check("exec_settings_slack_cap_check", Number.isFinite(cap) && cap >= 0 && cap <= 100);
    }
  }
  return bad.sort();
}

/** NOT NULL columns without a default (23502), for the P7a tables. */
const NOT_NULL: Partial<Record<string, readonly string[]>> = {
  [CH]: ["principal_id", "installation_id", "channel_id", "conv_type"],
  [TH]: ["principal_id", "channel_id", "thread_ts", "expires_at"],
  [SM]: ["principal_id", "channel_id", "ts", "role", "expires_at"],
  [IT]: ["principal_id", "channel_id", "ts", "kind", "assessed", "source_class", "expires_at"],
  [DL]: ["principal_id", "channel_id", "ts", "reason", "expires_at"],
  [RT]: ["team_id", "method", "window_start"],
  [DB]: ["team_id", "ok", "checked_at"],
  [PL]: ["principal_id", "scope", "reason"],
  [OO]: ["principal_id", "author_user_id"]
};

const UNIQUE: Partial<Record<string, { name: string; cols: string[]; where?: (r: Row) => boolean }[]>> = {
  [SI]: [
    { name: "exec_slack_installations_pkey", cols: ["id"] },
    { name: "exec_slack_installations_active_key", cols: ["principal_id"], where: (r) => isNull(r.revoked_at) },
    { name: "exec_slack_installations_dm_key", cols: ["slack_dm_channel_id"], where: (r) => isNull(r.revoked_at) },
    { name: "exec_slack_installations_reading_key", cols: ["team_id", "app_id"], where: (r) => isNull(r.revoked_at) && !isNull(r.user_token_enc) }
  ],
  [SE]: [{ name: "exec_slack_events_pkey", cols: ["event_id"] }],
  [OS]: [{ name: "exec_oauth_states_pkey", cols: ["nonce_hash"] }],
  [CH]: [{ name: "exec_slack_channels_pkey", cols: ["principal_id", "channel_id"] }],
  [TH]: [{ name: "exec_slack_threads_pkey", cols: ["principal_id", "channel_id", "thread_ts"] }],
  [SM]: [{ name: "exec_slack_messages_pkey", cols: ["principal_id", "channel_id", "ts"] }],
  [IT]: [
    { name: "exec_slack_items_pkey", cols: ["id"] },
    { name: "exec_slack_items_key", cols: ["principal_id", "channel_id", "ts", "kind"] }
  ],
  [DL]: [{ name: "exec_slack_deleted_pkey", cols: ["principal_id", "channel_id", "ts"] }],
  [RT]: [{ name: "exec_slack_rate_pkey", cols: ["team_id", "method"] }],
  [DB]: [{ name: "exec_slack_dd_bot_pkey", cols: ["team_id"] }],
  [PL]: [{ name: "exec_slack_purge_log_pkey", cols: ["id"] }],
  [OO]: [{ name: "exec_slack_author_optouts_pkey", cols: ["principal_id", "author_user_id"] }],
  [AI]: [
    { name: "exec_attention_items_pkey", cols: ["id"] },
    { name: "exec_attention_items_fingerprint_key", cols: ["principal_id", "fingerprint"] }
  ],
  [ST]: [{ name: "exec_settings_pkey", cols: ["principal_id"] }],
  [JOBS]: [{ name: "exec_jobs_dedupe_key_key", cols: ["dedupe_key"], where: (r) => !isNull(r.dedupe_key) }]
};

// ---------------------------------------------------------------------------
// Filters (SQL semantics), projection, ordering
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
  throw new Error(`fake slack read db: unsupported not() operator ${operator}`);
}

type Order = { column: string; ascending: boolean; nullsFirst?: boolean };

function sortRows(rows: Row[], orders: readonly Order[]): Row[] {
  return [...rows].sort((a, b) => {
    for (const { column, ascending, nullsFirst } of orders) {
      const x = a[column];
      const y = b[column];
      const nf = nullsFirst ?? !ascending;   // PostgreSQL: NULLS LAST for ASC, NULLS FIRST for DESC
      if (isNull(x) && isNull(y)) continue;
      if (isNull(x)) return nf ? -1 : 1;
      if (isNull(y)) return nf ? 1 : -1;
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
type Call = FakeSlackReadDbCall & { orders: Order[] };

const ABORTED: FakeSlackDbError = { message: "AbortError: This operation was aborted", code: "", details: "" };

export function createFakeSlackReadDb(seed?: FakeSlackReadDbSeed): FakeSlackReadDb {
  const cfg = seed ?? {};
  const now = () => (cfg.now ? cfg.now() : cfg.slack?.now ? cfg.slack.now() : new Date());
  const p6Seed: FakeSlackDbSeed = { ...(cfg.slack ?? {}), now: cfg.slack?.now ?? cfg.now, tables: { ...(cfg.slack?.tables ?? {}) } };
  for (const t of P6_TABLES) {
    const rows = cfg.tables?.[t];
    if (rows) p6Seed.tables = { ...p6Seed.tables, [t]: [...(p6Seed.tables?.[t] ?? []), ...rows] };
  }
  const p6 = createFakeSlackDb(p6Seed);
  for (const m of cfg.missing ?? []) p6.missing.add(m);
  if (!cfg.tables?.[BC]) p6.missing.add(BC);

  const own: Record<string, Row[]> = {};
  for (const t of OWN_TABLES) own[t] = (cfg.tables?.[t] ?? []).map((r) => structuredClone(r));
  const tables = {} as Record<FakeSlackReadTable, Row[]>;
  for (const t of OWN_TABLES) {
    Object.defineProperty(tables, t, { get: () => own[t], set: (v: Row[]) => { own[t] = v; }, enumerable: true });
  }
  for (const t of P6_TABLES) {
    Object.defineProperty(tables, t, {
      get: () => p6.tables[t],
      set: (v: Row[]) => { (p6.tables as Record<string, Row[]>)[t] = v; },
      enumerable: true
    });
  }

  const fdb: FakeSlackReadDb = { client: null, tables, p6, calls: [], missing: p6.missing, locks: [] };
  const rowsOf = (t: string): Row[] => (tables as Record<string, Row[]>)[t] ?? (own[t] ??= []);
  const setRows = (t: string, rows: Row[]) => {
    (tables as Record<string, Row[]>)[t] = rows;
  };
  const exists = (t: string) => !fdb.missing.has(t);

  let logSeq = rowsOf(PL).reduce((m, r) => Math.max(m, typeof r.id === "number" ? r.id : 0), 0);
  let jobSeq = JOB_ID_BASE;
  const nextJobId = () => {
    const max = rowsOf(JOBS).reduce((m, j) => Math.max(m, typeof j.id === "number" ? j.id : 0), 0);
    jobSeq = Math.max(jobSeq, max, JOB_ID_BASE) + 1;
    return jobSeq;
  };

  const lock = (rpc: string, table: FakeSlackReadLock["table"], key: string, mode: FakeSlackReadLock["mode"]) => {
    fdb.locks.push({ rpc, table, key, mode });
  };

  // --- defaults ----------------------------------------------------------------

  function defaults(table: string): Row {
    const nowIso = now().toISOString();
    switch (table) {
      case SI:
        return {
          id: `esi_${hex32()}`, bot_token_enc: null, key_id: null, bot_scopes: [], user_token_enc: null, user_scopes: [], installed_at: nowIso,
          updated_at: nowIso, revoked_at: null, revoke_reason: null, last_dm_at: null, last_error_code: null, last_error_at: null, purged_at: null,
          user_key_id: null, user_installed_at: null, user_revoked_at: null, user_revoke_reason: null, user_last_error_code: null,
          user_last_error_at: null, reading_state: "none", discovered_at: null, reading_purged_at: null
        };
      case SE:
        return {
          installation_id: null, principal_id: null, drop_reason: null, channel_id: null, message_ts: null, thread_ts: null, slack_user_id: null,
          retry_num: 0, job_id: null, reply_state: null, placeholder_ts: null, conversation_id: null, assistant_message_id: null, received_at: nowIso,
          updated_at: nowIso, ingest_outcome: null
        };
      case OS:
        return { created_at: nowIso, purpose: "install" };
      case CH:
        return {
          class: "unclassified", deny_reason: null, hub_kind: null, finance_name: false, watch_state: "unwatched", mute_source: null,
          watch_set_by_owner_at: null, name: null, im_user_id: null, is_member: false, is_private: true, is_ext_shared: false, ext_ever: false,
          is_archived: false, hist_watermark_ts: null, deep_swept_at: null, swept_at: null, last_event_ts: null, last_activity_ts: null,
          activity_30d: null, probed_at: null, classified_at: null, seen_at: null, left_at: null, created_at: nowIso, updated_at: nowIso
        };
      case TH:
        return { he_posted_ts: null, reply_watermark_ts: null, latest_reply_seen_ts: null, updated_at: nowIso };
      case SM:
        return {
          thread_ts: null, author_user_id: null, author_external: false, is_dd_post: false, dd_paths: [], reasons: 0, triage_state: "pending",
          content_hash: null, edited_ts: null, responded_ts: null, responded_at: null, acknowledged_at: null, assessed_at: null, created_at: nowIso,
          updated_at: nowIso
        };
      case IT:
        return {
          id: `esl_${hex32()}`, thread_ts: null, author_user_id: null, author_label: null, author_external: false, addressed_to_you: false,
          needs_response: false, bypass_mute: false, urgency: "normal", summary: null, excerpt: null, due_text: null, due_at: null,
          commitment_direction: null, permalink: null, responded_ts: null, responded_at: null, acknowledged_at: null, created_at: nowIso, updated_at: nowIso
        };
      case DL:
        return { deleted_at: nowIso };
      case RT:
        return { n_total: 0, n_triage: 0, n_sweep: 0, n_probe: 0, n_discovery: 0, blocked_until: null, updated_at: nowIso };
      case DB:
        return { user_id: null, bot_id: null, app_id: null, error_code: null };
      case PL:
        return { id: ++logSeq, channel_id: null, ts: null, created_at: nowIso, expires_at: new Date(now().getTime() + 7 * DAY).toISOString() };
      case OO:
        return { created_at: nowIso };
      case AI:
        return { id: `ea_${hex32()}`, status: "open", first_seen_at: nowIso, last_seen_at: nowIso, created_at: nowIso, updated_at: nowIso };
      case ST:
        return { updated_at: nowIso };
      case JOBS:
        return {
          id: nextJobId(), principal_id: null, payload: {}, dedupe_key: null, status: "queued", attempts: 0, max_attempts: 6, run_after: nowIso,
          locked_by: null, locked_until: null, heartbeat_at: null, last_error: null, result: null, created_at: nowIso, started_at: null, finished_at: null
        };
      default:
        return {};
    }
  }

  // --- the table's own refusals -------------------------------------------------

  function fkRefusal(table: string, c: Row, fk: (col: string) => boolean): PgError | null {
    const fail = (name: string) => new PgError("23503", `insert or update on table "${table}" violates foreign key constraint "${name}"`);
    if (table === CH && fk("installation_id") && !rowsOf(SI).some((i) => i.id === c.installation_id)) return fail("exec_slack_channels_installation_id_fkey");
    if ((table === TH || table === SM) && (fk("principal_id") || fk("channel_id"))
        && !rowsOf(CH).some((ch) => ch.principal_id === c.principal_id && ch.channel_id === c.channel_id)) {
      return fail(table === TH ? "exec_slack_threads_channel_fkey" : "exec_slack_messages_channel_fkey");
    }
    if (table === IT && (fk("principal_id") || fk("channel_id") || fk("ts"))
        && !rowsOf(SM).some((m) => m.principal_id === c.principal_id && m.channel_id === c.channel_id && m.ts === c.ts)) {
      return fail("exec_slack_items_message_fkey");
    }
    return null;
  }

  function refusal(table: string, candidates: Row[], others: Row[], fkColumns: ReadonlySet<string> | "all" = "all"): PgError | null {
    const fk = (col: string) => fkColumns === "all" || fkColumns.has(col);
    for (const c of candidates) {
      const col = (NOT_NULL[table] ?? []).find((k) => isNull(c[k]));
      if (col) return new PgError("23502", `null value in column "${col}" of relation "${table}" violates not-null constraint`);
    }
    for (const c of candidates) {
      const bad = violatedChecks(table, c);
      if (bad.length > 0) return new PgError("23514", `new row for relation "${table}" violates check constraint "${bad[0]}"`);
    }
    for (const key of UNIQUE[table] ?? []) {
      const all = [...others, ...candidates];
      for (const c of candidates) {
        if (key.where && !key.where(c)) continue;
        if (key.cols.some((col) => isNull(c[col]))) continue;
        const twin = all.find((o) => o !== c && (!key.where || key.where(o)) && key.cols.every((col) => compare(o[col], c[col]) === 0));
        if (twin) return new PgError("23505", `duplicate key value violates unique constraint "${key.name}"`, `Key (${key.cols.join(", ")}) already exists.`);
      }
    }
    for (const c of candidates) {
      const err = fkRefusal(table, c, fk);
      if (err) return err;
    }
    return null;
  }

  function unknownColumn(table: string, payload: Row): PgError | null {
    const cols = COLUMNS[table];
    for (const k of Object.keys(payload)) {
      if (fdb.missing.has(`${table}.${k}`) || (cols && !cols.includes(k))) {
        return new PgError("PGRST204", `Could not find the '${k}' column of '${table}' in the schema cache`);
      }
    }
    return null;
  }

  function checkSelected(table: string, columns: string | null): void {
    if (columns === null || columns.trim() === "*") return;
    const cols = COLUMNS[table];
    for (const c of columns.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (fdb.missing.has(`${table}.${c}`) || (cols && !cols.includes(c))) throw new PgError("42703", `column ${table}.${c} does not exist`);
    }
  }

  function project(row: Row, columns: string): Row {
    if (columns.trim() === "*") return structuredClone(row);
    const out: Row = {};
    for (const c of columns.split(",").map((s) => s.trim()).filter(Boolean)) out[c] = structuredClone(row[c] ?? null);
    return out;
  }

  /** Insert rows with the DDL defaults: refusals raise (a unique violation is skipped with onConflictDoNothing). */
  function insertRows(table: string, payloads: Row[], opts: { onConflictDoNothing?: boolean } = {}): Row[] {
    const table$ = rowsOf(table);
    const inserted: Row[] = [];
    for (const p of payloads) {
      const row = { ...defaults(table), ...structuredClone(p) };
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

  /** Delete rows, with the ON DELETE CASCADEs of the P7a tables. */
  function deleteRows(table: string, doomed: Row[]): void {
    if (doomed.length === 0) return;
    const gone = new Set(doomed);
    setRows(table, rowsOf(table).filter((r) => !gone.has(r)));
    if (table === CH) {
      const key = new Set(doomed.map((c) => `${String(c.principal_id)}|${String(c.channel_id)}`));
      deleteRows(TH, rowsOf(TH).filter((t) => key.has(`${String(t.principal_id)}|${String(t.channel_id)}`)));
      deleteRows(SM, rowsOf(SM).filter((m) => key.has(`${String(m.principal_id)}|${String(m.channel_id)}`)));
    } else if (table === SM) {
      const key = new Set(doomed.map((m) => `${String(m.principal_id)}|${String(m.channel_id)}|${String(m.ts)}`));
      deleteRows(IT, rowsOf(IT).filter((i) => key.has(`${String(i.principal_id)}|${String(i.channel_id)}|${String(i.ts)}`)));
    }
  }

  function updateRows(table: string, rows: Row[], patch: Row): void {
    if (rows.length === 0) return;
    const table$ = rowsOf(table);
    const next = rows.map((r) => Object.assign(structuredClone(r), structuredClone(patch)));
    const err = refusal(table, next, table$.filter((r) => !rows.includes(r)), new Set(Object.keys(patch)));
    if (err) throw err;
    const moves: { from: Row; to: Row }[] = [];
    rows.forEach((r, i) => {
      if (table === CH && (r.channel_id !== next[i].channel_id || r.principal_id !== next[i].principal_id)) moves.push({ from: structuredClone(r), to: next[i] });
      Object.assign(r, next[i]);
    });
    // ON UPDATE CASCADE: a re-keyed channel moves its threads and messages, and the messages their items.
    for (const { from, to } of moves) {
      for (const t of rowsOf(TH)) if (t.principal_id === from.principal_id && t.channel_id === from.channel_id) Object.assign(t, { principal_id: to.principal_id, channel_id: to.channel_id });
      for (const m of rowsOf(SM)) if (m.principal_id === from.principal_id && m.channel_id === from.channel_id) Object.assign(m, { principal_id: to.principal_id, channel_id: to.channel_id });
      for (const it of rowsOf(IT)) if (it.principal_id === from.principal_id && it.channel_id === from.channel_id) Object.assign(it, { principal_id: to.principal_id, channel_id: to.channel_id });
    }
  }

  function insertJob(job: Row): number | null {
    const [row] = insertRows(JOBS, [job], { onConflictDoNothing: true });
    return row ? Number(row.id) : null;
  }

  // --- small helpers the mirrored functions share --------------------------------

  const channelRow = (p: unknown, c: unknown) => rowsOf(CH).find((r) => r.principal_id === p && r.channel_id === c);
  const messageRow = (p: unknown, c: unknown, ts: unknown) => rowsOf(SM).find((r) => r.principal_id === p && r.channel_id === c && r.ts === ts);
  const marked = (p: unknown, c: unknown, ts: unknown) => rowsOf(DL).some((d) => d.principal_id === p && d.channel_id === c && d.ts === ts);
  const optedOut = (p: unknown, a: unknown) => !isNull(a) && rowsOf(OO).some((o) => o.principal_id === p && o.author_user_id === a);
  const retentionDays = (p: unknown) => {
    const s = rowsOf(ST).find((r) => r.principal_id === p);
    const d = s?.retention_days_slack;
    return typeof d === "number" && Number.isFinite(d) ? d : 90;
  };
  const readingOn = (p: unknown) => rowsOf(ST).find((r) => r.principal_id === p)?.slack_reading_enabled === true;
  const minuteNow = () => Math.floor(now().getTime() / 60_000);

  function kickAttention(p: unknown): void {
    const m = minuteNow() + 1;
    insertJob({
      kind: "exec.slack-attention", lane: "bulk", principal_id: p, payload: { kick: true }, dedupe_key: `slack-attn:${String(p)}:m${m}`, max_attempts: 3,
      run_after: new Date(m * 60_000 + 2_000).toISOString()
    });
  }

  function purgeLog(p: unknown, scope: string, channel: unknown, ts: unknown, reason: string): void {
    insertRows(PL, [{ principal_id: p, scope, channel_id: channel ?? null, ts: ts ?? null, reason }]);
  }

  /** Delete the attention rows matching `pred` (source slack) of principal p; returns how many. */
  function deleteAttention(pred: (a: Row) => boolean): number {
    const doomed = rowsOf(AI).filter((a) => a.source === "slack" && pred(a));
    deleteRows(AI, doomed);
    return doomed.length;
  }

  function reconcileItems(p: unknown, channel: unknown): number {
    const c = channelRow(p, channel);
    if (!c) return 0;
    const want = sourceClass(c.conv_type, c.class, c.is_private, c.ext_ever, c.is_ext_shared, c.finance_name);
    const rows = rowsOf(IT).filter((i) => i.principal_id === p && i.channel_id === channel && i.source_class !== want);
    updateRows(IT, rows, { source_class: want, updated_at: now().toISOString() });
    return rows.length;
  }

  // --- the twenty-five P7a functions, line for line with the migration -------------

  function ingestCheck(p: unknown): void {
    if (p === null || typeof p !== "object" || Array.isArray(p)) throw raise("exec_slack_ingest_check: not an object");
    const o = p as Row;
    if (isNull(o.kind)) throw raise("exec_slack_ingest_check: kind required");
    const str = (v: unknown, what: string, ok: (s: string) => boolean) => {
      if (typeof v !== "string" || !ok(v)) throw raise(`exec_slack_ingest_check: ${what}`);
    };
    for (const [k, v] of Object.entries(o)) {
      if (v === null || v === undefined) continue;
      switch (k) {
        case "kind": str(v, "kind", (s) => ["msg", "edit", "delete", "lifecycle"].includes(s)); break;
        case "conv": str(v, "conv", (s) => ["channel", "group", "im", "mpim"].includes(s)); break;
        case "lc": str(v, "lc", (s) => ["created", "rename", "archive", "unarchive", "deleted", "left", "shared", "unshared", "id_changed"].includes(s)); break;
        case "ts": case "thread_ts": case "edited_ts": case "deleted_ts": str(v, "ts", (s) => TS.test(s)); break;
        case "author": case "parent_user": case "auth_user": str(v, "user", (s) => USER.test(s)); break;
        case "author_team": str(v, "team", (s) => /^[TE][A-Z0-9]{2,30}$/.test(s)); break;
        case "app_id": str(v, "app", (s) => /^A[A-Z0-9]{2,30}$/.test(s)); break;
        case "new_channel": str(v, "channel", (s) => CHAN.test(s)); break;
        case "name": str(v, "name", (s) => NAME.test(s)); break;
        case "is_bot": case "dd_template": case "broadcast": case "question": case "files": case "ext_shared": case "auth_is_bot": case "is_ext_shared":
          if (typeof v !== "boolean") throw raise("exec_slack_ingest_check: flag");
          break;
        case "len":
          if (typeof v !== "number" || !/^[0-3]$/.test(String(v))) throw raise("exec_slack_ingest_check: len");
          break;
        case "hints":
          if (typeof v !== "number" || !/^[0-7]$/.test(String(v))) throw raise("exec_slack_ingest_check: hints");
          break;
        case "mentions":
          if (!Array.isArray(v) || v.length > 20) throw raise("exec_slack_ingest_check: mentions");
          for (const e of v) if (typeof e !== "string" || !USER.test(e)) throw raise("exec_slack_ingest_check: mention");
          break;
        case "dd_paths":
          if (!Array.isArray(v) || v.length > 20) throw raise("exec_slack_ingest_check: dd_paths");
          for (const e of v) if (typeof e !== "string") throw raise("exec_slack_ingest_check: dd_path");
          if (!ddPathsOk(v)) throw raise("exec_slack_ingest_check: dd_path");
          break;
        default:
          throw raise("exec_slack_ingest_check: unknown key");
      }
    }
  }

  function recordEvent(a: { id: unknown; inst: Row; team: unknown; app: unknown; type: unknown; decision: string; outcome: string; time: string; retry: number; his: unknown }): boolean {
    const exists$ = rowsOf(SE).some((e) => e.event_id === a.id);
    if (exists$) return false;
    insertRows(SE, [{
      event_id: a.id, installation_id: a.inst.id, principal_id: a.inst.principal_id, team_id: String(a.team).slice(0, 40), api_app_id: String(a.app).slice(0, 40),
      event_type: matches(a.type, /^[a-z_.]{1,60}$/) ? a.type : "unknown", decision: a.decision, ingest_outcome: a.outcome, event_time: a.time,
      retry_num: Math.min(Math.max(a.retry, 0), 100), slack_user_id: a.his ?? null
    }]);
    return true;
  }

  function purgeConversation(p: unknown, channel: unknown, reason: unknown, rpc = "exec_slack_purge_conversation"): Row {
    if (isNull(reason) || !["left", "lost_access", "deleted", "deny", "gone", "reinstall", "rekey", "author_optout"].includes(String(reason))) {
      throw raise("exec_slack_purge_conversation: bad reason");
    }
    if (!matches(channel, CHAN)) throw raise("exec_slack_purge_conversation: bad channel");
    const leave = reason === "left" || reason === "lost_access";
    if (channelRow(p, channel)) lock(rpc, CH, `${String(p)}:${String(channel)}`, "update");
    const items = rowsOf(IT).filter((i) => i.principal_id === p && i.channel_id === channel);
    deleteRows(IT, items);
    const msgs = rowsOf(SM).filter((m) => m.principal_id === p && m.channel_id === channel);
    deleteRows(SM, msgs);
    const threads = rowsOf(TH).filter((t) => t.principal_id === p && t.channel_id === channel);
    deleteRows(TH, threads);
    const attn = deleteAttention((x) => x.principal_id === p && String(x.fingerprint).startsWith(`slack:msg:${String(channel)}:`));
    const c = channelRow(p, channel);
    if (c) {
      updateRows(CH, [c], {
        hist_watermark_ts: null, deep_swept_at: null, swept_at: null, last_event_ts: null, last_activity_ts: null, activity_30d: null, probed_at: null,
        left_at: leave ? now().toISOString() : c.left_at, is_member: leave ? false : c.is_member,
        watch_state: leave && c.class !== "deny" ? "unwatched" : c.watch_state, mute_source: leave ? null : c.mute_source,
        watch_set_by_owner_at: leave ? null : c.watch_set_by_owner_at, updated_at: now().toISOString()
      });
    }
    purgeLog(p, "conversation", channel, null, String(reason));
    if (attn > 0) kickAttention(p);
    return { items: items.length, messages: msgs.length, threads: threads.length, attention: attn };
  }

  function markDeleted(p: unknown, channel: unknown, tsList: unknown, reason: unknown): Row {
    if (isNull(reason) || !["event", "absent", "tombstone"].includes(String(reason))) throw raise("exec_slack_mark_deleted: bad reason");
    if (!matches(channel, CHAN)) throw raise("exec_slack_mark_deleted: bad channel");
    if (!Array.isArray(tsList) || tsList.length > 500) throw raise("exec_slack_mark_deleted: 1..500 ts values");
    const chRow = channelRow(p, channel);
    if (chRow) lock("exec_slack_mark_deleted", CH, `${String(p)}:${String(channel)}`, "share");
    if (chRow && chRow.class === "deny") return { items: 0, messages: 0, attention: 0 };
    let items = 0;
    let msgs = 0;
    let attn = 0;
    for (const ts of tsList) {
      if (!matches(ts, TS)) throw raise("exec_slack_mark_deleted: bad ts");
      const nowD = now();
      const marker = rowsOf(DL).find((d) => d.principal_id === p && d.channel_id === channel && d.ts === ts);
      if (marker) {
        updateRows(DL, [marker], {
          deleted_at: nowD.toISOString(),
          expires_at: new Date(Math.max(ms(marker.expires_at), nowD.getTime() + 26 * H)).toISOString()
        });
      } else {
        insertRows(DL, [{ principal_id: p, channel_id: channel, ts, reason, deleted_at: nowD.toISOString(), expires_at: new Date(nowD.getTime() + 26 * H).toISOString() }]);
      }
      if (messageRow(p, channel, ts)) lock("exec_slack_mark_deleted", SM, `${String(p)}:${String(channel)}:${ts}`, "update");
      const it = rowsOf(IT).filter((i) => i.principal_id === p && i.channel_id === channel && i.ts === ts);
      deleteRows(IT, it);
      items += it.length;
      const m = rowsOf(SM).filter((r) => r.principal_id === p && r.channel_id === channel && r.ts === ts);
      deleteRows(SM, m);
      msgs += m.length;
      attn += deleteAttention((x) => x.principal_id === p && x.fingerprint === `slack:msg:${String(channel)}:${ts}`);
      purgeLog(p, "message", channel, ts, `deleted_${String(reason)}`);
    }
    if (items + attn > 0) kickAttention(p);
    return { items, messages: msgs, attention: attn };
  }

  function noteMessages(p: unknown, channel: unknown, rows: unknown, lane: unknown, bucket: unknown): Row {
    if ((lane !== "interactive" && lane !== "bulk") || !matches(bucket, /^[mb][0-9]{1,12}$/)) throw raise("exec_slack_note_messages: bad lane or bucket");
    if (!Array.isArray(rows) || rows.length > 500) throw raise("exec_slack_note_messages: rows");
    const ch = channelRow(p, channel);
    if (ch) lock("exec_slack_note_messages", CH, `${String(p)}:${String(channel)}`, "share");
    if (!ch || ch.class === "deny" || ch.class === "unclassified") {
      return { candidates: 0, anchors: 0, blocked: 0, opted_out: 0, jobs: 0, refused: "class" };
    }
    const days = retentionDays(p);
    const roots: string[] = [];
    let candidates = 0;
    let anchors = 0;
    let blocked = 0;
    let optout = 0;
    for (const r of rows as Row[]) {
      const ts = r.ts;
      if (!matches(ts, TS) || (!isNull(r.thread_ts) && !matches(r.thread_ts, TS)) || (r.role !== "candidate" && r.role !== "anchor")
          || (!isNull(r.author) && !matches(r.author, USER)) || (r.dd_paths !== undefined && r.dd_paths !== null && !Array.isArray(r.dd_paths))) {
        throw raise("exec_slack_note_messages: bad row");
      }
      const tsS = ts as string;
      const thread = r.thread_ts === tsS ? null : ((r.thread_ts as string | null | undefined) ?? null);
      const paths = Array.isArray(r.dd_paths) ? (r.dd_paths as unknown[]).map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : [];
      if (marked(p, channel, tsS)) {
        blocked += 1;
        continue;
      }
      const expires = new Date(tsToMs(tsS) + days * DAY).toISOString();
      if (r.role === "anchor") {
        const existing = messageRow(p, channel, tsS);
        if (!existing) {
          insertRows(SM, [{ principal_id: p, channel_id: channel, ts: tsS, thread_ts: thread, role: "anchor", is_dd_post: true, triage_state: "none", reasons: 0, dd_paths: paths, expires_at: expires }]);
        } else if (existing.role === "anchor" && paths.length > 0 && JSON.stringify(existing.dd_paths) !== JSON.stringify(paths)) {
          updateRows(SM, [existing], { dd_paths: paths, updated_at: now().toISOString() });
        }
        anchors += 1;
        continue;
      }
      if (ch.class === "hub" || ch.watch_state === "unwatched") continue;
      const reasons = typeof r.reasons === "number" ? r.reasons : Number(r.reasons ?? 0);
      if (!Number.isInteger(reasons) || reasons < 1 || reasons > 7) throw raise("exec_slack_note_messages: bad reasons");
      if (ch.watch_state === "muted" && (ch.mute_source === "default_finance" || ch.class === "finance" || ch.finance_name === true || (reasons & 3) === 0)) continue;
      if (optedOut(p, r.author)) {
        optout += 1;
        continue;
      }
      let state: unknown = null;
      const existing = messageRow(p, channel, tsS);
      if (!existing) {
        const [row] = insertRows(SM, [{
          principal_id: p, channel_id: channel, ts: tsS, thread_ts: thread, role: "candidate", author_user_id: r.author ?? null,
          author_external: r.author_external === true, is_dd_post: false, reasons, triage_state: "pending", dd_paths: paths, expires_at: expires
        }]);
        state = row.triage_state;
      } else if (existing.role !== "anchor") {
        updateRows(SM, [existing], {
          reasons: (Number(existing.reasons) | reasons),
          author_external: existing.author_external === true || r.author_external === true,
          dd_paths: paths.length > 0 ? paths : existing.dd_paths,
          updated_at: now().toISOString()
        });
        state = existing.triage_state;
      }
      if (state === "pending") {
        const root = thread ?? (ch.conv_type === "im" || ch.conv_type === "mpim" ? "c" : tsS);
        if (!roots.includes(root)) roots.push(root);
        candidates += 1;
      }
    }
    let jobs = 0;
    for (const root of roots) {
      const runAfter = lane === "interactive" ? new Date((minuteNow() + 1) * 60_000 + 5_000).toISOString() : now().toISOString();
      const id = insertJob({
        kind: "exec.slack-triage", lane, principal_id: p,
        payload: { installation_id: ch.installation_id, channel, root, mode: "window" },
        dedupe_key: `slack-triage:${String(p)}:${String(channel)}:${root}:${String(bucket)}`, max_attempts: 6, run_after: runAfter
      });
      if (id !== null) jobs += 1;
    }
    return { candidates, anchors, blocked, opted_out: optout, jobs };
  }

  function noteFromHim(p: unknown, channel: unknown, rows: unknown): Row {
    if (!Array.isArray(rows) || rows.length > 500) throw raise("exec_slack_note_from_him: rows");
    const ch = channelRow(p, channel);
    if (ch) lock("exec_slack_note_from_him", CH, `${String(p)}:${String(channel)}`, "share");
    const conv = ch && !["deny", "unclassified", "hub"].includes(String(ch.class)) ? String(ch.conv_type) : null;
    if (conv === null) return { stamped: 0, skipped: rows.length };
    const checks = exists(BC);
    let stamped = 0;
    let skipped = 0;
    for (const r of rows as Row[]) {
      const ts = r.ts;
      if (!matches(ts, TS) || (!isNull(r.thread_ts) && !matches(r.thread_ts, TS))) throw raise("exec_slack_note_from_him: bad ts");
      const tsS = ts as string;
      const thread = r.thread_ts === tsS ? null : ((r.thread_ts as string | null | undefined) ?? null);
      if (checks && rowsOf(BC).some((c) => c.principal_id === p && c.slack_ts === tsS)) {
        skipped += 1;
        continue;
      }
      const mentions = Array.isArray(r.mentions) ? (r.mentions as unknown[]) : [];
      if (mentions.some((m) => !matches(m, USER)) || mentions.length > 20) throw raise("exec_slack_note_from_him: bad mentions");
      if (conv === "channel" || conv === "group") {
        const root = thread ?? tsS;
        const expires = new Date(tsToMs(tsS) + 14 * DAY).toISOString();
        const t = rowsOf(TH).find((x) => x.principal_id === p && x.channel_id === channel && x.thread_ts === root);
        if (!t) insertRows(TH, [{ principal_id: p, channel_id: channel, thread_ts: root, he_posted_ts: tsS, expires_at: expires }]);
        else {
          updateRows(TH, [t], {
            he_posted_ts: isNull(t.he_posted_ts) || tsLt(t.he_posted_ts, tsS) ? tsS : t.he_posted_ts,
            expires_at: new Date(Math.max(ms(t.expires_at), ms(expires))).toISOString(),
            updated_at: now().toISOString()
          });
        }
      }
      const answers = (m: Row) =>
        tsLt(m.ts, tsS) &&
        (conv === "im" ||
          (thread !== null && (m.thread_ts ?? m.ts) === thread) ||
          (thread === null && isNull(m.thread_ts) && conv === "mpim") ||
          (thread === null && isNull(m.thread_ts) && (conv === "channel" || conv === "group") && mentions.includes(m.author_user_id)));
      const nowIso = now().toISOString();
      const msgs = rowsOf(SM).filter((m) => m.principal_id === p && m.channel_id === channel && m.role !== "anchor" && isNull(m.responded_ts) && answers(m));
      updateRows(SM, msgs, { responded_ts: tsS, responded_at: nowIso, updated_at: nowIso });
      stamped += msgs.length;
      const items = rowsOf(IT).filter((i) => i.principal_id === p && i.channel_id === channel && isNull(i.responded_ts) && answers(i));
      updateRows(IT, items, { responded_ts: tsS, responded_at: nowIso, updated_at: nowIso });
    }
    if (stamped > 0) kickAttention(p);
    return { stamped, skipped };
  }

  /** 7b (P7a fixer security-2): the thread watermark under the channel row's lock, never in a deny conversation. */
  function saveThreadWatermark(a: Row): boolean {
    const p = a.p_principal;
    const channel = a.p_channel;
    if (!matches(channel, CHAN)) throw raise("exec_slack_save_thread_watermark: bad channel");
    if (!matches(a.p_thread_ts, TS) || !matches(a.p_watermark, TS) || !matches(a.p_latest, TS)) throw raise("exec_slack_save_thread_watermark: bad ts");
    const ch = channelRow(p, channel);
    if (ch) lock("exec_slack_save_thread_watermark", CH, `${String(p)}:${String(channel)}`, "share");
    if (!ch || !["standard", "external", "finance", "hub"].includes(String(ch.class))) return false;
    const thread = String(a.p_thread_ts);
    const mark = String(a.p_watermark);
    const latest = String(a.p_latest);
    const t = rowsOf(TH).find((x) => x.principal_id === p && x.channel_id === channel && x.thread_ts === thread);
    if (!t) {
      insertRows(TH, [{ principal_id: p, channel_id: channel, thread_ts: thread, reply_watermark_ts: mark, latest_reply_seen_ts: latest,
        expires_at: new Date(tsToMs(latest) + 14 * DAY).toISOString() }]);
      return true;
    }
    const keep = (stored: unknown, given: string): string => (typeof stored === "string" && tsLt(given, stored) ? stored : given);
    const newest = keep(t.latest_reply_seen_ts, latest);
    updateRows(TH, [t], {
      reply_watermark_ts: keep(t.reply_watermark_ts, mark),
      latest_reply_seen_ts: newest,
      expires_at: new Date(Math.max(ms(t.expires_at), tsToMs(newest) + 14 * DAY)).toISOString(),
      updated_at: now().toISOString()
    });
    return true;
  }

  function fbLeadChannels(): Row[] {
    if (!exists(FB)) throw new PgError("42P01", 'relation "public.fb_onboarding" does not exist');
    const out: Row[] = [];
    for (const o of rowsOf(FB)) {
      const state = o.state as Row | null | undefined;
      if (!state || typeof state !== "object" || !Object.prototype.hasOwnProperty.call(state, "access.notify.slack_channels")) continue;
      const holder = state["access.notify.slack_channels"] as Row | null | undefined;
      const raw = holder && typeof holder === "object" ? holder.v : undefined;
      if (typeof raw !== "string") continue;
      let list: unknown;
      try {
        list = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!Array.isArray(list)) continue;
      for (const e of list.slice(0, 12)) {
        if (e === null || typeof e !== "object" || Array.isArray(e)) continue;
        const ent = e as Row;
        // The slug form (channelSlug; the SQL's btrim(regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), '-')).
        const n = slugOf(typeof ent.name === "string" ? ent.name : "");
        const name = SLUG.test(n) ? n : null;
        const url = typeof ent.url === "string" ? ent.url : "";
        const id = /\/archives\/([CG][A-Z0-9]{2,30})/.exec(url)?.[1] ?? /\/client\/T[A-Z0-9]+\/([CG][A-Z0-9]{2,30})/.exec(url)?.[1] ?? null;
        if (name !== null || id !== null) out.push({ name, channel_id: id });
      }
    }
    return out;
  }

  /** P6's v1, in the composed fake, with every installation's user half masked (P6's fake enforces its bot-only CHECKs). */
  async function p6Rpc(fn: string, args: Row): Promise<unknown> {
    const stash = new Map<unknown, { token: unknown; scopes: unknown }>();
    for (const r of rowsOf(SI)) {
      stash.set(r.id, { token: r.user_token_enc, scopes: r.user_scopes });
      r.user_token_enc = null;
      r.user_scopes = [];
    }
    let result: Result;
    try {
      result = (await (p6.client as { rpc(fn: string, args: Row): PromiseLike<Result> }).rpc(fn, args)) as Result;
    } finally {
      for (const r of rowsOf(SI)) {
        const s = stash.get(r.id);
        if (s) {
          r.user_token_enc = s.token ?? null;
          r.user_scopes = s.scopes ?? [];
        }
      }
    }
    if (result.error) throw new PgError(result.error.code ?? "", result.error.message, result.error.details);
    return result.data;
  }

  async function acceptEventV2(a: Row): Promise<Row> {
    const done = (o: Row) => ({ outcome: "accepted", recorded: false, path: "v2", ...o });
    const drop = (reason: string, extra: Row = {}) => done({ decision: "drop", reason, recorded: false, ...extra });
    // 1.
    if (!matches(a.p_event_id, EVENT_ID)) throw raise("exec_slack_accept_event_v2: bad event_id");
    if (isNull(a.p_team_id) || isNull(a.p_api_app_id) || isNull(a.p_event_type)) throw raise("exec_slack_accept_event_v2: team, app and type are required");
    const eventTime = a.p_event_time;
    if (typeof eventTime !== "number" || eventTime <= 0 || eventTime > 4102444800) throw raise("exec_slack_accept_event_v2: bad event_time");
    const vTime = new Date(eventTime * 1000).toISOString();
    const team = a.p_team_id;
    const app = a.p_api_app_id;
    const type = String(a.p_event_type);
    const channel = a.p_channel;
    const ingest = a.p_ingest as Row | null | undefined;
    const retry = Math.min(Math.max(typeof a.p_retry_num === "number" ? Math.trunc(a.p_retry_num) : 0, 0), 100);
    const revokedUsers = Array.isArray(a.p_revoked_user_ids) ? (a.p_revoked_user_ids as unknown[]) : [];
    const activeSi = () => rowsOf(SI).filter((i) => isNull(i.revoked_at) && i.team_id === team && i.app_id === app);
    // 2.
    if (isNull(ingest) || ["app_home_opened", "app_uninstalled", "tokens_revoked"].includes(type)
        || (type === "message" && (isNull(channel) || activeSi().some((i) => i.slack_dm_channel_id === channel)))
        || !READING_TYPES.includes(type)) {
      if (type === "tokens_revoked" && revokedUsers.length > 0) {
        for (const i of activeSi()) {
          if (isNull(i.user_token_enc) || !revokedUsers.includes(i.user_id) || !(ms(i.user_installed_at) <= ms(vTime))) continue;
          insertJob({
            kind: "exec.slack-user-check", lane: "bulk", principal_id: null, payload: { installation_id: i.id, event_time: eventTime },
            dedupe_key: `slack-user-check:${String(a.p_event_id)}:${String(i.id)}`, max_attempts: 3
          });
        }
        // C47 (P7a fixer ui-11): Slack revoking his token ends a failed Stop's "remove the access in Slack" banner.
        for (const i of activeSi()) {
          if (i.reading_state !== "revoked" || !isNull(i.user_token_enc) || i.user_last_error_code !== "revoke_failed" || !revokedUsers.includes(i.user_id)) continue;
          updateRows(SI, [i], { user_last_error_code: null, user_last_error_at: null, updated_at: now().toISOString() });
        }
      }
      const v1Args: Row = { ...a };
      delete v1Args.p_ingest;
      const res = (await p6Rpc("exec_slack_accept_event", v1Args)) as Row;
      if (type === "app_uninstalled" && res?.decision === "revoke") {
        for (const i of rowsOf(SI)) {
          if (i.team_id !== team || i.app_id !== app || i.revoke_reason !== "app_uninstalled" || i.reading_state === "none" || !isNull(i.reading_purged_at)) continue;
          const at = isNull(i.user_installed_at) ? "0" : String(Math.floor(ms(i.user_installed_at) / 1000));
          insertJob({
            kind: "exec.slack-read-purge", lane: "bulk", principal_id: null, payload: { installation_id: i.id, reason: "app_uninstalled" },
            dedupe_key: `slack-read-purge:${String(i.id)}:${at}`, max_attempts: 6
          });
        }
      }
      return { ...res, path: "v1" };
    }
    // 3.
    ingestCheck(ingest);
    const ing = ingest as Row;
    const kind = String(ing.kind);
    if ((kind === "lifecycle") !== (type !== "message")) throw raise("exec_slack_accept_event_v2: kind and event type disagree");
    if (!matches(channel, CHAN)) throw raise("exec_slack_accept_event_v2: bad channel");
    if (kind === "delete" && isNull(ing.deleted_ts)) throw raise("exec_slack_accept_event_v2: deleted_ts required");
    if ((kind === "msg" || kind === "edit") && isNull(ing.ts)) throw raise("exec_slack_accept_event_v2: ts required");
    const ts = (ing.ts as string | null | undefined) ?? null;
    const thread = isNull(ing.thread_ts) || ing.thread_ts === ts ? null : (ing.thread_ts as string);
    const author = (ing.author as string | null | undefined) ?? null;
    const conv = (ing.conv as string | null | undefined) ?? null;
    const paths = Array.isArray(ing.dd_paths) ? (ing.dd_paths as string[]) : [];
    // 4.
    const inst = rowsOf(SI).find((i) => isNull(i.revoked_at) && i.team_id === team && i.app_id === app && !isNull(i.user_token_enc));
    if (!inst) return drop("not_reading");
    if (ing.auth_is_bot === true || (ing.auth_user ?? null) !== inst.user_id) return drop("not_his_view");
    const pid = inst.principal_id;
    const ch = channelRow(pid, channel);
    if (ch) lock("exec_slack_accept_event_v2", CH, `${String(pid)}:${String(channel)}`, "update");
    const have = ch !== undefined;
    const record = (decision: string, outcome: string, his: unknown = null) =>
      recordEvent({ id: a.p_event_id, inst, team, app, type, decision, outcome, time: vTime, retry, his });
    const dup = { outcome: "duplicate", path: "v2" };
    // 4b.
    if (kind === "delete") {
      if (!have) return drop("unknown_channel");
      if (ch.class === "deny") return drop("deny");
      if (ch.class === "unclassified" && !messageRow(pid, channel, ing.deleted_ts)) return drop("unclassified");
      if (!record("ingest", "deleted")) return dup;
      const res = markDeleted(pid, channel, [ing.deleted_ts], "event");
      return { ...done({ decision: "ingest", reason: "deleted", recorded: true, enqueued: false, interactive: false }), ...res };
    }
    // 4c.
    if (kind === "edit" && have && ch.class !== "deny" && rowsOf(SM).some((m) => m.principal_id === pid && m.channel_id === channel && m.ts === ts && m.role !== "anchor")) {
      if (!record("ingest", "edited")) return dup;
      const nowIso = now().toISOString();
      updateRows(IT, rowsOf(IT).filter((i) => i.principal_id === pid && i.channel_id === channel && i.ts === ts && !isNull(i.excerpt)), { excerpt: null, updated_at: nowIso });
      const m = messageRow(pid, channel, ts);
      if (m) {
        const edited = ing.edited_ts;
        updateRows(SM, [m], {
          edited_ts: !isNull(edited) && (isNull(m.edited_ts) || tsLt(m.edited_ts, edited)) ? edited : m.edited_ts,
          dd_paths: paths.length > 0 ? [...paths] : m.dd_paths,
          updated_at: nowIso
        });
      }
      const scope = conv === "channel" ? "channels:history" : conv === "group" ? "groups:history" : conv === "im" ? "im:history" : conv === "mpim" ? "mpim:history" : null;
      const gates = !isNull(inst.discovered_at) && readingOn(pid) && scope !== null && Array.isArray(inst.user_scopes) && (inst.user_scopes as unknown[]).includes(scope)
        && ["standard", "external", "finance"].includes(String(ch.class)) && ch.watch_state !== "unwatched" && isNull(ch.left_at)
        && !(ch.watch_state === "muted" && (ch.mute_source === "default_finance" || ch.class === "finance" || ch.finance_name === true));
      if (gates) {
        insertJob({
          kind: "exec.slack-triage", lane: "bulk", principal_id: pid,
          payload: { installation_id: inst.id, channel, root: ts, mode: "retriage", ts },
          dedupe_key: `slack-retriage:${String(pid)}:${String(channel)}:${String(ts)}:${String(ing.edited_ts ?? ts)}`, max_attempts: 6
        });
      }
      return done({ decision: "ingest", reason: "edited", recorded: true, enqueued: gates, interactive: false });
    }
    // 5.
    if (kind === "lifecycle") {
      const lc = ing.lc as string | null | undefined;
      if (isNull(lc)) throw raise("exec_slack_accept_event_v2: lc required");
      if (!have && lc !== "created") return drop("unknown_channel");
      // N1, rule 7 (P7a fixer security-5): a deny row is its bare marker only; deleted removes it, id_changed still re-keys.
      if (have && ch.class === "deny" && lc !== "id_changed") {
        if (lc === "deleted") deleteRows(CH, rowsOf(CH).filter((c) => c.principal_id === pid && c.channel_id === channel));
        return drop("deny");
      }
      if (!record("lifecycle", String(lc))) return dup;
      let outcome = String(lc);
      const nowIso = () => now().toISOString();
      if (lc === "created") {
        if (!channelRow(pid, channel)) insertRows(CH, [{ principal_id: pid, installation_id: inst.id, channel_id: channel, conv_type: "channel", is_private: false }]);
        outcome = "classify";
      } else if (lc === "rename" && ch) {
        const newName = (ing.name as string | null | undefined) ?? null;
        let fb: boolean | null = false;
        if (ch.class !== "deny") {
          try {
            fb = fbLeadChannels().some((f) => f.channel_id === channel || (newName !== null && f.name === slugOf(newName)));
          } catch (err) {
            if (err instanceof PgError && err.code === "42P01") fb = null;
            else throw err;
          }
        }
        if (ch.class === "deny") {
          outcome = "deny_kept";
        } else if (fb === true || leadName(newName)) {
          purgeConversation(pid, channel, "deny", "exec_slack_accept_event_v2");
          const c = channelRow(pid, channel);
          if (c) {
            updateRows(CH, [c], {
              class: "deny", deny_reason: fb === true ? "fb_list" : "lead_name", hub_kind: null, finance_name: false, watch_state: "unwatched", mute_source: null,
              watch_set_by_owner_at: null, name: null, im_user_id: null, is_ext_shared: false, hist_watermark_ts: null, deep_swept_at: null, swept_at: null,
              last_event_ts: null, last_activity_ts: null, activity_30d: null, probed_at: null, classified_at: nowIso(), updated_at: nowIso()
            });
          }
          outcome = "denied";
        } else if (fb === null || newName === null || newName.includes("leads")) {
          updateRows(CH, [ch], {
            class: "unclassified", deny_reason: null, hub_kind: null, finance_name: false, watch_state: "unwatched", mute_source: null,
            watch_set_by_owner_at: null, name: null, updated_at: nowIso()
          });
          outcome = "classify";
        } else {
          const finance = ["standard", "external", "finance"].includes(String(ch.class)) && (ch.conv_type === "channel" || ch.conv_type === "group")
            && ch.finance_name !== true && financeName(newName);
          const watched = ch.watch_state === "watched" || ch.watch_state === "muted";
          updateRows(CH, [ch], {
            name: ch.class === "unclassified" ? null : newName,
            finance_name: ch.finance_name === true || finance,
            class: finance && ch.class === "standard" ? "finance" : ch.class,
            watch_state: finance && watched ? "muted" : ch.watch_state,
            mute_source: finance && watched ? "default_finance" : ch.mute_source,
            watch_set_by_owner_at: finance ? null : ch.watch_set_by_owner_at,
            updated_at: nowIso()
          });
          if (finance) {
            updateRows(IT, rowsOf(IT).filter((i) => i.principal_id === pid && i.channel_id === channel && i.source_class !== "finance"), { source_class: "finance", updated_at: nowIso() });
          }
          outcome = "classify";
        }
      } else if ((lc === "archive" || lc === "unarchive") && ch) {
        updateRows(CH, [ch], { is_archived: lc === "archive", updated_at: nowIso() });
      } else if (lc === "deleted") {
        purgeConversation(pid, channel, "deleted", "exec_slack_accept_event_v2");
        deleteRows(CH, rowsOf(CH).filter((c) => c.principal_id === pid && c.channel_id === channel));
        outcome = "purged";
      } else if (lc === "left") {
        purgeConversation(pid, channel, "left", "exec_slack_accept_event_v2");
        outcome = "purged";
      } else if (lc === "shared" && ch) {
        if (ch.class !== "deny") {
          updateRows(CH, [ch], {
            class: ch.class === "standard" || ch.class === "finance" ? "external" : ch.class, is_ext_shared: true, ext_ever: true, updated_at: nowIso()
          });
          reconcileItems(pid, channel);
        }
        outcome = "external";
      } else if (lc === "unshared" && ch) {
        if (ing.is_ext_shared === true || ch.class === "deny") outcome = "still_shared";
        else {
          updateRows(CH, [ch], { is_ext_shared: false, updated_at: nowIso() });
          outcome = "classify";
        }
      } else if (lc === "id_changed") {
        if (isNull(ing.new_channel)) throw raise("exec_slack_accept_event_v2: new_channel required");
        insertJob({
          kind: "exec.slack-rekey", lane: "interactive", principal_id: pid,
          payload: { installation_id: inst.id, old_channel: channel, new_channel: ing.new_channel },
          dedupe_key: `slack-rekey:${String(pid)}:${String(channel)}:${String(ing.new_channel)}`, max_attempts: 3
        });
        outcome = "rekey";
      }
      if (outcome === "classify") {
        insertJob({
          kind: "exec.slack-classify", lane: "bulk", principal_id: pid, payload: { installation_id: inst.id, channel },
          dedupe_key: `slack-classify:${String(pid)}:${String(channel)}:e${String(a.p_event_id)}`, max_attempts: 3
        });
      }
      const ev = rowsOf(SE).find((e) => e.event_id === a.p_event_id);
      if (ev) updateRows(SE, [ev], { ingest_outcome: outcome });
      return done({ decision: "lifecycle", reason: outcome, recorded: true, enqueued: outcome === "classify" || outcome === "rekey", interactive: outcome === "rekey" });
    }
    // 6.
    if (isNull(inst.discovered_at)) return drop("discovering");
    if (!readingOn(pid)) return drop("reading_off");
    const scope = conv === "channel" ? "channels:history" : conv === "group" ? "groups:history" : conv === "im" ? "im:history" : conv === "mpim" ? "mpim:history" : null;
    if (scope === null || !(Array.isArray(inst.user_scopes) && (inst.user_scopes as unknown[]).includes(scope))) return drop("scope");
    // 7.
    if (!have) insertRows(CH, [{ principal_id: pid, installation_id: inst.id, channel_id: channel, conv_type: conv, is_private: conv !== "channel" }]);
    if (!have || ch.class === "unclassified") {
      const lane = conv === "im" || conv === "mpim" ? "interactive" : "bulk";
      insertJob({
        kind: "exec.slack-classify", lane, principal_id: pid, payload: { installation_id: inst.id, channel },
        dedupe_key: `slack-classify:${String(pid)}:${String(channel)}:h${Math.floor(now().getTime() / H)}`, max_attempts: 3
      });
      return drop("unclassified", { enqueued: true, interactive: lane === "interactive" });
    }
    if (ch.class === "deny") return drop("deny");
    const dd = rowsOf(DB).find((d) => d.team_id === team && d.ok === true);
    const isDd = ing.dd_template === true || (!!dd && !isNull(dd.app_id) && ing.app_id === dd.app_id) || (!!dd && !isNull(dd.user_id) && author === dd.user_id);
    const anchorRow = [{ ts, thread_ts: thread, role: "anchor", author: null, author_external: false, reasons: 0, dd_paths: paths }];
    // 9.
    if (ch.class === "hub") {
      if (kind === "msg" && isDd && ch.watch_state === "watched") {
        if (!record("ingest", "anchor")) return dup;
        noteMessages(pid, channel, anchorRow, "bulk", "m0");
        return done({ decision: "ingest", reason: "anchor", recorded: true });
      }
      return drop("hub");
    }
    if (ch.watch_state === "unwatched" || !isNull(ch.left_at)) return drop("unwatched");
    // 10.
    if (isDd) {
      if (kind !== "msg") return drop("dd_post");
      if (!record("ingest", "anchor")) return dup;
      noteMessages(pid, channel, anchorRow, "bulk", "m0");
      return done({ decision: "ingest", reason: "anchor", recorded: true });
    }
    // 11.
    if (ing.is_bot !== false) return drop("bot");
    // 12.
    if (marked(pid, channel, ts)) return drop("deleted");
    const c13 = channelRow(pid, channel);
    if (c13 && (isNull(c13.last_event_ts) || tsLt(c13.last_event_ts, ts))) updateRows(CH, [c13], { last_event_ts: ts, updated_at: now().toISOString() });
    // 14.
    if (author !== null && author === inst.user_id) {
      if (!record("ingest", "from_him", inst.user_id)) return dup;
      const res = noteFromHim(pid, channel, [{ ts, thread_ts: thread, mentions: Array.isArray(ing.mentions) ? ing.mentions : [] }]);
      return { ...done({ decision: "ingest", reason: "from_him", recorded: true }), ...res };
    }
    // 15.
    const lenB = typeof ing.len === "number" ? ing.len : 0;
    const mentions = Array.isArray(ing.mentions) ? (ing.mentions as unknown[]) : [];
    let reasons = 0;
    if (conv === "im" && lenB >= 1) reasons |= 1;
    else if (conv === "mpim" && lenB >= 1 && (mentions.includes(inst.user_id) || ing.question === true || lenB >= 2)) reasons |= 1;
    if (mentions.includes(inst.user_id)) reasons |= 2;
    if (thread !== null && (ing.parent_user === inst.user_id
        || rowsOf(TH).some((t) => t.principal_id === pid && t.channel_id === channel && t.thread_ts === thread && !isNull(t.he_posted_ts)))) {
      reasons |= 4;
    }
    if (reasons === 0) return drop("not_addressed");
    if (ch.watch_state === "muted" && (ch.mute_source === "default_finance" || ch.class === "finance" || ch.finance_name === true || (reasons & 3) === 0)) return drop("muted");
    if (author !== null && optedOut(pid, author)) return drop("opted_out");
    const ext = (!isNull(ing.author_team) && ing.author_team !== inst.team_id)
      || (isNull(ing.author_team) && (ch.class === "external" || ch.ext_ever === true || ch.is_ext_shared === true));
    if (!record("ingest", "candidate")) return dup;
    const res = noteMessages(pid, channel, [{ ts, thread_ts: thread, role: "candidate", author, reasons, author_external: ext, dd_paths: paths }],
      "interactive", `m${minuteNow()}`);
    const jobs = typeof res.jobs === "number" ? res.jobs : 0;
    return done({ decision: "ingest", reason: "candidate", recorded: true, enqueued: jobs > 0, interactive: jobs > 0 });
  }

  async function writeItems(a: Row): Promise<Row> {
    const p = a.p_principal;
    const channel = a.p_channel;
    const rows = a.p_rows;
    const outcomes = a.p_outcomes;
    if (!matches(channel, CHAN)) throw raise("exec_slack_write_items: bad channel");
    if (!Array.isArray(rows) || !Array.isArray(outcomes) || rows.length > 200 || outcomes.length > 100) {
      throw raise("exec_slack_write_items: rows and outcomes must be arrays (<= 200 / <= 100)");
    }
    if ((rows as Row[]).some((e) => !(outcomes as Row[]).some((x) => x.ts === e.ts))) throw raise("exec_slack_write_items: an item without an outcome");
    const ctx: FakeSlackWriteHookContext = { rpc: "exec_slack_write_items", principalId: String(p), channelId: String(channel), ts: (outcomes as Row[]).map((o) => String(o.ts)) };
    await cfg.beforeWriteLock?.(ctx, fdb);
    const ch = channelRow(p, channel);
    if (ch) lock("exec_slack_write_items", CH, `${String(p)}:${String(channel)}`, "share");
    if (!ch || ["deny", "unclassified", "hub"].includes(String(ch.class))) {
      return { written: 0, refused_deleted: 0, refused_missing: 0, refused_optout: 0, class_mismatch: 0, refused_class: outcomes.length };
    }
    for (const o of outcomes as Row[]) if (messageRow(p, channel, o.ts)) lock("exec_slack_write_items", SM, `${String(p)}:${String(channel)}:${String(o.ts)}`, "update");
    await cfg.afterWriteLock?.(ctx, fdb);
    // The locked channel row, re-read after the hooks (a class change committed in between waited for us in SQL; here
    // the hook stands for a writer that committed before our lock).
    const locked = channelRow(p, channel);
    if (!locked || ["deny", "unclassified", "hub"].includes(String(locked.class))) {
      return { written: 0, refused_deleted: 0, refused_missing: 0, refused_optout: 0, class_mismatch: 0, refused_class: outcomes.length };
    }
    const cls = sourceClass(locked.conv_type, locked.class, locked.is_private, locked.ext_ever, locked.is_ext_shared, locked.finance_name);
    const mismatch = (rows as Row[]).filter((e) => e.source_class !== cls).length;
    const extConv = locked.class === "external" || locked.ext_ever === true || locked.is_ext_shared === true;
    const days = retentionDays(p);
    // P7a fixer security-3: unwatched, or a closed finance mute: each outcome skipped, no item, the stored items kept.
    const closed = locked.watch_state === "unwatched"
      || (locked.watch_state === "muted" && (locked.mute_source === "default_finance" || locked.class === "finance" || locked.finance_name === true));
    let written = 0;
    let refusedDeleted = 0;
    let refusedMissing = 0;
    let refusedOptout = 0;
    let refusedClosed = 0;
    for (const o of outcomes as Row[]) {
      if (!matches(o.ts, TS) || !["assessed", "unassessed", "refused", "failed", "skipped"].includes(String(o.state))
          || (!isNull(o.content_hash) && !matches(o.content_hash, /^[0-9a-f]{64}$/))) {
        throw raise("exec_slack_write_items: bad outcome");
      }
      const ts = o.ts as string;
      const m = messageRow(p, channel, ts);
      if (!m || m.role === "anchor") {
        refusedMissing += 1;
        continue;
      }
      if (marked(p, channel, ts)) {
        refusedDeleted += 1;
        continue;
      }
      if (!isNull(m.author_user_id) && optedOut(p, m.author_user_id)) {
        refusedOptout += 1;
        continue;
      }
      if (closed) {
        const at = now().toISOString();
        updateRows(SM, [m], { triage_state: "skipped", assessed_at: at, updated_at: at });
        refusedClosed += 1;
        continue;
      }
      deleteRows(IT, rowsOf(IT).filter((i) => i.principal_id === p && i.channel_id === channel && i.ts === ts));
      const mine = (rows as Row[]).filter((e) => e.ts === ts);
      const nowIso = now().toISOString();
      const inserted = insertRows(IT, mine.map((x) => {
        const ext = x.author_external === true || m.author_external === true || (extConv && x.author_internal_verified !== true);
        return {
          principal_id: p, channel_id: channel, ts: x.ts, kind: x.kind ?? null, thread_ts: m.thread_ts ?? null, author_user_id: x.author ?? null,
          author_label: x.author_label ?? null, author_external: ext, assessed: x.assessed ?? null, addressed_to_you: x.addressed === true,
          needs_response: x.needs_response === true,
          bypass_mute: x.bypass_mute === true && locked.mute_source !== "default_finance" && locked.class !== "finance" && locked.finance_name !== true,
          urgency: x.urgency ?? "normal", summary: x.summary ?? null, excerpt: ext ? null : (x.excerpt ?? null), due_text: x.due_text ?? null,
          due_at: isNull(x.due_at) ? null : new Date(ms(x.due_at)).toISOString(), commitment_direction: x.direction ?? null, source_class: cls,
          responded_ts: m.responded_ts ?? null, responded_at: m.responded_at ?? null, acknowledged_at: m.acknowledged_at ?? null,
          expires_at: new Date(tsToMs(String(x.ts)) + days * DAY).toISOString(), created_at: nowIso, updated_at: nowIso
        };
      }));
      written += inserted.length;
      updateRows(SM, [m], {
        role: inserted.length > 0 ? "item" : "candidate", triage_state: o.state, content_hash: o.content_hash ?? m.content_hash ?? null,
        assessed_at: nowIso, updated_at: nowIso, expires_at: new Date(tsToMs(ts) + days * DAY).toISOString()
      });
    }
    if (written > 0) kickAttention(p);
    return { written, refused_deleted: refusedDeleted, refused_missing: refusedMissing, refused_optout: refusedOptout, class_mismatch: mismatch, refused_class: refusedClosed };
  }

  function applyClasses(a: Row): Row {
    const p = a.p_principal;
    const instId = a.p_installation_id;
    const runAt = a.p_run_started_at;
    const inst = rowsOf(SI).find((i) => i.id === instId);
    if (!inst || inst.principal_id !== p || !isNull(inst.revoked_at) || isNull(inst.user_token_enc)) throw raise("exec_slack_apply_classes: the installation is not reading");
    const rows = a.p_rows;
    if (!Array.isArray(rows) || rows.length > 500) throw raise("exec_slack_apply_classes: rows");
    const seenAt = isNull(runAt) ? null : new Date(ms(runAt)).toISOString();
    let upserts = 0;
    let denied = 0;
    let purged = 0;
    let hubPurged = 0;
    let reclassed = 0;
    for (const r of rows as Row[]) {
      const cls = r.class;
      if (!matches(r.channel_id, CHAN) || !["channel", "group", "im", "mpim"].includes(String(r.conv_type))
          || !["unclassified", "deny", "hub", "finance", "external", "standard"].includes(String(cls))
          || !["watched", "muted", "unwatched"].includes(String(r.default_watch ?? "unwatched"))
          || (!isNull(r.default_mute) && r.default_mute !== "default_finance" && r.default_mute !== "slack")
          || (r.finance_name !== undefined && r.finance_name !== null && typeof r.finance_name !== "boolean")) {
        throw raise("exec_slack_apply_classes: bad row");
      }
      const fin = cls === "finance" || (cls === "external" && (r.conv_type === "channel" || r.conv_type === "group") && r.finance_name === true);
      const old = channelRow(p, r.channel_id);
      if (old) lock("exec_slack_apply_classes", CH, `${String(p)}:${String(r.channel_id)}`, "update");
      const have = old !== undefined;
      if (have && old.installation_id !== instId) {
        purgeConversation(p, old.channel_id, "reinstall", "exec_slack_apply_classes");
        purged += 1;
      }
      const nowIso = now().toISOString();
      if (cls === "deny") {
        if (have && old.class !== "deny") {
          purgeConversation(p, old.channel_id, "deny", "exec_slack_apply_classes");
          purged += 1;
        } else if (have) {
          // P7a fixer security-2 (deny -> deny): a raced write's leftovers go, with no purge-log row.
          deleteRows(IT, rowsOf(IT).filter((i) => i.principal_id === p && i.channel_id === old.channel_id));
          deleteRows(SM, rowsOf(SM).filter((m) => m.principal_id === p && m.channel_id === old.channel_id));
          deleteRows(TH, rowsOf(TH).filter((t) => t.principal_id === p && t.channel_id === old.channel_id));
          deleteAttention((x) => x.principal_id === p && String(x.fingerprint).startsWith(`slack:msg:${String(old.channel_id)}:`));
        }
        const cur = channelRow(p, r.channel_id);
        const fields = {
          installation_id: instId, conv_type: r.conv_type, class: "deny", deny_reason: r.deny_reason ?? null, hub_kind: null, finance_name: false,
          watch_state: "unwatched", mute_source: null, watch_set_by_owner_at: null, name: null, im_user_id: null, is_member: false, is_private: true,
          is_ext_shared: false, hist_watermark_ts: null, deep_swept_at: null, swept_at: null, last_event_ts: null, last_activity_ts: null,
          activity_30d: null, probed_at: null, left_at: null, seen_at: seenAt, classified_at: nowIso, updated_at: nowIso
        };
        if (cur) updateRows(CH, [cur], fields);
        else insertRows(CH, [{ principal_id: p, channel_id: r.channel_id, ...fields }]);
        denied += 1;
        continue;
      }
      let owner: unknown = null;
      const intoFin = fin && !(have && old.finance_name === true);
      let watch: unknown;
      let mute: unknown;
      if (cls === "unclassified") {
        watch = "unwatched";
        mute = null;
      } else if (cls === "hub") {
        watch = r.is_member === true ? "watched" : "unwatched";
        mute = null;
      } else if (have && !isNull(old.watch_set_by_owner_at) && !["deny", "unclassified", "hub"].includes(String(old.class)) && old.installation_id === instId && !intoFin) {
        watch = old.watch_state;
        mute = old.mute_source;
        owner = old.watch_set_by_owner_at;
      } else if (r.default_mute === "slack" && have && !["deny", "unclassified"].includes(String(old.class)) && old.installation_id === instId && !intoFin) {
        watch = old.watch_state;
        mute = old.mute_source;
      } else {
        watch = r.default_watch ?? "unwatched";
        mute = watch === "muted" ? (r.default_mute ?? "owner") : null;
      }
      const shared = r.is_ext_shared === true;
      const isMember = r.is_member === true;
      const cur = channelRow(p, r.channel_id);
      const fields: Row = {
        installation_id: instId, conv_type: r.conv_type, class: cls, deny_reason: null, hub_kind: r.hub_kind ?? null, finance_name: fin, watch_state: watch,
        mute_source: mute, watch_set_by_owner_at: owner, name: cls === "unclassified" ? null : (r.name ?? null), im_user_id: r.im_user_id ?? null,
        is_member: isMember, is_private: r.is_private !== false || r.conv_type !== "channel", is_ext_shared: shared, is_archived: r.is_archived === true,
        seen_at: seenAt, classified_at: nowIso, updated_at: nowIso
      };
      if (cur) updateRows(CH, [cur], { ...fields, ext_ever: cur.ext_ever === true || shared, left_at: isMember ? null : cur.left_at });
      else insertRows(CH, [{ principal_id: p, channel_id: r.channel_id, ...fields, ext_ever: shared }]);
      upserts += 1;
      if (cls === "hub") {
        const doomed = rowsOf(SM).filter((m) => m.principal_id === p && m.channel_id === r.channel_id && m.role !== "anchor")
          .sort((x, y) => compareTs(String(x.ts), String(y.ts)));
        for (const m of doomed) {
          lock("exec_slack_apply_classes", SM, `${String(p)}:${String(r.channel_id)}:${String(m.ts)}`, "update");
          deleteRows(IT, rowsOf(IT).filter((i) => i.principal_id === p && i.channel_id === r.channel_id && i.ts === m.ts));
          deleteRows(SM, [m]);
          deleteAttention((x) => x.principal_id === p && x.fingerprint === `slack:msg:${String(r.channel_id)}:${String(m.ts)}`);
          purgeLog(p, "message", r.channel_id, m.ts, "hub");
          hubPurged += 1;
        }
      } else if (cls !== "unclassified") {
        reclassed += reconcileItems(p, r.channel_id);
      }
    }
    if (hubPurged > 0) kickAttention(p);
    return { upserted: upserts, denied, purged, hub_purged: hubPurged, reclassed };
  }

  function finishDiscovery(a: Row): Row {
    const p = a.p_principal;
    const instId = a.p_installation_id;
    const inst = rowsOf(SI).find((i) => i.id === instId);
    if (!inst || inst.principal_id !== p || !isNull(inst.revoked_at) || isNull(inst.user_token_enc)) return { ready: false, removed: 0 };
    const scopes = Array.isArray(inst.user_scopes) ? (inst.user_scopes as unknown[]) : [];
    const runAt = ms(a.p_run_started_at);
    const doomed = rowsOf(CH)
      .filter((c) => c.principal_id === p && c.installation_id === instId)
      .filter((c) => ms(c.seen_at ?? c.created_at) < runAt
        || (c.conv_type === "channel" && !scopes.includes("channels:history")) || (c.conv_type === "group" && !scopes.includes("groups:history"))
        || (c.conv_type === "im" && !scopes.includes("im:history")) || (c.conv_type === "mpim" && !scopes.includes("mpim:history")))
      .sort((x, y) => String(x.channel_id).localeCompare(String(y.channel_id)));
    for (const c of doomed) {
      lock("exec_slack_finish_discovery", CH, `${String(p)}:${String(c.channel_id)}`, "update");
      if (c.class !== "deny") purgeConversation(p, c.channel_id, "gone", "exec_slack_finish_discovery");
      deleteRows(CH, rowsOf(CH).filter((x) => x.principal_id === p && x.channel_id === c.channel_id));
    }
    const nowIso = now().toISOString();
    updateRows(SI, [inst], { reading_state: "ready", discovered_at: inst.discovered_at ?? nowIso, updated_at: nowIso });
    return { ready: true, removed: doomed.length };
  }

  function purgeReading(a: Row): Row {
    const id = a.p_installation_id;
    const inst = rowsOf(SI).find((i) => i.id === id);
    if (!inst) return { purged: false };
    if (isNull(inst.revoked_at) && isNull(inst.user_revoked_at)) throw raise("exec_slack_purge_reading: the reading half is live");
    const channels = rowsOf(CH).filter((c) => c.installation_id === id);
    deleteRows(CH, channels);
    const backed = new Set(rowsOf(SM).filter((m) => m.principal_id === inst.principal_id).map((m) => `slack:msg:${String(m.channel_id)}:${String(m.ts)}`));
    const attn = deleteAttention((x) => x.principal_id === inst.principal_id && String(x.fingerprint).startsWith("slack:msg:") && !backed.has(String(x.fingerprint)));
    const events = rowsOf(SE).filter((e) => e.installation_id === id && (e.decision === "ingest" || e.decision === "lifecycle"));
    setRows(SE, rowsOf(SE).filter((e) => !events.includes(e)));
    const none = inst.reading_state === "none";
    const nowIso = now().toISOString();
    updateRows(SI, [inst], {
      user_token_enc: null, user_key_id: null,
      user_revoked_at: none ? inst.user_revoked_at : (inst.user_revoked_at ?? nowIso),
      user_revoke_reason: none ? inst.user_revoke_reason : (inst.user_revoke_reason ?? "installation_revoked"),
      reading_state: none ? "none" : "revoked", discovered_at: null, reading_purged_at: nowIso, updated_at: nowIso
    });
    purgeLog(inst.principal_id, "reading", null, null, "reading_purged");
    return { purged: true, channels: channels.length, attention: attn, events: events.length };
  }

  function userRevoke(a: Row): Row {
    const reason = a.p_reason;
    if (isNull(reason) || !["stopped", "tokens_revoked", "disconnected", "app_uninstalled"].includes(String(reason))) throw raise("exec_slack_user_revoke: bad reason");
    const id = a.p_installation_id;
    const inst = rowsOf(SI).find((i) => i.id === id && (i.reading_state === "discovering" || i.reading_state === "ready"));
    const nowIso = now().toISOString();
    if (inst) {
      updateRows(SI, [inst], {
        user_revoked_at: nowIso, user_revoke_reason: reason, user_token_enc: null, user_key_id: null, reading_state: "revoked", discovered_at: null, updated_at: nowIso
      });
    }
    const revoked = inst !== undefined;
    let purge: Row | null = null;
    if (revoked || rowsOf(SI).some((i) => i.id === id && i.reading_state === "revoked" && isNull(i.reading_purged_at))) purge = purgeReading({ p_installation_id: id });
    return { revoked, purge };
  }

  function rateTake(a: Row): Row {
    const cls = a.p_class;
    const n = a.p_n;
    if (!["triage", "sweep", "probe", "discovery"].includes(String(cls))) throw raise("exec_slack_rate_take: bad class");
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 10) throw raise("exec_slack_rate_take: n must be 1..10");
    const method = String(a.p_method);
    const tier = ["conversations.history", "conversations.replies", "conversations.info", "users.conversations"].includes(method) ? "t3"
      : ["conversations.list", "users.list"].includes(method) ? "t2" : method === "users.info" ? "t4" : method === "chat.getPermalink" ? "special" : null;
    if (tier === null || !matches(a.p_team, /^T[A-Z0-9]{2,30}$/)) throw raise("exec_slack_rate_take: bad team or method");
    const nowD = isNull(a.p_now) ? now() : new Date(ms(a.p_now));
    const window = new Date(Math.floor(nowD.getTime() / 60_000) * 60_000).toISOString();
    let row = rowsOf(RT).find((r) => r.team_id === a.p_team && r.method === method);
    if (!row) [row] = insertRows(RT, [{ team_id: a.p_team, method, window_start: window }]);
    if (!isNull(row.blocked_until) && ms(row.blocked_until) > nowD.getTime()) {
      return { allowed: false, reason: "blocked", wait_ms: Math.ceil(ms(row.blocked_until) - nowD.getTime()) };
    }
    const fresh = ms(row.window_start) !== ms(window);
    const cur = (k: string) => (fresh ? 0 : Number(row?.[k] ?? 0));
    const total = cur("n_total");
    const ownN = cur(`n_${String(cls)}`);
    const ok = tier === "t3"
      ? (cls === "triage" ? total + n <= 40 : cls === "sweep" ? total + n <= 30 : total + n <= 20 && ownN + n <= 10)
      : tier === "t2" ? cls === "discovery" && total + n <= 15 : tier === "t4" ? total + n <= 60 : total + n <= 100;
    updateRows(RT, [row], {
      window_start: window,
      n_total: total + (ok ? n : 0),
      n_triage: cur("n_triage") + (ok && cls === "triage" ? n : 0),
      n_sweep: cur("n_sweep") + (ok && cls === "sweep" ? n : 0),
      n_probe: cur("n_probe") + (ok && cls === "probe" ? n : 0),
      n_discovery: cur("n_discovery") + (ok && cls === "discovery" ? n : 0),
      updated_at: now().toISOString()
    });
    if (ok) return { allowed: true, wait_ms: 0 };
    return { allowed: false, reason: "budget", wait_ms: Math.ceil(ms(window) + 60_000 - nowD.getTime()) };
  }

  function rateBlock(a: Row): null {
    const nowD = now();
    const want = isNull(a.p_until) ? nowD.getTime() + 30_000 : ms(a.p_until);
    const until = new Date(Math.min(want, nowD.getTime() + 10 * 60_000)).toISOString();
    const row = rowsOf(RT).find((r) => r.team_id === a.p_team && r.method === a.p_method);
    if (!row) insertRows(RT, [{ team_id: a.p_team, method: a.p_method, window_start: new Date(Math.floor(nowD.getTime() / 60_000) * 60_000).toISOString(), blocked_until: until }]);
    else updateRows(RT, [row], { blocked_until: new Date(Math.max(isNull(row.blocked_until) ? ms(until) : ms(row.blocked_until), ms(until))).toISOString(), updated_at: nowD.toISOString() });
    return null;
  }

  function rekeyChannel(a: Row): Row {
    const p = a.p_principal;
    const oldId = a.p_old;
    const newId = a.p_new;
    if (!matches(oldId, CHAN) || !matches(newId, CHAN)) throw raise("exec_slack_rekey_channel: bad ids");
    if (oldId === newId) return { rekeyed: false, attention: 0 };
    const old = channelRow(p, oldId);
    if (!old) return { rekeyed: false, attention: 0 };
    lock("exec_slack_rekey_channel", CH, `${String(p)}:${String(oldId)}`, "update");
    const target = channelRow(p, newId);
    if (target) lock("exec_slack_rekey_channel", CH, `${String(p)}:${String(newId)}`, "update");
    if (target && target.class === "deny") {
      // N1, rule 7 (P7a fixer security-7): only the classifier lifts a deny; the old row's data and row go.
      if (old.class !== "deny") purgeConversation(p, oldId, "deny", "exec_slack_rekey_channel");
      deleteRows(CH, rowsOf(CH).filter((c) => c.principal_id === p && c.channel_id === oldId));
      return { rekeyed: false, attention: 0 };
    }
    if (target) {
      purgeConversation(p, newId, "rekey", "exec_slack_rekey_channel");
      deleteRows(CH, rowsOf(CH).filter((c) => c.principal_id === p && c.channel_id === newId));
    }
    updateRows(CH, [old], { channel_id: newId, updated_at: now().toISOString() });
    for (const d of rowsOf(DL)) {
      if (d.principal_id === p && d.channel_id === oldId && !rowsOf(DL).some((x) => x.principal_id === p && x.channel_id === newId && x.ts === d.ts)) d.channel_id = newId;
    }
    updateRows(IT, rowsOf(IT).filter((i) => i.principal_id === p && i.channel_id === newId), { permalink: null, updated_at: now().toISOString() });
    const prefix = `slack:msg:${String(oldId)}:`;
    const moved = rowsOf(AI).filter((x) => x.principal_id === p && x.source === "slack" && String(x.fingerprint).startsWith(prefix));
    updateRows(AI, moved, {});
    for (const x of moved) x.fingerprint = `slack:msg:${String(newId)}:${String(x.fingerprint).slice(prefix.length)}`;
    if (moved.length > 0) kickAttention(p);
    return { rekeyed: true, attention: moved.length };
  }

  function purgeExpired(a: Row): Row {
    const nowMs = isNull(a.p_now) ? now().getTime() : ms(a.p_now);
    const expired = (t: string) => rowsOf(t).filter((r) => ms(r.expires_at) < nowMs);
    const items = expired(IT).slice(0, 5000);
    deleteRows(IT, items);
    const msgs = expired(SM).slice(0, 5000);
    deleteRows(SM, msgs);
    const threads = expired(TH).slice(0, 5000);
    deleteRows(TH, threads);
    const markers = expired(DL);
    deleteRows(DL, markers);
    const log = expired(PL);
    deleteRows(PL, log);
    const channels = rowsOf(CH).filter((c) => !isNull(c.left_at) && ms(c.left_at) < nowMs - 30 * DAY);
    deleteRows(CH, channels);
    const backed = new Set(rowsOf(SM).map((m) => `${String(m.principal_id)}|slack:msg:${String(m.channel_id)}:${String(m.ts)}`));
    const attn = deleteAttention((x) => String(x.fingerprint).startsWith("slack:msg:") && !backed.has(`${String(x.principal_id)}|${String(x.fingerprint)}`));
    return { items: items.length, messages: msgs.length, threads: threads.length, markers: markers.length, log: log.length, channels: channels.length, attention: attn };
  }

  function setWatch(a: Row): Row {
    const watch = a.p_watch;
    if (!["watched", "muted", "unwatched"].includes(String(watch))) throw raise("exec_slack_set_watch: bad state");
    const v = channelRow(a.p_principal, a.p_channel);
    if (!v) return { outcome: "not_found" };
    lock("exec_slack_set_watch", CH, `${String(a.p_principal)}:${String(a.p_channel)}`, "update");
    if (["deny", "unclassified", "hub"].includes(String(v.class))) return { outcome: "refused", class: v.class };
    if (!isNull(v.left_at) && v.conv_type !== "channel") return { outcome: "refused", class: "left" };
    if (isNull(a.p_expected) || ms(v.updated_at) !== ms(a.p_expected)) return { outcome: "conflict", updated_at: v.updated_at };
    if (watch === "watched" && (v.class === "finance" || v.finance_name === true) && v.watch_state !== "watched" && a.p_allow_finance !== true) {
      return { outcome: "confirmation_required" };
    }
    // A strictly later token, like now() on a fresh transaction (the fake keeps milliseconds only).
    const at = new Date(Math.max(now().getTime(), ms(v.updated_at) + 1)).toISOString();
    const finance = v.class === "finance" || v.finance_name === true;
    updateRows(CH, [v], { watch_state: watch, mute_source: watch !== "muted" ? null : finance ? "default_finance" : "owner", watch_set_by_owner_at: at, updated_at: at });
    return { outcome: "updated", updated_at: at };
  }

  function purgeAuthor(a: Row): Row {
    const p = a.p_principal;
    const author = a.p_author;
    if (isNull(p)) throw raise("exec_slack_purge_author: unknown principal");
    if (!matches(author, USER)) throw raise("exec_slack_purge_author: bad author");
    if (!optedOut(p, author)) insertRows(OO, [{ principal_id: p, author_user_id: author }]);
    let convs = 0;
    const ims = rowsOf(CH).filter((c) => c.principal_id === p && c.conv_type === "im" && c.im_user_id === author)
      .sort((x, y) => String(x.channel_id).localeCompare(String(y.channel_id)));
    for (const c of ims) {
      purgeConversation(p, c.channel_id, "author_optout", "exec_slack_purge_author");
      convs += 1;
    }
    const hers = rowsOf(SM).filter((m) => m.principal_id === p && m.author_user_id === author);
    const doomed = rowsOf(SM)
      .filter((m) => m.principal_id === p && m.role !== "anchor"
        && hers.some((h) => h.channel_id === m.channel_id && (h.ts === m.ts || (!isNull(h.thread_ts) && (m.thread_ts ?? m.ts) === h.thread_ts) || m.thread_ts === h.ts)))
      .sort((x, y) => String(x.channel_id).localeCompare(String(y.channel_id)) || compareTs(String(x.ts), String(y.ts)))
      .map((m) => ({ channel: m.channel_id, ts: m.ts }));
    let items = 0;
    let msgs = 0;
    let attn = 0;
    for (const d of doomed) {
      lock("exec_slack_purge_author", CH, `${String(p)}:${String(d.channel)}`, "update");
      lock("exec_slack_purge_author", SM, `${String(p)}:${String(d.channel)}:${String(d.ts)}`, "update");
      const it = rowsOf(IT).filter((i) => i.principal_id === p && i.channel_id === d.channel && i.ts === d.ts);
      deleteRows(IT, it);
      items += it.length;
      const m = rowsOf(SM).filter((x) => x.principal_id === p && x.channel_id === d.channel && x.ts === d.ts);
      deleteRows(SM, m);
      msgs += m.length;
      attn += deleteAttention((x) => x.principal_id === p && x.fingerprint === `slack:msg:${String(d.channel)}:${String(d.ts)}`);
      purgeLog(p, "message", d.channel, d.ts, "author_optout");
    }
    if (items + attn + convs > 0) kickAttention(p);
    return { conversations: convs, messages: msgs, items, attention: attn, opted_out: true };
  }

  const rpcs: Record<string, (args: Row) => unknown> = {
    exec_slack_ingest_check: (args) => (ingestCheck(args.p), null),
    exec_slack_lead_name: (args) => leadName(args.p_name),
    exec_slack_fb_lead_channels: () => fbLeadChannels(),
    exec_slack_kick_attention: (args) => (kickAttention(args.p_principal), null),
    exec_slack_record_event: (args) => {
      const inst = { id: args.p_installation_id, principal_id: args.p_principal } as Row;
      return recordEvent({
        id: args.p_event_id, inst, team: args.p_team, app: args.p_app, type: args.p_type, decision: String(args.p_decision), outcome: String(args.p_outcome),
        time: new Date(ms(args.p_time)).toISOString(), retry: typeof args.p_retry === "number" ? args.p_retry : 0, his: args.p_his_id ?? null
      });
    },
    exec_slack_note_messages: (args) => noteMessages(args.p_principal, args.p_channel, args.p_rows, args.p_lane, args.p_bucket),
    exec_slack_note_from_him: (args) => noteFromHim(args.p_principal, args.p_channel, args.p_rows),
    exec_slack_save_thread_watermark: saveThreadWatermark,
    exec_slack_mark_deleted: (args) => markDeleted(args.p_principal, args.p_channel, args.p_ts, args.p_reason),
    exec_slack_purge_conversation: (args) => purgeConversation(args.p_principal, args.p_channel, args.p_reason),
    exec_slack_apply_classes: applyClasses,
    exec_slack_finish_discovery: finishDiscovery,
    exec_slack_purge_reading: purgeReading,
    exec_slack_user_revoke: userRevoke,
    exec_slack_rate_take: rateTake,
    exec_slack_rate_block: rateBlock,
    exec_slack_rekey_channel: rekeyChannel,
    exec_slack_purge_expired: purgeExpired,
    exec_slack_set_watch: setWatch,
    exec_slack_finance_name: (args) => financeName(args.p_name),
    exec_slack_item_source_class: (args) =>
      sourceClass(args.p_conv_type, args.p_class, args.p_is_private, args.p_ext_ever, args.p_is_ext_shared, args.p_finance_name),
    exec_slack_dd_paths_ok: (args) => ddPathsOk(args.p),
    exec_slack_purge_author: purgeAuthor
  };
  const asyncRpcs: Record<string, (args: Row) => Promise<unknown>> = {
    exec_slack_accept_event_v2: acceptEventV2,
    exec_slack_write_items: writeItems
  };

  // --- one request ------------------------------------------------------------

  function errorOf(err: unknown): FakeSlackDbError {
    if (err instanceof PgError) return { message: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) };
    const e = err as { message?: string; code?: string };
    return { message: typeof e?.message === "string" ? e.message : String(err), ...(typeof e?.code === "string" ? { code: e.code } : {}) };
  }

  /** One statement, one transaction: on any refusal every table (this fake's and P6's) goes back to how it was. */
  function snapshot(): () => void {
    const own$ = structuredClone(own);
    const p6$ = structuredClone(p6.tables);
    const seqs = [logSeq, jobSeq];
    const locks = fdb.locks.length;
    return () => {
      for (const t of OWN_TABLES) own[t] = own$[t] ?? [];
      for (const t of P6_TABLES) (p6.tables as Record<string, Row[]>)[t] = p6$[t];
      [logSeq, jobSeq] = seqs;
      fdb.locks.length = locks;
    };
  }

  async function runRpc(r: Call): Promise<Result> {
    const args = (r.payload ?? {}) as Row;
    if (P6_RPCS.has(r.target)) return { data: structuredClone(await p6Rpc(r.target, args)), count: null, error: null };
    const sync = rpcs[r.target];
    const asyncImpl = asyncRpcs[r.target];
    if (!sync && !asyncImpl) return { data: null, count: null, error: { code: "PGRST202", message: `Could not find the function public.${r.target} in the schema cache` } };
    const restore = snapshot();
    try {
      const data = sync ? sync(args) : await asyncImpl(args);
      return { data: structuredClone(data ?? null), count: null, error: null };
    } catch (err) {
      restore();
      throw err;
    }
  }

  function runTable(r: Call): Result {
    const opts = r.options ?? {};
    const wantCount = opts.count === "exact";
    const table = r.target;
    checkSelected(table, r.columns);
    let affected: Row[];
    if (r.kind === "insert" || r.kind === "upsert") {
      const payloads = (Array.isArray(r.payload) ? r.payload : [r.payload]) as Row[];
      for (const p of payloads) {
        const bad = unknownColumn(table, p);
        if (bad) throw bad;
      }
      const restore = snapshot();
      try {
        if (r.kind === "insert") affected = insertRows(table, payloads);
        else {
          const keys = String(opts.onConflict ?? "id").split(",").map((s) => s.trim());
          affected = [];
          for (const p of payloads) {
            const existing = rowsOf(table).find((row) => keys.every((k) => compare(row[k], p[k]) === 0));
            if (existing) {
              if (opts.ignoreDuplicates) continue;
              updateRows(table, [existing], p);
              affected.push(existing);
            } else {
              affected.push(...insertRows(table, [p]));
            }
          }
        }
      } catch (err) {
        restore();
        throw err;
      }
    } else {
      const rows = rowsOf(table).filter((row) => r.filters.every((f) => test(row, f)));
      if (r.kind === "update") {
        const bad = unknownColumn(table, (r.payload ?? {}) as Row);
        if (bad) throw bad;
        const restore = snapshot();
        try {
          updateRows(table, rows, (r.payload ?? {}) as Row);
        } catch (err) {
          restore();
          throw err;
        }
        affected = rows;
      } else if (r.kind === "delete") {
        deleteRows(table, rows);
        affected = rows;
      } else {
        affected = sortRows(rows, r.orders);
        if (r.range) affected = affected.slice(r.range[0], r.range[1] + 1);
        if (r.limit !== null) affected = affected.slice(0, r.limit);
      }
    }
    const count = wantCount ? affected.length : null;
    if (opts.head === true || r.columns === null) return { data: null, count, error: null };
    const out = affected.map((row) => project(row, r.columns as string));
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

  /** A from() request on a P6 table this fake doesn't extend: replayed on the composed P6 fake's own builder. */
  async function delegate(r: Call): Promise<Result> {
    const from = (p6.client as { from(t: string): Record<string, (...a: unknown[]) => unknown> }).from(r.target);
    let b: Record<string, (...a: unknown[]) => unknown>;
    if (r.kind === "select") b = from.select(r.columns ?? "*", r.options ?? undefined) as typeof b;
    else if (r.kind === "insert") b = from.insert(r.payload, r.options ?? undefined) as typeof b;
    else if (r.kind === "upsert") b = from.upsert(r.payload, r.options ?? undefined) as typeof b;
    else if (r.kind === "update") b = from.update(r.payload, r.options ?? undefined) as typeof b;
    else b = from.delete(r.options ?? undefined) as typeof b;
    if (r.kind !== "select" && r.columns !== null) b = b.select(r.columns) as typeof b;
    for (const f of r.filters) {
      if (f.op === "not") {
        const inner = f.inner;
        const value = inner.op === "in" ? inner.values : (inner as { value: unknown }).value;
        b = b.not(inner.column, inner.op, value) as typeof b;
      } else if (f.op === "in") b = b.in(f.column, f.values) as typeof b;
      else b = b[f.op](f.column, (f as { value: unknown }).value) as typeof b;
    }
    for (const o of r.orders) b = b.order(o.column, { ascending: o.ascending }) as typeof b;
    if (r.range) b = b.range(r.range[0], r.range[1]) as typeof b;
    if (r.limit !== null) b = b.limit(r.limit) as typeof b;
    if (r.single === "single") b = b.single() as typeof b;
    if (r.single === "maybe") b = b.maybeSingle() as typeof b;
    if (r.signal) b = b.abortSignal(r.signal) as typeof b;
    return (await (b as unknown as PromiseLike<Result>)) as Result;
  }

  async function execute(r: Call): Promise<Result> {
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
      if (r.kind === "rpc") return await runRpc(r);
      if ((P6_TABLES as readonly string[]).includes(r.target) && !ENGINE_P6.has(r.target)) return await delegate(r);
      return runTable(r);
    } catch (err) {
      return { data: null, count: null, error: errorOf(err) };
    }
  }

  function settle(r: Call): Promise<Result> {
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

  function builder(r: Call) {
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
      order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) {
        r.orders.push({ column, ascending: options?.ascending !== false, ...(options?.nullsFirst !== undefined ? { nullsFirst: options.nullsFirst } : {}) });
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

  const request = (kind: FakeSlackDbCall["kind"], target: string, payload: unknown = null, options: Record<string, unknown> | null = null): Call => ({
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
