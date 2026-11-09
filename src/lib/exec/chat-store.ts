import "server-only";

import { createHash } from "node:crypto";

import type {
  ChatCard,
  ChatContextInput,
  ChatContextKind,
  ChatStatus,
  ChatStatusReason,
  CitedSource,
  PersistedToolCall,
  PrivateRefKind,
  TurnUsage
} from "@/lib/exec/agent/types";
import { wellFormedText } from "@/lib/exec/chat/answer";
import { REDACTED_TEXT, UNCHECKED_TEXT } from "@/lib/exec/chat/copy";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// The chat store (P5b contract §3.3; Area A): exec_conversations,
// exec_messages and exec_task_proposals through the begin/finish/redact RPCs
// of 20261107100000_exec_chat.sql. Ids, counts and codes in logs and errors
// only; never a question, answer, argument or title (§0.2 rule 5): a
// ChatStoreError names the table, the step and the database's own code and
// message, never a value this module was handed. Imports neither P3 nor P4
// (P3's email-store imports this module for the tombstone hook).
//
//   * beginTurn / finishTurn: RPCs 1 and 2. The begin RPC does every check
//     (idempotency, one running answer per conversation, the principal-wide
//     running and rate limits) inside one transaction under a per-principal
//     advisory lock (C49); this module only maps its answer.
//   * The reads select the columns the views need and never tool_calls or
//     usage (arguments are content and nothing reads them back).
//   * Proposals: every insert builds the identical key set; the CAS is
//     `.eq("status", from)` and one returned row.
//   * Redaction (B7, C19-C21): the RPCs in chunks of 200. Before the P5b
//     migration is applied (a missing table or function) the redaction and
//     draft-id reads answer 0 / [] / false, so P3's tombstone procedure and
//     safety nets keep working; any other error throws (the caller retries).

const CONVERSATIONS = "exec_conversations";
const MESSAGES = "exec_messages";
const PROPOSALS = "exec_task_proposals";

/** Ids per redaction / draft-id RPC call (the RPCs refuse more than 200). */
export const CHAT_REDACT_CHUNK = 200;
/** Most turns loadConversation returns (two rows each, one PostgREST page). */
export const CHAT_MAX_LOADED_TURNS = 400;
const LIST_MAX = 100;
const IN_LIST_CHUNK = 100;
/** C21/purge: a running answer older than this is stale (B5). */
export const CHAT_STALE_SECONDS = 600;

const CONVERSATION_ID = /^ecv_[0-9a-f]{32}$/;
const MESSAGE_ID = /^ecm_[0-9a-f]{32}$/;
const PROPOSAL_ID = /^etp_[0-9a-f]{32}$/;
const DRAFT_ID = /^ed_[0-9a-f]{32}$/;
const CONTEXT_KINDS: readonly ChatContextKind[] = ["attention", "project", "client", "thread"];
const STATUSES: readonly ChatStatus[] = ["running", "complete", "aborted", "refused", "failed", "capped"];
const PROPOSAL_STATUSES: readonly ProposalStatus[] = ["pending", "confirming", "confirmed", "dismissed", "withdrawn"];
const PRIORITIES: readonly ProposalPriority[] = ["low", "medium", "high", "critical"];

const CONVERSATION_COLS = "id,surface,title,ref_seq,turn_count,created_at,last_message_at";
const MESSAGE_COLS =
  "id,conversation_id,turn_id,role,status,status_reason,text,recommendations,context,sources,cards," +
  "consulted_email_thread_ids,consulted_client_ids,consulted_dd_text,created_at,finished_at,redacted_at";
const PROPOSAL_COLS =
  "id,principal_id,conversation_id,message_id,status,title,description,assignee_user_id,assignee_name,department_id," +
  "due_on,due_at,client_name,priority,task_id,decided_at,redacted_at,created_at,updated_at,expires_at";

/** DB failures (never content in the message). */
export class ChatStoreError extends Error {
  readonly table: string;
  /** The Postgres / PostgREST error code, when the database gave one (23514 = a CHECK refused the row). Additive. */
  readonly code: string | null;
  constructor(table: string, message: string, code: string | null = null) {
    super(message);
    this.name = "ChatStoreError";
    this.table = table;
    this.code = code;
  }
}

type DbError = { code?: string | null; message?: string | null };
type Row = Record<string, unknown>;

const db = () => getSupabaseAdmin();

/** The P5b migration isn't applied: a table or function is missing. */
function isNotInstalled(error: DbError): boolean {
  const code = error.code ?? "";
  if (code === "42P01" || code === "PGRST205" || code === "42883" || code === "PGRST202") return true;
  const m = error.message ?? "";
  return (
    /relation "(public\.)?exec_(conversations|messages|task_proposals)" does not exist/i.test(m) ||
    /could not find the (table|function) '?public\.exec_(conversations|messages|task_proposals|chat_)/i.test(m)
  );
}

/**
 * The error to throw for a failed request. An aborted signal wins (postgrest-js
 * reports an AbortError result instead of throwing). The message carries the
 * step, the database's message and its code; never a value this module sent.
 */
