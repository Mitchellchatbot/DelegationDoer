import "server-only";

import { attentionRank, draftAttention, isActiveDraft, type DraftPatch } from "@/lib/exec/drafts-state";
import {
  ACTIVE_DRAFT_STATUSES,
  DRAFT_LIMITS,
  DRAFT_STATUSES,
  GENERATION_FLAGS,
  INSTRUCTION_BY,
  REVIEW_BLOCKERS,
  type ClientUpdateFactsRecord,
  type DraftAddress,
  type ExecDraftRow,
  type ExecDraftStatus
} from "@/lib/exec/drafts-types";
import type { SlotStatus } from "@/lib/exec/slack-intel-types";
import { NonRetryableError, type ErrorClass, type ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Every exec_drafts / exec_voice_profile read and write (P4 contract §3.7;
// Area A). Rules this module keeps:
//   * explicit column lists (never select *); every row read is mapped
//     strictly by draftFromDb (a malformed row throws);
//   * paged by .order("id") where unbounded (P2b convention);
//   * "not installed" = 42P01 / PGRST205 (relation) or PGRST202 / 42883
//     (function) only; every other database error throws (a refusal of the
//     write's shape as a NonRetryableError, the rest retryable);
//   * a CAS matches exactly one row (.select("id")) and never retries by
//     itself: the caller re-reads and decides;
//   * every insert sends the same key set (postgrest-js inserts NULL for
//     missing keys);
//   * nothing here logs content: the one log line carries counts.

export interface StoreOptions { signal?: AbortSignal }

const DRAFTS = "exec_drafts";
const VOICE = "exec_voice_profile";
const AUDIT = "exec_audit_log";
const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
const WRITE_CHUNK = 200;
const URL_LIST_BUDGET = 6_000;
const DAY_MS = 86_400_000;
const CLONE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)~(ed_[0-9a-f]{32})$/;

/** ExecDraftRow's three optional P7b fields (purpose, generatedVersion, clientUpdateFacts) are not in P4's column map: they
 *  are read and written through the tolerant path below (§3.17.2 E6), so a database without the P7b migration still reads
 *  and writes P4's drafts exactly as before. */
type MappedDraftField = Exclude<keyof ExecDraftRow, "purpose" | "generatedVersion" | "clientUpdateFacts">;
type P7bDraftField = "purpose" | "generatedVersion" | "clientUpdateFacts";

/** P7b (§2.1.6, §3.17.2 E2/E6): exec_drafts.purpose / generated_version / client_update_facts, appended by P7b's migration. */
export const P7B_DRAFT_COLUMNS: Readonly<Record<P7bDraftField, string>> = Object.freeze({
  purpose: "purpose",
  generatedVersion: "generated_version",
  clientUpdateFacts: "client_update_facts"
});
const P7B_FIELDS = Object.keys(P7B_DRAFT_COLUMNS) as P7bDraftField[];
const P7B_COLUMN_NAMES = P7B_FIELDS.map((f) => P7B_DRAFT_COLUMNS[f]);
/** E6: once a read finds P7b's columns missing, reads skip them for this long (per process) before asking again. */
const P7B_MISSING_TTL_MS = 600_000;
let p7bMissingUntil = 0;
const p7bColumnsKnownMissing = () => Date.now() < p7bMissingUntil;
/** Test seam: forget E6's cached "P7b's columns are missing" verdict. */
export function __resetDraftStoreColumnCacheForTests(): void {
  p7bMissingUntil = 0;
}

/** camel -> snake, every column of exec_drafts (§2.1), in the row's order. */
export const DRAFT_COLUMNS: Readonly<Record<MappedDraftField, string>> = Object.freeze({
  id: "id",
  principalId: "principal_id",
  accountId: "account_id",
  kind: "kind",
  origin: "origin",
  status: "status",
  priorStatus: "prior_status",
  version: "version",
  savedVersion: "saved_version",
  generationSeq: "generation_seq",
  threadId: "thread_id",
  parentMessageId: "parent_message_id",
  replyMode: "reply_mode",
  threadSubject: "thread_subject",
  replyCandidates: "reply_candidates",
  threadAddresses: "thread_addresses",
  toRecipients: "to_recipients",
  ccRecipients: "cc_recipients",
  bccRecipients: "bcc_recipients",
  subject: "subject",
  bodyDoc: "body_doc",
  bodyHtml: "body_html",
  bodyText: "body_text",
  instruction: "instruction",
  noteForMitchell: "note_for_mitchell",
  placeholders: "placeholders",
  reviewRecipients: "review_recipients",
  recipientsSig: "recipients_sig",
  screenHashes: "screen_hashes",
  screenTruncated: "screen_truncated",
  screenedPolicyHash: "screened_policy_hash",
  renderNonce: "render_nonce",
  model: "model",
  usage: "usage",
  generationError: "generation_error",
  generationFlags: "generation_flags",
  factsStatus: "facts_status",
  clientId: "client_id",
  generatedAt: "generated_at",
  outlookGraphId: "outlook_graph_id",
  internetMessageId: "internet_message_id",
  conversationId: "conversation_id",
  webLink: "web_link",
  contentHash: "content_hash",
  observedContentHash: "observed_content_hash",
  reviewHash: "review_hash",
  reviewAt: "review_at",
  reviewBlockers: "review_blockers",
  confirmHash: "confirm_hash",
  saveAttemptKey: "save_attempt_key",
  saveVersion: "save_version",
  saveTimezone: "save_timezone",
  saveIfContentHash: "save_if_content_hash",
  saveStartedAt: "save_started_at",
  discardAttemptKey: "discard_attempt_key",
  discardStartedAt: "discard_started_at",
  sendAttemptKey: "send_attempt_key",
  sendStartedAt: "send_started_at",
  sendAcceptedAt: "send_accepted_at",
  sentAt: "sent_at",
  sentAuditId: "sent_audit_id",
  sentMismatch: "sent_mismatch",
  unverified: "unverified",
  goneUnconfirmed: "gone_unconfirmed",
  signatureSkipped: "signature_skipped",
  outlookEdited: "outlook_edited",
  restrictedPurged: "restricted_purged",
  usesPrivateRefs: "uses_private_refs",
  cloneFlags: "clone_flags",
  ownerResolution: "owner_resolution",
  openedInOutlookAt: "opened_in_outlook_at",
  lastErrorCode: "last_error_code",
  lastErrorAt: "last_error_at",
  nextCheckAt: "next_check_at",
  checkCount: "check_count",
  goneAt: "gone_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
  terminalAt: "terminal_at",
  contentPurgedAt: "content_purged_at",
  expiresAt: "expires_at",
  // P5b (F7): appended by P5b's migration (ALTER TABLE ADD COLUMN), so it is the last column.
  instructionBy: "instruction_by",
  // P5b (review security-2): appended by the same migration.
  chatMessageId: "chat_message_id"
});

const DRAFT_FIELDS = Object.keys(DRAFT_COLUMNS) as MappedDraftField[];
const ALL_DRAFT_COLUMNS = DRAFT_FIELDS.map((f) => DRAFT_COLUMNS[f]).join(",");
/**
 * P5b (F7, security-2): every column but P5b's two (instruction_by, chat_message_id), for a database where P5b's
 * migration isn't applied yet. Every row there is one his web drafts wrote, so its instruction is his own and no
 * answer wrote it: the columns' defaults, 'owner' and null. P4's drafts keep working when the code ships before the
 * migration (chat needs the migration, so no 'assistant' row and no linked row exists yet).
 */
const LEGACY_DRAFT_COLUMNS = DRAFT_FIELDS.filter((f) => f !== "instructionBy" && f !== "chatMessageId").map((f) => DRAFT_COLUMNS[f]).join(",");
/** P7b (E6): P4's and P5b's columns plus P7b's three, the first read tried while they aren't known to be missing. */
const FULL_DRAFT_COLUMNS = `${ALL_DRAFT_COLUMNS},${P7B_COLUMN_NAMES.join(",")}`;
const INSTRUCTION_BY_COLUMN = DRAFT_COLUMNS.instructionBy;
const INSTRUCTION_BY_DEFAULT = "owner";
const CHAT_MESSAGE_ID_COLUMN = DRAFT_COLUMNS.chatMessageId;
/** The X2 artifact read (C73): only these columns, parsed tolerantly. */
const ARTIFACT_COLUMNS = "id,status,thread_id,parent_message_id,send_started_at,sent_at,updated_at";
/** The card and System counts: the columns draftAttention and the counters need. */
const COUNT_COLUMNS = "id,status,gone_unconfirmed,sent_mismatch,observed_content_hash,content_hash,last_error_code,restricted_purged,outlook_graph_id,version,saved_version,updated_at,terminal_at,next_check_at";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

type DbError = { code?: string | null; message?: string | null; details?: string | null };

/** A database answer the store couldn't use. `code` is the SQLSTATE / PostgREST code when there was one. */
export class DraftStoreError extends Error {
  readonly code: string | null;
  readonly errorClass: ErrorClass;
  constructor(message: string, code: string | null, errorClass: ErrorClass) {
    super(message);
    this.name = "DraftStoreError";
    this.code = code;
    this.errorClass = errorClass;
  }
}

/** True for the unique-index refusal a CAS into an active status can hit (§2.6.0 gone -> saved, T45). */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof DraftStoreError && err.code === "23505";
}

