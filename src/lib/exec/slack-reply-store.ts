import "server-only";

import { listActiveInstallationsForSystem } from "@/lib/exec/slack-install";
import { P10_LIMITS, REPLY_ACTIVE_STATUSES, REPLY_FLAGS } from "@/lib/exec/slack-p10-types";
import type {
  CreateReplyOutcome,
  CreateReplyRefusal,
  ReplyCardState,
  ReplyDraftRow,
  ReplyFlag,
  ReplyGenerationError,
  ReplyOrigin,
  ReplyStatus,
  ReplyTargetFacts,
  ReplyVoiceSource,
  SlackVoiceProfileRow
} from "@/lib/exec/slack-p10-types";
import type { ConvType } from "@/lib/exec/slack-read-types";
import { sanitizeChars } from "@/lib/exec/slack-ui";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P10 reply-draft store (contract §3.5.3; Area A; server-only): the only module naming exec_slack_reply_drafts,
// exec_slack_reply_cards, exec_slack_voice_profile and the reply functions of §2.1.9-§2.1.13 (B-P10-2). Every write builds
// rows with the identical key set; every read maps through one toReplyRow that validates shapes (a malformed row throws a
// code-only SlackReplyStoreError); errors carry the Postgres code only.
//
//   * Errors are SlackReplyStoreError(op, pgCode): the function's name and the database's own code, never a value this
//     module was handed or read (no ids, ts values, text, instructions). An aborted signal wins: its reason is thrown.
//   * A missing table / function / column (the P10 migration isn't applied, §2.4 item 2) maps to the signature's "not
//     installed" answer: false, [], null, zeros, an empty map or set, createReplyDraftRow's refusal "not_installed", and
//     "not_found" for the RPCs that answer it (regenerate, finish, edit, target).
//   * C34: every text write (finishReplyDraft, editReplyDraft) stores sanitizeChars(text.normalize("NFC")), so a stored draft
//     is always in the form sendSlackReply requires; its length is checked after that (1..4,000).
//   * Arguments are checked here (the shapes the table CHECKs and the RPCs require); a bad argument is a TypeError naming the
//     argument, never its value.
//   * §2.1.16 X1-X13 (stepReplyDraft) are plain-row CAS updates: one PostgREST update fenced on (id, principal_id, the from
//     status, the transition's own fence), answering whether a row moved. `now` is the app's time.
//   * Nothing here logs.

const DRAFTS = "exec_slack_reply_drafts";
const CARDS = "exec_slack_reply_cards";
const VOICE = "exec_slack_voice_profile";
const RPC_CREATE = "exec_slack_rdraft_create";
const RPC_REGENERATE = "exec_slack_rdraft_regenerate";
const RPC_FINISH = "exec_slack_rdraft_finish";
const RPC_EDIT = "exec_slack_rdraft_edit";
const RPC_TARGET = "exec_slack_rdraft_target";
const RPC_BLANK = "exec_slack_rdraft_blank";
const RPC_PURGE_EXPIRED = "exec_slack_rdraft_purge_expired";

/** Every exec_slack_reply_drafts column the app reads (ReplyDraftRow). */
const DRAFT_COLS =
  "id,installation_id,channel_id,conv_type,item_id,source_ts,source_thread_ts,reply_thread_ts,origin,status,status_reason,version,generation_seq," +
  "text,instruction,note,placeholders,edited,flags,injection_suspected,voice_source,generation_error,context_ts,context_authors,context_latest_ts," +
  "source_edited_ts,external,finance,generated_at,sending_at,audit_id,sent_at,posted_ts,posted_permalink,sent_text_sha256,sent_words_sha256," +
  "verify_checks,owner_resolution,chat_message_id,terminal_at,content_purged_at,expires_at,created_at,updated_at";
const VOICE_COLS =
  "status,formality,typical_length,capitalization,punctuation,greeting,emoji,abbreviations,exclamations,bullets,sample_count,sample_refs," +
  "sample_channels,samples_hash,model,prompt_version,last_attempt_error,built_at,expires_at";
/** The identical key set of every recordReplyCard row (P3 §0). */
const CARD_KEYS = ["installation_id", "principal_id", "dm_channel_id", "dm_ts", "thread_ts", "draft_id", "origin", "rendered_version",
  "rendered_state", "expires_at"] as const;

/** Missing table (42P01, PGRST205), function (42883, PGRST202) or column (42703, PGRST204): the migration isn't applied. */
const SCHEMA_MISSING_CODES: ReadonlySet<string> = new Set(["42P01", "PGRST205", "42883", "PGRST202", "42703", "PGRST204"]);
const PG_CODE = /^[A-Z0-9]{2,10}$/;
const DRAFT_ID = /^esr_[0-9a-f]{32}$/;
const ITEM_ID = /^esl_[0-9a-f]{32}$/;
const CHAT_MESSAGE_ID = /^ecm_[0-9a-f]{32}$/;
const CHANNEL = /^[CGD][A-Z0-9]{2,30}$/;
const DM_CHANNEL = /^D[A-Z0-9]{2,30}$/;
const SLACK_USER = /^[UW][A-Z0-9]{2,30}$/;
const TS = /^[0-9]{1,12}\.[0-9]{1,8}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CODE = /^[a-z0-9_]{1,60}$/;
const INSTALLATION = /^[A-Za-z0-9_-]{1,100}$/;
const PERMALINK = /^https:\/\/[a-z0-9][a-z0-9-]*\.slack\.com\/archives\/[CGD][A-Z0-9]{2,30}\/p[0-9]{10,20}/;
const REF = /^[CGD][A-Z0-9]{2,30}:[0-9]{1,12}\.[0-9]{1,8}$/;

const CONV_TYPES: readonly ConvType[] = ["channel", "group", "im", "mpim"];
const ORIGINS: readonly ReplyOrigin[] = ["web", "chat", "slack", "auto"];
const STATUSES: readonly ReplyStatus[] = ["generating", "generation_failed", "draft", "sending", "sent", "unknown", "failed", "discarded", "expired", "removed"];
const OPEN_STATUSES: readonly ReplyStatus[] = ["generating", "generation_failed", "draft"];
const GENERATION_ERRORS: readonly ReplyGenerationError[] = ["refused", "truncated", "invalid_output", "empty", "too_long", "copied_external",
  "timeout", "model_error", "budget", "context_unavailable", "reading_off", "channel", "context_deleted", "author_optout"];
const VOICE_SOURCES: readonly ReplyVoiceSource[] = ["slack", "email", "house"];
const CARD_STATES: readonly ReplyCardState[] = ["generating", "failed_generation", "live", "dd_only", "sending", "sent", "unknown", "failed",
  "discarded", "expired", "removed", "off"];
/** The cards the open index covers (exec_slack_reply_cards_open_idx): still showing something that can change. */
const CLOSED_CARD_STATES: readonly ReplyCardState[] = ["sent", "failed", "discarded", "expired", "removed", "off"];
const REFUSALS: readonly CreateReplyRefusal[] = ["not_reading", "channel", "message", "deleted", "author_optout", "item", "off", "not_installed",
  "screen", "not_found", "not_stored", "finance_slack", "cap", "rate_limited", "from_draft", "from_draft_mismatch", "already_posted", "unavailable"];
const URGENCIES = ["critical", "high", "normal", "low"] as const;
const BLANK_REASONS = ["deleted", "author_optout", "conversation", "reading"] as const;
const FORMALITY = ["very_casual", "casual", "neutral", "formal"] as const;
const LENGTH = ["one_liner", "short", "medium", "long"] as const;
const CAPS = ["mostly_lowercase", "standard"] as const;
const PUNCT = ["minimal", "standard"] as const;
const GREETING = ["none", "name_only", "hey_name", "hi_name", "mixed"] as const;
const EMOJI = ["never", "rarely", "sometimes", "often"] as const;
const FREQUENCY = ["never", "sometimes", "often"] as const;
const VOICE_ERRORS = ["declined", "truncated", "invalid_output", "budget", "read_failed", "insufficient"] as const;

const SCHEMA_TTL_TRUE_MS = 60_000;
const SCHEMA_TTL_FALSE_MS = 10_000;
const DAY_MS = 86_400_000;
const LIST_MAX = 50;
const IN_CHUNK = 200;
/** exec_slack_rdraft_purge_expired works in batches of 1,000 per step; the store calls again (≤ 10 rounds) while one fills. */
const PURGE_BATCH = 1000;
const PURGE_ROUNDS = 10;
const CARD_SCAN = 500;
/** deleteRevokedInstallationCards: the distinct installation ids walked a day, and listActiveInstallationsForSystem's cap. */
const CARD_INSTALLATIONS_MAX = 100;
const ACTIVE_INSTALLATIONS_MAX = 500;
const VOICE_TTL_MAX_MS = 31 * DAY_MS;

type ReadOpts = { signal?: AbortSignal };
type DbError = { code?: string | null; message?: string | null };
type Row = Record<string, unknown>;
type Result = { data: unknown; error: DbError | null; count?: number | null };

