import type { ChatContextKind } from "@/lib/exec/agent/types";
import { createSseParser } from "@/lib/exec/chat/sse-parse";
import type { ChatConversationView, ChatMessageView, ChatSseEvent, ProposalView } from "@/lib/exec/chat/view-types";

// The chat's HTTP side in the browser (P5b contract §3.19.4, §3.16; Area E):
// the POST that streams a turn, the GET that recovers one, and the proposal
// Confirm / Dismiss posts. No React here, so tests drive it with a fake fetch.
// Nothing is logged: an answer, a question or an error body never reaches the
// console (boundary B3); the callers only see kinds and codes.
//
// The POST is the repo's first POST stream reader: EventSource can't POST
// (CA §4.5), so the body is read with getReader() through one TextDecoder
// (stream mode, so a character split across chunks is joined) into
// createSseParser.

export const CHAT_ENDPOINT = "/api/exec/chat";
export const conversationEndpoint = (id: string) => `/api/exec/conversations/${encodeURIComponent(id)}`;
export const proposalEndpoint = (id: string, action: "confirm" | "dismiss") => `/api/exec/tasks/proposals/${encodeURIComponent(id)}/${action}`;

/** §3.16.1's request body. */
export interface ChatPostBody {
  conversationId: string | null;
  clientTurnId: string;
  text: string;
  context: { kind: ChatContextKind; id: string } | null;
}

export type ChatPostOutcome =
  /** The route answered without a stream: its code, the context reason, and Retry-After in seconds. */
  | { kind: "http_error"; status: number; error: string | null; reason: "gone" | "check_failed" | null; retryAfterSec: number | null; conversationId: string | null }
  /** No answer at all (DNS, offline, a reset before the headers). */
  | { kind: "network_error" }
  /** The caller's signal aborted it (Stop). */
  | { kind: "aborted"; sawHello: boolean; conversationId: string | null; turnId: string | null }
  /** The stream closed: whether hello, done or error came, and the ids hello carried. */
  | { kind: "ended"; sawHello: boolean; sawDone: boolean; sawError: boolean; conversationId: string | null; turnId: string | null };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
}

function retryAfterOf(res: Response, body: Record<string, unknown> | null): number | null {
  const fromBody = body?.retryAfterSeconds;
  if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody >= 0) return Math.ceil(fromBody);
  const header = res.headers.get("retry-after");
  if (header !== null && /^\d{1,6}$/.test(header.trim())) return Number(header.trim());
  return null;
}

async function jsonBody(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await res.json();
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A client turn id the route accepts (^[A-Za-z0-9_-]{8,64}$): a random UUID. */
export function newClientTurnId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * POST one turn and hand every parsed event to onEvent as it arrives. Resolves
 * once the stream closes, the route refuses, the network fails or the signal
 * aborts; never throws.
 */
export async function postChatTurn(
  body: ChatPostBody,
  opts: { signal?: AbortSignal; onEvent: (e: ChatSseEvent) => void; fetchImpl?: FetchLike }
): Promise<ChatPostOutcome> {
  const doFetch = opts.fetchImpl ?? defaultFetch;
  let sawHello = false;
  let sawDone = false;
  let sawError = false;
  let conversationId: string | null = null;
  let turnId: string | null = null;
  const parser = createSseParser((e) => {
    if (e.event === "hello") {
      sawHello = true;
      conversationId = e.data.conversationId;
      turnId = e.data.turnId;
    } else if (e.event === "done") sawDone = true;
    else if (e.event === "error") sawError = true;
    opts.onEvent(e);
  });

  let res: Response;
  try {
    res = await doFetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: opts.signal,
      credentials: "same-origin",
      cache: "no-store"
    });
  } catch (err) {
    return isAbort(err, opts.signal) ? { kind: "aborted", sawHello, conversationId, turnId } : { kind: "network_error" };
  }

  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.toLowerCase().startsWith("text/event-stream") || res.body === null) {
    const json = await jsonBody(res);
    const error = typeof json?.error === "string" ? json.error : null;
    const reason = json?.reason === "gone" || json?.reason === "check_failed" ? json.reason : null;
    const conv = typeof json?.conversationId === "string" ? json.conversationId : null;
    // A 200 that isn't a stream is a broken answer, not a refusal: treated like a 5xx (C50 keeps the question).
    const status = res.ok ? 502 : res.status;
    return { kind: "http_error", status, error, reason, retryAfterSec: retryAfterOf(res, json), conversationId: conv };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) parser.push(decoder.decode(value, { stream: true }));
      if (sawDone || sawError) break;
    }
    parser.push(decoder.decode());
    parser.end();
  } catch (err) {
    parser.end();
    if (isAbort(err, opts.signal)) return { kind: "aborted", sawHello, conversationId, turnId };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released or the stream errored: nothing to free.
    }
  }
  return { kind: "ended", sawHello, sawDone, sawError, conversationId, turnId };
}

export type ConversationRead =
  | { ok: true; conversation: ChatConversationView; messages: ChatMessageView[]; hasEarlier: boolean }
  | { ok: false; status: number };

/** GET /api/exec/conversations/:id (§3.16.2). status 0 = the network failed; never throws. */
export async function fetchConversation(id: string, opts: { signal?: AbortSignal; fetchImpl?: FetchLike } = {}): Promise<ConversationRead> {
  const doFetch = opts.fetchImpl ?? defaultFetch;
  let res: Response;
  try {
    res = await doFetch(conversationEndpoint(id), { method: "GET", headers: { Accept: "application/json" }, signal: opts.signal, credentials: "same-origin", cache: "no-store" });
  } catch {
    return { ok: false, status: 0 };
  }
  if (!res.ok) return { ok: false, status: res.status };
  const json = await jsonBody(res);
  if (!json || !Array.isArray(json.messages) || typeof json.conversation !== "object" || json.conversation === null) return { ok: false, status: 502 };
  return {
    ok: true,
    conversation: json.conversation as ChatConversationView,
    messages: json.messages as ChatMessageView[],
    hasEarlier: json.hasEarlier === true
  };
}

