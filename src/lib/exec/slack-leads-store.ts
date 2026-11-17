import "server-only";

import { P10_LIMITS } from "@/lib/exec/slack-p10-types";
import type {
  LeadChannelState,
  LeadCoverage,
  LeadDayCount,
  LeadKind,
  LeadLink,
  LeadMapRow,
  LeadMarkerRow,
  LeadSummaryRow
} from "@/lib/exec/slack-p10-types";
import type { ConvType } from "@/lib/exec/slack-read-types";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P10 lead-count store (contract §3.4.4; Area A; server-only): the only module naming exec_slack_lead_channels,
// exec_slack_lead_counts and the lead functions of §2.1.7 (B-P10-1). Ids, enums, DD labels, dates and integers only: nothing
// from a lead post ever reaches this module (H3), and no lead channel id ever reaches a log line (C21).
//
//   * Errors are SlackLeadsStoreError(op, pgCode): the function's name and the database's own code, never a value this
//     module was handed or read (no ids, dates, labels). An aborted signal wins: its reason is thrown instead.
//   * A missing table / function / column (the P10 migration isn't applied, §2.4 item 2) maps to the signature's "not
//     installed" answer: false, [], null, zeros. A write whose answer can't say it (applyLeadMap, putLeadCounts) throws
//     SlackLeadsStoreError("not_installed", code).
//   * Arguments are checked here (the shapes the table CHECKs and the RPCs require); a bad argument is a TypeError naming the
//     argument, never its value.
//   * Batch writes build every row with the identical key set (§0.3 rule 14).
//   * noteLeadChannelError never throws: a failure is logged by op, principal id and code only.

const CHANNELS = "exec_slack_lead_channels";
const RPC_MARKERS = "exec_slack_lead_markers";
const RPC_MAP_APPLY = "exec_slack_lead_map_apply";
const RPC_COUNTS_PUT = "exec_slack_lead_counts_put";
const RPC_SUMMARY = "exec_slack_lead_summary";
const RPC_COVERAGE = "exec_slack_lead_coverage";
const RPC_PURGE_PRINCIPAL = "exec_slack_lead_purge_principal";
const RPC_PURGE_EXPIRED = "exec_slack_lead_purge_expired";

/** Missing table (42P01, PGRST205), function (42883, PGRST202) or column (42703, PGRST204): the migration isn't applied. */
const SCHEMA_MISSING_CODES: ReadonlySet<string> = new Set(["42P01", "PGRST205", "42883", "PGRST202", "42703", "PGRST204"]);
const PG_CODE = /^[A-Z0-9]{2,10}$/;
const LEAD_CHANNEL = /^[CG][A-Z0-9]{2,30}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ERROR_CODE = /^[a-z0-9_]{1,60}$/;
const INSTALLATION = /^[A-Za-z0-9_-]{1,100}$/;
const LEAD_KINDS: readonly LeadKind[] = ["vob", "nonvob", "calendly", "zap_errors", "other"];
const LEAD_LINKS: readonly LeadLink[] = ["fb_id", "fb_name", "fb_sibling", "ambiguous", "none"];
const LINKED: readonly LeadLink[] = ["fb_id", "fb_name", "fb_sibling"];
const CONV_TYPES: readonly ConvType[] = ["channel", "group", "im", "mpim"];

const SCHEMA_TTL_TRUE_MS = 60_000;
const SCHEMA_TTL_FALSE_MS = 10_000;
/** exec_slack_lead_map_apply's own limit: a complete map is one call (§3.4.4). */
const MAP_MAX_ROWS = 500;
/** exec_slack_lead_counts_put's limit (the 8-day window plus the margin the RPC allows). */
const DAYS_MAX = 10;
/** exec_slack_lead_purge_expired deletes at most this many count rows a call; the store calls again while it hits it. */
const PURGE_BATCH = 5000;
const PURGE_ROUNDS = 10;
const STATES_MAX = 1000;
const PRINCIPAL_SCAN = 5000;
const DAY_MS = 86_400_000;