export class SlackReplyStoreError extends Error {
  readonly op: string;
  readonly pgCode: string | null;
  constructor(op: string, pgCode: string | null) {
    super(`exec slack reply store: ${op} failed${pgCode ? ` (${pgCode})` : ""}`);
    this.name = "SlackReplyStoreError";
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
export function isReplySchemaMissing(err: unknown): boolean {
  if (err instanceof SlackReplyStoreError) return err.pgCode !== null && SCHEMA_MISSING_CODES.has(err.pgCode);
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && SCHEMA_MISSING_CODES.has(code);
}

function failure(op: string, error: DbError | null | undefined, signal?: AbortSignal): SlackReplyStoreError {
  signal?.throwIfAborted();
  return new SlackReplyStoreError(op, pgCodeOf(error));
}

const malformed = (op: string) => new SlackReplyStoreError(`${op}: malformed answer`, null);
const bad = (fn: string, what: string) => new TypeError(`exec slack reply store: ${fn}: ${what}`);

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
  return Array.isArray(result.data) ? (result.data as Row[]) : [];
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
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null);
const chars = (s: string) => Array.from(s).length;
const objectOf = (v: unknown): Row | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null);
const plus = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS).toISOString();

function validDate(fn: string, v: unknown, what: string): Date {
  if (!(v instanceof Date) || !Number.isFinite(v.getTime())) throw bad(fn, `${what} must be a valid Date`);
  return v;
}
function validIso(fn: string, v: unknown, what: string): string {
  const out = typeof v === "string" ? iso(v) : null;
  if (out === null) throw bad(fn, `${what} must be an ISO timestamp`);
  return out;
}
function validTs(fn: string, v: unknown, what: string): string {
  if (typeof v !== "string" || !TS.test(v)) throw bad(fn, `${what} must be a Slack ts`);
  return v;
}
function validChannel(fn: string, v: unknown): string {
  if (typeof v !== "string" || !CHANNEL.test(v)) throw bad(fn, "a channel id (C…, G… or D…) is required");
  return v;
}
function validInstallation(fn: string, v: unknown): string {
  if (typeof v !== "string" || !INSTALLATION.test(v)) throw bad(fn, "an installation id is required");
  return v;
}
function validVersion(fn: string, v: unknown, what = "version"): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 9999) throw bad(fn, `${what} must be an integer 0..9999`);
  return v;
}
function validDraftId(fn: string, v: unknown): string {
  if (typeof v !== "string" || !DRAFT_ID.test(v)) throw bad(fn, "a draft id (esr_…) is required");
  return v;
}
/** An expiry the RPCs accept: after now, at most 8 days ahead. */
function validExpiry(fn: string, v: unknown): string {
  const d = validDate(fn, v, "expiresAt");
  const now = Date.now();
  if (d.getTime() <= now || d.getTime() > now + 8 * DAY_MS) throw bad(fn, "expiresAt must be within the next 8 days");
  return d.toISOString();
}
/** C34: the stored form of a draft text (generation and edit), 1..4,000 characters once normalized. */
function storedText(fn: string, v: unknown): string {
  if (typeof v !== "string") throw bad(fn, "text must be a string");
  const text = sanitizeChars(v.normalize("NFC"));
  const n = chars(text);
  if (n < 1 || n > P10_LIMITS.replyTextChars) throw bad(fn, `text must be 1..${P10_LIMITS.replyTextChars} characters`);
  return text;
}
function stringList(fn: string, v: unknown, re: RegExp, max: number, what: string): string[] {
  if (!Array.isArray(v)) throw bad(fn, `${what} must be an array`);
  if (v.length > max) throw bad(fn, `${what} holds at most ${max}`);
  for (const x of v) if (typeof x !== "string" || !re.test(x)) throw bad(fn, `${what} holds a malformed entry`);
  return [...v] as string[];
}
function placeholderList(fn: string, v: unknown): string[] {
  if (!Array.isArray(v)) throw bad(fn, "placeholders must be an array");
  if (v.length > P10_LIMITS.replyPlaceholdersMax) throw bad(fn, `placeholders holds at most ${P10_LIMITS.replyPlaceholdersMax}`);
  for (const x of v) if (typeof x !== "string" || x.length === 0 || chars(x) > 200) throw bad(fn, "placeholders holds a malformed entry");
  return [...v] as string[];
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

/** The one mapper of a stored draft row; a malformed row throws a code-only SlackReplyStoreError. */
function toReplyRow(r: Row, op: string): ReplyDraftRow {
  const fail = (): never => {
    throw new SlackReplyStoreError(`${op}: malformed row`, null);
  };
  const id = str(r.id);
  const installationId = str(r.installation_id);
  const channelId = str(r.channel_id);
  const convType = oneOf(r.conv_type, CONV_TYPES);
  const sourceTs = str(r.source_ts);
  const origin = oneOf(r.origin, ORIGINS);
  const status = oneOf(r.status, STATUSES);
  const version = int(r.version);
  const generationSeq = int(r.generation_seq);
  const verifyChecks = int(r.verify_checks);
  const expiresAt = iso(r.expires_at);
  const createdAt = iso(r.created_at);
  const updatedAt = iso(r.updated_at);
  if (id === null || !DRAFT_ID.test(id) || installationId === null || channelId === null || !CHANNEL.test(channelId) || convType === null
      || sourceTs === null || !TS.test(sourceTs) || origin === null || status === null || version === null || generationSeq === null
      || verifyChecks === null || expiresAt === null || createdAt === null || updatedAt === null) {
    return fail();
  }
  const optTs = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    return typeof v === "string" && TS.test(v) ? v : fail();
  };
  const texts = (v: unknown): string[] => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : fail());
  const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : fail());
  const flags = texts(r.flags);
  if (!flags.every((f) => (REPLY_FLAGS as readonly string[]).includes(f))) fail();
  const voiceSource = r.voice_source === null || r.voice_source === undefined ? null : oneOf(r.voice_source, VOICE_SOURCES) ?? fail();
  const generationError = r.generation_error === null || r.generation_error === undefined ? null : oneOf(r.generation_error, GENERATION_ERRORS) ?? fail();
  const ownerResolution = r.owner_resolution === null || r.owner_resolution === undefined ? null
    : oneOf(r.owner_resolution, ["posted", "not_posted"] as const) ?? fail();
  const auditId = r.audit_id === null || r.audit_id === undefined ? null : int(r.audit_id) ?? fail();
  return {
    id, installationId, channelId, convType, itemId: str(r.item_id), sourceTs, sourceThreadTs: optTs(r.source_thread_ts),
    replyThreadTs: optTs(r.reply_thread_ts), origin, status, statusReason: str(r.status_reason), version, generationSeq,
    text: str(r.text), instruction: str(r.instruction), note: str(r.note), placeholders: texts(r.placeholders), edited: bool(r.edited),
    flags: flags as ReplyFlag[], injectionSuspected: bool(r.injection_suspected), voiceSource, generationError, contextTs: texts(r.context_ts),
    contextAuthors: texts(r.context_authors), contextLatestTs: optTs(r.context_latest_ts), sourceEditedTs: optTs(r.source_edited_ts),
    external: bool(r.external), finance: bool(r.finance), generatedAt: iso(r.generated_at), sendingAt: iso(r.sending_at), auditId,
    sentAt: iso(r.sent_at), postedTs: optTs(r.posted_ts), postedPermalink: str(r.posted_permalink), sentTextSha256: str(r.sent_text_sha256),
    sentWordsSha256: str(r.sent_words_sha256), verifyChecks, ownerResolution, chatMessageId: str(r.chat_message_id), terminalAt: iso(r.terminal_at),
    contentPurgedAt: iso(r.content_purged_at), expiresAt, createdAt, updatedAt
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

let schemaCache: { value: boolean; at: number } | null = null;

/** Cached 60 s (10 s while missing); a missing table or column → false; any other error throws. */
export async function replySchemaReady(opts?: { signal?: AbortSignal }): Promise<boolean> {
  const now = Date.now();
  if (schemaCache && now - schemaCache.at >= 0 && now - schemaCache.at < (schemaCache.value ? SCHEMA_TTL_TRUE_MS : SCHEMA_TTL_FALSE_MS)) {
    return schemaCache.value;
  }
  const signal = opts?.signal;
  const { error } = (await withSignal(db().from(DRAFTS).select("id").limit(0), signal)) as Result;
  if (error && !missing(error)) throw failure("replySchemaReady", error, signal);
  if (error) signal?.throwIfAborted();
  schemaCache = { value: !error, at: Date.now() };
  return schemaCache.value;
}

// ---------------------------------------------------------------------------
// The RPCs (§2.1.9-§2.1.13)
// ---------------------------------------------------------------------------

/** RPC 13 (v1.1: p_from_draft, never text). Missing schema → refused "not_installed". */
export async function createReplyDraftRow(principal: ExecPrincipal, input: { installationId: string; channelId: string; ts: string;
  itemId: string | null; origin: ReplyOrigin; instruction: string | null; fromDraftId: string | null; chatMessageId: string | null;
  expiresAt: Date }): Promise<CreateReplyOutcome> {
  const fn = "createReplyDraftRow";
  const pid = requirePrincipal(fn, principal);
  if (!input || typeof input !== "object") throw bad(fn, "input is required");
  const installationId = validInstallation(fn, input.installationId);
  const channelId = validChannel(fn, input.channelId);
  const ts = validTs(fn, input.ts, "ts");
  if (input.itemId !== null && (typeof input.itemId !== "string" || !ITEM_ID.test(input.itemId))) throw bad(fn, "itemId must be an esl_ id or null");
  const origin = oneOf(input.origin, ORIGINS);
  if (origin === null) throw bad(fn, "origin must be web, chat, slack or auto");
  if (input.instruction !== null && (typeof input.instruction !== "string" || chars(input.instruction) < 1
      || chars(input.instruction) > P10_LIMITS.replyInstructionChars)) {
    throw bad(fn, `instruction must be 1..${P10_LIMITS.replyInstructionChars} characters or null`);
  }
  if (input.fromDraftId !== null) {
    validDraftId(fn, input.fromDraftId);
    if (origin !== "web" || input.instruction !== null) throw bad(fn, "fromDraftId is for a web create without an instruction");
  }
  if (input.chatMessageId !== null && (typeof input.chatMessageId !== "string" || !CHAT_MESSAGE_ID.test(input.chatMessageId))) {
    throw bad(fn, "chatMessageId must be an ecm_ id or null");
  }
  const expiresAt = validExpiry(fn, input.expiresAt);
  const { data, error } = await rpc(RPC_CREATE, {
    p_principal: pid, p_installation: installationId, p_channel: channelId, p_ts: ts, p_item_id: input.itemId, p_origin: origin,
    p_instruction: input.instruction, p_from_draft: input.fromDraftId, p_chat_message_id: input.chatMessageId, p_expires_at: expiresAt
  });
  if (error) {
    if (missing(error)) return { outcome: "refused", reason: "not_installed" };
    throw failure(fn, error);
  }
  const r = objectOf(data);
  if (r?.outcome === "refused") {
    const reason = oneOf(r.reason, REFUSALS);
    if (reason === null) throw malformed(fn);
    return { outcome: "refused", reason };
  }
  const outcome = oneOf(r?.outcome, ["created", "existing"] as const);
  const id = str(r?.id);
  const status = oneOf(r?.status, STATUSES);
  const version = int(r?.version);
  const generationSeq = int(r?.generation_seq);
  if (outcome === null || id === null || !DRAFT_ID.test(id) || status === null || version === null || generationSeq === null || typeof r?.edited !== "boolean") {
    throw malformed(fn);
  }
  return { outcome, id, status, version, generationSeq, edited: r.edited };
}

/** RPC 14 (Rewrite): claims a draft or a failed first generation at expectedVersion for a new generation. Missing → not_found. */
export async function regenerateReplyDraftRow(principal: ExecPrincipal, id: string, expectedVersion: number, instruction: string | null,
  keepInstruction: boolean, expiresAt: Date): Promise<{ outcome: "claimed"; generationSeq: number; version: number }
  | { outcome: "not_found" } | { outcome: "busy"; status: ReplyStatus } | { outcome: "conflict"; version: number }> {
  const fn = "regenerateReplyDraftRow";
  const pid = requirePrincipal(fn, principal);
  const draftId = validDraftId(fn, id);
  const version = validVersion(fn, expectedVersion, "expectedVersion");
  if (instruction !== null && (typeof instruction !== "string" || chars(instruction) < 1 || chars(instruction) > P10_LIMITS.replyInstructionChars)) {
    throw bad(fn, `instruction must be 1..${P10_LIMITS.replyInstructionChars} characters or null`);
  }
  if (typeof keepInstruction !== "boolean") throw bad(fn, "keepInstruction must be a boolean");
  const expires = validExpiry(fn, expiresAt);
  const { data, error } = await rpc(RPC_REGENERATE, {
    p_principal: pid, p_id: draftId, p_expected_version: version, p_instruction: instruction, p_keep_instruction: keepInstruction, p_expires_at: expires
  });
  if (error) {
    if (missing(error)) return { outcome: "not_found" };
    throw failure(fn, error);
  }
  const r = objectOf(data);
  switch (r?.outcome) {
    case "claimed": {
      const generationSeq = int(r.generation_seq);
      const v = int(r.version);
      if (generationSeq === null || v === null) throw malformed(fn);
      return { outcome: "claimed", generationSeq, version: v };
    }
    case "not_found":
      return { outcome: "not_found" };
    case "busy": {
      const status = oneOf(r.status, STATUSES);
      if (status === null) throw malformed(fn);
      return { outcome: "busy", status };
    }
    case "conflict": {
      const v = int(r.version);
      if (v === null) throw malformed(fn);
      return { outcome: "conflict", version: v };
    }
    default:
      throw malformed(fn);
  }
}

export interface FinishInput { ok: boolean; error?: ReplyGenerationError; text?: string; note?: string | null; placeholders?: string[];
  flags?: ReplyFlag[]; injectionSuspected?: boolean; voiceSource?: ReplyVoiceSource; model?: string; contextTs?: string[];
  contextAuthors?: string[]; contextLatestTs?: string | null; externalSeen?: boolean /* v1.1 security-4 */; expiresAt: Date }

/**
 * RPC 15: the generation's one write, fenced on (status generating, seq). ok → the draft (C34's stored form of the text); a
 * failure → generation_failed (first generation) or back to draft with the error as status_reason (a rewrite keeps its text),
 * or removed when a context message was deleted or its author opted out after a draft existed. p_out always carries the
 * same keys (external_seen as a boolean). Missing schema → not_found.
 */
export async function finishReplyDraft(principal: ExecPrincipal, id: string, seq: number, out: FinishInput):
  Promise<{ outcome: "written"; version: number } | { outcome: "failed"; error: string } | { outcome: "stale" | "not_found" }> {
  const fn = "finishReplyDraft";
  const pid = requirePrincipal(fn, principal);
  const draftId = validDraftId(fn, id);
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1 || seq > 1000) throw bad(fn, "seq must be an integer 1..1000");
  if (!out || typeof out !== "object" || typeof out.ok !== "boolean") throw bad(fn, "out.ok must be a boolean");
  const expiresAt = validExpiry(fn, out.expiresAt);
  let pOut: Row;
  if (!out.ok) {
    const error = out.error === undefined ? "model_error" : oneOf(out.error, GENERATION_ERRORS);
    if (error === null) throw bad(fn, "out.error is not a generation error");
    pOut = { ok: false, error, text: null, note: null, placeholders: [], flags: [], injection_suspected: false, voice_source: null, model: null,
      context_ts: [], context_authors: [], context_latest_ts: null, external_seen: out.externalSeen === true, expires_at: expiresAt };
  } else {
    const text = storedText(fn, out.text);
    let note: string | null = null;
    if (out.note !== undefined && out.note !== null) {
      if (typeof out.note !== "string") throw bad(fn, "out.note must be a string or null");
      const n = sanitizeChars(out.note.normalize("NFC"));
      if (chars(n) > P10_LIMITS.replyNoteChars) throw bad(fn, `out.note must be at most ${P10_LIMITS.replyNoteChars} characters`);
      note = n.length > 0 ? n : null;
    }
    const placeholders = placeholderList(fn, out.placeholders ?? []);
    const flags = out.flags ?? [];
    if (!Array.isArray(flags) || !flags.every((f) => (REPLY_FLAGS as readonly string[]).includes(f))) throw bad(fn, "out.flags holds an unknown flag");
    if (out.injectionSuspected !== undefined && typeof out.injectionSuspected !== "boolean") throw bad(fn, "out.injectionSuspected must be a boolean");
    const voiceSource = out.voiceSource === undefined ? null : oneOf(out.voiceSource, VOICE_SOURCES);
    if (out.voiceSource !== undefined && voiceSource === null) throw bad(fn, "out.voiceSource is not a voice source");
    if (out.model !== undefined && (typeof out.model !== "string" || chars(out.model) < 1 || chars(out.model) > 64)) throw bad(fn, "out.model must be 1..64 characters");
    const contextTs = stringList(fn, out.contextTs ?? [], TS, P10_LIMITS.replyContextMax, "out.contextTs");
    const contextAuthors = stringList(fn, out.contextAuthors ?? [], SLACK_USER, P10_LIMITS.replyContextMax, "out.contextAuthors");
    const contextLatestTs = out.contextLatestTs === undefined || out.contextLatestTs === null ? null : validTs(fn, out.contextLatestTs, "out.contextLatestTs");
    if (out.externalSeen !== undefined && typeof out.externalSeen !== "boolean") throw bad(fn, "out.externalSeen must be a boolean");
    pOut = { ok: true, error: null, text, note, placeholders, flags: [...new Set(flags)], injection_suspected: out.injectionSuspected === true,
      voice_source: voiceSource, model: out.model ?? null, context_ts: [...new Set(contextTs)], context_authors: [...new Set(contextAuthors)],
      context_latest_ts: contextLatestTs, external_seen: out.externalSeen === true, expires_at: expiresAt };
  }
  const { data, error } = await rpc(RPC_FINISH, { p_principal: pid, p_id: draftId, p_seq: seq, p_out: pOut });
  if (error) {
    if (missing(error)) return { outcome: "not_found" };
    throw failure(fn, error);
  }
  const r = objectOf(data);
  switch (r?.outcome) {
    case "written": {
      const version = int(r.version);
      if (version === null) throw malformed(fn);
      return { outcome: "written", version };
    }
    case "failed": {
      const e = oneOf(r.error, GENERATION_ERRORS);
      if (e === null) throw malformed(fn);
      return { outcome: "failed", error: e };
    }
    case "stale":
      return { outcome: "stale" };
    case "not_found":
      return { outcome: "not_found" };
    default:
      throw malformed(fn);
  }
}

