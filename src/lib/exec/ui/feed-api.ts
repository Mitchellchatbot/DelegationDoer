import type {
  AttentionFeedItem,
  AttentionFilters,
  EmailScreenState,
  FeedbackReason,
  OwnerAction
} from "@/lib/exec/attention-types";

// The feed's three calls from the browser (P5a contract §3.6, §3.13.2):
// PATCH /api/exec/attention/:id (an owner action), POST …/:id/feedback, and
// GET /api/exec/attention (Load more). Pure and client-safe: fetch with
// credentials "same-origin" and JSON in and out, nothing server-only, so the
// client FeedList imports it (boundary rule 16). Every answer becomes a typed
// result plus the words he sees (FeedMessage); a response is never shown raw.

/** What a row says after an action or a vote, in its aria-live region. */
export interface FeedMessage {
  tone: "ok" | "error";
  text: string;
  /** An out-of-view stub offers Undo: reopen, with the version the action left. */
  undo?: boolean;
}

export const FEED_COPY = {
  conflict: "This item changed since you loaded it. Check it and try again.",
  gone: "This item is gone.",
  failed: "Couldn't save. Try again.",
  notInstalled: "Feedback isn't available yet.",
  thanks: "Thanks, noted.",
  savedReload: "Saved. Reload to see the latest.",
  hiddenNow: "Saved. The item is hidden now: restricted sender."
} as const;

/** "Too many changes at once. Try again in N s." (N at least 1; 60 when the answer didn't say). */
export function tooManyMessage(seconds: number | null): string {
  const n = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60;
  return `Too many changes at once. Try again in ${n} s.`;
}

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

function codeOf(body: Json | null): string | null {
  return body && typeof body.error === "string" ? body.error : null;
}

/** The wait a 429 asked for: the body's retryAfterSeconds, else the Retry-After header (seconds), else null. */
export function retryAfterOf(body: Json | null, headers: Pick<Headers, "get"> | null): number | null {
  const fromBody = body?.retryAfterSeconds;
  if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody > 0) return fromBody;
  const raw = headers?.get("retry-after");
  if (raw && /^\s*\d+\s*$/.test(raw)) {
    const n = Number(raw);
    if (n > 0) return n;
  }
  return null;
}

/**
 * The words for a refused or failed call (test 67). `kind` picks the 409:
 * an action's 409 is a conflict or an invalid transition (the item changed);
 * a vote's 409 is "not installed". A 404 is "gone" only when the item route
 * said not_found (the gate's own 404 is a session problem, not a deleted item).
 */
export function feedMessageFor(status: number, body: unknown, headers: Pick<Headers, "get"> | null, kind: "action" | "feedback"): FeedMessage {
  const obj = asObject(body);
  const code = codeOf(obj);
  if (status === 409) {
    if (kind === "feedback" || code === "not_installed") return { tone: "error", text: code === "not_installed" ? FEED_COPY.notInstalled : FEED_COPY.failed };
    return { tone: "error", text: FEED_COPY.conflict };
  }
  if (status === 404 && code === "not_found") return { tone: "error", text: FEED_COPY.gone };
  if (status === 429) return { tone: "error", text: tooManyMessage(retryAfterOf(obj, headers)) };
  return { tone: "error", text: FEED_COPY.failed };
}

/** A light shape check of an item the server sent back: enough for the list to key, order and act on it. */
export function isFeedItem(v: unknown): v is AttentionFeedItem {
  const o = asObject(v);
  if (!o) return false;
  const priority = asObject(o.priority);
  return (
    typeof o.id === "string" &&
    typeof o.version === "string" &&
    typeof o.title === "string" &&
    typeof o.status === "string" &&
    typeof o.source === "string" &&
    typeof o.fingerprint === "string" &&
    typeof o.firstSeenAt === "string" &&
    Array.isArray(o.facts) &&
    Array.isArray(o.refs) &&
    priority !== null &&
    typeof priority.band === "string"
  );
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function fetcher(f?: FetchLike): FetchLike {
  return f ?? ((input, init) => fetch(input, init));
}

const JSON_HEADERS = { "content-type": "application/json", accept: "application/json" };

export function attentionItemPath(itemId: string): string {
  return `/api/exec/attention/${encodeURIComponent(itemId)}`;
}

export type ActionResponse =
  /** 200. item null: the restricted-sender screen withholds it now. */
  | { kind: "applied"; changed: boolean; item: AttentionFeedItem | null }
  /** 409 with the current row (null when the screen withholds it). */
  | { kind: "conflict"; item: AttentionFeedItem | null; message: FeedMessage }
  /** 404 not_found from the item route. */
  | { kind: "gone"; message: FeedMessage }
  | { kind: "failed"; status: number; message: FeedMessage };

/** PATCH one owner action with the version he loaded (C3); the route checks everything again. */
export async function patchAttention(
  itemId: string,
  body: { action: OwnerAction; snoozeUntil?: string; expectedUpdatedAt: string },
  fetchImpl?: FetchLike
): Promise<ActionResponse> {
  const payload: Json = { action: body.action, expectedUpdatedAt: body.expectedUpdatedAt };
  if (body.action === "snooze" && typeof body.snoozeUntil === "string") payload.snoozeUntil = body.snoozeUntil;
  let res: Response;
  try {
    res = await fetcher(fetchImpl)(attentionItemPath(itemId), {
      method: "PATCH",
      credentials: "same-origin",
      cache: "no-store",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload)
    });
  } catch {
    return { kind: "failed", status: 0, message: { tone: "error", text: FEED_COPY.failed } };
  }
  const json = asObject(await readJson(res));
  if (res.status === 200) {
    if (json && json.item === null && json.hidden === true) return { kind: "applied", changed: json.changed === true, item: null };
    if (json && isFeedItem(json.item)) return { kind: "applied", changed: json.changed === true, item: json.item };
    return { kind: "failed", status: 200, message: { tone: "error", text: FEED_COPY.savedReload } };
  }
  if (res.status === 409 && (codeOf(json) === "conflict" || codeOf(json) === "invalid_transition")) {
    const item = json && isFeedItem(json.item) ? json.item : null;
    return { kind: "conflict", item, message: feedMessageFor(409, json, res.headers, "action") };
  }
  if (res.status === 404 && codeOf(json) === "not_found") return { kind: "gone", message: feedMessageFor(404, json, res.headers, "action") };
  return { kind: "failed", status: res.status, message: feedMessageFor(res.status, json, res.headers, "action") };
}

