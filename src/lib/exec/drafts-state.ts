import { createHash, randomBytes } from "node:crypto";

import type { CloneDeleted, CloneDraftRead, CloneEaError, CloneEaErrorKind, CloneReadBack } from "@/lib/exec/clone-ea-types";
import {
  ACTIVE_DRAFT_STATUSES,
  DRAFT_LIMITS,
  REVIEW_BLOCKERS,
  TERMINAL_DRAFT_STATUSES,
  type CloneDraftStatus,
  type CloneFlag,
  type DraftAttention,
  type DraftCapabilities,
  type DraftErrorCode,
  type ExecDraftRow,
  type ExecDraftStatus,
  type GenerationFlag,
  type PriorStatus,
  type ReplyMode,
  type ResolveAction,
  type ReviewBlocker,
  type SendUnavailable,
  type SentCopyResult
} from "@/lib/exec/drafts-types";
import type { HisMessage, PrincipalMailThread, ReplyArtifacts } from "@/lib/exec/email-types";
import type { RecipientError } from "@/lib/exec/recipients";
import { NonRetryableError } from "@/lib/exec/types";

// The pure state machine of exec_drafts (P4 contract §2.4-§2.6, §3.6; Area A).
//
// Pure apart from newKeyNonce: every function maps a row, a clone answer and a
// clock to a Transition { to, patch, code, alert, reviewCleared } whose patch
// is the snake_case column patch the store applies under a CAS. Nothing here
// touches the database, the clone or the clock.
//
// Rules this module keeps:
//   * draftStatus outranks HTTP (§2.6): an error that carries one goes through
//     mirrorRegistry for the row's source status; the error kind then picks
//     only the code, the review handling and the alert.
//   * mirrorRegistry never writes content_hash (C66): a read he didn't see
//     refreshes observed_content_hash. The one exception is the replay's
//     re-GET of a `saving` row, which is T18/T19 by another path: the link,
//     saved_version and the content hash are written in the same CAS.
//   * A 404 near a send is never "not sent" (ST11): a send answer this module
//     can't place maps to `unknown`, never to `saved`.
//   * Every patch, applied to its source row, satisfies §2.1's CHECKs (ST16).
//
// Lifecycle columns a patch may carry: status, prior_status, terminal_at,
// expires_at, gone_at, gone_unconfirmed, next_check_at, updated_at. Retention
// (expires_at = terminal_at + retention_days_email) comes from the caller's
// settings through the optional `opts.retentionDays`; 180 when absent.

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const DEFAULT_RETENTION_DAYS = 180;
const KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const CLONE_FLAGS: readonly CloneFlag[] = ["send_status_unknown", "not_found_after_send", "verify_overdue", "create_unconfirmed",
  "gone_unconfirmed", "unverified", "signature_skipped"];
const LINKED_STATUSES: readonly ExecDraftStatus[] = ["saved", "sending", "sent_pending", "unknown", "discarding", "sent", "sent_external", "gone"];
/** C48 (b): a sibling draft on the same parent in one of these may have sent, or did. */
const SIBLING_SENT_STATUSES: readonly ExecDraftStatus[] = ["sending", "sent_pending", "unknown", "sent", "sent_external", "gone"];
/** S1 (§2.4): offsets from the anchor by check_count. */
const S1_MS = [20_000, 40_000, 60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000, 3_600_000];
const HOUR_MS = 3_600_000;

const RESOLVE_ACTIONS: readonly ResolveAction[] = ["check", "mark_sent", "not_sent_new_draft", "copy_to_new_draft", "keep_outlook_version", "stop_generation"];