export const RECOVERY_INTERVAL_MS = 3_000;
export const RECOVERY_MAX_MS = 120_000;

export type RecoveryOutcome =
  | { kind: "settled"; messages: ChatMessageView[] }
  /** 401/404: the conversation (or the session) is gone. */
  | { kind: "gone" }
  | { kind: "timeout" }
  | { kind: "aborted" };

/** The turn has settled when its answer (by turn id, or any answer when the id isn't known) isn't running. */
export function turnSettled(messages: readonly ChatMessageView[], turnId: string | null): boolean {
  const answers = messages.filter((m) => m.role === "assistant");
  if (turnId !== null) {
    const mine = answers.find((m) => m.turnId === turnId);
    if (mine) return mine.status !== "running";
  }
  return answers.every((m) => m.status !== "running");
}

/**
 * §3.19.4 recovery: GET the conversation every 3 s for up to 2 min until the
 * turn's answer isn't running. A failed read (network, 5xx) waits for the next
 * tick; 401/404 stops.
 */
export async function pollUntilSettled(
  conversationId: string,
  turnId: string | null,
  opts: { signal?: AbortSignal; fetchImpl?: FetchLike; intervalMs?: number; maxMs?: number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; nowMs?: () => number } = {}
): Promise<RecoveryOutcome> {
  const interval = opts.intervalMs ?? RECOVERY_INTERVAL_MS;
  const max = opts.maxMs ?? RECOVERY_MAX_MS;
  const now = opts.nowMs ?? (() => Date.now());
  const sleep =
    opts.sleep ??
    ((ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      }));
  const started = now();
  for (;;) {
    if (opts.signal?.aborted) return { kind: "aborted" };
    const read = await fetchConversation(conversationId, { signal: opts.signal, fetchImpl: opts.fetchImpl });
    if (opts.signal?.aborted) return { kind: "aborted" };
    if (read.ok && turnSettled(read.messages, turnId)) return { kind: "settled", messages: read.messages };
    if (!read.ok && (read.status === 401 || read.status === 404)) return { kind: "gone" };
    if (now() - started + interval > max) return { kind: "timeout" };
    await sleep(interval, opts.signal);
  }
}

export type ProposalActionOutcome =
  | { kind: "updated"; proposal: ProposalView }
  /** 409 changed (C43): the card was out of date; show the returned proposal and say so. */
  | { kind: "changed"; proposal: ProposalView }
  /** ui-8: status 0 = the network failed; error the route's code, so the card can say what failed and whether to retry. */
  | { kind: "failed"; status?: number; error?: string | null };

/**
 * Confirm (posts the card's contentHash, C43) or Dismiss one proposal, and the
 * card's next state. 200 confirmed / dismissed; 409 changed re-renders the
 * returned proposal; 409 not_pending takes the status it names; 409
 * in_progress is "confirming"; 410 expired; 404 removed; anything else
 * (409 assignee_unavailable, 429, 5xx, the network) is the card's error line.
 */
export async function postProposalAction(
  proposal: ProposalView,
  action: "confirm" | "dismiss",
  opts: { signal?: AbortSignal; fetchImpl?: FetchLike } = {}
): Promise<ProposalActionOutcome> {
  const doFetch = opts.fetchImpl ?? defaultFetch;
  let res: Response;
  try {
    res = await doFetch(proposalEndpoint(proposal.id, action), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: action === "confirm" ? JSON.stringify({ contentHash: proposal.contentHash }) : "{}",
      signal: opts.signal,
      credentials: "same-origin",
      cache: "no-store"
    });
  } catch {
    return { kind: "failed", status: 0, error: null };
  }
  const json = await jsonBody(res);
  if (res.ok) {
    if (action === "confirm" && json?.status === "confirmed") {
      const taskHref = typeof json.taskHref === "string" ? json.taskHref : typeof json.taskId === "string" ? `/tasks/${json.taskId}` : proposal.taskHref;
      return { kind: "updated", proposal: { ...proposal, status: "confirmed", taskHref } };
    }
    if (action === "dismiss" && json?.status === "dismissed") return { kind: "updated", proposal: { ...proposal, status: "dismissed" } };
    return { kind: "failed", status: res.status, error: null };
  }
  const error = typeof json?.error === "string" ? json.error : null;
  if (res.status === 409 && error === "changed" && typeof json?.proposal === "object" && json.proposal !== null) {
    return { kind: "changed", proposal: json.proposal as ProposalView };
  }
  if (res.status === 409 && error === "not_pending") {
    const status = json?.status;
    if (status === "confirmed" || status === "confirming" || status === "dismissed" || status === "withdrawn" || status === "expired" || status === "pending") {
      // ui-8: confirmed elsewhere (another tab): the route names the task, so the card can link to it.
      const taskHref = status === "confirmed" && typeof json?.taskId === "string" ? `/tasks/${encodeURIComponent(json.taskId)}` : proposal.taskHref;
      return { kind: "updated", proposal: { ...proposal, status, taskHref } };
    }
    return { kind: "failed", status: res.status, error };
  }
  if (res.status === 409 && error === "in_progress") return { kind: "updated", proposal: { ...proposal, status: "confirming" } };
  if (res.status === 410) return { kind: "updated", proposal: { ...proposal, status: "expired" } };
  if (res.status === 404) return { kind: "updated", proposal: { ...proposal, status: "withdrawn" } };
  return { kind: "failed", status: res.status, error };
}
