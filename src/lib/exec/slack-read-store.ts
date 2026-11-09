import "server-only";

import { loadSettings } from "@/lib/exec/principal";
import { getReadingHalf } from "@/lib/exec/slack-install";
import type {
  AcceptEventV2Result,
  CandidateRow,
  ChannelClass,
  ChannelRow,
  ClassRow,
  ConvType,
  DeletedReason,
  DenyReason,
  FromHimRow,
  HubKind,
  ItemOutcome,
  ItemSourceClass,
  ItemWriteRow,
  MeteredMethod,
  MuteSource,
  NoteRow,
  RateClass,
  SlackItemKind,
  SlackItemRow,
  TriageState,
  WatchState
} from "@/lib/exec/slack-read-types";
import { compareTs, slackMsgFingerprint } from "@/lib/exec/slack-read-types";
import type { SlackEventFacts } from "@/lib/exec/slack-types";
import type { ExecPrincipal, JobLane } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7a Slack reading store (P7a contract §3.8; Area A; server-only): every read
// and write of the nine P7a tables and the P7a functions of the migration's
// lockdown list (boundary rule B-P7a-2; exec_slack_fb_lead_channels is
// sources/dd.ts's, and the installation's user half is slack-install.ts's).
//
//   * Errors are SlackReadStoreError(op, pgCode): the function's name and the
//     database's own code, never a value this module was handed or read (no
//     ids, ts values, names or text in a message, §0.3 rule 4). An aborted
//     signal wins: its reason is thrown instead.
//   * A missing table / function / column (isSlackReadingSchemaMissing) maps to
//     the signature's "not installed" value: null, 0, [], an empty record or a
//     zero count. A write that returns nothing (void) or a discriminated union
//     that can't say "not installed" throws SlackReadStoreError("not_installed",
//     code) instead (§3.8.2), and so do purgeAuthor and the limiter's take (a
//     store error never allows an unmetered call).
//   * RPC rows are built with the identical key set (§0.3 rule 10): the
//     payload types of slack-read-types.ts, checked here before the call.
//   * Slack ts values compare with compareTs (numeric), never as strings; the
//     database compares them as numeric in the RPCs.
//   * Nothing here logs.

const CHANNELS = "exec_slack_channels";
const THREADS = "exec_slack_threads";
const MESSAGES = "exec_slack_messages";
const ITEMS = "exec_slack_items";
const DELETED = "exec_slack_deleted";
const RATE = "exec_slack_rate";
const DD_BOT = "exec_slack_dd_bot";
const PURGE_LOG = "exec_slack_purge_log";
const OPTOUTS = "exec_slack_author_optouts";

const RPC_ACCEPT_V2 = "exec_slack_accept_event_v2";
const RPC_NOTE_MESSAGES = "exec_slack_note_messages";
const RPC_NOTE_FROM_HIM = "exec_slack_note_from_him";
const RPC_SAVE_THREAD_WATERMARK = "exec_slack_save_thread_watermark";
const RPC_MARK_DELETED = "exec_slack_mark_deleted";
const RPC_PURGE_CONVERSATION = "exec_slack_purge_conversation";
const RPC_WRITE_ITEMS = "exec_slack_write_items";
const RPC_APPLY_CLASSES = "exec_slack_apply_classes";
const RPC_FINISH_DISCOVERY = "exec_slack_finish_discovery";
const RPC_PURGE_READING = "exec_slack_purge_reading";
const RPC_USER_REVOKE = "exec_slack_user_revoke";
const RPC_RATE_TAKE = "exec_slack_rate_take";
const RPC_RATE_BLOCK = "exec_slack_rate_block";
const RPC_REKEY = "exec_slack_rekey_channel";
const RPC_PURGE_EXPIRED = "exec_slack_purge_expired";
const RPC_SET_WATCH = "exec_slack_set_watch";
const RPC_PURGE_AUTHOR = "exec_slack_purge_author";

const CHANNEL_COLS =
  "channel_id,installation_id,conv_type,class,deny_reason,hub_kind,finance_name,watch_state,mute_source,watch_set_by_owner_at," +
  "name,im_user_id,is_member,is_private,is_ext_shared,ext_ever,is_archived,hist_watermark_ts,deep_swept_at,swept_at," +
  "last_event_ts,last_activity_ts,activity_30d,probed_at,classified_at,left_at,updated_at";
const CANDIDATE_COLS = "ts,thread_ts,author_user_id,author_external,reasons,triage_state,content_hash,edited_ts,responded_ts";
const ITEM_COLS =
  "id,channel_id,ts,kind,thread_ts,author_user_id,author_label,author_external,assessed,addressed_to_you,needs_response," +
  "bypass_mute,urgency,summary,excerpt,due_text,due_at,commitment_direction,source_class,permalink,responded_ts,responded_at," +
  "acknowledged_at,expires_at,created_at";
const THREAD_COLS = "thread_ts,he_posted_ts,reply_watermark_ts,latest_reply_seen_ts";

/** Missing table (42P01, PGRST205), function (42883, PGRST202) or column (42703, PGRST204): the P7a migration isn't applied. */
const SCHEMA_MISSING_CODES: ReadonlySet<string> = new Set(["42P01", "PGRST205", "42883", "PGRST202", "42703", "PGRST204"]);
const FUNCTION_MISSING_CODES: ReadonlySet<string> = new Set(["42883", "PGRST202"]);
const PG_CODE = /^[A-Z0-9]{2,10}$/;
const TS = /^[0-9]{1,12}\.[0-9]{1,8}$/;
const CHANNEL = /^[CGD][A-Z0-9]{2,30}$/;
const USER = /^[UW][A-Z0-9]{2,30}$/;
const TEAM = /^T[A-Z0-9]{2,30}$/;
const INSTALLATION = /^esi_[0-9a-f]{32}$/;
const ITEM_ID = /^esl_[0-9a-f]{32}$/;
const PERMALINK = /^https:\/\/[a-z0-9][a-z0-9-]*\.slack\.com\/archives\/[CGD][A-Z0-9]{2,30}\/p[0-9]{10,20}/;
const DB_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

const CONV_TYPES: readonly ConvType[] = ["channel", "group", "im", "mpim"];
const CLASSES: readonly ChannelClass[] = ["unclassified", "deny", "hub", "finance", "external", "standard"];
const DENY_REASONS: readonly DenyReason[] = ["assistant_dm", "dd_bot_dm", "self_dm", "bot_im", "fb_list", "lead_name"];
const HUB_KINDS: readonly HubKind[] = ["outbound", "client_email"];
const WATCH_STATES: readonly WatchState[] = ["watched", "muted", "unwatched"];
const MUTE_SOURCES: readonly MuteSource[] = ["owner", "default_finance", "slack"];
const ITEM_KINDS: readonly SlackItemKind[] = ["request", "question", "decision", "commitment", "action_item", "fyi"];
const TRIAGE_STATES: readonly TriageState[] = ["pending", "assessed", "unassessed", "refused", "failed", "skipped"];
const SOURCE_CLASSES: readonly ItemSourceClass[] = ["public", "private", "finance"];
const URGENCIES = ["critical", "high", "normal", "low"] as const;
const DIRECTIONS = ["mitchell_owes", "owed_to_mitchell"] as const;
const METHODS: readonly MeteredMethod[] = [
  "conversations.history", "conversations.replies", "conversations.info", "users.conversations",
  "conversations.list", "users.list", "users.info", "chat.getPermalink"
];
const RATE_CLASSES: readonly RateClass[] = ["triage", "sweep", "probe", "discovery"];
const PURGE_REASONS = ["left", "lost_access", "deleted", "deny", "gone"] as const;
const REVOKE_REASONS = ["stopped", "tokens_revoked", "disconnected", "app_uninstalled"] as const;
const DELETED_REASONS: readonly DeletedReason[] = ["event", "absent", "tombstone"];

/** The identical key sets of the RPC row payloads (slack-read-types.ts). */
const CLASS_ROW_KEYS = [
  "channel_id", "conv_type", "class", "deny_reason", "hub_kind", "finance_name", "default_watch", "default_mute", "name", "im_user_id",
  "is_member", "is_private", "is_ext_shared", "is_archived"
] as const;
const NOTE_ROW_KEYS = ["ts", "thread_ts", "role", "author", "author_external", "reasons", "dd_paths"] as const;
const FROM_HIM_KEYS = ["ts", "thread_ts", "mentions"] as const;
const ITEM_ROW_KEYS = [
  "ts", "kind", "author", "author_label", "author_external", "author_internal_verified", "assessed", "addressed", "needs_response",
  "bypass_mute", "urgency", "summary", "excerpt", "due_text", "due_at", "direction", "source_class"
] as const;
const OUTCOME_KEYS = ["ts", "state", "content_hash"] as const;

/** The RPC chunk sizes the functions accept (their own guards). */
const APPLY_CHUNK = 200;
const NOTE_CHUNK = 500;
const MARK_CHUNK = 500;
const WRITE_OUTCOMES_CHUNK = 100;
const WRITE_ROWS_MAX = 200;
const IN_CHUNK = 100;
const PAGE = 1000;
const MAX_PAGES = 20;
const ATTENTION_WINDOW_MS = 14 * 86_400_000;
const COMMITMENT_OVERDUE_MS = 30 * 86_400_000;

/** Never content in the message. Constructor frozen at stage 0. */
export class SlackReadStoreError extends Error {
  readonly op: string;
  readonly pgCode: string | null;
  constructor(op: string, pgCode: string | null) {
    super(`exec slack reading store: ${op} failed${pgCode ? ` (${pgCode})` : ""}`);
    this.name = "SlackReadStoreError";
    this.op = op;
    this.pgCode = pgCode;
  }
}

type DbError = { code?: string | null; message?: string | null };
type Row = Record<string, unknown>;
type Result = { data: unknown; error: DbError | null; count?: number | null };

const db = () => getSupabaseAdmin();

function pgCodeOf(error: DbError | null | undefined): string | null {
  const code = error?.code;
  return typeof code === "string" && PG_CODE.test(code) ? code : null;
}

function missing(error: DbError | null | undefined): boolean {
  const code = pgCodeOf(error);
  return code !== null && SCHEMA_MISSING_CODES.has(code);
}

/** 42P01, PGRST205, 42883, PGRST202, 42703, PGRST204. */
export function isSlackReadingSchemaMissing(err: unknown): boolean {
  if (err instanceof SlackReadStoreError) return err.pgCode !== null && SCHEMA_MISSING_CODES.has(err.pgCode);
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && SCHEMA_MISSING_CODES.has(code);
}

