"use client";

// Client-side cache for lazily-loaded message bodies. When a thread is opened
// with deferred bodies, only the latest message arrives with its body inline;
// older messages carry `body_deferred: true` and their body is fetched on demand
// when the user expands them (or replies to one, which needs the quoted body).
//
// Two goals, mirroring thread-cache.ts:
//   1. Persist a fetched body for the life of the page, so collapse→re-expand
//      (or expand-then-reply) doesn't refetch.
//   2. In-flight dedupe: expanding a message and replying to it at the same time
//      share ONE request.
//
// Keyed by messageId (a body is immutable for a given message id). Holds only
// data fetched through the access-checked `/api/inboxes/messages/[id]/body`
// route, so it adds no new authorization surface.

export interface MessageBody {
  body_html: string | null;
  body_text: string | null;
}

const resolved = new Map<string, MessageBody>();
const inFlight = new Map<string, Promise<MessageBody>>();

function url(messageId: string, accountId: string, threadId: string) {
  return (
    `/api/inboxes/messages/${encodeURIComponent(messageId)}/body` +
    `?account=${encodeURIComponent(accountId)}&thread=${encodeURIComponent(threadId)}`
  );
}

export function getCachedBody(messageId: string): MessageBody | undefined {
  return resolved.get(messageId);
}

// Fetch a message body, deduping against any request already in flight for the
// same message. Resolves with the parsed body and populates the cache. Rejects
// on HTTP/parse errors (callers decide how to surface). `signal` only aborts the
// CALLER's await — the shared request keeps running so a concurrent consumer
// (e.g. the reply composer) still gets the result.
export function fetchDeferredBody(
  messageId: string,
  accountId: string,
  threadId: string,
  signal?: AbortSignal
): Promise<MessageBody> {
  const cached = resolved.get(messageId);
  if (cached) return Promise.resolve(cached);

  const existing = inFlight.get(messageId);
  if (existing) return signal ? withSignal(existing, signal) : existing;

  const req = fetch(url(messageId, accountId, threadId))
    .then(async (r) => {
      if (!r.ok) {
        const j = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error || `Couldn't load message (${r.status})`);
      }
      return (await r.json()) as MessageBody;
    })
    .then((data) => {
      const body: MessageBody = {
        body_html: data.body_html ?? null,
        body_text: data.body_text ?? null
      };
      resolved.set(messageId, body);
      return body;
    })
    .finally(() => {
      inFlight.delete(messageId);
    });

  inFlight.set(messageId, req);
  return signal ? withSignal(req, signal) : req;
}

// Wrap a shared promise so the caller's await rejects on its own abort signal
// without cancelling the underlying (possibly shared) request.
function withSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}