type ReadOpts = { signal?: AbortSignal };
type DbError = { code?: string | null; message?: string | null };
type Row = Record<string, unknown>;
type Result = { data: unknown; error: DbError | null; count?: number | null };

export class SlackLeadsStoreError extends Error {
  readonly op: string;
  readonly pgCode: string | null;
  constructor(op: string, pgCode: string | null) {
    super(`exec slack leads store: ${op} failed${pgCode ? ` (${pgCode})` : ""}`);
    this.name = "SlackLeadsStoreError";
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

/** 42P01, PGRST205, 42883, PGRST202, 42703, PGRST204: the P10 migration isn't applied. A PostgREST error or a store error. */
export function isLeadSchemaMissing(err: unknown): boolean {
  if (err instanceof SlackLeadsStoreError) return err.pgCode !== null && SCHEMA_MISSING_CODES.has(err.pgCode);
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && SCHEMA_MISSING_CODES.has(code);
}

/** The error for a failed request: the abort reason when the signal fired, else SlackLeadsStoreError(op, code). */
function failure(op: string, error: DbError | null | undefined, signal?: AbortSignal): SlackLeadsStoreError {
  signal?.throwIfAborted();
  return new SlackLeadsStoreError(op, pgCodeOf(error));
}

function notInstalled(error: DbError | null | undefined, signal?: AbortSignal): SlackLeadsStoreError {
  signal?.throwIfAborted();
  return new SlackLeadsStoreError("not_installed", pgCodeOf(error));
}

const malformed = (op: string) => new SlackLeadsStoreError(`${op}: malformed answer`, null);
const bad = (fn: string, what: string) => new TypeError(`exec slack leads store: ${fn}: ${what}`);

function requirePrincipal(fn: string, principal: ExecPrincipal): string {
  if (!principal || typeof principal.id !== "string" || principal.id.length === 0 || principal.id.length > 100) {
    throw bad(fn, "an ExecPrincipal is required");
  }
  return principal.id;
}

function requirePrincipalId(fn: string, principalId: string): string {
  if (typeof principalId !== "string" || principalId.length === 0 || principalId.length > 100) throw bad(fn, "a principal id is required");
  return principalId;
}

function withSignal<T extends { abortSignal(signal: AbortSignal): T }>(q: T, signal: AbortSignal | undefined): T {
  return signal ? q.abortSignal(signal) : q;
}

async function rpc(fn: string, args: Row, signal?: AbortSignal): Promise<Result> {
  return (await withSignal(db().rpc(fn, args), signal)) as Result;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => {
  const n = typeof v === "string" && /^-?[0-9]+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) ? n : null;
};
const iso = (v: unknown): string | null => {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const ymd = (v: unknown): string | null => (typeof v === "string" && LOCAL_DATE.test(v.slice(0, 10)) ? v.slice(0, 10) : null);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null);
/** Character count as Postgres's char_length counts it (code points). */
const chars = (s: string) => Array.from(s).length;
const clip = (s: string, max: number) => (chars(s) <= max ? s : Array.from(s).slice(0, max).join(""));

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
function validLeadChannel(fn: string, v: unknown): string {
  if (typeof v !== "string" || !LEAD_CHANNEL.test(v)) throw bad(fn, "a lead channel id (C… or G…) is required");
  return v;
}
function validInstallation(fn: string, v: unknown): string {
  if (typeof v !== "string" || !INSTALLATION.test(v)) throw bad(fn, "an installation id is required");
  return v;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

let schemaCache: { value: boolean; at: number } | null = null;

/** Cached 60 s (10 s while missing); 42P01 / PGRST205 (and the other missing codes) → false; any other error throws. */
export async function leadSchemaReady(opts?: { signal?: AbortSignal }): Promise<boolean> {
  const now = Date.now();
  if (schemaCache && now - schemaCache.at >= 0 && now - schemaCache.at < (schemaCache.value ? SCHEMA_TTL_TRUE_MS : SCHEMA_TTL_FALSE_MS)) {
    return schemaCache.value;
  }
  const signal = opts?.signal;
  const { error } = (await withSignal(db().from(CHANNELS).select("channel_id").limit(0), signal)) as Result;
  if (error && !missing(error)) throw failure("leadSchemaReady", error, signal);
  if (error) signal?.throwIfAborted();
  schemaCache = { value: !error, at: Date.now() };
  return schemaCache.value;
}

// ---------------------------------------------------------------------------
// The map (C18-C20, C24)
// ---------------------------------------------------------------------------

/** RPC 1: this installation's lead markers (deny fb_list / lead_name, channel or group) and the readable rows the typed list names
 *  (by id or by channelSlug form). Malformed ids and slugs are dropped before the call. Missing schema → []. */
export async function listLeadMarkers(principal: ExecPrincipal, installationId: string, listedIds: readonly string[],
  listedSlugs: readonly string[], opts?: { signal?: AbortSignal }): Promise<LeadMarkerRow[]> {
  const fn = "listLeadMarkers";
  const pid = requirePrincipal(fn, principal);
  const inst = validInstallation(fn, installationId);
  if (!Array.isArray(listedIds) || !Array.isArray(listedSlugs)) throw bad(fn, "listedIds and listedSlugs must be arrays");
  const ids = [...new Set(listedIds.filter((v): v is string => typeof v === "string" && LEAD_CHANNEL.test(v)))];
  const slugs = [...new Set(listedSlugs.filter((v): v is string => typeof v === "string" && SLUG.test(v)))];
  const signal = opts?.signal;
  const { data, error } = await rpc(RPC_MARKERS, { p_principal: pid, p_installation: inst, p_listed_ids: ids, p_listed_slugs: slugs }, signal);
  if (error) {
    if (missing(error)) {
      signal?.throwIfAborted();
      return [];
    }
    throw failure(fn, error, signal);
  }
  const out: LeadMarkerRow[] = [];
  for (const r of Array.isArray(data) ? (data as Row[]) : []) {
    const channelId = str(r.channel_id);
    const convType = oneOf(r.conv_type, CONV_TYPES);
    const cls = str(r.class);
    if (channelId === null || convType === null || cls === null || typeof r.listed !== "boolean") throw malformed(fn);
    out.push({ channelId, convType, class: cls, denyReason: str(r.deny_reason), listed: r.listed });
  }
  return out;
}

/** The p_rows element of RPC 2: the identical key set on every row. */
function mapRowOf(fn: string, r: LeadMapRow): Row {
  if (!r || typeof r !== "object") throw bad(fn, "rows must be LeadMapRow objects");
  const channelId = validLeadChannel(fn, r.channelId);
  const kind = oneOf(r.kind, LEAD_KINDS);
  const link = oneOf(r.link, LEAD_LINKS);
  if (kind === null) throw bad(fn, "a row's kind is not a lead kind");
  if (link === null) throw bad(fn, "a row's link is not a lead link");
  const text = (v: unknown, what: string): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "string" || v.trim().length === 0) throw bad(fn, `a row's ${what} must be a non-empty string or null`);
    return v;
  };
  // Ids are never clipped (a clipped id would name another row); only the display label is (the table's 120).
  const taskId = text(r.taskId, "taskId");
  const clientId = text(r.clientId, "clientId");
  const label = text(r.clientLabel, "clientLabel");
  const clientLabel = label === null ? null : clip(label, P10_LIMITS.leadLabelChars);
  if (taskId !== null && chars(taskId) > 64) throw bad(fn, "a row's taskId is longer than 64");
  if (clientId !== null && chars(clientId) > 64) throw bad(fn, "a row's clientId is longer than 64");
  // The table's pair CHECKs, checked before the call: a linked row names its onboarding and label; a client implies a task.
  if ((LINKED as readonly string[]).includes(link) !== (taskId !== null && clientLabel !== null)) {
    throw bad(fn, "a linked row needs its taskId and clientLabel, and only a linked row has them");
  }
  if (clientId !== null && taskId === null) throw bad(fn, "a row with a clientId needs its taskId");
  return { channel_id: channelId, kind, link, task_id: taskId, client_id: clientId, client_label: clientLabel };
}

/**
 * RPC 2, one call (exec_slack_lead_map_apply deletes the rows not in ITS p_rows when complete, so a complete map is never
 * split): ≤ 500 rows; above that the first 500 go with complete = false, and lead_map_too_large is logged by principal id
 * (nothing is deleted that run). Duplicate channel ids keep their first row. Missing schema → SlackLeadsStoreError("not_installed").
 */
export async function applyLeadMap(principal: ExecPrincipal, installationId: string, rows: readonly LeadMapRow[], complete: boolean,
  mappedAt: Date, expiresAt: Date): Promise<{ upserted: number; refused: number; deleted: number }> {
  const fn = "applyLeadMap";
  const pid = requirePrincipal(fn, principal);
  const inst = validInstallation(fn, installationId);
  if (!Array.isArray(rows)) throw bad(fn, "rows must be an array");
  if (typeof complete !== "boolean") throw bad(fn, "complete must be a boolean");
  const mapped = validDate(fn, mappedAt, "mappedAt");
  const expires = validDate(fn, expiresAt, "expiresAt");
  if (expires.getTime() <= mapped.getTime()) throw bad(fn, "expiresAt must be after mappedAt");
  if (expires.getTime() > mapped.getTime() + 401 * DAY_MS) throw bad(fn, "expiresAt must be within 401 days of mappedAt");
  const seen = new Set<string>();
  const payload: Row[] = [];
  for (const r of rows) {
    const row = mapRowOf(fn, r);
    if (seen.has(row.channel_id as string)) continue;
    seen.add(row.channel_id as string);
    payload.push(row);
  }
  let completeArg = complete;
  if (payload.length > MAP_MAX_ROWS) {
    payload.length = MAP_MAX_ROWS;
    completeArg = false;
    console.warn(`[exec-slack-leads] lead_map_too_large principal=${pid}`);
  }
  const { data, error } = await rpc(RPC_MAP_APPLY, {
    p_principal: pid, p_installation: inst, p_rows: payload, p_complete: completeArg, p_mapped_at: mapped.toISOString(), p_expires_at: expires.toISOString()
  });
  if (error) {
    if (missing(error)) throw notInstalled(error);
    throw failure(fn, error);
  }
  const r = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Row) : null;
  const upserted = int(r?.upserted);
  const refused = int(r?.refused);
  const deleted = int(r?.deleted);
  if (upserted === null || refused === null || deleted === null || upserted < 0 || refused < 0 || deleted < 0) throw malformed(fn);
  return { upserted, refused, deleted };
}

