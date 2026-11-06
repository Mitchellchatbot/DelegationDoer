import "server-only";

import { createHash } from "node:crypto";
import {
  ATTENTION_ITEM_ID,
  effectiveAttentionItem,
  getAttentionItemRow,
  isAttentionCursorKey,
  listAttentionPage,
  parseEmailFingerprint,
  type AttentionCursorKey,
  type AttentionPageRow,
  type ParsedEmailFingerprint
} from "@/lib/exec/attention";
import type {
  AttentionCategory,
  AttentionFeedItem,
  AttentionFilters,
  AttentionSource,
  AttentionStatusFilter,
  EmailScreenState,
  PriorityBand,
  ScreenedAttentionPage,
  ScreenedItemResult
} from "@/lib/exec/attention-types";
import { listThreadScreenRows } from "@/lib/exec/email-store";
import type { ThreadScreenRow } from "@/lib/exec/email-types";
import { loadEmailGate, pinnedRowMap, type ScreeningPolicy } from "@/lib/exec/email-view";
import { loadScreeningPolicy, screenStoredRow } from "@/lib/exec/sources/mail";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";

// The screened Needs Attention accessor (P5a contract §3.4, S3): the only
// general feed read. Every feed surface (the Overview card, the full feed
// page, GET /api/exec/attention, P5b's list_attention, P6's App Home) goes
// through it, so an email item about a restricted, gone or unscreenable thread
// is never shown. Only this file (and attention.ts) may name listAttention
// (boundary rule 11); it doesn't need to: it pages with listAttentionPage.
//
// Paging (C5, a-build-3): keyset over (priority_score desc, first_seen_at
// desc, id asc). Each store read asks for exactly what the page still needs
// plus one probe row; the probe row is never examined, so the cursor is
// always the last EXAMINED row and the next page starts right after it. Rows
// the screen withholds are refilled, at most MAX_READS reads per call, so a
// page never holds more than `limit` items. Exact for rows whose sort key
// doesn't move; a row whose score changes between two calls can cross the
// cursor (C5 documents it; the client dedupes by id).
//
// The screen (C7, K24, P3C A2, and P3's Overview screen it replaces, K8):
//   - DD and Slack items pass as they are;
//   - email items show only while email is on (installed, enabled, a pinned
//     mailbox), as P3's Overview did; while it is off they are left out
//     (not counted in hiddenEmail: no screen withheld them);
//   - an email item whose fingerprint doesn't parse is withheld;
//   - satisfaction and health items pass (screened when they were made);
//   - a thread or commitment item needs its thread's stored row, in a mailbox
//     pinned to him now (P3 ui-3), not gone, and passing the restricted-sender
//     screen under the current rules (a tombstone never does);
//   - when the settings, the rules or the thread rows can't be read, every
//     email item they decide is withheld and the page says
//     emailScreen: "unavailable" (fail closed, never shown unchecked); an
//     unreadable settings read withholds every email item, since it can't
//     tell whether email is on.
// Ids and counts only in logs.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
/** a-build-3: store reads per call, refills included. */
export const MAX_SCREENED_READS = 5;
const MAX_CURSOR_LENGTH = 512;
const CURSOR_SHAPE = /^[A-Za-z0-9_-]{1,400}\.[0-9a-f]{24}$/;
const CURSOR_VERSION = 1;

const STATUS_FILTERS: ReadonlySet<string> = new Set<AttentionStatusFilter>(["default", "open", "seen", "snoozed", "dismissed", "resolved"]);
const CATEGORIES: ReadonlySet<string> = new Set<AttentionCategory>(["my_action", "approval", "delegated", "intervene", "fyi", "on_track"]);
const BANDS: ReadonlySet<string> = new Set<PriorityBand>(["critical", "high", "normal"]);
const SOURCES: ReadonlySet<string> = new Set<AttentionSource>(["dd", "email", "slack"]);
const KIND = /^[a-z][a-z0-9_]{0,63}$/;
// What an ISO since-filter may look like (toISOString's form and PostgREST's).
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/;

