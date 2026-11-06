import type { CloneDraftStatus, DraftKind } from "@/lib/exec/drafts-types";
import type { ErrorClass } from "@/lib/exec/types";

// The CL2 (missiveclone Outlook-drafts API) answer shapes, the error class and
// the error classifier (P4 contract §3.2.1, §3.2.3; CL2 contract §3, §8.5).
//
// Pure: no I/O, no server-only, importable anywhere (C1). Seeded at stage 0 with
// the real CloneEaError, MAILBOX_NOT_CONNECTED_DETAILS and classifyCloneEa; Area B
// owns the file afterwards and implements the parsers (below).
//
// Nothing here logs. CloneEaError.message carries codes only (the route, the
// HTTP status and the clone's error code), never response text, a detail string
// or a token; `detail` is kept as a field for the classifier and tests.

export type CloneEaRoute = "status" | "auth_me" | "create_reply" | "create_new" | "get_draft" | "recreate" | "delete" | "send";
export interface CloneAddress { address: string; name: string }             // CL2C §5.6: name '' when absent
export interface CloneAttachment { id: string; name: string; size: number; isInline: boolean; contentType: string | null }
/** CL2C §3.0.5, live: true. */
export interface CloneReadBack {
  live: true; graphId: string; status: CloneDraftStatus; kind: DraftKind; accountId: string;
  threadId: string | null; parentMessageId: string | null; replaces: string | null; changeKey: string;
  contentHash: string; internetMessageId: string | null; conversationId: string | null; webLink: string | null;
  isDraft: boolean; lastModified: string | null; sentAt: string | null;
  from: CloneAddress | null; sender: CloneAddress | null; replyTo: CloneAddress[];
  to: CloneAddress[]; cc: CloneAddress[]; bcc: CloneAddress[]; subject: string; bodyHtml: string;
  attachments: CloneAttachment[]; flags: string[];
}
/** CL2C §3.3 step 2: the registry view when a live read failed on a non-saved row. */
export interface CloneRegistryView {
  live: false; graphId: string; status: CloneDraftStatus; flags: string[];
  internetMessageId: string | null; webLink: string | null; verifiedAt: string | null;
}
export type CloneDraftRead = CloneReadBack | CloneRegistryView;
export interface CloneSendAccepted { graphId: string; status: "sent_pending_verification"; internetMessageId: string | null }
export interface CloneDeleted { graphId: string; status: "deleted" }
/** /api/status (no bearer): `cl2` absent on a pre-CL2 build (L4). */
export interface CloneStatus { cl2: { ready: boolean; send: "off" | "all" | "some" } | null }
/** /api/auth/me: `auth` absent on a pre-CL2 build or a legacy token (CL2C §4.9). */
export interface CloneAuthMe {
  auth: { kind: string; scopes: string[]; accounts: string[]; jti: string; expiresAt: string | null; sendEnabled: boolean } | null;
}
export interface CloneErrorBody {
  error: string; detail: string | null; draftStatus: CloneDraftStatus | null;
  graphStatus: number | null; graphCode: string | null; replacedBy: string | null;
}
export type CloneEaErrorKind = "auth" | "send_disabled" | "mailbox_not_connected" | "bad_request" | "not_found"
  | "gone" | "changed" | "already_sending" | "already_sent" | "sent_externally" | "parent_missing"
  | "idempotency_mismatch" | "throttled" | "mailbox_reconnect" | "graph_error" | "not_ready" | "graph_timeout"
  | "server_error" | "edge" | "unknown_code" | "invalid_body" | "transport" | "timeout";

/** The four failures that aren't an answer from the clone's own JSON error body. */
export type CloneEaFailure = "transport" | "timeout" | "edge" | "invalid_body";

const FAILURE_CODES: ReadonlySet<string> = new Set<CloneEaFailure>(["transport", "timeout", "edge", "invalid_body"]);
const isFailureCode = (code: string): code is CloneEaFailure => FAILURE_CODES.has(code);