/** The migration isn't applied: the table or the RPC doesn't exist yet. */
function isNotInstalled(error: DbError): boolean {
  const code = error.code ?? "";
  if (code === "42P01" || code === "PGRST205" || code === "42883" || code === "PGRST202") return true;
  const m = error.message ?? "";
  return /relation ".*exec_(drafts|voice_profile)" does not exist/i.test(m) ||
    /could not find the (table|function) '?public\.exec_(drafts|voice_profile)/i.test(m);
}

/** P5b (F7, security-2): one of P5b's columns isn't there (P5b's migration isn't applied): 42703 / PGRST204 naming it. */
function missingInstructionBy(error: DbError | null | undefined): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  if (code !== "42703" && code !== "PGRST204") return false;
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  return [INSTRUCTION_BY_COLUMN, CHAT_MESSAGE_ID_COLUMN].some((c) => new RegExp(`(?<![A-Za-z0-9_])${c}(?![A-Za-z0-9_])`).test(text));
}

/** P7b (E6): one of P7b's three columns isn't there (P7b's migration isn't applied): 42703 / PGRST204 naming it. */
function missingP7bColumn(error: DbError | null | undefined): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  if (code !== "42703" && code !== "PGRST204") return false;
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  return P7B_COLUMN_NAMES.some((c) => new RegExp(`(?<![A-Za-z0-9_])${c}(?![A-Za-z0-9_])`).test(text));
}

/** P7b (E6): the store refused a write because P7b's draft columns aren't there (a client update can't be stored yet). */
export function isP7bColumnMissing(err: unknown): boolean {
  return err instanceof DraftStoreError && (err.code === "42703" || err.code === "PGRST204") &&
    P7B_COLUMN_NAMES.some((c) => new RegExp(`(?<![A-Za-z0-9_])${c}(?![A-Za-z0-9_])`).test(err.message));
}

/** A write's P7b values can be dropped on a database without the columns only when they are what that database holds
 *  anyway: purpose 'reply' and no facts record (generated_version is a hint P4's drafts never read). */
function p7bDroppable(values: Record<string, unknown>): boolean {
  const purpose = values[P7B_DRAFT_COLUMNS.purpose];
  const facts = values[P7B_DRAFT_COLUMNS.clientUpdateFacts];
  return (purpose === undefined || purpose === "reply") && (facts === undefined || facts === null);
}
const hasP7bKeys = (values: Record<string, unknown>) => P7B_COLUMN_NAMES.some((c) => c in values);
function withoutKeys(values: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out = { ...values };
  for (const k of keys) delete out[k];
  return out;
}

/** A row read with LEGACY_DRAFT_COLUMNS, with the columns' defaults filled in (draftFromDb stays strict). */
function withDefaultInstructionBy(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const row = raw as Record<string, unknown>;
  if (INSTRUCTION_BY_COLUMN in row && CHAT_MESSAGE_ID_COLUMN in row) return raw;
  return { [INSTRUCTION_BY_COLUMN]: INSTRUCTION_BY_DEFAULT, [CHAT_MESSAGE_ID_COLUMN]: null, ...row };
}

type DraftAnswer = { data: unknown; error: DbError | null };

/**
 * A read of exec_drafts rows by the full column list; when only instruction_by is missing (P5b's migration isn't
 * applied), the same read once more by the legacy list, its rows given the column's default. Errors come back as
 * the read answered them, for the caller's own handling.
 */
async function readDraftRows(run: (columns: string) => PromiseLike<{ data: unknown; error: unknown }>): Promise<DraftAnswer> {
  // P7b (E6): P7b's three columns first, unless a read in the last 10 minutes found them missing. A missing P7b column
  // retries once without them (the rows then read purpose 'reply' and no generation record); a missing P5b column means
  // P7b's are missing too (P7b's migration requires P5b's), so it goes straight to the legacy list.
  if (!p7bColumnsKnownMissing()) {
    const full = (await run(FULL_DRAFT_COLUMNS)) as DraftAnswer;
    if (!missingP7bColumn(full.error) && !missingInstructionBy(full.error)) return full;
    p7bMissingUntil = Date.now() + P7B_MISSING_TTL_MS;
    if (!missingInstructionBy(full.error)) {
      const mapped = (await run(ALL_DRAFT_COLUMNS)) as DraftAnswer;
      if (!missingInstructionBy(mapped.error)) return mapped;
    }
    return legacyDraftRows(run);
  }
  const first = (await run(ALL_DRAFT_COLUMNS)) as DraftAnswer;
  if (!missingInstructionBy(first.error)) return first;
  return legacyDraftRows(run);
}

/** The legacy list (before P5b's migration): P5b's columns given their defaults. */
async function legacyDraftRows(run: (columns: string) => PromiseLike<{ data: unknown; error: unknown }>): Promise<DraftAnswer> {
  const legacy = (await run(LEGACY_DRAFT_COLUMNS)) as DraftAnswer;
  if (legacy.error) return legacy;
  const data = Array.isArray(legacy.data) ? legacy.data.map(withDefaultInstructionBy) : withDefaultInstructionBy(legacy.data);
  return { data, error: null };
}

/** The database refused the request's shape: a bug, not a transient failure. */
function isRefusal(error: DbError): boolean {
  const code = error.code ?? "";
  return code === "23514" || code === "23502" || code === "22001" || code === "22P02" || code === "22007" || code === "22008" ||
    code === "22023" || code === "42703" || code === "PGRST204" || code === "P0001" || code === "23503";
}

function failure(what: string, error: DbError, signal: AbortSignal | undefined): Error {
  signal?.throwIfAborted();
  const text = `exec drafts store: ${what} failed: ${error.message ?? "unknown error"}${error.code ? ` (${error.code})` : ""}`;
  return new DraftStoreError(text, error.code ?? null, isRefusal(error) ? "fatal" : "retryable");
}

function refuse(message: string): never {
  throw new NonRetryableError(`exec drafts store: ${message}`);
}

// ---------------------------------------------------------------------------
// Row mapping (strict)
// ---------------------------------------------------------------------------

type Kind =
  | "text" | "text?" | "int" | "int?" | "bool" | "ts" | "ts?" | "text[]" | "object?" | "addr[]"
  | { enum: readonly string[]; nullable: boolean } | { enumArray: readonly string[] };

const CLONE_FLAGS = ["send_status_unknown", "not_found_after_send", "verify_overdue", "create_unconfirmed", "gone_unconfirmed", "unverified", "signature_skipped"];

