import "server-only";

import type { MatchConfidence } from "@/lib/exec/email-types";
import type {
  DigestLine,
  DigestStatus,
  SlackChannelLink,
  SlackDigestPayload,
  SlackDigestRow,
  SlackIntelState,
  SlackItemKind,
  SlackMessageLink,
  SlackPrivacy
} from "@/lib/exec/slack-intel-types";
import { SLACK_INTEL_LIMITS, SLACK_ITEM_KINDS, compareTs, msToTs } from "@/lib/exec/slack-intel-types";
import { getSlackReadingState, latestAuthorOptoutAt } from "@/lib/exec/slack-reading";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P7b Slack intelligence store (P7b contract §3.2; Area A; server-only): the only module that names the P7b tables
// exec_slack_channel_links, exec_slack_message_links, exec_slack_digests, the P7b columns of exec_messages and the
// fourteen P7b RPCs (boundary rule B-P7b-1). P7a's tables are read only through P7a's facade (§0.3 rule 15): this file
// calls getSlackReadingState and nothing else of P7a's, and never selects an excerpt (B-P7b-3, ST10).
//
//   * Errors are SlackIntelStoreError(op, pgCode): the function's name and the database's own code, never a value this
//     module was handed or read (no ids, ts values, names, queries or text in a message, §0.3 rule 4). An aborted
//     signal wins: its reason is thrown instead.
//   * A missing table / function / column (isSlackIntelSchemaMissing: the P7b migration isn't applied) maps to the
//     signature's "not installed" value: [], an empty map, 0, false. A call whose answer can't say "not installed" (a
//     claim, a finish, a tag write) throws SlackIntelStoreError("not_installed", code) instead.
//   * Batch writes build every row with the identical key set (§0.3 rule 11); RPC payloads are built here, never
//     passed through.
//   * Slack ts values compare only through P7a's compareTs; timestamps come back as ISO strings.
//   * Nothing here logs.

const CHANNEL_LINKS = "exec_slack_channel_links";
const MESSAGE_LINKS = "exec_slack_message_links";
const DIGESTS = "exec_slack_digests";

const RPC_SET_CHANNEL_LINKS = "exec_slack_set_channel_links";
const RPC_SET_CHANNEL_RULES = "exec_slack_set_channel_rules";
const RPC_UNLINKED_MESSAGES = "exec_slack_unlinked_messages";
const RPC_PROJECT_ITEMS = "exec_slack_project_items";
const RPC_SEARCH = "exec_slack_search";
const RPC_DIGEST_CLAIM = "exec_slack_digest_claim";
const RPC_DIGEST_FINISH = "exec_slack_digest_finish";
const RPC_DIGEST_BLANK = "exec_slack_digest_blank";
const RPC_FINISH_TURN_V2 = "exec_chat_finish_turn_v2";
const RPC_REDACT_SLACK = "exec_chat_redact_slack";
const RPC_SLACK_RECHECK = "exec_chat_slack_recheck";
const RPC_ORPHAN_CHANNELS = "exec_chat_slack_orphan_channels";
const RPC_PUBLIC_FACTS = "exec_slack_public_facts";
const RPC_FORGET_CHANNELS = "exec_slack_intel_forget_channels";

const LINK_COLS =
  "channel_id,tag_client_id,tag_client_name,tag_project_ids,tagged_at,client_id,client_name,client_match_via,match_confidence,client_candidates";
const MESSAGE_LINK_COLS =
  "channel_id,ts,client_id,client_name,client_match_via,match_confidence,client_candidates,task_ids,project_ids,email_thread_ids,checked_at";
/** Every digest column the app reads (search_tsv is the index's, never read). */
const DIGEST_COLS =
  "id,channel_id,local_date,tz,from_ts,to_ts,status,summary,highlights,decisions,open_questions,source_ts,human_count,bot_count,dd_post_count," +
  "external_count,thread_count,privacy,partial,full_day,injection_suspected,rebuilds,model,cost_usd,requested_at,built_at,expires_at";
/** The identical key set of every exec_slack_message_links upsert row (P3 §0; ST05). */
const MESSAGE_LINK_ROW_KEYS = [
  "principal_id", "channel_id", "ts", "client_id", "client_name", "client_match_via", "match_confidence", "client_candidates", "task_ids",
  "project_ids", "email_thread_ids", "checked_at"
] as const;
/** The identical key set of RPC 2's p_rows. */
const RULE_ROW_KEYS = ["channel_id", "client_id", "client_name", "candidates"] as const;

/** Missing table (42P01, PGRST205), function (42883, PGRST202) or column (42703, PGRST204): the P7b migration isn't applied. */
const SCHEMA_MISSING_CODES: ReadonlySet<string> = new Set(["42P01", "PGRST205", "42883", "PGRST202", "42703", "PGRST204"]);
const FUNCTION_MISSING_CODES: ReadonlySet<string> = new Set(["42883", "PGRST202"]);
const PG_CODE = /^[A-Z0-9]{2,10}$/;
const TS = /^[0-9]{1,12}\.[0-9]{1,8}$/;
const CHANNEL = /^[CGD][A-Z0-9]{2,30}$/;
const DIGEST_ID = /^esd_[0-9a-f]{32}$/;
const ITEM_ID = /^esl_[0-9a-f]{32}$/;
const MESSAGE_ID = /^ecm_[0-9a-f]{32}$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REF_KEY = /^(m:[CGD][A-Z0-9]{2,30}:[0-9]{1,12}\.[0-9]{1,8}|d:[CGD][A-Z0-9]{2,30}:\d{4}-\d{2}-\d{2}:[0-9]{1,4})$/;

const IN_CHUNK = 100;
const PAGE = 1000;
const MAX_PAGES = 2;   // 2 000 channel links at most (the picker's ceiling)
const PURGE_CHUNK = 1000;
const PURGE_MAX_ROUNDS = 50;
const STALE_BUILD_MS = 30 * 60_000;
const SCHEMA_TTL_TRUE_MS = 60_000;
const SCHEMA_TTL_FALSE_MS = 10_000;
const V2_REPROBE_MS = 10 * 60_000;
const RULES_CHUNK = SLACK_INTEL_LIMITS.rulesBatch;           // 2 000 (RPC 2's guard)
const LINK_CHUNK = SLACK_INTEL_LIMITS.linkUpsertChunk;       // 500
const FORGET_CHUNK = SLACK_INTEL_LIMITS.forgetChunk;         // 500 (RPC 14's guard)
const REDACT_CHUNK = SLACK_INTEL_LIMITS.redactChunk;         // 500 keys + channels per RPC 10 call
const REDACT_HIT_CAP = 2000;                                 // RPC 10's per-call answer limit (`limit 2000`)
const REDACT_MAX_PASSES = 50;                                // ≤ 100 000 answers per chunk in one sweep (fixer security-2)
const BLANK_TS_CHUNK = 500;                                  // RPC 8's guard
const BLANK_DATES_CHUNK = 30;                                // RPC 8's guard
const CLIENT_KEYS_READ = 2000;
const DIGEST_STATUSES: readonly DigestStatus[] = ["building", "built", "empty", "stale", "failed", "skipped_cap"];
const FINISH_STATUSES = ["built", "empty", "failed", "skipped_cap"] as const;
const DIGEST_PRIVACIES = ["public", "private", "group_dm", "external", "finance"] as const;
const CLAIM_MODES = ["plan", "today", "rebuild"] as const;
const MESSAGE_VIAS = ["dd_post", "dd_link", "domain"] as const;
const CONFIDENCES = ["high", "medium", "low"] as const;

type ReadOpts = { signal?: AbortSignal };
type DbError = { code?: string | null; message?: string | null };
type Row = Record<string, unknown>;
type Result = { data: unknown; error: DbError | null; count?: number | null };