/** K14: a 429 with no usable Retry-After waits this long. */
export const THROTTLED_DEFAULT_RETRY_MS = 30_000;

/** Thrown by sources/clone-ea.ts for every non-2xx answer, transport failure and timeout. */
export class CloneEaError extends Error {
  readonly route: CloneEaRoute;
  /** HTTP status; null for transport and timeout. */
  readonly status: number | null;
  /** body.error, or "transport" | "timeout" | "edge" | "invalid_body". */
  readonly code: string;
  readonly kind: CloneEaErrorKind;
  /** Read by P2a's job classifier (jobs.ts classifyError: an errorClass property wins). */
  readonly errorClass: ErrorClass;
  readonly draftStatus: CloneDraftStatus | null;
  readonly graphStatus: number | null;
  readonly graphCode: string | null;
  readonly replacedBy: string | null;
  /** Top-level, the only place P2a's backoff reads it. */
  readonly retryAfterMs: number | null;
  readonly replay: boolean;
  /** Kept for the classifier and tests; never logged and never part of `message`. */
  readonly detail: string | null;
  constructor(init: {
    route: CloneEaRoute; status: number | null; body: CloneErrorBody | null; code?: string;
    retryAfterMs?: number | null; replay?: boolean;
  }) {
    const body = init.body ?? null;
    const code = init.code ?? body?.error ?? (init.status === null ? "transport" : "unknown_code");
    // message = codes only: never response text or a token.
    super(`clone ${init.route} answered ${init.status ?? "no status"} ${code}`);
    this.name = "CloneEaError";
    this.route = init.route;
    this.status = init.status;
    this.code = code;
    const verdict = classifyCloneEa(init.route, init.status, body, isFailureCode(code) ? code : undefined);
    this.kind = verdict.kind;
    this.errorClass = verdict.errorClass;
    this.draftStatus = body?.draftStatus ?? null;
    this.graphStatus = body?.graphStatus ?? null;
    this.graphCode = body?.graphCode ?? null;
    this.replacedBy = body?.replacedBy ?? null;
    this.retryAfterMs = init.retryAfterMs ?? (this.kind === "throttled" ? THROTTLED_DEFAULT_RETRY_MS : null);
    this.replay = init.replay ?? false;
    this.detail = body?.detail ?? null;
  }
}

export const MAILBOX_NOT_CONNECTED_DETAILS: readonly string[] = ["not a connected Microsoft mailbox", "not_microsoft", "mailbox_not_connected"];

const CREATE_ROUTES: ReadonlySet<CloneEaRoute> = new Set<CloneEaRoute>(["create_reply", "create_new", "recreate"]);
const RETRYABLE = { errorClass: "retryable" } as const;
const FATAL = { errorClass: "fatal" } as const;
const AUTH = { errorClass: "auth" } as const;

/**
 * CL2C §8.5's table (contract §3.2.3), keyed on (route, HTTP, error, detail/graphCode);
 * never on message text. `draftStatus` is not an input: it outranks HTTP in the
 * transition (drafts-state.ts), while this table fixes the error kind and P2a's
 * errorClass. Only K02 and K04 read `detail`, by exact equality; K15 reads
 * `graphCode` by equality.
 */
