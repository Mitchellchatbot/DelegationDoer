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
  // Sent by a CL1 clone on message:new (socket and webhook), so a subscriber
  // can tell inbound from outbound and Junk from Inbox without fetching the
  // message. Absent from older clones; only set when valid (inboxEventExtras).
  direction?: "inbound" | "outbound";
  folder?: string;
}

const MAX_FOLDER_CHARS = 200;

/**
 * The validated direction/folder of a clone event payload, ready to spread
 * into an InboxEvent: a field that is missing or malformed is left out rather
 * than passed through, since subscribers act on it (Junk is skipped, outbound
 * is routed differently).
 */
export function inboxEventExtras(
  payload: { direction?: unknown; folder?: unknown } | null | undefined
): Pick<InboxEvent, "direction" | "folder"> {
  const out: Pick<InboxEvent, "direction" | "folder"> = {};
  const direction = payload?.direction;
  if (direction === "inbound" || direction === "outbound") out.direction = direction;
  const folder = payload?.folder;
  if (typeof folder === "string") {
    const trimmed = folder.trim();
    // No control characters: a folder label is shown and matched, never parsed.
    if (trimmed.length > 0 && trimmed.length <= MAX_FOLDER_CHARS && !/[\x00-\x1f\x7f]/.test(trimmed)) {
      out.folder = trimmed;
    }
  }
  return out;
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