const KINDS: Readonly<Record<MappedDraftField, Kind>> = {
  id: "text", principalId: "text", accountId: "text",
  kind: { enum: ["reply", "new"], nullable: false },
  origin: { enum: ["web", "slack", "chat"], nullable: false },
  status: { enum: DRAFT_STATUSES, nullable: false },
  priorStatus: { enum: ["draft", "saved", "generation_failed", "unknown"], nullable: true },
  version: "int", savedVersion: "int?", generationSeq: "int",
  threadId: "text?", parentMessageId: "text?",
  replyMode: { enum: ["reply", "reply_all", "follow_up"], nullable: true },
  threadSubject: "text?", replyCandidates: "object?", threadAddresses: "text[]",
  toRecipients: "addr[]", ccRecipients: "addr[]", bccRecipients: "addr[]",
  subject: "text?", bodyDoc: "object?", bodyHtml: "text?", bodyText: "text?", instruction: "text?", noteForMitchell: "text?",
  placeholders: "text[]", reviewRecipients: "object?", recipientsSig: "text?",
  screenHashes: "text[]", screenTruncated: "bool", screenedPolicyHash: "text?",
  renderNonce: "text", model: "text?", usage: "object?",
  generationError: { enum: ["declined", "truncated", "invalid_output", "budget", "input_too_large", "thread_unavailable", "restricted", "model_error", "timeout", "stale", "stopped"], nullable: true },
  generationFlags: { enumArray: GENERATION_FLAGS },
  factsStatus: { enum: ["used", "none", "not_matched", "medium_confidence", "unavailable", "recipients_outside_client"], nullable: true },
  clientId: "text?", generatedAt: "ts?",
  outlookGraphId: "text?", internetMessageId: "text?", conversationId: "text?", webLink: "text?",
  contentHash: "text?", observedContentHash: "text?", reviewHash: "text?", reviewAt: "ts?",
  reviewBlockers: { enumArray: REVIEW_BLOCKERS },
  confirmHash: "text?", saveAttemptKey: "text?", saveVersion: "int?", saveTimezone: "text?", saveIfContentHash: "text?",
  saveStartedAt: "ts?", discardAttemptKey: "text?", discardStartedAt: "ts?", sendAttemptKey: "text?", sendStartedAt: "ts?",
  sendAcceptedAt: "ts?", sentAt: "ts?", sentAuditId: "int?",
  sentMismatch: "bool", unverified: "bool", goneUnconfirmed: "bool", signatureSkipped: "bool", outlookEdited: "bool",
  restrictedPurged: "bool", usesPrivateRefs: "bool",
  cloneFlags: { enumArray: CLONE_FLAGS },
  ownerResolution: { enum: ["sent", "not_sent"], nullable: true },
  openedInOutlookAt: "ts?", lastErrorCode: "text?", lastErrorAt: "ts?", nextCheckAt: "ts?", checkCount: "int", goneAt: "ts?",
  createdAt: "ts", updatedAt: "ts", terminalAt: "ts?", contentPurgedAt: "ts?", expiresAt: "ts?",
  instructionBy: { enum: INSTRUCTION_BY, nullable: false },
  chatMessageId: "text?"
};

const isTs = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const isAddress = (v: unknown): v is DraftAddress =>
  typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as DraftAddress).address === "string" &&
  ((v as DraftAddress).name === null || (v as DraftAddress).name === undefined || typeof (v as DraftAddress).name === "string");

function cell(row: Record<string, unknown>, field: MappedDraftField): unknown {
  const column = DRAFT_COLUMNS[field];
  const v = row[column];
  const kind = KINDS[field];
  const bad = () => new DraftStoreError(`exec drafts store: ${DRAFTS} read failed: column ${column} is malformed`, null, "fatal");
  if (typeof kind === "object") {
    if ("enum" in kind) {
      if (v === null && kind.nullable) return null;
      if (typeof v !== "string" || !kind.enum.includes(v)) throw bad();
      return v;
    }
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !kind.enumArray.includes(x))) throw bad();
    return [...v];
  }
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
    case "int?":
      if (v !== null && (typeof v !== "number" || !Number.isSafeInteger(v))) throw bad();
      return v;
    case "bool":
      if (typeof v !== "boolean") throw bad();
      return v;
    case "ts":
      if (!isTs(v)) throw bad();
      return v;
    case "ts?":
      if (v !== null && !isTs(v)) throw bad();
      return v;
    case "text[]":
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw bad();
      return [...v];
    case "object?":
      if (v !== null && (typeof v !== "object" || Array.isArray(v))) throw bad();
      return v;
    case "addr[]":
      if (!Array.isArray(v) || !v.every(isAddress)) throw bad();
      return v.map((a) => ({ address: (a as DraftAddress).address, name: (a as DraftAddress).name ?? null }));
  }
}

/** strict; a malformed row throws */
export function draftFromDb(raw: unknown): ExecDraftRow {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DraftStoreError(`exec drafts store: ${DRAFTS} read failed: a row is not an object`, null, "fatal");
  }
  const row = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of DRAFT_FIELDS) out[field] = cell(row, field);
  // P7b (E2, E6): a column the read selected is mapped (strictly); one it didn't (a database before P7b's migration, or
  // P4's insert read-back) is left absent, which every reader takes as purpose 'reply' and no generation record.
  const bad = (column: string) => new DraftStoreError(`exec drafts store: ${DRAFTS} read failed: column ${column} is malformed`, null, "fatal");
  if (P7B_DRAFT_COLUMNS.purpose in row) {
    const v = row[P7B_DRAFT_COLUMNS.purpose];
    if (v !== "reply" && v !== "client_update") throw bad(P7B_DRAFT_COLUMNS.purpose);
    out.purpose = v;
  }
  if (P7B_DRAFT_COLUMNS.generatedVersion in row) {
    const v = row[P7B_DRAFT_COLUMNS.generatedVersion];
    if (v !== null && (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1)) throw bad(P7B_DRAFT_COLUMNS.generatedVersion);
    out.generatedVersion = v;
  }
  if (P7B_DRAFT_COLUMNS.clientUpdateFacts in row) {
    const v = row[P7B_DRAFT_COLUMNS.clientUpdateFacts];
    const record = v === null ? null : clientUpdateFactsRecordOf(v);
    if (record === undefined) throw bad(P7B_DRAFT_COLUMNS.clientUpdateFacts);
    out.clientUpdateFacts = record;
  }
  return out as unknown as ExecDraftRow;
}

/** SlotStatus's values (slack-intel-types.ts), for the strict read of client_update_facts. */
const SLOT_STATUSES: readonly SlotStatus[] = ["used", "none", "unavailable", "not_connected", "off"];

/** exec_drafts.client_update_facts as a ClientUpdateFactsRecord (counts, slot statuses, two timestamps), or undefined when
 *  it isn't one. Only the record's own keys are kept: the column never carries text. */
export function clientUpdateFactsRecordOf(v: unknown): ClientUpdateFactsRecord | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const slot = (x: unknown): { status: SlotStatus; count: number } | undefined => {
    if (typeof x !== "object" || x === null || Array.isArray(x)) return undefined;
    const s = x as Record<string, unknown>;
    if (typeof s.status !== "string" || !(SLOT_STATUSES as readonly string[]).includes(s.status)) return undefined;
    if (typeof s.count !== "number" || !Number.isSafeInteger(s.count) || s.count < 0) return undefined;
    return { status: s.status as SlotStatus, count: s.count };
  };
  const completed = slot(o.completed);
  const teamWork = slot(o.teamWork);
  const publicSlack = slot(o.publicSlack);
  if (completed === undefined || teamWork === undefined || publicSlack === undefined) return undefined;
  const instant = (x: unknown): string | null | undefined =>
    x === null || x === undefined ? null : typeof x === "string" && Number.isFinite(Date.parse(x)) ? new Date(Date.parse(x)).toISOString() : undefined;
  let lastUpdate: ClientUpdateFactsRecord["lastUpdate"] = null;
  if (o.lastUpdate !== null && o.lastUpdate !== undefined) {
    if (typeof o.lastUpdate !== "object" || Array.isArray(o.lastUpdate)) return undefined;
    const l = o.lastUpdate as Record<string, unknown>;
    const teamEmailSentAt = instant(l.teamEmailSentAt);
    const workReportedAt = instant(l.workReportedAt);
    if (teamEmailSentAt === undefined || workReportedAt === undefined) return undefined;
    lastUpdate = { teamEmailSentAt, workReportedAt };
  }
  return { completed, teamWork, publicSlack, lastUpdate };
}

/** Every column a create sets (identical key set for every insert): the row minus the database-set id, created_at and updated_at. */
export type NewDraftRow = Omit<ExecDraftRow, "id" | "createdAt" | "updatedAt">;

const NEW_DRAFT_FIELDS = DRAFT_FIELDS.filter((f) => f !== "id" && f !== "createdAt" && f !== "updatedAt") as (keyof NewDraftRow & MappedDraftField)[];