export function classifyCloneEa(route: CloneEaRoute, httpStatus: number | null, body: CloneErrorBody | null,
  failure?: CloneEaFailure): { kind: CloneEaErrorKind; errorClass: ErrorClass } {
  // K22, K23, K24, K20: not an answer from the clone's own JSON body.
  if (failure === "transport") return { kind: "transport", ...RETRYABLE };
  if (failure === "timeout") return { kind: "timeout", ...RETRYABLE };
  if (failure === "invalid_body") return { kind: "invalid_body", ...RETRYABLE };
  if (failure === "edge") return { kind: "edge", ...RETRYABLE };
  if (httpStatus === null) return { kind: "transport", ...RETRYABLE };
  if (body === null) {
    // A 2xx whose body didn't parse (K24), or a non-JSON (edge) page on an error status (K20).
    return httpStatus >= 200 && httpStatus < 300 ? { kind: "invalid_body", ...RETRYABLE } : { kind: "edge", ...RETRYABLE };
  }
  const error = body.error;
  switch (httpStatus) {
    case 401:
      if (error === "invalid_token") return { kind: "auth", ...AUTH };                                     // K01
      break;
    case 403:
      if (error === "forbidden_scope") {
        return body.detail === "send_disabled" ? { kind: "send_disabled", ...FATAL } : { kind: "auth", ...AUTH };  // K02, K03
      }
      break;
    case 400:
      if (error === "bad_request") {
        if (CREATE_ROUTES.has(route) && body.detail !== null && MAILBOX_NOT_CONNECTED_DETAILS.includes(body.detail)) {
          return { kind: "mailbox_not_connected", ...FATAL };                                               // K04
        }
        return { kind: "bad_request", ...FATAL };                                                            // K05
      }
      break;
    case 404:
      if (error === "not_found") return { kind: "not_found", ...FATAL };                                     // K06
      if (error === "gone") return { kind: "gone", ...FATAL };                                               // K07
      break;
    case 409:
      if (error === "changed") return { kind: "changed", ...FATAL };                                         // K08
      if (error === "already_sending") return { kind: "already_sending", ...RETRYABLE };                     // K09
      if (error === "already_sent") return { kind: "already_sent", ...FATAL };                               // K10
      if (error === "sent_externally") return { kind: "sent_externally", ...FATAL };                         // K11
      if (error === "parent_missing") return { kind: "parent_missing", ...FATAL };                           // K12
      break;
    case 422:
      if (error === "idempotency_mismatch") return { kind: "idempotency_mismatch", ...FATAL };               // K13
      break;
    case 429:
      if (error === "throttled") return { kind: "throttled", ...RETRYABLE };                                 // K14
      break;
    case 502:
      if (error === "graph_error") {
        return body.graphCode === "token_refresh_failed:invalid_grant"
          ? { kind: "mailbox_reconnect", ...AUTH }                                                            // K15
          : { kind: "graph_error", ...RETRYABLE };                                                           // K16
      }
      break;
    case 503:
      if (error === "not_ready") return { kind: "not_ready", ...RETRYABLE };                                 // K17
      break;
    case 504:
      if (error === "graph_timeout") return { kind: "graph_timeout", ...RETRYABLE };                         // K18
      break;
    case 500:
      if (error === "server_error") return { kind: "server_error", ...RETRYABLE };                           // K19
      break;
    default:
      break;
  }
  // K21: a code not in the table (or a known code on the wrong status): fatal for 4xx, retryable otherwise.
  return { kind: "unknown_code", errorClass: httpStatus >= 400 && httpStatus < 500 ? "fatal" : "retryable" };
}

// ---------------------------------------------------------------------------
// Parsers (Area B). Every answer the clone sends is checked for shape before
// any field is used; a body that fails a check is a CloneEaError of kind
// invalid_body (K24), never a partially read answer. The parsers see only the
// decoded JSON, so the error they throw carries no HTTP status; the two
// callers (sources/mail.ts, send.ts) rethrow it with the real status.
// ---------------------------------------------------------------------------