// ---------------------------------------------------------------------------
// Filters and the cursor (pure)
// ---------------------------------------------------------------------------

type Checked<T> = { ok: true; value: T } | { ok: false; detail: string };

function isoParam(v: string, detail: string): Checked<string> {
  if (!ISO_TIMESTAMP.test(v)) return { ok: false, detail };
  const t = Date.parse(v);
  return Number.isFinite(t) ? { ok: true, value: new Date(t).toISOString() } : { ok: false, detail };
}

/** The filters with every value checked and since-filters in toISOString form; the first bad field's name otherwise. */
function checkFilters(f: AttentionFilters): Checked<AttentionFilters> {
  if (typeof f !== "object" || f === null) return { ok: false, detail: "filters" };
  const out: AttentionFilters = {};
  if (f.status !== undefined) {
    if (typeof f.status !== "string" || !STATUS_FILTERS.has(f.status)) return { ok: false, detail: "status" };
    out.status = f.status;
  }
  if (f.category !== undefined) {
    if (typeof f.category !== "string" || !CATEGORIES.has(f.category)) return { ok: false, detail: "category" };
    out.category = f.category;
  }
  if (f.band !== undefined) {
    if (typeof f.band !== "string" || !BANDS.has(f.band)) return { ok: false, detail: "band" };
    out.band = f.band;
  }
  if (f.source !== undefined) {
    if (typeof f.source !== "string" || !SOURCES.has(f.source)) return { ok: false, detail: "source" };
    out.source = f.source;
  }
  if (f.kind !== undefined) {
    if (typeof f.kind !== "string" || !KIND.test(f.kind)) return { ok: false, detail: "kind" };
    out.kind = f.kind;
  }
  for (const key of ["firstSeenAfter", "updatedAfter"] as const) {
    const v = f[key];
    if (v === undefined) continue;
    if (typeof v !== "string") return { ok: false, detail: key };
    const iso = isoParam(v, key);
    if (!iso.ok) return iso;
    out[key] = iso.value;
  }
  if (f.cursor !== undefined && f.cursor !== null) {
    if (typeof f.cursor !== "string" || f.cursor.length === 0 || f.cursor.length > MAX_CURSOR_LENGTH) return { ok: false, detail: "cursor" };
    out.cursor = f.cursor;
  }
  if (f.limit !== undefined) {
    if (typeof f.limit !== "number" || !Number.isFinite(f.limit)) return { ok: false, detail: "limit" };
    out.limit = f.limit;
  }
  return { ok: true, value: out };
}

/**
 * Filter validation for routes and tools: query-string values in, typed
 * filters out, or the name of the first bad parameter. Empty values count as
 * absent; keys that aren't filters are ignored. limit must be an integer
 * 1..100. The cursor is only shape-checked here: whether it belongs to these
 * filters is decodeAttentionCursor's call. Pure.
 */