export type FeedbackResponse =
  | { kind: "recorded"; vote: 1 | -1; reason: FeedbackReason | null }
  | { kind: "gone"; message: FeedMessage }
  | { kind: "failed"; status: number; message: FeedMessage };

/** POST his vote on one item (C10): useful (+1) or not (−1, with an optional reason). */
export async function postFeedback(itemId: string, vote: 1 | -1, reason: FeedbackReason | null, fetchImpl?: FetchLike): Promise<FeedbackResponse> {
  let res: Response;
  try {
    res = await fetcher(fetchImpl)(`${attentionItemPath(itemId)}/feedback`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: JSON_HEADERS,
      body: JSON.stringify({ vote, reason })
    });
  } catch {
    return { kind: "failed", status: 0, message: { tone: "error", text: FEED_COPY.failed } };
  }
  const json = asObject(await readJson(res));
  if (res.status === 200) return { kind: "recorded", vote, reason };
  if (res.status === 404 && codeOf(json) === "not_found") return { kind: "gone", message: feedMessageFor(404, json, res.headers, "feedback") };
  return { kind: "failed", status: res.status, message: feedMessageFor(res.status, json, res.headers, "feedback") };
}

export type PageResponse =
  | { ok: true; items: AttentionFeedItem[]; nextCursor: string | null; hiddenEmail: number; emailScreen: EmailScreenState }
  | { ok: false; status: number };

const EMAIL_SCREEN: ReadonlySet<string> = new Set<EmailScreenState>(["none", "ok", "unavailable"]);

/** The query string of a feed read: the filters the page was built with, the cursor and the page size. */
export function attentionQuery(filters: AttentionFilters, cursor: string | null, limit = 50): string {
  const q = new URLSearchParams();
  if (filters.status && filters.status !== "default") q.set("status", filters.status);
  if (filters.category) q.set("category", filters.category);
  if (filters.band) q.set("band", filters.band);
  if (filters.source) q.set("source", filters.source);
  if (filters.kind) q.set("kind", filters.kind);
  if (filters.firstSeenAfter) q.set("firstSeenAfter", filters.firstSeenAfter);
  if (filters.updatedAfter) q.set("updatedAfter", filters.updatedAfter);
  if (cursor) q.set("cursor", cursor);
  q.set("limit", String(limit));
  return q.toString();
}

/** GET the next page under the same filters (the cursor is bound to them, C5). */
export async function fetchAttentionPage(filters: AttentionFilters, cursor: string | null, fetchImpl?: FetchLike, limit = 50): Promise<PageResponse> {
  let res: Response;
  try {
    res = await fetcher(fetchImpl)(`/api/exec/attention?${attentionQuery(filters, cursor, limit)}`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" }
    });
  } catch {
    return { ok: false, status: 0 };
  }
  if (res.status !== 200) return { ok: false, status: res.status };
  const json = asObject(await readJson(res));
  if (!json || !Array.isArray(json.items)) return { ok: false, status: 200 };
  const items = json.items.filter(isFeedItem);
  const nextCursor = typeof json.nextCursor === "string" && json.nextCursor.length > 0 ? json.nextCursor : null;
  const hiddenEmail = typeof json.hiddenEmail === "number" && Number.isFinite(json.hiddenEmail) && json.hiddenEmail > 0 ? Math.floor(json.hiddenEmail) : 0;
  const emailScreen = typeof json.emailScreen === "string" && EMAIL_SCREEN.has(json.emailScreen) ? (json.emailScreen as EmailScreenState) : "none";
  return { ok: true, items, nextCursor, hiddenEmail, emailScreen };
}
