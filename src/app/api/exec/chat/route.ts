import { requireExecPrincipal } from "@/lib/exec/access";
import { CHAT_PROMPT_VERSION } from "@/lib/exec/agent/prompt";
import { withOwnSignal } from "@/lib/exec/agent/signal";
import { TOOLS_VERSION } from "@/lib/exec/agent/tool-defs";
import { prepareChatTurn, runPreparedTurn, storedTurnPayload, type ChatTurnRequest, type PreparedTurn } from "@/lib/exec/agent/turn";
import type { AgentEventSink, ChatContextInput, ChatContextKind, TurnUsage } from "@/lib/exec/agent/types";
import { ATTENTION_ITEM_ID } from "@/lib/exec/attention";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import { finishTurn } from "@/lib/exec/chat-store";
import { CHAT_TEXT_MAX, FAILED_TEXT } from "@/lib/exec/chat/copy";
import { createSseStream, SSE_HEADERS, type SseWriter } from "@/lib/exec/chat/sse-server";
import type { ChatDonePayload } from "@/lib/exec/chat/view-types";
import { assertSameOrigin, jsonError, rateLimit, readJsonBody } from "@/lib/exec/http";
import { EXEC_MODELS } from "@/lib/exec/llm/models";
import { loadSettings } from "@/lib/exec/principal";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";

// POST /api/exec/chat (P5b contract §3.16.1, B5, S1, S2, C49, C50, C55; Area D):
// one question, answered over Server-Sent Events. In this order, each failing closed:
//   1. owner gate with the step-up                 → the gate's 401 / 404 / 503
//   2. same origin                                 → 403 forbidden
//   3. the body: ≤ 16 KB JSON, exact keys          → 413 too_large / 400 bad_request | bad_text | bad_context
//   4. settings: chat installed and on             → 503 unavailable / 403 chat_off
//   5. 30 questions per 10 minutes                 → 503 unavailable when the count can't be read; at the limit it is
//      advisory (loop-4): a retried POST of a stored turn must still get its replay or busy, which the begin RPC
//      answers before its own exact limit, and a new turn gets the RPC's 429 rate_limited {retryAfterSeconds}
//   6. the audit row                               → 503 audit_unavailable
//   7. prepare (context screen + the begin RPC, on its OWN 10 s controller, never the request's signal: C55)
//        context_unavailable 409 {reason} · not_found 404 · busy 409 turn_in_progress ·
//        busy_principal 409 too_many_running · rate_limited 429 (the RPC's exact count) · DB error / timeout 503
//   8. replay → 200 SSE hello + the stored done; started → 200 SSE live:
//        hello at once, text/tool/retract as the turn runs, a comment heartbeat every 15 s, then done.
// Once prepare has started a turn the stream always opens and the turn always runs (C55): an already
// aborted request finishes it as aborted with no model call. A disconnect aborts the model call; the turn
// stores what it has on its own signals (turn.ts). A throw after hello sends error {code:"internal"}, finishes
// the row as failed on a fresh signal and closes. Answers and logs carry codes, ids and counts only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/exec/chat";
const BODY_MAX_BYTES = 16_384;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 600_000;
const PREPARE_TIMEOUT_MS = 10_000;
/** The best-effort failed finish after a throw: its own controller (B5). */
const FAIL_FINISH_MS = 10_000;

const BODY_KEYS: ReadonlySet<string> = new Set(["conversationId", "clientTurnId", "text", "context"]);
const CONTEXT_KEYS: ReadonlySet<string> = new Set(["kind", "id"]);
const CONTEXT_KINDS: readonly ChatContextKind[] = ["attention", "project", "client", "thread"];
const CONVERSATION_ID = /^ecv_[0-9a-f]{32}$/;
const CLIENT_TURN_ID = /^[A-Za-z0-9_-]{8,64}$/;
const DD_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
// P3's thread id rule: 1-200 characters, no whitespace or control characters (C0, DEL and C1).
const THREAD_ID = /^[^\s\x00-\x1f\x7f-\x9f]{1,200}$/;
/** Postgres can't store a NUL or a lone UTF-16 surrogate: such a question is refused here, not as a 503 later. */
function unstorable(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) return true;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

type BodyCode = "bad_request" | "bad_text" | "bad_context";

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** Trimmed, CRLF and lone CR → LF, 1..4,000 characters; null when it isn't a question we can store. */
function normalizeQuestion(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\r\n?/g, "\n").trim();
  if (s.length < 1 || s.length > CHAT_TEXT_MAX || unstorable(s)) return null;
  return s;
}