/** The error for a failed request: the abort reason when the signal fired, else SlackReadStoreError(op, code). */
function failure(op: string, error: DbError | null | undefined, signal?: AbortSignal): SlackReadStoreError {
  signal?.throwIfAborted();
  return new SlackReadStoreError(op, pgCodeOf(error));
}

/** A missing schema where the signature can't say "not installed". */
function notInstalled(error: DbError | null | undefined, signal?: AbortSignal): SlackReadStoreError {
  signal?.throwIfAborted();
  return new SlackReadStoreError("not_installed", pgCodeOf(error));
}

function requirePrincipal(principal: ExecPrincipal): string {
  if (!principal || typeof principal.id !== "string" || principal.id.length === 0) {
    throw new TypeError("exec slack reading store: an ExecPrincipal is required");
  }
  return principal.id;
}

const bad = (fn: string, what: string) => new TypeError(`exec slack reading store: ${fn}: ${what}`);

function requireChannel(fn: string, channelId: string): void {
  if (typeof channelId !== "string" || !CHANNEL.test(channelId)) throw bad(fn, "malformed channel id");
}

function requireTs(fn: string, ts: unknown): asserts ts is string {
  if (typeof ts !== "string" || !TS.test(ts)) throw bad(fn, "malformed ts");
}

function withSignal<T extends { abortSignal(signal: AbortSignal): T }>(q: T, signal: AbortSignal | undefined): T {
  return signal ? q.abortSignal(signal) : q;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown): boolean => v === true;
const int = (v: unknown): number => {
  const n = typeof v === "string" && /^-?[0-9]+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
};
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null);
const clampInt = (n: unknown, lo: number, hi: number, fallback: number): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : fallback;
const isTime = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Every row carries exactly `keys` (identical key sets, §0.3 rule 10). */
function requireKeys(fn: string, rows: readonly object[], keys: readonly string[]): void {
  const want = [...keys].sort().join(",");
  for (const r of rows) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) throw bad(fn, "a row is not an object");
    if (Object.keys(r).sort().join(",") !== want) throw bad(fn, "every row must carry exactly the payload type's keys");
  }
}

/** A JSON-only copy of the rows in key order (undefined never reaches PostgREST). */
function payload<T extends object>(rows: readonly T[], keys: readonly string[]): Row[] {
  return rows.map((r) => {
    const out: Row = {};
    for (const k of keys) out[k] = (r as Row)[k] ?? null;
    return out;
  });
}

function rowsOf(result: Result): Row[] {
  return Array.isArray(result.data) ? (result.data as Row[]) : [];
}

/** An RPC's jsonb answer as an object (else a malformed-answer error). */
function answer(op: string, data: unknown): Row {
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new SlackReadStoreError(`${op}: malformed answer`, null);
  return data as Row;
}

/** An RPC answer's numeric fields (booleans as 1/0), for the Record<string, number> results. */
function counts(r: Row): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === "boolean") out[k] = v ? 1 : 0;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