/** RPC 16: his edit, a CAS on (status draft, expectedVersion, content present); stores C34's form of the text. Missing → not_found. */
export async function editReplyDraft(principal: ExecPrincipal, id: string, expectedVersion: number, text: string, placeholders: readonly string[],
  expiresAt: Date): Promise<{ outcome: "updated"; version: number } | { outcome: "conflict"; status: ReplyStatus; version: number } | { outcome: "not_found" }> {
  const fn = "editReplyDraft";
  const pid = requirePrincipal(fn, principal);
  const draftId = validDraftId(fn, id);
  const version = validVersion(fn, expectedVersion, "expectedVersion");
  const stored = storedText(fn, text);
  const ph = placeholderList(fn, placeholders);
  const expires = validExpiry(fn, expiresAt);
  const { data, error } = await rpc(RPC_EDIT, {
    p_principal: pid, p_id: draftId, p_expected_version: version, p_text: stored, p_placeholders: ph, p_expires_at: expires
  });
  if (error) {
    if (missing(error)) return { outcome: "not_found" };
    throw failure(fn, error);
  }
  const r = objectOf(data);
  switch (r?.outcome) {
    case "updated": {
      const v = int(r.version);
      if (v === null) throw malformed(fn);
      return { outcome: "updated", version: v };
    }
    case "conflict": {
      const status = oneOf(r.status, STATUSES);
      const v = int(r.version);
      if (status === null || v === null) throw malformed(fn);
      return { outcome: "conflict", status, version: v };
    }
    case "not_found":
      return { outcome: "not_found" };
    default:
      throw malformed(fn);
  }
}

