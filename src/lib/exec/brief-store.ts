import "server-only";

import type { PriorityBand } from "@/lib/exec/attention-types";
import { BRIEF_LIMITS } from "@/lib/exec/brief-types";
import type {
  BriefContent,
  BriefMode,
  BriefModeReason,
  BriefOwner,
  BriefOwnerReason,
  BriefPageOnlyReason,
  BriefRow,
  BriefStatus,
  BriefTrigger,
  BriefUnknownReason,
  CheckinRow,
  CheckinStatus,
  NewCheckin
} from "@/lib/exec/brief-types";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P8 brief store (contract §3.4; Area A; server-only): every read and write of exec_briefs, exec_brief_checkins and
// exec_brief_mentions and the ten P8 functions (B-P8-1: the only module that names them), plus the two legacy reads of
// DD's daily_briefings the ownership gate needs. Column maps camelCase <-> snake_case; select lists are explicit
// (never *).
//
//   * Errors are BriefStoreError(op, pgCode): the function's name and the database's own code, never a value this
//     module was handed or read (no ids, ts values, dates, text or tokens in a message, §0.3 rule 4). An aborted signal
//     wins: its reason is thrown instead.
//   * A missing table / function / column (isBriefSchemaMissing: the P8 migration isn't applied, §2.4 item 2) maps to the
//     signature's "not installed" answer: { outcome: "not_installed" }, null, false, 0, [], an empty map or set, zeros.
//     A write whose answer can't say it (finishBuild, insertCheckins) throws BriefStoreError("not_installed", code).
//   * Arguments are checked here (shape, length, the table CHECKs a write must pass); a bad argument is a TypeError
//     naming the argument, never its value.
//   * Batch writes build every row with the identical key set (§0.3 rule 13); RPC payloads are built here.
//   * Times compare as epoch ms; timestamps come back as ISO strings; local dates as YYYY-MM-DD.
//   * Nothing here logs content; releaseRegenLock is the one function that never throws, and it logs the op only.

const BRIEFS = "exec_briefs";
const CHECKINS = "exec_brief_checkins";
const MENTIONS = "exec_brief_mentions";
const LEGACY = "daily_briefings";

const RPC_CLAIM_BUILD = "exec_brief_claim_build";
const RPC_FINISH_BUILD = "exec_brief_finish_build";
const RPC_DELIVERY_STEP = "exec_brief_delivery_step";
const RPC_CLAIM_FALLBACK = "exec_brief_claim_fallback";
const RPC_SCRUB_THREADS = "exec_brief_scrub_threads";
const RPC_SCRUB_SLACK = "exec_brief_scrub_slack";
const RPC_PURGE_EXPIRED = "exec_brief_purge_expired";

/** Every exec_briefs column the app reads (BriefRow). */
const BRIEF_COLS =
  "id,principal_id,local_date,tz,scheduled_at,rev,status,status_reason,owner,owner_reason,mode,mode_reason,content,build_started_at,built_at," +
  "regen_lock_until,regen_seq,novelty_marked_at,delivery_started_at,post_attempts,delivered_at,slack_channel_id,slack_ts,checkins_ts,late_note_ts," +
  "fallback_sent_at,fallback_slack_ts,fallback_channel_id,fallback_delete_after,fallback_deleted_at,fallback_error_code,scrubbed_at,dm_followed_at," +
  "error_code,content_expires_at,content_purged_at,expires_at,created_at,updated_at";
/** Every exec_brief_checkins column the app reads (CheckinRow). */
const CHECKIN_COLS =
  "id,brief_id,principal_id,local_date,brief_rev,rev,recipient_user_id,recipient_slack_id,text,status,status_reason,sending_at,sent_at," +
  "slack_channel_id,slack_ts,audit_id,expires_at,purge_at,created_at,updated_at";
/** The identical key set of every insertCheckins row (P3 §0). */
const CHECKIN_ROW_KEYS = [
  "principal_id", "brief_id", "local_date", "brief_rev", "recipient_user_id", "recipient_slack_id", "text", "expires_at", "purge_at"
] as const;

/** Missing table (42P01, PGRST205), function (42883, PGRST202) or column (42703, PGRST204): the migration isn't applied. */
const SCHEMA_MISSING_CODES: ReadonlySet<string> = new Set(["42P01", "PGRST205", "42883", "PGRST202", "42703", "PGRST204"]);
const PG_CODE = /^[A-Z0-9]{2,10}$/;
const BRIEF_ID = /^eb_[0-9a-f]{32}$/;
const CHECKIN_ID = /^ebc_[0-9a-f]{32}$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TS = /^[0-9]{1,12}\.[0-9]{1,8}$/;
const DM_CHANNEL = /^D[A-Z0-9]{2,30}$/;
const SLACK_USER = /^[UW][A-Z0-9]{2,30}$/;
const CODE = /^[a-z0-9_]{1,60}$/;
const REASON = /^[a-z_]{1,40}$/;
const CHECKIN_REASON = /^[a-z0-9_]{1,60}$/;

const SCHEMA_TTL_TRUE_MS = 60_000;
const SCHEMA_TTL_FALSE_MS = 10_000;
const IN_CHUNK = 200;
const URL_LIST_BUDGET = 6_000;
const SCRUB_CHUNK = BRIEF_LIMITS.scrubBatch;          // 500: RPCs 5 and 6 refuse more per call
const PURGE_BATCH = BRIEF_LIMITS.purgeBatch;          // 1 000
const PURGE_ROUNDS = BRIEF_LIMITS.purgeRounds;        // 10
const MENTION_TTL_DAYS = BRIEF_LIMITS.mentionTtlDays; // 90
const MENTIONS_MAX = BRIEF_LIMITS.mentionsMax;        // 400
const STALE_BUILDING_MS = BRIEF_LIMITS.staleBuildingMs;
const NEVER_BUILT_MS = BRIEF_LIMITS.neverBuiltMs;
/** The longest regenerate lock RPC 1 grants (C16 hold-back: regen_lock_until - this = the latest the claim could have run). */
const MAX_REGEN_LOCK_MS = 900_000;
const FOLLOWUP_SCAN = 500;
const DAY_MS = 86_400_000;
/** security-3: how long a legacy brief's posting stamp holds the exec DM back, and how far back its row is looked for. */
const LEGACY_IN_FLIGHT_MS = 10 * 60_000;
const LEGACY_SCAN_MS = 3 * DAY_MS;

const BRIEF_STATUSES: readonly BriefStatus[] = ["building", "built", "delivering", "delivered", "delivery_unknown", "page_only", "failed"];
const CHECKIN_STATUSES: readonly CheckinStatus[] = ["proposed", "sending", "sent", "unknown", "failed", "expired"];
const OWNERS: readonly BriefOwner[] = ["exec", "legacy", "exec_page_only"];
const OWNER_REASONS: readonly BriefOwnerReason[] = [
  "exec_disabled", "not_installed", "exec_delivered", "brief_off", "legacy_delivered", "not_superseding", "no_installation", "owns"
];
const MODES: readonly BriefMode[] = ["ai", "deterministic"];
const MODE_REASONS: readonly BriefModeReason[] = ["refused", "truncated", "budget", "invalid_output", "model_error", "timeout"];
const TRIGGERS: readonly BriefTrigger[] = ["schedule", "retry", "regenerate"];
const BANDS: readonly PriorityBand[] = ["critical", "high", "normal"];
const DELIVERY_SOURCES: readonly BriefStatus[] = ["built", "page_only", "delivering"];

type ReadOpts = { signal?: AbortSignal };
type DbError = { code?: string | null; message?: string | null };
type Row = Record<string, unknown>;
type Result = { data: unknown; error: DbError | null; count?: number | null };

export class BriefStoreError extends Error {
  readonly op: string;
  readonly pgCode: string | null;
  constructor(op: string, pgCode: string | null) {
    super(`exec brief store: ${op} failed${pgCode ? ` (${pgCode})` : ""}`);
    this.name = "BriefStoreError";
    this.op = op;
    this.pgCode = pgCode;
  }
}

const db = () => getSupabaseAdmin();

function pgCodeOf(error: DbError | null | undefined): string | null {
  const code = error?.code;
  return typeof code === "string" && PG_CODE.test(code) ? code : null;
}

function missing(error: DbError | null | undefined): boolean {
  const code = pgCodeOf(error);
  return code !== null && SCHEMA_MISSING_CODES.has(code);
}

/** 42P01, PGRST205 (table), 42883, PGRST202 (function), 42703, PGRST204 (column): the P8 migration isn't applied. Accepts a
 *  PostgREST error object or a BriefStoreError. */
export function isBriefSchemaMissing(err: unknown): boolean {
  if (err instanceof BriefStoreError) return err.pgCode !== null && SCHEMA_MISSING_CODES.has(err.pgCode);
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && SCHEMA_MISSING_CODES.has(code);
}

/** The error for a failed request: the abort reason when the signal fired, else BriefStoreError(op, code). */
function failure(op: string, error: DbError | null | undefined, signal?: AbortSignal): BriefStoreError {
  signal?.throwIfAborted();
  return new BriefStoreError(op, pgCodeOf(error));
}