function failure(table: string, what: string, error: DbError, signal?: AbortSignal): ChatStoreError {
  signal?.throwIfAborted();
  const code = typeof error.code === "string" && error.code.length > 0 ? error.code : null;
  return new ChatStoreError(table, `exec chat store: ${what} failed: ${safeDbMessage(error.message)}${code ? ` (${code})` : ""}`, code);
}

/**
 * The database's message with every quoted value hidden: Postgres quotes the input it couldn't parse
 * (`invalid input syntax for type json: "..."`), while the names worth keeping (a relation, a
 * constraint) are snake_case identifiers. So a quoted run that isn't one becomes "...".
 */
function safeDbMessage(message: string | null | undefined): string {
  const text = typeof message === "string" && message.length > 0 ? message : "unknown error";
  return text
    .replace(/"([^"]*)"/g, (whole, inner: string) => (/^(public\.)?[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(inner) && inner.length <= 80 ? whole : '"..."'))
    .slice(0, 300);
}

function malformed(table: string, what: string): ChatStoreError {
  return new ChatStoreError(table, `exec chat store: ${what}: the database's answer is malformed`);
}

function requirePrincipal(principal: ExecPrincipal): string {
  if (!principal || typeof principal.id !== "string" || principal.id.length === 0) {
    throw new TypeError("exec chat store: an ExecPrincipal is required");
  }
  return principal.id;
}

function checkIds(ids: readonly unknown[], what: string): string[] {
  if (!Array.isArray(ids)) throw new TypeError(`exec chat store: ${what} must be a list`);
  const out = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || id.length > 200 || /[\x00-\x1f\x7f]/.test(id)) {
      throw new TypeError(`exec chat store: ${what} holds a malformed id`);
    }
    out.add(id);
  }
  return [...out];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const isObject = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Turns: begin and finish (RPCs 1 and 2)
// ---------------------------------------------------------------------------

export type BeginTurnResult =
  | { outcome: "started"; conversationId: string; created: boolean; turnId: string; userMessageId: string;
      userCreatedAt: string; assistantMessageId: string; refSeq: number; contextRef: string | null }
  | { outcome: "replay"; conversationId: string; turnId: string; assistantMessageId: string }
  | { outcome: "busy"; conversationId: string }
  | { outcome: "busy_principal" }                                   // C49: 2 answers already running
  | { outcome: "rate_limited"; retryAfterSeconds: number }          // C49: the exact in-transaction count
  | { outcome: "not_found" };

function beginResult(raw: unknown): BeginTurnResult | null {
  if (!isObject(raw)) return null;
  const conversationId = str(raw.conversation_id);
  switch (raw.outcome) {
    case "started": {
      const turnId = str(raw.turn_id);
      const userMessageId = str(raw.user_message_id);
      const userCreatedAt = str(raw.user_created_at);
      const assistantMessageId = str(raw.assistant_message_id);
      const refSeq = raw.ref_seq;
      const contextRef = raw.context_ref === null || raw.context_ref === undefined ? null : str(raw.context_ref);
      if (
        conversationId === null || turnId === null || userMessageId === null || userCreatedAt === null ||
        !Number.isFinite(Date.parse(userCreatedAt)) || assistantMessageId === null || typeof raw.created !== "boolean" ||
        typeof refSeq !== "number" || !Number.isSafeInteger(refSeq) || refSeq < 0 ||
        (raw.context_ref !== null && raw.context_ref !== undefined && contextRef === null)
      ) {
        return null;
      }
      return { outcome: "started", conversationId, created: raw.created, turnId, userMessageId, userCreatedAt, assistantMessageId, refSeq, contextRef };
    }
    case "replay": {
      const turnId = str(raw.turn_id);
      const assistantMessageId = str(raw.assistant_message_id);
      if (conversationId === null || turnId === null || assistantMessageId === null) return null;
      return { outcome: "replay", conversationId, turnId, assistantMessageId };
    }
    case "busy":
      return conversationId === null ? null : { outcome: "busy", conversationId };
    case "busy_principal":
      return { outcome: "busy_principal" };
    case "rate_limited": {
      const s = raw.retry_after_seconds;
      if (typeof s !== "number" || !Number.isFinite(s)) return null;
      return { outcome: "rate_limited", retryAfterSeconds: Math.max(1, Math.ceil(s)) };
    }
    case "not_found":
      return { outcome: "not_found" };
    default:
      return null;
  }
}