/** The insert payload: every NewDraftRow field, snake_case, arrays copied (rule 11: one key set). */
function toDb(row: NewDraftRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of NEW_DRAFT_FIELDS) {
    if (!(field in row)) refuse(`insert is missing ${field}`);
    const v = row[field];
    out[DRAFT_COLUMNS[field]] = Array.isArray(v) ? [...v] : v;
  }
  // P7b (E2): a row that names its purpose sends P7b's three columns together (one key set for them); one that doesn't
  // (every P4 and P5b insert) sends P4's set exactly, and the table's defaults apply ('reply', null, null).
  if (row.purpose !== undefined || row.generatedVersion !== undefined || row.clientUpdateFacts !== undefined) {
    out[P7B_DRAFT_COLUMNS.purpose] = row.purpose ?? "reply";
    out[P7B_DRAFT_COLUMNS.generatedVersion] = row.generatedVersion ?? null;
    out[P7B_DRAFT_COLUMNS.clientUpdateFacts] = row.clientUpdateFacts ?? null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

const db = () => getSupabaseAdmin();
function sel(table: string, columns: string, options?: { count: "exact"; head: true }) {
  return db().from(table).select(columns, options);
}
type Query = ReturnType<typeof sel>;

function checkIds(ids: readonly unknown[], field: string): string[] {
  if (!Array.isArray(ids)) refuse(`${field} must be a list`);
  for (const id of ids) if (typeof id !== "string" || !CLONE_ID.test(id)) refuse(`${field} is malformed`);
  return [...new Set(ids as string[])];
}

function checkDraftId(id: unknown): string {
  if (typeof id !== "string" || !/^ed_[0-9a-f]{32}$/.test(id)) refuse("draft id is malformed");
  return id;
}

function validNow(now: Date): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) refuse("a valid `now` is required");
  return now;
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

/** Every row of a query, in pages ordered by `orderBy`. Throws on any error; `null` = not installed. */
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
    if (!Array.isArray(data)) throw new DraftStoreError(`exec drafts store: ${what} failed: the response carried no rows`, null, "retryable");
    for (const row of data) rows.push(row as unknown as Record<string, unknown>);
    if (data.length < PAGE_SIZE) return rows;
  }
  throw new DraftStoreError(`exec drafts store: ${what} failed: more than ${MAX_PAGES * PAGE_SIZE} rows`, null, "retryable");
}

/** The `active` predicate as a PostgREST or() filter (the unique index's, §2.1). */
const ACTIVE_OR = `status.in.(${ACTIVE_DRAFT_STATUSES.join(",")}),and(status.eq.gone,gone_unconfirmed.is.true)`;

// ---------------------------------------------------------------------------
// Single rows and the CAS
// ---------------------------------------------------------------------------

/** 23505 on the one-active index -> existing */
export async function insertDraft(principal: ExecPrincipal, row: NewDraftRow, opts: StoreOptions = {}):
  Promise<{ inserted: true; row: ExecDraftRow } | { inserted: false; existingId: string }> {
  if (row.principalId !== principal.id) refuse("a draft is inserted for its own principal only");
  const payload = toDb(row);
  const insert = (body: Record<string, unknown>, columns: string) => {
    let query = db().from(DRAFTS).insert(body).select(columns);
    if (opts.signal) query = query.abortSignal(opts.signal);
    return query.single();
  };
  // P7b (E6): a payload with P7b's columns reads them back too; P4's payloads keep P4's read-back exactly.
  const p7b = hasP7bKeys(payload);
  let { data, error } = (await insert(payload, p7b ? FULL_DRAFT_COLUMNS : ALL_DRAFT_COLUMNS)) as DraftAnswer;
  let sent = payload;
  if (p7b && missingP7bColumn(error) && p7bDroppable(payload)) {
    // P7b's migration isn't applied: a 'reply' row with no record is what the table holds anyway.
    p7bMissingUntil = Date.now() + P7B_MISSING_TTL_MS;
    sent = withoutKeys(payload, P7B_COLUMN_NAMES);
    ({ data, error } = (await insert(sent, ALL_DRAFT_COLUMNS)) as DraftAnswer);
  } else if (p7b && !error) {
    p7bMissingUntil = 0;
  }
  if (missingInstructionBy(error) && sent[INSTRUCTION_BY_COLUMN] === INSTRUCTION_BY_DEFAULT && sent[CHAT_MESSAGE_ID_COLUMN] === null && p7bDroppable(sent)) {
    // P5b's migration isn't applied: an owner row with no linked answer is what the table's defaults would write
    // anyway (F7). An assistant or linked row can't be stored there, so it fails below (chat needs the migration).
    // P7b's columns can't exist there either (P7b's migration requires P5b's), so they go too when they're defaults.
    const legacyPayload = withoutKeys(sent, [INSTRUCTION_BY_COLUMN, CHAT_MESSAGE_ID_COLUMN, ...P7B_COLUMN_NAMES]);
    ({ data, error } = (await insert(legacyPayload, LEGACY_DRAFT_COLUMNS)) as DraftAnswer);
    if (!error) data = withDefaultInstructionBy(data);
  }
  if (error) {
    const text = `${error.message ?? ""} ${(error as DbError).details ?? ""}`;
    if (error.code === "23505" && /exec_drafts_one_active_per_thread/.test(text) && row.threadId !== null) {
      const existing = await getActiveDraftForThread(principal, row.threadId, opts);
      if (existing) return { inserted: false, existingId: existing.id };
    }
    throw failure(`${DRAFTS} insert`, error, opts.signal);
  }
  return { inserted: true, row: draftFromDb(data) };
}

export async function getDraft(principal: ExecPrincipal, id: string, opts: StoreOptions = {}): Promise<ExecDraftRow | null> {
  checkDraftId(id);
  const { data, error } = await readDraftRows((columns) => {
    let query = sel(DRAFTS, columns).eq("id", id).eq("principal_id", principal.id);
    if (opts.signal) query = query.abortSignal(opts.signal);
    return query.maybeSingle();
  });
  if (error) {
    if (isNotInstalled(error)) return null;
    throw failure(`${DRAFTS} read`, error, opts.signal);
  }
  return data === null ? null : draftFromDb(data);
}

/** The thread's active draft (the unique index allows one): non-terminal, or gone while unconfirmed. */
export async function getActiveDraftForThread(principal: ExecPrincipal, threadId: string, opts: StoreOptions = {}): Promise<ExecDraftRow | null> {
  const [id] = checkIds([threadId], "threadId");
  const { data, error } = await readDraftRows((columns) => {
    let query = sel(DRAFTS, columns).eq("principal_id", principal.id).eq("thread_id", id).or(ACTIVE_OR).order("id").limit(1);
    if (opts.signal) query = query.abortSignal(opts.signal);
    return query;
  });
  if (error) {
    if (isNotInstalled(error)) return null;
    throw failure(`${DRAFTS} active read`, error, opts.signal);
  }
  const rows = Array.isArray(data) ? data : [];
  return rows.length === 0 ? null : draftFromDb(rows[0]);
}

export interface CasExpect {
  status: ExecDraftStatus | readonly ExecDraftStatus[];
  version?: number; generationSeq?: number; reviewHash?: string;
  saveAttemptKey?: string; discardAttemptKey?: string; sendAttemptKey?: string;
}

/**
 * .update(patch).eq("id").eq("principal_id")...expect....select("id"): true iff exactly one row; DB errors throw.
 * The patch is written as given plus updated_at = now when it carries none. The keys of a CAS are fixed per
 * transition (C5): V = status + version; G = V + generationSeq; Ks/Kd/Kx = the in-flight status(es) + the attempt key.
 */