/** Fail closed: no row (or no schema) reads as not found, finance, external, not live. */
const NO_TARGET: ReplyTargetFacts = Object.freeze({
  found: false, readingLive: false, channelOk: false, finance: true, external: true, message: false, deleted: false, editedTs: null,
  respondedAt: null, itemUrgency: null
});

/** RPC 17: the send-time facts in one read (C48, §3.5.8 step 6). */
export async function replyTargetFacts(principal: ExecPrincipal, id: string, opts?: { signal?: AbortSignal }): Promise<ReplyTargetFacts> {
  const fn = "replyTargetFacts";
  const pid = requirePrincipal(fn, principal);
  if (typeof id !== "string" || !DRAFT_ID.test(id)) return { ...NO_TARGET };
  const signal = opts?.signal;
  const { data, error } = await rpc(RPC_TARGET, { p_principal: pid, p_id: id }, signal);
  if (error) {
    if (missing(error)) {
      signal?.throwIfAborted();
      return { ...NO_TARGET };
    }
    throw failure(fn, error, signal);
  }
  const r = objectOf(data);
  if (r === null || typeof r.found !== "boolean") throw malformed(fn);
  if (!r.found) return { ...NO_TARGET };
  const bool = (k: string, fallback: boolean): boolean => (typeof r[k] === "boolean" ? (r[k] as boolean) : fallback);
  const editedTs = r.edited_ts === null || r.edited_ts === undefined ? null : typeof r.edited_ts === "string" && TS.test(r.edited_ts) ? r.edited_ts : null;
  return {
    found: true,
    readingLive: bool("reading_live", false),
    channelOk: bool("channel_ok", false),
    finance: bool("finance", true),
    external: bool("external", true),
    message: bool("message", false),
    deleted: bool("deleted", true),
    editedTs,
    respondedAt: iso(r.responded_at),
    itemUrgency: oneOf(r.item_urgency, URGENCIES)
  };
}

/** RPC 18: blank every draft that rests on deleted messages (channel + ts) or opted-out authors; returns the ids it changed.
 *  v1.1 correctness-6: `before` = the purge-log row's created_at (drafts created later are left alone). Missing schema → []. */
export async function blankReplyDrafts(principal: ExecPrincipal, q: { channelId: string | null; ts: readonly string[] | null;
  authors: readonly string[] | null; reason: "deleted" | "author_optout" | "conversation" | "reading";
  before: string | null /* v1.1 correctness-6: RPC 18's p_before */ }): Promise<string[]> {
  const fn = "blankReplyDrafts";
  const pid = requirePrincipal(fn, principal);
  if (!q || typeof q !== "object") throw bad(fn, "q is required");
  const channel = q.channelId === null ? null : validChannel(fn, q.channelId);
  const ts = q.ts === null ? null : stringList(fn, q.ts, TS, 200, "ts");
  const authors = q.authors === null ? null : stringList(fn, q.authors, SLACK_USER, 200, "authors");
  const reason = oneOf(q.reason, BLANK_REASONS);
  if (reason === null) throw bad(fn, "reason is not a blank reason");
  if (channel === null && authors === null) throw bad(fn, "a channel or authors are required");
  const before = q.before === null ? null : validIso(fn, q.before, "before");
  const { data, error } = await rpc(RPC_BLANK, { p_principal: pid, p_channel: channel, p_ts: ts, p_authors: authors, p_reason: reason, p_before: before });
  if (error) {
    if (missing(error)) return [];
    throw failure(fn, error);
  }
  if (!Array.isArray(data) || !data.every((x) => typeof x === "string" && DRAFT_ID.test(x))) throw malformed(fn);
  return data as string[];
}

/** RPC 19 (C44), principal-agnostic: open drafts idle past expires_at → expired; content 7 days after the end (unknown: after
 *  sending_at); rows 30 days after; cards and the voice profile at their expires_at. Called again (≤ 10 rounds) while a step
 *  fills its 1,000-row batch. Missing schema → zeros. */
export async function purgeExpiredReplies(now: Date, opts?: { signal?: AbortSignal }): Promise<Record<string, number>> {
  const fn = "purgeExpiredReplies";
  const at = validDate(fn, now, "now");
  const signal = opts?.signal;
  const total: Record<string, number> = { expired: 0, contentPurged: 0, deleted: 0, cards: 0, voice: 0 };
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
    const r = objectOf(data);
    const step: Record<string, number> = {};
    for (const k of Object.keys(total)) {
      const v = int(r?.[k]);
      if (v === null || v < 0) throw malformed(fn);
      step[k] = v;
      total[k] += v;
    }
    if (step.expired < PURGE_BATCH && step.contentPurged < PURGE_BATCH && step.deleted < PURGE_BATCH) break;
  }
  return total;
}

// ---------------------------------------------------------------------------
// §2.1.16: the plain-row CAS transitions
// ---------------------------------------------------------------------------

export type ReplyTransition =
  | { t: "discard"; version: number }
  | { t: "claim"; version: number; sendingAt: string; auditId: number; textSha256: string; wordsSha256: string | null }
  | { t: "sent"; auditId: number; sentAt: string; postedTs: string } | { t: "clear"; auditId: number; version: number; reason: string }
  | { t: "clear_removed"; auditId: number; reason: string }                        // v1.1 X4b (correctness-5)
  | { t: "ambiguous"; auditId: number; reason: string } | { t: "stale"; before: string } | { t: "verified"; checks: number; sentAt: string; postedTs: string }
  | { t: "miss"; checks: number } | { t: "owner_posted"; at: string } | { t: "owner_not_posted"; at: string } | { t: "permalink"; url: string }
  | { t: "stale_generating"; seq: number; before: string | null }                 // v1.1 X12 (correctness-1); before null = no age fence
  | { t: "late_verified"; sentAt: string; postedTs: string };                     // v1.1 X13 (security-7)

type Filter = (q: UpdateQuery) => UpdateQuery;
interface UpdateQuery {
  eq(column: string, value: unknown): UpdateQuery;
  in(column: string, values: readonly unknown[]): UpdateQuery;
  is(column: string, value: null | boolean): UpdateQuery;
  not(column: string, operator: string, value: unknown): UpdateQuery;
  lt(column: string, value: unknown): UpdateQuery;
  gte(column: string, value: unknown): UpdateQuery;
  select(columns: string): PromiseLike<Result>;
}

function validAuditId(fn: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw bad(fn, "auditId must be a positive integer");
  return v;
}
function validChecks(fn: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 3) throw bad(fn, "checks must be an integer 0..3");
  return v;
}
function validCode(fn: string, v: unknown, what: string): string {
  if (typeof v !== "string" || !CODE.test(v)) throw bad(fn, `${what} must be a snake_case code`);
  return v;
}

/** One fenced update; true when a row moved. */
async function cas(fn: string, pid: string, id: string, from: readonly ReplyStatus[], patch: Row, fence: Filter): Promise<boolean> {
  let q = db().from(DRAFTS).update(patch).eq("id", id).eq("principal_id", pid) as unknown as UpdateQuery;
  q = from.length === 1 ? q.eq("status", from[0]) : q.in("status", from);
  const { data, error } = await fence(q).select("id");
  if (error) {
    if (missing(error)) return false;
    throw failure(fn, error);
  }
  return Array.isArray(data) && data.length > 0;
}