const STATE_COLS = "channel_id,kind,link,counted_from,final_through,counted_at,last_error_code,final_attempt_at,task_id,client_id,client_label";

/** His lead channel rows, counted_at nulls first (then oldest), ≤ 1,000. v1.1: also final_attempt_at, task_id, client_id and
 *  client_label. Missing schema → []. */
export async function listLeadChannelStates(principal: ExecPrincipal, opts?: { signal?: AbortSignal }): Promise<LeadChannelState[]> {
  const fn = "listLeadChannelStates";
  const pid = requirePrincipal(fn, principal);
  const signal = opts?.signal;
  const { data, error } = (await withSignal(db().from(CHANNELS).select(STATE_COLS).eq("principal_id", pid)
    .order("counted_at", { ascending: true, nullsFirst: true }).order("channel_id", { ascending: true }).limit(STATES_MAX), signal)) as Result;
  if (error) {
    if (missing(error)) {
      signal?.throwIfAborted();
      return [];
    }
    throw failure(fn, error, signal);
  }
  const out: LeadChannelState[] = [];
  for (const r of Array.isArray(data) ? (data as Row[]) : []) {
    const channelId = str(r.channel_id);
    const kind = oneOf(r.kind, LEAD_KINDS);
    const link = oneOf(r.link, LEAD_LINKS);
    if (channelId === null || kind === null || link === null) throw malformed(fn);
    out.push({
      channelId, kind, link, countedFrom: ymd(r.counted_from), finalThrough: ymd(r.final_through), countedAt: iso(r.counted_at),
      lastErrorCode: str(r.last_error_code), finalAttemptAt: iso(r.final_attempt_at), taskId: str(r.task_id), clientId: str(r.client_id),
      clientLabel: str(r.client_label)
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Counts (C13-C15, C22)
// ---------------------------------------------------------------------------

/**
 * RPC 3: replaces each day given (a lower bound never lowers a stored row), only while the parent is a lead marker.
 * "refused" = the channel is no longer a lead marker; "no_row" = no lead row (the map hasn't run for it). v1.1: finalAttempt
 * stamps final_attempt_at. Missing schema → SlackLeadsStoreError("not_installed").
 */
export async function putLeadCounts(principal: ExecPrincipal, channelId: string, input: { tz: string; today: string;
  days: readonly (LeadDayCount & { expiresAt: string })[]; countedAt: Date; finalThrough: string | null;
  finalAttempt: boolean }): Promise<"written" | "refused" | "no_row"> {
  const fn = "putLeadCounts";
  const pid = requirePrincipal(fn, principal);
  const channel = validLeadChannel(fn, channelId);
  if (!input || typeof input !== "object") throw bad(fn, "input is required");
  if (typeof input.tz !== "string" || chars(input.tz) < 1 || chars(input.tz) > 64) throw bad(fn, "tz must be 1..64 characters");
  const today = validYmd(fn, input.today, "today");
  const countedAt = validDate(fn, input.countedAt, "countedAt");
  const finalThrough = input.finalThrough === null ? null : validYmd(fn, input.finalThrough, "finalThrough");
  if (typeof input.finalAttempt !== "boolean") throw bad(fn, "finalAttempt must be a boolean");
  if (!Array.isArray(input.days) || input.days.length > DAYS_MAX) throw bad(fn, `days must be an array of at most ${DAYS_MAX}`);
  const days = input.days.map((d) => {
    if (!d || typeof d !== "object") throw bad(fn, "a day must be an object");
    const day = validYmd(fn, d.day, "a day's date");
    const whole = (v: unknown, what: string) => {
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 100_000) throw bad(fn, `a day's ${what} must be an integer 0..100000`);
      return v;
    };
    if (typeof d.complete !== "boolean") throw bad(fn, "a day's complete must be a boolean");
    const expiresAt = validIso(fn, d.expiresAt, "a day's expiresAt");
    if (Date.parse(expiresAt) <= countedAt.getTime()) throw bad(fn, "a day's expiresAt must be after countedAt");
    return { d: day, n: whole(d.n, "n"), skipped: whole(d.skipped, "skipped"), complete: d.complete, expires_at: expiresAt };
  });
  const { data, error } = await rpc(RPC_COUNTS_PUT, {
    p_principal: pid, p_channel: channel, p_tz: input.tz, p_today: today, p_days: days, p_counted_at: countedAt.toISOString(),
    p_final_through: finalThrough, p_final_attempt: input.finalAttempt
  });
  if (error) {
    if (missing(error)) throw notInstalled(error);
    throw failure(fn, error);
  }
  const r = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Row) : null;
  const outcome = oneOf(r?.outcome, ["written", "refused", "no_row"] as const);
  if (outcome === null) throw malformed(fn);
  return outcome;
}

/** v1.1 correctness-2: finalAttempt also stamps final_attempt_at, so a failing final pass is retried at most every 6 hours.
 *  Never throws; logs the op, the principal id and the database code only (never the channel id, C21). */
export async function noteLeadChannelError(principal: ExecPrincipal, channelId: string, code: string, finalAttempt: boolean): Promise<void> {
  const fn = "noteLeadChannelError";
  try {
    const pid = requirePrincipal(fn, principal);
    const channel = validLeadChannel(fn, channelId);
    const errorCode = typeof code === "string" && ERROR_CODE.test(code) ? code : "unknown";
    const now = new Date().toISOString();
    const patch: Row = { last_error_code: errorCode, updated_at: now, ...(finalAttempt === true ? { final_attempt_at: now } : {}) };
    const { error } = (await db().from(CHANNELS).update(patch).eq("principal_id", pid).eq("channel_id", channel)) as Result;
    if (error && !missing(error)) console.error(`[exec-slack-leads] ${fn} failed principal=${pid} (${pgCodeOf(error) ?? "no_code"})`);
  } catch {
    // A bad argument or a thrown request: the op only (never the error's message, which could name a value).
    console.error(`[exec-slack-leads] ${fn} failed (unexpected)`);
  }
}

/** C22: not_in_channel / channel_not_found → his lead row for the channel goes (its counts cascade). Missing schema → nothing to do. */
export async function dropLeadChannel(principal: ExecPrincipal, channelId: string): Promise<void> {
  const fn = "dropLeadChannel";
  const pid = requirePrincipal(fn, principal);
  const channel = validLeadChannel(fn, channelId);
  const { error } = (await db().from(CHANNELS).delete().eq("principal_id", pid).eq("channel_id", channel)) as Result;
  if (error && !missing(error)) throw failure(fn, error);
}

// ---------------------------------------------------------------------------
// Reads for the surfaces (§3.4.6)
// ---------------------------------------------------------------------------

/** RPC 4: sums per client group × kind × local day over [from, to] (≤ 31 days apart). Missing schema → []. */
export async function leadSummary(principal: ExecPrincipal, from: string, to: string, opts?: { signal?: AbortSignal }): Promise<LeadSummaryRow[]> {
  const fn = "leadSummary";
  const pid = requirePrincipal(fn, principal);
  const f = validYmd(fn, from, "from");
  const t = validYmd(fn, to, "to");
  const signal = opts?.signal;
  const { data, error } = await rpc(RPC_SUMMARY, { p_principal: pid, p_from: f, p_to: t }, signal);
  if (error) {
    if (missing(error)) {
      signal?.throwIfAborted();
      return [];
    }
    throw failure(fn, error, signal);
  }
  const out: LeadSummaryRow[] = [];
  for (const r of Array.isArray(data) ? (data as Row[]) : []) {
    const groupKey = str(r.group_key);
    const kind = oneOf(r.kind, LEAD_KINDS);
    const day = ymd(r.local_day);
    const n = int(r.n);
    const channels = int(r.channels);
    if (groupKey === null || kind === null || day === null || n === null || n < 0 || channels === null || channels < 0 || typeof r.complete !== "boolean") {
      throw malformed(fn);
    }
    out.push({
      groupKey, clientId: str(r.client_id), taskId: str(r.task_id), clientLabel: str(r.client_label), kind, day, n, channels, complete: r.complete,
      oldestCountedAt: iso(r.oldest_counted_at)
    });
  }
  return out;
}

/** RPC 5: coverage counts. Missing schema → null. */
export async function leadCoverage(principal: ExecPrincipal, today: string, opts?: { signal?: AbortSignal }): Promise<LeadCoverage | null> {
  const fn = "leadCoverage";
  const pid = requirePrincipal(fn, principal);
  const day = validYmd(fn, today, "today");
  const signal = opts?.signal;
  const { data, error } = await rpc(RPC_COVERAGE, { p_principal: pid, p_today: day }, signal);
  if (error) {
    if (missing(error)) {
      signal?.throwIfAborted();
      return null;
    }
    throw failure(fn, error, signal);
  }
  const r = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Row) : null;
  if (r === null) throw malformed(fn);
  const n = (k: string) => {
    const v = int(r[k]);
    if (v === null || v < 0) throw malformed(fn);
    return v;
  };
  return {
    channels: n("channels"), linked: n("linked"), unlinked: n("unlinked"), ambiguous: n("ambiguous"), otherKind: n("other_kind"),
    withError: n("with_error"), neverCounted: n("never_counted"), oldestCountedAt: iso(r.oldest_counted_at), skippedToday: n("skipped_today")
  };
}

// ---------------------------------------------------------------------------
// Purges (C23, C44, §3.11)
// ---------------------------------------------------------------------------

async function purgePrincipalById(fn: string, pid: string): Promise<{ counts: number; channels: number } | null> {
  const { data, error } = await rpc(RPC_PURGE_PRINCIPAL, { p_principal: pid });
  if (error) {
    if (missing(error)) return null;
    throw failure(fn, error);
  }
  const r = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Row) : null;
  const counts = int(r?.counts);
  const channels = int(r?.channels);
  if (counts === null || channels === null || counts < 0 || channels < 0) throw malformed(fn);
  return { counts, channels };
}