/** exec_chat_begin_turn. Throws ChatStoreError on a DB error (incl. the table missing). */
export async function beginTurn(principal: ExecPrincipal, input: {
  conversationId: string | null; clientTurnId: string; surface: "web" | "slack"; text: string;
  context: ChatContextInput | null; title: string; retentionDays: number; staleSeconds: number;
  rateLimit: number; rateWindowSeconds: number; maxRunning: number;      // 30, 600, 2 (C49)
}, opts?: { signal?: AbortSignal }): Promise<BeginTurnResult> {
  const principalId = requirePrincipal(principal);
  const signal = opts?.signal;
  if (input.context !== null && (!isObject(input.context) || !CONTEXT_KINDS.includes(input.context.kind) || typeof input.context.id !== "string")) {
    throw new TypeError("exec chat store: beginTurn: the context must be { kind, id }");
  }
  // Only kind and id reach the RPC (a context never carries a label).
  const context = input.context === null ? null : { kind: input.context.kind, id: input.context.id };
  let call = db().rpc("exec_chat_begin_turn", {
    p_principal: principalId,
    p_conversation_id: input.conversationId,
    p_client_turn_id: input.clientTurnId,
    p_surface: input.surface,
    p_user_text: input.text,
    p_context: context,
    p_title: input.title,
    p_retention_days: input.retentionDays,
    p_stale_seconds: input.staleSeconds,
    p_rate_limit: input.rateLimit,
    p_rate_window_seconds: input.rateWindowSeconds,
    p_max_running: input.maxRunning
  });
  if (signal) call = call.abortSignal(signal);
  const { data, error } = await call;
  if (error) throw failure(MESSAGES, "exec_chat_begin_turn", error, signal);
  const result = beginResult(data);
  if (result === null) throw malformed(MESSAGES, "exec_chat_begin_turn");
  return result;
}

export interface FinishTurnInput {
  messageId: string; status: Exclude<ChatStatus, "running">; statusReason: ChatStatusReason | null;
  refusalCategory: string | null; text: string; recommendations: string; sources: CitedSource[];
  cards: ChatCard[]; toolCalls: PersistedToolCall[];                    // ≤ 8 cards (C40), ≤ 100 records (C14)
  consultedEmailThreadIds: string[];                                    // ≤ 560 (C41)
  consultedClientIds: string[]; consultedDdText: boolean;               // C24
  usage: TurnUsage; model: string; refSeq: number;
}

/**
 * exec_chat_finish_turn: true when the running row was finished, false when it no longer was. Never passed an aborted
 * signal (B5): the caller hands in its own controller's. The values must already fit the §2.1 CHECKs (the caller clips:
 * C11, C14, C40, C41); a row the CHECKs refuse throws ChatStoreError with code 23514 and the row stays running.
 */
/** Every string (keys too) with a lone surrogate replaced by U+FFFD: Postgres's json input refuses one, which would
 *  fail the whole finish and leave the answer running (loop-1). A second layer behind the callers' clips. */
function wellFormedDeep<T>(v: T): T {
  if (typeof v === "string") return wellFormedText(v) as T;
  if (Array.isArray(v)) return v.map((x) => wellFormedDeep(x)) as T;
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[wellFormedText(k)] = wellFormedDeep(x);
    return out as T;
  }
  return v;
}

export async function finishTurn(principal: ExecPrincipal, input: FinishTurnInput, opts: { signal: AbortSignal }): Promise<boolean> {
  const principalId = requirePrincipal(principal);
  if (!opts || !(opts.signal instanceof AbortSignal)) throw new TypeError("exec chat store: finishTurn needs its own signal");
  if (typeof input.messageId !== "string" || !MESSAGE_ID.test(input.messageId)) {
    throw new TypeError("exec chat store: finishTurn: a malformed message id");
  }
  const { data, error } = await db()
    .rpc("exec_chat_finish_turn", {
      p_principal: principalId,
      p_message_id: input.messageId,
      p_status: input.status,
      p_status_reason: input.statusReason,
      p_refusal_category: input.refusalCategory,
      p_text: wellFormedDeep(input.text),
      p_recommendations: wellFormedDeep(input.recommendations),
      p_sources: wellFormedDeep(input.sources),
      p_cards: wellFormedDeep(input.cards),
      p_tool_calls: wellFormedDeep(input.toolCalls),
      p_consulted: input.consultedEmailThreadIds,
      p_consulted_clients: input.consultedClientIds,
      p_consulted_dd_text: input.consultedDdText,
      p_usage: input.usage,
      p_model: input.model,
      p_ref_seq: input.refSeq
    })
    .abortSignal(opts.signal);
  if (error) throw failure(MESSAGES, "exec_chat_finish_turn", error, opts.signal);
  if (typeof data !== "boolean") throw malformed(MESSAGES, "exec_chat_finish_turn");
  return data;
}

// ---------------------------------------------------------------------------
// Reads: conversations and turns
// ---------------------------------------------------------------------------

export interface StoredTurn {
  turnId: string; user: StoredMessage; assistant: StoredMessage | null;   // assistant null only mid-begin (never seen)
}
export interface StoredMessage {
  id: string; role: "user" | "assistant"; status: ChatStatus; statusReason: string | null; text: string;
  recommendations: string; context: { kind: ChatContextKind; id: string; ref: string } | null;
  sources: CitedSource[]; cards: ChatCard[]; consultedEmailThreadIds: string[];
  consultedClientIds: string[]; consultedDdText: boolean; createdAt: string;
  finishedAt: string | null; redactedAt: string | null;
}
export interface ChatConversationRow { id: string; surface: "web" | "slack"; title: string; refSeq: number; turnCount: number;
  createdAt: string; lastMessageAt: string }

