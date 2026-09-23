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
//
// It is also a tiny external store: the thread view derives each message's
// attachment chips from its body (an inline image referenced by `cid:` must not
// also chip), so it needs to re-render when a deferred body lands or fails —
// including ones warmed by the background prefetch, which nothing else awaits.

import { useSyncExternalStore } from "react";

export interface MessageBody {
  body_html: string | null;
  body_text: string | null;
}

const resolved = new Map<string, MessageBody>();
const inFlight = new Map<string, Promise<MessageBody>>();
// Ids whose last fetch failed. Sticky until a later fetch SUCCEEDS (a retry in
// flight doesn't clear it), so a consumer that falls back to "show every
// attachment" on failure never hides a file mid-retry.
const failed = new Set<string>();

const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify() {
  listeners.forEach((fn) => fn());
}

export type BodyStatus = "ready" | "failed" | "pending";

// Where a deferred body stands in this page's cache. "pending" covers both
// "in flight" and "never requested".
export function getBodyStatus(messageId: string): BodyStatus {
  if (resolved.has(messageId)) return "ready";
  return failed.has(messageId) ? "failed" : "pending";
}

// Re-render when THIS message's body lands or fails (null = not watching, e.g.
// a message whose body arrived inline). Per message on purpose: every landing
// notifies every subscriber, but only the one whose status actually changed
// re-renders — so the thread view keeps this in small per-message components
// rather than re-rendering a long thread once per body the prefetch warms. The
// status is a string, so useSyncExternalStore's Object.is check is a value
// compare. Same function for the server snapshot: nothing resolves during SSR.
export function useBodyStatus(messageId: string | null): BodyStatus | null {
  const getSnapshot = () => (messageId ? getBodyStatus(messageId) : null);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

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
      failed.delete(messageId);
      return body;
    })
    // Marked here, on the shared request, not in the callers: the prefetch
    // swallows its errors, and a caller's own abort (withSignal) never rejects
    // this chain, so collapsing a card mid-load never marks it failed.
    .catch((err: unknown) => {
      failed.add(messageId);
      throw err;
    })
    .finally(() => {
      inFlight.delete(messageId);
      notify();
    });

  inFlight.set(messageId, req);
  return signal ? withSignal(req, signal) : req;
}

// Bulk pre-warm every deferred body in a thread in the background, so expanding
// any collapsed message is instant (its body is already cached). Concurrency-
// capped so a long chain doesn't fire dozens of requests at once. Skips bodies
// already cached or in flight; the on-expand path (fetchDeferredBody) dedupes
// against these, and getCachedBody lets the card render with no loading flash
// once warmed. Fire-and-forget — errors are swallowed (a later expand retries).
const MAX_BODY_PREFETCH = 5;

export function prefetchThreadBodies(
  messages: Array<{
    id: string;
    body_deferred?: boolean | null;
    body_html?: string | null;
    body_text?: string | null;
  }>,
  accountId: string,
  threadId: string
): void {
  // Seed the cache with bodies that arrived inline (the latest message). A
  // later fetch — a new reply, an SWR revalidate — ships that same row
  // deferred, and without this it would drop back to "pending": its Content-ID
  // file chips (an Outlook PDF) would vanish until a refetch landed, and the
  // prefetch below would pay a clone round-trip for a body we already had. No
  // notify: a row carrying its body inline isn't one the thread view watches.
  for (const m of messages) {
    if (m.body_deferred || resolved.has(m.id)) continue;
    if (m.body_html == null && m.body_text == null) continue;
    resolved.set(m.id, { body_html: m.body_html ?? null, body_text: m.body_text ?? null });
    failed.delete(m.id);
  }

  const ids = messages
    .filter((m) => m.body_deferred && !m.body_html && !resolved.has(m.id) && !inFlight.has(m.id))
    .map((m) => m.id)
    // Newest-deferred first: messages are ordered oldest→newest, and the reader
    // works down from the (inline) latest, so warm the ones nearest the bottom
    // — the most-likely-next expands — before the old ones at the top.
    .reverse();
  if (ids.length === 0) return;
  let idx = 0;
  let active = 0;
  const pump = () => {
    while (active < MAX_BODY_PREFETCH && idx < ids.length) {
      const id = ids[idx++];
      if (resolved.has(id) || inFlight.has(id)) continue;
      active++;
      fetchDeferredBody(id, accountId, threadId)
        .catch(() => {})
        .finally(() => { active--; pump(); });
    }
  };
  pump();
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