export function parseAttentionFilters(input: Record<string, string | undefined>): { ok: true; filters: AttentionFilters } | { ok: false; detail: string } {
  if (typeof input !== "object" || input === null) return { ok: false, detail: "filters" };
  const get = (key: string): string | undefined => {
    if (!Object.prototype.hasOwnProperty.call(input, key)) return undefined;
    const v = input[key];
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const raw: AttentionFilters = {};
  const status = get("status");
  if (status !== undefined) raw.status = status as AttentionStatusFilter;
  const category = get("category");
  if (category !== undefined) raw.category = category as AttentionCategory;
  const band = get("band");
  if (band !== undefined) raw.band = band as PriorityBand;
  const source = get("source");
  if (source !== undefined) raw.source = source as AttentionSource;
  const kind = get("kind");
  if (kind !== undefined) raw.kind = kind;
  const firstSeenAfter = get("firstSeenAfter");
  if (firstSeenAfter !== undefined) raw.firstSeenAfter = firstSeenAfter;
  const updatedAfter = get("updatedAfter");
  if (updatedAfter !== undefined) raw.updatedAfter = updatedAfter;
  const cursor = get("cursor");
  if (cursor !== undefined) raw.cursor = cursor;
  const limit = get("limit");
  if (limit !== undefined) {
    if (!/^\d{1,3}$/.test(limit)) return { ok: false, detail: "limit" };
    const n = Number(limit);
    if (n < 1 || n > MAX_LIMIT) return { ok: false, detail: "limit" };
    raw.limit = n;
  }
  const checked = checkFilters(raw);
  return checked.ok ? { ok: true, filters: checked.value } : checked;
}

/** The filter set a cursor is bound to: everything but the cursor and the page size, in a fixed order. */
function filterKey(f: AttentionFilters): string {
  const iso = (v: string | undefined) => {
    if (v === undefined) return "";
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : v;
  };
  return JSON.stringify([
    f.status ?? "default",
    f.category ?? "",
    f.band ?? "",
    f.source ?? "",
    f.kind ?? "",
    iso(f.firstSeenAfter),
    iso(f.updatedAfter)
  ]);
}

function cursorMac(payload: string, filters: AttentionFilters): string {
  return createHash("sha256").update(`exec-attention-cursor:v${CURSOR_VERSION}\n${filterKey(filters)}\n${payload}`).digest("hex").slice(0, 24);
}

/**
 * A keyset position bound to its filter set (C5): base64url of the key, and a
 * hash over the filters and the key, so a cursor reused with other filters,
 * or edited, doesn't decode. It holds his own item id, a score and a time:
 * nothing about the item's content. Throws NonRetryableError on a bad key.
 */
export function encodeAttentionCursor(key: AttentionCursorKey, filters: AttentionFilters): string {
  if (!isAttentionCursorKey(key)) throw new NonRetryableError("exec attention: a cursor key is malformed");
  const payload = Buffer.from(JSON.stringify([CURSOR_VERSION, key.score, key.firstSeenRaw, key.id]), "utf8").toString("base64url");
  return `${payload}.${cursorMac(payload, filters)}`;
}

/** The key a cursor holds, or null when it is malformed, edited, or was made for other filters. Pure. */
export function decodeAttentionCursor(cursor: string, filters: AttentionFilters): AttentionCursorKey | null {
  if (typeof cursor !== "string" || cursor.length > MAX_CURSOR_LENGTH || !CURSOR_SHAPE.test(cursor)) return null;
  const [payload, mac] = cursor.split(".");
  if (cursorMac(payload, filters) !== mac) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== CURSOR_VERSION) return null;
  const key = { score: parsed[1], firstSeenRaw: parsed[2], id: parsed[3] };
  return isAttentionCursorKey(key) ? key : null;
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

type GateState = "on" | "off" | "unavailable";

interface Screened {
  items: AttentionFeedItem[];
  hiddenEmail: number;
  emailScreen: EmailScreenState;
}

function rethrowAbort(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

/**
 * One call's screen. The email gate and the rules are read at most once per
 * screener (they hold across the call's refill reads); the thread rows are
 * read per batch, for that batch's threads. An abort is rethrown, never
 * mistaken for an unreadable screen.
 */
function createScreener(principal: ExecPrincipal, signal: AbortSignal | undefined): (items: readonly AttentionFeedItem[]) => Promise<Screened> {
  let gate: Promise<GateState> | null = null;
  let policy: Promise<ScreeningPolicy | null> | null = null;

  const readGate = (): Promise<GateState> =>
    (gate ??= loadEmailGate(principal).then(
      (g): GateState => (g.kind === "on" ? "on" : "off"),
      (err: unknown): GateState => {
        rethrowAbort(signal);
        console.error(`[exec-attention-read] email settings unreadable for ${principal.id}; email items withheld (${err instanceof Error ? err.name : "error"})`);
        return "unavailable";
      }
    ));
  const readPolicy = (): Promise<ScreeningPolicy | null> =>
    (policy ??= loadScreeningPolicy(principal, { signal }).then(
      (p): ScreeningPolicy | null => p,
      (err: unknown) => {
        rethrowAbort(signal);
        console.error(`[exec-attention-read] restricted-sender rules unreadable for ${principal.id}; email thread items withheld (${err instanceof Error ? err.name : "error"})`);
        return null;
      }
    ));
  const readRows = async (threadIds: string[]): Promise<Map<string, ThreadScreenRow> | null> => {
    try {
      // A thread of a mailbox no longer pinned to him links to a 404: left out like one with no row (P3 ui-3).
      return pinnedRowMap(principal, await listThreadScreenRows(principal, threadIds, { signal }));
    } catch (err) {
      rethrowAbort(signal);
      console.error(`[exec-attention-read] ${threadIds.length} thread row(s) unreadable for ${principal.id}; their items withheld (${err instanceof Error ? err.name : "error"})`);
      return null;
    }
  };

  return async (items) => {
    const email = items.filter((i) => i.source === "email");
    if (email.length === 0) return { items: [...items], hiddenEmail: 0, emailScreen: "none" };

    const state = await readGate();
    // Email off (or no mailbox pinned): its items aren't shown at all, as on P3's Overview. That isn't the
    // restricted-sender screen withholding them, so they aren't counted in hiddenEmail. An unreadable
    // gate can't say email is off: every email item is withheld and counted, and the screen is unavailable.
    if (state === "off") return { items: items.filter((i) => i.source !== "email"), hiddenEmail: 0, emailScreen: "ok" };
    if (state === "unavailable") return { items: items.filter((i) => i.source !== "email"), hiddenEmail: email.length, emailScreen: "unavailable" };

    const parsed = new Map<string, ParsedEmailFingerprint | null>(email.map((i) => [i.id, parseEmailFingerprint(i.fingerprint)]));
    const threadIds = [...new Set([...parsed.values()].flatMap((p) => (p !== null && p.threadId !== null ? [p.threadId] : [])))];
    let rules: ScreeningPolicy | null = null;
    let rows: Map<string, ThreadScreenRow> | null = new Map();
    if (threadIds.length > 0) {
      rules = await readPolicy();
      rows = rules === null ? null : await readRows(threadIds);
    }
    const unavailable = threadIds.length > 0 && (rules === null || rows === null);

    const kept: AttentionFeedItem[] = [];
    let hidden = 0;
    for (const item of items) {
      if (item.source !== "email") {
        kept.push(item);
        continue;
      }
      const p = parsed.get(item.id) ?? null;
      // Not one of the four email shapes: can't tell which thread it is about.
      if (p === null) {
        hidden += 1;
        continue;
      }
      // Satisfaction and health are about a client, screened when they were made.
      if (p.threadId === null) {
        kept.push(item);
        continue;
      }
      if (unavailable || rules === null || rows === null) {
        hidden += 1;
        continue;
      }
      const row = rows.get(p.threadId);
      if (!row || row.state === "gone" || screenStoredRow(row, rules.rules, rules.hash).verdict === "restricted") {
        hidden += 1;
        continue;
      }
      kept.push(item);
    }
    return { items: kept, hiddenEmail: hidden, emailScreen: unavailable ? "unavailable" : "ok" };
  };
}

/** "unavailable" outranks "ok", which outranks "none". */
function mergeScreenState(a: EmailScreenState, b: EmailScreenState): EmailScreenState {
  if (a === "unavailable" || b === "unavailable") return "unavailable";
  if (a === "ok" || b === "ok") return "ok";
  return "none";
}

/** A stored row as the feed shows it: effective() at `now` (a run-out snooze is open), with its CAS version (C3). Not screened. */
export function attentionFeedItem(row: AttentionPageRow, now: Date): AttentionFeedItem {
  return { ...effectiveAttentionItem(row.item, now), version: row.version };
}
const feedItem = attentionFeedItem;

/** Screen arbitrary items (the PATCH/feedback responses use it). Never throws for the screen; rethrows an abort. */
export async function screenAttentionItems(
  principal: ExecPrincipal,
  items: readonly AttentionFeedItem[],
  opts: { signal?: AbortSignal } = {}
): Promise<{ items: AttentionFeedItem[]; hiddenEmail: number; emailScreen: EmailScreenState }> {
  return createScreener(principal, opts.signal)(items);
}

// ---------------------------------------------------------------------------
// The accessor
// ---------------------------------------------------------------------------

/**
 * S3: the only general feed read. One page of his items under `filters`
 * (status "default" = open + seen, open including run-out snoozes, C6),
 * screened, effective() (a run-out snooze shows as open) and each with its CAS
 * version. Never throws for the screen (C7). Throws NonRetryableError on bad
 * filters or a cursor that doesn't belong to them ("invalid_cursor"), and an
 * Error on a store read error.
 */
export async function listScreenedAttention(
  principal: ExecPrincipal,
  filters: AttentionFilters,
  opts: { now?: Date; signal?: AbortSignal } = {}
): Promise<ScreenedAttentionPage> {
  const checked = checkFilters(filters);
  if (!checked.ok) throw new NonRetryableError(`exec attention: invalid ${checked.detail}`);
  const f = checked.value;
  const now = opts.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new NonRetryableError("exec attention: now must be a valid Date");
  const limit = f.limit === undefined ? DEFAULT_LIMIT : Math.min(MAX_LIMIT, Math.max(1, Math.floor(f.limit)));
  let after: AttentionCursorKey | null = null;
  if (f.cursor !== undefined && f.cursor !== null) {
    after = decodeAttentionCursor(f.cursor, f);
    if (after === null) throw new NonRetryableError("exec attention: invalid_cursor");
  }

  const screen = createScreener(principal, opts.signal);
  const collected: AttentionFeedItem[] = [];
  let hiddenEmail = 0;
  let emailScreen: EmailScreenState = "none";
  let more = false;
  for (let read = 0; read < MAX_SCREENED_READS; read += 1) {
    const need = limit - collected.length;
    const rows = await listAttentionPage(
      principal,
      {
        statuses: f.status ?? "default",
        category: f.category,
        band: f.band,
        source: f.source,
        kind: f.kind,
        firstSeenAfter: f.firstSeenAfter,
        updatedAfter: f.updatedAfter,
        after,
        limit: need + 1,
        now
      },
      { signal: opts.signal }
    );
    // The row past `need` only says whether there is more; it is never examined.
    const examined = rows.slice(0, need);
    more = rows.length > need;
    if (examined.length > 0) {
      const s = await screen(examined.map((r) => feedItem(r, now)));
      collected.push(...s.items);
      hiddenEmail += s.hiddenEmail;
      emailScreen = mergeScreenState(emailScreen, s.emailScreen);
      const last = examined[examined.length - 1];
      after = { score: last.item.priority.score, firstSeenRaw: last.firstSeenRaw, id: last.item.id };
    }
    if (collected.length >= limit || !more) break;
  }
  return {
    items: collected,
    nextCursor: more && after !== null ? encodeAttentionCursor(after, f) : null,
    hiddenEmail,
    emailScreen
  };
}

/**
 * One item by id, any status, screened (coherence-9): a DD, Slack,
 * satisfaction or health item as it is; an email thread or commitment item
 * through the same screen as the feed. { ok: false, reason } instead of a bare
 * null: "missing" (no such item, or a malformed id), "withheld" (restricted,
 * gone, no row, an unpinned mailbox, an unparseable fingerprint, or email
 * off), "screen_unavailable" (the settings, rules or thread rows couldn't be
 * read). Throws on a store read error.
 */
export async function getScreenedAttentionItem(
  principal: ExecPrincipal,
  itemId: string,
  opts: { now?: Date; signal?: AbortSignal } = {}
): Promise<ScreenedItemResult> {
  if (typeof itemId !== "string" || !ATTENTION_ITEM_ID.test(itemId)) return { ok: false, reason: "missing" };
  const row = await getAttentionItemRow(principal, itemId, { signal: opts.signal });
  if (row === null) return { ok: false, reason: "missing" };
  const item = feedItem(row, opts.now ?? new Date());
  const s = await createScreener(principal, opts.signal)([item]);
  if (s.items.length === 1) return { ok: true, item: s.items[0] };
  return { ok: false, reason: s.emailScreen === "unavailable" ? "screen_unavailable" : "withheld" };
}