function conversationFromRow(r: Row): ChatConversationRow {
  const id = str(r.id);
  const title = str(r.title);
  const createdAt = str(r.created_at);
  const lastMessageAt = str(r.last_message_at);
  const refSeq = r.ref_seq;
  const turnCount = r.turn_count;
  if (
    id === null || (r.surface !== "web" && r.surface !== "slack") || title === null || createdAt === null || lastMessageAt === null ||
    typeof refSeq !== "number" || typeof turnCount !== "number"
  ) {
    throw malformed(CONVERSATIONS, "a conversation row");
  }
  return { id, surface: r.surface, title, refSeq, turnCount, createdAt, lastMessageAt };
}

function contextOf(v: unknown): StoredMessage["context"] {
  if (!isObject(v)) return null;
  const kind = v.kind;
  const id = str(v.id);
  const ref = str(v.ref);
  if (!CONTEXT_KINDS.includes(kind as ChatContextKind) || id === null || ref === null) return null;
  return { kind: kind as ChatContextKind, id, ref };
}

/** The stored cited refs; an entry that isn't { ref, target: { type }, source } is skipped (the writer is ours). */
function sourcesOf(v: unknown): CitedSource[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (e): e is CitedSource => isObject(e) && typeof e.ref === "string" && isObject(e.target) && typeof e.target.type === "string" && isObject(e.source)
  );
}

const PRIVATE_REF_KINDS: readonly PrivateRefKind[] = ["other_threads", "dd_text", "other_clients"];

function cardsOf(v: unknown): ChatCard[] {
  if (!Array.isArray(v)) return [];
  const out: ChatCard[] = [];
  for (const e of v) {
    if (!isObject(e) || typeof e.id !== "string") continue;
    if (e.kind === "task_proposal") out.push({ kind: "task_proposal", id: e.id });
    else if (e.kind === "draft") {
      const kinds = strArray(e.privateRefKinds).filter((k): k is PrivateRefKind => PRIVATE_REF_KINDS.includes(k as PrivateRefKind));
      out.push({ kind: "draft", id: e.id, existing: e.existing === true, privateRefKinds: kinds });
    }
  }
  return out;
}

function messageFromRow(r: Row): StoredMessage & { conversationId: string; turnId: string } {
  const id = str(r.id);
  const conversationId = str(r.conversation_id);
  const turnId = str(r.turn_id);
  const createdAt = str(r.created_at);
  if (
    id === null || conversationId === null || turnId === null || createdAt === null ||
    (r.role !== "user" && r.role !== "assistant") || !STATUSES.includes(r.status as ChatStatus)
  ) {
    throw malformed(MESSAGES, "a message row");
  }
  return {
    id,
    conversationId,
    turnId,
    role: r.role,
    status: r.status as ChatStatus,
    statusReason: str(r.status_reason),
    text: str(r.text) ?? "",
    recommendations: str(r.recommendations) ?? "",
    context: contextOf(r.context),
    sources: sourcesOf(r.sources),
    cards: cardsOf(r.cards),
    consultedEmailThreadIds: strArray(r.consulted_email_thread_ids),
    consultedClientIds: strArray(r.consulted_client_ids),
    consultedDdText: r.consulted_dd_text === true,
    createdAt,
    finishedAt: str(r.finished_at),
    redactedAt: str(r.redacted_at)
  };
}

function stored(m: ReturnType<typeof messageFromRow>): StoredMessage {
  const { conversationId: _c, turnId: _t, ...rest } = m;
  void _c;
  void _t;
  return rest;
}

/** Message rows → turns, in the order their turns first appear. A turn without its question is skipped. */
function turnsOf(rows: ReturnType<typeof messageFromRow>[]): StoredTurn[] {
  const order: string[] = [];
  const byTurn = new Map<string, { user: StoredMessage | null; assistant: StoredMessage | null }>();
  for (const m of rows) {
    let t = byTurn.get(m.turnId);
    if (!t) {
      t = { user: null, assistant: null };
      byTurn.set(m.turnId, t);
      order.push(m.turnId);
    }
    if (m.role === "user") t.user = stored(m);
    else t.assistant = stored(m);
  }
  const out: StoredTurn[] = [];
  for (const turnId of order) {
    const t = byTurn.get(turnId);
    if (t?.user) out.push({ turnId, user: t.user, assistant: t.assistant });
  }
  return out;
}

/**
 * The conversation (his, and of `surface` when given) with up to `maxTurns` newest turns, oldest first. null = not
 * found (also for a malformed id). `surface` is an additive optional filter.
 */
