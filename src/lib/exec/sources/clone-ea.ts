import "server-only";

import { CLONE_IDEMPOTENCY_KEY_RE, CloneEaError, parseCloneErrorBody, parseRetryAfterMs, type CloneEaRoute } from "@/lib/exec/clone-ea-types";
import { NonRetryableError } from "@/lib/exec/types";

// The one module that makes CL2 HTTP calls (P4 contract §3.2.2; boundary B4:
// imported only by sources/mail.ts and send.ts).
//
// Rules (§3.2.2): cache "no-store"; Accept application/json; the bearer only
// when `token` is non-null (never read from process.env here, L2); Idempotency-Key
// when given; path ids are encoded by CLONE_EA_PATHS with their case kept; an
// own AbortController per call and NO caller signal (B12, hard rule 9); the
// response text read under the same abort, at most 4 MB; a 2xx whose body isn't
// JSON is invalid_body; a non-2xx is a CloneEaError built from the clone's JSON
// error body (an HTML or edge page is kind edge); a rejected fetch is transport,
// the own timeout is timeout. Never logs the token, the request body, the
// response body or `detail`: a log line names the route, the status and the code.

export interface CloneEaCall {
  route: CloneEaRoute;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** From CLONE_EA_PATHS only. */
  path: string;
  /** null = no Authorization header (/api/status only). Never read from process.env here (L2). */
  token: string | null;
  json?: Record<string, unknown>;
  /** ^[A-Za-z0-9_.:-]{1,128}$, else NonRetryableError before any fetch. */
  idempotencyKey?: string;
  /** C4; own AbortController. There is NO signal parameter (B12, hard rule 9). */
  timeoutMs: number;
}
export interface CloneEaResponse { status: number; body: unknown; replay: boolean }

/** The CL2 routes (CL2C §3.0-§3.6, DD-consumer view). Ids are encoded, case kept (Graph ids are case-sensitive). */
export const CLONE_EA_PATHS: {
  status(): string; authMe(): string; createReply(threadId: string): string; createNew(): string;
  draft(graphId: string): string; send(graphId: string): string;
} = Object.freeze({
  status: () => "/api/status",
  authMe: () => "/api/auth/me",
  createReply: (threadId: string) => `/api/threads/${encodeURIComponent(threadId)}/outlook-draft`,
  createNew: () => "/api/compose/outlook-draft",
  draft: (graphId: string) => `/api/outlook-drafts/${encodeURIComponent(graphId)}`,
  send: (graphId: string) => `/api/outlook-drafts/${encodeURIComponent(graphId)}/send`
});

/** A read-back body can be about 1 MB plus the quoted thread; anything past this is cut and reported as invalid_body. */
export const CLONE_EA_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** process.env.MISSIVE_API_URL trimmed, trailing slashes stripped; throws NonRetryableError("clone base URL not configured", "auth") when unset. */
export function cloneEaBaseUrl(): string {
  const raw = process.env.MISSIVE_API_URL;
  const url = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
  if (url.length === 0) throw new NonRetryableError("clone base URL not configured", "auth");
  return url;
}