/** The context, null for none, undefined when it is malformed. Only kind and id: labels never come from the client. */
function parseContext(v: unknown): ChatContextInput | null | undefined {
  if (v === undefined || v === null) return null;
  if (!isPlainObject(v)) return undefined;
  if (Object.keys(v).some((k) => !CONTEXT_KEYS.has(k))) return undefined;
  const kind = v.kind;
  const id = v.id;
  if (typeof kind !== "string" || !(CONTEXT_KINDS as readonly string[]).includes(kind) || typeof id !== "string") return undefined;
  const shape = kind === "attention" ? ATTENTION_ITEM_ID : kind === "thread" ? THREAD_ID : DD_ID;
  if (!shape.test(id)) return undefined;
  return { kind: kind as ChatContextKind, id };
}

function parseChatBody(v: unknown): { ok: true; value: ChatTurnRequest } | { ok: false; code: BodyCode } {
  if (!isPlainObject(v) || Object.keys(v).some((k) => !BODY_KEYS.has(k))) return { ok: false, code: "bad_request" };
  const conversationId = v.conversationId === undefined ? null : v.conversationId;
  if (conversationId !== null && (typeof conversationId !== "string" || !CONVERSATION_ID.test(conversationId))) return { ok: false, code: "bad_request" };
  if (typeof v.clientTurnId !== "string" || !CLIENT_TURN_ID.test(v.clientTurnId)) return { ok: false, code: "bad_request" };
  const text = normalizeQuestion(v.text);
  if (text === null) return { ok: false, code: "bad_text" };
  const context = parseContext(v.context);
  if (context === undefined) return { ok: false, code: "bad_context" };
  return { ok: true, value: { conversationId, clientTurnId: v.clientTurnId, surface: "web", text, context } };
}

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "error");

function logId(id: unknown): string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "unknown";
}

/** Step 7's refusals, each with its exact answer. */
function refusalAnswer(p: Exclude<PreparedTurn, { kind: "started" } | { kind: "replay" }>): Response {
  switch (p.kind) {
    case "context_unavailable":
      return jsonError(409, "context_unavailable", { reason: p.reason });
    case "not_found":
      return jsonError(404, "not_found");
    case "busy":
      // C50: the client polls this conversation (it may not know the id yet: a retried first question).
      return jsonError(409, "turn_in_progress", p.conversationId ? { conversationId: p.conversationId } : undefined);
    case "busy_principal":
      return jsonError(409, "too_many_running");
    case "rate_limited":
      return jsonError(429, "rate_limited", { retryAfterSeconds: p.retryAfterSeconds });
  }
}

function emptyUsage(): TurnUsage {
  return {
    modelCalls: 0, toolCalls: 0, toolCallsNotPersisted: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    costUsd: 0, transformations: 0, unknownMarkers: 0, partialRoundUncounted: false, promptVersion: CHAT_PROMPT_VERSION, toolsVersion: TOOLS_VERSION
  };
}

/** After a throw past hello: the running row finished as failed on a fresh signal (never the request's). Best effort. */
async function finishAsFailed(principal: ExecPrincipal, begin: Extract<PreparedTurn, { kind: "started" }>["begin"]): Promise<void> {
  try {
    await withOwnSignal(FAIL_FINISH_MS, (signal) =>
      finishTurn(
        principal,
        {
          messageId: begin.assistantMessageId,
          status: "failed",
          statusReason: "internal",
          refusalCategory: null,
          text: FAILED_TEXT,
          recommendations: "",
          sources: [],
          cards: [],
          toolCalls: [],
          consultedEmailThreadIds: [],
          consultedClientIds: [],
          consultedDdText: false,
          usage: emptyUsage(),
          model: EXEC_MODELS.chat,
          refSeq: begin.refSeq
        },
        { signal }
      )
    );
  } catch (err) {
    console.error(`[exec-chat] ${ROUTE} turn ${logId(begin.turnId)}: failed finish not written (${errName(err)})`);
  }
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { status: 200, headers: { ...SSE_HEADERS } });
}

/** 8, replay: the stored turn, never re-run (C50). */
async function replayAnswer(principal: ExecPrincipal, p: Extract<PreparedTurn, { kind: "replay" }>, req: Request, now: Date, auditId: number): Promise<Response> {
  let done: ChatDonePayload;
  try {
    done = await storedTurnPayload(principal, p.conversation, p.turn, now, { signal: req.signal });
  } catch (err) {
    console.error(`[exec-chat] ${ROUTE} ${principal.id}: replay unavailable (${errName(err)})`);
    await auditFinish(auditId, { ok: false, result: { outcome: "unavailable" } });
    return jsonError(503, "unavailable");
  }
  await auditFinish(auditId, { ok: true, result: { outcome: "replay" } });
  return sseResponse(
    createSseStream({
      heartbeatMs: 0,
      start: (w) => {
        w.send({ event: "hello", data: { turnId: p.turn.turnId, conversationId: p.conversation.id, messageId: done.messageId, created: false } });
        w.send({ event: "done", data: done });
        w.close();
      }
    })
  );
}