/** §2.1.16 X1–X13: one CAS update each; true when a row moved. */
export async function stepReplyDraft(principal: ExecPrincipal, id: string, step: ReplyTransition, now: Date): Promise<boolean> {
  const fn = "stepReplyDraft";
  const pid = requirePrincipal(fn, principal);
  const draftId = validDraftId(fn, id);
  const at = validDate(fn, now, "now");
  const nowIso = at.toISOString();
  const none: Filter = (q) => q;
  const purged = { text: null, instruction: null, note: null, placeholders: [] as string[] };
  if (!step || typeof step !== "object") throw bad(fn, "step is required");
  switch (step.t) {
    case "discard": {                                                    // X1
      const v = validVersion(fn, step.version);
      return cas(fn, pid, draftId, ["draft", "generation_failed"], {
        status: "discarded", status_reason: "owner", terminal_at: nowIso, ...purged, content_purged_at: nowIso, expires_at: plus(at, 30), updated_at: nowIso
      }, (q) => q.eq("version", v));
    }
    case "claim": {                                                      // X2
      const v = validVersion(fn, step.version);
      const sendingAt = validIso(fn, step.sendingAt, "sendingAt");
      const auditId = validAuditId(fn, step.auditId);
      if (typeof step.textSha256 !== "string" || !SHA256.test(step.textSha256)) throw bad(fn, "textSha256 must be 64 hex");
      if (step.wordsSha256 !== null && (typeof step.wordsSha256 !== "string" || !SHA256.test(step.wordsSha256))) throw bad(fn, "wordsSha256 must be 64 hex or null");
      return cas(fn, pid, draftId, ["draft"], {
        status: "sending", sending_at: sendingAt, audit_id: auditId, sent_text_sha256: step.textSha256, sent_words_sha256: step.wordsSha256, updated_at: nowIso
      }, (q) => q.eq("version", v));
    }
    case "sent": {                                                       // X3
      const auditId = validAuditId(fn, step.auditId);
      const sentAt = validIso(fn, step.sentAt, "sentAt");
      const postedTs = validTs(fn, step.postedTs, "postedTs");
      return cas(fn, pid, draftId, ["sending"], {
        status: "sent", sent_at: sentAt, posted_ts: postedTs, terminal_at: nowIso, expires_at: plus(at, 30), updated_at: nowIso
      }, (q) => q.eq("audit_id", auditId));
    }
    case "clear": {                                                      // X4: version = the claimed (fenced) version + 1
      const auditId = validAuditId(fn, step.auditId);
      const v = validVersion(fn, step.version);
      if (v >= 9999) throw bad(fn, "version must be below 9999");
      const reason = validCode(fn, step.reason, "reason");
      return cas(fn, pid, draftId, ["sending"], {
        status: "draft", status_reason: reason, version: v + 1, sending_at: null, audit_id: null, sent_text_sha256: null, sent_words_sha256: null,
        expires_at: plus(at, P10_LIMITS.replyIdleDays), updated_at: nowIso
      }, (q) => q.eq("audit_id", auditId).eq("version", v).is("content_purged_at", null));
    }
    case "clear_removed": {                                              // X4b
      const auditId = validAuditId(fn, step.auditId);
      const reason = validCode(fn, step.reason, "reason");
      return cas(fn, pid, draftId, ["sending"], {
        status: "removed", status_reason: reason, terminal_at: nowIso, expires_at: plus(at, 30), updated_at: nowIso
      }, (q) => q.eq("audit_id", auditId).not("content_purged_at", "is", null));
    }
    case "ambiguous": {                                                  // X5
      const auditId = validAuditId(fn, step.auditId);
      const reason = validCode(fn, step.reason, "reason");
      return cas(fn, pid, draftId, ["sending"], { status: "unknown", status_reason: reason, updated_at: nowIso }, (q) => q.eq("audit_id", auditId));
    }
    case "stale": {                                                      // X6
      const before = validIso(fn, step.before, "before");
      return cas(fn, pid, draftId, ["sending"], { status: "unknown", status_reason: "stale_sending", updated_at: nowIso }, (q) => q.lt("sending_at", before));
    }
    case "verified": {                                                   // X7
      const checks = validChecks(fn, step.checks);
      const sentAt = validIso(fn, step.sentAt, "sentAt");
      const postedTs = validTs(fn, step.postedTs, "postedTs");
      return cas(fn, pid, draftId, ["unknown"], {
        status: "sent", sent_at: sentAt, posted_ts: postedTs, terminal_at: nowIso, expires_at: plus(at, 30), verify_checks: Math.min(checks + 1, 3),
        updated_at: nowIso
      }, (q) => q.eq("verify_checks", checks));
    }
    case "miss": {                                                       // X8
      const checks = validChecks(fn, step.checks);
      if (checks >= 3) return false;
      return cas(fn, pid, draftId, ["unknown"], { verify_checks: checks + 1, updated_at: nowIso }, (q) => q.eq("verify_checks", checks));
    }
    case "owner_posted": {                                               // X9
      const atIso = validIso(fn, step.at, "at");
      return cas(fn, pid, draftId, ["unknown"], {
        status: "sent", owner_resolution: "posted", sent_at: atIso, terminal_at: atIso, expires_at: plus(new Date(atIso), 30), updated_at: nowIso
      }, none);
    }
    case "owner_not_posted": {                                           // X10: only after the third read-only check
      const atIso = validIso(fn, step.at, "at");
      return cas(fn, pid, draftId, ["unknown"], {
        status: "failed", owner_resolution: "not_posted", terminal_at: atIso, expires_at: plus(new Date(atIso), 30), updated_at: nowIso
      }, (q) => q.eq("verify_checks", 3));
    }
    case "permalink": {                                                  // X11
      if (typeof step.url !== "string" || step.url.length > 500 || !PERMALINK.test(step.url)) throw bad(fn, "url must be a Slack message permalink");
      return cas(fn, pid, draftId, ["sent"], { posted_permalink: step.url, updated_at: nowIso }, (q) => q.is("posted_permalink", null));
    }
    case "stale_generating": {                                           // X12: two fenced updates, the rewrite first
      if (typeof step.seq !== "number" || !Number.isSafeInteger(step.seq) || step.seq < 1 || step.seq > 1000) throw bad(fn, "seq must be an integer 1..1000");
      const seq = step.seq;
      const before = step.before === null ? null : validIso(fn, step.before, "before");
      const fenced: Filter = (q) => {
        const s = q.eq("generation_seq", seq);
        return before === null ? s : s.lt("updated_at", before);
      };
      if (await cas(fn, pid, draftId, ["generating"], { status: "draft", status_reason: "timeout", updated_at: nowIso },
        (q) => fenced(q).gte("version", 1).not("text", "is", null))) {
        return true;
      }
      return cas(fn, pid, draftId, ["generating"], { status: "generation_failed", generation_error: "timeout", updated_at: nowIso }, fenced);
    }
    case "late_verified": {                                              // X13
      const sentAt = validIso(fn, step.sentAt, "sentAt");
      const postedTs = validTs(fn, step.postedTs, "postedTs");
      return cas(fn, pid, draftId, ["failed"], {
        status: "sent", owner_resolution: null, sent_at: sentAt, posted_ts: postedTs, expires_at: plus(at, 30), updated_at: nowIso
      }, (q) => q.eq("owner_resolution", "not_posted"));
    }
    default:
      throw bad(fn, "unknown transition");
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** v1.1 correctness-1: generating rows whose updated_at is before `before`, oldest first, ≤ 50 (the sweep's X12 pass). */
export async function listStaleGenerating(principal: ExecPrincipal, before: string): Promise<{ id: string; generationSeq: number }[]> {
  const fn = "listStaleGenerating";
  const pid = requirePrincipal(fn, principal);
  const b = validIso(fn, before, "before");
  const rows = await readRows(fn, db().from(DRAFTS).select("id,generation_seq").eq("principal_id", pid).eq("status", "generating").lt("updated_at", b)
    .order("updated_at", { ascending: true }).limit(LIST_MAX) as unknown as PromiseLike<Result>);
  const out: { id: string; generationSeq: number }[] = [];
  for (const r of rows ?? []) {
    const id = str(r.id);
    const seq = int(r.generation_seq);
    if (id === null || !DRAFT_ID.test(id) || seq === null) throw malformed(fn);
    out.push({ id, generationSeq: seq });
  }
  return out;
}

/** v1.1 product-21: automatic drafts still `draft`, created since sinceIso, with no card row, oldest first, ≤ limit (held cards). */
export async function listHeldAutoCards(principal: ExecPrincipal, sinceIso: string, limit: number): Promise<{ id: string }[]> {
  const fn = "listHeldAutoCards";
  const pid = requirePrincipal(fn, principal);
  const since = validIso(fn, sinceIso, "sinceIso");
  const n = typeof limit === "number" && Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), LIST_MAX) : 10;
  const drafts = await readRows(fn, db().from(DRAFTS).select("id").eq("principal_id", pid).eq("origin", "auto").eq("status", "draft")
    .gte("created_at", since).order("created_at", { ascending: true }).order("id", { ascending: true }).limit(CARD_SCAN) as unknown as PromiseLike<Result>);
  const ids = (drafts ?? []).map((r) => str(r.id)).filter((x): x is string => x !== null && DRAFT_ID.test(x));
  if (ids.length === 0) return [];
  const carded = new Set<string>();
  for (const part of chunks(ids, IN_CHUNK)) {
    const cards = await readRows(fn, db().from(CARDS).select("draft_id").eq("principal_id", pid).in("draft_id", part) as unknown as PromiseLike<Result>);
    for (const c of cards ?? []) {
      const d = str(c.draft_id);
      if (d) carded.add(d);
    }
  }
  return ids.filter((id) => !carded.has(id)).slice(0, n).map((id) => ({ id }));
}

export async function getReplyDraft(principal: ExecPrincipal, id: string, opts?: { signal?: AbortSignal }): Promise<ReplyDraftRow | null> {
  const fn = "getReplyDraft";
  const pid = requirePrincipal(fn, principal);
  if (typeof id !== "string" || !DRAFT_ID.test(id)) return null;
  const signal = opts?.signal;
  const rows = await readRows(fn, withSignal(db().from(DRAFTS).select(DRAFT_COLS).eq("principal_id", pid).eq("id", id).limit(1), signal) as unknown as PromiseLike<Result>, signal);
  return rows && rows.length > 0 ? toReplyRow(rows[0], fn) : null;
}

/** The newest draft per message (active first), for badges: key "<channel>:<ts>". */
export async function listReplyDraftsForMessages(principal: ExecPrincipal, keys: readonly { channelId: string; ts: string }[],
  opts?: { signal?: AbortSignal }): Promise<Map<string, { id: string; status: ReplyStatus; sentAt: string | null }>> {
  const fn = "listReplyDraftsForMessages";
  const pid = requirePrincipal(fn, principal);
  if (!Array.isArray(keys)) throw bad(fn, "keys must be an array");
  const signal = opts?.signal;
  const wanted = new Map<string, Set<string>>();
  for (const k of keys) {
    if (!k || typeof k.channelId !== "string" || !CHANNEL.test(k.channelId) || typeof k.ts !== "string" || !TS.test(k.ts)) continue;
    const set = wanted.get(k.channelId) ?? new Set<string>();
    set.add(k.ts);
    wanted.set(k.channelId, set);
  }
  const best = new Map<string, { id: string; status: ReplyStatus; sentAt: string | null; active: boolean; createdAt: number }>();
  for (const [channel, tsSet] of wanted) {
    for (const part of chunks([...tsSet], IN_CHUNK)) {
      const rows = await readRows(fn, withSignal(db().from(DRAFTS).select("id,channel_id,source_ts,status,sent_at,created_at").eq("principal_id", pid)
        .eq("channel_id", channel).in("source_ts", part), signal) as unknown as PromiseLike<Result>, signal);
      if (rows === null) return new Map();
      for (const r of rows) {
        const id = str(r.id);
        const ts = str(r.source_ts);
        const status = oneOf(r.status, STATUSES);
        const createdAt = iso(r.created_at);
        if (id === null || ts === null || status === null || createdAt === null) throw malformed(fn);
        const key = `${channel}:${ts}`;
        const cand = { id, status, sentAt: iso(r.sent_at), active: (REPLY_ACTIVE_STATUSES as readonly string[]).includes(status), createdAt: Date.parse(createdAt) };
        const cur = best.get(key);
        if (!cur || (cand.active && !cur.active) || (cand.active === cur.active && cand.createdAt > cur.createdAt)) best.set(key, cand);
      }
    }
  }
  const out = new Map<string, { id: string; status: ReplyStatus; sentAt: string | null }>();
  for (const [key, v] of best) out.set(key, { id: v.id, status: v.status, sentAt: v.sentAt });
  return out;
}

/** Any status (the planner never drafts a message twice). Missing schema → false. */
export async function hasAnyReplyDraft(principal: ExecPrincipal, channelId: string, ts: string): Promise<boolean> {
  const fn = "hasAnyReplyDraft";
  const pid = requirePrincipal(fn, principal);
  const channel = validChannel(fn, channelId);
  const t = validTs(fn, ts, "ts");
  const rows = await readRows(fn, db().from(DRAFTS).select("id").eq("principal_id", pid).eq("channel_id", channel).eq("source_ts", t).limit(1) as unknown as PromiseLike<Result>);
  return (rows ?? []).length > 0;
}

async function countOf(fn: string, q: PromiseLike<Result>): Promise<number> {
  const { count, error } = await q;
  if (error) {
    if (missing(error)) return 0;
    throw failure(fn, error);
  }
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

/** The System card and the caps (C30, C31, C58): automatic drafts and cards since sinceIso, replies sent since then, drafts open
 *  now and drafts unknown now. Missing schema → zeros. */
export async function countRepliesToday(principal: ExecPrincipal, sinceIso: string): Promise<{ autoDrafts: number; autoCards: number; sent: number; open: number; unknown: number }> {
  const fn = "countRepliesToday";
  const pid = requirePrincipal(fn, principal);
  const since = validIso(fn, sinceIso, "sinceIso");
  const head = (t: string) => db().from(t).select("principal_id", { count: "exact", head: true }).eq("principal_id", pid);
  const [autoDrafts, autoCards, sent, open, unknown] = await Promise.all([
    countOf(fn, head(DRAFTS).eq("origin", "auto").gte("created_at", since) as unknown as PromiseLike<Result>),
    countOf(fn, head(CARDS).eq("origin", "auto").gte("posted_at", since) as unknown as PromiseLike<Result>),
    countOf(fn, head(DRAFTS).eq("status", "sent").gte("sent_at", since) as unknown as PromiseLike<Result>),
    countOf(fn, head(DRAFTS).in("status", OPEN_STATUSES as ReplyStatus[]) as unknown as PromiseLike<Result>),
    countOf(fn, head(DRAFTS).eq("status", "unknown") as unknown as PromiseLike<Result>)
  ]);
  return { autoDrafts, autoCards, sent, open, unknown };
}

/** Rows still `sending` since before `before` (X6's candidates), oldest first, ≤ 50. */
export async function listStaleSending(principal: ExecPrincipal, before: string): Promise<{ id: string }[]> {
  const fn = "listStaleSending";
  const pid = requirePrincipal(fn, principal);
  const b = validIso(fn, before, "before");
  const rows = await readRows(fn, db().from(DRAFTS).select("id").eq("principal_id", pid).eq("status", "sending").lt("sending_at", b)
    .order("sending_at", { ascending: true }).limit(LIST_MAX) as unknown as PromiseLike<Result>);
  return (rows ?? []).map((r) => str(r.id)).filter((x): x is string => x !== null && DRAFT_ID.test(x)).map((id) => ({ id }));
}

/** C37: `unknown` rows whose next read-only check is due (sending_at + delaysMs[verify_checks] ≤ now, verify_checks < the number of
 *  delays), oldest first, ≤ 50. */
export async function listUnknownDue(principal: ExecPrincipal, now: Date, delaysMs: readonly number[]): Promise<ReplyDraftRow[]> {
  const fn = "listUnknownDue";
  const pid = requirePrincipal(fn, principal);
  const at = validDate(fn, now, "now");
  if (!Array.isArray(delaysMs) || delaysMs.length === 0 || delaysMs.length > 3
      || !delaysMs.every((d, i) => typeof d === "number" && Number.isSafeInteger(d) && d >= 0 && (i === 0 || d >= delaysMs[i - 1]))) {
    throw bad(fn, "delaysMs must be 1..3 ascending non-negative integers");
  }
  const earliest = new Date(at.getTime() - delaysMs[0]).toISOString();
  const rows = await readRows(fn, db().from(DRAFTS).select(DRAFT_COLS).eq("principal_id", pid).eq("status", "unknown").lt("verify_checks", delaysMs.length)
    .lte("sending_at", earliest).order("sending_at", { ascending: true }).limit(LIST_MAX) as unknown as PromiseLike<Result>);
  const out: ReplyDraftRow[] = [];
  for (const r of rows ?? []) {
    const row = toReplyRow(r, fn);
    if (row.sendingAt === null) continue;
    const delay = delaysMs[row.verifyChecks];
    if (delay !== undefined && Date.parse(row.sendingAt) + delay <= at.getTime()) out.push(row);
  }
  return out;
}

/** "<channel>:<posted_ts>" of his replies sent since sinceIso in these channels (the voice sampler leaves them out, C25). */
export async function listSentPostedKeys(principal: ExecPrincipal, channelIds: readonly string[], sinceIso: string): Promise<Set<string>> {
  const fn = "listSentPostedKeys";
  const pid = requirePrincipal(fn, principal);
  if (!Array.isArray(channelIds)) throw bad(fn, "channelIds must be an array");
  const since = validIso(fn, sinceIso, "sinceIso");
  const channels = [...new Set(channelIds.filter((c): c is string => typeof c === "string" && CHANNEL.test(c)))];
  const out = new Set<string>();
  for (const part of chunks(channels, IN_CHUNK)) {
    const rows = await readRows(fn, db().from(DRAFTS).select("channel_id,posted_ts").eq("principal_id", pid).eq("status", "sent")
      .not("posted_ts", "is", null).gte("sent_at", since).in("channel_id", part).limit(5000) as unknown as PromiseLike<Result>);
    if (rows === null) return new Set();
    for (const r of rows) {
      const c = str(r.channel_id);
      const p = str(r.posted_ts);
      if (c && p && TS.test(p)) out.add(`${c}:${p}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cards (C31)
// ---------------------------------------------------------------------------

export async function recordReplyCard(principal: ExecPrincipal, card: { installationId: string; dmChannelId: string; dmTs: string;
  threadTs: string | null; draftId: string; origin: "slack" | "auto"; version: number; state: ReplyCardState; expiresAt: Date }): Promise<void> {
  const fn = "recordReplyCard";
  const pid = requirePrincipal(fn, principal);
  if (!card || typeof card !== "object") throw bad(fn, "card is required");
  const installationId = validInstallation(fn, card.installationId);
  if (typeof card.dmChannelId !== "string" || !DM_CHANNEL.test(card.dmChannelId)) throw bad(fn, "dmChannelId must be a D… channel id");
  const dmTs = validTs(fn, card.dmTs, "dmTs");
  const threadTs = card.threadTs === null ? null : validTs(fn, card.threadTs, "threadTs");
  const draftId = validDraftId(fn, card.draftId);
  const origin = oneOf(card.origin, ["slack", "auto"] as const);
  if (origin === null) throw bad(fn, "origin must be slack or auto");
  const version = validVersion(fn, card.version);
  const state = oneOf(card.state, CARD_STATES);
  if (state === null) throw bad(fn, "state is not a card state");
  const expires = validDate(fn, card.expiresAt, "expiresAt");
  if (expires.getTime() <= Date.now()) throw bad(fn, "expiresAt must be in the future");
  const row: Row = {
    installation_id: installationId, principal_id: pid, dm_channel_id: card.dmChannelId, dm_ts: dmTs, thread_ts: threadTs, draft_id: draftId, origin,
    rendered_version: version, rendered_state: state, expires_at: expires.toISOString()
  };
  if (Object.keys(row).join() !== CARD_KEYS.join()) throw new Error("recordReplyCard: key set");
  const { error } = (await db().from(CARDS).upsert(row, { onConflict: "installation_id,dm_ts" })) as Result;
  if (error) throw failure(fn, error);
}

export async function listReplyCards(principal: ExecPrincipal, draftId: string): Promise<{ installationId: string; dmChannelId: string; dmTs: string;
  renderedVersion: number; renderedState: ReplyCardState }[]> {
  const fn = "listReplyCards";
  const pid = requirePrincipal(fn, principal);
  if (typeof draftId !== "string" || !DRAFT_ID.test(draftId)) return [];
  const rows = await readRows(fn, db().from(CARDS).select("installation_id,dm_channel_id,dm_ts,rendered_version,rendered_state").eq("principal_id", pid)
    .eq("draft_id", draftId).order("posted_at", { ascending: true }) as unknown as PromiseLike<Result>);
  return (rows ?? []).map((r) => {
    const installationId = str(r.installation_id);
    const dmChannelId = str(r.dm_channel_id);
    const dmTs = str(r.dm_ts);
    const renderedVersion = int(r.rendered_version);
    const renderedState = oneOf(r.rendered_state, CARD_STATES);
    if (installationId === null || dmChannelId === null || dmTs === null || renderedVersion === null || renderedState === null) throw malformed(fn);
    return { installationId, dmChannelId, dmTs, renderedVersion, renderedState };
  });
}

/** By the DM message a click came from (principal-free: the act handler resolves the card first). */
export async function getReplyCard(installationId: string, dmTs: string): Promise<{ principalId: string; draftId: string; dmChannelId: string;
  renderedVersion: number; renderedState: ReplyCardState } | null> {
  const fn = "getReplyCard";
  if (typeof installationId !== "string" || !INSTALLATION.test(installationId) || typeof dmTs !== "string" || !TS.test(dmTs)) return null;
  const rows = await readRows(fn, db().from(CARDS).select("principal_id,draft_id,dm_channel_id,rendered_version,rendered_state")
    .eq("installation_id", installationId).eq("dm_ts", dmTs).limit(1) as unknown as PromiseLike<Result>);
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  const principalId = str(r.principal_id);
  const draftId = str(r.draft_id);
  const dmChannelId = str(r.dm_channel_id);
  const renderedVersion = int(r.rendered_version);
  const renderedState = oneOf(r.rendered_state, CARD_STATES);
  if (principalId === null || draftId === null || dmChannelId === null || renderedVersion === null || renderedState === null) throw malformed(fn);
  return { principalId, draftId, dmChannelId, renderedVersion, renderedState };
}

/** After a re-render: the card now shows `version` in `state`. followed_at records when (listStaleReplyCards compares it with
 *  the draft's content_purged_at, so a card re-rendered after a purge is no longer stale). */
export async function markReplyCard(installationId: string, dmTs: string, version: number, state: ReplyCardState): Promise<void> {
  const fn = "markReplyCard";
  const inst = validInstallation(fn, installationId);
  const ts = validTs(fn, dmTs, "dmTs");
  const v = validVersion(fn, version);
  const s = oneOf(state, CARD_STATES);
  if (s === null) throw bad(fn, "state is not a card state");
  const { error } = (await db().from(CARDS).update({ rendered_version: v, rendered_state: s, followed_at: new Date().toISOString() })
    .eq("installation_id", inst).eq("dm_ts", ts)) as Result;
  if (error && !missing(error)) throw failure(fn, error);
}

type CardRow = { installationId: string; dmChannelId: string; dmTs: string; draftId: string; renderedVersion: number; renderedState: ReplyCardState;
  followedAt: string | null };

async function cardsOf(fn: string, pid: string, onlyOpen: boolean): Promise<CardRow[]> {
  let q = db().from(CARDS).select("installation_id,dm_channel_id,dm_ts,draft_id,rendered_version,rendered_state,followed_at").eq("principal_id", pid);
  q = onlyOpen ? q.not("rendered_state", "in", `(${CLOSED_CARD_STATES.join(",")})`) : q.not("rendered_state", "in", "(removed,off)");
  const rows = await readRows(fn, q.order("posted_at", { ascending: true }).limit(CARD_SCAN) as unknown as PromiseLike<Result>);
  return (rows ?? []).map((r) => {
    const installationId = str(r.installation_id);
    const dmChannelId = str(r.dm_channel_id);
    const dmTs = str(r.dm_ts);
    const draftId = str(r.draft_id);
    const renderedVersion = int(r.rendered_version);
    const renderedState = oneOf(r.rendered_state, CARD_STATES);
    if (installationId === null || dmChannelId === null || dmTs === null || draftId === null || renderedVersion === null || renderedState === null) {
      throw malformed(fn);
    }
    return { installationId, dmChannelId, dmTs, draftId, renderedVersion, renderedState, followedAt: iso(r.followed_at) };
  });
}

async function draftsByIds(fn: string, pid: string, ids: readonly string[]): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  for (const part of chunks([...new Set(ids)].filter((x) => DRAFT_ID.test(x)), IN_CHUNK)) {
    const rows = await readRows(fn, db().from(DRAFTS).select("id,status,version,content_purged_at").eq("principal_id", pid).in("id", part) as unknown as PromiseLike<Result>);
    for (const r of rows ?? []) {
      const id = str(r.id);
      if (id) out.set(id, r);
    }
  }
  return out;
}

/** Open cards whose draft row no longer exists (cascaded away), ≤ limit. */
export async function listOrphanReplyCards(principal: ExecPrincipal, limit: number): Promise<{ installationId: string; dmChannelId: string; dmTs: string }[]> {
  const fn = "listOrphanReplyCards";
  const pid = requirePrincipal(fn, principal);
  const n = typeof limit === "number" && Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), CARD_SCAN) : LIST_MAX;
  const cards = await cardsOf(fn, pid, true);
  if (cards.length === 0) return [];
  const drafts = await draftsByIds(fn, pid, cards.map((c) => c.draftId));
  return cards.filter((c) => !drafts.has(c.draftId)).slice(0, n).map((c) => ({ installationId: c.installationId, dmChannelId: c.dmChannelId, dmTs: c.dmTs }));
}

/** The card state a draft's status implies, for the statuses where only one state fits (a `draft` may show live, dd_only or off). */
const EXPECTED_CARD_STATE: Partial<Record<ReplyStatus, ReplyCardState>> = {
  generating: "generating", generation_failed: "failed_generation", sending: "sending", sent: "sent", unknown: "unknown", failed: "failed",
  discarded: "discarded", expired: "expired", removed: "removed"
};

/** Cards whose rendered version or state no longer matches their draft (the system purge expired it, its content was purged,
 *  another process moved it), ≤ limit; the sweep re-renders them so no Slack card keeps text DD has dropped. A card in its final
 *  `removed` or `off` form is never listed; a card whose draft is gone is listOrphanReplyCards'. */
export async function listStaleReplyCards(principal: ExecPrincipal, limit: number): Promise<{ draftId: string }[]> {
  const fn = "listStaleReplyCards";
  const pid = requirePrincipal(fn, principal);
  const n = typeof limit === "number" && Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), CARD_SCAN) : LIST_MAX;
  const cards = await cardsOf(fn, pid, false);
  if (cards.length === 0) return [];
  const drafts = await draftsByIds(fn, pid, cards.map((c) => c.draftId));
  const out: string[] = [];
  for (const c of cards) {
    const d = drafts.get(c.draftId);
    if (!d || out.includes(c.draftId)) continue;
    const status = oneOf(d.status, STATUSES);
    const version = int(d.version);
    if (status === null || version === null) throw malformed(fn);
    const expected = EXPECTED_CARD_STATE[status];
    const stateOk = expected === undefined ? ["live", "dd_only"].includes(c.renderedState) : c.renderedState === expected;
    const purgedAt = iso(d.content_purged_at);
    const purgeShown = purgedAt === null || (c.followedAt !== null && Date.parse(c.followedAt) >= Date.parse(purgedAt));
    if (c.renderedVersion !== version || !stateOk || !purgeShown) out.push(c.draftId);
    if (out.length >= n) break;
  }
  return out.map((draftId) => ({ draftId }));
}

/** P10 fixer security-1 (H9, §3.5.9 step 6): every card not yet in its final `removed` or `off` form, by draft, with the states
 *  its cards show (oldest card first, ≤ CARD_SCAN cards). The sweep checks each such draft's conversation again (RPC 17), so a
 *  card whose conversation turned finance-class, or a live card that can no longer send, is re-rendered. */
export async function listReplyCardStates(principal: ExecPrincipal): Promise<{ draftId: string; states: ReplyCardState[] }[]> {
  const fn = "listReplyCardStates";
  const pid = requirePrincipal(fn, principal);
  const cards = await cardsOf(fn, pid, false);
  const byDraft = new Map<string, Set<ReplyCardState>>();
  for (const c of cards) {
    const set = byDraft.get(c.draftId) ?? new Set<ReplyCardState>();
    set.add(c.renderedState);
    byDraft.set(c.draftId, set);
  }
  return [...byDraft].map(([draftId, states]) => ({ draftId, states: [...states] }));
}

/** The system purge (H7): the card rows of installations that are no longer active (revoked; P6 keeps their rows as the record).
 *  Returns how many card rows went. Missing schema → 0. The cards' distinct installation ids are walked one row at a time (an
 *  installation with many cards never hides another one's), and a full list of active installations (the cap) can't prove any
 *  other one inactive, so that day nothing is deleted: never an active installation's cards. */
export async function deleteRevokedInstallationCards(): Promise<number> {
  const fn = "deleteRevokedInstallationCards";
  const ids: string[] = [];
  let after: string | null = null;
  while (ids.length < CARD_INSTALLATIONS_MAX) {
    let q = db().from(CARDS).select("installation_id");
    if (after !== null) q = q.gt("installation_id", after);
    const rows = await readRows(fn, q.order("installation_id", { ascending: true }).limit(1) as unknown as PromiseLike<Result>);
    const id = rows !== null && rows.length > 0 ? str(rows[0].installation_id) : null;
    if (id === null) break;
    ids.push(id);
    after = id;
  }
  if (ids.length === 0) return 0;
  const listed = await listActiveInstallationsForSystem(ACTIVE_INSTALLATIONS_MAX);
  if (listed.length >= ACTIVE_INSTALLATIONS_MAX) return 0;
  const active = new Set(listed.map((i) => i.id));
  const gone = ids.filter((id) => !active.has(id));
  let deleted = 0;
  for (const part of chunks(gone, IN_CHUNK)) {
    const { data, error } = (await db().from(CARDS).delete().in("installation_id", part).select("dm_ts")) as Result;
    if (error) {
      if (missing(error)) return deleted;
      throw failure(fn, error);
    }
    deleted += Array.isArray(data) ? data.length : 0;
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// The Slack voice profile (C25): one row per principal, enums and refs only
// ---------------------------------------------------------------------------

export async function getSlackVoiceProfile(principal: ExecPrincipal): Promise<SlackVoiceProfileRow | null> {
  const fn = "getSlackVoiceProfile";
  const pid = requirePrincipal(fn, principal);
  const rows = await readRows(fn, db().from(VOICE).select(VOICE_COLS).eq("principal_id", pid).limit(1) as unknown as PromiseLike<Result>);
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  const status = oneOf(r.status, ["ready", "insufficient", "failed"] as const);
  const sampleCount = int(r.sample_count);
  const promptVersion = str(r.prompt_version);
  const builtAt = iso(r.built_at);
  const expiresAt = iso(r.expires_at);
  const refs = Array.isArray(r.sample_refs) && r.sample_refs.every((x) => typeof x === "string") ? (r.sample_refs as string[]) : null;
  const channels = Array.isArray(r.sample_channels) && r.sample_channels.every((x) => typeof x === "string") ? (r.sample_channels as string[]) : null;
  if (status === null || sampleCount === null || promptVersion === null || builtAt === null || expiresAt === null || refs === null || channels === null) {
    throw malformed(fn);
  }
  return {
    status, formality: oneOf(r.formality, FORMALITY), typicalLength: oneOf(r.typical_length, LENGTH), capitalization: oneOf(r.capitalization, CAPS),
    punctuation: oneOf(r.punctuation, PUNCT), greeting: oneOf(r.greeting, GREETING), emoji: oneOf(r.emoji, EMOJI),
    abbreviations: oneOf(r.abbreviations, FREQUENCY), exclamations: oneOf(r.exclamations, FREQUENCY), bullets: oneOf(r.bullets, FREQUENCY),
    sampleCount, sampleRefs: refs, sampleChannels: channels, samplesHash: str(r.samples_hash), model: str(r.model), promptVersion,
    lastAttemptError: str(r.last_attempt_error), builtAt, expiresAt
  };
}

/** One upsert per principal with the identical key set; the table's CHECKs are checked here first (ready needs all nine enums,
 *  refs "<channel>:<ts>" ≤ 60, channels ≤ 10, expires_at within 31 days of built_at, v1.1 correctness-4). */
export async function putSlackVoiceProfile(principal: ExecPrincipal, row: SlackVoiceProfileRow): Promise<void> {
  const fn = "putSlackVoiceProfile";
  const pid = requirePrincipal(fn, principal);
  if (!row || typeof row !== "object") throw bad(fn, "row is required");
  const status = oneOf(row.status, ["ready", "insufficient", "failed"] as const);
  if (status === null) throw bad(fn, "status must be ready, insufficient or failed");
  const enumOrNull = <T extends string>(v: unknown, list: readonly T[], what: string): T | null => {
    if (v === null || v === undefined) return null;
    const out = oneOf(v, list);
    if (out === null) throw bad(fn, `${what} is not one of its enums`);
    return out;
  };
  const enums = {
    formality: enumOrNull(row.formality, FORMALITY, "formality"), typical_length: enumOrNull(row.typicalLength, LENGTH, "typicalLength"),
    capitalization: enumOrNull(row.capitalization, CAPS, "capitalization"), punctuation: enumOrNull(row.punctuation, PUNCT, "punctuation"),
    greeting: enumOrNull(row.greeting, GREETING, "greeting"), emoji: enumOrNull(row.emoji, EMOJI, "emoji"),
    abbreviations: enumOrNull(row.abbreviations, FREQUENCY, "abbreviations"), exclamations: enumOrNull(row.exclamations, FREQUENCY, "exclamations"),
    bullets: enumOrNull(row.bullets, FREQUENCY, "bullets")
  };
  if (status === "ready" && Object.values(enums).some((v) => v === null)) throw bad(fn, "a ready profile needs all nine enums");
  if (typeof row.sampleCount !== "number" || !Number.isSafeInteger(row.sampleCount) || row.sampleCount < 0 || row.sampleCount > P10_LIMITS.voiceSamplesMax) {
    throw bad(fn, `sampleCount must be an integer 0..${P10_LIMITS.voiceSamplesMax}`);
  }
  const refs = stringList(fn, row.sampleRefs, REF, P10_LIMITS.voiceSamplesMax, "sampleRefs");
  const channels = stringList(fn, row.sampleChannels, CHANNEL, P10_LIMITS.voiceConversations, "sampleChannels");
  if (row.samplesHash !== null && (typeof row.samplesHash !== "string" || !SHA256.test(row.samplesHash))) throw bad(fn, "samplesHash must be 64 hex or null");
  if (row.model !== null && (typeof row.model !== "string" || chars(row.model) < 1 || chars(row.model) > 64)) throw bad(fn, "model must be 1..64 characters or null");
  if (typeof row.promptVersion !== "string" || chars(row.promptVersion) < 1 || chars(row.promptVersion) > 40) throw bad(fn, "promptVersion must be 1..40 characters");
  const lastAttemptError = enumOrNull(row.lastAttemptError, VOICE_ERRORS, "lastAttemptError");
  const builtAt = validIso(fn, row.builtAt, "builtAt");
  const expiresAt = validIso(fn, row.expiresAt, "expiresAt");
  const span = Date.parse(expiresAt) - Date.parse(builtAt);
  if (span <= 0 || span > VOICE_TTL_MAX_MS) throw bad(fn, "expiresAt must be after builtAt and within 31 days of it");
  const payload: Row = {
    principal_id: pid, status, ...enums, sample_count: row.sampleCount, sample_refs: refs, sample_channels: channels, samples_hash: row.samplesHash,
    model: row.model, prompt_version: row.promptVersion, last_attempt_error: lastAttemptError, built_at: builtAt, expires_at: expiresAt,
    updated_at: new Date().toISOString()
  };
  const { error } = (await db().from(VOICE).upsert(payload, { onConflict: "principal_id" })) as Result;
  if (error) throw failure(fn, error);
}

/** true when a row was deleted. Missing schema → false. */
export async function deleteSlackVoiceProfile(principal: ExecPrincipal): Promise<boolean> {
  const fn = "deleteSlackVoiceProfile";
  const pid = requirePrincipal(fn, principal);
  const { data, error } = (await db().from(VOICE).delete().eq("principal_id", pid).select("principal_id")) as Result;
  if (error) {
    if (missing(error)) return false;
    throw failure(fn, error);
  }
  return Array.isArray(data) && data.length > 0;
}

/** true when the profile's sample_refs hold any of refs or its sample_channels hold channelId. */
export async function voiceProfileUses(principal: ExecPrincipal, q: { refs?: readonly string[]; channelId?: string }): Promise<boolean> {
  const fn = "voiceProfileUses";
  const pid = requirePrincipal(fn, principal);
  const refs = (q?.refs ?? []).filter((r): r is string => typeof r === "string" && REF.test(r));
  const channel = typeof q?.channelId === "string" && CHANNEL.test(q.channelId) ? q.channelId : null;
  if (refs.length === 0 && channel === null) return false;
  const rows = await readRows(fn, db().from(VOICE).select("sample_refs,sample_channels").eq("principal_id", pid).limit(1) as unknown as PromiseLike<Result>);
  if (!rows || rows.length === 0) return false;
  const sampleRefs = Array.isArray(rows[0].sample_refs) ? (rows[0].sample_refs as unknown[]) : [];
  const sampleChannels = Array.isArray(rows[0].sample_channels) ? (rows[0].sample_channels as unknown[]) : [];
  return refs.some((r) => sampleRefs.includes(r)) || (channel !== null && sampleChannels.includes(channel));
}

/** Test seam: forget the per-process schema cache. */
export function __resetReplyStoreForTests(): void {
  schemaCache = null;
}