/** A body that fails a strict shape check; becomes CloneEaError(invalid_body) at the parser's edge. */
class InvalidBody extends Error {
  constructor(what: string) {
    super(what);
    this.name = "InvalidBody";
  }
}
const bad = (what: string): never => {
  throw new InvalidBody(what);
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const objectOf = (v: unknown, what: string): Obj => (isObj(v) ? v : bad(what));
const absent = (v: unknown): v is null | undefined => v === undefined || v === null;

/** CL2C §3.0.3: a Graph id, case kept. */
export const CLONE_GRAPH_ID_RE = /^[A-Za-z0-9_=-]{1,512}$/;
/** CL2C §3.0.3: the idempotency key charset and length. */
export const CLONE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const MAX_ERROR_BODY_CHARS = 8 * 1024;
const MAX_DETAIL_CHARS = 200;
const MAX_CODE_CHARS = 100;
const MAX_RETRY_AFTER_MS = 3_600_000;
/** Ids, keys, links and times: opaque short strings. */
const MAX_FIELD_CHARS = 2048;
const MAX_LIST_ITEMS = 200;

const CLONE_DRAFT_STATUSES: ReadonlySet<string> = new Set<CloneDraftStatus>([
  "creating", "saved", "sending", "sent_pending_verification", "sent", "sent_mismatch", "sent_external", "unknown", "gone", "deleted"
]);

export function isCloneDraftStatus(v: unknown): v is CloneDraftStatus {
  return typeof v === "string" && CLONE_DRAFT_STATUSES.has(v);
}

function text(v: unknown, what: string, max = MAX_FIELD_CHARS): string {
  return typeof v === "string" && v.length <= max ? v : bad(what);
}
function nonEmpty(v: unknown, what: string, max = MAX_FIELD_CHARS): string {
  const s = text(v, what, max);
  return s.length > 0 ? s : bad(what);
}
const textOrNull = (v: unknown, what: string, max = MAX_FIELD_CHARS): string | null => (absent(v) ? null : text(v, what, max));
const bool = (v: unknown, what: string): boolean => (typeof v === "boolean" ? v : bad(what));
const graphIdOf = (v: unknown, what: string): string => (typeof v === "string" && CLONE_GRAPH_ID_RE.test(v) ? v : bad(what));
const statusOf = (v: unknown, what: string): CloneDraftStatus => (isCloneDraftStatus(v) ? v : bad(what));

function addressOf(v: unknown, what: string): CloneAddress {
  const o = objectOf(v, what);
  // CL2C §5.6: the name is '' when Graph sent none.
  return { address: nonEmpty(o.address, `${what}.address`, 320), name: typeof o.name === "string" ? o.name.slice(0, 256) : "" };
}
function addressListOf(v: unknown, what: string): CloneAddress[] {
  if (absent(v)) return [];
  if (!Array.isArray(v) || v.length > MAX_LIST_ITEMS) return bad(what);
  return v.map((x, i) => addressOf(x, `${what}[${i}]`));
}
function stringListOf(v: unknown, what: string, maxItem = 64): string[] {
  if (absent(v)) return [];
  if (!Array.isArray(v) || v.length > MAX_LIST_ITEMS) return bad(what);
  return v.map((x) => text(x, what, maxItem));
}
function attachmentOf(v: unknown, what: string): CloneAttachment {
  const o = objectOf(v, what);
  const size = typeof o.size === "number" && Number.isFinite(o.size) && o.size >= 0 ? Math.trunc(o.size) : 0;
  return {
    id: nonEmpty(o.id, `${what}.id`),
    name: typeof o.name === "string" && o.name.length > 0 ? o.name.slice(0, 1024) : "attachment",
    size,
    isInline: o.isInline === true,
    contentType: typeof o.contentType === "string" && o.contentType.length > 0 ? o.contentType.slice(0, 256) : null
  };
}

/** Runs a strict parse; a failed check becomes CloneEaError(kind invalid_body) for `route`. */
function strict<T>(route: CloneEaRoute, parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    if (err instanceof InvalidBody) throw new CloneEaError({ route, status: null, body: null, code: "invalid_body" });
    throw err;
  }
}

/** ≤8 KB of text, JSON only; null when it isn't the clone's JSON error body (an edge page). */
export function parseCloneErrorBody(contentType: string | null, text: string): CloneErrorBody | null {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_ERROR_BODY_CHARS) return null;
  // A content type that says it isn't JSON is an edge page whatever the text; no content type is tried as JSON.
  if (contentType !== null && !/json/i.test(contentType)) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(v) || typeof v.error !== "string" || v.error.length === 0) return null;
  return {
    error: v.error.slice(0, MAX_CODE_CHARS),
    detail: typeof v.detail === "string" && v.detail.length > 0 ? v.detail.slice(0, MAX_DETAIL_CHARS) : null,
    draftStatus: isCloneDraftStatus(v.draftStatus) ? v.draftStatus : null,
    graphStatus: typeof v.graphStatus === "number" && Number.isInteger(v.graphStatus) ? v.graphStatus : null,
    graphCode: typeof v.graphCode === "string" && v.graphCode.length > 0 ? v.graphCode.slice(0, MAX_CODE_CHARS) : null,
    replacedBy: typeof v.replacedBy === "string" && CLONE_GRAPH_ID_RE.test(v.replacedBy) ? v.replacedBy : null
  };
}