/** RPC 6 (C23): every lead row of the principal (switch-off, reading gone). null: schema missing. */
export async function purgeLeadCounts(principal: ExecPrincipal): Promise<{ counts: number; channels: number } | null> {
  return purgePrincipalById("purgeLeadCounts", requirePrincipal("purgeLeadCounts", principal));
}

/** §3.11: the by-id twin of purgeLeadCounts (the system purge, principal-agnostic). null: schema missing. */
export async function purgeLeadCountsSystem(principalId: string): Promise<{ counts: number; channels: number } | null> {
  return purgePrincipalById("purgeLeadCountsSystem", requirePrincipalId("purgeLeadCountsSystem", principalId));
}

/** RPC 7 (C44): count rows and channel rows past their expires_at, principal-agnostic; called again (≤ 10 rounds) while a call
 *  hits the RPC's 5,000-row batch. Missing schema → zeros. */
export async function purgeExpiredLeadCounts(now: Date, opts?: { signal?: AbortSignal }): Promise<{ counts: number; channels: number }> {
  const fn = "purgeExpiredLeadCounts";
  const at = validDate(fn, now, "now");
  const signal = opts?.signal;
  const total = { counts: 0, channels: 0 };
  for (let round = 0; round < PURGE_ROUNDS; round += 1) {
    signal?.throwIfAborted();
    const { data, error } = await rpc(RPC_PURGE_EXPIRED, { p_now: at.toISOString() }, signal);
    if (error) {
      if (missing(error)) {
        signal?.throwIfAborted();
        return total;
      }
      throw failure(fn, error, signal);
    }
    const r = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Row) : null;
    const counts = int(r?.counts);
    const channels = int(r?.channels);
    if (counts === null || channels === null || counts < 0 || channels < 0) throw malformed(fn);
    total.counts += counts;
    total.channels += channels;
    if (counts < PURGE_BATCH) break;
  }
  return total;
}

/** The principals that have lead channel rows (the system purge's first source of principals to re-check), distinct, ≤ limit
 *  (clamped 1..1000). Missing schema → []. */
export async function listPrincipalsWithLeadRows(limit: number, opts?: { signal?: AbortSignal }): Promise<string[]> {
  const fn = "listPrincipalsWithLeadRows";
  const n = typeof limit === "number" && Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 1000) : 100;
  const signal = opts?.signal;
  const { data, error } = (await withSignal(db().from(CHANNELS).select("principal_id").order("principal_id", { ascending: true })
    .limit(PRINCIPAL_SCAN), signal)) as Result;
  if (error) {
    if (missing(error)) {
      signal?.throwIfAborted();
      return [];
    }
    throw failure(fn, error, signal);
  }
  const out: string[] = [];
  for (const r of Array.isArray(data) ? (data as Row[]) : []) {
    const p = str(r.principal_id);
    if (p && !out.includes(p)) out.push(p);
    if (out.length >= n) break;
  }
  return out;
}

/** Test seam: forget the per-process schema cache. */
export function __resetLeadStoreForTests(): void {
  schemaCache = null;
}