/** A missing schema where the signature can't say "not installed". */
function notInstalled(error: DbError | null | undefined, signal?: AbortSignal): BriefStoreError {
  signal?.throwIfAborted();
  return new BriefStoreError("not_installed", pgCodeOf(error));
}

const malformed = (op: string) => new BriefStoreError(`${op}: malformed answer`, null);
const bad = (fn: string, what: string) => new TypeError(`exec brief store: ${fn}: ${what}`);

function requirePrincipal(fn: string, principal: ExecPrincipal): string {
  if (!principal || typeof principal.id !== "string" || principal.id.length === 0 || principal.id.length > 100) {
    throw bad(fn, "an ExecPrincipal is required");
  }
  return principal.id;
}

function withSignal<T extends { abortSignal(signal: AbortSignal): T }>(q: T, signal: AbortSignal | undefined): T {
  return signal ? q.abortSignal(signal) : q;
}

async function rpc(fn: string, args: Row, signal?: AbortSignal): Promise<Result> {
  return (await withSignal(db().rpc(fn, args), signal)) as Result;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null);
const int = (v: unknown): number | null => {
  const n = typeof v === "string" && /^-?[0-9]+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) ? n : null;
};
const count = (v: unknown): number => {
  const n = int(v);
  return n !== null && n >= 0 ? n : 0;
};
/** A timestamp as an ISO string, or null when absent / unparseable. */
const iso = (v: unknown): string | null => {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const ymd = (v: unknown): string | null => (typeof v === "string" && LOCAL_DATE.test(v.slice(0, 10)) ? v.slice(0, 10) : null);
const isTs = (v: unknown): v is string => typeof v === "string" && TS.test(v);
const nowIso = () => new Date().toISOString();

function validDate(fn: string, v: unknown, what: string): Date {
  if (!(v instanceof Date) || !Number.isFinite(v.getTime())) throw bad(fn, `${what} must be a valid Date`);
  return v;
}
function validYmd(fn: string, v: unknown, what: string): string {
  if (typeof v !== "string" || !LOCAL_DATE.test(v) || !Number.isFinite(Date.parse(`${v}T00:00:00Z`))) throw bad(fn, `${what} must be YYYY-MM-DD`);
  return v;
}
function validIso(fn: string, v: unknown, what: string): string {
  const out = typeof v === "string" ? iso(v) : null;
  if (out === null) throw bad(fn, `${what} must be an ISO timestamp`);
  return out;
}
function validBriefId(fn: string, v: unknown): string {
  if (typeof v !== "string" || !BRIEF_ID.test(v)) throw bad(fn, "a brief id (eb_…) is required");
  return v;
}
function validCheckinId(fn: string, v: unknown): string {
  if (typeof v !== "string" || !CHECKIN_ID.test(v)) throw bad(fn, "a check-in id (ebc_…) is required");
  return v;
}
function validRev(fn: string, v: unknown, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > max) throw bad(fn, `rev must be an integer 1..${max}`);
  return v;
}
function validTs(fn: string, v: unknown, what: string): string {
  if (!isTs(v)) throw bad(fn, `${what} must be a Slack ts`);
  return v;
}
function validDmChannel(fn: string, v: unknown, what: string): string {
  if (typeof v !== "string" || !DM_CHANNEL.test(v)) throw bad(fn, `${what} must be a D… channel id`);
  return v;
}
/** An error code for a status column: the stored shape, else "unknown" (a code is a label, never a reason to throw). */
const safeCode = (v: unknown): string => (typeof v === "string" && CODE.test(v) ? v : "unknown");

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Chunks for an `in.(…)` filter: at most IN_CHUNK values and URL_LIST_BUDGET encoded characters each. */
function urlListChunks(values: readonly string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const value of values) {
    const cost = encodeURIComponent(value).length + 3;
    if (current.length > 0 && (current.length >= IN_CHUNK || size + cost > URL_LIST_BUDGET)) {
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

/** Distinct non-empty strings of at most `max` characters with no double quote or backslash (safe in an in.() list). */
function cleanList(list: readonly unknown[] | null | undefined, max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of Array.isArray(list) ? list : []) {
    if (typeof v !== "string" || v.length === 0 || v.length > max || /["\\]/.test(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function rowsOf(result: Result): Row[] {
  return Array.isArray(result.data) ? (result.data as Row[]) : [];
}

/** A read's rows, or null on a missing schema (other errors throw). */
async function readRows(op: string, q: PromiseLike<Result>, signal?: AbortSignal): Promise<Row[] | null> {
  const result = await q;
  if (result.error) {
    if (missing(result.error)) {
      signal?.throwIfAborted();
      return null;
    }
    throw failure(op, result.error, signal);
  }
  return rowsOf(result);
}

/** A plain-row CAS (update … returning id): true when it changed a row; a missing schema → false. */
async function casUpdate(op: string, q: PromiseLike<Result>, signal?: AbortSignal): Promise<boolean> {
  const rows = await readRows(op, q, signal);
  return rows !== null && rows.length > 0;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toBriefRow(r: Row, op: string): BriefRow {
  const id = str(r.id);
  const principalId = str(r.principal_id);
  const localDate = ymd(r.local_date);
  const status = oneOf(r.status, BRIEF_STATUSES);
  const scheduledAt = iso(r.scheduled_at);
  const contentExpiresAt = iso(r.content_expires_at);
  const expiresAt = iso(r.expires_at);
  const rev = int(r.rev);
  if (!id || !principalId || !localDate || !status || !scheduledAt || !contentExpiresAt || !expiresAt || rev === null) {
    throw new BriefStoreError(`${op}: malformed row`, null);
  }
  const content = r.content !== null && typeof r.content === "object" && !Array.isArray(r.content) ? (r.content as BriefContent) : null;
  return {
    id,
    principalId,
    localDate,
    tz: str(r.tz) ?? "",
    scheduledAt,
    rev,
    status,
    statusReason: str(r.status_reason),
    owner: oneOf(r.owner, OWNERS),
    ownerReason: oneOf(r.owner_reason, OWNER_REASONS),
    mode: oneOf(r.mode, MODES),
    modeReason: oneOf(r.mode_reason, MODE_REASONS),
    content,
    buildStartedAt: iso(r.build_started_at),
    builtAt: iso(r.built_at),
    regenLockUntil: iso(r.regen_lock_until),
    regenSeq: count(r.regen_seq),
    noveltyMarkedAt: iso(r.novelty_marked_at),
    deliveryStartedAt: iso(r.delivery_started_at),
    postAttempts: count(r.post_attempts),
    deliveredAt: iso(r.delivered_at),
    slackChannelId: str(r.slack_channel_id),
    slackTs: str(r.slack_ts),
    checkinsTs: str(r.checkins_ts),
    lateNoteTs: str(r.late_note_ts),
    fallbackSentAt: iso(r.fallback_sent_at),
    fallbackSlackTs: str(r.fallback_slack_ts),
    fallbackChannelId: str(r.fallback_channel_id),
    fallbackDeleteAfter: iso(r.fallback_delete_after),
    fallbackDeletedAt: iso(r.fallback_deleted_at),
    fallbackErrorCode: str(r.fallback_error_code),
    scrubbedAt: iso(r.scrubbed_at),
    dmFollowedAt: iso(r.dm_followed_at),
    errorCode: str(r.error_code),
    contentExpiresAt,
    contentPurgedAt: iso(r.content_purged_at),
    expiresAt,
    createdAt: iso(r.created_at) ?? scheduledAt,
    updatedAt: iso(r.updated_at) ?? scheduledAt
  };
}

function toCheckinRow(r: Row, op: string): CheckinRow {
  const id = str(r.id);
  const briefId = str(r.brief_id);
  const principalId = str(r.principal_id);
  const localDate = ymd(r.local_date);
  const status = oneOf(r.status, CHECKIN_STATUSES);
  const briefRev = int(r.brief_rev);
  const rev = int(r.rev);
  const recipientUserId = str(r.recipient_user_id);
  const recipientSlackId = str(r.recipient_slack_id);
  const text = str(r.text);
  const expiresAt = iso(r.expires_at);
  const purgeAt = iso(r.purge_at);
  if (!id || !briefId || !principalId || !localDate || !status || briefRev === null || rev === null || !recipientUserId || !recipientSlackId
      || text === null || !expiresAt || !purgeAt) {
    throw new BriefStoreError(`${op}: malformed row`, null);
  }
  const auditId = int(r.audit_id);
  return {
    id,
    briefId,
    principalId,
    localDate,
    briefRev,
    rev,
    recipientUserId,
    recipientSlackId,
    text,
    status,
    statusReason: str(r.status_reason),
    sendingAt: iso(r.sending_at),
    sentAt: iso(r.sent_at),
    slackChannelId: str(r.slack_channel_id),
    slackTs: str(r.slack_ts),
    auditId,
    expiresAt,
    purgeAt,
    createdAt: iso(r.created_at) ?? expiresAt,
    updatedAt: iso(r.updated_at) ?? expiresAt
  };
}

// ---------------------------------------------------------------------------
// Schema probe
// ---------------------------------------------------------------------------

let schemaCache: { value: boolean; at: number } | null = null;

/** select 1 from exec_briefs limit 0; cached per process 60 s (true) / 10 s (false). A missing table → false; any other
 *  error throws (and is not cached). */
export async function briefSchemaReady(opts?: ReadOpts): Promise<boolean> {
  const now = Date.now();
  if (schemaCache && now - schemaCache.at < (schemaCache.value ? SCHEMA_TTL_TRUE_MS : SCHEMA_TTL_FALSE_MS)) return schemaCache.value;
  const signal = opts?.signal;
  const { error } = (await withSignal(db().from(BRIEFS).select("id").limit(0), signal)) as Result;
  if (error && !missing(error)) throw failure("briefSchemaReady", error, signal);
  if (error) signal?.throwIfAborted();
  schemaCache = { value: !error, at: Date.now() };
  return schemaCache.value;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getBriefByDate(principal: ExecPrincipal, localDate: string, opts?: ReadOpts): Promise<BriefRow | null> {
  const pid = requirePrincipal("getBriefByDate", principal);
  const date = validYmd("getBriefByDate", localDate, "localDate");
  const signal = opts?.signal;
  const rows = await readRows("getBriefByDate",
    withSignal(db().from(BRIEFS).select(BRIEF_COLS).eq("principal_id", pid).eq("local_date", date).limit(1), signal), signal);
  return rows && rows.length > 0 ? toBriefRow(rows[0], "getBriefByDate") : null;
}

export async function getBriefById(principal: ExecPrincipal, id: string, opts?: ReadOpts): Promise<BriefRow | null> {
  const pid = requirePrincipal("getBriefById", principal);
  if (typeof id !== "string" || !BRIEF_ID.test(id)) return null;
  const signal = opts?.signal;
  const rows = await readRows("getBriefById", withSignal(db().from(BRIEFS).select(BRIEF_COLS).eq("principal_id", pid).eq("id", id).limit(1), signal), signal);
  return rows && rows.length > 0 ? toBriefRow(rows[0], "getBriefById") : null;
}

/** Newest by local_date ≤ onOrBefore. */
export async function getLatestBrief(principal: ExecPrincipal, onOrBefore: string, opts?: ReadOpts): Promise<BriefRow | null> {
  const pid = requirePrincipal("getLatestBrief", principal);
  const date = validYmd("getLatestBrief", onOrBefore, "onOrBefore");
  const signal = opts?.signal;
  const rows = await readRows("getLatestBrief",
    withSignal(db().from(BRIEFS).select(BRIEF_COLS).eq("principal_id", pid).lte("local_date", date).order("local_date", { ascending: false }).limit(1), signal),
    signal);
  return rows && rows.length > 0 ? toBriefRow(rows[0], "getLatestBrief") : null;
}

/** Legacy gate (principal-free, booleans only): whether the day's row exists, its M1 owner, and whether it was delivered
 *  or the watchdog claimed. Reads no content. */
export async function getBriefDayFactsForSystem(principalId: string, localDate: string, opts?: ReadOpts):
  Promise<{ exists: boolean; owner: BriefOwner | null; delivered: boolean; fallbackSent: boolean } | "not_installed"> {
  if (typeof principalId !== "string" || principalId.length === 0 || principalId.length > 100) throw bad("getBriefDayFactsForSystem", "a principal id is required");
  const date = validYmd("getBriefDayFactsForSystem", localDate, "localDate");
  const signal = opts?.signal;
  const rows = await readRows("getBriefDayFactsForSystem",
    withSignal(db().from(BRIEFS).select("owner,delivered_at,fallback_sent_at").eq("principal_id", principalId).eq("local_date", date).limit(1), signal),
    signal);
  if (rows === null) return "not_installed";
  const r = rows[0];
  if (!r) return { exists: false, owner: null, delivered: false, fallbackSent: false };
  return { exists: true, owner: oneOf(r.owner, OWNERS), delivered: iso(r.delivered_at) !== null, fallbackSent: iso(r.fallback_sent_at) !== null };
}

/** daily_briefings: any row with delivered_at in [fromIso, toIso). DD's table missing → false (no legacy brief can have
 *  been delivered); any other error throws. */
export async function legacyDeliveredBetween(fromIso: string, toIso: string, opts?: ReadOpts): Promise<boolean> {
  const from = validIso("legacyDeliveredBetween", fromIso, "fromIso");
  const to = validIso("legacyDeliveredBetween", toIso, "toIso");
  const signal = opts?.signal;
  const rows = await readRows("legacyDeliveredBetween",
    withSignal(db().from(LEGACY).select("id").gte("delivered_at", from).lt("delivered_at", to).limit(1), signal), signal);
  return rows !== null && rows.length > 0;
}

/** P8 fixer security-3 (M1): a legacy brief that may post any second now: an undelivered daily_briefings row whose meta.postingAt
 *  (stamped by the legacy runner with its upsert, BEFORE its late gate, and cleared when it doesn't post) is within the last 10
 *  minutes. The exec side reads it as delivered, so the two can never both DM. DD's table missing → false; any other error throws.
 *  Reads meta only. */
export async function legacyBriefInFlight(opts?: ReadOpts): Promise<boolean> {
  const fn = "legacyBriefInFlight";
  const signal = opts?.signal;
  const now = Date.now();
  const rows = await readRows(fn, withSignal(db().from(LEGACY).select("meta").is("delivered_at", null)
    .gte("created_at", new Date(now - LEGACY_SCAN_MS).toISOString()).order("created_at", { ascending: false }).limit(10), signal), signal);
  for (const r of rows ?? []) {
    const meta = r.meta !== null && typeof r.meta === "object" && !Array.isArray(r.meta) ? (r.meta as Row) : null;
    const at = iso(meta?.postingAt);
    if (at === null) continue;
    const t = Date.parse(at);
    if (t > now - LEGACY_IN_FLIGHT_MS && t <= now + 60_000) return true;
  }
  return false;
}

/** daily_briefings.meta of one row → { ranWhileSuperseded } (null: no row, or DD's table missing). Reads meta only. */
export async function getLegacyBriefMeta(briefId: string, opts?: ReadOpts): Promise<{ ranWhileSuperseded: boolean } | null> {
  if (typeof briefId !== "string" || briefId.length === 0 || briefId.length > 100) return null;
  const signal = opts?.signal;
  const rows = await readRows("getLegacyBriefMeta", withSignal(db().from(LEGACY).select("meta").eq("id", briefId).limit(1), signal), signal);
  if (!rows || rows.length === 0) return null;
  const meta = rows[0].meta;
  return { ranWhileSuperseded: meta !== null && typeof meta === "object" && (meta as Row).ranWhileSuperseded === true };
}

/** C22-P7b resolver: the latest delivered_at or fallback_sent_at of his briefs; null when none (or not installed). */
export async function lastDeliveredBriefAt(principal: ExecPrincipal, opts?: ReadOpts): Promise<string | null> {
  const pid = requirePrincipal("lastDeliveredBriefAt", principal);
  const signal = opts?.signal;
  let latest: number | null = null;
  for (const col of ["delivered_at", "fallback_sent_at"] as const) {
    const rows = await readRows("lastDeliveredBriefAt",
      withSignal(db().from(BRIEFS).select(col).eq("principal_id", pid).not(col, "is", null).order(col, { ascending: false }).limit(1), signal), signal);
    if (rows === null) return null;
    const at = iso(rows[0]?.[col]);
    if (at !== null && (latest === null || Date.parse(at) > latest)) latest = Date.parse(at);
  }
  return latest === null ? null : new Date(latest).toISOString();
}

export async function getMentions(principal: ExecPrincipal, fps: readonly string[], opts?: ReadOpts):
  Promise<Map<string, { stateHash: string; band: PriorityBand; lastMentionedOn: string }>> {   // chunks of 200
  const pid = requirePrincipal("getMentions", principal);
  const signal = opts?.signal;
  const out = new Map<string, { stateHash: string; band: PriorityBand; lastMentionedOn: string }>();
  for (const chunk of urlListChunks(cleanList(fps, 300))) {
    signal?.throwIfAborted();
    const rows = await readRows("getMentions",
      withSignal(db().from(MENTIONS).select("fingerprint,last_state_hash,last_band,last_mentioned_on").eq("principal_id", pid).in("fingerprint", chunk), signal),
      signal);
    if (rows === null) return new Map();
    for (const r of rows) {
      const fp = str(r.fingerprint);
      const stateHash = str(r.last_state_hash);
      const band = oneOf(r.last_band, BANDS);
      const on = ymd(r.last_mentioned_on);
      if (fp && stateHash && band && on) out.set(fp, { stateHash, band, lastMentionedOn: on });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build (RPCs 1, 2)
// ---------------------------------------------------------------------------

export type ClaimBuildResult =
  | { outcome: "claimed"; id: string; rev: number; first: boolean; fallbackSent: boolean; status: BriefStatus | null;
      /** C47: the regenerate claim's regen_seq (the job key's nonce); null for schedule/retry claims. */ regenSeq: number | null }
  | { outcome: "exists"; id: string; rev: number; status: BriefStatus }
  | { outcome: "conflict"; rev: number } | { outcome: "busy"; rev: number; status: BriefStatus }
  | { outcome: "not_found" } | { outcome: "not_installed" };

export async function claimBuild(principal: ExecPrincipal, input: { localDate: string; tz: string; scheduledAt: Date;
  trigger: BriefTrigger; expectedRev: number | null; contentExpiresAt: Date; expiresAt: Date; regenLockSeconds?: number }): Promise<ClaimBuildResult> {
  const fn = "claimBuild";
  const pid = requirePrincipal(fn, principal);
  const localDate = validYmd(fn, input?.localDate, "localDate");
  if (typeof input.tz !== "string" || input.tz.length < 1 || input.tz.length > 64) throw bad(fn, "tz must be 1..64 characters");
  const scheduledAt = validDate(fn, input.scheduledAt, "scheduledAt");
  const contentExpiresAt = validDate(fn, input.contentExpiresAt, "contentExpiresAt");
  const expiresAt = validDate(fn, input.expiresAt, "expiresAt");
  if (expiresAt.getTime() < contentExpiresAt.getTime()) throw bad(fn, "expiresAt must not be before contentExpiresAt");
  const trigger = oneOf(input.trigger, TRIGGERS);
  if (!trigger) throw bad(fn, "a trigger is required");
  if (trigger === "regenerate") validRev(fn, input.expectedRev, 10_000);
  else if (input.expectedRev !== null && input.expectedRev !== undefined) throw bad(fn, "expectedRev is for a regenerate only");
  const lock = input.regenLockSeconds;
  if (lock !== undefined && (typeof lock !== "number" || !Number.isSafeInteger(lock) || lock < 1)) throw bad(fn, "regenLockSeconds must be a positive integer");
  const { data, error } = await rpc(RPC_CLAIM_BUILD, {
    p_principal: pid,
    p_local_date: localDate,
    p_tz: input.tz,
    p_scheduled_at: scheduledAt.toISOString(),
    p_trigger: trigger,
    p_expected_rev: trigger === "regenerate" ? input.expectedRev : null,
    p_content_expires_at: contentExpiresAt.toISOString(),
    p_expires_at: expiresAt.toISOString(),
    p_regen_lock_seconds: trigger === "regenerate" ? (lock ?? BRIEF_LIMITS.regenLockSeconds) : null
  });
  if (error) {
    if (missing(error)) return { outcome: "not_installed" };
    throw failure(RPC_CLAIM_BUILD, error);
  }
  const r = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Row) : null;
  const rev = int(r?.rev);
  const id = str(r?.id);
  const status = oneOf(r?.status, BRIEF_STATUSES);
  switch (r?.outcome) {
    case "claimed":
      if (!id || !BRIEF_ID.test(id) || rev === null || typeof r.first !== "boolean" || typeof r.fallback_sent !== "boolean") throw malformed(RPC_CLAIM_BUILD);
      return { outcome: "claimed", id, rev, first: r.first, fallbackSent: r.fallback_sent, status, regenSeq: r.regen_seq === undefined ? null : int(r.regen_seq) };
    case "exists":
      if (!id || rev === null || !status) throw malformed(RPC_CLAIM_BUILD);
      return { outcome: "exists", id, rev, status };
    case "conflict":
      if (rev === null) throw malformed(RPC_CLAIM_BUILD);
      return { outcome: "conflict", rev };
    case "busy":
      if (rev === null || !status) throw malformed(RPC_CLAIM_BUILD);
      return { outcome: "busy", rev, status };
    case "not_found":
      return { outcome: "not_found" };
    default:
      throw malformed(RPC_CLAIM_BUILD);
  }
}

export interface FinishBuildInput {
  id: string; expectedRev: number; trigger: BriefTrigger; status: "built" | "page_only"; statusReason: BriefPageOnlyReason | null;
  owner: BriefOwner; ownerReason: BriefOwnerReason; mode: BriefMode; modeReason: BriefModeReason | null; content: BriefContent;
  refs: { threadIds: string[]; slackKeys: string[]; slackChannels: string[] };
  /** Distinct fps (de-duplicated here too), validated against the table CHECKs before the call. Sent by EVERY build, whatever the
   *  trigger; the RPC marks them only while novelty_marked_at is null (intel-16). */
  mentions: readonly { fp: string; state: string; band: PriorityBand }[]; mentionedOn: string;
}

/** The mentions RPC 2 is sent: de-duplicated by fingerprint (first wins), each checked against exec_brief_mentions' CHECKs. */
function cleanMentions(fn: string, list: FinishBuildInput["mentions"]): { fp: string; state: string; band: PriorityBand }[] {
  if (!Array.isArray(list)) throw bad(fn, "mentions must be an array");
  const out: { fp: string; state: string; band: PriorityBand }[] = [];
  const seen = new Set<string>();
  for (const m of list) {
    if (!m || typeof m.fp !== "string" || m.fp.length < 1 || m.fp.length > 300) throw bad(fn, "a mention's fingerprint must be 1..300 characters");
    if (typeof m.state !== "string" || m.state.length < 1 || m.state.length > 128) throw bad(fn, "a mention's state hash must be 1..128 characters");
    if (!oneOf(m.band, BANDS)) throw bad(fn, "a mention's band must be critical, high or normal");
    if (seen.has(m.fp)) continue;
    seen.add(m.fp);
    out.push({ fp: m.fp, state: m.state, band: m.band });
  }
  if (out.length > MENTIONS_MAX) throw bad(fn, `at most ${MENTIONS_MAX} mentions`);
  return out;
}

/** A denormalized ref array (§2.1.1 CHECKs: ≤ 400 / 400 / 200): non-empty strings, de-duplicated. */
function refList(fn: string, v: unknown, max: number, what: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.length === 0 || x.length > 300)) {
    throw bad(fn, `${what} must be an array of non-empty strings`);
  }
  const list = [...new Set(v as string[])];
  if (list.length > max) throw bad(fn, `at most ${max} ${what}`);
  return list;
}

export async function finishBuild(principal: ExecPrincipal, input: FinishBuildInput):
  Promise<{ outcome: "ok"; rev: number; status: BriefStatus; marked: number } | { outcome: "conflict"; rev: number; status: BriefStatus } | { outcome: "lost" }> {
  const fn = "finishBuild";
  requirePrincipal(fn, principal);
  const id = validBriefId(fn, input?.id);
  const expectedRev = validRev(fn, input.expectedRev, 10_000);
  const trigger = oneOf(input.trigger, TRIGGERS);
  if (!trigger) throw bad(fn, "a trigger is required");
  if (input.status !== "built" && input.status !== "page_only") throw bad(fn, "status must be built or page_only");
  if (input.statusReason !== null && (typeof input.statusReason !== "string" || !REASON.test(input.statusReason))) throw bad(fn, "a bad status reason");
  const owner = oneOf(input.owner, OWNERS);
  const ownerReason = oneOf(input.ownerReason, OWNER_REASONS);
  const mode = oneOf(input.mode, MODES);
  if (!owner || !ownerReason || !mode) throw bad(fn, "owner, ownerReason and mode are required");
  if (input.modeReason !== null && !oneOf(input.modeReason, MODE_REASONS)) throw bad(fn, "a bad mode reason");
  if (input.content === null || typeof input.content !== "object" || Array.isArray(input.content)) throw bad(fn, "content must be an object");
  const threadIds = refList(fn, input.refs?.threadIds, 400, "thread ids");
  const slackKeys = refList(fn, input.refs?.slackKeys, 400, "Slack keys");
  const slackChannels = refList(fn, input.refs?.slackChannels, 200, "Slack channels");
  const mentions = cleanMentions(fn, input.mentions);
  const mentionedOn = validYmd(fn, input.mentionedOn, "mentionedOn");
  const { data, error } = await rpc(RPC_FINISH_BUILD, {
    p_id: id,
    p_expected_rev: expectedRev,
    p_trigger: trigger,
    p_status: input.status,
    p_status_reason: input.statusReason,
    p_owner: owner,
    p_owner_reason: ownerReason,
    p_mode: mode,
    p_mode_reason: input.modeReason,
    p_content: input.content,
    p_thread_ids: threadIds,
    p_slack_keys: slackKeys,
    p_slack_channels: slackChannels,
    p_mentions: mentions,
    p_mentioned_on: mentionedOn
  });
  if (error) {
    if (missing(error)) throw notInstalled(error);
    throw failure(RPC_FINISH_BUILD, error);
  }
  const r = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Row) : null;
  const rev = int(r?.rev);
  const status = oneOf(r?.status, BRIEF_STATUSES);
  switch (r?.outcome) {
    case "ok":
      if (rev === null || !status) throw malformed(RPC_FINISH_BUILD);
      return { outcome: "ok", rev, status, marked: count(r.marked) };
    case "conflict":
      if (rev === null || !status) throw malformed(RPC_FINISH_BUILD);
      return { outcome: "conflict", rev, status };
    case "lost":
      return { outcome: "lost" };
    default:
      throw malformed(RPC_FINISH_BUILD);
  }
}

/** A build's own failure (C5): building → failed with status_reason pre_model | post_model and the error code, by CAS on
 *  (id, principal, status building, rev). */
export async function failBuild(principal: ExecPrincipal, id: string, rev: number, reason: "pre_model" | "post_model", code: string): Promise<boolean> {
  const fn = "failBuild";
  const pid = requirePrincipal(fn, principal);
  validBriefId(fn, id);
  validRev(fn, rev, 10_000);
  if (reason !== "pre_model" && reason !== "post_model") throw bad(fn, "reason must be pre_model or post_model");
  return casUpdate(fn, db().from(BRIEFS)
    .update({ status: "failed", status_reason: reason, error_code: safeCode(code), updated_at: nowIso() })
    .eq("id", id).eq("principal_id", pid).eq("status", "building").eq("rev", rev).select("id"));
}

/** A regenerate's failure, or a regenerate whose job couldn't be enqueued (C47): clears the lock on (id, rev). Never throws. */
export async function releaseRegenLock(principal: ExecPrincipal, id: string, rev: number): Promise<void> {   // never throws
  try {
    const pid = requirePrincipal("releaseRegenLock", principal);
    if (typeof id !== "string" || !BRIEF_ID.test(id) || typeof rev !== "number" || !Number.isSafeInteger(rev)) return;
    const { error } = (await db().from(BRIEFS).update({ regen_lock_until: null, updated_at: nowIso() }).eq("id", id).eq("principal_id", pid).eq("rev", rev)) as Result;
    if (error && !missing(error)) console.warn(`[exec-brief] releaseRegenLock failed (${pgCodeOf(error) ?? "error"})`);
  } catch (err) {
    console.warn(`[exec-brief] releaseRegenLock failed (${err instanceof Error ? err.name : "error"})`);
  }
}

// ---------------------------------------------------------------------------
// Delivery (RPCs 3, 4 + plain CAS)
// ---------------------------------------------------------------------------

/** RPC 3 (M2): one CAS step of the delivery status machine; true when it moved the row. A missing RPC → false (no post). */
export async function deliveryStep(id: string, step: { from: readonly BriefStatus[]; to: "delivering" | "delivered" | "delivery_unknown" | "page_only";
  countPost: boolean; channel?: string; ts?: string; reason?: BriefPageOnlyReason | BriefUnknownReason; errorCode?: string }): Promise<boolean> {
  const fn = "deliveryStep";
  validBriefId(fn, id);
  const from = Array.isArray(step?.from) ? [...new Set(step.from)] : [];
  if (from.length === 0 || from.some((s) => !(DELIVERY_SOURCES as readonly string[]).includes(s))) throw bad(fn, "from ⊆ {built, page_only, delivering}");
  if (!["delivering", "delivered", "delivery_unknown", "page_only"].includes(step.to)) throw bad(fn, "a bad target status");
  if (typeof step.countPost !== "boolean" || step.countPost !== (step.to === "delivering")) throw bad(fn, "a post is counted exactly on the way into delivering");
  const channel = step.to === "delivered" ? validDmChannel(fn, step.channel, "channel") : null;
  const ts = step.to === "delivered" ? validTs(fn, step.ts, "ts") : null;
  const reason = step.to === "page_only" || step.to === "delivery_unknown" ? step.reason ?? null : null;
  if (reason !== null && !REASON.test(reason)) throw bad(fn, "a bad reason");
  const { data, error } = await rpc(RPC_DELIVERY_STEP, {
    p_id: id,
    p_from: from,
    p_to: step.to,
    p_count_post: step.countPost,
    p_channel: channel,
    p_ts: ts,
    p_reason: reason,
    p_error_code: step.errorCode === undefined ? null : safeCode(step.errorCode)
  });
  if (error) {
    if (missing(error)) return false;
    throw failure(RPC_DELIVERY_STEP, error);
  }
  return data === true;
}

/** RPC 4 (M7): insert the day's row when missing, then stamp fallback_sent_at by CAS. */
export async function claimFallback(principal: ExecPrincipal, input: { localDate: string; tz: string; scheduledAt: Date; contentExpiresAt: Date; expiresAt: Date }):
  Promise<{ outcome: "claimed" | "delivered" | "in_flight" | "already"; id: string; status: BriefStatus | null } | { outcome: "not_installed" }> {
  const fn = "claimFallback";
  const pid = requirePrincipal(fn, principal);
  const localDate = validYmd(fn, input?.localDate, "localDate");
  if (typeof input.tz !== "string" || input.tz.length < 1 || input.tz.length > 64) throw bad(fn, "tz must be 1..64 characters");
  const scheduledAt = validDate(fn, input.scheduledAt, "scheduledAt");
  const contentExpiresAt = validDate(fn, input.contentExpiresAt, "contentExpiresAt");
  const expiresAt = validDate(fn, input.expiresAt, "expiresAt");
  if (expiresAt.getTime() < contentExpiresAt.getTime()) throw bad(fn, "expiresAt must not be before contentExpiresAt");
  const { data, error } = await rpc(RPC_CLAIM_FALLBACK, {
    p_principal: pid,
    p_local_date: localDate,
    p_tz: input.tz,
    p_scheduled_at: scheduledAt.toISOString(),
    p_content_expires_at: contentExpiresAt.toISOString(),
    p_expires_at: expiresAt.toISOString()
  });
  if (error) {
    if (missing(error)) return { outcome: "not_installed" };
    throw failure(RPC_CLAIM_FALLBACK, error);
  }
  const r = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Row) : null;
  const id = str(r?.id);
  const outcome = oneOf(r?.outcome, ["claimed", "delivered", "in_flight", "already"] as const);
  if (!outcome || !id) throw malformed(RPC_CLAIM_FALLBACK);
  return { outcome, id, status: oneOf(r?.status, BRIEF_STATUSES) };
}

/** C49: a posted mini-brief stores its DD-bot IM channel, ts and deletion time (fallback_sent_at + retentionDaysChat, ≤ expires_at). */
export async function recordFallbackResult(id: string, r: { channel: string; ts: string; deleteAfter: Date } | { errorCode: string }): Promise<boolean> {
  const fn = "recordFallbackResult";
  validBriefId(fn, id);
  let patch: Row;
  if (r && "errorCode" in r) {
    patch = { fallback_error_code: safeCode(r.errorCode), updated_at: nowIso() };
  } else {
    patch = {
      fallback_channel_id: validDmChannel(fn, r?.channel, "channel"),
      fallback_slack_ts: validTs(fn, r?.ts, "ts"),
      fallback_delete_after: validDate(fn, r?.deleteAfter, "deleteAfter").toISOString(),
      updated_at: nowIso()
    };
  }
  return casUpdate(fn, db().from(BRIEFS).update(patch).eq("id", id).not("fallback_sent_at", "is", null).is("fallback_slack_ts", null)
    .is("fallback_error_code", null).select("id"));
}

/** C49 (system purge): mini-brief DMs due for deletion, oldest first; refs only. */
export async function listFallbackDmsDue(now: Date, limit: number): Promise<{ id: string; channel: string; ts: string }[]> {
  const fn = "listFallbackDmsDue";
  const at = validDate(fn, now, "now");
  const n = typeof limit === "number" && Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 1000) : 50;
  const rows = await readRows(fn, db().from(BRIEFS).select("id,fallback_channel_id,fallback_slack_ts").not("fallback_slack_ts", "is", null)
    .is("fallback_deleted_at", null).lt("fallback_delete_after", at.toISOString()).order("fallback_delete_after", { ascending: true }).limit(n));
  const out: { id: string; channel: string; ts: string }[] = [];
  for (const r of rows ?? []) {
    const id = str(r.id);
    const channel = str(r.fallback_channel_id);
    const ts = str(r.fallback_slack_ts);
    if (id && BRIEF_ID.test(id) && channel && DM_CHANNEL.test(channel) && isTs(ts)) out.push({ id, channel, ts });
  }
  return out;
}

/** Idempotent: true the first time, false once already marked. */
export async function markFallbackDmDeleted(id: string): Promise<boolean> {
  const fn = "markFallbackDmDeleted";
  validBriefId(fn, id);
  return casUpdate(fn, db().from(BRIEFS).update({ fallback_deleted_at: nowIso(), updated_at: nowIso() }).eq("id", id).is("fallback_deleted_at", null)
    .not("fallback_slack_ts", "is", null).select("id"));
}

/** C11: the check-ins message's ts, set once. */
export async function recordCheckinsMessage(id: string, ts: string): Promise<boolean> {
  const fn = "recordCheckinsMessage";
  validBriefId(fn, id);
  return casUpdate(fn, db().from(BRIEFS).update({ checkins_ts: validTs(fn, ts, "ts"), updated_at: nowIso() }).eq("id", id).is("checkins_ts", null)
    .select("id"));
}

/** C34: the late note's ts, set once, only after a fallback. */
export async function recordLateNote(id: string, ts: string): Promise<boolean> {
  const fn = "recordLateNote";
  validBriefId(fn, id);
  return casUpdate(fn, db().from(BRIEFS).update({ late_note_ts: validTs(fn, ts, "ts"), updated_at: nowIso() }).eq("id", id).is("late_note_ts", null)
    .not("fallback_sent_at", "is", null).select("id"));
}

/** C15: delivered briefs scrubbed since their DM was last followed up (dm_followed_at null or before scrubbed_at), oldest
 *  scrub first; refs only. */
export async function listFollowups(principal: ExecPrincipal, limit: number): Promise<{ id: string; channel: string; ts: string; scrubbedAt: string }[]> {
  const fn = "listFollowups";
  const pid = requirePrincipal(fn, principal);
  const n = typeof limit === "number" && Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 10;
  // Served by exec_briefs_followup_idx; the column-to-column comparison (dm_followed_at < scrubbed_at) is done here.
  const rows = await readRows(fn, db().from(BRIEFS).select("id,slack_channel_id,slack_ts,scrubbed_at,dm_followed_at").eq("principal_id", pid)
    .not("scrubbed_at", "is", null).not("delivered_at", "is", null).order("scrubbed_at", { ascending: true }).limit(FOLLOWUP_SCAN));
  const out: { id: string; channel: string; ts: string; scrubbedAt: string }[] = [];
  for (const r of rows ?? []) {
    const id = str(r.id);
    const channel = str(r.slack_channel_id);
    const ts = str(r.slack_ts);
    const scrubbedAt = iso(r.scrubbed_at);
    const followed = iso(r.dm_followed_at);
    if (!id || !channel || !isTs(ts) || !scrubbedAt) continue;
    if (followed !== null && Date.parse(followed) >= Date.parse(scrubbedAt)) continue;
    out.push({ id, channel, ts, scrubbedAt });
    if (out.length >= n) break;
  }
  return out;
}

/** dm_followed_at = scrubbedAt where it is null or earlier (a later scrub needs a new follow-up). */
export async function markDmFollowed(id: string, scrubbedAt: string): Promise<void> {
  const fn = "markDmFollowed";
  validBriefId(fn, id);
  const at = validIso(fn, scrubbedAt, "scrubbedAt");
  const patch = { dm_followed_at: at, updated_at: nowIso() };
  for (const q of [
    db().from(BRIEFS).update(patch).eq("id", id).is("dm_followed_at", null),
    db().from(BRIEFS).update(patch).eq("id", id).lt("dm_followed_at", at)
  ]) {
    const { error } = (await q) as Result;
    if (error && !missing(error)) throw failure(fn, error);
  }
}

/** stale_build (building, build_started_at < now − 10 min) and never_built (building, build_started_at null, created_at < now − 2 h). */
export async function failStaleBuilds(principal: ExecPrincipal, now: Date): Promise<{ staleBuild: string[]; neverBuilt: string[] }> {
  const fn = "failStaleBuilds";
  const pid = requirePrincipal(fn, principal);
  const t = validDate(fn, now, "now").getTime();
  const stamp = nowIso();
  const ids = (rows: Row[] | null) => (rows ?? []).map((r) => str(r.id)).filter((x): x is string => x !== null);
  const stale = await readRows(fn, db().from(BRIEFS).update({ status: "failed", status_reason: "stale_build", updated_at: stamp })
    .eq("principal_id", pid).eq("status", "building").lt("build_started_at", new Date(t - STALE_BUILDING_MS).toISOString()).select("id"));
  const never = await readRows(fn, db().from(BRIEFS).update({ status: "failed", status_reason: "never_built", updated_at: stamp })
    .eq("principal_id", pid).eq("status", "building").is("build_started_at", null).lt("created_at", new Date(t - NEVER_BUILT_MS).toISOString()).select("id"));
  return { staleBuild: ids(stale), neverBuilt: ids(never) };
}

/** 'delivering' rows whose last step (updated_at) is older than olderThan: a post that may have crashed mid-flight. */
export async function listStaleDelivering(principal: ExecPrincipal, olderThan: Date): Promise<BriefRow[]> {
  const fn = "listStaleDelivering";
  const pid = requirePrincipal(fn, principal);
  const at = validDate(fn, olderThan, "olderThan").toISOString();
  const rows = await readRows(fn, db().from(BRIEFS).select(BRIEF_COLS).eq("principal_id", pid).eq("status", "delivering").lt("updated_at", at)
    .order("local_date", { ascending: true }).limit(20));
  return (rows ?? []).map((r) => toBriefRow(r, fn));
}

/** C48: status 'built' and built_at < builtBefore. */
export async function listStaleBuilt(principal: ExecPrincipal, builtBefore: Date): Promise<BriefRow[]> {
  const fn = "listStaleBuilt";
  const pid = requirePrincipal(fn, principal);
  const at = validDate(fn, builtBefore, "builtBefore").toISOString();
  const rows = await readRows(fn, db().from(BRIEFS).select(BRIEF_COLS).eq("principal_id", pid).eq("status", "built").lt("built_at", at)
    .order("local_date", { ascending: true }).limit(20));
  return (rows ?? []).map((r) => toBriefRow(r, fn));
}

/** C16 hold-back (intel-13): the earliest of the principal's builds in flight: build_started_at of 'building' rows (a placeholder's null
 *  excluded) and, for a regenerate (regen_lock_until > now), regen_lock_until − 900 s (the longest lock); null when none (§3.17.7). */
export async function oldestBuildInFlight(principal: ExecPrincipal): Promise<string | null> {
  const fn = "oldestBuildInFlight";
  const pid = requirePrincipal(fn, principal);
  const building = await readRows(fn, db().from(BRIEFS).select("build_started_at").eq("principal_id", pid).eq("status", "building")
    .not("build_started_at", "is", null).order("build_started_at", { ascending: true }).limit(1));
  if (building === null) return null;
  const locks = await readRows(fn, db().from(BRIEFS).select("regen_lock_until").eq("principal_id", pid).gt("regen_lock_until", nowIso())
    .order("regen_lock_until", { ascending: true }).limit(1));
  const times: number[] = [];
  const started = iso(building[0]?.build_started_at);
  if (started) times.push(Date.parse(started));
  const lock = iso(locks?.[0]?.regen_lock_until);
  if (lock) times.push(Date.parse(lock) - MAX_REGEN_LOCK_MS);
  return times.length === 0 ? null : new Date(Math.min(...times)).toISOString();
}

// ---------------------------------------------------------------------------
// Scrubs and purge (RPCs 5–7)
// ---------------------------------------------------------------------------

/** M9: null = not installed (the tombstone procedure continues); other errors throw (retryable). Chunks of 500. */
export async function scrubBriefsForThreads(principal: ExecPrincipal, threadIds: readonly string[], opts?: ReadOpts): Promise<number | null> {
  const fn = "scrubBriefsForThreads";
  const pid = requirePrincipal(fn, principal);
  const ids = cleanList(threadIds, 500);
  if (ids.length === 0) return 0;
  const signal = opts?.signal;
  let n = 0;
  for (const chunk of chunks(ids, SCRUB_CHUNK)) {
    signal?.throwIfAborted();
    const { data, error } = await rpc(RPC_SCRUB_THREADS, { p_principal: pid, p_thread_ids: chunk }, signal);
    if (error) {
      if (missing(error)) {
        signal?.throwIfAborted();
        return null;
      }
      throw failure(RPC_SCRUB_THREADS, error, signal);
    }
    const c = int(data);
    if (c === null || c < 0) throw malformed(RPC_SCRUB_THREADS);
    n += c;
  }
  return n;
}

/** C16: brief lines citing these Slack message / digest keys or conversations, or (all) every Slack-derived line, become
 *  "[Removed: no longer available in Slack]". null = not installed; other errors throw. ≤ 500 keys and 500 channels per call. */
export async function scrubBriefsForSlack(principal: ExecPrincipal, q: { slackKeys: readonly string[]; channels: readonly string[]; all: boolean },
  opts?: ReadOpts): Promise<number | null> {
  const fn = "scrubBriefsForSlack";
  const pid = requirePrincipal(fn, principal);
  const keys = cleanList(q?.slackKeys, 300);
  const channels = cleanList(q?.channels, 100);
  const all = q?.all === true;
  if (!all && keys.length === 0 && channels.length === 0) return 0;
  const calls: { keys: string[]; channels: string[] }[] = [];
  if (all) {
    calls.push({ keys: [], channels: [] });
  } else {
    const k = chunks(keys, SCRUB_CHUNK);
    const c = chunks(channels, SCRUB_CHUNK);
    for (let i = 0; i < Math.max(k.length, c.length); i += 1) calls.push({ keys: k[i] ?? [], channels: c[i] ?? [] });
  }
  const signal = opts?.signal;
  let n = 0;
  for (const call of calls) {
    signal?.throwIfAborted();
    const { data, error } = await rpc(RPC_SCRUB_SLACK, { p_principal: pid, p_slack_keys: call.keys, p_channels: call.channels, p_all: all }, signal);
    if (error) {
      if (missing(error)) {
        signal?.throwIfAborted();
        return null;
      }
      throw failure(RPC_SCRUB_SLACK, error, signal);
    }
    const c = int(data);
    if (c === null || c < 0) throw malformed(RPC_SCRUB_SLACK);
    n += c;
  }
  return n;
}

/** System purge (M10): principal ids whose briefs still cite Slack (content present, ref_slack_channels non-empty). */
export async function listPrincipalIdsWithSlackLines(limit: number, opts?: ReadOpts): Promise<string[]> {
  const fn = "listPrincipalIdsWithSlackLines";
  const n = typeof limit === "number" && Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 1000) : 100;
  const signal = opts?.signal;
  let query = db().from(BRIEFS).select("principal_id").not("content", "is", null).neq("ref_slack_channels", "{}");
  query = query.order("principal_id", { ascending: true }).limit(5000);
  if (signal) query = query.abortSignal(signal);
  const rows = await readRows(fn, query, signal);
  const out: string[] = [];
  for (const r of rows ?? []) {
    const p = str(r.principal_id);
    if (p && !out.includes(p)) out.push(p);
    if (out.length >= n) break;
  }
  return out;
}

/** M10 step 3: every Slack-derived line of one principal's briefs (the reading half is gone). Principal-free (system purge). */
export async function scrubBriefsForSlackSystem(principalId: string, opts?: ReadOpts): Promise<number | null> {
  const fn = "scrubBriefsForSlackSystem";
  if (typeof principalId !== "string" || principalId.length === 0 || principalId.length > 100) throw bad(fn, "a principal id is required");
  const signal = opts?.signal;
  const { data, error } = await rpc(RPC_SCRUB_SLACK, { p_principal: principalId, p_slack_keys: [], p_channels: [], p_all: true }, signal);
  if (error) {
    if (missing(error)) {
      signal?.throwIfAborted();
      return null;
    }
    throw failure(RPC_SCRUB_SLACK, error, signal);
  }
  const c = int(data);
  if (c === null || c < 0) throw malformed(RPC_SCRUB_SLACK);
  return c;
}

/** RPC 7 (M9, C28) up to 10 times while any count equals the batch (P4's pattern), with p_mention_cutoff = UTC date(now) − 90
 *  days. A missing function → zeros. */
export async function purgeExpiredBriefs(now: Date, opts?: ReadOpts):
  Promise<{ contentPurged: number; briefsDeleted: number; checkinsDeleted: number; mentionsDeleted: number }> {
  const fn = "purgeExpiredBriefs";
  const at = validDate(fn, now, "now");
  const signal = opts?.signal;
  const cutoff = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - MENTION_TTL_DAYS * DAY_MS).toISOString().slice(0, 10);
  const total = { contentPurged: 0, briefsDeleted: 0, checkinsDeleted: 0, mentionsDeleted: 0 };
  for (let round = 0; round < PURGE_ROUNDS; round += 1) {
    signal?.throwIfAborted();
    const { data, error } = await rpc(RPC_PURGE_EXPIRED, { p_now: at.toISOString(), p_limit: PURGE_BATCH, p_mention_cutoff: cutoff }, signal);
    if (error) {
      if (missing(error)) {
        signal?.throwIfAborted();
        return total;
      }
      throw failure(RPC_PURGE_EXPIRED, error, signal);
    }
    const r = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Row) : null;
    const read = (k: keyof typeof total): number => {
      const v = int(r?.[k]);
      if (v === null || v < 0) throw malformed(RPC_PURGE_EXPIRED);
      return v;
    };
    const step = { contentPurged: read("contentPurged"), briefsDeleted: read("briefsDeleted"), checkinsDeleted: read("checkinsDeleted"),
      mentionsDeleted: read("mentionsDeleted") };
    total.contentPurged += step.contentPurged;
    total.briefsDeleted += step.briefsDeleted;
    total.checkinsDeleted += step.checkinsDeleted;
    total.mentionsDeleted += step.mentionsDeleted;
    if (!Object.values(step).some((v) => v === PURGE_BATCH)) break;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Check-ins
// ---------------------------------------------------------------------------

export async function insertCheckins(principal: ExecPrincipal, rows: readonly NewCheckin[]): Promise<CheckinRow[]> {   // identical key set
  const fn = "insertCheckins";
  const pid = requirePrincipal(fn, principal);
  if (!Array.isArray(rows)) throw bad(fn, "rows must be an array");
  if (rows.length === 0) return [];
  const payload = rows.map((r) => {
    const text = r?.text;
    if (typeof text !== "string" || text.length < 1 || text.length > BRIEF_LIMITS.checkinTextChars) throw bad(fn, "a check-in text must be 1..600 characters");
    if (typeof r.recipientUserId !== "string" || r.recipientUserId.length === 0 || r.recipientUserId.length > 100) throw bad(fn, "a recipient user id is required");
    if (typeof r.recipientSlackId !== "string" || !SLACK_USER.test(r.recipientSlackId)) throw bad(fn, "a recipient Slack id is required");
    const expiresAt = validIso(fn, r.expiresAt, "expiresAt");
    const purgeAt = validIso(fn, r.purgeAt, "purgeAt");
    if (Date.parse(purgeAt) < Date.parse(expiresAt)) throw bad(fn, "purgeAt must not be before expiresAt");
    const row: Record<(typeof CHECKIN_ROW_KEYS)[number], unknown> = {
      principal_id: pid,
      brief_id: validBriefId(fn, r.briefId),
      local_date: validYmd(fn, r.localDate, "localDate"),
      brief_rev: validRev(fn, r.briefRev, 10_000),
      recipient_user_id: r.recipientUserId,
      recipient_slack_id: r.recipientSlackId,
      text,
      expires_at: expiresAt,
      purge_at: purgeAt
    };
    return row;
  });
  const { data, error } = (await db().from(CHECKINS).insert(payload).select(CHECKIN_COLS)) as Result;
  if (error) {
    if (missing(error)) throw notInstalled(error);
    throw failure(fn, error);
  }
  return rowsOf({ data, error: null }).map((r) => toCheckinRow(r, fn));
}

export async function listCheckinsForBrief(principal: ExecPrincipal, briefId: string, opts?: ReadOpts): Promise<CheckinRow[]> {
  const fn = "listCheckinsForBrief";
  const pid = requirePrincipal(fn, principal);
  if (typeof briefId !== "string" || !BRIEF_ID.test(briefId)) return [];
  const signal = opts?.signal;
  const rows = await readRows(fn, withSignal(db().from(CHECKINS).select(CHECKIN_COLS).eq("principal_id", pid).eq("brief_id", briefId)
    .order("created_at", { ascending: true }).order("id", { ascending: true }).limit(50), signal), signal);
  return (rows ?? []).map((r) => toCheckinRow(r, fn));
}

export async function getCheckin(principal: ExecPrincipal, id: string, opts?: ReadOpts): Promise<CheckinRow | null> {
  const fn = "getCheckin";
  const pid = requirePrincipal(fn, principal);
  if (typeof id !== "string" || !CHECKIN_ID.test(id)) return null;
  const signal = opts?.signal;
  const rows = await readRows(fn, withSignal(db().from(CHECKINS).select(CHECKIN_COLS).eq("principal_id", pid).eq("id", id).limit(1), signal), signal);
  return rows && rows.length > 0 ? toCheckinRow(rows[0], fn) : null;
}

/** Plain-row CAS: update … where id and principal_id and status in (from) and rev = rev. The patch is always { status,
 *  status_reason (reason ?? null), updated_at } plus exactly the optional columns the step names (ST03: never an undefined
 *  value, never a column the step didn't ask for, so a later step can't null an earlier step's stamp). */
export async function checkinStep(principal: ExecPrincipal, id: string, step: { from: readonly CheckinStatus[]; rev: number; to: CheckinStatus;
  reason?: string | null; sendingAt?: string; auditId?: number; sentAt?: string; channel?: string; ts?: string }): Promise<boolean> {
  const fn = "checkinStep";
  const pid = requirePrincipal(fn, principal);
  validCheckinId(fn, id);
  const from = Array.isArray(step?.from) ? [...new Set(step.from)] : [];
  if (from.length === 0 || from.some((s) => !CHECKIN_STATUSES.includes(s))) throw bad(fn, "from must list check-in statuses");
  validRev(fn, step.rev, 1000);
  if (!CHECKIN_STATUSES.includes(step.to)) throw bad(fn, "a bad target status");
  const reason = step.reason ?? null;
  if (reason !== null && (typeof reason !== "string" || !CHECKIN_REASON.test(reason))) throw bad(fn, "a bad reason");
  const patch: Row = { status: step.to, status_reason: reason, updated_at: nowIso() };
  if (step.sendingAt !== undefined) patch.sending_at = validIso(fn, step.sendingAt, "sendingAt");
  if (step.auditId !== undefined) {
    if (typeof step.auditId !== "number" || !Number.isSafeInteger(step.auditId) || step.auditId < 1) throw bad(fn, "auditId must be a positive integer");
    patch.audit_id = step.auditId;
  }
  if (step.sentAt !== undefined) patch.sent_at = validIso(fn, step.sentAt, "sentAt");
  if (step.channel !== undefined) patch.slack_channel_id = validDmChannel(fn, step.channel, "channel");
  if (step.ts !== undefined) patch.slack_ts = validTs(fn, step.ts, "ts");
  return casUpdate(fn, db().from(CHECKINS).update(patch).eq("id", id).eq("principal_id", pid).in("status", from).eq("rev", step.rev).select("id"));
}

/** Rewrite: set text, rev = rev + 1 where id, status = 'proposed', rev = rev (M6). */
export async function rewriteCheckin(principal: ExecPrincipal, id: string, rev: number, text: string): Promise<boolean> {
  const fn = "rewriteCheckin";
  const pid = requirePrincipal(fn, principal);
  validCheckinId(fn, id);
  validRev(fn, rev, 999);
  if (typeof text !== "string" || text.length < 1 || text.length > BRIEF_LIMITS.checkinTextChars) throw bad(fn, "a check-in text must be 1..600 characters");
  return casUpdate(fn, db().from(CHECKINS).update({ text, rev: rev + 1, updated_at: nowIso() }).eq("id", id).eq("principal_id", pid)
    .eq("status", "proposed").eq("rev", rev).select("id"));
}

/** Expires 'proposed' rows: of one brief (C12 superseded), of earlier local dates (C45 next_brief) or past expires_at. At least one
 *  filter is required. Returns how many rows moved. */
export async function expireCheckins(principal: ExecPrincipal, q: { briefId?: string; beforeLocalDate?: string; expiredBefore?: Date;
  reason: "superseded" | "next_brief" | "expired" }): Promise<number> {
  const fn = "expireCheckins";
  const pid = requirePrincipal(fn, principal);
  if (!q || !["superseded", "next_brief", "expired"].includes(q.reason)) throw bad(fn, "a reason is required");
  if (q.briefId === undefined && q.beforeLocalDate === undefined && q.expiredBefore === undefined) throw bad(fn, "a filter is required");
  let query = db().from(CHECKINS).update({ status: "expired", status_reason: q.reason, updated_at: nowIso() }).eq("principal_id", pid).eq("status", "proposed");
  if (q.briefId !== undefined) query = query.eq("brief_id", validBriefId(fn, q.briefId));
  if (q.beforeLocalDate !== undefined) query = query.lt("local_date", validYmd(fn, q.beforeLocalDate, "beforeLocalDate"));
  if (q.expiredBefore !== undefined) query = query.lte("expires_at", validDate(fn, q.expiredBefore, "expiredBefore").toISOString());
  const rows = await readRows(fn, query.select("id"));
  return rows?.length ?? 0;
}

/** C50: 'sending' rows with sending_at < before → 'unknown' (status_reason 'stale_sending'); returns their brief ids (to re-render). */
export async function resolveStaleSendingCheckins(principal: ExecPrincipal, before: Date): Promise<string[]> {
  const fn = "resolveStaleSendingCheckins";
  const pid = requirePrincipal(fn, principal);
  const at = validDate(fn, before, "before").toISOString();
  const rows = await readRows(fn, db().from(CHECKINS).update({ status: "unknown", status_reason: "stale_sending", updated_at: nowIso() })
    .eq("principal_id", pid).eq("status", "sending").lt("sending_at", at).select("brief_id"));
  return [...new Set((rows ?? []).map((r) => str(r.brief_id)).filter((x): x is string => x !== null && BRIEF_ID.test(x)))];
}

/** M14: today's live proposals (status proposed, expires_at > now): the count and the oldest created_at. Not installed → 0. */
export async function countPendingCheckins(principal: ExecPrincipal, localDate: string, now: Date): Promise<{ count: number; oldestAt: string | null }> {
  const fn = "countPendingCheckins";
  const pid = requirePrincipal(fn, principal);
  const date = validYmd(fn, localDate, "localDate");
  const at = validDate(fn, now, "now").toISOString();
  const result = (await db().from(CHECKINS).select("created_at", { count: "exact" }).eq("principal_id", pid).eq("local_date", date)
    .eq("status", "proposed").gt("expires_at", at).order("created_at", { ascending: true }).limit(1)) as Result;
  if (result.error) {
    if (missing(result.error)) return { count: 0, oldestAt: null };
    throw failure(fn, result.error);
  }
  const rows = rowsOf(result);
  const n = typeof result.count === "number" && Number.isSafeInteger(result.count) ? result.count : rows.length;
  return { count: n, oldestAt: iso(rows[0]?.created_at) };
}

export async function checkinCounts(principal: ExecPrincipal, localDate: string): Promise<Record<CheckinStatus, number>> {
  const fn = "checkinCounts";
  const pid = requirePrincipal(fn, principal);
  const date = validYmd(fn, localDate, "localDate");
  const out = Object.fromEntries(CHECKIN_STATUSES.map((s) => [s, 0])) as Record<CheckinStatus, number>;
  const rows = await readRows(fn, db().from(CHECKINS).select("status").eq("principal_id", pid).eq("local_date", date).limit(1000));
  for (const r of rows ?? []) {
    const s = oneOf(r.status, CHECKIN_STATUSES);
    if (s) out[s] += 1;
  }
  return out;
}

/** user id → newest created_at of an exec check-in since sinceIso (any status but expired-with-reason superseded). */
export async function listRecentCheckinRecipients(principal: ExecPrincipal, sinceIso: string): Promise<Map<string, string>> {
  const fn = "listRecentCheckinRecipients";
  const pid = requirePrincipal(fn, principal);
  const since = validIso(fn, sinceIso, "sinceIso");
  const rows = await readRows(fn, db().from(CHECKINS).select("recipient_user_id,created_at,status,status_reason").eq("principal_id", pid)
    .gte("created_at", since).order("created_at", { ascending: false }).limit(2000));
  const out = new Map<string, string>();
  for (const r of rows ?? []) {
    if (r.status === "expired" && r.status_reason === "superseded") continue;
    const user = str(r.recipient_user_id);
    const at = iso(r.created_at);
    if (!user || !at) continue;
    const prev = out.get(user);
    if (prev === undefined || Date.parse(at) > Date.parse(prev)) out.set(user, at);
  }
  return out;
}

/** user id → up to perUser most recent sent texts (newest first). DD-only data (M6): the check-in model's variety input. */
export async function listSentCheckinTexts(principal: ExecPrincipal, userIds: readonly string[], perUser: number): Promise<Map<string, string[]>> {
  const fn = "listSentCheckinTexts";
  const pid = requirePrincipal(fn, principal);
  const per = typeof perUser === "number" && Number.isSafeInteger(perUser) ? Math.min(Math.max(perUser, 0), 10) : 3;
  const out = new Map<string, string[]>();
  if (per === 0) return out;
  for (const chunk of urlListChunks(cleanList(userIds, 100))) {
    const rows = await readRows(fn, db().from(CHECKINS).select("recipient_user_id,text,sent_at").eq("principal_id", pid).eq("status", "sent")
      .in("recipient_user_id", chunk).order("sent_at", { ascending: false }).limit(chunk.length * per * 4));
    if (rows === null) return new Map();
    for (const r of rows) {
      const user = str(r.recipient_user_id);
      const text = str(r.text);
      if (!user || !text) continue;
      const list = out.get(user) ?? [];
      if (list.length < per) list.push(text);
      out.set(user, list);
    }
  }
  return out;
}

/** daily_briefings.messages since sinceYmd: userId → newest brief_date (any message status; the legacy rotation). Malformed
 *  rows and entries are skipped; DD's table missing → an empty map. Reads only ids and dates out of each entry. */
export async function listLegacyCheckinRecipients(sinceYmd: string): Promise<Map<string, string>> {
  const fn = "listLegacyCheckinRecipients";
  const since = validYmd(fn, sinceYmd, "sinceYmd");
  const rows = await readRows(fn, db().from(LEGACY).select("brief_date,messages").gte("brief_date", since).order("brief_date", { ascending: false }).limit(60));
  const out = new Map<string, string>();
  for (const r of rows ?? []) {
    const date = typeof r.brief_date === "string" && LOCAL_DATE.test(r.brief_date) ? r.brief_date : null;
    if (!date || !Array.isArray(r.messages)) continue;
    for (const m of r.messages as unknown[]) {
      if (m === null || typeof m !== "object" || Array.isArray(m)) continue;
      const user = (m as Row).userId;
      if (typeof user !== "string" || user.length === 0 || user.length > 100) continue;
      const prev = out.get(user);
      if (prev === undefined || date > prev) out.set(user, date);
    }
  }
  return out;
}

/** A6: of these Slack keys, the ones that are check-in posts of this principal ("<channelId>:<ts>" strings). */
export async function checkinPostKeys(principal: ExecPrincipal, keys: readonly { channelId: string; ts: string }[]): Promise<Set<string>> {
  const fn = "checkinPostKeys";
  const pid = requirePrincipal(fn, principal);
  const wanted = new Set<string>();
  for (const k of Array.isArray(keys) ? keys : []) {
    if (k && typeof k.channelId === "string" && /^[CGD][A-Z0-9]{2,30}$/.test(k.channelId) && isTs(k.ts)) wanted.add(`${k.channelId}:${k.ts}`);
  }
  const out = new Set<string>();
  if (wanted.size === 0) return out;
  const tsList = [...new Set([...wanted].map((w) => w.slice(w.indexOf(":") + 1)))];
  for (const chunk of urlListChunks(tsList)) {
    const rows = await readRows(fn, db().from(CHECKINS).select("slack_channel_id,slack_ts").eq("principal_id", pid).in("slack_ts", chunk));
    if (rows === null) return new Set();
    for (const r of rows) {
      const key = `${str(r.slack_channel_id) ?? ""}:${str(r.slack_ts) ?? ""}`;
      if (wanted.has(key)) out.add(key);
    }
  }
  return out;
}

/** Test seam: forget the per-process schema cache. */
export function __resetBriefStoreForTests(): void {
  schemaCache = null;
}
