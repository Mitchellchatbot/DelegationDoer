"use client";

import type { ThreadDetailData } from "@/components/ThreadConversation";
import { prefetchThreadBodies } from "@/lib/message-body-cache";

// Client-side cache for opened email threads. Two goals:
//   1. Stale-while-revalidate: re-opening a thread you've already viewed renders
//      instantly from memory while a fresh copy loads in the background — no
//      spinner on revisit.
//   2. In-flight dedupe: a hover-prefetch and the subsequent click (or two
//      rapid opens of the same thread) share ONE network request instead of
//      racing duplicates.
//
// This lives in module scope, so it persists across ThreadReadingPane mounts for
// the life of the page (which is the logged-in session — the inbox list page is
// force-dynamic and re-runs SSR on real navigation/refresh, dropping this cache).
// It holds only data the user already fetched through the access-checked
// `/api/inboxes/threads/[id]` route, so it adds no new authorization surface.

const resolved = new Map<string, ThreadDetailData>();
const inFlight = new Map<string, Promise<ThreadDetailData>>();

// Cache key. The payload bakes in account-scoped fields (reply-all sets, the
// send-from list, the "your address" used for dedup), so the SAME thread opened
// under a different inbox is a genuinely different payload — key on both.
function keyOf(threadId: string, accountId: string) {
  return `${threadId}::${accountId}`;
}

function url(threadId: string, accountId: string) {
  return `/api/inboxes/threads/${encodeURIComponent(
    threadId
  )}?account=${encodeURIComponent(accountId)}`;
}

export function getCachedThread(
  threadId: string,
  accountId: string
): ThreadDetailData | undefined {
  return resolved.get(keyOf(threadId, accountId));
}

// Fetch a thread, deduping against any request already in flight for the same
// (thread, account). Resolves with the parsed payload and populates the
// resolved cache. Rejects on HTTP/parse errors (callers decide how to surface).
// `signal` only aborts the CALLER's await — the shared request keeps running so
// a prefetch isn't cancelled when an unrelated component unmounts.
export function fetchThread(
  threadId: string,
  accountId: string,
  signal?: AbortSignal
): Promise<ThreadDetailData> {
  const key = keyOf(threadId, accountId);
  const existing = inFlight.get(key);
  if (existing) return signal ? withSignal(existing, signal) : existing;

  const req = fetch(url(threadId, accountId))
    .then(async (r) => {
      if (!r.ok) {
        const j = await r.json().catch(() => ({} as { error?: string }));
        throw new Error(j.error || `Couldn't load thread (${r.status})`);
      }
      return (await r.json()) as ThreadDetailData;
    })
    .then((data) => {
      resolved.set(key, data);
      return data;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, req);
  return signal ? withSignal(req, signal) : req;
}

// Background prefetch is concurrency-capped so viewport/eager warming can't
// fire a dozen getThread calls at the clone at once. The CLICK path
// (fetchThread, called directly by the reading pane) is never throttled — a
// real open always goes immediately and dedupes against any queued/active
// prefetch.
const MAX_PREFETCH_CONCURRENCY = 4;
let activePrefetches = 0;
const prefetchQueue: Array<() => void> = [];

function pumpPrefetchQueue(): void {
  while (activePrefetches < MAX_PREFETCH_CONCURRENCY && prefetchQueue.length > 0) {
    const run = prefetchQueue.shift();
    run?.();
  }
}

// Fire-and-forget warm-up for a thread the user is likely about to open (hover /
// mousedown / scrolled into view). Reuses the resolved cache and in-flight
// dedupe, so it's cheap to call repeatedly and never duplicates a request.
// Swallows errors — the real open will surface them.
export function prefetchThread(threadId: string, accountId: string): void {
  const key = keyOf(threadId, accountId);
  if (resolved.has(key) || inFlight.has(key)) return;
  prefetchQueue.push(() => {
    // A click (or another prefetch) may have started this while it was queued.
    if (resolved.has(key) || inFlight.has(key)) {
      pumpPrefetchQueue();
      return;
    }
    activePrefetches++;
    void fetchThread(threadId, accountId)
      .catch(() => {})
      .finally(() => {
        activePrefetches--;
        pumpPrefetchQueue();
      });
  });
  pumpPrefetchQueue();
}

// Warm a thread's detail AND its full message chain (every collapsed body), so
// that opening it and then expanding any message is instant. Heavier than a
// plain detail prefetch (it fans out to the per-message body endpoint), so
// callers gate it behind real intent (a hover dwell / mousedown), not the
// viewport sweep. Dedupes at every layer, so repeat calls are cheap.
export function prefetchThreadChain(threadId: string, accountId: string): void {
  fetchThread(threadId, accountId)
    .then((data) => prefetchThreadBodies(data.messages, accountId, threadId))
    .catch(() => {});
}

// Wrap a shared promise so the caller's await rejects on its own abort signal
// without cancelling the underlying (possibly shared) request.
function withSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new DOMException("Aborted", "AbortError"));
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