/** 8, started: the live stream. The turn's signal follows the request's and a cancelled stream (a disconnect). */
function liveAnswer(
  principal: ExecPrincipal, settings: ExecSettings, p: Extract<PreparedTurn, { kind: "started" }>, turn: ChatTurnRequest, req: Request, now: Date, auditId: number
): Response {
  const begin = p.begin;
  const turnAbort = new AbortController();
  const onRequestAbort = () => turnAbort.abort(req.signal.reason);
  if (req.signal.aborted) turnAbort.abort(req.signal.reason);
  else req.signal.addEventListener("abort", onRequestAbort, { once: true });

  const run = async (w: SseWriter): Promise<void> => {
    const sink: AgentEventSink = {
      text: (round, delta) => void w.send({ event: "text", data: { round, delta } }),
      tool: (e) => void w.send({ event: "tool", data: { round: e.round, callId: e.callId, name: e.name, label: e.label, state: e.state } }),
      retract: () => void w.send({ event: "retract", data: {} })
    };
    try {
      const out = await runPreparedTurn(principal, settings, p, turn, { signal: turnAbort.signal, sink, now });
      w.send({ event: "done", data: out.done });
      await auditFinish(auditId, {
        ok: out.audit.status !== "failed",
        result: {
          status: out.audit.status,
          statusReason: out.audit.statusReason,
          modelCalls: out.audit.modelCalls,
          toolCalls: out.audit.toolCalls,
          costUsd: out.audit.costUsd
        }
      });
    } catch (err) {
      console.error(`[exec-chat] ${ROUTE} turn ${logId(begin.turnId)} failed after hello (${errName(err)})`);
      w.send({ event: "error", data: { code: "internal" } });
      await finishAsFailed(principal, begin);
      await auditFinish(auditId, { ok: false, result: { status: "failed", statusReason: "internal" } });
    } finally {
      w.close();
      req.signal.removeEventListener("abort", onRequestAbort);
    }
  };

  return sseResponse(
    createSseStream({
      onCancel: () => {
        if (!turnAbort.signal.aborted) turnAbort.abort();
      },
      start: (w) => {
        w.send({ event: "hello", data: { turnId: begin.turnId, conversationId: begin.conversationId, messageId: begin.assistantMessageId, created: begin.created } });
        void run(w);
      }
    })
  );
}

export async function POST(req: Request) {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  const origin = assertSameOrigin(req);
  if (!origin.ok) return origin.response;
  const principal = gate.principal;
  const now = new Date();

  const read = await readJsonBody(req, BODY_MAX_BYTES);
  if (!read.ok) return read.reason === "too_large" ? jsonError(413, "too_large") : jsonError(400, "bad_request");
  const parsed = parseChatBody(read.value);
  if (!parsed.ok) return jsonError(400, parsed.code);
  const turn = parsed.value;

  let settings: ExecSettings;
  try {
    settings = await loadSettings(principal.id);
  } catch (err) {
    console.error(`[exec-chat] ${ROUTE} ${principal.id}: settings read failed (${errName(err)})`);
    return jsonError(503, "unavailable");
  }
  if (!settings.chatSchemaReady || !settings.chatEnabled) return jsonError(403, "chat_off");

  const limited = await rateLimit(principal, "chat", RATE_LIMIT, RATE_WINDOW_MS, { now });
  if (!limited.ok && limited.response.status !== 429) return limited.response;

  let auditId: number;
  try {
    auditId = await auditStart(principal, {
      actor: "owner",
      action: "chat.turn",
      target: `exec_conversations:${turn.conversationId ?? "new"}`,
      input: { conversationId: turn.conversationId, contextKind: turn.context?.kind ?? null, textChars: turn.text.length }
    });
  } catch {
    // auditStart logged why (it only throws AuditUnavailableError).
    return jsonError(503, "audit_unavailable");
  }

  let prepared: PreparedTurn;
  try {
    prepared = await prepareChatTurn(principal, settings, turn, now, { timeoutMs: PREPARE_TIMEOUT_MS });
  } catch (err) {
    console.error(`[exec-chat] ${ROUTE} ${principal.id}: prepare failed (${errName(err)})`);
    await auditFinish(auditId, { ok: false, result: { outcome: "unavailable" } });
    return jsonError(503, "unavailable");
  }

  switch (prepared.kind) {
    case "started":
      return liveAnswer(principal, settings, prepared, turn, req, now, auditId);
    case "replay":
      return replayAnswer(principal, prepared, req, now, auditId);
    default:
      await auditFinish(auditId, { ok: false, result: { outcome: prepared.kind } });
      return refusalAnswer(prepared);
  }
}