export interface TransitionOptions {
  /** exec_settings.retention_days_email of the principal; 180 when absent. */
  retentionDays?: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString();
const plus = (now: Date, ms: number) => iso(now.getTime() + ms);
function toMs(v: string | null | undefined): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
const isCloneFlag = (v: string): v is CloneFlag => (CLONE_FLAGS as readonly string[]).includes(v);
/** The flags DD knows, deduplicated (exported for the review patch, data-1). */
export const knownFlags = (flags: readonly string[]): CloneFlag[] => [...new Set(flags.filter(isCloneFlag))];
const daysOf = (opts: TransitionOptions | undefined) => {
  const d = opts?.retentionDays;
  return typeof d === "number" && Number.isFinite(d) && d >= 1 ? Math.floor(d) : DEFAULT_RETENTION_DAYS;
};

export function isTerminalStatus(s: ExecDraftStatus): boolean {
  return TERMINAL_DRAFT_STATUSES.includes(s);
}
/** = the unique index predicate (§2.1): the non-terminal statuses, plus gone while unconfirmed. */
export function isActiveDraft(row: Pick<ExecDraftRow, "status" | "goneUnconfirmed">): boolean {
  return ACTIVE_DRAFT_STATUSES.includes(row.status) || (row.status === "gone" && row.goneUnconfirmed);
}
export function hasLink(row: Pick<ExecDraftRow, "outlookGraphId">): boolean {
  return row.outlookGraphId !== null;
}
/** A link whose Outlook draft is older than DD's text (§2.4 draft): linked and version > saved_version. */
export function isStaleLink(row: Pick<ExecDraftRow, "outlookGraphId" | "version" | "savedVersion">): boolean {
  return row.outlookGraphId !== null && (row.savedVersion === null || row.version > row.savedVersion);
}
/** C66: a background read saw a hash that differs from the one he was shown or DD's save produced. */
export function changedSinceSaved(row: Pick<ExecDraftRow, "contentHash" | "observedContentHash">): boolean {
  return row.contentHash !== null && row.observedContentHash !== null && row.contentHash !== row.observedContentHash;
}
/**
 * C76: where a discard (or a regenerate) started, as the row returns to it: a
 * `saved` prior becomes `draft` when the Outlook draft no longer holds the
 * current version (saved_version != version) on an unpurged row. A row without
 * a recorded prior (a programming error the CHECK forbids) falls back on its
 * link: linked and current -> saved, else draft.
 */
export function priorStatusOf(row: Pick<ExecDraftRow, "priorStatus" | "savedVersion" | "version" | "restrictedPurged" | "outlookGraphId">): PriorStatus {
  const prior = row.priorStatus;
  if (prior === "saved") return row.savedVersion !== row.version && !row.restrictedPurged ? "draft" : "saved";
  if (prior !== null) return prior;
  return row.outlookGraphId !== null && row.savedVersion === row.version ? "saved" : "draft";
}

/** randomBytes(12).toString("base64url"): 16 characters; tests mock it. */
export function newKeyNonce(): string {
  return randomBytes(12).toString("base64url");
}
/** sha256 hex, first 16 (C3's gfp16). */
export function graphIdFp(graphId: string): string {
  return createHash("sha256").update(graphId, "utf8").digest("hex").slice(0, 16);
}
/** `${id}:v${version}:save:${nonce}` */
export function saveKey(draftId: string, version: number, nonce: string): string {
  return `${draftId}:v${version}:save:${nonce}`;
}
/** `${id}:g${graphIdFp(g)}:delete:${nonce}` (C3: never the graphId itself, §1.3 K2) */
export function deleteKey(draftId: string, graphId: string, nonce: string): string {
  return `${draftId}:g${graphIdFp(graphId)}:delete:${nonce}`;
}
/** `${id}:v${version}:send:${nonce}` */
export function sendKey(draftId: string, version: number, nonce: string): string {
  return `${draftId}:v${version}:send:${nonce}`;
}
/** Throws NonRetryableError unless ^[A-Za-z0-9_.:-]{1,128}$ (CL2C §3.0.3). */
export function assertKeyShape(key: string): void {
  if (typeof key !== "string" || !KEY_RE.test(key)) throw new NonRetryableError("exec drafts: idempotency key is malformed");
}

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

/** A snake_case column patch for exec_drafts; built only in this module. */
export type DraftPatch = Readonly<Record<string, unknown>>;
export type OpsAlertCode = "draft-sent-mismatch" | "draft-send-unknown" | "clone-ea-auth" | "clone-ea-bug"
  | "draft-registry-missing" | "clone-anomaly";
export interface Transition {
  to: ExecDraftStatus; patch: DraftPatch; code: string | null; alert: OpsAlertCode | null; reviewCleared: boolean;
}

/** "Review cleared" (§2.5): the four review columns reset. */
export const REVIEW_CLEARED_PATCH: DraftPatch = Object.freeze({ review_hash: null, review_at: null, review_blockers: [], review_recipients: null });

/** snake_case column -> camelCase field (the inverse of drafts-store's DRAFT_COLUMNS, kept here so the module stays pure). */
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** The row a patch produces (snake_case keys applied to the camelCase row). Used by nextCheckAt chaining and by tests. */
export function applyDraftPatch(row: ExecDraftRow, patch: DraftPatch): ExecDraftRow {
  const out: Record<string, unknown> = { ...row };
  for (const [column, value] of Object.entries(patch)) out[camel(column)] = Array.isArray(value) ? [...value] : value;
  return out as unknown as ExecDraftRow;
}

const REVIEW_COLUMNS = ["review_hash", "review_at", "review_blockers", "review_recipients"] as const;
function withoutReview(patch: DraftPatch): Record<string, unknown> {
  const out: Record<string, unknown> = { ...patch };
  for (const c of REVIEW_COLUMNS) delete out[c];
  return out;
}

/**
 * The lifecycle columns of a status change (§2.5 "Terminal"): terminal_at /
 * expires_at set on entering a terminal status and cleared on leaving one,
 * gone_at and gone_unconfirmed cleared when the target isn't gone,
 * prior_status cleared unless the target records one, next_check_at nulled
 * on terminal targets other than an unconfirmed gone.
 */
function statusPatch(row: ExecDraftRow, to: ExecDraftStatus, now: Date, days: number): Record<string, unknown> {
  const nowIso = now.toISOString();
  const p: Record<string, unknown> = { status: to, updated_at: nowIso };
  const wasTerminal = isTerminalStatus(row.status);
  const willBeTerminal = isTerminalStatus(to);
  if (to === "gone") {
    if (row.status !== "gone") {
      p.gone_unconfirmed = true;
      p.gone_at = nowIso;
      p.terminal_at = nowIso;
      p.expires_at = plus(now, days * DAY_MS);
      p.next_check_at = plus(now, DRAFT_LIMITS.goneRecheckMs[0]);
      p.check_count = 0;
    }
  } else {
    p.gone_unconfirmed = false;
    if (row.status === "gone" || row.goneAt !== null) p.gone_at = null;
    if (willBeTerminal) {
      p.terminal_at = nowIso;
      p.expires_at = plus(now, days * DAY_MS);
      p.next_check_at = null;
    } else if (wasTerminal) {
      p.terminal_at = null;
      p.expires_at = null;
    }
  }
  if (to !== "generating" && to !== "discarding") p.prior_status = null;
  return p;
}

/** Terminal by DD's own hand (T36, T42, T46, T50, T51, T57): the status plus its lifecycle columns, review cleared. */
export function terminalPatch(row: ExecDraftRow, to: "sent" | "sent_external" | "discarded", now: Date, opts?: TransitionOptions): DraftPatch {
  return { ...statusPatch(row, to, now, daysOf(opts)), ...REVIEW_CLEARED_PATCH };
}

/** The fields a read refreshes on the row (observed only, C66; a registry view carries no content hash). */
function readRefresh(read: CloneDraftRead | null): Record<string, unknown> {
  if (read === null) return {};
  const p: Record<string, unknown> = {};
  if (read.live) {
    p.observed_content_hash = read.contentHash;
    if (read.conversationId !== null) p.conversation_id = read.conversationId;
  }
  if (read.internetMessageId !== null) p.internet_message_id = read.internetMessageId;
  if (read.webLink !== null) p.web_link = read.webLink;
  return p;
}

/** The link columns of a read-back (T18/T19 and the replay's re-GET of a saving row): the one place content_hash is written from a read. */
function linkPatch(row: ExecDraftRow, read: CloneDraftRead, flags: readonly CloneFlag[]): Record<string, unknown> {
  const p: Record<string, unknown> = {
    outlook_graph_id: read.graphId,
    internet_message_id: read.internetMessageId,
    web_link: read.webLink,
    saved_version: row.saveVersion ?? row.version,
    signature_skipped: flags.includes("signature_skipped"),
    clone_flags: [...flags],
    outlook_edited: false,
    // opened_in_outlook_at is kept (data-4, L13): a compose window for the replaced draft may still be open,
    // so the next review keeps the opened_in_outlook blocker; next_check_at = null stops the C69 follow-ups.
    last_error_code: null
  };
  if (read.live) {
    p.conversation_id = read.conversationId;
    p.content_hash = read.contentHash;
    p.observed_content_hash = read.contentHash;
  }
  return p;
}

function errorPatch(code: string | null, now: Date): Record<string, unknown> {
  return code === null ? {} : { last_error_code: code, last_error_at: now.toISOString() };
}

const transition = (to: ExecDraftStatus, patch: Record<string, unknown>, code: string | null, alert: OpsAlertCode | null, reviewCleared: boolean): Transition =>
  ({ to, patch: Object.freeze({ ...patch }), code, alert, reviewCleared });

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

const DRAFT_ERROR_CODES = ["not_found", "forbidden", "bad_request", "invalid", "drafts_off", "send_off", "drafts_unavailable",
  "send_unavailable", "rate_limited", "version_conflict", "state_conflict", "review_required", "review_expired", "acks_missing",
  "recipients_blocked", "placeholders", "empty_body", "unsafe_markup", "instruction_required", "subject_required",
  "thread_unavailable", "mailbox_problem", "audit_unavailable", "unavailable", "hold", "sent_copy_found", "private_refs_unconfirmed"] as const;
const CLONE_KINDS = ["auth", "send_disabled", "mailbox_not_connected", "bad_request", "not_found", "gone", "changed", "already_sending",
  "already_sent", "sent_externally", "parent_missing", "idempotency_mismatch", "throttled", "mailbox_reconnect", "graph_error",
  "not_ready", "graph_timeout", "server_error", "edge", "unknown_code", "invalid_body", "transport", "timeout"] as const;
const RECIPIENT_ERRORS = ["empty_to", "invalid_address", "own_address", "no_reply_address", "restricted_recipient", "too_many",
  "not_allowed", "to_not_derived", "bcc_on_reply", "from_mismatch", "sender_mismatch", "reply_to_restricted", "facts_recipient"] as const;
/** §2.6 and §3.12 codes (last_error_code and response codes) that aren't already a DraftErrorCode or a clone kind. */
const STATE_CODES = ["outcome_unknown", "mailbox_not_connected", "ea_auth", "thread_not_found", "account_not_found",
  "parent_missing", "idempotency_mismatch", "throttled", "mailbox_reconnect", "graph_error", "clone_not_ready", "timeout",
  "clone_error", "outlook_changed", "recreate_failed", "not_in_registry", "accepted", "changed", "already_sending",
  "already_sent", "sent_externally", "clone_anomaly", "send_disabled", "gone", "timeout_nothing_sent", "transport",
  "outlook_not_found", "outlook_unknown", "outlook_unknown_restricted", "outlook_reappeared", "expired_idle",
  "generation_stopped", "not_saved", "follow_replacement"] as const;
const GENERATION_ERRORS = ["declined", "truncated", "invalid_output", "budget", "input_too_large", "thread_unavailable", "restricted",
  "model_error", "timeout", "stale", "stopped"] as const;
// Exhaustiveness: a union member missing from its list is a type error here.
type MissingDraftError = Exclude<DraftErrorCode, (typeof DRAFT_ERROR_CODES)[number]>;
type MissingKind = Exclude<CloneEaErrorKind, (typeof CLONE_KINDS)[number]>;
type MissingRecipient = Exclude<RecipientError, (typeof RECIPIENT_ERRORS)[number]>;
const exhaustive: [MissingDraftError, MissingKind, MissingRecipient] extends [never, never, never] ? true : never = true;
void exhaustive;

const KNOWN_CODES: ReadonlySet<string> = new Set<string>([
  ...DRAFT_ERROR_CODES, ...CLONE_KINDS, ...RECIPIENT_ERRORS, ...STATE_CODES,
  ...GENERATION_ERRORS.map((g) => `generation_${g}`)
]);

/**
 * BD14: an audit `error` is a string literal or auditCode(x): x when it is a
 * DraftErrorCode, a CloneEaErrorKind, a §2.6 last_error_code or a RecipientError;
 * otherwise "other". Never free text.
 */
export function auditCode(x: unknown): string {
  return typeof x === "string" && KNOWN_CODES.has(x) ? x : "other";
}

/** The §2.6 code an error kind reads as, per route family. */
function kindCode(kind: CloneEaErrorKind, route: "create_reply" | "create_new" | "recreate" | "delete" | "get" | "send"): string {
  switch (kind) {
    case "auth": return "ea_auth";
    case "send_disabled": return "send_disabled";
    case "mailbox_not_connected": return "mailbox_not_connected";
    case "bad_request": return "bad_request";
    case "not_found":
      if (route === "create_reply") return "thread_not_found";
      if (route === "create_new") return "account_not_found";
      if (route === "send") return "clone_anomaly";
      return "not_in_registry";
    case "gone": return "gone";
    case "changed": return route === "send" ? "changed" : "outlook_changed";
    case "already_sending": return "already_sending";
    case "already_sent": return "already_sent";
    case "sent_externally": return "sent_externally";
    case "parent_missing": return route === "send" ? "clone_anomaly" : "parent_missing";
    case "idempotency_mismatch": return "idempotency_mismatch";
    case "throttled": return "throttled";
    case "mailbox_reconnect": return "mailbox_reconnect";
    case "graph_error": return "graph_error";
    case "not_ready": return "clone_not_ready";
    case "graph_timeout": return "timeout";
    case "server_error": return "clone_error";
    case "transport": return route === "send" ? "transport" : "outcome_unknown";
    case "timeout": return route === "send" ? "transport" : "outcome_unknown";
    case "edge":
    case "invalid_body":
    case "unknown_code":
      return route === "send" || route === "get" ? "clone_anomaly" : "outcome_unknown";
  }
}

function kindAlert(kind: CloneEaErrorKind, route: "create" | "delete" | "get"): OpsAlertCode | null {
  switch (kind) {
    case "auth":
    case "mailbox_reconnect":
      return "clone-ea-auth";
    case "bad_request":
    case "idempotency_mismatch":
      return "clone-ea-bug";
    case "not_found":
      return route === "create" ? null : "draft-registry-missing";
    case "graph_error":
    case "unknown_code":
    case "invalid_body":
    case "edge":
      return "clone-anomaly";
    case "already_sending":
    case "already_sent":
    case "sent_externally":
      return route === "create" || route === "delete" ? "clone-anomaly" : null;
    default:
      return null;
  }
}

/** The four failures that aren't an answer from the clone (K20, K22-K24) and a code the table doesn't list. */
const NO_ANSWER_KINDS: ReadonlySet<CloneEaErrorKind> = new Set<CloneEaErrorKind>(["edge", "invalid_body", "transport", "timeout", "unknown_code"]);

// ---------------------------------------------------------------------------
// Guards and capabilities (§3.12.2 G11, §3.13.4, C13, C24, C70, C71, C76)
// ---------------------------------------------------------------------------

export type DraftAction = "edit" | "regenerate" | "save" | "review" | "send" | "discard" | "delete_restricted"
  | "outlook_opened" | `resolve:${ResolveAction}`;
export interface GuardContext {
  now: Date;
  /** settings + pin (C25) */
  draftsOn: boolean;
  /** send_enabled */
  sendOn: boolean;
  /** EA readiness (C24) */
  draftsReady: boolean;
  /** send readiness (L1) */
  sendReady: boolean;
  /** the render-time screen (C11) */
  restricted: boolean;
  checkedOutlook?: boolean;
  sentCopy?: SentCopyResult;
}

type GuardResult = { ok: true } | { ok: false; code: DraftErrorCode };
const OK: GuardResult = Object.freeze({ ok: true });
const refuse = (code: DraftErrorCode): GuardResult => ({ ok: false, code });

/** C68: the owner resolution of `unknown` opens 30 min after send_started_at; a row with none counts as past the horizon. */
export function pastSendHorizon(row: Pick<ExecDraftRow, "sendStartedAt">, now: Date): boolean {
  const started = toMs(row.sendStartedAt);
  return started === null || now.getTime() - started >= DRAFT_LIMITS.sendHorizonMs;
}

/** C76: a row whose send outcome is in doubt never gets a save, review or send from the same row. */
function sendInDoubt(row: ExecDraftRow): boolean {
  return row.cloneFlags.includes("send_status_unknown") || row.ownerResolution !== null;
}

/**
 * G11. Refuses with the first applicable code, in the routes' order: the
 * render-time screen (not_found, C13 lists the actions a restricted row
 * keeps), the switches (drafts_off / send_off), readiness
 * (drafts_unavailable / send_unavailable for the actions that call the clone,
 * C24), then the row's status and flags (state_conflict), C76, and the
 * action's own guards (review validity, the owner-resolution horizon and
 * checkbox, the sent-copy check).
 */
export function guard(action: DraftAction, row: ExecDraftRow, ctx: GuardContext): GuardResult {
  const restricted = ctx.restricted || row.restrictedPurged;
  const linked = hasLink(row);
  const s = row.status;

  if (restricted) {
    // C13: Delete on a linked saved/draft row; Check again, "It was sent" and
    // "It wasn't sent" (no successor) on unknown; nothing else.
    const allowed =
      (action === "delete_restricted" && linked && (s === "saved" || s === "draft")) ||
      ((action === "resolve:check" || action === "resolve:mark_sent" || action === "resolve:not_sent_new_draft") && s === "unknown");
    if (!allowed) return refuse("not_found");
  } else if (action === "delete_restricted") {
    return refuse("state_conflict");
  }

  const needsDraftsOn = action !== "discard" && action !== "delete_restricted" && action !== "outlook_opened";
  if (needsDraftsOn && !ctx.draftsOn) return refuse("drafts_off");
  if ((action === "send" || action === "review") && !ctx.sendOn) return refuse("send_off");

  const callsClone =
    action === "regenerate" || action === "save" || action === "review" || action === "send" || action === "delete_restricted" ||
    (action === "discard" && linked) ||
    action === "resolve:not_sent_new_draft" || action === "resolve:keep_outlook_version" || action === "resolve:check" ||
    (action === "resolve:copy_to_new_draft" && linked);
  if (callsClone && !ctx.draftsReady) return refuse("drafts_unavailable");
  if ((action === "send" || action === "review") && !ctx.sendReady) return refuse("send_unavailable");

  switch (action) {
    case "edit":
    case "regenerate":
      return s === "draft" || s === "saved" || s === "generation_failed" ? OK : refuse("state_conflict");
    case "save":
      if (s !== "draft") return refuse("state_conflict");
      return sendInDoubt(row) ? refuse("state_conflict") : OK;
    case "review":
      if (s !== "saved" || !linked || row.savedVersion !== row.version) return refuse("state_conflict");
      return sendInDoubt(row) ? refuse("state_conflict") : OK;
    case "send": {
      if (s !== "saved" || !linked || row.savedVersion !== row.version) return refuse("state_conflict");
      if (sendInDoubt(row)) return refuse("state_conflict");
      if (row.reviewHash === null || row.reviewAt === null) return refuse("review_required");
      const reviewAt = toMs(row.reviewAt) ?? 0;
      if (ctx.now.getTime() - reviewAt > DRAFT_LIMITS.reviewTtlMs) return refuse("review_expired");
      const opened = toMs(row.openedInOutlookAt);
      if (opened !== null && opened > reviewAt) return refuse("review_required");
      return OK;
    }
    case "discard":
      return s === "draft" || s === "saved" || s === "generation_failed" ? OK : refuse("state_conflict");
    case "delete_restricted":
      return OK; // the restricted branch above already required linked saved/draft
    case "outlook_opened":
      if (!linked) return refuse("state_conflict");
      return s === "saved" || s === "draft" || s === "unknown" || s === "sent_pending" ? OK : refuse("state_conflict");
    case "resolve:mark_sent":
      if (s === "unknown") {
        if (!pastSendHorizon(row, ctx.now)) return refuse("hold");
      } else if (s !== "gone" || row.lastErrorCode === "outlook_reappeared") return refuse("state_conflict");
      if (ctx.sentCopy === "found") return refuse("sent_copy_found");
      return ctx.checkedOutlook === true ? OK : refuse("hold");
    case "resolve:not_sent_new_draft":
      if (s !== "unknown") return refuse("state_conflict");
      if (!pastSendHorizon(row, ctx.now)) return refuse("hold");
      if (ctx.sentCopy === "found") return refuse("sent_copy_found");
      return ctx.checkedOutlook === true ? OK : refuse("hold");
    case "resolve:copy_to_new_draft": {
      // An older Outlook draft that reappeared holds the thread (§2.6.0 gone -> saved lost its CAS): he deletes it in Outlook first.
      // A row already copied (T45 records `copied`) offers no second copy (data-7).
      if (s !== "gone" || row.lastErrorCode === "outlook_reappeared" || row.lastErrorCode === "copied") return refuse("state_conflict");
      const r = canOfferNewReply(row, { sentCopy: ctx.sentCopy ?? "unsupported", checkedOutlook: ctx.checkedOutlook === true, now: ctx.now });
      return r.ok ? OK : refuse(r.code);
    }
    case "resolve:keep_outlook_version":
      if ((s !== "draft" && s !== "saved") || !linked) return refuse("state_conflict");
      return row.lastErrorCode === "outlook_changed" || changedSinceSaved(row) ? OK : refuse("state_conflict");
    case "resolve:check":
      if (!linked) return refuse("state_conflict");
      if (s === "saved" || s === "draft" || s === "unknown" || s === "sent_pending") return OK;
      return s === "gone" && row.goneUnconfirmed ? OK : refuse("state_conflict");
    case "resolve:stop_generation":
      return s === "generating" ? OK : refuse("state_conflict");
  }
}

/**
 * The buttons of §3.13.4, from the guards: each capability is the guard's
 * verdict with the owner's checkbox assumed ticked (the panel shows it next to
 * every action that needs it). canEdit also needs readiness and the switch:
 * the "drafts unavailable" row renders a read-only preview. canOpenInOutlook
 * needs a web link to open. draftsUnavailable / sendUnavailable pass through.
 */
export function capabilitiesFor(row: ExecDraftRow, ctx: GuardContext & {
  draftsUnavailable: DraftCapabilities["draftsUnavailable"]; sendUnavailable: SendUnavailable | null }): DraftCapabilities {
  const assumed: GuardContext = { ...ctx, checkedOutlook: true };
  const ok = (a: DraftAction) => guard(a, row, assumed).ok;
  if (!ctx.draftsReady || !ctx.draftsOn) {
    // §3.13.4 "drafts unavailable": a read-only preview and Discard for a DD-only row; nothing else.
    return {
      canEdit: false, canRegenerate: false, canSave: false, canReview: false,
      canDiscard: !hasLink(row) && ok("discard"),
      canDeleteRestricted: false, canOpenInOutlook: false, resolve: [],
      draftsUnavailable: ctx.draftsUnavailable, sendUnavailable: ctx.sendUnavailable
    };
  }
  return {
    canEdit: ok("edit") && ctx.draftsReady && ctx.draftsOn,
    canRegenerate: ok("regenerate"),
    canSave: ok("save"),
    canReview: ok("review"),
    canDiscard: ok("discard"),
    canDeleteRestricted: ok("delete_restricted"),
    canOpenInOutlook: ok("outlook_opened") && row.webLink !== null,
    resolve: RESOLVE_ACTIONS.filter((a) => ok(`resolve:${a}`)),
    draftsUnavailable: ctx.draftsUnavailable,
    sendUnavailable: ctx.sendUnavailable
  };
}

// ---------------------------------------------------------------------------
// §2.6.0: the registry mirror
// ---------------------------------------------------------------------------

/**
 * §2.6.0. Never writes content_hash (C66): a refreshed read-back hash goes to
 * observed_content_hash. The replay's re-GET of a `saving` row is T18/T19 by
 * another path and writes the link, saved_version and both hashes in one CAS.
 * A patch that leaves the status alone still carries the read's refresh and
 * the mirrored flags. `review cleared` on every status change; an unchanged
 * status keeps its review.
 */
export function mirrorRegistry(row: ExecDraftRow,
  clone: { status: CloneDraftStatus; flags: readonly string[]; read: CloneDraftRead | null; replacedBy?: string | null }, now: Date,
  opts?: TransitionOptions): Transition {
  const days = daysOf(opts);
  const src = row.status;
  const read = clone.read;
  const live = read !== null && read.live ? read : null;
  // Flags are authoritative when they come with a read (or are non-empty); an error body carries none.
  const flags = read !== null || clone.flags.length > 0 ? knownFlags(clone.flags) : [...row.cloneFlags];
  const refresh = readRefresh(read);
  const flagsPatch = read !== null ? { clone_flags: flags } : {};
  const settled = src === "sent" || src === "sent_external" || src === "discarded";
  const nowIso = now.toISOString();

  const unchanged = (code: string | null = null, alert: OpsAlertCode | null = null): Transition =>
    transition(src, { ...refresh, ...flagsPatch, ...errorPatch(code === "clone_anomaly" ? code : null, now), updated_at: nowIso }, code, alert, false);
  // The link a target that needs one takes: the row's, else the read's (a saving row), else nowhere to go.
  const link = (): Record<string, unknown> | null => {
    if (src === "saving" && read !== null) return linkPatch(row, read, flags);
    if (row.outlookGraphId !== null) return {};
    return null;
  };
  const move = (to: ExecDraftStatus, extra: Record<string, unknown>, code: string | null = null, alert: OpsAlertCode | null = null): Transition => {
    const needs = LINKED_STATUSES.includes(to) ? link() : {};
    if (needs === null) return transition(src, { ...errorPatch("clone_anomaly", now), updated_at: nowIso }, "clone_anomaly", "clone-anomaly", false);
    const base = { ...statusPatch(row, to, now, days), ...refresh, ...flagsPatch, ...needs, ...REVIEW_CLEARED_PATCH, ...extra };
    const next = applyDraftPatch(row, base);
    const patch = { ...base, next_check_at: "next_check_at" in extra ? extra.next_check_at : nextCheckAt(next, now, "ok") };
    return transition(to, patch, code, alert, true);
  };

  if (settled) {
    // Nothing moves a row out of sent, sent_external or discarded (§2.5); a sent row learns of a mismatch.
    if (src === "sent" && clone.status === "sent_mismatch" && !row.sentMismatch) {
      return transition(src, { ...refresh, ...flagsPatch, sent_mismatch: true, updated_at: nowIso }, null, "draft-sent-mismatch", false);
    }
    return unchanged();
  }

  switch (clone.status) {
    case "saved": {
      if (flags.includes("send_status_unknown")) {
        // C68: the genuinely ambiguous send, from any source; send_started_at kept.
        return src === "unknown" ? unchanged() : move("unknown", {});
      }
      if (src === "sending" || src === "unknown") {
        // C15: the clone's single-flight proves nothing was sent.
        return move("saved", { last_error_code: null });
      }
      if (src === "discarding") return move(priorStatusOf(row), {});
      if (src === "gone") {
        // The draft reappeared: back to what the link held before it went gone (data-2, the rule priorStatusOf
        // applies): saved only when the Outlook draft holds the current version, else a stale-link draft.
        if (live !== null && live.isDraft) {
          return move(row.savedVersion === row.version && !row.restrictedPurged ? "saved" : "draft", { last_error_code: null });
        }
        return unchanged();
      }
      if (src === "saving") {
        // A read-back: the replay's T18/T19. An error-carried `saved` means the old draft is still there and the
        // save never landed (T21, the GET resolution's "200 saved"): back to draft with the old link kept.
        if (read !== null) return move("saved", { next_check_at: null });
        if (row.outlookGraphId !== null) return move("draft", {});
        return move("saved", {}); // no link anywhere: the anomaly row
      }
      if (src === "sent_pending") return unchanged("clone_anomaly", "clone-anomaly");
      return unchanged();
    }
    case "sending":
    case "unknown":
      if (src === "gone") return unchanged();
      return src === "unknown" ? unchanged() : move("unknown", {});
    case "sent_pending_verification":
      if (src === "gone") return unchanged();
      if (src === "sent_pending") return unchanged();
      return move("sent_pending", { send_accepted_at: row.sendAcceptedAt ?? nowIso, check_count: 0 });
    case "sent":
    case "sent_mismatch": {
      const mismatch = clone.status === "sent_mismatch";
      return move("sent", {
        sent_at: live?.sentAt ?? row.sendAcceptedAt ?? nowIso,
        unverified: flags.includes("unverified") || flags.includes("verify_overdue"),
        sent_mismatch: mismatch
      }, null, mismatch ? "draft-sent-mismatch" : null);
    }
    case "sent_external":
      return move("sent_external", {});
    case "deleted": {
      if (src === "discarding") {
        return move("discarded", row.priorStatus === "unknown" ? { owner_resolution: "not_sent" } : {});
      }
      if (src === "saving") {
        if (clone.replacedBy) return transition(src, { updated_at: nowIso }, "follow_replacement", null, false);
        return move("draft", { outlook_graph_id: null, web_link: null, conversation_id: null, ...errorPatch("recreate_failed", now) }, "recreate_failed");
      }
      if (src === "gone") return unchanged();
      return move("gone", {});
    }
    case "gone":
      if (src === "gone") return unchanged();
      return move("gone", {});
    case "creating":
      return unchanged("clone_anomaly", "clone-anomaly");
  }
}

/**
 * A GET answer (T26, T32-T35, T40, T47's pre-check, T49): a read-back or a
 * registry view goes through mirrorRegistry; an error carrying draftStatus
 * does too (the §2.6 precedence rule); the rest are §2.6.0's last rows: the
 * state is unchanged and the next check is + 5 min (C68), with the alert the
 * row names. Additive helper (Area D's sweep and Check again).
 */
export function mapGetResult(row: ExecDraftRow, r: CloneAnswer<CloneDraftRead>, now: Date, opts?: TransitionOptions): Transition {
  if (r.ok) return mirrorRegistry(row, { status: r.value.status, flags: r.value.flags, read: r.value }, now, opts);
  const nowIso = now.toISOString();
  const failed = (code: string | null, alert: OpsAlertCode | null): Transition =>
    transition(row.status, { ...errorPatch(code, now), next_check_at: nextCheckAt(row, now, "failed"), updated_at: nowIso }, code, alert, false);
  if ("noAnswer" in r) return failed("outcome_unknown", null);
  const e = r.error;
  if (e.draftStatus === "saved" && (row.status === "sending" || row.status === "unknown")) {
    // data-1: an error body carries no flags, so it can't say whether the clone's row also holds
    // send_status_unknown (CL2C §5.10). Only a read with real flags applies C15; this is a failed check.
    return failed(kindCode(e.kind, "get"), kindAlert(e.kind, "get"));
  }
  if (e.draftStatus !== null) {
    const t = mirrorRegistry(row, { status: e.draftStatus, flags: [], read: null, replacedBy: e.replacedBy }, now, opts);
    return t.code === null ? { ...t, code: kindCode(e.kind, "get") } : t;
  }
  if (e.kind === "not_found") return failed("not_in_registry", "draft-registry-missing");
  return failed(kindCode(e.kind, "get"), kindAlert(e.kind, "get"));
}

// ---------------------------------------------------------------------------
// §2.6.1-§2.6.5: the per-route maps
// ---------------------------------------------------------------------------

export type CloneAnswer<T> = { ok: true; value: T; replay: boolean } | { ok: false; error: CloneEaError } | { ok: false; noAnswer: true };

/** T18/T19: the save landed; link, saved_version and content hash written, review cleared (the row was a draft). */
function saveLanded(row: ExecDraftRow, read: CloneReadBack, now: Date, days: number): Transition {
  const flags = knownFlags(read.flags);
  const patch = { ...statusPatch(row, "saved", now, days), ...linkPatch(row, read, flags), ...REVIEW_CLEARED_PATCH, next_check_at: null };
  return transition("saved", patch, null, null, true);
}

/** T25: no answer to a create or recreate; the row stays saving and the stale sweep replays it (C14, C67). Additive export. */
export function saveOutcomeUnknown(row: ExecDraftRow, now: Date): Transition {
  return transition("saving", { ...errorPatch("outcome_unknown", now), next_check_at: nextCheckAt(row, now), updated_at: now.toISOString() }, "outcome_unknown", null, false);
}

/** T20 and its recreate cousins: back to draft with the code; a create has no link, a recreate keeps the old one. */
function saveFailed(row: ExecDraftRow, code: string, alert: OpsAlertCode | null, now: Date, days: number, extra: Record<string, unknown> = {}): Transition {
  const base = { ...statusPatch(row, "draft", now, days), ...errorPatch(code, now), ...extra };
  const next = applyDraftPatch(row, base);
  return transition("draft", { ...base, next_check_at: nextCheckAt(next, now) }, code, alert, false);
}

/** §2.6.1: the answer to his click. */
export function mapCreateResult(row: ExecDraftRow, r: CloneAnswer<CloneReadBack>, now: Date, opts?: TransitionOptions): Transition {
  const days = daysOf(opts);
  if (r.ok) return saveLanded(row, r.value, now, days);
  if ("noAnswer" in r) return saveOutcomeUnknown(row, now);
  const e = r.error;
  const route = row.kind === "reply" ? "create_reply" : "create_new";
  if (e.draftStatus !== null) {
    // 409 already_* with a registry status: an anomaly on a create, mirrored by draftStatus (§2.6 precedence).
    const t = mirrorRegistry(row, { status: e.draftStatus, flags: [], read: null, replacedBy: e.replacedBy }, now, opts);
    return { ...t, code: t.code ?? kindCode(e.kind, route), alert: t.alert ?? "clone-anomaly" };
  }
  if (NO_ANSWER_KINDS.has(e.kind)) return saveOutcomeUnknown(row, now);
  switch (e.kind) {
    case "already_sending":
    case "already_sent":
    case "sent_externally":
    case "changed":
    case "gone":
    case "send_disabled":
      // Not an answer a create gives without draftStatus: the no-answer row (never "nothing happened").
      return saveOutcomeUnknown(row, now);
    default:
      return saveFailed(row, kindCode(e.kind, route), kindAlert(e.kind, "create"), now, days);
  }
}

/** §2.6.2: the answer to his click on a stale link (the recreate). */
export function mapRecreateResult(row: ExecDraftRow, r: CloneAnswer<CloneReadBack>, now: Date, opts?: TransitionOptions):
  Transition | { needGetResolution: true; code: string } | { leaveSaving: true } {
  const days = daysOf(opts);
  if (r.ok) return saveLanded(row, r.value, now, days);
  if ("noAnswer" in r) return { leaveSaving: true };
  const e = r.error;
  if (NO_ANSWER_KINDS.has(e.kind)) return { leaveSaving: true };
  if (e.draftStatus !== null) {
    const t = mirrorRegistry(row, { status: e.draftStatus, flags: [], read: null, replacedBy: e.replacedBy }, now, opts);
    return { ...t, code: t.code ?? kindCode(e.kind, "recreate") };
  }
  switch (e.kind) {
    case "changed":
      // T21: nothing deleted or created; content_hash unchanged so a retry without seenContentHash 409s again.
      return saveFailed(row, "outlook_changed", null, now, days);
    case "sent_externally":
      return transition("sent_external", { ...statusPatch(row, "sent_external", now, days), ...REVIEW_CLEARED_PATCH }, "sent_externally", null, true);
    case "gone":
      // A 404 gone without draftStatus: the GET resolution tells deleted from gone.
      return { needGetResolution: true, code: "gone" };
    case "already_sending":
    case "already_sent":
      return { needGetResolution: true, code: kindCode(e.kind, "recreate") };
    default:
      return { needGetResolution: true, code: kindCode(e.kind, "recreate") };
  }
}

/**
 * §2.6.2's GET resolution after an answered recreate error: `old` is the GET of
 * the old graphId, `replacement` the GET of `replacedBy` when the old answered
 * 404 gone/deleted with one (null when not fetched). Every read writes
 * observed_content_hash only (C66).
 */
export function resolveRecreateByGet(row: ExecDraftRow, old: CloneAnswer<CloneDraftRead>,
  replacement: CloneAnswer<CloneDraftRead> | null, code: string, now: Date, opts?: TransitionOptions): Transition | { leaveSaving: true } {
  const days = daysOf(opts);
  if (old.ok) {
    if (old.value.status === "saved") {
      // The old draft is still there: the recreate failed before deleting; back to draft with the original code, link kept.
      return saveFailed(row, code, null, now, days, readRefresh(old.value));
    }
    return { leaveSaving: true };
  }
  if ("noAnswer" in old) return { leaveSaving: true };
  const e = old.error;
  if (e.kind !== "gone" || e.draftStatus !== "deleted") return { leaveSaving: true };
  if (e.replacedBy) {
    if (replacement === null || !replacement.ok || replacement.value.status !== "saved") return { leaveSaving: true };
    return linkReplacement(row, replacement.value, now, opts);
  }
  return saveFailed(row, "recreate_failed", null, now, days, { outlook_graph_id: null, web_link: null, conversation_id: null });
}

/**
 * data-3: a replacement reached through `replacedBy` (a 404 gone / deleted of
 * the old graphId) is never this attempt's own result (CL2C §3.0.4: a same-key
 * replay returns the stored 2xx), so it holds an earlier attempt's text and
 * recipients. It is linked as a stale link: back to `draft`, saved_version left
 * as it was (below version), its hash observed only (C66), so the panel says
 * it changed in Outlook and the next Save shows him that version (409 changed)
 * before recreating it with the current text. A replacement that isn't a saved
 * draft goes through §2.6.0's saving row (sent, sent elsewhere, in doubt).
 */
export function linkReplacement(row: ExecDraftRow, read: CloneDraftRead, now: Date, opts?: TransitionOptions): Transition {
  if (read.status !== "saved" || (read.live && !read.isDraft) || read.flags.includes("send_status_unknown")) {
    return mirrorRegistry(row, { status: read.status, flags: read.flags, read }, now, opts);
  }
  const flags = knownFlags(read.flags);
  const base: Record<string, unknown> = {
    ...statusPatch(row, "draft", now, daysOf(opts)),
    outlook_graph_id: read.graphId,
    internet_message_id: read.internetMessageId,
    web_link: read.webLink,
    ...readRefresh(read),
    clone_flags: flags,
    signature_skipped: flags.includes("signature_skipped"),
    outlook_edited: false,
    last_error_code: null,
    ...REVIEW_CLEARED_PATCH
  };
  const next = applyDraftPatch(row, base);
  return transition("draft", { ...base, next_check_at: nextCheckAt(next, now) }, null, null, true);
}

/** T52: a save unresolved 24 h after it started, or a replay the fresh recipient check refused (C67). Additive export. */
export function giveUpSaving(row: ExecDraftRow, now: Date, opts?: TransitionOptions): Transition {
  return saveFailed(row, "outlook_unknown", null, now, daysOf(opts));
}

/** T51: a stale create of a restricted (purged) row is never replayed; it closes with its Outlook copy unknown (C67 (4)). Additive export. */
export function closePurgedCreate(row: ExecDraftRow, now: Date, opts?: TransitionOptions): Transition {
  const patch = { ...terminalPatch(row, "discarded", now, opts), ...errorPatch("outlook_unknown_restricted", now) };
  return transition("discarded", patch, "outlook_unknown_restricted", null, true);
}

/**
 * C67 (3): a sweep replay of a create or recreate. 401/403/429/5xx/edge/no answer → leaveSaving (never T20);
 * a 2xx with replay → needGet (one GET, then §2.6.0's saving row); definitive answers → the §2.6.1/§2.6.2 row;
 * unresolved past replayGiveUpMs → T52.
 */
export function mapReplayResult(row: ExecDraftRow, kind: "create" | "recreate", r: CloneAnswer<CloneReadBack>, now: Date, opts?: TransitionOptions):
  Transition | { needGet: true; graphId: string } | { leaveSaving: true; code: string | null } {
  const days = daysOf(opts);
  const started = toMs(row.saveStartedAt);
  const gaveUp = started !== null && now.getTime() - started >= DRAFT_LIMITS.replayGiveUpMs;
  const leave = (code: string | null) => (gaveUp ? giveUpSaving(row, now, opts) : { leaveSaving: true as const, code });
  if (r.ok) return r.replay ? { needGet: true, graphId: r.value.graphId } : saveLanded(row, r.value, now, days);
  if ("noAnswer" in r) return leave("outcome_unknown");
  const e = r.error;
  if (e.draftStatus !== null) {
    const t = mirrorRegistry(row, { status: e.draftStatus, flags: [], read: null, replacedBy: e.replacedBy }, now, opts);
    if (t.to === "saving" && t.code !== "follow_replacement") return leave(t.code);
    return { ...t, code: t.code ?? kindCode(e.kind, kind === "create" ? (row.kind === "reply" ? "create_reply" : "create_new") : "recreate") };
  }
  const route = kind === "create" ? (row.kind === "reply" ? "create_reply" : "create_new") : "recreate";
  switch (e.kind) {
    case "auth":
    case "send_disabled":
    case "throttled":
    case "mailbox_reconnect":
    case "graph_error":
    case "not_ready":
    case "graph_timeout":
    case "server_error":
    case "edge":
    case "invalid_body":
    case "transport":
    case "timeout":
    case "unknown_code":
      return leave(kindCode(e.kind, route));
    case "changed":
      return kind === "recreate" ? saveFailed(row, "outlook_changed", null, now, days) : leave("outcome_unknown");
    case "sent_externally":
      return kind === "recreate"
        ? transition("sent_external", { ...statusPatch(row, "sent_external", now, days), ...REVIEW_CLEARED_PATCH }, "sent_externally", null, true)
        : leave("outcome_unknown");
    case "gone":
    case "already_sending":
    case "already_sent":
      // Definitive only with a draftStatus (handled above); without one, the next replay reads the stored answer again.
      return leave(kindCode(e.kind, route));
    case "bad_request":
    case "mailbox_not_connected":
    case "not_found":
    case "parent_missing":
    case "idempotency_mismatch":
      // The §2.6.1 row for a create. A recreate keeps its old link: the next Save (a recreate) resolves what Outlook holds.
      return saveFailed(row, kindCode(e.kind, route), kindAlert(e.kind, "create"), now, days);
  }
}

/** §2.6.3: the answer to a DELETE, from each prior status (C76: a failure returns to it, never to an inferred saved). */
export function mapDeleteResult(row: ExecDraftRow, r: CloneAnswer<CloneDeleted>, now: Date, opts?: TransitionOptions): Transition | { leaveDiscarding: true } {
  const days = daysOf(opts);
  const prior = priorStatusOf(row);
  const discarded = (code: string | null, alert: OpsAlertCode | null): Transition => {
    const patch = { ...statusPatch(row, "discarded", now, days), ...REVIEW_CLEARED_PATCH, ...errorPatch(code, now),
      ...(row.priorStatus === "unknown" ? { owner_resolution: "not_sent" } : {}) };
    return transition("discarded", patch, code, alert, true);
  };
  const back = (code: string, alert: OpsAlertCode | null): Transition => {
    const base = { ...statusPatch(row, prior, now, days), ...errorPatch(code, now) };
    const next = applyDraftPatch(row, base);
    return transition(prior, { ...base, next_check_at: nextCheckAt(next, now) }, code, alert, prior !== row.status);
  };
  if (r.ok) return discarded(null, null);
  if ("noAnswer" in r) return { leaveDiscarding: true };
  const e = r.error;
  if (NO_ANSWER_KINDS.has(e.kind)) return { leaveDiscarding: true };
  if (e.kind === "changed") return back("outlook_changed", null);
  if (e.draftStatus !== null) {
    if (e.kind === "gone" && e.draftStatus === "deleted") return discarded(null, null);
    const t = mirrorRegistry(row, { status: e.draftStatus, flags: [], read: null, replacedBy: e.replacedBy }, now, opts);
    return { ...t, code: t.code ?? kindCode(e.kind, "delete") };
  }
  switch (e.kind) {
    case "sent_externally":
      return transition("sent_external", { ...statusPatch(row, "sent_external", now, days), ...REVIEW_CLEARED_PATCH }, "sent_externally", null, true);
    case "gone":
      // 404 gone without a draftStatus: the draft isn't there; whether it was sent is for the re-checks.
      return { ...mirrorRegistry(row, { status: "gone", flags: [], read: null }, now, opts), code: "gone" };
    case "not_found":
      return discarded("not_in_registry", "draft-registry-missing");
    default:
      return back(kindCode(e.kind, "delete"), kindAlert(e.kind, "delete"));
  }
}

export type SendOutcomeShape = { kind: "accepted"; internetMessageId: string | null; replay: boolean } | { kind: "error"; error: CloneEaError };

/** One row of the §2.6.5 table: the status when no draftStatus decides it, the code, whether the review is kept, the alert. */
type SendRow = { to: ExecDraftStatus; code: string; keep: boolean; alert: OpsAlertCode | null; extra?: Record<string, unknown> };
const unknownRow = (code: string, alert: OpsAlertCode | null = "draft-send-unknown"): SendRow => ({ to: "unknown", code, keep: false, alert });
const savedRow = (code: string, keep: boolean, alert: OpsAlertCode | null = null): SendRow => ({ to: "saved", code, keep, alert });

/** §2.6.5 by error kind, with the draftStatus-dependent variants. The default is `unknown` + clone_anomaly (security-8). */
function sendRowFor(kind: CloneEaErrorKind, ds: CloneDraftStatus | null): SendRow {
  switch (kind) {
    case "changed": return savedRow("changed", false);
    case "already_sending": return unknownRow("already_sending", null);
    case "already_sent":
      if (ds === "sent_pending_verification") return { to: "sent_pending", code: "already_sent", keep: false, alert: null };
      if (ds === "sent" || ds === "sent_mismatch") return { to: "sent", code: "already_sent", keep: false, alert: ds === "sent_mismatch" ? "draft-sent-mismatch" : null };
      return unknownRow("already_sent", null);
    case "sent_externally": return { to: "sent_external", code: "sent_externally", keep: false, alert: null };
    case "parent_missing": return savedRow("clone_anomaly", true, "clone-anomaly");
    case "send_disabled": return savedRow("send_disabled", true);
    case "auth": return savedRow("ea_auth", true, "clone-ea-auth");
    case "bad_request": return savedRow("bad_request", true, "clone-ea-bug");
    case "mailbox_not_connected": return savedRow("mailbox_not_connected", true, null); // a create-route kind (K04); a 400 on send reads as bad_request
    case "not_found": return savedRow("clone_anomaly", false, "draft-registry-missing");
    case "gone":
      if (ds === "saved") return savedRow("outlook_not_found", false);
      if (ds === "gone" || ds === "deleted") return { to: "gone", code: "gone", keep: false, alert: null };
      return unknownRow("clone_anomaly");
    case "idempotency_mismatch": return unknownRow("idempotency_mismatch", "clone-ea-bug");
    case "throttled": return savedRow("throttled", true);
    case "mailbox_reconnect":
      if (ds === "unknown") return unknownRow("mailbox_reconnect");
      return ds === "saved" ? savedRow("mailbox_reconnect", true, "clone-ea-auth") : unknownRow("clone_anomaly");
    case "graph_error":
      if (ds === "unknown") return unknownRow("graph_error");
      return ds === "saved" ? savedRow("graph_error", true, "clone-anomaly") : unknownRow("clone_anomaly");
    case "not_ready": return savedRow("clone_not_ready", true, "clone-anomaly");
    case "graph_timeout":
      if (ds === "unknown") return unknownRow("timeout");
      return ds === "saved" ? savedRow("timeout_nothing_sent", true) : unknownRow("clone_anomaly");
    case "server_error": return unknownRow("clone_error");
    case "transport":
    case "timeout":
      return unknownRow("transport");
    case "edge":
    case "invalid_body":
    case "unknown_code":
      return unknownRow("clone_anomaly");
  }
}

/**
 * §2.6.5. draftStatus outranks HTTP: it decides the status through §2.6.0 from
 * `sending`; the error kind picks the code, whether the review is kept and the
 * alert. The default (an unparseable 2xx, an unknown code, an edge page, an
 * unlisted status) is `unknown` + clone_anomaly + draft-send-unknown, never
 * `saved` (security-8).
 */
export function mapSendResult(row: ExecDraftRow, outcome: SendOutcomeShape, now: Date, opts?: TransitionOptions): Transition {
  const days = daysOf(opts);
  const nowIso = now.toISOString();
  if (outcome.kind === "accepted") {
    const patch = {
      ...statusPatch(row, "sent_pending", now, days),
      ...(outcome.internetMessageId !== null ? { internet_message_id: outcome.internetMessageId } : {}),
      send_accepted_at: nowIso,
      check_count: 0,
      last_error_code: null,
      ...REVIEW_CLEARED_PATCH,
      next_check_at: plus(now, S1_MS[0])
    };
    return transition("sent_pending", patch, "accepted", null, true);
  }
  const e = outcome.error;
  const ds = e.draftStatus;
  let r: SendRow = sendRowFor(e.kind, ds);
  if (ds !== null && ds !== "creating") {
    // The §2.6 precedence rule: the registry status decides the DD status.
    const m = mirrorRegistry(row, { status: ds, flags: [], read: null, replacedBy: e.replacedBy }, now, opts);
    r = { ...r, to: m.to, extra: withoutReview(m.patch) };
  }
  const base = r.extra ?? statusPatch(row, r.to, now, days);
  const keep = r.keep && r.to === "saved";
  const review = keep ? {} : REVIEW_CLEARED_PATCH;
  const errored = { ...base, ...review, ...errorPatch(r.code, now), ...(r.to === "unknown" ? { check_count: 0 } : {}) };
  const next = applyDraftPatch(row, errored);
  const patch = { ...errored, next_check_at: nextCheckAt(next, now) };
  return transition(r.to, patch, r.code, r.alert, !keep);
}

// ---------------------------------------------------------------------------
// Schedules (§2.4, C16, C17, C68, C69)
// ---------------------------------------------------------------------------

/** The first of `offsets` after `now`, measured from `anchor`; null when all have passed. */
function nextOffset(anchorMs: number, offsets: readonly number[], nowMs: number): number | null {
  for (const o of offsets) if (anchorMs + o > nowMs) return anchorMs + o;
  return null;
}

/** S1 from `anchor` by check_count: the nine offsets, then hourly; never in the past; capped at the 24 h horizon. */
function s1(anchorMs: number, checkCount: number, nowMs: number): number {
  const n = Math.max(0, checkCount);
  const candidate = n < S1_MS.length ? anchorMs + S1_MS[n] : anchorMs + S1_MS[S1_MS.length - 1] + (n - (S1_MS.length - 1)) * HOUR_MS;
  const next = Math.max(candidate, nowMs + S1_MS[0]);
  return Math.min(next, anchorMs + DRAFT_LIMITS.slowAfterMs);
}

/** An in-flight attempt's stale timer (§2.4): its start + the stale window, or + 5 min once that has passed. */
function stale(startedMs: number, staleMs: number, nowMs: number): string {
  const due = startedMs + staleMs;
  return iso(due > nowMs ? due : nowMs + DRAFT_LIMITS.failedCheckRetryMs);
}

/** C68: every 6 h until 14 days after the anchor, then nothing. */
function slow(anchorMs: number, nowMs: number): string | null {
  const next = nowMs + DRAFT_LIMITS.slowCheckMs;
  return next - anchorMs > DRAFT_LIMITS.slowCheckUntilMs ? null : iso(next);
}

/**
 * §2.4: S1 then the slow schedule (C68), the stale timers, the gone re-checks (C17), the saved/linked-draft
 * follow-ups after Open in Outlook (opened_in_outlook_at + 25 s / 2 min / 10 min, C69) and after an
 * outlook_not_found send answer (last_error_at + 2 / 6 / 16 min); a failed check → now + 5 min; null when nothing is due.
 */
export function nextCheckAt(row: ExecDraftRow, now: Date, lastCheck?: "ok" | "failed"): string | null {
  const nowMs = now.getTime();
  const retry = () => iso(nowMs + DRAFT_LIMITS.failedCheckRetryMs);
  switch (row.status) {
    case "generating":
      return iso(nowMs + DRAFT_LIMITS.generatingStaleMs);
    case "generation_failed":
    case "sent":
    case "sent_external":
    case "discarded":
      return null;
    case "saving":
      return lastCheck === "failed" ? retry() : stale(toMs(row.saveStartedAt) ?? nowMs, DRAFT_LIMITS.savingStaleMs, nowMs);
    case "discarding":
      return lastCheck === "failed" ? retry() : stale(toMs(row.discardStartedAt) ?? nowMs, DRAFT_LIMITS.discardingStaleMs, nowMs);
    case "sending":
      return lastCheck === "failed" ? retry() : stale(toMs(row.sendStartedAt) ?? nowMs, DRAFT_LIMITS.sendingStaleMs, nowMs);
    case "sent_pending": {
      const anchor = toMs(row.sendAcceptedAt) ?? toMs(row.sendStartedAt) ?? toMs(row.createdAt) ?? nowMs;
      if (nowMs - anchor >= DRAFT_LIMITS.sentPendingMaxMs) return null; // C16: T33 closes it as sent + unverified
      if (lastCheck === "failed") return iso(Math.min(nowMs + DRAFT_LIMITS.failedCheckRetryMs, anchor + DRAFT_LIMITS.sentPendingMaxMs));
      return iso(s1(anchor, row.checkCount, nowMs));
    }
    case "unknown": {
      const anchor = toMs(row.sendStartedAt) ?? toMs(row.createdAt) ?? nowMs;
      if (nowMs - anchor >= DRAFT_LIMITS.slowAfterMs) return slow(anchor, nowMs);
      if (lastCheck === "failed") return retry();
      return iso(s1(anchor, row.checkCount, nowMs));
    }
    case "gone": {
      if (!row.goneUnconfirmed) return null;
      const anchor = toMs(row.goneAt) ?? nowMs;
      if (nowMs - anchor >= DRAFT_LIMITS.slowAfterMs) return slow(anchor, nowMs);
      if (lastCheck === "failed") return retry();
      const next = nextOffset(anchor, DRAFT_LIMITS.goneRecheckMs, nowMs);
      return next !== null ? iso(next) : retry();
    }
    case "draft":
    case "saved": {
      if (row.outlookGraphId === null) return null;
      const candidates: number[] = [];
      const opened = toMs(row.openedInOutlookAt);
      if (opened !== null) {
        const next = nextOffset(opened, DRAFT_LIMITS.openedFollowUpMs, nowMs);
        if (next !== null) candidates.push(next);
      }
      const erred = toMs(row.lastErrorAt);
      if (row.lastErrorCode === "outlook_not_found" && erred !== null) {
        const next = nextOffset(erred, DRAFT_LIMITS.notFoundFollowUpMs, nowMs);
        if (next !== null) candidates.push(next);
      }
      if (lastCheck === "failed") {
        const anchor = Math.max(opened ?? Number.NEGATIVE_INFINITY, erred ?? Number.NEGATIVE_INFINITY);
        if (Number.isFinite(anchor) && nowMs - anchor < DRAFT_LIMITS.slowAfterMs) candidates.push(nowMs + DRAFT_LIMITS.failedCheckRetryMs);
      }
      return candidates.length > 0 ? iso(Math.min(...candidates)) : null;
    }
  }
}

/**
 * The sweep's bookkeeping on a transition (§3.11): check_count + 1 and
 * next_check_at recomputed on the row the patch produces. Additive helper, so
 * the schedule lives in one place.
 */
export function checkedPatch(row: ExecDraftRow, t: Transition, now: Date, lastCheck: "ok" | "failed"): DraftPatch {
  const count = row.checkCount + 1;
  const base: Record<string, unknown> = { ...t.patch, check_count: "check_count" in t.patch ? t.patch.check_count : count };
  const next = applyDraftPatch(row, base);
  return { ...base, next_check_at: nextCheckAt(next, now, lastCheck) };
}

// ---------------------------------------------------------------------------
// Owner choices and review
// ---------------------------------------------------------------------------

/** L14, C17, C63: may a new draft / re-save be offered after this row? */
export function canOfferNewReply(row: ExecDraftRow, input: { sentCopy: SentCopyResult; checkedOutlook: boolean; now: Date }):
  { ok: true } | { ok: false; code: "hold" | "sent_copy_found" | "state_conflict" } {
  if (input.sentCopy === "found") return { ok: false, code: "sent_copy_found" };
  const s = row.status;
  if (s === "sending" || s === "sent_pending") return { ok: false, code: "state_conflict" };
  if (s === "unknown" && !pastSendHorizon(row, input.now)) return { ok: false, code: "hold" };
  if ((s === "unknown" || s === "gone") && !input.checkedOutlook) return { ok: false, code: "hold" };
  if (input.sentCopy === "unsupported" && !input.checkedOutlook) return { ok: false, code: "hold" };
  return { ok: true };
}

/** hash set, ≤10 min, not opened in Outlook since */
export function reviewIsValid(row: ExecDraftRow, now: Date): boolean {
  if (row.reviewHash === null || row.reviewAt === null) return false;
  const at = toMs(row.reviewAt);
  if (at === null || now.getTime() - at > DRAFT_LIMITS.reviewTtlMs) return false;
  const opened = toMs(row.openedInOutlookAt);
  return opened === null || opened <= at;
}

export interface ReviewFacts {
  draftCreatedAtMs: number; generatedAtMs: number | null; parentMessageId: string | null;
  replyMode: ReplyMode | null;
  /** The anchor (parent) message's sentAt, from the live read; null for new drafts or when it isn't in the read. */
  parentSentAtMs: number | null;
  /** null for new drafts */
  thread: PrincipalMailThread | "unavailable" | null;
  ownAddresses: ReadonlySet<string>; legacyArtifacts: ReplyArtifacts | null;
  /** Other exec drafts on the same (thread_id, parent_message_id), this one excluded (listDraftsForParent). */
  siblingDrafts: readonly { status: ExecDraftStatus }[];
  openedInOutlookAt: string | null; storedContentHash: string | null; readBackContentHash: string;
  storedSig: string | null; readBackSig: string; readBackReplyToCount: number;
  ownPartPlaceholders: readonly string[]; ddPlaceholders: readonly string[];
  /** C62: factsRecipientsOutside on the read-back is non-empty (only computed when facts_status = 'used'). */
  factsOutsideClient: boolean;
  /** C65: the row's generation_flags. */
  generationFlags: readonly GenerationFlag[];
  /** P5b (F4, C45): the row's uses_private_refs (a draft started in a chat that read other private material). */
  usesPrivateRefs: boolean;
}

const sentMs = (m: HisMessage): number => toMs(m.sentAt) ?? 0;
const byTime = (a: HisMessage, b: HisMessage) => sentMs(a) - sentMs(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** C20, C21, C48, C62, C65; P5b F4 (C45): private_refs exactly when the row uses private refs. */
export function computeReviewBlockers(f: ReviewFacts): ReviewBlocker[] {
  const out = new Set<ReviewBlocker>();
  const thread = f.thread !== null && f.thread !== "unavailable" ? f.thread : null;
  if (f.thread === "unavailable") out.add("thread_unavailable");
  if (thread !== null) {
    const own = new Set([...f.ownAddresses].map((a) => a.trim().toLowerCase()));
    const since = f.replyMode === "follow_up" ? f.draftCreatedAtMs : (f.parentSentAtMs ?? f.draftCreatedAtMs);
    // C48 (a): an outbound of his after the anchor (reply modes) or after this draft began (follow-up).
    const replied = thread.his.some((m) => m.direction === "outbound" && !m.isJunk && !m.isAutomated && sentMs(m) > since);
    if (replied) out.add("already_replied");
    // newer_inbound: his newest qualifying inbound (computeAnswered's rule: no junk, no self-copies) is newer than this draft and isn't the parent.
    const inbound = thread.his
      .filter((m) => m.direction === "inbound" && !m.isJunk && !(m.from !== null && own.has(m.from.email.toLowerCase())))
      .sort(byTime);
    const newest = inbound[inbound.length - 1];
    const measuredFrom = f.generatedAtMs ?? f.draftCreatedAtMs;
    if (newest !== undefined && newest.id !== f.parentMessageId && sentMs(newest) > measuredFrom) out.add("newer_inbound");
  }
  // C48 (b): a sibling draft on the same parent that was sent or may have been.
  if (f.siblingDrafts.some((d) => SIBLING_SENT_STATUSES.includes(d.status))) out.add("already_replied");
  if (f.legacyArtifacts !== null) {
    if (f.legacyArtifacts.scheduledFor !== null) out.add("reply_scheduled");
    if (f.legacyArtifacts.draftPending) out.add("legacy_draft_pending");
  }
  if (f.openedInOutlookAt !== null) out.add("opened_in_outlook");
  if (f.storedContentHash !== null && f.readBackContentHash !== f.storedContentHash) out.add("changed_in_outlook");
  if (f.storedSig !== null && f.readBackSig !== f.storedSig) out.add("recipients_changed");
  if (f.readBackReplyToCount > 0) out.add("reply_to_present");
  const dd = new Set(f.ddPlaceholders);
  if (f.ownPartPlaceholders.some((p) => !dd.has(p))) out.add("placeholder_in_outlook");
  if (f.factsOutsideClient) out.add("facts_outside_client");
  if (f.generationFlags.length > 0) out.add("unexpected_content");
  if (f.usesPrivateRefs) out.add("private_refs");
  return REVIEW_BLOCKERS.filter((b) => out.has(b));
}

/** True for a 64-hex clone hash (the only shape content_hash, confirm_hash and review_hash take). */
export function isHex64(v: unknown): v is string {
  return typeof v === "string" && HEX64.test(v);
}

/** The C46 attention reasons, in the bucket's order; the index is the sort rank. */
const ATTENTION_ORDER: readonly DraftAttention[] = ["unknown", "sent_mismatch", "gone_unconfirmed", "outlook_changed", "generation_failed", "restricted", "stale_link"];

/**
 * C46: why a draft sits at the top of the Drafts bucket, or null. Additive
 * helper (the store's `active` ordering, the card and System counts, and
 * Area D's DraftListItem.attention).
 */
export function draftAttention(row: Pick<ExecDraftRow, "status" | "sentMismatch" | "goneUnconfirmed" | "observedContentHash" | "contentHash"
  | "lastErrorCode" | "restrictedPurged" | "outlookGraphId" | "version" | "savedVersion">): DraftAttention | null {
  if (row.status === "unknown") return "unknown";
  if (row.status === "sent" && row.sentMismatch) return "sent_mismatch";
  if (row.status === "gone" && row.goneUnconfirmed) return "gone_unconfirmed";
  if (!isTerminalStatus(row.status) && (changedSinceSaved(row) || row.lastErrorCode === "outlook_changed")) return "outlook_changed";
  if (row.status === "generation_failed") return "generation_failed";
  if (row.restrictedPurged && row.outlookGraphId !== null && !isTerminalStatus(row.status)) return "restricted";
  if (row.status === "draft" && isStaleLink(row)) return "stale_link";
  return null;
}

/** The sort rank of a draft in the `active` view: attention first in C46's order, then (the caller's) updated_at desc. */
export function attentionRank(attention: DraftAttention | null): number {
  return attention === null ? ATTENTION_ORDER.length : ATTENTION_ORDER.indexOf(attention);
}