// The reason an own timeout aborts with; identity-compared, so a caller's
// AbortError can't be mistaken for it.
class CloneEaTimeout extends Error {
  constructor(route: CloneEaRoute, ms: number) {
    super(`clone ${route} call timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

/** The first string `code` in an error's cause chain (undici puts ECONNREFUSED and friends there), else its name. */
function transportCode(err: unknown): string {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  for (let i = 0; i < queue.length && i < 16; i += 1) {
    const node = queue[i];
    if (typeof node !== "object" || node === null || seen.has(node)) continue;
    seen.add(node);
    const record = node as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === "string" && record.code.length > 0) return record.code.slice(0, 64);
    if ("cause" in record) queue.push(record.cause);
    if (Array.isArray(record.errors)) queue.push(...record.errors.slice(0, 8));
  }
  return err instanceof Error && err.name ? err.name : "unknown";
}

/** The whole response as text, or `cut` when it passed CLONE_EA_MAX_RESPONSE_BYTES (the rest is cancelled, never buffered). */
async function readBodyText(res: Response, signal: AbortSignal): Promise<{ text: string; cut: boolean }> {
  const stream = res.body;
  if (!stream) return { text: await res.text(), cut: false };
  const reader = stream.getReader();
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > CLONE_EA_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { text: "", cut: true };
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (signal.aborted) throw signal.reason;
  return { text: Buffer.concat(chunks).toString("utf8"), cut: false };
}

function logFailure(route: CloneEaRoute, status: number | null, code: string, extra?: string): void {
  console.warn(`[clone-ea] ${route} ${status === null ? "no status" : status} ${code}${extra ? ` ${extra}` : ""}`);
}

export async function cloneEaFetch(call: CloneEaCall): Promise<CloneEaResponse> {
  const { route } = call;
  if (call.idempotencyKey !== undefined && (typeof call.idempotencyKey !== "string" || !CLONE_IDEMPOTENCY_KEY_RE.test(call.idempotencyKey))) {
    throw new NonRetryableError(`clone ${route}: the idempotency key is malformed`);
  }
  if (typeof call.timeoutMs !== "number" || !Number.isFinite(call.timeoutMs) || call.timeoutMs <= 0) {
    throw new NonRetryableError(`clone ${route}: timeoutMs must be a positive number of ms`);
  }
  if (typeof call.path !== "string" || !call.path.startsWith("/api/")) throw new NonRetryableError(`clone ${route}: the path is not a CL2 route`);
  const url = `${cloneEaBaseUrl()}${call.path}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (call.token !== null) headers.authorization = `Bearer ${call.token}`;
  if (call.json !== undefined) headers["content-type"] = "application/json";
  if (call.idempotencyKey !== undefined) headers["idempotency-key"] = call.idempotencyKey;

  const controller = new AbortController();
  const timeout = new CloneEaTimeout(route, call.timeoutMs);
  const timer = setTimeout(() => controller.abort(timeout), call.timeoutMs);
  const timedOut = () => controller.signal.aborted && controller.signal.reason === timeout;
  let res: Response;
  let text: string;
  let cut: boolean;
  try {
    res = await fetch(url, {
      method: call.method,
      headers,
      body: call.json === undefined ? undefined : JSON.stringify(call.json),
      cache: "no-store",
      signal: controller.signal
    });
    ({ text, cut } = await readBodyText(res, controller.signal));
  } catch (err) {
    clearTimeout(timer);
    if (timedOut()) {
      logFailure(route, null, "timeout");
      throw new CloneEaError({ route, status: null, body: null, code: "timeout" });
    }
    logFailure(route, null, "transport", transportCode(err));
    throw new CloneEaError({ route, status: null, body: null, code: "transport" });
  }
  clearTimeout(timer);

  const replay = (res.headers.get("idempotent-replay") ?? "").trim().toLowerCase() === "true";
  if (res.status >= 200 && res.status < 300) {
    let body: unknown;
    try {
      if (cut) throw new Error("cut");
      body = JSON.parse(text);
    } catch {
      logFailure(route, res.status, "invalid_body");
      throw new CloneEaError({ route, status: res.status, body: null, code: "invalid_body", replay });
    }
    return { status: res.status, body, replay };
  }
  const errorBody = cut ? null : parseCloneErrorBody(res.headers.get("content-type"), text);
  const retryAfterMs = res.status === 429 ? parseRetryAfterMs(res.headers.get("retry-after")) : null;
  const error = new CloneEaError({
    route,
    status: res.status,
    body: errorBody,
    ...(errorBody === null ? { code: "edge" } : {}),
    retryAfterMs,
    replay
  });
  if (errorBody === null || res.status >= 500) logFailure(route, res.status, error.code);
  throw error;
}
