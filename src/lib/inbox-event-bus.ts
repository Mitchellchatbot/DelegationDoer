// Tiny in-process pub/sub for "something happened in a Missive account."
// Producers: /api/missive-webhook (called by missiveclone when an inbound
// message lands). Consumers: /api/inbox-events (SSE per-user stream) plus
// the badge-cache invalidator in /api/notifications/badges.
//
// No external dependency — fine for the single-instance Railway deploy.
// If we ever scale to multiple Node processes we'll swap this for Redis
// pub/sub; the surface area is tiny on purpose so the swap is easy.

export interface InboxEvent {
  event: "message:new" | "thread:updated";
  workspace_id?: string;
  account_id: string;
  thread_id: string;
  message_id?: string;
  ts: number;
}

export type InboxEventListener = (e: InboxEvent) => void;

const listeners = new Set<InboxEventListener>();
// Per-account cache busters: lets the badge route register a "drop my
// cached value when anything happens in this account" hook without
// having to know who's subscribed to live events.
const cacheBusters = new Set<(accountId: string) => void>();

export function publish(event: InboxEvent): void {
  // Notify listeners first so the live UI updates immediately, then run
  // cache busters so the next REST poll re-fetches fresh data instead
  // of serving a stale cached badge count.
  for (const fn of listeners) {
    try { fn(event); } catch (err) { console.error("[inbox-bus] listener", err); }
  }
  for (const fn of cacheBusters) {
    try { fn(event.account_id); } catch (err) { console.error("[inbox-bus] buster", err); }
  }
}

export function subscribe(fn: InboxEventListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function onCacheBust(fn: (accountId: string) => void): () => void {
  cacheBusters.add(fn);
  return () => { cacheBusters.delete(fn); };
}