async function rpc(fn: string, args: Row, signal?: AbortSignal): Promise<Result> {
  const q = db().rpc(fn, args);
  return (await (signal ? q.abortSignal(signal) : q)) as Result;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toChannelRow(r: Row, op: string): ChannelRow {
  const channelId = str(r.channel_id);
  const installationId = str(r.installation_id);
  const convType = oneOf(r.conv_type, CONV_TYPES);
  const cls = oneOf(r.class, CLASSES);
  const watchState = oneOf(r.watch_state, WATCH_STATES);
  const updatedAt = str(r.updated_at);
  if (!channelId || !installationId || !convType || !cls || !watchState || !updatedAt) throw new SlackReadStoreError(`${op}: malformed row`, null);
  return {
    channelId,
    installationId,
    convType,
    class: cls,
    denyReason: oneOf(r.deny_reason, DENY_REASONS),
    hubKind: oneOf(r.hub_kind, HUB_KINDS),
    financeName: bool(r.finance_name),
    watchState,
    muteSource: oneOf(r.mute_source, MUTE_SOURCES),
    watchSetByOwnerAt: str(r.watch_set_by_owner_at),
    name: str(r.name),
    imUserId: str(r.im_user_id),
    isMember: bool(r.is_member),
    isPrivate: r.is_private !== false,
    isExtShared: bool(r.is_ext_shared),
    extEver: bool(r.ext_ever),
    isArchived: bool(r.is_archived),
    histWatermarkTs: str(r.hist_watermark_ts),
    deepSweptAt: str(r.deep_swept_at),
    sweptAt: str(r.swept_at),
    lastEventTs: str(r.last_event_ts),
    lastActivityTs: str(r.last_activity_ts),
    activity30d: typeof r.activity_30d === "number" && Number.isSafeInteger(r.activity_30d) ? r.activity_30d : null,
    probedAt: str(r.probed_at),
    classifiedAt: str(r.classified_at),
    leftAt: str(r.left_at),
    updatedAt
  };
}

function toCandidateRow(r: Row, op: string): CandidateRow {
  const ts = str(r.ts);
  const triageState = oneOf(r.triage_state, [...TRIAGE_STATES]);
  if (!ts || !triageState) throw new SlackReadStoreError(`${op}: malformed row`, null);
  return {
    ts,
    threadTs: str(r.thread_ts),
    authorUserId: str(r.author_user_id),
    authorExternal: bool(r.author_external),
    reasons: int(r.reasons),
    triageState,
    contentHash: str(r.content_hash),
    editedTs: str(r.edited_ts),
    respondedTs: str(r.responded_ts)
  };
}

function toItemRow(r: Row, op: string): SlackItemRow {
  const id = str(r.id);
  const channelId = str(r.channel_id);
  const ts = str(r.ts);
  const kind = oneOf(r.kind, ITEM_KINDS);
  const urgency = oneOf(r.urgency, URGENCIES);
  const sourceClass = oneOf(r.source_class, SOURCE_CLASSES);
  const expiresAt = str(r.expires_at);
  const createdAt = str(r.created_at);
  if (!id || !channelId || !ts || !kind || !urgency || !sourceClass || !expiresAt || !createdAt) {
    throw new SlackReadStoreError(`${op}: malformed row`, null);
  }
  return {
    id,
    channelId,
    ts,
    kind,
    threadTs: str(r.thread_ts),
    authorUserId: str(r.author_user_id),
    authorLabel: str(r.author_label),
    authorExternal: bool(r.author_external),
    assessed: bool(r.assessed),
    addressedToYou: bool(r.addressed_to_you),
    needsResponse: bool(r.needs_response),
    bypassMute: bool(r.bypass_mute),
    urgency,
    summary: str(r.summary),
    excerpt: str(r.excerpt),
    dueText: str(r.due_text),
    dueAt: str(r.due_at),
    commitmentDirection: oneOf(r.commitment_direction, DIRECTIONS),
    sourceClass,
    permalink: str(r.permalink),
    respondedTs: str(r.responded_ts),
    respondedAt: str(r.responded_at),
    acknowledgedAt: str(r.acknowledged_at),
    expiresAt,
    createdAt
  };
}

/** Keyset-free paging by range for small principal-scoped tables (≤ MAX_PAGES × PAGE rows). */
async function pagedSelect(op: string, build: () => { range(from: number, to: number): PromiseLike<Result> }): Promise<Row[] | null> {
  const out: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await build().range(page * PAGE, page * PAGE + PAGE - 1);
    if (result.error) {
      if (missing(result.error)) return null;
      throw failure(op, result.error);
    }
    const rows = rowsOf(result);
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  throw new SlackReadStoreError(`${op}: too many rows`, null);
}

// ---------------------------------------------------------------------------
// The ack gate (RPC 10)
// ---------------------------------------------------------------------------

/** RPC 10 on opts.signal. Its named arguments are exactly v2's 21 parameter names (p_event_id … p_revoked_user_ids, p_ingest):
 *  PostgREST answers PGRST202 for a name mismatch too, so ST17 parses the names from the migration and compares (C48).
 *  { outcome: "v2_missing" } on 42883/PGRST202; other errors throw SlackReadStoreError. */
export async function acceptEventV2(facts: SlackEventFacts, ingest: Record<string, unknown> | null, opts: { signal: AbortSignal }): Promise<AcceptEventV2Result> {
  const signal = opts?.signal;
  const { data, error } = await rpc(
    RPC_ACCEPT_V2,
    {
      p_event_id: facts.eventId,
      p_team_id: facts.teamId,
      p_api_app_id: facts.apiAppId,
      p_event_type: facts.eventType,
      p_event_time: facts.eventTime,
      p_retry_num: facts.retryNum,
      p_channel: facts.channel,
      p_channel_type: facts.channelType,
      p_user: facts.user,
      p_ts: facts.ts,
      p_thread_ts: facts.threadTs,
      p_has_bot_id: facts.hasBotId,
      p_has_app_id: facts.hasAppId,
      p_subtype: facts.subtype,
      p_hidden: facts.hidden,
      p_text_is_string: facts.textIsString,
      p_has_message: facts.hasMessage,
      p_tab: facts.tab,
      p_revoked_bot_ids: facts.revokedBotIds,
      p_revoked_user_ids: facts.revokedUserIds,
      p_ingest: ingest ?? null
    },
    signal
  );
  if (error) {
    signal?.throwIfAborted();
    const code = pgCodeOf(error);
    if (code !== null && FUNCTION_MISSING_CODES.has(code)) return { outcome: "v2_missing" };
    if (missing(error)) return { outcome: "not_installed" };
    throw failure("acceptEventV2", error, signal);
  }
  const r = answer("acceptEventV2", data);
  const path = r.path === "v1" || r.path === "v2" ? r.path : null;
  if (path === null) throw new SlackReadStoreError("acceptEventV2: malformed answer", null);
  if (r.outcome === "duplicate") return { outcome: "duplicate", path };
  if (r.outcome === "not_installed") return { outcome: "not_installed" };
  if (r.outcome === "accepted" && typeof r.decision === "string" && (r.reason === null || r.reason === undefined || typeof r.reason === "string")) {
    const out: Extract<AcceptEventV2Result, { outcome: "accepted" }> = {
      outcome: "accepted",
      decision: r.decision,
      reason: typeof r.reason === "string" ? r.reason : null,
      path
    };
    if (typeof r.recorded === "boolean") out.recorded = r.recorded;
    if (typeof r.enqueued === "boolean") out.enqueued = r.enqueued;
    if (typeof r.interactive === "boolean") out.interactive = r.interactive;
    return out;
  }
  throw new SlackReadStoreError("acceptEventV2: malformed answer", null);
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export async function getChannel(principal: ExecPrincipal, channelId: string): Promise<ChannelRow | null> {
  const pid = requirePrincipal(principal);
  if (typeof channelId !== "string" || !CHANNEL.test(channelId)) return null;
  const result = (await db().from(CHANNELS).select(CHANNEL_COLS).eq("principal_id", pid).eq("channel_id", channelId).limit(1)) as Result;
  if (result.error) {
    if (missing(result.error)) return null;
    throw failure("getChannel", result.error);
  }
  const r = rowsOf(result)[0];
  return r ? toChannelRow(r, "getChannel") : null;
}

/** conv_type channel|group, class not deny; at most `limit` (1..1,000): the watched and muted rows first (C29: he must always
 *  be able to unwatch or mute what is read), then unwatched rows fill what is left; each part by name (then id). */
export async function listPickerChannels(principal: ExecPrincipal, limit: number): Promise<ChannelRow[]> {
  const pid = requirePrincipal(principal);
  const n = clampInt(limit, 1, 1000, 1000);
  const part = (states: readonly WatchState[], max: number) =>
    db()
      .from(CHANNELS)
      .select(CHANNEL_COLS)
      .eq("principal_id", pid)
      .in("conv_type", ["channel", "group"])
      .neq("class", "deny")
      .in("watch_state", [...states])
      .order("name", { ascending: true })
      .order("channel_id", { ascending: true })
      .limit(max);
  const read = (await part(["watched", "muted"], n)) as Result;
  if (read.error) {
    if (missing(read.error)) return [];
    throw failure("listPickerChannels", read.error);
  }
  const out = rowsOf(read).map((r) => toChannelRow(r, "listPickerChannels"));
  if (out.length >= n) return out.slice(0, n);
  const rest = (await part(["unwatched"], n - out.length)) as Result;
  if (rest.error) {
    if (missing(rest.error)) return out;
    throw failure("listPickerChannels", rest.error);
  }
  return [...out, ...rowsOf(rest).map((r) => toChannelRow(r, "listPickerChannels"))].slice(0, n);
}

/** C29: byWatch over the public and private channels that aren't deny or hub rows; deny rows by reason (counts only, never
 *  names); hubs; DMs and group DMs as watched / total (deny rows excluded). Missing schema → all zero. */
export async function countChannels(principal: ExecPrincipal): Promise<{ byWatch: Record<WatchState, number>; denyByReason: Partial<Record<DenyReason, number>>;
  hubs: number; dms: { watched: number; total: number }; groupDms: { watched: number; total: number } }> {
  const pid = requirePrincipal(principal);
  const out = {
    byWatch: { watched: 0, muted: 0, unwatched: 0 } as Record<WatchState, number>,
    denyByReason: {} as Partial<Record<DenyReason, number>>,
    hubs: 0,
    dms: { watched: 0, total: 0 },
    groupDms: { watched: 0, total: 0 }
  };
  const rows = await pagedSelect("countChannels", () =>
    db().from(CHANNELS).select("channel_id,conv_type,class,deny_reason,watch_state").eq("principal_id", pid).order("channel_id", { ascending: true })
  );
  for (const r of rows ?? []) {
    const cls = oneOf(r.class, CLASSES);
    const conv = oneOf(r.conv_type, CONV_TYPES);
    const watch = oneOf(r.watch_state, WATCH_STATES);
    if (!cls || !conv || !watch) continue;
    if (cls === "deny") {
      const reason = oneOf(r.deny_reason, DENY_REASONS);
      if (reason) out.denyByReason[reason] = (out.denyByReason[reason] ?? 0) + 1;
      continue;
    }
    if (conv === "im" || conv === "mpim") {
      const bucket = conv === "im" ? out.dms : out.groupDms;
      bucket.total += 1;
      if (watch === "watched") bucket.watched += 1;
      continue;
    }
    if (cls === "hub") {
      out.hubs += 1;
      continue;
    }
    out.byWatch[watch] += 1;
  }
  return out;
}

const SWEEP_CLASSES = ["standard", "external", "finance", "hub"] as const;
const DM_TYPES: ReadonlySet<ConvType> = new Set<ConvType>(["im", "mpim"]);

/** The sweep's order: never swept first, then the oldest sweep; a DM or group DM wins a tie; then the id. */
function sweepOrder(a: ChannelRow, b: ChannelRow): number {
  const at = (c: ChannelRow) => (c.sweptAt === null ? Number.NEGATIVE_INFINITY : Date.parse(c.sweptAt));
  const x = at(a);
  const y = at(b);
  if (x !== y) return x < y ? -1 : 1;
  const dm = Number(DM_TYPES.has(b.convType)) - Number(DM_TYPES.has(a.convType));
  if (dm !== 0) return dm;
  return a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0;
}

/** class in (standard, external, finance, hub), not archived, left_at null, and watched or muted by him or Slack (N11: their
 *  DMs and mentions bypass the mute, so the sweep is their backstop too; N1's finance default mute is never swept). One order
 *  across every conversation type (correctness-2: a DM never starves the channels): never swept first, then the oldest
 *  sweep, a DM or group DM winning a tie. */
export async function listSweepTargets(principal: ExecPrincipal, limit: number): Promise<ChannelRow[]> {
  const pid = requirePrincipal(principal);
  const n = clampInt(limit, 1, 1000, 200);
  const base = (convTypes: readonly ConvType[], max: number) =>
    db()
      .from(CHANNELS)
      .select(CHANNEL_COLS)
      .eq("principal_id", pid)
      .in("class", [...SWEEP_CLASSES])
      .in("conv_type", [...convTypes])
      .eq("is_archived", false)
      .is("left_at", null)
      .order("swept_at", { ascending: true, nullsFirst: true })
      .order("channel_id", { ascending: true })
      .limit(max);
  // Each part is its own top n by the same order, so their merge holds the overall top n.
  const parts = [
    () => base(["im", "mpim"], n).eq("watch_state", "watched"),
    () => base(["im", "mpim"], n).eq("watch_state", "muted").in("mute_source", ["owner", "slack"]),
    () => base(["channel", "group"], n).eq("watch_state", "watched"),
    () => base(["channel", "group"], n).eq("watch_state", "muted").in("mute_source", ["owner", "slack"])
  ];
  const out: ChannelRow[] = [];
  for (const part of parts) {
    const result = (await part()) as Result;
    if (result.error) {
      if (missing(result.error)) return [];
      throw failure("listSweepTargets", result.error);
    }
    for (const r of rowsOf(result)) out.push(toChannelRow(r, "listSweepTargets"));
  }
  return out.sort(sweepOrder).slice(0, n);
}

/** Unjoined public channels of class standard / external (not archived), never probed or probed before staleBefore;
 *  never-probed first, then the oldest probe. */
export async function listProbeTargets(principal: ExecPrincipal, staleBefore: string, limit: number): Promise<ChannelRow[]> {
  const pid = requirePrincipal(principal);
  if (!isTime(staleBefore)) throw bad("listProbeTargets", "staleBefore must be a timestamp");
  const n = clampInt(limit, 1, 500, 30);
  const base = () =>
    db()
      .from(CHANNELS)
      .select(CHANNEL_COLS)
      .eq("principal_id", pid)
      .eq("conv_type", "channel")
      .in("class", ["standard", "external"])
      .eq("is_member", false)
      .eq("is_archived", false);
  const never = (await base().is("probed_at", null).order("channel_id", { ascending: true }).limit(n)) as Result;
  if (never.error) {
    if (missing(never.error)) return [];
    throw failure("listProbeTargets", never.error);
  }
  const out = rowsOf(never).map((r) => toChannelRow(r, "listProbeTargets"));
  if (out.length >= n) return out;
  const stale = (await base()
    .lt("probed_at", new Date(Date.parse(staleBefore)).toISOString())
    .order("probed_at", { ascending: true })
    .order("channel_id", { ascending: true })
    .limit(n - out.length)) as Result;
  if (stale.error) {
    if (missing(stale.error)) return out;
    throw failure("listProbeTargets", stale.error);
  }
  return [...out, ...rowsOf(stale).map((r) => toChannelRow(r, "listProbeTargets"))];
}

/** class unclassified, oldest row first. */
export async function listUnclassified(principal: ExecPrincipal, limit: number): Promise<ChannelRow[]> {
  const pid = requirePrincipal(principal);
  const result = (await db()
    .from(CHANNELS)
    .select(CHANNEL_COLS)
    .eq("principal_id", pid)
    .eq("class", "unclassified")
    .order("created_at", { ascending: true })
    .order("channel_id", { ascending: true })
    .limit(clampInt(limit, 1, 1000, 100))) as Result;
  if (result.error) {
    if (missing(result.error)) return [];
    throw failure("listUnclassified", result.error);
  }
  return rowsOf(result).map((r) => toChannelRow(r, "listUnclassified"));
}

/** RPC 12, in chunks of 200 rows. Missing → zeros. */
export async function applyClasses(principal: ExecPrincipal, installationId: string, rows: readonly ClassRow[], runStartedAt: string):
  Promise<{ upserted: number; denied: number; purged: number }> {                                   // RPC 12
  const pid = requirePrincipal(principal);
  if (typeof installationId !== "string" || !INSTALLATION.test(installationId)) throw bad("applyClasses", "malformed installation id");
  if (!isTime(runStartedAt)) throw bad("applyClasses", "runStartedAt must be a timestamp");
  if (!Array.isArray(rows)) throw bad("applyClasses", "rows must be an array");
  requireKeys("applyClasses", rows, CLASS_ROW_KEYS);
  const total = { upserted: 0, denied: 0, purged: 0 };
  for (const chunk of chunks(rows, APPLY_CHUNK)) {
    const { data, error } = await rpc(RPC_APPLY_CLASSES, {
      p_principal: pid,
      p_installation_id: installationId,
      p_rows: payload(chunk, CLASS_ROW_KEYS),
      p_run_started_at: runStartedAt
    });
    if (error) {
      if (missing(error)) return total;
      throw failure("applyClasses", error);
    }
    const r = answer("applyClasses", data);
    total.upserted += int(r.upserted);
    total.denied += int(r.denied);
    total.purged += int(r.purged);
  }
  return total;
}

/** RPC 13. Missing → { ready: false, removed: 0 }. */
export async function finishDiscovery(principal: ExecPrincipal, installationId: string, runStartedAt: string): Promise<{ ready: boolean; removed: number }> {  // RPC 13
  const pid = requirePrincipal(principal);
  if (typeof installationId !== "string" || !INSTALLATION.test(installationId)) return { ready: false, removed: 0 };
  if (!isTime(runStartedAt)) throw bad("finishDiscovery", "runStartedAt must be a timestamp");
  const { data, error } = await rpc(RPC_FINISH_DISCOVERY, { p_principal: pid, p_installation_id: installationId, p_run_started_at: runStartedAt });
  if (error) {
    if (missing(error)) return { ready: false, removed: 0 };
    throw failure("finishDiscovery", error);
  }
  const r = answer("finishDiscovery", data);
  return { ready: r.ready === true, removed: int(r.removed) };
}

export type SetWatchOutcome = { outcome: "updated"; updatedAt: string } | { outcome: "conflict"; updatedAt: string }
  | { outcome: "confirmation_required" } | { outcome: "refused"; class: string } | { outcome: "not_found" };

/** RPC 20. A missing schema throws SlackReadStoreError("not_installed") (the union can't say it). */
export async function setWatch(principal: ExecPrincipal, channelId: string, watch: WatchState, expected: string, allowFinance: boolean): Promise<SetWatchOutcome> {  // RPC 20
  const pid = requirePrincipal(principal);
  if (!(WATCH_STATES as readonly string[]).includes(watch)) throw bad("setWatch", "unknown watch state");
  if (typeof channelId !== "string" || !CHANNEL.test(channelId)) return { outcome: "not_found" };
  const expectedAt = typeof expected === "string" && DB_TIMESTAMP.test(expected) ? expected : null;
  const { data, error } = await rpc(RPC_SET_WATCH, {
    p_principal: pid,
    p_channel: channelId,
    p_watch: watch,
    p_expected: expectedAt,
    p_allow_finance: allowFinance === true
  });
  if (error) {
    if (missing(error)) throw notInstalled(error);
    throw failure("setWatch", error);
  }
  const r = answer("setWatch", data);
  switch (r.outcome) {
    case "updated":
    case "conflict":
      if (typeof r.updated_at !== "string") throw new SlackReadStoreError("setWatch: malformed answer", null);
      return { outcome: r.outcome, updatedAt: r.updated_at };
    case "confirmation_required":
      return { outcome: "confirmation_required" };
    case "refused":
      return { outcome: "refused", class: typeof r.class === "string" ? r.class : "unknown" };
    case "not_found":
      return { outcome: "not_found" };
    default:
      throw new SlackReadStoreError("setWatch: malformed answer", null);
  }
}

/** update … where principal, channel and class not in ('deny','unclassified'). Watermark progress only: updated_at (the
 *  picker's CAS token) doesn't move, so a sweep never makes his open picker conflict. A null watermark / activity keeps
 *  the stored one. */
export async function saveSweepProgress(principal: ExecPrincipal, channelId: string, p: { histWatermarkTs: string | null;
  deep: boolean; sweptAt: string; lastActivityTs: string | null }): Promise<void> {
  const pid = requirePrincipal(principal);
  requireChannel("saveSweepProgress", channelId);
  if (!p || !isTime(p.sweptAt)) throw bad("saveSweepProgress", "sweptAt must be a timestamp");
  if (p.histWatermarkTs !== null) requireTs("saveSweepProgress", p.histWatermarkTs);
  if (p.lastActivityTs !== null) requireTs("saveSweepProgress", p.lastActivityTs);
  const sweptAt = new Date(Date.parse(p.sweptAt)).toISOString();
  const patch: Row = { swept_at: sweptAt };
  if (p.deep === true) patch.deep_swept_at = sweptAt;
  if (p.histWatermarkTs !== null) patch.hist_watermark_ts = p.histWatermarkTs;
  if (p.lastActivityTs !== null) patch.last_activity_ts = p.lastActivityTs;
  const { error } = (await db()
    .from(CHANNELS)
    .update(patch)
    .eq("principal_id", pid)
    .eq("channel_id", channelId)
    .not("class", "in", "(deny,unclassified)")) as Result;
  if (error) {
    if (missing(error)) throw notInstalled(error);
    throw failure("saveSweepProgress", error);
  }
}

/** activity and probed_at; watch_state only when watch_set_by_owner_at is null, class in (standard, external) and not finance_name
 *  (and never a muted row: probes move only between watched and unwatched). */
export async function saveProbe(principal: ExecPrincipal, channelId: string, p: { activity30d: number; lastActivityTs: string | null; probedAt: string; watch: "watched" | "unwatched" }): Promise<void> {
  const pid = requirePrincipal(principal);
  requireChannel("saveProbe", channelId);
  if (!p || !isTime(p.probedAt)) throw bad("saveProbe", "probedAt must be a timestamp");
  if (p.watch !== "watched" && p.watch !== "unwatched") throw bad("saveProbe", "watch must be watched or unwatched");
  if (p.lastActivityTs !== null) requireTs("saveProbe", p.lastActivityTs);
  const activity = clampInt(p.activity30d, 0, 100_000, 0);
  const metrics: Row = { activity_30d: activity, probed_at: new Date(Date.parse(p.probedAt)).toISOString() };
  if (p.lastActivityTs !== null) metrics.last_activity_ts = p.lastActivityTs;
  const first = (await db()
    .from(CHANNELS)
    .update(metrics)
    .eq("principal_id", pid)
    .eq("channel_id", channelId)
    .not("class", "in", "(deny,unclassified)")) as Result;
  if (first.error) {
    if (missing(first.error)) throw notInstalled(first.error);
    throw failure("saveProbe", first.error);
  }
  const second = (await db()
    .from(CHANNELS)
    .update({ watch_state: p.watch, mute_source: null, updated_at: new Date().toISOString() })
    .eq("principal_id", pid)
    .eq("channel_id", channelId)
    .is("watch_set_by_owner_at", null)
    .in("class", ["standard", "external"])
    .eq("finance_name", false)
    .neq("watch_state", "muted")
    .neq("watch_state", p.watch)) as Result;
  if (second.error) {
    if (missing(second.error)) throw notInstalled(second.error);
    throw failure("saveProbe", second.error);
  }
}

/** watch_mode → member_only: unjoined public channel rows the owner didn't set and the probe watched become unwatched. */
export async function unwatchUnjoined(principal: ExecPrincipal): Promise<number> {
  const pid = requirePrincipal(principal);
  const result = (await db()
    .from(CHANNELS)
    .update({ watch_state: "unwatched", mute_source: null, updated_at: new Date().toISOString() })
    .eq("principal_id", pid)
    .eq("conv_type", "channel")
    .eq("is_member", false)
    .is("watch_set_by_owner_at", null)
    .eq("watch_state", "watched")
    .in("class", ["standard", "external"])
    .select("channel_id")) as Result;
  if (result.error) {
    if (missing(result.error)) return 0;
    throw failure("unwatchUnjoined", result.error);
  }
  return rowsOf(result).length;
}

/** RPC 9. Missing → {}. */
export async function purgeConversation(principal: ExecPrincipal, channelId: string, reason: "left" | "lost_access" | "deleted" | "deny" | "gone"): Promise<Record<string, number>> { // RPC 9
  const pid = requirePrincipal(principal);
  if (!(PURGE_REASONS as readonly string[]).includes(reason)) throw bad("purgeConversation", "unknown reason");
  requireChannel("purgeConversation", channelId);
  const { data, error } = await rpc(RPC_PURGE_CONVERSATION, { p_principal: pid, p_channel: channelId, p_reason: reason });
  if (error) {
    if (missing(error)) return {};
    throw failure("purgeConversation", error);
  }
  return counts(answer("purgeConversation", data));
}

/** The channel row (its threads, messages and items cascade). Missing schema → SlackReadStoreError("not_installed"). */
export async function deleteChannelRow(principal: ExecPrincipal, channelId: string): Promise<void> {
  const pid = requirePrincipal(principal);
  requireChannel("deleteChannelRow", channelId);
  const { error } = (await db().from(CHANNELS).delete().eq("principal_id", pid).eq("channel_id", channelId)) as Result;
  if (error) {
    if (missing(error)) throw notInstalled(error);
    throw failure("deleteChannelRow", error);
  }
}

/** RPC 18. Missing → { rekeyed: false }. */
export async function rekeyChannel(principal: ExecPrincipal, oldId: string, newId: string): Promise<{ rekeyed: boolean }> {   // RPC 18
  const pid = requirePrincipal(principal);
  requireChannel("rekeyChannel", oldId);
  requireChannel("rekeyChannel", newId);
  const { data, error } = await rpc(RPC_REKEY, { p_principal: pid, p_old: oldId, p_new: newId });
  if (error) {
    if (missing(error)) return { rekeyed: false };
    throw failure("rekeyChannel", error);
  }
  return { rekeyed: answer("rekeyChannel", data).rekeyed === true };
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export async function listThreads(principal: ExecPrincipal, channelId: string, rootTs: readonly string[]): Promise<{ threadTs: string;
  hePostedTs: string | null; replyWatermarkTs: string | null; latestReplySeenTs: string | null }[]> {
  const pid = requirePrincipal(principal);
  requireChannel("listThreads", channelId);
  const roots = [...new Set((Array.isArray(rootTs) ? rootTs : []).filter((t) => typeof t === "string" && TS.test(t)))];
  const out: { threadTs: string; hePostedTs: string | null; replyWatermarkTs: string | null; latestReplySeenTs: string | null }[] = [];
  for (const chunk of chunks(roots, IN_CHUNK)) {
    const result = (await db().from(THREADS).select(THREAD_COLS).eq("principal_id", pid).eq("channel_id", channelId).in("thread_ts", chunk)) as Result;
    if (result.error) {
      if (missing(result.error)) return [];
      throw failure("listThreads", result.error);
    }
    for (const r of rowsOf(result)) {
      const threadTs = str(r.thread_ts);
      if (!threadTs) continue;
      out.push({ threadTs, hePostedTs: str(r.he_posted_ts), replyWatermarkTs: str(r.reply_watermark_ts), latestReplySeenTs: str(r.latest_reply_seen_ts) });
    }
  }
  return out.sort((a, b) => compareTs(a.threadTs, b.threadTs));
}

/** RPC 7b (exec_slack_save_thread_watermark): written under the channel row's lock, and only while the conversation's class
 *  may hold one (never a deny row, N1 rule 7: a sweep that read the row before a class change can't store a watermark
 *  after it). The watermark never moves back; expires_at = max(existing, latest + 14 d). A refused class writes nothing. */
export async function saveThreadWatermark(principal: ExecPrincipal, channelId: string, threadTs: string, p: { replyWatermarkTs: string;
  latestReplySeenTs: string }): Promise<void> {   // RPC 7b; frozen signature (void)
  const pid = requirePrincipal(principal);
  requireChannel("saveThreadWatermark", channelId);
  requireTs("saveThreadWatermark", threadTs);
  requireTs("saveThreadWatermark", p?.replyWatermarkTs);
  requireTs("saveThreadWatermark", p?.latestReplySeenTs);
  const { error } = await rpc(RPC_SAVE_THREAD_WATERMARK, {
    p_principal: pid,
    p_channel: channelId,
    p_thread_ts: threadTs,
    p_watermark: p.replyWatermarkTs,
    p_latest: p.latestReplySeenTs
  });
  if (error) {
    if (missing(error)) throw notInstalled(error);
    throw failure("saveThreadWatermark", error);
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** RPC 6, in chunks of 500. Missing → zeros. */
export async function noteMessages(principal: ExecPrincipal, channelId: string, rows: readonly NoteRow[], lane: JobLane, bucket: string):
  Promise<{ candidates: number; anchors: number; blocked: number; optedOut: number; jobs: number }> {   // RPC 6
  const pid = requirePrincipal(principal);
  requireChannel("noteMessages", channelId);
  if (lane !== "interactive" && lane !== "bulk") throw bad("noteMessages", "unknown lane");
  if (typeof bucket !== "string" || !/^[mb][0-9]{1,12}$/.test(bucket)) throw bad("noteMessages", "malformed bucket");
  if (!Array.isArray(rows)) throw bad("noteMessages", "rows must be an array");
  requireKeys("noteMessages", rows, NOTE_ROW_KEYS);
  const total = { candidates: 0, anchors: 0, blocked: 0, optedOut: 0, jobs: 0 };
  for (const chunk of chunks(rows, NOTE_CHUNK)) {
    const { data, error } = await rpc(RPC_NOTE_MESSAGES, {
      p_principal: pid,
      p_channel: channelId,
      p_rows: payload(chunk, NOTE_ROW_KEYS),
      p_lane: lane,
      p_bucket: bucket
    });
    if (error) {
      if (missing(error)) return total;
      throw failure("noteMessages", error);
    }
    const r = answer("noteMessages", data);
    total.candidates += int(r.candidates);
    total.anchors += int(r.anchors);
    total.blocked += int(r.blocked);
    total.optedOut += int(r.opted_out);
    total.jobs += int(r.jobs);
  }
  return total;
}

/** RPC 7, in chunks of 500. Missing → zeros. */
export async function noteFromHim(principal: ExecPrincipal, channelId: string, rows: readonly FromHimRow[]): Promise<{ stamped: number; skipped: number }> {  // RPC 7
  const pid = requirePrincipal(principal);
  requireChannel("noteFromHim", channelId);
  if (!Array.isArray(rows)) throw bad("noteFromHim", "rows must be an array");
  requireKeys("noteFromHim", rows, FROM_HIM_KEYS);
  const total = { stamped: 0, skipped: 0 };
  for (const chunk of chunks(rows, NOTE_CHUNK)) {
    const { data, error } = await rpc(RPC_NOTE_FROM_HIM, { p_principal: pid, p_channel: channelId, p_rows: payload(chunk, FROM_HIM_KEYS) });
    if (error) {
      if (missing(error)) return total;
      throw failure("noteFromHim", error);
    }
    const r = answer("noteFromHim", data);
    total.stamped += int(r.stamped);
    total.skipped += int(r.skipped);
  }
  return total;
}

/** RPC 8, in chunks of 500 ts values. Missing → zeros. */
export async function markDeleted(principal: ExecPrincipal, channelId: string, ts: readonly string[], reason: DeletedReason):
  Promise<{ items: number; messages: number; attention: number }> {                                // RPC 8
  const pid = requirePrincipal(principal);
  requireChannel("markDeleted", channelId);
  if (!(DELETED_REASONS as readonly string[]).includes(reason)) throw bad("markDeleted", "unknown reason");
  const list = [...new Set(Array.isArray(ts) ? ts : [])];
  for (const t of list) requireTs("markDeleted", t);
  const total = { items: 0, messages: 0, attention: 0 };
  for (const chunk of chunks(list, MARK_CHUNK)) {
    const { data, error } = await rpc(RPC_MARK_DELETED, { p_principal: pid, p_channel: channelId, p_ts: chunk, p_reason: reason });
    if (error) {
      if (missing(error)) return total;
      throw failure("markDeleted", error);
    }
    const r = answer("markDeleted", data);
    total.items += int(r.items);
    total.messages += int(r.messages);
    total.attention += int(r.attention);
  }
  return total;
}

/** mode window: role candidate, triage_state pending, and (root "c": thread_ts null) / (root = ts: ts = root or thread_ts = root)
 *  / (thread root: thread_ts = root or ts = root); mode retriage: the one ts, any role but anchor. Oldest first, ≤ 50. */
export async function listCandidates(principal: ExecPrincipal, channelId: string, root: string, mode: "window" | "retriage", ts?: string): Promise<CandidateRow[]> {
  const pid = requirePrincipal(principal);
  requireChannel("listCandidates", channelId);
  const op = "listCandidates";
  const take = async (q: PromiseLike<Result>): Promise<Row[] | null> => {
    const result = await q;
    if (result.error) {
      if (missing(result.error)) return null;
      throw failure(op, result.error);
    }
    return rowsOf(result);
  };
  if (mode === "retriage") {
    const one = typeof ts === "string" ? ts : root;
    requireTs(op, one);
    const rows = await take(db().from(MESSAGES).select(CANDIDATE_COLS).eq("principal_id", pid).eq("channel_id", channelId).eq("ts", one).neq("role", "anchor").limit(1));
    return (rows ?? []).map((r) => toCandidateRow(r, op));
  }
  if (mode !== "window") throw bad(op, "unknown mode");
  const pending = () => db().from(MESSAGES).select(CANDIDATE_COLS).eq("principal_id", pid).eq("channel_id", channelId).eq("role", "candidate").eq("triage_state", "pending");
  let rows: Row[];
  if (root === "c") {
    rows = (await take(pending().is("thread_ts", null).order("ts", { ascending: true }).limit(50))) ?? [];
  } else {
    requireTs(op, root);
    const own = (await take(pending().eq("ts", root).limit(1))) ?? [];
    const replies = (await take(pending().eq("thread_ts", root).order("ts", { ascending: true }).limit(50))) ?? [];
    rows = [...own, ...replies];
  }
  const seen = new Set<string>();
  const out: CandidateRow[] = [];
  for (const r of rows) {
    const c = toCandidateRow(r, op);
    if (seen.has(c.ts)) continue;
    seen.add(c.ts);
    out.push(c);
  }
  return out.sort((a, b) => compareTs(a.ts, b.ts)).slice(0, 50);
}

/** Top-level (threadTs null) or one thread's replies (thread_ts = threadTs): the stored ts values in [oldest, latest] (numeric). */
export async function listStoredTs(principal: ExecPrincipal, channelId: string, q: { oldest: string; latest: string; threadTs: string | null }): Promise<string[]> {
  const pid = requirePrincipal(principal);
  requireChannel("listStoredTs", channelId);
  requireTs("listStoredTs", q?.oldest);
  requireTs("listStoredTs", q?.latest);
  if (q.threadTs !== null) requireTs("listStoredTs", q.threadTs);
  const rows = await pagedSelect("listStoredTs", () => {
    const base = db().from(MESSAGES).select("ts").eq("principal_id", pid).eq("channel_id", channelId);
    return (q.threadTs === null ? base.is("thread_ts", null) : base.eq("thread_ts", q.threadTs)).order("ts", { ascending: true });
  });
  const out: string[] = [];
  for (const r of rows ?? []) {
    const t = str(r.ts);
    if (t && TS.test(t) && compareTs(t, q.oldest) >= 0 && compareTs(t, q.latest) <= 0) out.push(t);
  }
  return out.sort(compareTs);
}

/** C40: his reaction → acknowledged_at on the message rows (and their items) still without one. Returns the message rows set. */
export async function setAcknowledged(principal: ExecPrincipal, channelId: string, ts: readonly string[], at: string): Promise<number> {
  const pid = requirePrincipal(principal);
  requireChannel("setAcknowledged", channelId);
  if (!isTime(at)) throw bad("setAcknowledged", "at must be a timestamp");
  const list = [...new Set(Array.isArray(ts) ? ts : [])];
  for (const t of list) requireTs("setAcknowledged", t);
  const atIso = new Date(Date.parse(at)).toISOString();
  let n = 0;
  for (const chunk of chunks(list, IN_CHUNK)) {
    const msgs = (await db()
      .from(MESSAGES)
      .update({ acknowledged_at: atIso, updated_at: new Date().toISOString() })
      .eq("principal_id", pid)
      .eq("channel_id", channelId)
      .in("ts", chunk)
      .neq("role", "anchor")
      .is("acknowledged_at", null)
      .select("ts")) as Result;
    if (msgs.error) {
      if (missing(msgs.error)) return 0;
      throw failure("setAcknowledged", msgs.error);
    }
    n += rowsOf(msgs).length;
    const items = (await db()
      .from(ITEMS)
      .update({ acknowledged_at: atIso, updated_at: new Date().toISOString() })
      .eq("principal_id", pid)
      .eq("channel_id", channelId)
      .in("ts", chunk)
      .is("acknowledged_at", null)) as Result;
    if (items.error) {
      if (missing(items.error)) return n;
      throw failure("setAcknowledged", items.error);
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** RPC 11 — the only excerpt writer (N7). Outcomes in chunks of 100, each chunk with its own rows (≤ 200). The SQL derives
 *  source_class and the external rule from the locked rows; this function only checks shapes. Missing → nothing written
 *  (every outcome counted as refusedClass). */
export async function writeTriageResult(principal: ExecPrincipal, channelId: string, rows: readonly ItemWriteRow[], outcomes: readonly ItemOutcome[]):
  Promise<{ written: number; refusedDeleted: number; refusedMissing: number; refusedClass: number; refusedOptout: number;
            classMismatch: number }> {                                                              // RPC 11 — the only excerpt writer
  const pid = requirePrincipal(principal);
  requireChannel("writeTriageResult", channelId);
  if (!Array.isArray(rows) || !Array.isArray(outcomes)) throw bad("writeTriageResult", "rows and outcomes must be arrays");
  requireKeys("writeTriageResult", rows, ITEM_ROW_KEYS);
  requireKeys("writeTriageResult", outcomes, OUTCOME_KEYS);
  const outTs = new Set<string>();
  for (const o of outcomes) {
    requireTs("writeTriageResult", o.ts);
    if (outTs.has(o.ts)) throw bad("writeTriageResult", "one outcome per ts");
    outTs.add(o.ts);
  }
  for (const r of rows) {
    requireTs("writeTriageResult", r.ts);
    if (!outTs.has(r.ts)) throw bad("writeTriageResult", "an item without an outcome");
  }
  const total = { written: 0, refusedDeleted: 0, refusedMissing: 0, refusedClass: 0, refusedOptout: 0, classMismatch: 0 };
  for (const chunk of chunks(outcomes, WRITE_OUTCOMES_CHUNK)) {
    const keys = new Set(chunk.map((o) => o.ts));
    const mine = rows.filter((r) => keys.has(r.ts));
    if (mine.length > WRITE_ROWS_MAX) throw bad("writeTriageResult", `at most ${WRITE_ROWS_MAX} items per ${WRITE_OUTCOMES_CHUNK} outcomes`);
    const { data, error } = await rpc(RPC_WRITE_ITEMS, {
      p_principal: pid,
      p_channel: channelId,
      p_rows: payload(mine, ITEM_ROW_KEYS),
      p_outcomes: payload(chunk, OUTCOME_KEYS)
    });
    if (error) {
      if (missing(error)) {
        total.refusedClass += chunk.length;
        continue;
      }
      throw failure("writeTriageResult", error);
    }
    const r = answer("writeTriageResult", data);
    total.written += int(r.written);
    total.refusedDeleted += int(r.refused_deleted);
    total.refusedMissing += int(r.refused_missing);
    total.refusedClass += int(r.refused_class);
    total.refusedOptout += int(r.refused_optout);
    total.classMismatch += int(r.class_mismatch);
  }
  return total;
}

export async function listItemsForMessage(principal: ExecPrincipal, channelId: string, ts: string): Promise<SlackItemRow[]> {
  const pid = requirePrincipal(principal);
  requireChannel("listItemsForMessage", channelId);
  requireTs("listItemsForMessage", ts);
  const result = (await db().from(ITEMS).select(ITEM_COLS).eq("principal_id", pid).eq("channel_id", channelId).eq("ts", ts).order("kind", { ascending: true })) as Result;
  if (result.error) {
    if (missing(result.error)) return [];
    throw failure("listItemsForMessage", result.error);
  }
  return rowsOf(result).map((r) => toItemRow(r, "listItemsForMessage"));
}

/** C32: permalinks fetched at triage time; one that doesn't match the column's CHECK is skipped (never written). */
export async function setPermalinks(principal: ExecPrincipal, rows: readonly { id: string; permalink: string }[]): Promise<void> {
  const pid = requirePrincipal(principal);
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.id !== "string" || !ITEM_ID.test(r.id)) continue;
    if (typeof r.permalink !== "string" || r.permalink.length > 500 || !PERMALINK.test(r.permalink)) continue;
    const { error } = (await db().from(ITEMS).update({ permalink: r.permalink, updated_at: new Date().toISOString() }).eq("principal_id", pid).eq("id", r.id)) as Result;
    if (error) {
      if (missing(error)) throw notInstalled(error);
      throw failure("setPermalinks", error);
    }
  }
}

/** The producer's items: kind <> fyi created within attentionWindowDays and not answered (opts.answered: answered ones too, for
 *  P8's check-in hook, C21: a late-matched check-in's stamp is undone and the item reopens), plus every commitment with due_at
 *  in [now − 30 d, now] whatever its answer (§3.13: owed_to_mitchell stays open until 30 days overdue even after he replied;
 *  the producer applies respondedAt only to mitchell_owes); with their channel rows. */
export async function listItemsForAttention(principal: ExecPrincipal, now: Date, opts: { answered?: boolean } = {}): Promise<{ items: SlackItemRow[]; channels: ChannelRow[] }> {
  const pid = requirePrincipal(principal);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw bad("listItemsForAttention", "now must be a valid Date");
  const since = new Date(now.getTime() - ATTENTION_WINDOW_MS).toISOString();
  const answered = opts?.answered === true;
  const recent = await pagedSelect("listItemsForAttention", () => {
    const q = db()
      .from(ITEMS)
      .select(ITEM_COLS)
      .eq("principal_id", pid)
      .neq("kind", "fyi");
    return (answered ? q : q.is("responded_at", null))
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
  });
  if (recent === null) return { items: [], channels: [] };
  const due = await pagedSelect("listItemsForAttention", () =>
    db()
      .from(ITEMS)
      .select(ITEM_COLS)
      .eq("principal_id", pid)
      .eq("kind", "commitment")
      .gte("due_at", new Date(now.getTime() - COMMITMENT_OVERDUE_MS).toISOString())
      .lte("due_at", now.toISOString())
      .order("due_at", { ascending: true })
      .order("id", { ascending: true })
  );
  const byId = new Map<string, SlackItemRow>();
  for (const r of [...recent, ...(due ?? [])]) {
    const item = toItemRow(r, "listItemsForAttention");
    byId.set(item.id, item);
  }
  const items = [...byId.values()];
  const channelIds = [...new Set(items.map((i) => i.channelId))];
  const channels: ChannelRow[] = [];
  for (const chunk of chunks(channelIds, IN_CHUNK)) {
    const result = (await db().from(CHANNELS).select(CHANNEL_COLS).eq("principal_id", pid).in("channel_id", chunk)) as Result;
    if (result.error) {
      if (missing(result.error)) return { items: [], channels: [] };
      throw failure("listItemsForAttention", result.error);
    }
    for (const r of rowsOf(result)) channels.push(toChannelRow(r, "listItemsForAttention"));
  }
  return { items, channels };
}

/** AN09 (C21): un-stamp the message rows and items a check-in ts stamped (P8's answeredExclusion). Returns the items un-stamped. */
export async function unstampAnswered(principal: ExecPrincipal, keys: readonly { channelId: string; respondedTs: string }[]): Promise<number> {
  const pid = requirePrincipal(principal);
  let n = 0;
  for (const k of Array.isArray(keys) ? keys : []) {
    if (!k || typeof k.channelId !== "string" || !CHANNEL.test(k.channelId) || typeof k.respondedTs !== "string" || !TS.test(k.respondedTs)) continue;
    const nowIso = new Date().toISOString();
    const msgs = (await db()
      .from(MESSAGES)
      .update({ responded_ts: null, responded_at: null, updated_at: nowIso })
      .eq("principal_id", pid)
      .eq("channel_id", k.channelId)
      .eq("responded_ts", k.respondedTs)) as Result;
    if (msgs.error) {
      if (missing(msgs.error)) return 0;
      throw failure("unstampAnswered", msgs.error);
    }
    const items = (await db()
      .from(ITEMS)
      .update({ responded_ts: null, responded_at: null, updated_at: nowIso })
      .eq("principal_id", pid)
      .eq("channel_id", k.channelId)
      .eq("responded_ts", k.respondedTs)
      .select("id")) as Result;
    if (items.error) {
      if (missing(items.error)) return n;
      throw failure("unstampAnswered", items.error);
    }
    n += rowsOf(items).length;
  }
  return n;
}

export interface SlackScreenRows {
  readingLive: boolean;
  channels: Map<string, { class: ChannelClass; watchState: WatchState; muteSource: MuteSource | null; financeName: boolean }>;
  items: Map<string, { bypassMute: boolean; sourceClass: ItemSourceClass }>;   // key fingerprint; the item of highest precedence
  messages: Set<string>;   // fingerprints with a message row
  markers: Set<string>;    // fingerprints with a deleted marker
}

/** C19's precedence (lower wins): decision > request / question / action_item > commitment > unassessed > fyi. */
function precedence(kind: SlackItemKind, assessed: boolean): number {
  if (!assessed) return 3;
  if (kind === "decision") return 0;
  if (kind === "request" || kind === "question" || kind === "action_item") return 1;
  if (kind === "commitment") return 2;
  return 4;
}

/** C20: the rows the S3 screen needs for a batch of Slack fingerprints. readingLive = a live reading half (discovering|ready,
 *  a token) AND the switch on. A missing schema → not live, nothing found. Any other read failure throws (the screen then
 *  withholds every Slack item). */
export async function slackScreenRows(principal: ExecPrincipal, keys: readonly { channelId: string; ts: string }[], opts?: { signal?: AbortSignal }): Promise<SlackScreenRows> {
  const pid = requirePrincipal(principal);
  const signal = opts?.signal;
  const out: SlackScreenRows = { readingLive: false, channels: new Map(), items: new Map(), messages: new Set(), markers: new Set() };
  const half = await getReadingHalf(principal, { signal });
  const live = half !== null && half.reading.hasToken && (half.reading.state === "discovering" || half.reading.state === "ready");
  if (live) {
    const settings = await loadSettings(pid);
    out.readingLive = settings.slackReadingSchemaReady && settings.slackReadingEnabled;
  }
  const wanted = new Map<string, Set<string>>();
  for (const k of Array.isArray(keys) ? keys : []) {
    if (!k || typeof k.channelId !== "string" || !CHANNEL.test(k.channelId) || typeof k.ts !== "string" || !TS.test(k.ts)) continue;
    let set = wanted.get(k.channelId);
    if (!set) wanted.set(k.channelId, (set = new Set()));
    set.add(k.ts);
  }
  if (wanted.size === 0) return out;
  const want = (channelId: unknown, ts: unknown): string | null =>
    typeof channelId === "string" && typeof ts === "string" && wanted.get(channelId)?.has(ts) === true ? slackMsgFingerprint(channelId, ts) : null;
  const read = async (q: PromiseLike<Result>): Promise<Row[] | null> => {
    const result = await q;
    if (result.error) {
      if (missing(result.error)) return null;
      throw failure("slackScreenRows", result.error, signal);
    }
    return rowsOf(result);
  };
  const channelIds = [...wanted.keys()];
  const best = new Map<string, { rank: number; bypassMute: boolean; sourceClass: ItemSourceClass }>();
  for (const chunk of chunks(channelIds, IN_CHUNK)) {
    const tsList = [...new Set(chunk.flatMap((c) => [...(wanted.get(c) ?? [])]))];
    for (const tsChunk of chunks(tsList, IN_CHUNK)) {
      const channels = await read(withSignal(db().from(CHANNELS).select("channel_id,class,watch_state,mute_source,finance_name").eq("principal_id", pid).in("channel_id", chunk), signal));
      if (channels === null) return { ...out, readingLive: false };
      for (const r of channels) {
        const id = str(r.channel_id);
        const cls = oneOf(r.class, CLASSES);
        const watch = oneOf(r.watch_state, WATCH_STATES);
        if (!id || !cls || !watch) continue;
        out.channels.set(id, { class: cls, watchState: watch, muteSource: oneOf(r.mute_source, MUTE_SOURCES), financeName: bool(r.finance_name) });
      }
      const messages = await read(withSignal(db().from(MESSAGES).select("channel_id,ts").eq("principal_id", pid).in("channel_id", chunk).in("ts", tsChunk), signal));
      if (messages === null) return { ...out, readingLive: false };
      for (const r of messages) {
        const fp = want(r.channel_id, r.ts);
        if (fp) out.messages.add(fp);
      }
      const markers = await read(withSignal(db().from(DELETED).select("channel_id,ts").eq("principal_id", pid).in("channel_id", chunk).in("ts", tsChunk), signal));
      if (markers === null) return { ...out, readingLive: false };
      for (const r of markers) {
        const fp = want(r.channel_id, r.ts);
        if (fp) out.markers.add(fp);
      }
      const items = await read(
        withSignal(db().from(ITEMS).select("channel_id,ts,kind,assessed,bypass_mute,source_class").eq("principal_id", pid).in("channel_id", chunk).in("ts", tsChunk), signal)
      );
      if (items === null) return { ...out, readingLive: false };
      for (const r of items) {
        const fp = want(r.channel_id, r.ts);
        const kind = oneOf(r.kind, ITEM_KINDS);
        const sourceClass = oneOf(r.source_class, SOURCE_CLASSES);
        if (!fp || !kind || !sourceClass) continue;
        const rank = precedence(kind, bool(r.assessed));
        const prior = best.get(fp);
        if (!prior || rank < prior.rank) best.set(fp, { rank, bypassMute: bool(r.bypass_mute), sourceClass });
      }
    }
  }
  for (const [fp, v] of best) out.items.set(fp, { bypassMute: v.bypassMute, sourceClass: v.sourceClass });
  return out;
}

async function countOf(op: string, q: PromiseLike<Result>): Promise<number> {
  const result = await q;
  if (result.error) {
    if (missing(result.error)) return 0;
    throw failure(op, result.error);
  }
  return typeof result.count === "number" && result.count > 0 ? result.count : 0;
}

/** Open items: responded_at null, kind <> fyi. */
export async function countOpenItems(principal: ExecPrincipal): Promise<number> {
  const pid = requirePrincipal(principal);
  return countOf("countOpenItems", db().from(ITEMS).select("id", { count: "exact", head: true }).eq("principal_id", pid).is("responded_at", null).neq("kind", "fyi"));
}

/** Candidates waiting for triage: role candidate, triage_state pending. */
export async function countPendingTriage(principal: ExecPrincipal): Promise<number> {
  const pid = requirePrincipal(principal);
  return countOf(
    "countPendingTriage",
    db().from(MESSAGES).select("ts", { count: "exact", head: true }).eq("principal_id", pid).eq("role", "candidate").eq("triage_state", "pending")
  );
}

/** The newest swept_at of his conversations, or null. */
export async function lastSweepAt(principal: ExecPrincipal): Promise<string | null> {
  const pid = requirePrincipal(principal);
  const result = (await db()
    .from(CHANNELS)
    .select("swept_at")
    .eq("principal_id", pid)
    .not("swept_at", "is", null)
    .order("swept_at", { ascending: false })
    .limit(1)) as Result;
  if (result.error) {
    if (missing(result.error)) return null;
    throw failure("lastSweepAt", result.error);
  }
  return str(rowsOf(result)[0]?.swept_at);
}

// ---------------------------------------------------------------------------
// Purges, the limiter, the DD bot, the outbox
// ---------------------------------------------------------------------------

/** RPC 15: marks the user half revoked and purges every reading row of the installation in one transaction (C25, C42).
 *  Missing → { revoked: false, purge: null }. */
export async function userRevoke(installationId: string, reason: "stopped" | "tokens_revoked" | "disconnected" | "app_uninstalled"):
  Promise<{ revoked: boolean; purge: Record<string, number> | null }> {                              // RPC 15
  if (!(REVOKE_REASONS as readonly string[]).includes(reason)) throw bad("userRevoke", "unknown reason");
  if (typeof installationId !== "string" || !INSTALLATION.test(installationId)) return { revoked: false, purge: null };
  const { data, error } = await rpc(RPC_USER_REVOKE, { p_installation_id: installationId, p_reason: reason });
  if (error) {
    if (missing(error)) return { revoked: false, purge: null };
    throw failure("userRevoke", error);
  }
  const r = answer("userRevoke", data);
  const purge = r.purge !== null && typeof r.purge === "object" && !Array.isArray(r.purge) ? counts(r.purge as Row) : null;
  return { revoked: r.revoked === true, purge };
}

/** RPC 14 (raises while the reading half is live); null when the P7a migration isn't applied. */
export async function purgeReading(installationId: string): Promise<Record<string, number> | null> {   // RPC 14; null when missing
  if (typeof installationId !== "string" || !INSTALLATION.test(installationId)) return { purged: 0 };
  const { data, error } = await rpc(RPC_PURGE_READING, { p_installation_id: installationId });
  if (error) {
    if (missing(error)) return null;
    throw failure("purgeReading", error);
  }
  return counts(answer("purgeReading", data));
}

const EXPIRED_KEYS = ["items", "messages", "threads", "markers", "log", "channels", "attention"] as const;

/** RPC 19 (global, expires_at-driven). Missing → every count 0. */
export async function purgeExpiredSlack(now: Date, opts?: { signal?: AbortSignal }): Promise<Record<string, number>> {  // RPC 19; missing → all 0
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw bad("purgeExpiredSlack", "now must be a valid Date");
  const signal = opts?.signal;
  const zeros = Object.fromEntries(EXPIRED_KEYS.map((k) => [k, 0])) as Record<string, number>;
  const { data, error } = await rpc(RPC_PURGE_EXPIRED, { p_now: now.toISOString() }, signal);
  if (error) {
    signal?.throwIfAborted();
    if (missing(error)) return zeros;
    throw failure("purgeExpiredSlack", error, signal);
  }
  const r = answer("purgeExpiredSlack", data);
  for (const k of EXPIRED_KEYS) zeros[k] = int(r[k]);
  return zeros;
}

/** RPC 16. A store error (a missing schema included) throws: no unmetered call. */
export async function rateTake(teamId: string, method: MeteredMethod, cls: RateClass, n: number, now: Date):
  Promise<{ allowed: boolean; waitMs: number; reason?: "blocked" | "budget" }> {                    // RPC 16
  if (typeof teamId !== "string" || !TEAM.test(teamId)) throw bad("rateTake", "malformed team id");
  if (!(METHODS as readonly string[]).includes(method)) throw bad("rateTake", "unknown method");
  if (!(RATE_CLASSES as readonly string[]).includes(cls)) throw bad("rateTake", "unknown class");
  if (!Number.isSafeInteger(n) || n < 1 || n > 10) throw bad("rateTake", "n must be 1..10");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw bad("rateTake", "now must be a valid Date");
  const { data, error } = await rpc(RPC_RATE_TAKE, { p_team: teamId, p_method: method, p_class: cls, p_n: n, p_now: now.toISOString() });
  if (error) {
    if (missing(error)) throw notInstalled(error);
    throw failure("rateTake", error);
  }
  const r = answer("rateTake", data);
  if (typeof r.allowed !== "boolean") throw new SlackReadStoreError("rateTake: malformed answer", null);
  const waitMs = int(r.wait_ms);
  if (r.allowed) return { allowed: true, waitMs: 0 };
  const reason = r.reason === "blocked" || r.reason === "budget" ? r.reason : "budget";
  return { allowed: false, waitMs, reason };
}

/** RPC 17 (≤ 10 minutes, the SQL caps it). */
export async function rateBlock(teamId: string, method: MeteredMethod, until: Date): Promise<void> {  // RPC 17
  if (typeof teamId !== "string" || !TEAM.test(teamId)) throw bad("rateBlock", "malformed team id");
  if (!(METHODS as readonly string[]).includes(method)) throw bad("rateBlock", "unknown method");
  if (!(until instanceof Date) || !Number.isFinite(until.getTime())) throw bad("rateBlock", "until must be a valid Date");
  const { error } = await rpc(RPC_RATE_BLOCK, { p_team: teamId, p_method: method, p_until: until.toISOString() });
  if (error) {
    if (missing(error)) throw notInstalled(error);
    throw failure("rateBlock", error);
  }
}

/** Methods whose blocked_until is still in the future. Missing → []. */
export async function rateBlocks(teamId: string): Promise<{ method: MeteredMethod; blockedUntil: string }[]> {   // blocked_until > now
  if (typeof teamId !== "string" || !TEAM.test(teamId)) return [];
  const result = (await db()
    .from(RATE)
    .select("method,blocked_until")
    .eq("team_id", teamId)
    .gt("blocked_until", new Date().toISOString())
    .order("method", { ascending: true })) as Result;
  if (result.error) {
    if (missing(result.error)) return [];
    throw failure("rateBlocks", result.error);
  }
  const out: { method: MeteredMethod; blockedUntil: string }[] = [];
  for (const r of rowsOf(result)) {
    const method = oneOf(r.method, METHODS);
    const blockedUntil = str(r.blocked_until);
    if (method && blockedUntil) out.push({ method, blockedUntil });
  }
  return out;
}

export async function getDdBotRow(teamId: string): Promise<{ ok: boolean; userId: string | null; botId: string | null; appId: string | null; errorCode: string | null; checkedAt: string } | null> {
  if (typeof teamId !== "string" || !TEAM.test(teamId)) return null;
  const result = (await db().from(DD_BOT).select("team_id,ok,user_id,bot_id,app_id,error_code,checked_at").eq("team_id", teamId).limit(1)) as Result;
  if (result.error) {
    if (missing(result.error)) return null;
    throw failure("getDdBotRow", result.error);
  }
  const r = rowsOf(result)[0];
  if (!r) return null;
  const checkedAt = str(r.checked_at);
  if (typeof r.ok !== "boolean" || !checkedAt) throw new SlackReadStoreError("getDdBotRow: malformed row", null);
  return { ok: r.ok, userId: str(r.user_id), botId: str(r.bot_id), appId: str(r.app_id), errorCode: str(r.error_code), checkedAt };
}

/** Upsert by team (identical key set). The table's CHECKs hold the shape (ok ⇔ both ids and no error code). */
export async function saveDdBotRow(row: { teamId: string; ok: boolean; userId: string | null; botId: string | null; appId: string | null; errorCode: string | null; checkedAt: string }): Promise<void> {
  if (!row || typeof row.teamId !== "string" || !TEAM.test(row.teamId)) throw bad("saveDdBotRow", "malformed team id");
  if (typeof row.ok !== "boolean" || !isTime(row.checkedAt)) throw bad("saveDdBotRow", "malformed row");
  const { error } = (await db()
    .from(DD_BOT)
    .upsert(
      {
        team_id: row.teamId,
        ok: row.ok,
        user_id: row.userId ?? null,
        bot_id: row.botId ?? null,
        app_id: row.appId ?? null,
        error_code: row.errorCode ?? null,
        checked_at: new Date(Date.parse(row.checkedAt)).toISOString()
      },
      { onConflict: "team_id" }
    )) as Result;
  if (error) {
    if (missing(error)) throw notInstalled(error);
    throw failure("saveDdBotRow", error);
  }
}

/** C44: RPC 24 (the runbook's step, also callable from code/tests); missing → SlackReadStoreError("not_installed"). */
export async function purgeAuthor(principal: ExecPrincipal, authorUserId: string): Promise<{ conversations: number; messages: number;
  items: number; attention: number }> {
  const pid = requirePrincipal(principal);
  if (typeof authorUserId !== "string" || !USER.test(authorUserId)) throw bad("purgeAuthor", "malformed author id");
  const { data, error } = await rpc(RPC_PURGE_AUTHOR, { p_principal: pid, p_author: authorUserId });
  if (error) {
    if (missing(error)) throw notInstalled(error);
    throw failure("purgeAuthor", error);
  }
  const r = answer("purgeAuthor", data);
  return { conversations: int(r.conversations), messages: int(r.messages), items: int(r.items), attention: int(r.attention) };
}

/** C44: the opted-out author ids (P7b excludes them from digests and live search; triage renders them as placeholders). */
export async function listAuthorOptouts(principal: ExecPrincipal): Promise<string[]> {
  const pid = requirePrincipal(principal);
  const rows = await pagedSelect("listAuthorOptouts", () =>
    db().from(OPTOUTS).select("author_user_id").eq("principal_id", pid).order("author_user_id", { ascending: true })
  );
  return (rows ?? []).map((r) => str(r.author_user_id)).filter((v): v is string => v !== null && USER.test(v));
}

// ---------------------------------------------------------------------------
// P7b's additive reads (P7b contract §3.17.6 P7a-2, §0.6.1 R8b; Area A): the only path by which P7a rows (and the excerpt)
// reach P7b. Explicit columns; P7a's missing-schema tolerance; an aborted signal wins. listAuthorOptouts (R8b's third read)
// is P7a's own, above: P7b binds it as it is (string[], no opts).
// ---------------------------------------------------------------------------

const INTEL_CHANNELS_MAX = 2000;
const ITEMS_BY_ID_MAX = 500;

/** Every channel row of the principal except class deny (≤ 2 000, by channel id), optionally only the given ids (each must
 *  match the channel id shape; others are ignored). Missing schema → []. */
export async function listIntelChannels(principal: ExecPrincipal, opts?: { channelIds?: readonly string[]; signal?: AbortSignal }): Promise<ChannelRow[]> {
  const pid = requirePrincipal(principal);
  const signal = opts?.signal;
  const read = async (q: PromiseLike<Result>): Promise<Row[] | null> => {
    const result = await q;
    if (result.error) {
      signal?.throwIfAborted();
      if (missing(result.error)) return null;
      throw failure("listIntelChannels", result.error, signal);
    }
    return rowsOf(result);
  };
  const out: ChannelRow[] = [];
  if (opts?.channelIds !== undefined) {
    const ids = [...new Set((Array.isArray(opts.channelIds) ? opts.channelIds : []).filter((c) => typeof c === "string" && CHANNEL.test(c)))];
    for (const chunk of chunks(ids, IN_CHUNK)) {
      const rows = await read(withSignal(db().from(CHANNELS).select(CHANNEL_COLS).eq("principal_id", pid).neq("class", "deny").in("channel_id", chunk), signal));
      if (rows === null) return [];
      for (const r of rows) out.push(toChannelRow(r, "listIntelChannels"));
    }
    return out.sort((a, b) => (a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0)).slice(0, INTEL_CHANNELS_MAX);
  }
  for (let page = 0; page * PAGE < INTEL_CHANNELS_MAX; page += 1) {
    const rows = await read(withSignal(db().from(CHANNELS).select(CHANNEL_COLS).eq("principal_id", pid).neq("class", "deny")
      .order("channel_id", { ascending: true }).range(page * PAGE, Math.min(page * PAGE + PAGE, INTEL_CHANNELS_MAX) - 1), signal));
    if (rows === null) return [];
    for (const r of rows) out.push(toChannelRow(r, "listIntelChannels"));
    if (rows.length < PAGE) break;
  }
  return out.slice(0, INTEL_CHANNELS_MAX);
}

/** The items of the given ids (esl_…; ≤ 500, malformed ids ignored), in the order asked, screened like C20 through
 *  slackScreenRows + slackScreenAllows (attention-read.ts, the rule listOpenSlackItems applies: one rule, never re-implemented)
 *  with the surface as given (anything but "web" screens as the stricter "slack"): a withheld row (reading not live, no channel
 *  row, deny/unclassified/hub, no message row, a deleted marker, a channel that isn't watched without an owner/Slack mute
 *  bypass, finance on "slack") is dropped. The only P7a read that selects `excerpt` for P7b. Missing schema → []; any other
 *  failure throws (the caller fails closed). */
export async function getSlackItemsByIds(principal: ExecPrincipal, ids: readonly string[], opts: { surface: "web" | "slack"; signal?: AbortSignal }): Promise<SlackItemRow[]> {
  const pid = requirePrincipal(principal);
  const signal = opts?.signal;
  const surface: "web" | "slack" = opts?.surface === "web" ? "web" : "slack";
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && ITEM_ID.test(id)))].slice(0, ITEMS_BY_ID_MAX);
  if (wanted.length === 0) return [];
  const byId = new Map<string, SlackItemRow>();
  for (const chunk of chunks(wanted, IN_CHUNK)) {
    const result = (await withSignal(db().from(ITEMS).select(ITEM_COLS).eq("principal_id", pid).in("id", chunk), signal)) as Result;
    if (result.error) {
      signal?.throwIfAborted();
      if (missing(result.error)) return [];
      throw failure("getSlackItemsByIds", result.error, signal);
    }
    for (const r of rowsOf(result)) {
      const item = toItemRow(r, "getSlackItemsByIds");
      byId.set(item.id, item);
    }
  }
  const items = wanted.map((id) => byId.get(id)).filter((i): i is SlackItemRow => i !== undefined);
  if (items.length === 0) return [];
  const screen = await slackScreenRows(principal, items.map((i) => ({ channelId: i.channelId, ts: i.ts })), { signal });
  if (!screen.readingLive) return [];
  // Loaded on first use: attention-read.ts imports this module (slackScreenRows), so a static import would be a cycle.
  const { slackScreenAllows } = await import("@/lib/exec/attention-read");
  return items.filter((i) => slackScreenAllows(screen, { channelId: i.channelId, ts: i.ts }, i, surface));
}

/** P7b fixer (security-3; additive, a read, §3.17.6): the newest per-author opt-out's created_at (ISO), so P7b withholds
 *  every stored digest requested at or before it until its sweep blanks them (C33; digests store no author). null when
 *  there is none or the table is missing; any other failure throws (the caller fails closed). Refs only: no author id. */
export async function latestAuthorOptoutAt(principal: ExecPrincipal, opts?: { signal?: AbortSignal }): Promise<string | null> {
  const pid = requirePrincipal(principal);
  const signal = opts?.signal;
  const result = (await withSignal(db().from(OPTOUTS).select("created_at").eq("principal_id", pid).order("created_at", { ascending: false }).limit(1), signal)) as Result;
  if (result.error) {
    signal?.throwIfAborted();
    if (missing(result.error)) return null;
    throw failure("latestAuthorOptoutAt", result.error, signal);
  }
  const at = str(rowsOf(result)[0]?.created_at);
  if (at === null) return null;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) throw new SlackReadStoreError("latestAuthorOptoutAt: malformed row", null);
  return new Date(ms).toISOString();
}

/** P7b/P8 follow-ups (C31): rows after afterId, oldest first, at most `limit` (1..500). */
export async function listPurgeLog(principal: ExecPrincipal, afterId: number, limit: number): Promise<{ id: number; scope: "message" | "conversation" | "reading";
  channelId: string | null; ts: string | null; reason: string; createdAt: string }[]> {
  const pid = requirePrincipal(principal);
  const after = typeof afterId === "number" && Number.isSafeInteger(afterId) && afterId > 0 ? afterId : 0;
  const result = (await db()
    .from(PURGE_LOG)
    .select("id,scope,channel_id,ts,reason,created_at")
    .eq("principal_id", pid)
    .gt("id", after)
    .order("id", { ascending: true })
    .limit(clampInt(limit, 1, 500, 100))) as Result;
  if (result.error) {
    if (missing(result.error)) return [];
    throw failure("listPurgeLog", result.error);
  }
  const out: { id: number; scope: "message" | "conversation" | "reading"; channelId: string | null; ts: string | null; reason: string; createdAt: string }[] = [];
  for (const r of rowsOf(result)) {
    const id = typeof r.id === "string" && /^[0-9]+$/.test(r.id) ? Number(r.id) : r.id;
    const scope = oneOf(r.scope, ["message", "conversation", "reading"] as const);
    const reason = str(r.reason);
    const createdAt = str(r.created_at);
    if (typeof id !== "number" || !Number.isSafeInteger(id) || !scope || !reason || !createdAt) {
      throw new SlackReadStoreError("listPurgeLog: malformed row", null);
    }
    out.push({ id, scope, channelId: str(r.channel_id), ts: str(r.ts), reason, createdAt });
  }
  return out;
}

/** Gate cache: (principal, channel) with class deny|unclassified for every principal with a live reading half. */
export async function listGateDropChannels(principalIds: readonly string[]): Promise<{ principalId: string; channelId: string; class: "deny" | "unclassified" }[]> {
  const ids = [...new Set((Array.isArray(principalIds) ? principalIds : []).filter((p) => typeof p === "string" && p.length > 0))];
  const out: { principalId: string; channelId: string; class: "deny" | "unclassified" }[] = [];
  for (const chunk of chunks(ids, IN_CHUNK)) {
    const rows = await pagedSelect("listGateDropChannels", () =>
      db()
        .from(CHANNELS)
        .select("principal_id,channel_id,class")
        .in("principal_id", chunk)
        .in("class", ["deny", "unclassified"])
        .order("principal_id", { ascending: true })
        .order("channel_id", { ascending: true })
    );
    if (rows === null) return [];
    for (const r of rows) {
      const principalId = str(r.principal_id);
      const channelId = str(r.channel_id);
      const cls = r.class === "deny" || r.class === "unclassified" ? r.class : null;
      if (principalId && channelId && cls) out.push({ principalId, channelId, class: cls });
    }
  }
  return out;
}