export async function loadConversation(principal: ExecPrincipal, conversationId: string,
  opts: { maxTurns: number; signal?: AbortSignal; surface?: "web" | "slack" }): Promise<{ conversation: ChatConversationRow; turns: StoredTurn[]; hasEarlier: boolean } | null> {
  const principalId = requirePrincipal(principal);
  const maxTurns = opts?.maxTurns;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > CHAT_MAX_LOADED_TURNS) {
    throw new TypeError(`exec chat store: maxTurns must be 1..${CHAT_MAX_LOADED_TURNS}`);
  }
  if (typeof conversationId !== "string" || !CONVERSATION_ID.test(conversationId)) return null;
  const signal = opts.signal;
  let head = db().from(CONVERSATIONS).select(CONVERSATION_COLS).eq("id", conversationId).eq("principal_id", principalId);
  if (opts.surface) head = head.eq("surface", opts.surface);
  if (signal) head = head.abortSignal(signal);
  const { data: conv, error: convError } = await head.maybeSingle();
  if (convError) throw failure(CONVERSATIONS, `${CONVERSATIONS} read`, convError, signal);
  if (conv === null || conv === undefined) return null;
  const conversation = conversationFromRow(conv as unknown as Row);

  // Two rows per turn (one transaction, one created_at): the newest maxTurns + 1 turns tell whether there are earlier ones.
  let query = db()
    .from(MESSAGES)
    .select(MESSAGE_COLS)
    .eq("conversation_id", conversation.id)
    .eq("principal_id", principalId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit((maxTurns + 1) * 2);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw failure(MESSAGES, `${MESSAGES} read`, error, signal);
  if (!Array.isArray(data)) throw malformed(MESSAGES, `${MESSAGES} read`);
  const newestFirst = turnsOf((data as unknown as Row[]).map(messageFromRow));
  const hasEarlier = newestFirst.length > maxTurns;
  const turns = newestFirst.slice(0, maxTurns).reverse();
  return { conversation, turns, hasEarlier };
}