/** Seconds or an HTTP date; null when absent or unparseable; capped at 3 600 000. */
export function parseRetryAfterMs(header: string | null, nowMs: number = Date.now()): number | null {
  if (typeof header !== "string") return null;
  const s = header.trim();
  if (s.length === 0) return null;
  if (/^\d{1,10}$/.test(s)) return Math.min(Number(s) * 1000, MAX_RETRY_AFTER_MS);
  // An HTTP date is an IMF-fixdate ("Thu, 05 Nov 2026 12:01:00 GMT"); Date.parse alone would read junk like "-5" as a year.
  if (!HTTP_DATE_RE.test(s)) return null;
  const at = Date.parse(s);
  if (!Number.isFinite(at)) return null;
  return Math.min(Math.max(0, at - nowMs), MAX_RETRY_AFTER_MS);
}
const HTTP_DATE_RE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

function registryViewOf(o: Obj): CloneRegistryView {
  return {
    live: false,
    graphId: graphIdOf(o.graphId, "graphId"),
    status: statusOf(o.status, "status"),
    flags: stringListOf(o.flags, "flags"),
    internetMessageId: textOrNull(o.internetMessageId, "internetMessageId"),
    webLink: textOrNull(o.webLink, "webLink"),
    verifiedAt: textOrNull(o.verifiedAt, "verifiedAt", 64)
  };
}

function readBackOf(o: Obj): CloneReadBack {
  const kind: DraftKind = o.kind === "reply" || o.kind === "new" ? o.kind : bad("kind");
  const attachments = absent(o.attachments)
    ? []
    : Array.isArray(o.attachments) && o.attachments.length <= 500
      ? o.attachments.map((a, i) => attachmentOf(a, `attachments[${i}]`))
      : bad("attachments");
  return {
    live: true,
    graphId: graphIdOf(o.graphId, "graphId"),
    status: statusOf(o.status, "status"),
    kind,
    accountId: nonEmpty(o.accountId, "accountId", 200),
    threadId: textOrNull(o.threadId, "threadId", 200),
    parentMessageId: textOrNull(o.parentMessageId, "parentMessageId", 200),
    replaces: absent(o.replaces) ? null : graphIdOf(o.replaces, "replaces"),
    changeKey: text(o.changeKey, "changeKey"),
    contentHash: typeof o.contentHash === "string" && HEX64_RE.test(o.contentHash) ? o.contentHash : bad("contentHash"),
    internetMessageId: textOrNull(o.internetMessageId, "internetMessageId"),
    conversationId: textOrNull(o.conversationId, "conversationId"),
    webLink: textOrNull(o.webLink, "webLink"),
    isDraft: bool(o.isDraft, "isDraft"),
    lastModified: textOrNull(o.lastModified, "lastModified", 64),
    sentAt: textOrNull(o.sentAt, "sentAt", 64),
    from: absent(o.from) ? null : addressOf(o.from, "from"),
    sender: absent(o.sender) ? null : addressOf(o.sender, "sender"),
    replyTo: addressListOf(o.replyTo, "replyTo"),
    to: addressListOf(o.to, "to"),
    cc: addressListOf(o.cc, "cc"),
    bcc: addressListOf(o.bcc, "bcc"),
    subject: typeof o.subject === "string" ? o.subject : bad("subject"),
    bodyHtml: typeof o.bodyHtml === "string" ? o.bodyHtml : bad("bodyHtml"),
    attachments,
    flags: stringListOf(o.flags, "flags")
  };
}