export class SlackIntelStoreError extends Error {   // no content in the message
  readonly op: string;
  readonly pgCode: string | null;
  constructor(op: string, pgCode: string | null) {
    super(`exec slack intel store: ${op} failed${pgCode ? ` (${pgCode})` : ""}`);
    this.name = "SlackIntelStoreError";
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

/** 42P01, PGRST205 (table) or 42883, PGRST202 (function): the P7b migration isn't applied. A missing column (42703,
 *  PGRST204: an exec_messages / exec_drafts column of P7b's) counts too. Accepts a PostgREST error or a SlackIntelStoreError. */
export function isSlackIntelSchemaMissing(err: unknown): boolean {
  if (err instanceof SlackIntelStoreError) return err.pgCode !== null && SCHEMA_MISSING_CODES.has(err.pgCode);
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && SCHEMA_MISSING_CODES.has(code);
}

/** The error for a failed request: the abort reason when the signal fired, else SlackIntelStoreError(op, code). */
function failure(op: string, error: DbError | null | undefined, signal?: AbortSignal): SlackIntelStoreError {
  signal?.throwIfAborted();
  return new SlackIntelStoreError(op, pgCodeOf(error));
}

/** A missing schema where the signature can't say "not installed". */
function notInstalled(error: DbError | null | undefined, signal?: AbortSignal): SlackIntelStoreError {
  signal?.throwIfAborted();
  return new SlackIntelStoreError("not_installed", pgCodeOf(error));
}

const malformed = (op: string) => new SlackIntelStoreError(`${op}: malformed answer`, null);
const bad = (fn: string, what: string) => new TypeError(`exec slack intel store: ${fn}: ${what}`);

function requirePrincipal(principal: ExecPrincipal): string {
  if (!principal || typeof principal.id !== "string" || principal.id.length === 0) {
    throw new TypeError("exec slack intel store: an ExecPrincipal is required");
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
const bool = (v: unknown): boolean => v === true;
const int = (v: unknown): number => {
  const n = typeof v === "string" && /^-?[0-9]+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
};
const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const clampInt = (n: unknown, lo: number, hi: number, fallback: number): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : fallback;
/** A timestamp as an ISO string, or null when absent / unparseable. */
const iso = (v: unknown): string | null => {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const isTime = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const isChannel = (v: unknown): v is string => typeof v === "string" && CHANNEL.test(v);
const isTs = (v: unknown): v is string => typeof v === "string" && TS.test(v);

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Distinct values of `list` that pass `ok`, in first-seen order. */
function distinct<T>(list: readonly T[] | null | undefined, ok: (v: T) => boolean): T[] {
  const out: T[] = [];
  const seen = new Set<T>();
  for (const v of Array.isArray(list) ? list : []) {
    if (!ok(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function rowsOf(result: Result): Row[] {
  return Array.isArray(result.data) ? (result.data as Row[]) : [];
}

/** Every row carries exactly `keys` (identical key sets, §0.3 rule 11). */
function requireKeys(fn: string, rows: readonly Row[], keys: readonly string[]): void {
  const want = [...keys].sort().join(",");
  for (const r of rows) {
    if (Object.keys(r).sort().join(",") !== want) throw bad(fn, "every row must carry exactly the payload type's keys");
  }
}

/** Keyset-free paging by range for small principal-scoped reads (≤ pages × PAGE rows). Missing schema → null. */
async function pagedSelect(op: string, build: () => { range(from: number, to: number): PromiseLike<Result> }, pages: number, signal?: AbortSignal):
  Promise<Row[] | null> {
  const out: Row[] = [];
  for (let page = 0; page < pages; page += 1) {
    const result = await build().range(page * PAGE, page * PAGE + PAGE - 1);
    if (result.error) {
      if (missing(result.error)) {
        signal?.throwIfAborted();
        return null;
      }
      throw failure(op, result.error, signal);
    }
    const rows = rowsOf(result);
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  return out;
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

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toChannelLink(r: Row, op: string): SlackChannelLink {
  const channelId = str(r.channel_id);
  if (!channelId) throw new SlackIntelStoreError(`${op}: malformed row`, null);
  const via = oneOf(r.client_match_via, ["tag", "name"] as const);
  const confidence = oneOf(r.match_confidence, ["high", "low"] as const);
  return {
    channelId,
    tagClientId: str(r.tag_client_id),
    tagClientName: str(r.tag_client_name),
    tagProjectIds: strings(r.tag_project_ids),
    taggedAt: iso(r.tagged_at),
    clientId: str(r.client_id),
    clientName: str(r.client_name),
    clientMatchVia: via,
    // A verdict the code doesn't know reads as no verdict (fail closed: never a high it can't explain).
    matchConfidence: via === null ? null : confidence,
    clientCandidates: int(r.client_candidates)
  };
}

function toMessageLink(r: Row, op: string): SlackMessageLink {
  const channelId = str(r.channel_id);
  const ts = str(r.ts);
  if (!channelId || !ts) throw new SlackIntelStoreError(`${op}: malformed row`, null);
  const via = oneOf(r.client_match_via, MESSAGE_VIAS);
  return {
    channelId,
    ts,
    clientId: str(r.client_id),
    clientName: str(r.client_name),
    clientMatchVia: via,
    matchConfidence: via === null ? null : oneOf(r.match_confidence, CONFIDENCES),
    clientCandidates: int(r.client_candidates),
    taskIds: strings(r.task_ids),
    projectIds: strings(r.project_ids),
    emailThreadIds: strings(r.email_thread_ids),
    checkedAt: iso(r.checked_at) ?? new Date(0).toISOString()
  };
}

function toLines(v: unknown): DigestLine[] {
  const out: DigestLine[] = [];
  for (const e of Array.isArray(v) ? v : []) {
    if (e === null || typeof e !== "object") continue;
    const msg = str((e as Row).msg);
    const text = str((e as Row).text);
    if (msg !== null && text !== null) out.push({ msg, text });
  }
  return out;
}

function toDigestRow(r: Row, op: string): SlackDigestRow {
  const id = str(r.id);
  const channelId = str(r.channel_id);
  const localDate = typeof r.local_date === "string" ? r.local_date.slice(0, 10) : null;
  const status = oneOf(r.status, DIGEST_STATUSES);
  const requestedAt = iso(r.requested_at);
  const expiresAt = iso(r.expires_at);
  const tz = str(r.tz);
  const fromTs = str(r.from_ts);
  const toTs = str(r.to_ts);
  if (!id || !channelId || !localDate || !LOCAL_DATE.test(localDate) || !status || !requestedAt || !expiresAt || !tz || !fromTs || !toTs) {
    throw new SlackIntelStoreError(`${op}: malformed row`, null);
  }
  const built = status === "built";
  return {
    id,
    channelId,
    localDate,
    tz,
    fromTs,
    toTs,
    status,
    // Only a built digest holds text (the table's whitelist); a row that says otherwise is read as holding none.
    summary: built ? str(r.summary) : null,
    highlights: built ? toLines(r.highlights) : [],
    decisions: built ? toLines(r.decisions) : [],
    openQuestions: built ? toLines(r.open_questions) : [],
    sourceTs: strings(r.source_ts),
    counts: { human: int(r.human_count), bot: int(r.bot_count), ddPost: int(r.dd_post_count), external: int(r.external_count), threads: int(r.thread_count) },
    privacy: oneOf(r.privacy, DIGEST_PRIVACIES),
    partial: bool(r.partial),
    fullDay: bool(r.full_day),
    injectionSuspected: bool(r.injection_suspected),
    rebuilds: int(r.rebuilds),
    model: str(r.model),
    costUsd: num(r.cost_usd),
    requestedAt,
    builtAt: iso(r.built_at),
    expiresAt
  };
}

// ---------------------------------------------------------------------------
// The state gate (C1)
// ---------------------------------------------------------------------------

type Cached = { value: boolean; at: number };
let schemaCache: Cached | null = null;
let v2Cache: Cached | null = null;

/** select id from exec_slack_digests limit 0; cached per process for 60 s (true) / 10 s (false). A missing table → false;
 *  any other failure throws (not cached). */
export async function slackIntelSchemaReady(opts?: ReadOpts): Promise<boolean> {
  const now = Date.now();
  if (schemaCache && now - schemaCache.at < (schemaCache.value ? SCHEMA_TTL_TRUE_MS : SCHEMA_TTL_FALSE_MS)) return schemaCache.value;
  const signal = opts?.signal;
  const { error } = (await withSignal(db().from(DIGESTS).select("id").limit(0), signal)) as Result;
  if (error && !missing(error)) throw failure("slackIntelSchemaReady", error, signal);
  if (error) signal?.throwIfAborted();
  schemaCache = { value: !error, at: Date.now() };
  return schemaCache.value;
}

/** C1: P7a's getSlackReadingState (facade) + settings.slackReadingSchemaReady + the P7b schema + settings.slackReadingEnabled,
 *  mapped exactly as C1 (first match wins). Never throws: a read error → "not_installed" (fail closed). */
export async function slackIntelState(principal: ExecPrincipal, settings: ExecSettings, opts?: ReadOpts): Promise<SlackIntelState> {
  try {
    requirePrincipal(principal);
    if (!settings || settings.slackReadingSchemaReady !== true) return "not_installed";
    if (!(await slackIntelSchemaReady(opts))) return "not_installed";
    const view = await getSlackReadingState(principal);
    const enabled = settings.slackReadingEnabled === true;
    switch (view?.state) {
      case "not_installed":
        return "not_installed";
      case "bot_not_connected":
        return "not_connected";
      case "not_consented":
      case "revoked":
      case "error":
        return "reading_revoked";
      case "paused":
        return "reading_off";
      case "discovering":
        return enabled ? "discovering" : "reading_off";
      case "on":
        return enabled ? "ok" : "reading_off";
      default:
        return "not_installed";
    }
  } catch {
    return "not_installed";
  }
}

// ---------------------------------------------------------------------------
// Channel links
// ---------------------------------------------------------------------------

/** Every link row of the principal (≤ 2 000), or only the given channel ids (malformed ids ignored). Missing schema → empty. */
export async function listChannelLinks(principal: ExecPrincipal, opts?: { channelIds?: readonly string[]; signal?: AbortSignal }): Promise<Map<string, SlackChannelLink>> {
  const pid = requirePrincipal(principal);
  const signal = opts?.signal;
  const out = new Map<string, SlackChannelLink>();
  if (opts?.channelIds !== undefined) {
    for (const chunk of chunks(distinct(opts.channelIds, isChannel), IN_CHUNK)) {
      const rows = await readRows("listChannelLinks", withSignal(db().from(CHANNEL_LINKS).select(LINK_COLS).eq("principal_id", pid).in("channel_id", chunk), signal), signal);
      if (rows === null) return new Map();
      for (const r of rows) {
        const link = toChannelLink(r, "listChannelLinks");
        out.set(link.channelId, link);
      }
    }
    return out;
  }
  const rows = await pagedSelect("listChannelLinks", () =>
    withSignal(db().from(CHANNEL_LINKS).select(LINK_COLS).eq("principal_id", pid).order("channel_id", { ascending: true }), signal), MAX_PAGES, signal);
  for (const r of rows ?? []) {
    const link = toChannelLink(r, "listChannelLinks");
    out.set(link.channelId, link);
  }
  return out;
}

/** Channels whose generated verdict names the client at one of the given confidences (high = a tag, low = the name rule),
 *  by channel id. Missing schema → []. */
export async function listChannelsLinkedToClient(principal: ExecPrincipal, clientId: string, confidences: readonly ("high" | "low")[], opts?: ReadOpts): Promise<SlackChannelLink[]> {
  const pid = requirePrincipal(principal);
  const levels = distinct(confidences, (c) => c === "high" || c === "low");
  if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 100 || levels.length === 0) return [];
  const signal = opts?.signal;
  const rows = await pagedSelect("listChannelsLinkedToClient", () =>
    withSignal(db().from(CHANNEL_LINKS).select(LINK_COLS).eq("principal_id", pid).eq("client_id", clientId).in("match_confidence", levels)
      .order("channel_id", { ascending: true }), signal), MAX_PAGES, signal);
  return (rows ?? []).map((r) => toChannelLink(r, "listChannelsLinkedToClient")).filter((l) => l.matchConfidence !== null && levels.includes(l.matchConfidence));
}

/** Channels he tagged to the project (tag_project_ids contains it), by channel id. Missing schema → []. */
export async function listChannelsTaggedToProject(principal: ExecPrincipal, projectId: string, opts?: ReadOpts): Promise<SlackChannelLink[]> {
  const pid = requirePrincipal(principal);
  if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 200) return [];
  const signal = opts?.signal;
  const rows = await pagedSelect("listChannelsTaggedToProject", () =>
    withSignal(db().from(CHANNEL_LINKS).select(LINK_COLS).eq("principal_id", pid).contains("tag_project_ids", [projectId])
      .order("channel_id", { ascending: true }), signal), MAX_PAGES, signal);
  return (rows ?? []).map((r) => toChannelLink(r, "listChannelsTaggedToProject")).filter((l) => l.tagProjectIds.includes(projectId));
}

/** RPC 1: replace the channel's tags (a client or none, ≤ 10 projects). A malformed channel id → "not_found" without a call.
 *  Missing schema → SlackIntelStoreError("not_installed"). */
export async function setChannelTags(principal: ExecPrincipal, input: { channelId: string; client: { id: string; name: string } | null; projectIds: readonly string[] }):
  Promise<"ok" | "not_found" | "not_taggable"> {
  const pid = requirePrincipal(principal);
  if (!input || !isChannel(input.channelId)) return "not_found";
  const client = input.client ?? null;
  if (client !== null && (typeof client.id !== "string" || client.id.length < 1 || client.id.length > 100
    || typeof client.name !== "string" || client.name.length < 1 || client.name.length > 200)) {
    throw bad("setChannelTags", "a client needs an id (1..100) and a name (1..200)");
  }
  const projects = distinct(input.projectIds, (p) => typeof p === "string" && p.length > 0 && p.length <= 200);
  if (!Array.isArray(input.projectIds) || projects.length > 10) throw bad("setChannelTags", "at most 10 project ids");
  const { data, error } = await rpc(RPC_SET_CHANNEL_LINKS, {
    p_principal: pid,
    p_channel_id: input.channelId,
    p_client_id: client === null ? null : client.id,
    p_client_name: client === null ? null : client.name,
    p_project_ids: projects
  });
  if (error) {
    if (missing(error)) throw notInstalled(error);
    throw failure("setChannelTags", error);
  }
  const outcome = oneOf(data, ["ok", "not_found", "not_taggable"] as const);
  if (outcome === null) throw malformed("setChannelTags");
  return outcome;
}

/** RPC 2, in chunks of 2 000 (rule_* columns only; a tag is never touched). Duplicate channel ids: the last row wins. Returns
 *  the rows written (unchanged rows aren't rewritten). Missing schema → 0. */
export async function setChannelRules(principal: ExecPrincipal, rows: readonly { channelId: string; clientId: string | null; clientName: string | null; candidates: number }[]): Promise<number> {
  const pid = requirePrincipal(principal);
  const byChannel = new Map<string, Row>();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !isChannel(r.channelId)) throw bad("setChannelRules", "malformed channel id");
    const candidates = r.candidates;
    if (!Number.isSafeInteger(candidates) || candidates < 0 || candidates > 1000) throw bad("setChannelRules", "candidates must be 0..1000");
    if ((r.clientId === null) !== (r.clientName === null)) throw bad("setChannelRules", "client id and name go together");
    byChannel.delete(r.channelId);
    byChannel.set(r.channelId, { channel_id: r.channelId, client_id: r.clientId ?? null, client_name: r.clientName ?? null, candidates });
  }
  const payload = [...byChannel.values()];
  requireKeys("setChannelRules", payload, RULE_ROW_KEYS);
  let n = 0;
  for (const chunk of chunks(payload, RULES_CHUNK)) {
    const { data, error } = await rpc(RPC_SET_CHANNEL_RULES, { p_principal: pid, p_rows: chunk });
    if (error) {
      if (missing(error)) return n;
      throw failure("setChannelRules", error);
    }
    n += int(data);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Message links
// ---------------------------------------------------------------------------

/** RPC 3: P7a message rows with no link row yet, oldest first, with their dd_paths and their items' AI summaries (never an
 *  excerpt). limit 1..2 000. Missing schema → []. */
export async function listUnlinkedMessages(principal: ExecPrincipal, limit: number, opts?: ReadOpts): Promise<{ channelId: string; ts: string; threadTs: string | null;
  role: "candidate" | "item" | "anchor"; isDdPost: boolean; ddPaths: string[]; summaries: string[] }[]> {
  const pid = requirePrincipal(principal);
  const signal = opts?.signal;
  const { data, error } = await rpc(RPC_UNLINKED_MESSAGES, { p_principal: pid, p_limit: clampInt(limit, 1, 2000, SLACK_INTEL_LIMITS.unlinkedBatch) }, signal);
  if (error) {
    if (missing(error)) {
      signal?.throwIfAborted();
      return [];
    }
    throw failure("listUnlinkedMessages", error, signal);
  }
  if (!Array.isArray(data)) throw malformed("listUnlinkedMessages");
  const out: { channelId: string; ts: string; threadTs: string | null; role: "candidate" | "item" | "anchor"; isDdPost: boolean; ddPaths: string[]; summaries: string[] }[] = [];
  for (const r of data as Row[]) {
    const role = oneOf(r.role, ["candidate", "item", "anchor"] as const);
    if (!isChannel(r.channel_id) || !isTs(r.ts) || role === null) throw new SlackIntelStoreError("listUnlinkedMessages: malformed row", null);
    out.push({
      channelId: r.channel_id,
      ts: r.ts,
      threadTs: isTs(r.thread_ts) ? r.thread_ts : null,
      role,
      isDdPost: bool(r.is_dd_post),
      ddPaths: strings(r.dd_paths),
      summaries: strings(r.summaries)
    });
  }
  return out;
}

const capList = (list: readonly string[] | null | undefined, max: number): string[] =>
  distinct(list ?? [], (v) => typeof v === "string" && v.length > 0 && v.length <= 200).slice(0, max);

/** PostgREST upsert on the PK with the identical key set of every column (P3 §0), chunks of 500. Arrays are deduped and capped
 *  at the table's limits (20 tasks, 20 projects, 5 email threads). Duplicate (channel, ts): the last link wins. Returns the rows
 *  written. Missing schema → 0. */
export async function upsertMessageLinks(principal: ExecPrincipal, links: readonly SlackMessageLink[]): Promise<number> {
  const pid = requirePrincipal(principal);
  const byKey = new Map<string, Row>();
  const nowIso = new Date().toISOString();
  for (const l of Array.isArray(links) ? links : []) {
    if (!l || !isChannel(l.channelId) || !isTs(l.ts)) throw bad("upsertMessageLinks", "malformed channel id or ts");
    const via = l.clientMatchVia ?? null;
    const confidence = l.matchConfidence ?? null;
    if (via !== null && !(MESSAGE_VIAS as readonly string[]).includes(via)) throw bad("upsertMessageLinks", "unknown via");
    if (confidence !== null && !(CONFIDENCES as readonly string[]).includes(confidence)) throw bad("upsertMessageLinks", "unknown confidence");
    const candidates = l.clientCandidates;
    if (!Number.isSafeInteger(candidates) || candidates < 0 || candidates > 1000) throw bad("upsertMessageLinks", "candidates must be 0..1000");
    const key = `${l.channelId}:${l.ts}`;
    byKey.delete(key);
    byKey.set(key, {
      principal_id: pid,
      channel_id: l.channelId,
      ts: l.ts,
      client_id: l.clientId ?? null,
      client_name: l.clientName ?? null,
      client_match_via: via,
      match_confidence: confidence,
      client_candidates: candidates,
      task_ids: capList(l.taskIds, 20),
      project_ids: capList(l.projectIds, 20),
      email_thread_ids: capList(l.emailThreadIds, 5),
      checked_at: isTime(l.checkedAt) ? new Date(Date.parse(l.checkedAt)).toISOString() : nowIso
    });
  }
  const rows = [...byKey.values()];
  requireKeys("upsertMessageLinks", rows, MESSAGE_LINK_ROW_KEYS);
  let n = 0;
  for (const chunk of chunks(rows, LINK_CHUNK)) {
    const { error } = (await db().from(MESSAGE_LINKS).upsert(chunk, { onConflict: "principal_id,channel_id,ts" })) as Result;
    if (error) {
      if (missing(error)) return n;
      throw failure("upsertMessageLinks", error);
    }
    n += chunk.length;
  }
  return n;
}

/** By (channel, ts) pairs: the message's own link and, for each pair with a threadTs (≠ ts), the root's link. Every valid key
 *  has an entry ("channel:ts"), null where no link row exists. Missing schema → every entry null. */
export async function getMessageLinks(principal: ExecPrincipal, keys: readonly { channelId: string; ts: string; threadTs: string | null }[], opts?: ReadOpts):
  Promise<Map<string /* channel:ts */, { own: SlackMessageLink | null; root: SlackMessageLink | null }>> {
  const pid = requirePrincipal(principal);
  const signal = opts?.signal;
  const valid = (Array.isArray(keys) ? keys : []).filter((k) => k && isChannel(k.channelId) && isTs(k.ts));
  const out = new Map<string, { own: SlackMessageLink | null; root: SlackMessageLink | null }>();
  const wanted = new Map<string, Set<string>>();
  const want = (channelId: string, ts: string) => {
    let set = wanted.get(channelId);
    if (!set) wanted.set(channelId, (set = new Set()));
    set.add(ts);
  };
  for (const k of valid) {
    out.set(`${k.channelId}:${k.ts}`, { own: null, root: null });
    want(k.channelId, k.ts);
    if (isTs(k.threadTs) && k.threadTs !== k.ts) want(k.channelId, k.threadTs);
  }
  if (wanted.size === 0) return out;
  const found = new Map<string, SlackMessageLink>();
  for (const chunk of chunks([...wanted.keys()], IN_CHUNK)) {
    const tsList = [...new Set(chunk.flatMap((c) => [...(wanted.get(c) ?? [])]))];
    for (const tsChunk of chunks(tsList, IN_CHUNK)) {
      const rows = await readRows("getMessageLinks", withSignal(db().from(MESSAGE_LINKS).select(MESSAGE_LINK_COLS).eq("principal_id", pid)
        .in("channel_id", chunk).in("ts", tsChunk), signal), signal);
      if (rows === null) return out;
      for (const r of rows) {
        const link = toMessageLink(r, "getMessageLinks");
        if (wanted.get(link.channelId)?.has(link.ts)) found.set(`${link.channelId}:${link.ts}`, link);
      }
    }
  }
  for (const k of valid) {
    const own = found.get(`${k.channelId}:${k.ts}`) ?? null;
    const root = isTs(k.threadTs) && k.threadTs !== k.ts ? found.get(`${k.channelId}:${k.threadTs}`) ?? null : null;
    out.set(`${k.channelId}:${k.ts}`, { own, root });
  }
  return out;
}

/** RPC 4 (the caller asks for 3 × the rows it shows, then re-screens). limit 1..150. Missing schema → []. */
export async function listProjectItemIds(principal: ExecPrincipal, q: { projectId: string; taskIds: readonly string[]; sinceIso: string; limit: number }, opts?: ReadOpts):
  Promise<{ itemId: string; via: "link" | "thread" | "tag"; at: string }[]> {
  const pid = requirePrincipal(principal);
  if (!q || typeof q.projectId !== "string" || q.projectId.length === 0 || !isTime(q.sinceIso)) return [];
  const signal = opts?.signal;
  const { data, error } = await rpc(RPC_PROJECT_ITEMS, {
    p_principal: pid,
    p_project_id: q.projectId,
    p_task_ids: capList(q.taskIds, 2000),
    p_since: new Date(Date.parse(q.sinceIso)).toISOString(),
    p_limit: clampInt(q.limit, 1, 150, 30)
  }, signal);
  if (error) {
    if (missing(error)) {
      signal?.throwIfAborted();
      return [];
    }
    throw failure("listProjectItemIds", error, signal);
  }
  if (!Array.isArray(data)) throw malformed("listProjectItemIds");
  return (data as Row[]).map((r) => {
    const itemId = str(r.item_id);
    const via = oneOf(r.via, ["link", "thread", "tag"] as const);
    const at = iso(r.at);
    if (!itemId || !ITEM_ID.test(itemId) || !via || !at) throw new SlackIntelStoreError("listProjectItemIds: malformed row", null);
    return { itemId, via, at };
  });
}

/** Item keys linked to a client (message links, high or medium), newest first by ts (compareTs), with ts at or after sinceIso.
 *  Reads at most 2 000 link rows (newest checked first). Missing schema → []. */
export async function listItemKeysLinkedToClient(principal: ExecPrincipal, clientId: string, q: { sinceIso: string; limit: number }, opts?: ReadOpts):
  Promise<{ channelId: string; ts: string; confidence: MatchConfidence }[]> {
  const pid = requirePrincipal(principal);
  if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 100 || !q || !isTime(q.sinceIso)) return [];
  const limit = clampInt(q.limit, 1, CLIENT_KEYS_READ, 50);
  const sinceTs = msToTs(Math.max(0, Date.parse(q.sinceIso)));
  const signal = opts?.signal;
  const rows = await readRows("listItemKeysLinkedToClient", withSignal(db().from(MESSAGE_LINKS).select("channel_id,ts,match_confidence").eq("principal_id", pid)
    .eq("client_id", clientId).in("match_confidence", ["high", "medium"]).order("checked_at", { ascending: false }).limit(CLIENT_KEYS_READ), signal), signal);
  const out: { channelId: string; ts: string; confidence: MatchConfidence }[] = [];
  for (const r of rows ?? []) {
    const confidence = oneOf(r.match_confidence, ["high", "medium"] as const);
    if (!isChannel(r.channel_id) || !isTs(r.ts) || confidence === null) continue;
    if (compareTs(r.ts, sinceTs) < 0) continue;
    out.push({ channelId: r.channel_id, ts: r.ts, confidence });
  }
  return out.sort((a, b) => compareTs(b.ts, a.ts) || (a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0)).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Search and public facts
// ---------------------------------------------------------------------------

/** RPC 5. channelIds / bypassChannelIds = storedSearchChannels(...) (both empty → [] without a call). The query is clipped to
 *  200 characters; kinds null = every kind (and digests); limit 1..50. Missing schema → []. */
export async function searchSlackStored(principal: ExecPrincipal, q: { query: string; channelIds: readonly string[]; bypassChannelIds: readonly string[];
  kinds: readonly SlackItemKind[] | null; sinceIso: string; includeDigests: boolean; limit: number }, opts?: ReadOpts):
  Promise<{ src: "item" | "digest"; id: string; channelId: string; rank: number; at: string }[]> {
  const pid = requirePrincipal(principal);
  if (!q || !isTime(q.sinceIso)) return [];
  const channels = distinct(q.channelIds, isChannel);
  const bypass = distinct(q.bypassChannelIds, isChannel).filter((c) => !channels.includes(c));
  if (channels.length === 0 && bypass.length === 0) return [];
  const kinds = q.kinds === null || q.kinds === undefined ? null : distinct(q.kinds, (k) => SLACK_ITEM_KINDS.includes(k));
  if (kinds !== null && kinds.length === 0) return [];
  const query = typeof q.query === "string" ? q.query.slice(0, SLACK_INTEL_LIMITS.searchQueryChars) : "";
  const signal = opts?.signal;
  const { data, error } = await rpc(RPC_SEARCH, {
    p_principal: pid,
    p_query: query,
    p_channel_ids: channels,
    p_bypass_channel_ids: bypass,
    p_kinds: kinds,
    p_since: new Date(Date.parse(q.sinceIso)).toISOString(),
    p_include_digests: q.includeDigests === true,
    p_limit: clampInt(q.limit, 1, 50, 10)
  }, signal);
  if (error) {
    if (missing(error)) {
      signal?.throwIfAborted();
      return [];
    }
    throw failure("searchSlackStored", error, signal);
  }
  if (!Array.isArray(data)) throw malformed("searchSlackStored");
  return (data as Row[]).map((r) => {
    const src = oneOf(r.src, ["item", "digest"] as const);
    const id = str(r.id);
    const at = iso(r.at);
    if (!src || !id || !(src === "item" ? ITEM_ID : DIGEST_ID).test(id) || !isChannel(r.channel_id) || !at) {
      throw new SlackIntelStoreError("searchSlackStored: malformed row", null);
    }
    return { src, id, channelId: r.channel_id, rank: num(r.rank) ?? 0, at };
  });
}

/** RPC 13: the public_slack slot's candidates for one client (limit 1..20). Missing schema → []. */
export async function listPublicSlackFactsForClient(principal: ExecPrincipal, clientId: string, q: { sinceIso: string; limit: number }, opts?: ReadOpts):
  Promise<{ src: "item" | "digest"; id: string; channelId: string; ts: string | null; localDate: string | null; kind: string; body: string; at: string }[]> {
  const pid = requirePrincipal(principal);
  if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 100 || !q || !isTime(q.sinceIso)) return [];
  const signal = opts?.signal;
  const { data, error } = await rpc(RPC_PUBLIC_FACTS, {
    p_principal: pid,
    p_client_id: clientId,
    p_since: new Date(Date.parse(q.sinceIso)).toISOString(),
    p_limit: clampInt(q.limit, 1, 20, SLACK_INTEL_LIMITS.publicSlackFacts)
  }, signal);
  if (error) {
    if (missing(error)) {
      signal?.throwIfAborted();
      return [];
    }
    throw failure("listPublicSlackFactsForClient", error, signal);
  }
  if (!Array.isArray(data)) throw malformed("listPublicSlackFactsForClient");
  const out: { src: "item" | "digest"; id: string; channelId: string; ts: string | null; localDate: string | null; kind: string; body: string; at: string }[] = [];
  for (const r of data as Row[]) {
    const src = oneOf(r.src, ["item", "digest"] as const);
    const id = str(r.id);
    const kind = str(r.kind);
    const body = str(r.body);
    const at = iso(r.at);
    if (!src || !id || !isChannel(r.channel_id) || !kind || body === null || !at) throw new SlackIntelStoreError("listPublicSlackFactsForClient: malformed row", null);
    const localDate = typeof r.local_date === "string" && LOCAL_DATE.test(r.local_date.slice(0, 10)) ? r.local_date.slice(0, 10) : null;
    out.push({ src, id, channelId: r.channel_id, ts: isTs(r.ts) ? r.ts : null, localDate, kind, body, at });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

/** Fixer security-3 (§0.3 rule 14, C33): a built digest requested at or before the newest per-author opt-out may summarize
 *  that author, and digests store no author, so until the sweep blanks it every reader sees it as removed (stale, no text;
 *  its generation unchanged, so the chat keys stay the sweep's to redact). A failed opt-out read throws (fail closed). The
 *  sweep's own reads pass raw (they need the rows as stored). RPCs 5 and 13 apply the same rule in SQL. */
async function guardOptedOut(principal: ExecPrincipal, rows: SlackDigestRow[], signal: AbortSignal | undefined): Promise<SlackDigestRow[]> {
  if (!rows.some((r) => r.status === "built")) return rows;
  const latest = await latestAuthorOptoutAt(principal, { signal });
  if (latest === null) return rows;
  const cut = Date.parse(latest);
  return rows.map((r) => (r.status === "built" && !(Date.parse(r.requestedAt) > cut)
    ? { ...r, status: "stale" as const, summary: null, highlights: [], decisions: [], openQuestions: [], sourceTs: [], fullDay: false }
    : r));
}

/** The digests of the given local dates ("YYYY-MM-DD"; malformed ones ignored), optionally of some channels and statuses,
 *  newest date first, then by channel. Missing schema → []. A built digest older than the newest opt-out reads as stale
 *  unless `raw` (fixer security-3; the statuses filter applies to the stored status). */
export async function getDigests(principal: ExecPrincipal, q: { channelIds?: readonly string[]; dates: readonly string[]; statuses?: readonly DigestStatus[] },
  opts?: ReadOpts & { raw?: boolean }): Promise<SlackDigestRow[]> {
  const pid = requirePrincipal(principal);
  const dates = distinct(q?.dates, (d) => typeof d === "string" && LOCAL_DATE.test(d) && Number.isFinite(Date.parse(`${d}T00:00:00Z`)));
  if (dates.length === 0) return [];
  const statuses = q.statuses === undefined ? null : distinct(q.statuses, (s) => DIGEST_STATUSES.includes(s));
  if (statuses !== null && statuses.length === 0) return [];
  const channelGroups = q.channelIds === undefined ? [null] : chunks(distinct(q.channelIds, isChannel), IN_CHUNK);
  const signal = opts?.signal;
  const out: SlackDigestRow[] = [];
  for (const dateChunk of chunks(dates, IN_CHUNK)) {
    for (const channels of channelGroups) {
      const rows = await pagedSelect("getDigests", () => {
        let query = db().from(DIGESTS).select(DIGEST_COLS).eq("principal_id", pid).in("local_date", dateChunk);
        if (channels !== null) query = query.in("channel_id", channels);
        if (statuses !== null) query = query.in("status", statuses);
        return withSignal(query.order("local_date", { ascending: false }).order("channel_id", { ascending: true }).order("id", { ascending: true }), signal);
      }, 20, signal);
      if (rows === null) return [];
      for (const r of rows) out.push(toDigestRow(r, "getDigests"));
    }
  }
  const sorted = out.sort((a, b) => (a.localDate < b.localDate ? 1 : a.localDate > b.localDate ? -1 : a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0));
  return opts?.raw === true ? sorted : guardOptedOut(principal, sorted, signal);
}

/** The digests of the given ids (esd_…; malformed ones ignored). Missing schema → []. A built digest older than the newest
 *  opt-out reads as stale (fixer security-3). */
export async function getDigestsByIds(principal: ExecPrincipal, ids: readonly string[], opts?: ReadOpts): Promise<SlackDigestRow[]> {
  const pid = requirePrincipal(principal);
  const signal = opts?.signal;
  const out: SlackDigestRow[] = [];
  for (const chunk of chunks(distinct(ids, (id) => typeof id === "string" && DIGEST_ID.test(id)), IN_CHUNK)) {
    const rows = await readRows("getDigestsByIds", withSignal(db().from(DIGESTS).select(DIGEST_COLS).eq("principal_id", pid).in("id", chunk), signal), signal);
    if (rows === null) return [];
    for (const r of rows) out.push(toDigestRow(r, "getDigestsByIds"));
  }
  return guardOptedOut(principal, out, signal);
}

/** RPC 6: claim a (channel, local day) build. Missing schema → SlackIntelStoreError("not_installed"). */
export async function claimDigest(principal: ExecPrincipal, input: { channelId: string; localDate: string; tz: string; fromTs: string; toTs: string;
  expiresAt: string; mode: SlackDigestPayload["mode"] }): Promise<{ outcome: "claimed"; id: string; rebuilds: number } | { outcome: "fresh" | "busy" | "not_found" }> {
  const pid = requirePrincipal(principal);
  if (!input || !isChannel(input.channelId)) return { outcome: "not_found" };
  if (typeof input.localDate !== "string" || !LOCAL_DATE.test(input.localDate)) throw bad("claimDigest", "malformed local date");
  if (typeof input.tz !== "string" || input.tz.length < 1 || input.tz.length > 64) throw bad("claimDigest", "malformed time zone");
  if (!isTs(input.fromTs) || !isTs(input.toTs)) throw bad("claimDigest", "malformed ts bounds");
  if (!isTime(input.expiresAt)) throw bad("claimDigest", "malformed expiry");
  if (!(CLAIM_MODES as readonly string[]).includes(input.mode)) throw bad("claimDigest", "unknown mode");
  const { data, error } = await rpc(RPC_DIGEST_CLAIM, {
    p_principal: pid,
    p_channel_id: input.channelId,
    p_local_date: input.localDate,
    p_tz: input.tz,
    p_from_ts: input.fromTs,
    p_to_ts: input.toTs,
    p_expires_at: new Date(Date.parse(input.expiresAt)).toISOString(),
    p_mode: input.mode
  });
  if (error) {
    if (missing(error)) throw notInstalled(error);
    throw failure("claimDigest", error);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw malformed("claimDigest");
  const r = data as Row;
  if (r.outcome === "claimed") {
    const id = str(r.id);
    if (!id || !DIGEST_ID.test(id)) throw malformed("claimDigest");
    return { outcome: "claimed", id, rebuilds: int(r.rebuilds) };
  }
  const outcome = oneOf(r.outcome, ["fresh", "busy", "not_found"] as const);
  if (outcome === null) throw malformed("claimDigest");
  return { outcome };
}

function linesPayload(fn: string, lines: readonly DigestLine[] | null | undefined): Row[] {
  const list = Array.isArray(lines) ? lines : [];
  if (list.length > SLACK_INTEL_LIMITS.digestLines) throw bad(fn, "at most 6 lines per list");
  return list.map((l) => {
    if (!l || typeof l.msg !== "string" || typeof l.text !== "string") throw bad(fn, "a line needs msg and text");
    return { msg: l.msg, text: l.text };
  });
}

/** RPC 7: finish a build. "lost" (no longer building) | "channel_gone" (left / reclassified: the row is deleted) |
 *  "deleted_source" (a source was deleted or an author opted out since the build began: stale, no text) | "ok".
 *  Missing schema → SlackIntelStoreError("not_installed"). */
export async function finishDigest(principal: ExecPrincipal, input: { id: string; status: Exclude<DigestStatus, "building" | "stale">; summary: string | null;
  highlights: DigestLine[]; decisions: DigestLine[]; openQuestions: DigestLine[]; sourceTs: readonly string[];
  counts: SlackDigestRow["counts"]; privacy: SlackPrivacy; partial: boolean; fullDay: boolean; injectionSuspected: boolean;
  model: string | null; costUsd: number | null }):
  Promise<"ok" | "lost" | "deleted_source" | "channel_gone"> {
  const pid = requirePrincipal(principal);
  if (!input || typeof input.id !== "string" || !DIGEST_ID.test(input.id)) return "lost";
  if (!(FINISH_STATUSES as readonly string[]).includes(input.status)) throw bad("finishDigest", "unknown status");
  // P7b's privacy set (no "dm": 1:1 DMs are never digested, the policy denies them).
  if (!(DIGEST_PRIVACIES as readonly string[]).includes(input.privacy)) throw bad("finishDigest", "a digest's privacy is public, private, group_dm, external or finance");
  const sourceTs = distinct(input.sourceTs, isTs);
  if (sourceTs.length > 2000) throw bad("finishDigest", "at most 2000 source ts");
  const c = input.counts ?? { human: 0, bot: 0, ddPost: 0, external: 0, threads: 0 };
  const count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const cost = typeof input.costUsd === "number" && Number.isFinite(input.costUsd) && input.costUsd >= 0 ? input.costUsd : null;
  const { data, error } = await rpc(RPC_DIGEST_FINISH, {
    p_principal: pid,
    p_id: input.id,
    p_status: input.status,
    p_summary: input.status === "built" ? input.summary ?? null : null,
    p_highlights: linesPayload("finishDigest", input.highlights),
    p_decisions: linesPayload("finishDigest", input.decisions),
    p_questions: linesPayload("finishDigest", input.openQuestions),
    p_source_ts: sourceTs,
    p_counts: { human: count(c.human), bot: count(c.bot), ddPost: count(c.ddPost), external: count(c.external), threads: count(c.threads) },
    p_privacy: input.privacy,
    p_partial: input.partial === true,
    p_injection: input.injectionSuspected === true,
    p_model: typeof input.model === "string" && input.model.length > 0 ? input.model.slice(0, 64) : null,
    p_cost: cost,
    p_full_day: input.fullDay === true
  });
  if (error) {
    if (missing(error)) throw notInstalled(error);
    throw failure("finishDigest", error);
  }
  const outcome = oneOf(data, ["ok", "lost", "deleted_source", "channel_gone"] as const);
  if (outcome === null) throw malformed("finishDigest");
  return outcome;
}

function blankRows(op: string, data: unknown): { id: string; channelId: string; localDate: string; oldRebuilds: number }[] {
  if (!Array.isArray(data)) throw malformed(op);
  return (data as Row[]).map((r) => {
    const id = str(r.id);
    const localDate = typeof r.local_date === "string" ? r.local_date.slice(0, 10) : null;
    if (!id || !DIGEST_ID.test(id) || !isChannel(r.channel_id) || !localDate || !LOCAL_DATE.test(localDate)) throw new SlackIntelStoreError(`${op}: malformed row`, null);
    return { id, channelId: r.channel_id, localDate, oldRebuilds: int(r.old_rebuilds) };
  });
}

/** RPC 8 for one channel's ts on the given dates (chunked to RPC 8's 500 ts × 30 dates). Each blanked digest is returned once,
 *  with its rebuilds value before the bump. No ts or dates → [] without a call. Missing schema → []. */
export async function blankDigests(principal: ExecPrincipal, channelId: string, ts: readonly string[], dates: readonly string[]):
  Promise<{ id: string; channelId: string; localDate: string; oldRebuilds: number }[]> {
  const pid = requirePrincipal(principal);
  if (!isChannel(channelId)) throw bad("blankDigests", "malformed channel id");
  const tsList = distinct(ts, isTs);
  const dateList = distinct(dates, (d) => typeof d === "string" && LOCAL_DATE.test(d));
  if (tsList.length === 0 || dateList.length === 0) return [];
  const out = new Map<string, { id: string; channelId: string; localDate: string; oldRebuilds: number }>();
  for (const tsChunk of chunks(tsList, BLANK_TS_CHUNK)) {
    for (const dateChunk of chunks(dateList, BLANK_DATES_CHUNK)) {
      const { data, error } = await rpc(RPC_DIGEST_BLANK, { p_principal: pid, p_channel_id: channelId, p_ts: tsChunk, p_dates: dateChunk, p_all: false });
      if (error) {
        if (missing(error)) return [...out.values()];
        throw failure("blankDigests", error);
      }
      // A digest blanked by an earlier chunk keeps its first (pre-bump) generation.
      for (const r of blankRows("blankDigests", data)) if (!out.has(r.id)) out.set(r.id, r);
    }
  }
  return [...out.values()];
}

/** RPC 8 with p_all (an author opt-out, C33): every built, empty or building digest of the principal. Missing schema → []. */
export async function blankAllDigests(principal: ExecPrincipal): Promise<{ id: string; channelId: string; localDate: string; oldRebuilds: number }[]> {
  const pid = requirePrincipal(principal);
  const { data, error } = await rpc(RPC_DIGEST_BLANK, { p_principal: pid, p_channel_id: null, p_ts: null, p_dates: null, p_all: true });
  if (error) {
    if (missing(error)) return [];
    throw failure("blankAllDigests", error);
  }
  return blankRows("blankAllDigests", data);
}

/** RPC 14, in chunks of 500 channels (the scan arm runs once, with the first chunk; no channels and no scan → [] without a
 *  call). Missing schema → []. */
export async function forgetSlackIntelChannels(principal: ExecPrincipal, channelIds: readonly string[], opts: { scan: boolean; signal?: AbortSignal }):
  Promise<{ channelId: string; digests: number; links: number }[]> {
  const pid = requirePrincipal(principal);
  const signal = opts?.signal;
  const scan = opts?.scan === true;
  const ids = distinct(channelIds, isChannel);
  const groups = chunks(ids, FORGET_CHUNK);
  if (groups.length === 0) {
    if (!scan) return [];
    groups.push([]);
  }
  const out: { channelId: string; digests: number; links: number }[] = [];
  for (const [i, group] of groups.entries()) {
    const { data, error } = await rpc(RPC_FORGET_CHANNELS, { p_principal: pid, p_channel_ids: group, p_scan: scan && i === 0 }, signal);
    if (error) {
      if (missing(error)) {
        signal?.throwIfAborted();
        return out;
      }
      throw failure("forgetSlackIntelChannels", error, signal);
    }
    if (!Array.isArray(data)) throw malformed("forgetSlackIntelChannels");
    for (const r of data as Row[]) {
      if (!isChannel(r.channel_id)) throw new SlackIntelStoreError("forgetSlackIntelChannels: malformed row", null);
      out.push({ channelId: r.channel_id, digests: int(r.digests), links: int(r.links) });
    }
  }
  return out;
}

/** The retention step (§2.3): digests past expires_at deleted in chunks of 1 000 by id, and `building` digests whose
 *  requested_at is over 30 minutes old marked `failed` (a crashed build). Global (every principal). Missing table → 0. */
export async function purgeExpiredSlackIntel(now: Date, opts?: ReadOpts): Promise<{ digests: number; failedBuilds: number }> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw bad("purgeExpiredSlackIntel", "now must be a valid Date");
  const signal = opts?.signal;
  const nowIso = now.toISOString();
  let digests = 0;
  for (let round = 0; round < PURGE_MAX_ROUNDS; round += 1) {
    signal?.throwIfAborted();
    const ids = await readRows("purgeExpiredSlackIntel", withSignal(db().from(DIGESTS).select("id").lt("expires_at", nowIso).order("id", { ascending: true })
      .limit(PURGE_CHUNK), signal), signal);
    if (ids === null) return { digests, failedBuilds: 0 };
    const list = ids.map((r) => str(r.id)).filter((id): id is string => id !== null);
    if (list.length === 0) break;
    for (const chunk of chunks(list, IN_CHUNK * 2)) {
      const gone = await readRows("purgeExpiredSlackIntel", withSignal(db().from(DIGESTS).delete().in("id", chunk).lt("expires_at", nowIso).select("id"), signal), signal);
      if (gone === null) return { digests, failedBuilds: 0 };
      digests += gone.length;
    }
    if (list.length < PURGE_CHUNK) break;
  }
  const cutoff = new Date(now.getTime() - STALE_BUILD_MS).toISOString();
  const failed = await readRows("purgeExpiredSlackIntel", withSignal(db().from(DIGESTS).update({ status: "failed", full_day: false, updated_at: nowIso })
    .eq("status", "building").lt("requested_at", cutoff).select("id"), signal), signal);
  return { digests, failedBuilds: failed === null ? 0 : failed.length };
}

// ---------------------------------------------------------------------------
// Chat (RPCs 9-12)
// ---------------------------------------------------------------------------

/** true when RPC 9 exists. Probed with a no-op call (no such message: v1 updates nothing and v2 writes nothing); a true answer
 *  is cached for the process, a missing function (42883 / PGRST202) for 10 minutes. Any other failure throws (not cached). */
export async function finishTurnV2Available(): Promise<boolean> {
  const now = Date.now();
  if (v2Cache && (v2Cache.value || now - v2Cache.at < V2_REPROBE_MS)) return v2Cache.value;
  const { error } = await rpc(RPC_FINISH_TURN_V2, {
    p_principal: "",
    p_message_id: "",
    p_status: "complete",
    p_status_reason: null,
    p_refusal_category: null,
    p_text: "",
    p_recommendations: "",
    p_sources: [],
    p_cards: [],
    p_tool_calls: [],
    p_consulted: [],
    p_consulted_clients: [],
    p_consulted_dd_text: false,
    p_usage: null,
    p_model: null,
    p_ref_seq: 0,
    p_slack_refs: [],
    p_slack_channels: [],
    p_private_slack: false
  });
  if (error) {
    const code = pgCodeOf(error);
    if (code !== null && (FUNCTION_MISSING_CODES.has(code) || SCHEMA_MISSING_CODES.has(code))) {
      v2Cache = { value: false, at: Date.now() };
      return false;
    }
    throw failure("finishTurnV2Available", error);
  }
  v2Cache = { value: true, at: Date.now() };
  return true;
}

/** RPC 9: the v2 finish (P5b's RPC 2 and the turn's Slack consults in one transaction, D6). `args` are RPC 2's p_* arguments
 *  exactly as chat-store.ts builds them (p_principal aside); the three Slack values are appended here. true = the running row
 *  was finished. Throws SlackIntelStoreError("finishTurnV2", code) on any error (a missing RPC 9 included: chat-store probes
 *  finishTurnV2Available first and never falls back to v1 with consults); an aborted signal wins. */
export async function finishTurnV2Rpc(principal: ExecPrincipal, args: Readonly<Record<string, unknown>>,
  slack: { refs: readonly string[]; channels: readonly string[]; privateSlack: boolean }, opts: { signal: AbortSignal }): Promise<boolean> {
  const pid = requirePrincipal(principal);
  if (!opts || !(opts.signal instanceof AbortSignal)) throw bad("finishTurnV2Rpc", "needs its own signal");
  if (!slack || !Array.isArray(slack.refs) || !Array.isArray(slack.channels)) throw bad("finishTurnV2Rpc", "malformed Slack consults");
  const signal = opts.signal;
  signal.throwIfAborted();
  const { data, error } = await rpc(RPC_FINISH_TURN_V2, {
    ...args,
    p_principal: pid,
    p_slack_refs: [...slack.refs],
    p_slack_channels: [...slack.channels],
    p_private_slack: slack.privateSlack === true
  }, signal);
  if (error) throw failure("finishTurnV2", error, signal);
  if (typeof data !== "boolean") throw malformed("finishTurnV2");
  return data;
}

/** RPC 10. Keys must be m:<C>:<ts> / d:<C>:<date>:<n> (others are dropped), channels channel ids; at most 500 keys + channels
 *  per call (chunked). all: one principal-wide call. text 1..400 characters. Returns the answers redacted. Each call is
 *  repeated while it comes back at RPC 10's 2 000-answer cap (fixer security-2). Missing schema → 0 (nothing could have
 *  recorded a Slack consult without it). */
export async function redactSlackRpc(principal: ExecPrincipal, input: { messageKeys: readonly string[]; digestKeys: readonly string[];
  channelIds: readonly string[]; all: boolean; text: string }, opts?: ReadOpts): Promise<number> {
  const pid = requirePrincipal(principal);
  if (!input || typeof input.text !== "string" || input.text.length < 1 || input.text.length > 400) throw bad("redactSlackRpc", "text must be 1..400 characters");
  const signal = opts?.signal;
  const once = async (mk: string[], dk: string[], ch: string[], all: boolean): Promise<number | null> => {
    const { data, error } = await rpc(RPC_REDACT_SLACK, { p_principal: pid, p_message_keys: mk, p_digest_keys: dk, p_channel_ids: ch, p_all: all, p_text: input.text }, signal);
    if (error) {
      if (missing(error)) {
        signal?.throwIfAborted();
        return null;
      }
      throw failure("redactSlackRpc", error, signal);
    }
    return int(data);
  };
  // Fixer security-2 / correctness-6: RPC 10 redacts at most REDACT_HIT_CAP answers per call (oldest first), and a redacted
  // answer drops out of its selection, so a call that hit the cap is repeated until one comes back under it. The one-shot
  // callers (a reading row, an opt-out) move their cursor or fingerprint only after this returns, so a set still at the
  // cap after REDACT_MAX_PASSES throws instead: the next sweep goes on from where this one stopped.
  const call = async (mk: string[], dk: string[], ch: string[], all: boolean): Promise<number | null> => {
    let total = 0;
    for (let pass = 0; pass < REDACT_MAX_PASSES; pass++) {
      signal?.throwIfAborted();
      const n = await once(mk, dk, ch, all);
      if (n === null) return pass === 0 ? null : total;
      total += n;
      if (n < REDACT_HIT_CAP) return total;
    }
    throw new SlackIntelStoreError("redactSlackRpc: more answers than one sweep redacts", null);
  };
  if (input.all === true) return (await call([], [], [], true)) ?? 0;
  const items: ["m" | "d" | "c", string][] = [
    ...distinct(input.messageKeys, (k) => typeof k === "string" && k.startsWith("m:") && REF_KEY.test(k)).map((k) => ["m", k] as ["m", string]),
    ...distinct(input.digestKeys, (k) => typeof k === "string" && k.startsWith("d:") && REF_KEY.test(k)).map((k) => ["d", k] as ["d", string]),
    ...distinct(input.channelIds, isChannel).map((c) => ["c", c] as ["c", string])
  ];
  let n = 0;
  for (const chunk of chunks(items, REDACT_CHUNK)) {
    const got = await call(chunk.filter(([t]) => t === "m").map(([, v]) => v), chunk.filter(([t]) => t === "d").map(([, v]) => v),
      chunk.filter(([t]) => t === "c").map(([, v]) => v), false);
    if (got === null) return n;
    n += got;
  }
  return n;
}

/** RPC 11: the post-finish recheck of one answer; true when it redacted. Missing schema → false. */
export async function recheckSlackRpc(principal: ExecPrincipal, messageId: string, text: string, opts: { signal: AbortSignal }): Promise<boolean> {
  const pid = requirePrincipal(principal);
  if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId)) return false;
  if (typeof text !== "string" || text.length < 1 || text.length > 400) throw bad("recheckSlackRpc", "text must be 1..400 characters");
  const signal = opts?.signal;
  const { data, error } = await rpc(RPC_SLACK_RECHECK, { p_principal: pid, p_message_id: messageId, p_text: text }, signal);
  if (error) {
    if (missing(error)) {
      signal?.throwIfAborted();
      return false;
    }
    throw failure("recheckSlackRpc", error, signal);
  }
  if (typeof data !== "boolean") throw malformed("recheckSlackRpc");
  return data;
}

/** RPC 12: lost channels that unredacted answers consulted (limit 1..200). Missing schema → []. */
export async function listOrphanSlackChannels(principal: ExecPrincipal, limit: number, opts?: ReadOpts): Promise<string[]> {
  const pid = requirePrincipal(principal);
  const signal = opts?.signal;
  const { data, error } = await rpc(RPC_ORPHAN_CHANNELS, { p_principal: pid, p_limit: clampInt(limit, 1, 200, 200) }, signal);
  if (error) {
    if (missing(error)) {
      signal?.throwIfAborted();
      return [];
    }
    throw failure("listOrphanSlackChannels", error, signal);
  }
  if (!Array.isArray(data)) throw malformed("listOrphanSlackChannels");
  // PostgREST answers a setof-scalar function with the scalars; an object row ({ exec_chat_slack_orphan_channels: id }) is
  // accepted too.
  const ids = (data as unknown[]).map((v) => (typeof v === "string" ? v : v !== null && typeof v === "object" ? Object.values(v as Row)[0] : null));
  return distinct(ids.filter(isChannel), () => true);
}

/** Test seam: forget the per-process schema and v2 caches. */
export function __resetSlackIntelStoreForTests(): void {
  schemaCache = null;
  v2Cache = null;
}