/** His conversations of `surface`, most recently active first (exec_conversations_recent_idx). limit 1..100. */
export async function listConversations(principal: ExecPrincipal, opts: { surface: "web"; limit: number; signal?: AbortSignal }): Promise<ChatConversationRow[]> {
  const principalId = requirePrincipal(principal);
  if (!Number.isSafeInteger(opts?.limit) || opts.limit < 1 || opts.limit > LIST_MAX) throw new TypeError(`exec chat store: limit must be 1..${LIST_MAX}`);
  let query = db()
    .from(CONVERSATIONS)
    .select(CONVERSATION_COLS)
    .eq("principal_id", principalId)
    .eq("surface", opts.surface)
    .order("last_message_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(opts.limit);
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { data, error } = await query;
  if (error) throw failure(CONVERSATIONS, `${CONVERSATIONS} list`, error, opts.signal);
  if (!Array.isArray(data)) throw malformed(CONVERSATIONS, `${CONVERSATIONS} list`);
  return (data as unknown as Row[]).map(conversationFromRow);
}

/** One stored turn by its assistant message id (the replay path). null = not his, not an answer, or malformed. */
export async function loadTurnByMessageId(principal: ExecPrincipal, assistantMessageId: string, opts?: { signal?: AbortSignal }): Promise<StoredTurn | null> {
  const principalId = requirePrincipal(principal);
  if (typeof assistantMessageId !== "string" || !MESSAGE_ID.test(assistantMessageId)) return null;
  const signal = opts?.signal;
  let head = db().from(MESSAGES).select(MESSAGE_COLS).eq("id", assistantMessageId).eq("principal_id", principalId).eq("role", "assistant");
  if (signal) head = head.abortSignal(signal);
  const { data: a, error: aError } = await head.maybeSingle();
  if (aError) throw failure(MESSAGES, `${MESSAGES} read`, aError, signal);
  if (a === null || a === undefined) return null;
  const assistant = messageFromRow(a as unknown as Row);
  let q = db()
    .from(MESSAGES)
    .select(MESSAGE_COLS)
    .eq("conversation_id", assistant.conversationId)
    .eq("principal_id", principalId)
    .eq("turn_id", assistant.turnId)
    .eq("role", "user");
  if (signal) q = q.abortSignal(signal);
  const { data: u, error: uError } = await q.maybeSingle();
  if (uError) throw failure(MESSAGES, `${MESSAGES} read`, uError, signal);
  if (u === null || u === undefined) return null;
  return { turnId: assistant.turnId, user: stored(messageFromRow(u as unknown as Row)), assistant: stored(assistant) };
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export type ProposalStatus = "pending" | "confirming" | "confirmed" | "dismissed" | "withdrawn";
export type ProposalPriority = "low" | "medium" | "high" | "critical";

/** title and description already through neutralizeTaskText (C42). Every insert builds the identical key set. */
export interface NewProposal {
  conversationId: string; messageId: string; title: string; description: string;
  assigneeUserId: string | null; assigneeName: string | null; departmentId: string | null;
  /** YYYY-MM-DD in his zone, with dueAt (17:00 that day) */
  dueOn: string | null; dueAt: string | null;
  clientName: string | null; priority: ProposalPriority; expiresAt: string;
}
/** exec_task_proposals, camelCase (§2.1). */
export interface ProposalRow {
  id: string; principalId: string; conversationId: string; messageId: string; status: ProposalStatus;
  title: string; description: string; assigneeUserId: string | null; assigneeName: string | null;
  departmentId: string | null; dueOn: string | null; dueAt: string | null; clientName: string | null;
  priority: ProposalPriority; taskId: string | null; decidedAt: string | null; redactedAt: string | null;
  createdAt: string; updatedAt: string; expiresAt: string;
}

/** A NewProposal → the insert row: always every key, in one order (P3 §0). */
export function proposalInsertRow(principalId: string, p: NewProposal): Row {
  return {
    principal_id: principalId,
    conversation_id: p.conversationId,
    message_id: p.messageId,
    status: "pending",
    title: p.title,
    description: p.description,
    assignee_user_id: p.assigneeUserId ?? null,
    assignee_name: p.assigneeName ?? null,
    department_id: p.departmentId ?? null,
    due_on: p.dueOn ?? null,
    due_at: p.dueAt ?? null,
    client_name: p.clientName ?? null,
    priority: p.priority,
    expires_at: p.expiresAt
  };
}

function proposalFromRow(r: Row): ProposalRow {
  const req = (k: string): string => {
    const v = str(r[k]);
    if (v === null) throw malformed(PROPOSALS, "a proposal row");
    return v;
  };
  if (!PROPOSAL_STATUSES.includes(r.status as ProposalStatus) || !PRIORITIES.includes(r.priority as ProposalPriority)) {
    throw malformed(PROPOSALS, "a proposal row");
  }
  return {
    id: req("id"),
    principalId: req("principal_id"),
    conversationId: req("conversation_id"),
    messageId: req("message_id"),
    status: r.status as ProposalStatus,
    title: req("title"),
    description: str(r.description) ?? "",
    assigneeUserId: str(r.assignee_user_id),
    assigneeName: str(r.assignee_name),
    departmentId: str(r.department_id),
    dueOn: str(r.due_on),
    dueAt: str(r.due_at),
    clientName: str(r.client_name),
    priority: r.priority as ProposalPriority,
    taskId: str(r.task_id),
    decidedAt: str(r.decided_at),
    redactedAt: str(r.redacted_at),
    createdAt: req("created_at"),
    updatedAt: req("updated_at"),
    expiresAt: req("expires_at")
  };
}

/** One insert with the identical key set (status 'pending'). The database's CHECKs judge the values (C42's text is the caller's). */
export async function insertProposal(principal: ExecPrincipal, p: NewProposal, opts?: { signal?: AbortSignal }): Promise<{ id: string; expiresAt: string }> {
  const principalId = requirePrincipal(principal);
  if (!PRIORITIES.includes(p.priority)) throw new TypeError("exec chat store: insertProposal: an unknown priority");
  let q = db().from(PROPOSALS).insert(proposalInsertRow(principalId, p)).select("id,expires_at");
  if (opts?.signal) q = q.abortSignal(opts.signal);
  const { data, error } = await q.single();
  if (error) throw failure(PROPOSALS, `${PROPOSALS} insert`, error, opts?.signal);
  const id = str((data as unknown as Row | null)?.id);
  const expiresAt = str((data as unknown as Row | null)?.expires_at);
  if (id === null || expiresAt === null) throw malformed(PROPOSALS, `${PROPOSALS} insert`);
  return { id, expiresAt };
}

/** His proposals on these messages, oldest first. Empty input → [] without a read. */
export async function listProposalsForMessages(principal: ExecPrincipal, messageIds: readonly string[], opts?: { signal?: AbortSignal }): Promise<ProposalRow[]> {
  const principalId = requirePrincipal(principal);
  const ids = checkIds(messageIds, "messageIds");
  const out: ProposalRow[] = [];
  for (const chunk of chunks(ids, IN_LIST_CHUNK)) {
    let q = db()
      .from(PROPOSALS)
      .select(PROPOSAL_COLS)
      .eq("principal_id", principalId)
      .in("message_id", chunk)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (opts?.signal) q = q.abortSignal(opts.signal);
    const { data, error } = await q;
    if (error) throw failure(PROPOSALS, `${PROPOSALS} read`, error, opts?.signal);
    if (!Array.isArray(data)) throw malformed(PROPOSALS, `${PROPOSALS} read`);
    for (const r of data as unknown as Row[]) out.push(proposalFromRow(r));
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One of his proposals, or null (also for a malformed id). */
export async function getProposal(principal: ExecPrincipal, id: string, opts?: { signal?: AbortSignal }): Promise<ProposalRow | null> {
  const principalId = requirePrincipal(principal);
  if (typeof id !== "string" || !PROPOSAL_ID.test(id)) return null;
  let q = db().from(PROPOSALS).select(PROPOSAL_COLS).eq("id", id).eq("principal_id", principalId);
  if (opts?.signal) q = q.abortSignal(opts.signal);
  const { data, error } = await q.maybeSingle();
  if (error) throw failure(PROPOSALS, `${PROPOSALS} read`, error, opts?.signal);
  return data === null || data === undefined ? null : proposalFromRow(data as unknown as Row);
}

/** .eq("status", from).select("id") row count = 1. The patch's keys only (status, task_id, decided_at) plus updated_at. */
export async function casProposal(principal: ExecPrincipal, id: string, from: ProposalRow["status"],
  patch: Partial<Pick<ProposalRow, "status" | "taskId" | "decidedAt">>, opts?: { signal?: AbortSignal }): Promise<boolean> {
  const principalId = requirePrincipal(principal);
  if (typeof id !== "string" || !PROPOSAL_ID.test(id)) return false;
  if (!PROPOSAL_STATUSES.includes(from)) throw new TypeError("exec chat store: casProposal: an unknown from-status");
  const row: Row = {};
  if (patch.status !== undefined) {
    if (!PROPOSAL_STATUSES.includes(patch.status)) throw new TypeError("exec chat store: casProposal: an unknown status");
    row.status = patch.status;
  }
  if (patch.taskId !== undefined) row.task_id = patch.taskId;
  if (patch.decidedAt !== undefined) row.decided_at = patch.decidedAt;
  if (Object.keys(row).length === 0) throw new TypeError("exec chat store: casProposal: an empty patch");
  row.updated_at = new Date().toISOString();
  let q = db().from(PROPOSALS).update(row).eq("id", id).eq("principal_id", principalId).eq("status", from).select("id");
  if (opts?.signal) q = q.abortSignal(opts.signal);
  const { data, error } = await q;
  if (error) throw failure(PROPOSALS, `${PROPOSALS} update`, error, opts?.signal);
  if (!Array.isArray(data)) throw malformed(PROPOSALS, `${PROPOSALS} update`);
  return data.length === 1;
}

/**
 * C23, C43: sha256 hex of JSON.stringify([title, description, assigneeUserId, departmentId, clientName, dueAt, priority]).
 * dueAt is taken as its instant (ISO, ms), so the same due time printed two ways (PostgREST's "+00:00", an insert's
 * "Z") hashes the same; anything that isn't a timestamp is hashed as given.
 */
export function proposalContentHash(row: Pick<ProposalRow, "title" | "description" | "assigneeUserId" | "departmentId" | "clientName" | "dueAt" | "priority">): string {
  const dueMs = typeof row.dueAt === "string" ? Date.parse(row.dueAt) : Number.NaN;
  const dueAt = Number.isFinite(dueMs) ? new Date(dueMs).toISOString() : (row.dueAt ?? null);
  const fields = [row.title, row.description, row.assigneeUserId ?? null, row.departmentId ?? null, row.clientName ?? null, dueAt, row.priority];
  return createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Redaction (B7, C19-C21) and purge (§3.21)
// ---------------------------------------------------------------------------

/** B7 redaction (C19, C20): exec_chat_redact_threads in chunks of 200, with REDACTED_TEXT. Callers pass VERIFIED ids only
 *  (a tombstone, or a stored row whose screen verdict is rule_match or tombstone; C21). Returns messages changed.
 *  A missing function or table (42883/PGRST202, 42P01/PGRST205) → 0 (P5b not installed). Any other error throws (the caller retries). */
export async function redactChatForThreads(principal: ExecPrincipal, threadIds: readonly string[], opts?: { signal?: AbortSignal }): Promise<number> {
  const principalId = requirePrincipal(principal);
  const ids = checkIds(threadIds, "threadIds");
  let changed = 0;
  for (const chunk of chunks(ids, CHAT_REDACT_CHUNK)) {
    let call = db().rpc("exec_chat_redact_threads", { p_principal: principalId, p_thread_ids: chunk, p_text: REDACTED_TEXT });
    if (opts?.signal) call = call.abortSignal(opts.signal);
    const { data, error } = await call;
    if (error) {
      if (isNotInstalled(error)) return 0;
      throw failure(MESSAGES, "exec_chat_redact_threads", error, opts?.signal);
    }
    if (typeof data !== "number" || !Number.isSafeInteger(data) || data < 0) throw malformed(MESSAGES, "exec_chat_redact_threads");
    changed += data;
  }
  return changed;
}

/** C21 (3)-(5): exec_chat_redact_message on ONE message (never principal-wide, never a draft purge). text is
 *  REDACTED_TEXT or UNCHECKED_TEXT; an earlier REDACTED_TEXT is never replaced (the RPC keeps it). Same not-installed rule. */
export async function redactChatMessage(principal: ExecPrincipal, messageId: string, text: string, opts?: { signal?: AbortSignal }): Promise<boolean> {
  const principalId = requirePrincipal(principal);
  if (text !== REDACTED_TEXT && text !== UNCHECKED_TEXT) throw new TypeError("exec chat store: redactChatMessage takes REDACTED_TEXT or UNCHECKED_TEXT only");
  if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId)) return false;
  let call = db().rpc("exec_chat_redact_message", { p_principal: principalId, p_message_id: messageId, p_text: text });
  if (opts?.signal) call = call.abortSignal(opts.signal);
  const { data, error } = await call;
  if (error) {
    if (isNotInstalled(error)) return false;
    throw failure(MESSAGES, "exec_chat_redact_message", error, opts?.signal);
  }
  if (typeof data !== "boolean") throw malformed(MESSAGES, "exec_chat_redact_message");
  return data;
}

/** C21 (5): assistant messages of this conversation with redacted_at >= sinceIso (exec_messages_redacted_idx): ids and
 *  whether their text is REDACTED_TEXT. Never other content. Same not-installed rule ([]). */
export async function listRedactedSince(principal: ExecPrincipal, conversationId: string, sinceIso: string,
  opts?: { signal?: AbortSignal }): Promise<{ id: string; verified: boolean }[]> {
  const principalId = requirePrincipal(principal);
  if (typeof conversationId !== "string" || !CONVERSATION_ID.test(conversationId)) return [];
  if (typeof sinceIso !== "string" || !Number.isFinite(Date.parse(sinceIso))) throw new TypeError("exec chat store: sinceIso must be a timestamp");
  // A redacted row's text is one of the two fixed sentences (RPCs 3 and 4 write nothing else), so reading it is no content.
  let q = db()
    .from(MESSAGES)
    .select("id,text")
    .eq("conversation_id", conversationId)
    .eq("principal_id", principalId)
    .eq("role", "assistant")
    .gte("redacted_at", sinceIso)
    .order("redacted_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1000);
  if (opts?.signal) q = q.abortSignal(opts.signal);
  const { data, error } = await q;
  if (error) {
    if (isNotInstalled(error)) return [];
    throw failure(MESSAGES, `${MESSAGES} redacted read`, error, opts?.signal);
  }
  if (!Array.isArray(data)) throw malformed(MESSAGES, `${MESSAGES} redacted read`);
  return (data as unknown as Row[]).map((r) => {
    const id = str(r.id);
    if (id === null) throw malformed(MESSAGES, `${MESSAGES} redacted read`);
    return { id, verified: r.text === REDACTED_TEXT };
  });
}

/** C20: draft ids on the cards of every assistant message exec_chat_messages_for_threads reaches (redacted or not).
 *  Callers that may import P4 pass them to P4's purgeDraftsByIds (§3.23 F8). Same not-installed rule ([]). */
export async function listChatDraftIdsForThreads(principal: ExecPrincipal, threadIds: readonly string[], opts?: { signal?: AbortSignal }): Promise<string[]> {
  const principalId = requirePrincipal(principal);
  const ids = checkIds(threadIds, "threadIds");
  const out = new Set<string>();
  for (const chunk of chunks(ids, CHAT_REDACT_CHUNK)) {
    let call = db().rpc("exec_chat_draft_ids_for_threads", { p_principal: principalId, p_thread_ids: chunk });
    if (opts?.signal) call = call.abortSignal(opts.signal);
    const { data, error } = await call;
    if (error) {
      if (isNotInstalled(error)) return [];
      throw failure(MESSAGES, "exec_chat_draft_ids_for_threads", error, opts?.signal);
    }
    if (!Array.isArray(data)) throw malformed(MESSAGES, "exec_chat_draft_ids_for_threads");
    for (const id of data) if (typeof id === "string" && DRAFT_ID.test(id)) out.add(id);
  }
  return [...out].sort();
}

async function purgeStep(table: string, what: string, run: () => PromiseLike<{ data: unknown; count?: number | null; error: DbError | null }>, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  const { data, count, error } = await run();
  if (error) {
    if (isNotInstalled(error)) return 0;
    throw failure(table, what, error, signal);
  }
  if (typeof count === "number") return count;
  return Array.isArray(data) ? data.length : 0;
}

/**
 * Purge (§3.21): expired conversations, expired messages, stale running rows. Tolerates P5b not installed (counts 0).
 * Expired messages go through RPC 6 (loop-3), which first carries each expired answer's thread ids into the earliest
 * surviving later answer of its conversation, so a later tombstone still reaches every answer that replayed it
 * (C19), hiding with UNCHECKED_TEXT where they wouldn't fit; it skips a conversation with a running answer.
 */
export async function purgeExpiredChatRows(now: Date, opts?: { signal?: AbortSignal }): Promise<{ conversations: number; messages: number; staleFailed: number }> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("exec chat store: purgeExpiredChatRows needs a valid now");
  const signal = opts?.signal;
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - CHAT_STALE_SECONDS * 1000).toISOString();
  // Deleting a conversation takes its messages and proposals (cascade).
  const conversations = await purgeStep(CONVERSATIONS, `${CONVERSATIONS} purge`, () => {
    let q = db().from(CONVERSATIONS).delete({ count: "exact" }).lt("expires_at", nowIso);
    if (signal) q = q.abortSignal(signal);
    return q;
  }, signal);
  const messages = await purgeStep(MESSAGES, "exec_chat_purge_expired_messages", async () => {
    let q = db().rpc("exec_chat_purge_expired_messages", { p_now: nowIso, p_text: UNCHECKED_TEXT });
    if (signal) q = q.abortSignal(signal);
    const { data, error } = await q;
    if (error) return { data: null, count: null, error };
    if (typeof data !== "number" || !Number.isSafeInteger(data) || data < 0) throw malformed(MESSAGES, "exec_chat_purge_expired_messages");
    return { data: null, count: data, error: null };
  }, signal);
  // B5: a running answer whose process died is failed/stale (the begin RPC sweeps too; this covers idle principals).
  const staleFailed = await purgeStep(MESSAGES, `${MESSAGES} stale sweep`, () => {
    let q = db()
      .from(MESSAGES)
      .update({ status: "failed", status_reason: "stale", finished_at: nowIso, updated_at: nowIso }, { count: "exact" })
      .eq("status", "running")
      .lt("created_at", staleBefore);
    if (signal) q = q.abortSignal(signal);
    return q;
  }, signal);
  return { conversations, messages, staleFailed };
}