/** Strict shape checks; a malformed body throws CloneEaError(kind invalid_body). graphId must match ^[A-Za-z0-9_=-]{1,512}$, hashes ^[0-9a-f]{64}$. */
export function parseCloneDraftRead(route: CloneEaRoute, json: unknown): CloneDraftRead {
  return strict(route, () => {
    const o = objectOf(json, "body");
    // CL2C §3.3 step 2 marks the registry view live: false; the canonical read-back carries live: true or no flag.
    if (o.live === false) return registryViewOf(o);
    if (!absent(o.live) && o.live !== true) return bad("live");
    return readBackOf(o);
  });
}

/** A live read-back (create, recreate); a registry view is not one. */
export function parseCloneReadBack(route: CloneEaRoute, json: unknown): CloneReadBack {
  const read = parseCloneDraftRead(route, json);
  if (read.live !== true) throw new CloneEaError({ route, status: null, body: null, code: "invalid_body" });
  return read;
}

export function parseCloneSendAccepted(json: unknown): CloneSendAccepted {
  return strict("send", () => {
    const o = objectOf(json, "body");
    if (o.status !== "sent_pending_verification") return bad("status");
    return {
      graphId: graphIdOf(o.graphId, "graphId"),
      status: "sent_pending_verification",
      internetMessageId: textOrNull(o.internetMessageId, "internetMessageId")
    };
  });
}

export function parseCloneDeleted(json: unknown): CloneDeleted {
  return strict("delete", () => {
    const o = objectOf(json, "body");
    if (o.status !== "deleted") return bad("status");
    return { graphId: graphIdOf(o.graphId, "graphId"), status: "deleted" };
  });
}

export function parseCloneStatus(json: unknown): CloneStatus {
  return strict("status", () => {
    const o = objectOf(json, "body");
    if (absent(o.cl2)) return { cl2: null };
    const c = objectOf(o.cl2, "cl2");
    const send = c.send === "off" || c.send === "all" || c.send === "some" ? c.send : bad("cl2.send");
    return { cl2: { ready: bool(c.ready, "cl2.ready"), send } };
  });
}

export function parseCloneAuthMe(json: unknown): CloneAuthMe {
  return strict("auth_me", () => {
    const o = objectOf(json, "body");
    if (absent(o.auth)) return { auth: null };
    const a = objectOf(o.auth, "auth");
    return {
      auth: {
        kind: nonEmpty(a.kind, "auth.kind", 64),
        scopes: stringListOf(a.scopes, "auth.scopes"),
        accounts: stringListOf(a.accounts, "auth.accounts"),
        // Never persisted by DD; tolerated when missing so a readiness check doesn't fail on it.
        jti: typeof a.jti === "string" ? a.jti.slice(0, 64) : "",
        expiresAt: textOrNull(a.expiresAt, "auth.expiresAt", 64),
        // Anything but an explicit true reads as send off (fail closed).
        sendEnabled: a.sendEnabled === true
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Offline token decoding (L4: a misconfiguration check, never a security
// check). Shared by sources/mail.ts (the EA token) and send.ts (the send token),
// which may not import each other (B3, B6). Pure: no Buffer, so the module
// stays importable anywhere.
// ---------------------------------------------------------------------------

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_PART = /^[A-Za-z0-9_-]+$/;

function base64UrlDecode(part: string): string | null {
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of part) {
    const v = BASE64URL_ALPHABET.indexOf(ch);
    if (v < 0) return null;
    acc = ((acc << 6) | v) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/**
 * The claims of a three-part JWT, read without verifying the signature:
 * null when the token isn't three base64url parts whose middle part is a JSON
 * object. Callers interpret the claims (scope, accounts, exp, jti) with their
 * own reason vocabularies and never log or persist them beyond the expiry.
 */
export function decodeTokenClaims(token: string): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => p.length > 0 && BASE64URL_PART.test(p.replace(/=+$/, "")))) return null;
  const json = base64UrlDecode(parts[1].replace(/=+$/, ""));
  if (json === null) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(json);
  } catch {
    return null;
  }
  return isObj(claims) ? claims : null;
}