export async function casDraft(principal: ExecPrincipal, id: string, expect: CasExpect, patch: DraftPatch, opts: StoreOptions = {}): Promise<boolean> {
  checkDraftId(id);
  if ("id" in patch || "principal_id" in patch) refuse("a CAS patch may not write id or principal_id");
  const body: Record<string, unknown> = { updated_at: new Date().toISOString(), ...patch };
  const statuses = typeof expect.status === "string" ? [expect.status] : [...expect.status];
  if (statuses.length === 0) refuse("a CAS expects at least one status");
  const update = (values: Record<string, unknown>) => {
    let query = db().from(DRAFTS).update(values).eq("id", id).eq("principal_id", principal.id);
    query = statuses.length === 1 ? query.eq("status", statuses[0]) : query.in("status", statuses);
    if (expect.version !== undefined) query = query.eq("version", expect.version);
    if (expect.generationSeq !== undefined) query = query.eq("generation_seq", expect.generationSeq);
    if (expect.reviewHash !== undefined) query = query.eq("review_hash", expect.reviewHash);
    if (expect.saveAttemptKey !== undefined) query = query.eq("save_attempt_key", expect.saveAttemptKey);
    if (expect.discardAttemptKey !== undefined) query = query.eq("discard_attempt_key", expect.discardAttemptKey);
    if (expect.sendAttemptKey !== undefined) query = query.eq("send_attempt_key", expect.sendAttemptKey);
    let selected = query.select("id");
    if (opts.signal) selected = selected.abortSignal(opts.signal);
    return selected;
  };
  let { data, error } = (await update(body)) as DraftAnswer;
  let sent = body;
  if (missingP7bColumn(error) && p7bDroppable(sent)) {
    // P7b (E6): P7b's migration isn't applied: generated_version (and a 'reply' purpose) mean nothing there, so the write
    // without them is the same. A client update's purpose or record can't be stored there and fails below.
    p7bMissingUntil = Date.now() + P7B_MISSING_TTL_MS;
    sent = withoutKeys(sent, P7B_COLUMN_NAMES);
    ({ data, error } = (await update(sent)) as DraftAnswer);
  }
  if (missingInstructionBy(error) && sent[INSTRUCTION_BY_COLUMN] === INSTRUCTION_BY_DEFAULT && p7bDroppable(sent)) {
    // P5b's migration isn't applied: every row there is already 'owner' (F7), so the write without it is the same.
    const legacy = withoutKeys(sent, [INSTRUCTION_BY_COLUMN, ...P7B_COLUMN_NAMES]);
    ({ data, error } = (await update(legacy)) as DraftAnswer);
  }
  if (error) throw failure(`${DRAFTS} update`, error, opts.signal);
  return Array.isArray(data) && data.length === 1;
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

function parseCursor(cursor: string | null | undefined): { updatedAt: string; id: string } | null {
  if (cursor === null || cursor === undefined || cursor === "") return null;
  const m = CURSOR_RE.exec(cursor);
  if (!m || !Number.isFinite(Date.parse(m[1]))) refuse("cursor is malformed");
  return { updatedAt: m[1], id: m[2] };
}

/**
 * C46: `active` (non-terminal + gone while unconfirmed, ≤200, attention first then updated_at desc, no cursor);
 * `recent` (sent / sent_external that ended in the last 7 days, newest first); `all` (cursor-paged by updated_at desc,
 * id desc, ≤50 per page). The bucket is active + recent.
 */
export async function listDrafts(principal: ExecPrincipal, q: { view: "active" | "recent" | "all"; cursor?: string | null; limit?: number }, now: Date, opts: StoreOptions = {}):
  Promise<{ rows: ExecDraftRow[]; nextCursor: string | null }> {
  validNow(now);
  const limitOf = (cap: number) => (typeof q.limit === "number" && Number.isSafeInteger(q.limit) && q.limit >= 1 ? Math.min(q.limit, cap) : cap);
  let build: (columns: string) => Query;
  let limit: number;
  if (q.view === "active") {
    limit = limitOf(DRAFT_LIMITS.activeListLimit);
    const n = limit;
    build = (columns) => sel(DRAFTS, columns).eq("principal_id", principal.id).or(ACTIVE_OR)
      .order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(n);
  } else if (q.view === "recent") {
    limit = limitOf(DRAFT_LIMITS.activeListLimit);
    const n = limit;
    const since = new Date(now.getTime() - DRAFT_LIMITS.recentSentDays * DAY_MS).toISOString();
    build = (columns) => sel(DRAFTS, columns).eq("principal_id", principal.id).in("status", ["sent", "sent_external"]).gte("terminal_at", since)
      .order("terminal_at", { ascending: false }).order("id", { ascending: false }).limit(n);
  } else {
    limit = limitOf(DRAFT_LIMITS.pageLimit);
    const n = limit;
    const cursor = parseCursor(q.cursor);
    build = (columns) => {
      let query = sel(DRAFTS, columns).eq("principal_id", principal.id);
      if (cursor) query = query.or(`updated_at.lt."${cursor.updatedAt}",and(updated_at.eq."${cursor.updatedAt}",id.lt."${cursor.id}")`);
      return query.order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(n);
    };
  }
  const { data, error } = await readDraftRows((columns) => {
    const query = build(columns);
    return opts.signal ? query.abortSignal(opts.signal) : query;
  });
  if (error) {
    if (isNotInstalled(error)) return { rows: [], nextCursor: null };
    throw failure(`${DRAFTS} list`, error, opts.signal);
  }
  const rows = (Array.isArray(data) ? data : []).map(draftFromDb);
  if (q.view === "active") {
    rows.sort((a, b) => attentionRank(draftAttention(a)) - attentionRank(draftAttention(b)) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return { rows, nextCursor: null };
  }
  if (q.view === "recent") return { rows, nextCursor: null };
  const last = rows[rows.length - 1];
  return { rows, nextCursor: rows.length === limit && last ? `${last.updatedAt}~${last.id}` : null };
}

/** Rows due for the sweep: next_check_at ≤ now, oldest first. */
export async function listDueDrafts(principal: ExecPrincipal, now: Date, limit: number, opts: StoreOptions = {}): Promise<ExecDraftRow[]> {
  const nowIso = validNow(now).toISOString();
  const n = Number.isSafeInteger(limit) && limit >= 1 ? limit : 20;
  const { data, error } = await readDraftRows((columns) => {
    let query = sel(DRAFTS, columns).eq("principal_id", principal.id).lte("next_check_at", nowIso)
      .order("next_check_at", { ascending: true }).order("id").limit(n);
    if (opts.signal) query = query.abortSignal(opts.signal);
    return query;
  });
  if (error) {
    if (isNotInstalled(error)) return [];
    throw failure(`${DRAFTS} due read`, error, opts.signal);
  }
  return (Array.isArray(data) ? data : []).map(draftFromDb);
}

/** C67 (1): .update({ next_check_at: until }).eq("id").eq("principal_id").eq("next_check_at", seen).select("id"); true iff one row. */
export async function claimDueDraft(principal: ExecPrincipal, id: string, seenNextCheckAt: string, until: string, opts: StoreOptions = {}): Promise<boolean> {
  checkDraftId(id);
  if (!isTs(seenNextCheckAt) || !isTs(until)) refuse("claim times must be ISO timestamps");
  let query = db().from(DRAFTS).update({ next_check_at: until }).eq("id", id).eq("principal_id", principal.id).eq("next_check_at", seenNextCheckAt).select("id");
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { data, error } = await query;
  if (error) throw failure(`${DRAFTS} claim`, error, opts.signal);
  return Array.isArray(data) && data.length === 1;
}

/** C63: the newest inactive, unsent draft on (thread, parent): discarded, or gone and confirmed; newest created_at first; null when none. */
export async function getLatestDraftForParent(principal: ExecPrincipal, threadId: string, parentMessageId: string, opts: StoreOptions = {}): Promise<ExecDraftRow | null> {
  const [thread] = checkIds([threadId], "threadId");
  const [parent] = checkIds([parentMessageId], "parentMessageId");
  const { data, error } = await readDraftRows((columns) => {
    let query = sel(DRAFTS, columns).eq("principal_id", principal.id).eq("thread_id", thread).eq("parent_message_id", parent)
      .or("status.eq.discarded,and(status.eq.gone,gone_unconfirmed.is.false)")
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1);
    if (opts.signal) query = query.abortSignal(opts.signal);
    return query;
  });
  if (error) {
    if (isNotInstalled(error)) return null;
    throw failure(`${DRAFTS} parent read`, error, opts.signal);
  }
  const rows = Array.isArray(data) ? data : [];
  return rows.length === 0 ? null : draftFromDb(rows[0]);
}

/** C48 (b): every other draft on (thread, parent), id and status only. Not installed → []. */
export async function listDraftsForParent(principal: ExecPrincipal, threadId: string, parentMessageId: string, excludeId: string, opts: StoreOptions = {}):
  Promise<{ id: string; status: ExecDraftStatus }[]> {
  const [thread] = checkIds([threadId], "threadId");
  const [parent] = checkIds([parentMessageId], "parentMessageId");
  checkDraftId(excludeId);
  const rows = await pageAll(
    `${DRAFTS} siblings read`,
    () => sel(DRAFTS, "id,status").eq("principal_id", principal.id).eq("thread_id", thread).eq("parent_message_id", parent).neq("id", excludeId),
    ["id"],
    opts.signal
  );
  if (rows === null) return [];
  const out: { id: string; status: ExecDraftStatus }[] = [];
  for (const r of rows) {
    if (typeof r.id !== "string" || typeof r.status !== "string" || !DRAFT_STATUSES.includes(r.status as ExecDraftStatus)) {
      throw new DraftStoreError(`exec drafts store: ${DRAFTS} siblings read failed: a row is malformed`, null, "fatal");
    }
    out.push({ id: r.id, status: r.status as ExecDraftStatus });
  }
  return out;
}

/** not installed → false */
export async function hasDueDrafts(principal: ExecPrincipal, now: Date, opts: StoreOptions = {}): Promise<boolean> {
  const nowIso = validNow(now).toISOString();
  let query = sel(DRAFTS, "id", { count: "exact", head: true }).eq("principal_id", principal.id).lte("next_check_at", nowIso);
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { count, error } = await query;
  if (error) {
    if (isNotInstalled(error)) return false;
    throw failure(`${DRAFTS} due count`, error, opts.signal);
  }
  return typeof count === "number" && count > 0;
}

/** The earliest next_check_at at or before now + withinMs, or null (not installed → null). */
export async function earliestDueWithin(principal: ExecPrincipal, now: Date, withinMs: number, opts: StoreOptions = {}): Promise<string | null> {
  const until = new Date(validNow(now).getTime() + Math.max(0, withinMs)).toISOString();
  let query = sel(DRAFTS, "next_check_at").eq("principal_id", principal.id).lte("next_check_at", until)
    .order("next_check_at", { ascending: true }).limit(1);
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { data, error } = await query;
  if (error) {
    if (isNotInstalled(error)) return null;
    throw failure(`${DRAFTS} earliest due`, error, opts.signal);
  }
  const first = Array.isArray(data) && data.length > 0 ? (data[0] as { next_check_at?: unknown }).next_check_at : null;
  return isTs(first) ? first : null;
}

// ---------------------------------------------------------------------------
// Purges (§2.7, §2.8)
// ---------------------------------------------------------------------------

/** §2.7. null = not installed (RPC missing). Any other error throws (retryable), so a tombstone never finishes without it. */
export async function purgeDraftsForThreads(principal: ExecPrincipal, threadIds: readonly string[], opts: StoreOptions = {}): Promise<number | null> {
  const ids = checkIds(threadIds, "threadIds");
  if (ids.length === 0) return 0;
  let purged = 0;
  for (const chunk of urlListChunks(ids)) {
    opts.signal?.throwIfAborted();
    let query = db().rpc("exec_drafts_purge_restricted", { p_principal: principal.id, p_thread_ids: chunk });
    if (opts.signal) query = query.abortSignal(opts.signal);
    const { data, error } = await query;
    if (error) {
      if (isNotInstalled(error)) return null;
      throw failure("exec_drafts_purge_restricted", error, opts.signal);
    }
    if (typeof data !== "number" || !Number.isSafeInteger(data)) {
      throw new DraftStoreError("exec drafts store: exec_drafts_purge_restricted failed: the answer is not a count", null, "retryable");
    }
    purged += data;
  }
  return purged;
}

export interface DraftPurgeCounts { contentPurged: number; deleted: number; closedIdle: number; checksScheduled: number }
const PURGE_BATCH = 1000;
const PURGE_ROUNDS = 10;

/** §2.8: exec_drafts_purge_expired(now, 1000) up to 10 times while any returned count equals 1 000; not installed → zeros. */
export async function purgeExpiredDrafts(now: Date, opts: StoreOptions = {}): Promise<DraftPurgeCounts> {
  const nowIso = validNow(now).toISOString();
  const total: DraftPurgeCounts = { contentPurged: 0, deleted: 0, closedIdle: 0, checksScheduled: 0 };
  for (let round = 0; round < PURGE_ROUNDS; round += 1) {
    opts.signal?.throwIfAborted();
    let query = db().rpc("exec_drafts_purge_expired", { p_now: nowIso, p_limit: PURGE_BATCH });
    if (opts.signal) query = query.abortSignal(opts.signal);
    const { data, error } = await query;
    if (error) {
      if (isNotInstalled(error)) return total;
      throw failure("exec_drafts_purge_expired", error, opts.signal);
    }
    const counts = data as Partial<Record<keyof DraftPurgeCounts, unknown>> | null;
    const read = (k: keyof DraftPurgeCounts): number => {
      const v = counts?.[k];
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
        throw new DraftStoreError(`exec drafts store: exec_drafts_purge_expired failed: ${k} is not a count`, null, "retryable");
      }
      return v;
    };
    const step: DraftPurgeCounts = { contentPurged: read("contentPurged"), deleted: read("deleted"), closedIdle: read("closedIdle"), checksScheduled: read("checksScheduled") };
    total.contentPurged += step.contentPurged;
    total.deleted += step.deleted;
    total.closedIdle += step.closedIdle;
    total.checksScheduled += step.checksScheduled;
    if (Math.max(step.contentPurged, step.deleted, step.closedIdle, step.checksScheduled) < PURGE_BATCH) break;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Artifacts and counts (X1, X2, X7, Y7)
// ---------------------------------------------------------------------------

const SENT_PARENT_STATUSES: readonly ExecDraftStatus[] = ["sending", "sent_pending", "sent", "sent_external"];

/**
 * X2: per thread, the active draft (id, status) and the parents of drafts sent from DD in the last 7 days (sending, sent_pending, sent, sent_external). Not installed → empty map.
 * C73: selects only id, status, thread_id, parent_message_id, send_started_at, sent_at, updated_at and parses tolerantly
 * (a row with an unknown status or a bad field is skipped and counted); other DB errors throw to the caller, which fails open.
 */
export async function listDraftArtifacts(principal: ExecPrincipal, threadIds: readonly string[] | "all", now: Date, opts: StoreOptions = {}):
  Promise<Map<string, { execDraft: { id: string; status: ExecDraftStatus } | null; execSentParents: string[] }>> {
  const sinceMs = validNow(now).getTime() - DRAFT_LIMITS.recentSentDays * DAY_MS;
  const out = new Map<string, { execDraft: { id: string; status: ExecDraftStatus } | null; execSentParents: string[] }>();
  const chunks = threadIds === "all" ? [null] : urlListChunks(checkIds(threadIds, "threadIds"));
  let skipped = 0;
  for (const chunk of chunks) {
    const rows = await pageAll(
      `${DRAFTS} artifacts read`,
      () => {
        const q = sel(DRAFTS, ARTIFACT_COLUMNS).eq("principal_id", principal.id);
        return chunk === null ? q.not("thread_id", "is", null) : q.in("thread_id", chunk);
      },
      ["id"],
      opts.signal
    );
    if (rows === null) return new Map();
    for (const r of rows) {
      const status = typeof r.status === "string" && DRAFT_STATUSES.includes(r.status as ExecDraftStatus) ? (r.status as ExecDraftStatus) : null;
      if (status === null || typeof r.id !== "string" || typeof r.thread_id !== "string") {
        skipped += 1;
        continue;
      }
      const entry = out.get(r.thread_id) ?? { execDraft: null, execSentParents: [] };
      // gone_unconfirmed isn't selected (C73): a gone row never reads as active here; chips only.
      if (ACTIVE_DRAFT_STATUSES.includes(status)) entry.execDraft = { id: r.id, status };
      if (SENT_PARENT_STATUSES.includes(status) && typeof r.parent_message_id === "string") {
        const stamp = [r.send_started_at, r.sent_at, r.updated_at].find(isTs);
        if (stamp !== undefined && Date.parse(stamp) >= sinceMs && !entry.execSentParents.includes(r.parent_message_id)) {
          entry.execSentParents.push(r.parent_message_id);
        }
      }
      out.set(r.thread_id, entry);
    }
  }
  if (skipped > 0) console.warn(`[exec-drafts] artifacts: skipped ${skipped} malformed rows for ${principal.id}`);
  return out;
}

interface CountRow {
  id: string; status: ExecDraftStatus; goneUnconfirmed: boolean; sentMismatch: boolean; observedContentHash: string | null; contentHash: string | null;
  lastErrorCode: string | null; restrictedPurged: boolean; outlookGraphId: string | null; version: number; savedVersion: number | null;
  updatedAt: string; terminalAt: string | null; nextCheckAt: string | null;
}

function countRow(r: Record<string, unknown>): CountRow | null {
  const status = typeof r.status === "string" && DRAFT_STATUSES.includes(r.status as ExecDraftStatus) ? (r.status as ExecDraftStatus) : null;
  if (status === null || typeof r.id !== "string" || typeof r.version !== "number" || !isTs(r.updated_at)) return null;
  return {
    id: r.id,
    status,
    goneUnconfirmed: r.gone_unconfirmed === true,
    sentMismatch: r.sent_mismatch === true,
    observedContentHash: typeof r.observed_content_hash === "string" ? r.observed_content_hash : null,
    contentHash: typeof r.content_hash === "string" ? r.content_hash : null,
    lastErrorCode: typeof r.last_error_code === "string" ? r.last_error_code : null,
    restrictedPurged: r.restricted_purged === true,
    outlookGraphId: typeof r.outlook_graph_id === "string" ? r.outlook_graph_id : null,
    version: r.version,
    savedVersion: typeof r.saved_version === "number" ? r.saved_version : null,
    updatedAt: r.updated_at,
    terminalAt: isTs(r.terminal_at) ? r.terminal_at : null,
    nextCheckAt: isTs(r.next_check_at) ? r.next_check_at : null
  };
}

/** The bucket's rows (active + recent sent) with the counting columns. null = not installed. */
async function bucketCountRows(principal: ExecPrincipal, now: Date, signal: AbortSignal | undefined): Promise<CountRow[] | null> {
  const since = new Date(now.getTime() - DRAFT_LIMITS.recentSentDays * DAY_MS).toISOString();
  const rows = await pageAll(
    `${DRAFTS} count read`,
    () => sel(DRAFTS, COUNT_COLUMNS).eq("principal_id", principal.id)
      .or(`${ACTIVE_OR},and(status.in.(sent,sent_external),terminal_at.gte."${since}")`),
    ["id"],
    signal
  );
  if (rows === null) return null;
  const out: CountRow[] = [];
  for (const r of rows) {
    const c = countRow(r);
    if (c === null) throw new DraftStoreError(`exec drafts store: ${DRAFTS} count read failed: a row is malformed`, null, "fatal");
    out.push(c);
  }
  return out;
}

/** X1/X7: the Email tab's drafts card (EmailDraftsView.execDraftsActive / execDraftsAttention). null = not installed. */
export async function countDraftsForCard(principal: ExecPrincipal, opts: StoreOptions = {}): Promise<{ active: number; attention: number } | null> {
  const rows = await bucketCountRows(principal, new Date(), opts.signal);
  if (rows === null) return null;
  return {
    active: rows.filter((r) => isActiveDraft(r)).length,
    attention: rows.filter((r) => draftAttention(r) !== null).length
  };
}

export interface DraftSystemCounts { active: number; unknown: number; sentMismatch7d: number; goneUnconfirmed: number; generationFailed24h: number; restrictedLinked: number;
  /** The oldest next_check_at ≤ now (Y7 reconcile.overdueSince); null when nothing is due. */
  oldestDueAt: string | null }

/** Y7: the System card's counts. null = not installed. */
export async function countDraftsForSystem(principal: ExecPrincipal, now: Date, opts: StoreOptions = {}): Promise<DraftSystemCounts | null> {
  validNow(now);
  const rows = await bucketCountRows(principal, now, opts.signal);
  if (rows === null) return null;
  const dayAgo = now.getTime() - DAY_MS;
  const due = await earliestDueWithin(principal, now, 0, opts);
  return {
    active: rows.filter((r) => isActiveDraft(r)).length,
    unknown: rows.filter((r) => r.status === "unknown").length,
    sentMismatch7d: rows.filter((r) => r.status === "sent" && r.sentMismatch).length,
    goneUnconfirmed: rows.filter((r) => r.status === "gone" && r.goneUnconfirmed).length,
    generationFailed24h: rows.filter((r) => r.status === "generation_failed" && Date.parse(r.updatedAt) >= dayAgo).length,
    restrictedLinked: rows.filter((r) => isActiveDraft(r) && r.restrictedPurged && r.outlookGraphId !== null).length,
    oldestDueAt: due
  };
}

/** lowercased, bracket-less: the Internet Message-IDs of drafts sent from DD (the voice sample excludes them, C33). */
export async function listSentInternetMessageIds(principal: ExecPrincipal, sinceIso: string, opts: StoreOptions = {}): Promise<Set<string>> {
  if (!isTs(sinceIso)) refuse("sinceIso must be an ISO timestamp");
  const rows = await pageAll(
    `${DRAFTS} sent ids read`,
    () => sel(DRAFTS, "id,internet_message_id").eq("principal_id", principal.id).in("status", ["sent", "sent_external"])
      .not("internet_message_id", "is", null).gte("updated_at", sinceIso),
    ["id"],
    opts.signal
  );
  const out = new Set<string>();
  for (const r of rows ?? []) {
    if (typeof r.internet_message_id !== "string") continue;
    const id = r.internet_message_id.trim().toLowerCase().replace(/^<|>$/g, "");
    if (id) out.add(id);
  }
  return out;
}

/** C38: audit rows of `action` for the principal since `sinceIso` (the shape of email-assess.ts's recentAssessments). */
export async function countRecentAudit(principal: ExecPrincipal, action: string, sinceIso: string, opts: StoreOptions = {}): Promise<number> {
  if (typeof action !== "string" || action.length === 0 || action.length > 80) refuse("action is malformed");
  if (!isTs(sinceIso)) refuse("sinceIso must be an ISO timestamp");
  let query = sel(AUDIT, "id", { count: "exact", head: true }).eq("principal_id", principal.id).eq("action", action).gte("created_at", sinceIso);
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { count, error } = await query;
  if (error) throw failure(`${AUDIT} count`, error, opts.signal);
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new DraftStoreError(`exec drafts store: ${AUDIT} count failed: no count came back`, null, "retryable");
  }
  return count;
}

// --- exec_voice_profile (§2.1), camelCase ---------------------------------------------

export type VoiceProfileStatus = "ready" | "insufficient" | "failed";
export type VoiceFormality = "very_casual" | "casual" | "neutral" | "formal";
export type VoiceTypicalLength = "one_liner" | "short" | "medium" | "long";
export type VoiceGreeting = "none" | "hi_first_name" | "hey_first_name" | "hello_first_name" | "first_name_only" | "dear_name" | "mixed";
export type VoiceParagraphing = "single_block" | "short_paragraphs" | "many_short_lines";
export type VoiceBullets = "never" | "sometimes" | "often";
export type VoiceEmoji = "never" | "rarely" | "sometimes";
export type VoiceAttemptError = "declined" | "truncated" | "invalid_output" | "budget" | "input_too_large" | "read_failed" | "feed_unsupported";
/** camelCase mirror of exec_voice_profile: style enums and a short sign-off, no free text. A `ready` row has all six enums. */
export interface VoiceProfileRow {
  principalId: string;
  status: VoiceProfileStatus;
  formality: VoiceFormality | null;
  typicalLength: VoiceTypicalLength | null;
  greeting: VoiceGreeting | null;
  paragraphing: VoiceParagraphing | null;
  bullets: VoiceBullets | null;
  emoji: VoiceEmoji | null;
  /** ^[A-Za-z][A-Za-z ,.!'-]{0,39}$ (C34, lexicon-filtered) */
  signOff: string | null;
  /** 0..40 */
  sampleCount: number;
  /** sha256 hex of the sorted sample message ids, or null */
  samplesHash: string | null;
  /** 1..365, default 90 */
  windowDays: number;
  model: string | null;
  promptVersion: string;
  builtAt: string;
  lastAttemptAt: string | null;
  lastAttemptError: VoiceAttemptError | null;
  updatedAt: string;
}

const VOICE_COLUMNS: Readonly<Record<keyof VoiceProfileRow, string>> = Object.freeze({
  principalId: "principal_id", status: "status", formality: "formality", typicalLength: "typical_length", greeting: "greeting",
  paragraphing: "paragraphing", bullets: "bullets", emoji: "emoji", signOff: "sign_off", sampleCount: "sample_count",
  samplesHash: "samples_hash", windowDays: "window_days", model: "model", promptVersion: "prompt_version", builtAt: "built_at",
  lastAttemptAt: "last_attempt_at", lastAttemptError: "last_attempt_error", updatedAt: "updated_at"
});
const VOICE_FIELDS = Object.keys(VOICE_COLUMNS) as (keyof VoiceProfileRow)[];
const ALL_VOICE_COLUMNS = VOICE_FIELDS.map((f) => VOICE_COLUMNS[f]).join(",");
const VOICE_ENUMS: Readonly<Partial<Record<keyof VoiceProfileRow, readonly string[]>>> = {
  status: ["ready", "insufficient", "failed"],
  formality: ["very_casual", "casual", "neutral", "formal"],
  typicalLength: ["one_liner", "short", "medium", "long"],
  greeting: ["none", "hi_first_name", "hey_first_name", "hello_first_name", "first_name_only", "dear_name", "mixed"],
  paragraphing: ["single_block", "short_paragraphs", "many_short_lines"],
  bullets: ["never", "sometimes", "often"],
  emoji: ["never", "rarely", "sometimes"],
  lastAttemptError: ["declined", "truncated", "invalid_output", "budget", "input_too_large", "read_failed", "feed_unsupported"]
};

function voiceFromDb(raw: unknown): VoiceProfileRow {
  const bad = (column: string) => new DraftStoreError(`exec drafts store: ${VOICE} read failed: column ${column} is malformed`, null, "fatal");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw bad("row");
  const r = raw as Record<string, unknown>;
  const text = (f: keyof VoiceProfileRow) => { const v = r[VOICE_COLUMNS[f]]; if (typeof v !== "string") throw bad(VOICE_COLUMNS[f]); return v; };
  const textOrNull = (f: keyof VoiceProfileRow) => { const v = r[VOICE_COLUMNS[f]]; if (v !== null && typeof v !== "string") throw bad(VOICE_COLUMNS[f]); return v as string | null; };
  const int = (f: keyof VoiceProfileRow) => { const v = r[VOICE_COLUMNS[f]]; if (typeof v !== "number" || !Number.isSafeInteger(v)) throw bad(VOICE_COLUMNS[f]); return v; };
  const ts = (f: keyof VoiceProfileRow) => { const v = r[VOICE_COLUMNS[f]]; if (!isTs(v)) throw bad(VOICE_COLUMNS[f]); return v; };
  const tsOrNull = (f: keyof VoiceProfileRow) => { const v = r[VOICE_COLUMNS[f]]; if (v !== null && !isTs(v)) throw bad(VOICE_COLUMNS[f]); return v as string | null; };
  const en = <T extends string>(f: keyof VoiceProfileRow): T => {
    const v = r[VOICE_COLUMNS[f]];
    if (typeof v !== "string" || !(VOICE_ENUMS[f] ?? []).includes(v)) throw bad(VOICE_COLUMNS[f]);
    return v as T;
  };
  const enOrNull = <T extends string>(f: keyof VoiceProfileRow): T | null => (r[VOICE_COLUMNS[f]] === null ? null : en<T>(f));
  return {
    principalId: text("principalId"),
    status: en<VoiceProfileStatus>("status"),
    formality: enOrNull<VoiceFormality>("formality"),
    typicalLength: enOrNull<VoiceTypicalLength>("typicalLength"),
    greeting: enOrNull<VoiceGreeting>("greeting"),
    paragraphing: enOrNull<VoiceParagraphing>("paragraphing"),
    bullets: enOrNull<VoiceBullets>("bullets"),
    emoji: enOrNull<VoiceEmoji>("emoji"),
    signOff: textOrNull("signOff"),
    sampleCount: int("sampleCount"),
    samplesHash: textOrNull("samplesHash"),
    windowDays: int("windowDays"),
    model: textOrNull("model"),
    promptVersion: text("promptVersion"),
    builtAt: ts("builtAt"),
    lastAttemptAt: tsOrNull("lastAttemptAt"),
    lastAttemptError: enOrNull<VoiceAttemptError>("lastAttemptError"),
    updatedAt: ts("updatedAt")
  };
}

/** not installed → null */
export async function getVoiceProfile(principal: ExecPrincipal, opts: StoreOptions = {}): Promise<VoiceProfileRow | null> {
  let query = sel(VOICE, ALL_VOICE_COLUMNS).eq("principal_id", principal.id);
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { data, error } = await query.maybeSingle();
  if (error) {
    if (isNotInstalled(error)) return null;
    throw failure(`${VOICE} read`, error, opts.signal);
  }
  return data === null ? null : voiceFromDb(data);
}

/** Replace the principal's profile (one row per principal; updated_at = now). Not installed throws: the voice job runs only once the schema is ready. */
export async function upsertVoiceProfile(principal: ExecPrincipal, row: Omit<VoiceProfileRow, "principalId" | "updatedAt">, opts: StoreOptions = {}): Promise<void> {
  const payload: Record<string, unknown> = { principal_id: principal.id, updated_at: new Date().toISOString() };
  for (const f of VOICE_FIELDS) {
    if (f === "principalId" || f === "updatedAt") continue;
    if (!(f in row)) refuse(`voice profile is missing ${f}`);
    payload[VOICE_COLUMNS[f]] = (row as unknown as Record<string, unknown>)[f];
  }
  let query = db().from(VOICE).upsert(payload, { onConflict: "principal_id" }).select("principal_id");
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { error } = await query;
  if (error) throw failure(`${VOICE} upsert`, error, opts.signal);
}

/**
 * P5a (contract §3.14.2b, C20, K12): delete the principal's voice profile
 * (the Settings "Reset"; the weekly voice job builds a new one). true = his
 * row was deleted, false = he had none, null when the table is missing (as
 * getVoiceProfile). Any other error throws. This module stays the only
 * writer of the voice profile table.
 */
export async function resetVoiceProfile(principal: ExecPrincipal, opts: StoreOptions = {}): Promise<boolean | null> {
  let query = db().from(VOICE).delete().eq("principal_id", principal.id).select("principal_id");
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { data, error } = await query;
  if (error) {
    if (isNotInstalled(error)) return null;
    throw failure(`${VOICE} delete`, error, opts.signal);
  }
  return Array.isArray(data) && data.length > 0;
}

// ---------------------------------------------------------------------------
// P5b (contract §3.23 F8; Area F): the chat-draft purge by id
// ---------------------------------------------------------------------------

/**
 * F8 (C20, b-security-6): RPC 5 exec_drafts_purge_by_ids (P4's restricted purge applied by id, origin = 'chat' rows only)
 * in chunks of 200. null when the function is missing (PGRST202 / 42883: P5b not installed); any other error throws.
 * Callers: email-store.ts's tombstone procedure, handlers/email-attention.ts's safety net and agent/turn.ts's post-finish
 * screen (F11). Ids are checked (`ed_` + 32 hex) and de-duplicated before any call; an empty list is 0 with no call.
 * The RPC's own WHERE keeps it to his origin = 'chat' rows not yet purged, so a card that points at a web draft
 * (existing: true) never purges it, and a second call counts 0.
 */
export async function purgeDraftsByIds(principal: ExecPrincipal, draftIds: readonly string[], opts: StoreOptions = {}): Promise<number | null> {
  if (!Array.isArray(draftIds)) refuse("draftIds must be a list");
  const ids = [...new Set(draftIds.map((id) => checkDraftId(id)))];
  if (ids.length === 0) return 0;
  let purged = 0;
  for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
    opts.signal?.throwIfAborted();
    let query = db().rpc("exec_drafts_purge_by_ids", { p_principal: principal.id, p_draft_ids: ids.slice(i, i + WRITE_CHUNK) });
    if (opts.signal) query = query.abortSignal(opts.signal);
    const { data, error } = await query;
    if (error) {
      if (isNotInstalled(error)) return null;
      throw failure("exec_drafts_purge_by_ids", error, opts.signal);
    }
    if (typeof data !== "number" || !Number.isSafeInteger(data) || data < 0) {
      throw new DraftStoreError("exec drafts store: exec_drafts_purge_by_ids failed: the answer is not a count", null, "retryable");
    }
    purged += data;
  }
  return purged;
}
