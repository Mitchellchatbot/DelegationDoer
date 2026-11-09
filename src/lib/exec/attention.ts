import "server-only";

import type {
  AttentionCandidate,
  AttentionCategory,
  AttentionFact,
  AttentionItem,
  AttentionSource,
  AttentionStatus,
  AttentionStatusFilter,
  FactBasis,
  OwnerAction,
  PriorityBand,
  PriorityResult
} from "@/lib/exec/attention-types";
import { clipExcerpt, isAllowedLinkUrl } from "@/lib/exec/refs";
import { NonRetryableError, type ExecPrincipal, type SourceClass, type SourceRef, type SourceSystem } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// Needs Attention: the store behind the feed (public.exec_attention_items).
//
// Producers (the DD rules in P2b, email triage in P3, Slack in P7) recompute
// their candidates on a schedule and hand them to syncAttention together with
// their scope: one source and the kinds that producer owns. reconcile()
// compares the candidates with the stored rows of that scope and plans the
// writes:
//   - a situation seen for the first time is inserted as open;
//   - a known one gets its content refreshed, and its status follows the
//     transition table: a seen item reopens when its state changes, a snoozed
//     one when the snooze has run out or its band went up, a dismissed one
//     only when its band went up (above the band he put it away at, which a
//     put-away row keeps: see asWritten), an auto-resolved one whenever it
//     comes back, and one the owner resolved only when its state changed;
//   - a live row of the scope that no candidate matches any more is resolved
//     (resolution "auto").
// Rows of another source or kind are never touched, so producers can't
// resolve each other's items.
//
// Everything stored is normalized first: text is clipped to ATTENTION_LIMITS
// with control and bidi characters stripped (clipExcerpt), enums are checked,
// and every link is re-checked against refs.ts's allowlist, so a producer bug
// can't put an arbitrary URL in front of the executive.
//
// Reads fail closed: a database error throws. An empty feed must mean
// "nothing needs attention", never "couldn't read". Bad input (an unknown
// enum, a candidate outside the scope) throws NonRetryableError, because a
// retry would hit the same bug and the job should dead-letter to ops at once.

export const ATTENTION_LIMITS = { title: 200, text: 600, facts: 12, factText: 300, refs: 20 } as const;

/** What one sync owns: its source, and the kinds its producer emits. Rows outside it are never touched. */
export interface AttentionScope {
  source: AttentionSource;
  kinds: readonly string[];
}

/** A planned write to an existing row. */
export interface AttentionUpdate {
  id: string;
  /** Columns to set, as stored (snake_case). */
  patch: Record<string, unknown>;
  /**
   * updated    content or priority changed; the status stays
   * reopened   the row goes back to open (from seen, snoozed, dismissed or resolved)
   * unchanged  same content, priority and status: only last_seen_at moves
   */
  change: "updated" | "reopened" | "unchanged";
}

export interface AttentionPlan {
  inserts: AttentionCandidate[];
  updates: AttentionUpdate[];
  resolves: string[];
  unchanged: number;
}

export interface AttentionSyncResult {
  inserted: number;
  updated: number;
  reopened: number;
  resolved: number;
  unchanged: number;
}

const TABLE = "exec_attention_items";
const ITEM_COLUMNS =
  "id,principal_id,fingerprint,source,kind,category,priority_score,priority_band,priority_reasons,title," +
  "what_happened,why_it_matters,recommended_next,facts,refs,state_hash,occurred_at,status,snooze_until," +
  "resolution,first_seen_at,last_seen_at,resolved_at,updated_at";

// Writes go out in chunks of at most this many rows or ids, each awaited.
const WRITE_CHUNK = 200;
// Rows whose content changed are written one request each (every row has its
// own patch), this many at a time.
const UPDATE_CONCURRENCY = 10;
// An `in.(…)` list travels in the URL. An id is 35 characters, a fingerprint
// up to 300, so lists are also cut by their encoded length, keeping each
// request line well under the 8 KB a proxy may refuse above.
const URL_LIST_BUDGET = 6_000;
// PostgREST returns at most 1000 rows per request.
const PAGE_SIZE = 1_000;
const MAX_PAGES = 50;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
// The feed: everything he hasn't put away. A snoozed item whose snooze has run
// out counts as open (see effective()).
const FEED_STATUSES: readonly AttentionStatus[] = ["open", "seen"];

// Identity strings. Fingerprints and kinds go into PostgREST filters, so they
// hold no whitespace and none of the characters PostgREST quotes on (or that
// would break its quoting). The DB checks the fingerprint's source prefix and
// its 300-character cap too.
const MAX_FINGERPRINT = 300;
const FINGERPRINT_CHARS = /^[^\s",()\\]+$/;
const KIND_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_STATE_HASH = 128;
const MAX_REF_ID = 512;
const MAX_LABEL = 200;
const MAX_EXCERPT = 280;
// scorePriority writes at most eight reasons; anything past this is noise.
const MAX_REASONS = 12;
const MAX_REASON = 200;

const SOURCES: ReadonlySet<string> = new Set<AttentionSource>(["dd", "email", "slack"]);
const CATEGORIES: ReadonlySet<string> = new Set<AttentionCategory>([
  "my_action",
  "approval",
  "delegated",
  "intervene",
  "fyi",
  "on_track"
]);
const BANDS: ReadonlySet<string> = new Set<PriorityBand>(["critical", "high", "normal"]);
// Also the order status lists are written in.
const STATUS_ORDER: readonly AttentionStatus[] = ["open", "seen", "snoozed", "dismissed", "resolved"];
const STATUSES: ReadonlySet<string> = new Set<string>(STATUS_ORDER);
const RESOLUTIONS: ReadonlySet<string> = new Set(["auto", "owner"]);
const BASES: ReadonlySet<string> = new Set<FactBasis>(["record", "derived", "ai"]);
const SYSTEMS: ReadonlySet<string> = new Set<SourceSystem>(["dd", "outlook", "slack", "meeting", "web"]);
const CLASSES: ReadonlySet<string> = new Set<SourceClass>(["public", "private", "internal", "finance", "restricted"]);
const BAND_RANK: Readonly<Record<PriorityBand, number>> = { normal: 0, high: 1, critical: 2 };

// ---------------------------------------------------------------------------
// Validation and normalization (pure)
// ---------------------------------------------------------------------------

function invalid(message: string): never {
  throw new NonRetryableError(`exec attention: ${message}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A short, content-free description of a bad value for an error message. */
function shown(v: unknown): string {
  return typeof v === "string" ? JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v) : typeof v;
}

function oneOf<T extends string>(allowed: ReadonlySet<string>, value: unknown, what: string): T {
  if (typeof value !== "string" || !allowed.has(value)) invalid(`unknown ${what} ${shown(value)}`);
  return value as T;
}

/** One line of plain text, at most `max` characters (see clipExcerpt). */
function text(value: unknown, max: number, what: string): string {
  if (typeof value !== "string") invalid(`${what} must be a string`);
  return clipExcerpt(value, max);
}

/**
 * True for an identifier that is already clean: what clipExcerpt would leave
 * unchanged (no control or bidi characters, no lone surrogates, no stray
 * whitespace) and at most `max` long. Identifiers are matched exactly, so
 * they are checked, never rewritten.
 */
function isCleanId(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && clipExcerpt(value, max) === value;
}

function normalizeRef(ref: unknown, where: string): SourceRef {
  if (!isRecord(ref)) invalid(`${where}: a ref must be an object`);
  const system = oneOf<SourceSystem>(SYSTEMS, ref.system, `${where} ref system`);
  const klass = oneOf<SourceClass>(CLASSES, ref.class, `${where} ref class`);
  if (!isCleanId(ref.id, MAX_REF_ID)) invalid(`${where}: a ref id must be a clean string of 1-${MAX_REF_ID} characters`);
  const out: SourceRef = {
    system,
    id: ref.id,
    // refs.ts builders only ever produce allowlisted links. Anything else is a
    // bug, and the safe outcome is no link at all.
    url: typeof ref.url === "string" && isAllowedLinkUrl(ref.url) ? ref.url : null,
    label: clipExcerpt(typeof ref.label === "string" ? ref.label : "", MAX_LABEL) || clipExcerpt(ref.id, MAX_LABEL),
    class: klass
  };
  const excerpt = typeof ref.excerpt === "string" ? clipExcerpt(ref.excerpt, MAX_EXCERPT) : "";
  if (excerpt) out.excerpt = excerpt;
  return out;
}

function normalizeRefs(refs: unknown, where: string): SourceRef[] {
  if (!Array.isArray(refs)) invalid(`${where}: refs must be an array`);
  return refs.slice(0, ATTENTION_LIMITS.refs).map((r) => normalizeRef(r, where));
}

function normalizeFacts(facts: unknown, where: string): AttentionFact[] {
  if (!Array.isArray(facts)) invalid(`${where}: facts must be an array`);
  const out: AttentionFact[] = [];
  for (const [i, fact] of facts.entries()) {
    if (!isRecord(fact)) invalid(`${where}: fact ${i} must be an object`);
    const basis = oneOf<FactBasis>(BASES, fact.basis, `${where} fact ${i} basis`);
    const body = text(fact.text, ATTENTION_LIMITS.factText, `${where} fact ${i} text`);
    // A fact with no text says nothing; it isn't stored.
    if (!body) continue;
    out.push({ text: body, basis, refs: normalizeRefs(fact.refs, `${where} fact ${i}`) });
    if (out.length === ATTENTION_LIMITS.facts) break;
  }
  return out;
}

function normalizePriority(p: unknown, where: string): PriorityResult {
  if (!isRecord(p)) invalid(`${where}: priority must be an object`);
  if (typeof p.score !== "number" || !Number.isFinite(p.score)) invalid(`${where}: priority score must be a finite number`);
  if (!Array.isArray(p.reasons)) invalid(`${where}: priority reasons must be an array`);
  return {
    score: Math.min(100, Math.max(0, Math.round(p.score))),
    band: oneOf<PriorityBand>(BANDS, p.band, `${where} priority band`),
    reasons: p.reasons
      .map((r, i) => text(r, MAX_REASON, `${where} priority reason ${i}`))
      .filter((r) => r.length > 0)
      .slice(0, MAX_REASONS)
  };
}

/** An ISO instant, or null when the value is missing or isn't a date ("when it happened" is then unknown). */
function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * The candidate as it will be stored: text clipped to ATTENTION_LIMITS (one
 * line each, control and bidi characters stripped), facts and refs capped,
 * links re-checked against the allowlist, the score clamped to 0..100, and
 * occurredAt in ISO form. Throws NonRetryableError on an unknown enum, an
 * empty title, a malformed fingerprint, kind or state hash, or a fingerprint
 * that doesn't start with "<source>:". Pure; the input isn't modified.
 */
export function normalizeCandidate(c: AttentionCandidate): AttentionCandidate {
  if (!isRecord(c)) invalid("a candidate must be an object");
  const raw = c as unknown as Record<string, unknown>;
  const fingerprint = raw.fingerprint;
  if (!isCleanId(fingerprint, MAX_FINGERPRINT) || !FINGERPRINT_CHARS.test(fingerprint)) {
    invalid(`fingerprint ${shown(fingerprint)} must be 1-${MAX_FINGERPRINT} characters with no whitespace, quotes, commas or parentheses`);
  }
  const source = oneOf<AttentionSource>(SOURCES, raw.source, `${fingerprint}: source`);
  if (!fingerprint.startsWith(`${source}:`) || fingerprint.length === source.length + 1) {
    invalid(`${fingerprint}: a ${source} fingerprint must start with "${source}:" and name the situation`);
  }
  if (typeof raw.kind !== "string" || !KIND_PATTERN.test(raw.kind)) invalid(`${fingerprint}: kind ${shown(raw.kind)} is not a kind`);
  const title = text(raw.title, ATTENTION_LIMITS.title, `${fingerprint}: title`);
  if (!title) invalid(`${fingerprint}: title is empty`);
  if (!isCleanId(raw.stateHash, MAX_STATE_HASH)) invalid(`${fingerprint}: stateHash must be a clean string of 1-${MAX_STATE_HASH} characters`);
  const recommended =
    raw.recommendedNext === null || raw.recommendedNext === undefined
      ? ""
      : text(raw.recommendedNext, ATTENTION_LIMITS.text, `${fingerprint}: recommendedNext`);
  return {
    fingerprint,
    source,
    kind: raw.kind,
    category: oneOf<AttentionCategory>(CATEGORIES, raw.category, `${fingerprint}: category`),
    title,
    whatHappened: text(raw.whatHappened, ATTENTION_LIMITS.text, `${fingerprint}: whatHappened`),
    whyItMatters: text(raw.whyItMatters, ATTENTION_LIMITS.text, `${fingerprint}: whyItMatters`),
    recommendedNext: recommended || null,
    facts: normalizeFacts(raw.facts, fingerprint),
    refs: normalizeRefs(raw.refs, fingerprint),
    priority: normalizePriority(raw.priority, fingerprint),
    stateHash: raw.stateHash,
    occurredAt: isoOrNull(raw.occurredAt)
  };
}

function checkScope(scope: AttentionScope): void {
  if (!isRecord(scope)) invalid("a scope must be an object");
  oneOf<AttentionSource>(SOURCES, scope.source, "scope source");
  if (!Array.isArray(scope.kinds) || scope.kinds.length === 0) invalid("a scope needs at least one kind");
  for (const kind of scope.kinds) {
    if (typeof kind !== "string" || !KIND_PATTERN.test(kind)) invalid(`scope kind ${shown(kind)} is not a kind`);
  }
}

/**
 * Normalize a batch and refuse it, before anything is read or written, when a
 * candidate is outside the scope or two share a fingerprint. Either is a
 * producer bug, and acting on the rest could resolve rows it still means.
 */
function prepareCandidates(candidates: readonly AttentionCandidate[], scope: AttentionScope): AttentionCandidate[] {
  checkScope(scope);
  if (!Array.isArray(candidates)) invalid("candidates must be an array");
  const kinds = new Set(scope.kinds);
  const seen = new Set<string>();
  return candidates.map((candidate) => {
    const c = normalizeCandidate(candidate);
    if (c.source !== scope.source) invalid(`${c.fingerprint}: source ${c.source} is outside this sync's scope (${scope.source})`);
    if (!kinds.has(c.kind)) invalid(`${c.fingerprint}: kind ${c.kind} is outside this sync's scope`);
    if (seen.has(c.fingerprint)) invalid(`duplicate fingerprint ${c.fingerprint} in one batch`);
    seen.add(c.fingerprint);
    return c;
  });
}

// ---------------------------------------------------------------------------
// Reconcile (pure)
// ---------------------------------------------------------------------------

/** JSON with object keys sorted, so jsonb read back (which reorders keys) compares equal to what was written. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isRecord(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v
  );
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Date.parse(a) === Date.parse(b);
}

/** Same content and priority: the columns contentColumns writes. */
function sameContent(row: AttentionItem, c: AttentionCandidate): boolean {
  return (
    row.kind === c.kind &&
    row.category === c.category &&
    row.title === c.title &&
    row.whatHappened === c.whatHappened &&
    row.whyItMatters === c.whyItMatters &&
    row.recommendedNext === c.recommendedNext &&
    row.stateHash === c.stateHash &&
    sameInstant(row.occurredAt, c.occurredAt) &&
    row.priority.score === c.priority.score &&
    row.priority.band === c.priority.band &&
    canonical(row.priority.reasons) === canonical(c.priority.reasons) &&
    canonical(row.facts) === canonical(c.facts) &&
    canonical(row.refs) === canonical(c.refs)
  );
}

function contentColumns(c: AttentionCandidate): Record<string, unknown> {
  return {
    kind: c.kind,
    category: c.category,
    priority_score: c.priority.score,
    priority_band: c.priority.band,
    priority_reasons: c.priority.reasons,
    title: c.title,
    what_happened: c.whatHappened,
    why_it_matters: c.whyItMatters,
    recommended_next: c.recommendedNext,
    facts: c.facts,
    refs: c.refs,
    state_hash: c.stateHash,
    occurred_at: c.occurredAt
  };
}

/**
 * Whether a row whose situation is still present goes back to open (the
 * transition table above). Reopening clears the snooze and any resolution;
 * first_seen_at is kept.
 */
function reopens(row: AttentionItem, c: AttentionCandidate, nowMs: number): boolean {
  const escalated = BAND_RANK[c.priority.band] > BAND_RANK[row.priority.band];
  const stateChanged = c.stateHash !== row.stateHash;
  switch (row.status) {
    case "open":
      return false;
    case "seen":
      return stateChanged;
    case "snoozed": {
      // A snoozed row always has snooze_until (DB check); NaN would compare false.
      const until = row.snoozeUntil === null ? Number.NaN : Date.parse(row.snoozeUntil);
      return until <= nowMs || escalated;
    }
    case "dismissed":
      return escalated;
    case "resolved":
      // He resolved it himself: it stays put until the state really changes.
      return row.resolution === "owner" ? stateChanged : true;
  }
}

/**
 * The candidate as it will be written over `row`. A dismissed or snoozed row
 * that stays put keeps its stored priority when the candidate's band is
 * lower, so the stored band is the highest it has been since he put the item
 * away. reopens() compares against it: "escalated" then means above the band
 * he dismissed or snoozed it at. Writing the lower band would let an item
 * that dips below its band and climbs back reopen something he dismissed.
 * Everything else is the candidate's, and a row that reopens takes the
 * candidate's priority too.
 */
function asWritten(row: AttentionItem, c: AttentionCandidate, reopen: boolean): AttentionCandidate {
  const putAway = row.status === "dismissed" || row.status === "snoozed";
  if (reopen || !putAway || BAND_RANK[c.priority.band] >= BAND_RANK[row.priority.band]) return c;
  return { ...c, priority: row.priority };
}

function plan(
  existing: readonly AttentionItem[],
  candidates: readonly AttentionCandidate[],
  scope: AttentionScope,
  now: Date
): AttentionPlan {
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const kinds = new Set(scope.kinds);
  const inScope = (row: AttentionItem) => row.source === scope.source && kinds.has(row.kind);
  const rows = new Map(existing.map((row) => [row.id, row]));
  const byFingerprint = new Map<string, AttentionItem>();
  for (const row of rows.values()) byFingerprint.set(row.fingerprint, row);

  const out: AttentionPlan = { inserts: [], updates: [], resolves: [], unchanged: 0 };
  const present = new Set<string>();
  for (const c of candidates) {
    present.add(c.fingerprint);
    const row = byFingerprint.get(c.fingerprint);
    if (!row) {
      out.inserts.push(c);
      continue;
    }
    // Fingerprints are namespaced by rule, so this is a producer bug. Taking
    // the row over would move it out of the scope that owns it.
    if (!inScope(row)) invalid(`${c.fingerprint} already belongs to ${row.source}/${row.kind}, outside this sync's scope`);
    const reopen = reopens(row, c, nowMs);
    const next = asWritten(row, c, reopen);
    if (!reopen && sameContent(row, next)) {
      out.updates.push({ id: row.id, patch: { last_seen_at: nowIso }, change: "unchanged" });
      out.unchanged += 1;
      continue;
    }
    const status = reopen ? { status: "open", snooze_until: null, resolution: null, resolved_at: null } : {};
    out.updates.push({
      id: row.id,
      patch: { ...contentColumns(next), ...status, last_seen_at: nowIso, updated_at: nowIso },
      change: reopen ? "reopened" : "updated"
    });
  }
  for (const row of rows.values()) {
    if (inScope(row) && row.status !== "resolved" && !present.has(row.fingerprint)) out.resolves.push(row.id);
  }
  return out;
}

/**
 * Plan the writes that bring the stored rows of `scope` in line with
 * `candidates` (pure). `existing` may hold rows outside the scope; they are
 * never touched, and a candidate whose fingerprint belongs to one throws.
 * Candidates are normalized and checked like syncAttention's.
 *
 * Every update sets last_seen_at; a real change also sets updated_at.
 * Resolves (rows of the scope that are live and no longer present) are
 * applied as status resolved, resolution auto, resolved_at = now.
 */
export function reconcile(
  existing: AttentionItem[],
  candidates: AttentionCandidate[],
  scope: { source: AttentionSource; kinds: readonly string[] },
  now: Date
): AttentionPlan {
  return plan(existing, prepareCandidates(candidates, scope), scope, validNow(now));
}

function validNow(now: unknown): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) invalid("now must be a valid Date");
  return now;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function requiredIso(v: unknown, what: string): string {
  const iso = isoOrNull(v);
  if (iso === null) throw new Error(`${what} is not a timestamp`);
  return iso;
}

/** A stored row as an item. Content goes through the same normalization as a candidate. */
function itemFromRow(row: unknown): AttentionItem {
  if (!isRecord(row) || typeof row.id !== "string" || typeof row.principal_id !== "string") {
    throw new Error(`${TABLE} read failed: malformed row`);
  }
  try {
    const content = normalizeCandidate({
      fingerprint: row.fingerprint,
      source: row.source,
      kind: row.kind,
      category: row.category,
      title: row.title,
      whatHappened: row.what_happened,
      whyItMatters: row.why_it_matters,
      recommendedNext: row.recommended_next,
      facts: row.facts,
      refs: row.refs,
      priority: { score: row.priority_score, band: row.priority_band, reasons: row.priority_reasons },
      stateHash: row.state_hash,
      occurredAt: row.occurred_at
    } as AttentionCandidate);
    return {
      ...content,
      id: row.id,
      principalId: row.principal_id,
      status: oneOf<AttentionStatus>(STATUSES, row.status, "status"),
      snoozeUntil: row.snooze_until === null ? null : requiredIso(row.snooze_until, "snooze_until"),
      firstSeenAt: requiredIso(row.first_seen_at, "first_seen_at"),
      lastSeenAt: requiredIso(row.last_seen_at, "last_seen_at"),
      resolvedAt: row.resolved_at === null ? null : requiredIso(row.resolved_at, "resolved_at"),
      resolution: row.resolution === null ? null : oneOf<"auto" | "owner">(RESOLUTIONS, row.resolution, "resolution"),
      updatedAt: requiredIso(row.updated_at, "updated_at")
    };
  } catch (err) {
    // A row the checks above refuse is shown to no one: the read fails.
    throw new Error(`${TABLE} read failed: row ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function itemsFrom(data: unknown): AttentionItem[] {
  if (!Array.isArray(data)) throw new Error(`${TABLE} read failed: no rows array in the response`);
  return data.map(itemFromRow);
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

type DbError = { message: string };

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Chunks for an `in.(…)` filter: at most WRITE_CHUNK values and URL_LIST_BUDGET encoded characters each. */
function urlListChunks(values: readonly string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const value of values) {
    const cost = encodeURIComponent(value).length + 3; // and the encoded comma
    if (current.length > 0 && (current.length >= WRITE_CHUNK || size + cost > URL_LIST_BUDGET)) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(value);
    size += cost;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * The error to throw for a failed request. When the signal fired (timeout,
 * lost lease), postgrest-js reports an AbortError result; the signal's own
 * reason says why, so that is thrown instead.
 */
function failure(what: string, error: DbError, signal: AbortSignal | undefined): Error {
  signal?.throwIfAborted();
  return new Error(`${TABLE} ${what} failed: ${error.message}`);
}

interface LoadedRows {
  items: AttentionItem[];
  /**
   * Each row's updated_at exactly as PostgREST printed it. A write is fenced
   * on it, and an item's own updatedAt is rounded to the millisecond, which
   * would never match a value written by now() in SQL (microseconds).
   */
  versions: Map<string, string>;
}

/** Add a page of rows (already checked by itemsFrom) and their versions. */
function addRows(data: unknown, into: LoadedRows["versions"], items: Map<string, AttentionItem>): number {
  const parsed = itemsFrom(data);
  const raw = data as Record<string, unknown>[];
  parsed.forEach((item, i) => {
    items.set(item.id, item);
    // itemFromRow has checked it is a timestamp string.
    into.set(item.id, raw[i].updated_at as string);
  });
  return parsed.length;
}

/**
 * Every row the sync may touch: the live rows of the scope (the ones to
 * resolve when nothing matches them), plus any row, in any status, that holds
 * a candidate's fingerprint (a resolved row that may reopen, or a clash with
 * another scope that reconcile refuses). Resolved rows of the scope that no
 * candidate names are left unread: they are never touched.
 */
async function loadRows(
  principal: ExecPrincipal,
  scope: AttentionScope,
  candidates: readonly AttentionCandidate[],
  signal: AbortSignal | undefined
): Promise<LoadedRows> {
  const rows = new Map<string, AttentionItem>();
  const versions = new Map<string, string>();
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) throw new Error(`${TABLE} read failed: more than ${MAX_PAGES * PAGE_SIZE} live rows in one scope`);
    signal?.throwIfAborted();
    let query = getSupabaseAdmin()
      .from(TABLE)
      .select(ITEM_COLUMNS)
      .eq("principal_id", principal.id)
      .eq("source", scope.source)
      .in("kind", [...scope.kinds])
      .neq("status", "resolved")
      .order("id")
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw failure("read", error, signal);
    if (addRows(data, versions, rows) < PAGE_SIZE) break;
  }

  const live = new Set([...rows.values()].map((row) => row.fingerprint));
  const unknown = candidates.map((c) => c.fingerprint).filter((fp) => !live.has(fp));
  for (const chunk of urlListChunks(unknown)) {
    signal?.throwIfAborted();
    // At most WRITE_CHUNK fingerprints, each unique per principal: one page.
    let query = getSupabaseAdmin().from(TABLE).select(ITEM_COLUMNS).eq("principal_id", principal.id).in("fingerprint", chunk).order("id");
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw failure("read", error, signal);
    addRows(data, versions, rows);
  }
  return { items: [...rows.values()], versions };
}

function insertRow(principal: ExecPrincipal, c: AttentionCandidate, nowIso: string): Record<string, unknown> {
  return {
    principal_id: principal.id,
    fingerprint: c.fingerprint,
    source: c.source,
    ...contentColumns(c),
    status: "open",
    first_seen_at: nowIso,
    last_seen_at: nowIso,
    updated_at: nowIso
  };
}

/**
 * Apply a plan. Inserts go first and resolves last: if a step fails partway,
 * the feed shows a finished item a little longer instead of missing a new one,
 * and the next sync, which reconciles from what is stored, finishes the job.
 *
 * Every write is scoped to the principal and fenced, and a write the fence
 * stops is skipped (counted in the warning). The next sync reconciles that
 * row afresh from what is stored.
 *   - Overlapping syncs. Two refreshes for one principal can run at once (a
 *     retry can outlast its 10-minute bucket), and the earlier one can finish
 *     last with older data. Every update and resolve requires last_seen_at
 *     <= this sync's now, and every write that keeps a row stamps last_seen_at,
 *     so a row a later sync has already seen is never written by an earlier
 *     one, and last_seen_at only moves forward. A resolve stamps updated_at
 *     instead (the situation wasn't seen), so a content or reopen update also
 *     requires updated_at <= now: an earlier sync never reopens what a later
 *     one resolved, even when it read the row after that. An insert whose
 *     fingerprint appeared since the read is skipped too.
 *   - His actions. A content or reopen update is also a compare-and-set on
 *     the status and the exact updated_at it read, so anything he did to the
 *     row since the read wins, a change that kept its status included (a new
 *     snooze on one that had run out). For that to hold, every write that
 *     acts for him (P5's seen, snooze, dismiss, resolve) must set updated_at,
 *     and must leave last_seen_at alone: that is when a producer last saw
 *     the situation (lastAttentionRefresh).
 * The last-seen bump of an unchanged row doesn't touch updated_at, so
 * consecutive syncs never trip each other's compare-and-set.
 */
async function applyPlan(
  principal: ExecPrincipal,
  todo: AttentionPlan,
  existing: LoadedRows,
  now: Date,
  signal: AbortSignal | undefined
): Promise<AttentionSyncResult> {
  const db = () => getSupabaseAdmin().from(TABLE);
  const nowIso = now.toISOString();
  const statusById = new Map(existing.items.map((row) => [row.id, row.status]));
  const result: AttentionSyncResult = { inserted: 0, updated: 0, reopened: 0, resolved: 0, unchanged: 0 };
  let skipped = 0;

  for (const chunk of chunks(todo.inserts, WRITE_CHUNK)) {
    signal?.throwIfAborted();
    let query = db()
      .upsert(
        chunk.map((c) => insertRow(principal, c, nowIso)),
        { onConflict: "principal_id,fingerprint", ignoreDuplicates: true }
      )
      .select("id");
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw failure("insert", error, signal);
    const inserted = Array.isArray(data) ? data.length : 0;
    result.inserted += inserted;
    skipped += chunk.length - inserted;
  }

  const changed = todo.updates.filter((u) => u.change !== "unchanged");
  for (const window of chunks(changed, UPDATE_CONCURRENCY)) {
    signal?.throwIfAborted();
    const applied = await Promise.all(
      window.map(async (u) => {
        let query = db()
          .update(u.patch, { count: "exact" })
          .eq("principal_id", principal.id)
          .eq("id", u.id)
          .eq("status", statusById.get(u.id) ?? "")
          .eq("updated_at", existing.versions.get(u.id) ?? "")
          .lte("updated_at", nowIso)
          .lte("last_seen_at", nowIso);
        if (signal) query = query.abortSignal(signal);
        const { count, error } = await query;
        if (error) throw failure("update", error, signal);
        return (count ?? 0) > 0;
      })
    );
    window.forEach((u, i) => {
      if (!applied[i]) skipped += 1;
      else if (u.change === "reopened") result.reopened += 1;
      else result.updated += 1;
    });
  }

  // Unchanged rows all get the same patch, so they go in batches.
  const unchanged = todo.updates.filter((u) => u.change === "unchanged").map((u) => u.id);
  for (const chunk of urlListChunks(unchanged)) {
    signal?.throwIfAborted();
    let query = db()
      .update({ last_seen_at: nowIso }, { count: "exact" })
      .eq("principal_id", principal.id)
      .in("id", chunk)
      .lte("last_seen_at", nowIso);
    if (signal) query = query.abortSignal(signal);
    const { count, error } = await query;
    if (error) throw failure("update", error, signal);
    result.unchanged += count ?? 0;
    skipped += chunk.length - (count ?? 0);
  }

  for (const chunk of urlListChunks(todo.resolves)) {
    signal?.throwIfAborted();
    let query = db()
      .update({ status: "resolved", resolution: "auto", resolved_at: nowIso, snooze_until: null, updated_at: nowIso }, { count: "exact" })
      .eq("principal_id", principal.id)
      .in("id", chunk)
      // A row he resolved himself in the meantime keeps his resolution.
      .neq("status", "resolved")
      .lte("last_seen_at", nowIso);
    if (signal) query = query.abortSignal(signal);
    const { count, error } = await query;
    if (error) throw failure("resolve", error, signal);
    result.resolved += count ?? 0;
    skipped += chunk.length - (count ?? 0);
  }

  if (skipped > 0) console.warn(`[exec-attention] ${skipped} write(s) skipped for ${principal.id}: rows changed during the sync`);
  return result;
}

/**
 * Reconcile one producer's candidates with the stored items of its scope and
 * write the result. Returns how many rows were inserted, updated, reopened,
 * resolved and left unchanged.
 *
 * Throws NonRetryableError, before reading or writing anything, when a
 * candidate's source or kind is outside the scope, two candidates share a
 * fingerprint, a fingerprint doesn't start with "<source>:", or a candidate
 * is otherwise invalid (see normalizeCandidate). Throws on any database error.
 *
 * An empty `candidates` resolves every live item of the scope, so a producer
 * whose reads failed must throw instead of syncing an empty list.
 *
 * Two syncs of one scope may overlap: the earlier one never writes a row the
 * later one has already stamped, and neither overrides what he did to a row
 * since its read (see applyPlan).
 */
export async function syncAttention(
  principal: ExecPrincipal,
  scope: { source: AttentionSource; kinds: readonly string[] },
  candidates: readonly AttentionCandidate[],
  now: Date = new Date(),
  opts: { signal?: AbortSignal } = {}
): Promise<AttentionSyncResult> {
  const at = validNow(now);
  const prepared = prepareCandidates(candidates, scope);
  const loaded = await loadRows(principal, scope, prepared, opts.signal);
  const result = await applyPlan(principal, plan(loaded.items, prepared, scope, at), loaded, at, opts.signal);
  console.log(
    `[exec-attention] synced ${scope.source} for ${principal.id}: inserted=${result.inserted} updated=${result.updated} ` +
      `reopened=${result.reopened} resolved=${result.resolved} unchanged=${result.unchanged}`
  );
  return result;
}

// ---------------------------------------------------------------------------
// Email items (P3): fingerprints, the per-thread read, hard deletes
// ---------------------------------------------------------------------------
//
// Email items are keyed by the thread (or client) they are about (L4):
//   email:thread:<threadId>:<anchorMessageId>
//   email:commitment:<threadId>:<commitmentId>
//   email:satisfaction:<clientId>
//   email:health:<clientId>
// The anchor message id and the commitment id never hold a ":" (clone ids are
// UUIDs, commitment ids "ec_<hex>"), so the thread id is everything between
// the prefix and the LAST ":". The builders refuse any part that would break
// that, so every fingerprint they make parses back to the parts it was made
// from (the store's purge and the render-time screens rely on it).
//
// Restricted mail (L2): a thread that becomes a tombstone must not keep an
// item anywhere, in any status. A resolved item keeps its title and facts for
// 90 days, so resolving isn't enough: these rows are hard-deleted
// (deleteEmailAttentionForThreads, from the tombstone procedure and the
// attention pass's safety nets).

export type EmailFingerprintKind = "thread" | "commitment" | "satisfaction" | "health";

export interface ParsedEmailFingerprint {
  kind: EmailFingerprintKind;
  /** The clone thread a thread or commitment item hangs off; null for the client-level kinds. */
  threadId: string | null;
  /** thread: the anchor message id; commitment: the commitment id; satisfaction, health: the client id. */
  key: string;
}

const EMAIL_FINGERPRINT_PREFIXES: readonly (readonly [string, EmailFingerprintKind])[] = [
  ["email:thread:", "thread"],
  ["email:commitment:", "commitment"],
  ["email:satisfaction:", "satisfaction"],
  ["email:health:", "health"]
];

/**
 * The parts of an email item's fingerprint, or null for anything that isn't
 * one of the four email shapes (a DD fingerprint, a malformed one). A consumer
 * that screens email items treats null as "can't tell which thread": drop it.
 */
export function parseEmailFingerprint(fp: string): ParsedEmailFingerprint | null {
  if (typeof fp !== "string") return null;
  for (const [prefix, kind] of EMAIL_FINGERPRINT_PREFIXES) {
    if (!fp.startsWith(prefix)) continue;
    const rest = fp.slice(prefix.length);
    if (kind === "satisfaction" || kind === "health") {
      return rest.length > 0 && !rest.includes(":") ? { kind, threadId: null, key: rest } : null;
    }
    const cut = rest.lastIndexOf(":");
    if (cut <= 0 || cut === rest.length - 1) return null;
    return { kind, threadId: rest.slice(0, cut), key: rest.slice(cut + 1) };
  }
  return null;
}

/** A fingerprint part: clean, and free of the characters a fingerprint or PostgREST filter can't hold. */
function fingerprintPart(v: unknown, allowColon: boolean): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    isCleanId(v, MAX_FINGERPRINT) &&
    FINGERPRINT_CHARS.test(v) &&
    (allowColon || !v.includes(":"))
  );
}

function builtFingerprint(fp: string): string | null {
  return isCleanId(fp, MAX_FINGERPRINT) && FINGERPRINT_CHARS.test(fp) ? fp : null;
}

/** email:thread:<threadId>:<anchorMessageId>, or null when a part can't be keyed (the item is then not made). */
export function emailThreadFingerprint(threadId: string, anchorMessageId: string): string | null {
  if (!fingerprintPart(threadId, true) || !fingerprintPart(anchorMessageId, false)) return null;
  return builtFingerprint(`email:thread:${threadId}:${anchorMessageId}`);
}

/** email:commitment:<threadId>:<commitmentId>, or null when a part can't be keyed. */
export function emailCommitmentFingerprint(threadId: string, commitmentId: string): string | null {
  if (!fingerprintPart(threadId, true) || !fingerprintPart(commitmentId, false)) return null;
  return builtFingerprint(`email:commitment:${threadId}:${commitmentId}`);
}

/** email:satisfaction:<clientId> / email:health:<clientId>, or null when the id can't be keyed. */
export function emailClientFingerprint(kind: "satisfaction" | "health", clientId: string): string | null {
  if (kind !== "satisfaction" && kind !== "health") return null;
  if (!fingerprintPart(clientId, false)) return null;
  return builtFingerprint(`email:${kind}:${clientId}`);
}

/** One email item's identity, as the safety nets and the per-thread read need it. */
export interface EmailAttentionRow {
  id: string;
  fingerprint: string;
  kind: string;
  status: AttentionStatus;
}

const EMAIL_ROW_COLUMNS = "id,fingerprint,kind,status";
const MAX_ROW_ID = 100;

/** A row id as the table makes them ("ea_<hex>"): clean, and nothing a filter would have to quote. */
const isRowId = (v: unknown): v is string => isCleanId(v, MAX_ROW_ID) && FINGERPRINT_CHARS.test(v);

function emailRowFrom(raw: unknown): EmailAttentionRow {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.fingerprint !== "string" || typeof raw.kind !== "string") {
    throw new Error(`${TABLE} read failed: malformed row`);
  }
  return { id: raw.id, fingerprint: raw.fingerprint, kind: raw.kind, status: oneOf<AttentionStatus>(STATUSES, raw.status, "status") };
}

/**
 * One keyset page of the principal's email items, every status, ordered by
 * id: pass the last id as `afterId` for the next page. Identity columns only
 * (no title, no facts). limit is 1..1000. Throws on a database error.
 */
export async function listEmailAttentionRows(
  principal: ExecPrincipal,
  q: { afterId: string | null; limit: number },
  opts: { signal?: AbortSignal } = {}
): Promise<EmailAttentionRow[]> {
  if (!Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > PAGE_SIZE) invalid(`listEmailAttentionRows limit must be 1-${PAGE_SIZE}`);
  if (q.afterId !== null && !isRowId(q.afterId)) invalid("listEmailAttentionRows afterId is malformed");
  opts.signal?.throwIfAborted();
  let query = getSupabaseAdmin().from(TABLE).select(EMAIL_ROW_COLUMNS).eq("principal_id", principal.id).eq("source", "email");
  if (q.afterId !== null) query = query.gt("id", q.afterId);
  query = query.order("id", { ascending: true }).limit(q.limit);
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { data, error } = await query;
  if (error) throw failure("read", error, opts.signal);
  if (!Array.isArray(data)) throw new Error(`${TABLE} read failed: no rows array in the response`);
  return data.map(emailRowFrom);
}

/** Every email item of the principal (identity columns), page by page. Throws past MAX_PAGES pages and on a database error. */
export async function listAllEmailAttentionRows(principal: ExecPrincipal, opts: { signal?: AbortSignal } = {}): Promise<EmailAttentionRow[]> {
  return allEmailAttentionRows(principal, opts.signal);
}

async function allEmailAttentionRows(principal: ExecPrincipal, signal: AbortSignal | undefined): Promise<EmailAttentionRow[]> {
  const out: EmailAttentionRow[] = [];
  let afterId: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await listEmailAttentionRows(principal, { afterId, limit: PAGE_SIZE }, { signal });
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
    afterId = rows[rows.length - 1].id;
  }
  throw new Error(`${TABLE} read failed: more than ${MAX_PAGES * PAGE_SIZE} email items`);
}

/**
 * Hard-delete these items of the principal, whatever their status, limited to
 * one source when `source` is given (the email code always passes "email", so
 * a stray id can never take a DD item with it). Returns how many went.
 * Throws on a database error.
 */
export async function deleteAttentionItemsByIds(
  principal: ExecPrincipal,
  ids: readonly string[],
  opts: { source?: AttentionSource; signal?: AbortSignal } = {}
): Promise<number> {
  if (!Array.isArray(ids)) invalid("deleteAttentionItemsByIds needs a list of ids");
  if (opts.source !== undefined) oneOf<AttentionSource>(SOURCES, opts.source, "source");
  const unique = [...new Set(ids)];
  for (const id of unique) if (!isRowId(id)) invalid("deleteAttentionItemsByIds: an id is malformed");
  let deleted = 0;
  for (const chunk of urlListChunks(unique)) {
    opts.signal?.throwIfAborted();
    let query = getSupabaseAdmin().from(TABLE).delete({ count: "exact" }).eq("principal_id", principal.id).in("id", chunk);
    if (opts.source !== undefined) query = query.eq("source", opts.source);
    if (opts.signal) query = query.abortSignal(opts.signal);
    const { count, error } = await query;
    if (error) throw failure("delete", error, opts.signal);
    deleted += count ?? 0;
  }
  return deleted;
}

/**
 * Hard-delete every email item about these threads, in every status: the
 * thread items (email:thread:<id>:…) and the commitment items
 * (email:commitment:<id>:…). The tombstone procedure (email-store.ts) and the
 * attention pass's safety nets call it; a restricted thread must leave no
 * title, summary or promise behind, not even on a resolved row. Returns how
 * many rows went. Throws on a database error, so a tombstone that couldn't
 * finish this step is retried.
 */
export async function deleteEmailAttentionForThreads(
  principal: ExecPrincipal,
  threadIds: readonly string[],
  opts: { signal?: AbortSignal } = {}
): Promise<number> {
  if (!Array.isArray(threadIds)) invalid("deleteEmailAttentionForThreads needs a list of thread ids");
  const wanted = new Set(threadIds.filter((id) => typeof id === "string" && id.length > 0));
  if (wanted.size === 0) return 0;
  const rows = await allEmailAttentionRows(principal, opts.signal);
  const doomed = rows
    .filter((row) => {
      const parsed = parseEmailFingerprint(row.fingerprint);
      return parsed !== null && parsed.threadId !== null && wanted.has(parsed.threadId);
    })
    .map((row) => row.id);
  if (doomed.length === 0) return 0;
  const deleted = await deleteAttentionItemsByIds(principal, doomed, { source: "email", signal: opts.signal });
  console.log(`[exec-attention] deleted ${deleted} email item(s) of ${wanted.size} thread(s) for ${principal.id}`);
  return deleted;
}

// The thread page shows what the feed knows about the thread, put away or not.
const THREAD_DEFAULT_STATUSES: readonly AttentionStatus[] = ["open", "seen", "snoozed", "dismissed"];

/**
 * The items about one email thread (its thread item and its commitment
 * items), highest priority first, for the thread page. By default every
 * status but resolved; a snoozed item whose snooze has run out counts as
 * open, as in listAttention. The caller still screens them (A2): this only
 * finds them. Throws on a database error.
 */
export async function listAttentionForThread(
  principal: ExecPrincipal,
  threadId: string,
  opts: { statuses?: readonly AttentionStatus[]; now?: Date; signal?: AbortSignal } = {}
): Promise<AttentionItem[]> {
  if (typeof threadId !== "string" || threadId.length === 0) invalid("listAttentionForThread needs a thread id");
  const now = validNow(opts.now ?? new Date());
  const statuses = opts.statuses ?? THREAD_DEFAULT_STATUSES;
  if (!Array.isArray(statuses) || statuses.length === 0) invalid("listAttentionForThread needs at least one status");
  const wanted = new Set(statuses.map((s) => oneOf<AttentionStatus>(STATUSES, s, "status")));

  const ids = (await allEmailAttentionRows(principal, opts.signal))
    .filter((row) => parseEmailFingerprint(row.fingerprint)?.threadId === threadId)
    .map((row) => row.id);
  const items: AttentionItem[] = [];
  for (const chunk of urlListChunks(ids)) {
    opts.signal?.throwIfAborted();
    let query = getSupabaseAdmin().from(TABLE).select(ITEM_COLUMNS).eq("principal_id", principal.id).eq("source", "email").in("id", chunk).order("id");
    if (opts.signal) query = query.abortSignal(opts.signal);
    const { data, error } = await query;
    if (error) throw failure("read", error, opts.signal);
    items.push(...itemsFrom(data));
  }
  const nowMs = now.getTime();
  return items
    .map((item) => effective(item, nowMs))
    .filter((item) => wanted.has(item.status))
    .sort(
      (a, b) =>
        b.priority.score - a.priority.score ||
        Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
}

/** The status he sees: a snoozed item whose snooze has run out is open again (no snooze shown). */
function effective(item: AttentionItem, nowMs: number): AttentionItem {
  if (item.status === "snoozed" && item.snoozeUntil !== null && Date.parse(item.snoozeUntil) <= nowMs) {
    return { ...item, status: "open", snoozeUntil: null };
  }
  return item;
}

/**
 * The PostgREST `or` filter for the statuses he sees. "open" includes snoozed
 * rows whose snooze has run out, and "snoozed" means still snoozed.
 */
function statusFilter(wanted: ReadonlySet<AttentionStatus>, nowIso: string): string {
  const direct = STATUS_ORDER.filter((s) => s !== "snoozed" && wanted.has(s));
  const terms: string[] = [];
  if (wanted.has("open") && wanted.has("snoozed")) direct.push("snoozed");
  else if (wanted.has("open")) terms.push(`and(status.eq.snoozed,snooze_until.lte.${nowIso})`);
  else if (wanted.has("snoozed")) terms.push(`and(status.eq.snoozed,snooze_until.gt.${nowIso})`);
  if (direct.length > 0) terms.unshift(`status.in.(${direct.join(",")})`);
  return terms.join(",");
}

/**
 * The principal's items, highest priority first (then most recently seen).
 *
 * Statuses are the ones he sees: by default open and seen, where open
 * includes a snoozed item whose snooze has run out (returned as "open").
 * Ask for "snoozed" to get the ones still snoozed. limit defaults to 50,
 * clamped to 1..200. Throws on a database error and on an empty or unknown
 * status list (an empty feed has to mean "nothing", not "asked for nothing").
 */
export async function listAttention(
  principal: ExecPrincipal,
  opts: { statuses?: AttentionStatus[]; limit?: number; now?: Date } = {}
): Promise<AttentionItem[]> {
  const now = validNow(opts.now ?? new Date());
  const statuses = opts.statuses ?? FEED_STATUSES;
  if (!Array.isArray(statuses) || statuses.length === 0) invalid("listAttention needs at least one status");
  const wanted = new Set(statuses.map((s) => oneOf<AttentionStatus>(STATUSES, s, "status")));
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit)
      ? Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(opts.limit)))
      : DEFAULT_LIST_LIMIT;

  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select(ITEM_COLUMNS)
    .eq("principal_id", principal.id)
    .or(statusFilter(wanted, now.toISOString()))
    .order("priority_score", { ascending: false })
    .order("last_seen_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`${TABLE} read failed: ${error.message}`);
  return itemsFrom(data).map((item) => effective(item, now.getTime()));
}

/**
 * When a producer of `source` last saw anything: max(last_seen_at) over the
 * principal's items of that source, or null when it has none. A sync that
 * finds nothing at all leaves no row to stamp, so this is "last saw an item",
 * not "last ran"; the job history has the run times.
 *
 * P5a (contract §3.3.1, a-correct-16): `kinds` narrows it to one producer's
 * kinds (.in("kind", kinds)). Two producers share source "dd" (the DD rules
 * and DD text triage), so the DD freshness line passes DD_ATTENTION_KINDS:
 * the ddtext job's own last_seen_at bumps never make a dead exec.dd-attention
 * look fresh. Without it, unchanged.
 */
export async function lastAttentionRefresh(
  principal: ExecPrincipal,
  source: AttentionSource,
  opts?: { kinds?: readonly string[] }
): Promise<string | null> {
  oneOf<AttentionSource>(SOURCES, source, "source");
  const kinds = opts?.kinds;
  if (kinds !== undefined) {
    if (!Array.isArray(kinds) || kinds.length === 0) invalid("lastAttentionRefresh needs at least one kind when kinds is given");
    for (const kind of kinds) if (typeof kind !== "string" || !KIND_PATTERN.test(kind)) invalid(`lastAttentionRefresh kind ${shown(kind)} is not a kind`);
  }
  let query = getSupabaseAdmin().from(TABLE).select("last_seen_at").eq("principal_id", principal.id).eq("source", source);
  if (kinds !== undefined) query = query.in("kind", [...kinds]);
  const { data, error } = await query.order("last_seen_at", { ascending: false }).limit(1);
  if (error) throw new Error(`${TABLE} read failed: ${error.message}`);
  if (!Array.isArray(data)) throw new Error(`${TABLE} read failed: no rows array in the response`);
  if (data.length === 0) return null;
  const iso = isoOrNull((data[0] as { last_seen_at?: unknown }).last_seen_at);
  if (iso === null) throw new Error(`${TABLE} read failed: last_seen_at is not a timestamp`);
  return iso;
}

// ---------------------------------------------------------------------------
// P5a (contract §3.3; Area A): the store reads behind the screened accessor
// (attention-read.ts) and the owner-action writer. listAttention above stays
// as P2b wrote it (C26); only attention-read.ts may call it (boundary rule 11).
// ---------------------------------------------------------------------------

/** exec_attention_items.id (exec_attention.sql: 'ea_' || a uuid without dashes). */
export const ATTENTION_ITEM_ID = /^ea_[0-9a-f]{32}$/;

/**
 * A timestamp as PostgREST prints timestamptz (or as toISOString writes it):
 * the form a cursor key, a version token or a since-filter may take before it
 * goes into a filter string.
 */
const FEED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;
const MAX_VERSION = 64;
const MAX_PAGE_QUERY_LIMIT = 101;
const SNOOZE_MIN_AHEAD_MS = 60_000;
const SNOOZE_MAX_AHEAD_MS = 90 * 86_400_000;

/** C6: the status filter → the statuses he sees ("open" includes snoozes that have run out). */
const STATUS_FILTER_SETS: Readonly<Record<AttentionStatusFilter, readonly AttentionStatus[]>> = {
  default: FEED_STATUSES,
  open: ["open"],
  seen: ["seen"],
  snoozed: ["snoozed"],
  dismissed: ["dismissed"],
  resolved: ["resolved"]
};

/** A version token, cursor key or since-filter value of the shape C3/C5 allow (PostgREST timestamptz or toISOString). Pure. */
export const isFeedTimestamp = (v: unknown): v is string => typeof v === "string" && FEED_TIMESTAMP.test(v) && Number.isFinite(Date.parse(v));

function statusSetFor(statuses: AttentionStatusFilter): ReadonlySet<AttentionStatus> {
  if (typeof statuses !== "string" || !Object.prototype.hasOwnProperty.call(STATUS_FILTER_SETS, statuses)) invalid(`unknown status filter ${shown(statuses)}`);
  return new Set(STATUS_FILTER_SETS[statuses]);
}

export interface AttentionCursorKey {
  score: number;
  firstSeenRaw: string;
  id: string;
}

/** True for a keyset position that may go into a filter: score 0..100, a PostgREST timestamp, an item id. */
export function isAttentionCursorKey(key: unknown): key is AttentionCursorKey {
  if (!isRecord(key)) return false;
  return (
    typeof key.score === "number" &&
    Number.isInteger(key.score) &&
    key.score >= 0 &&
    key.score <= 100 &&
    isFeedTimestamp(key.firstSeenRaw) &&
    typeof key.id === "string" &&
    ATTENTION_ITEM_ID.test(key.id)
  );
}

export interface AttentionPageQuery {
  /** mapped to P2b's statusFilter */
  statuses: AttentionStatusFilter;
  category?: AttentionCategory;
  band?: PriorityBand;
  source?: AttentionSource;
  kind?: string;
  firstSeenAfter?: string;
  updatedAfter?: string;
  after: AttentionCursorKey | null;
  /** 1..101 (the accessor asks limit+1) */
  limit: number;
  now: Date;
}

export interface AttentionPageRow {
  /** The item as stored (not effective(): a run-out snooze still says snoozed). */
  item: AttentionItem;
  /** updated_at exactly as PostgREST printed it: the CAS token (C3). */
  version: string;
  /** first_seen_at exactly as PostgREST printed it: the cursor key (C5). */
  firstSeenRaw: string;
}

/**
 * C5: the feed's one PostgREST `or` filter. Without a cursor, the status terms
 * (P2b's statusFilter: "open" includes snoozes that have run out); with one,
 * those AND the keyset position after `after` in (priority_score desc,
 * first_seen_at desc, id asc) order:
 *   and(or(<status>),or(priority_score.lt.S,and(priority_score.eq.S,first_seen_at.lt."F"),
 *       and(priority_score.eq.S,first_seen_at.eq."F",id.gt.I)))
 * F is the raw first_seen_at (microseconds kept), quoted. Every value is
 * checked before it goes in: S an integer 0..100, F a timestamp, I an item id,
 * nowIso a timestamp. Throws NonRetryableError otherwise. Pure.
 */
export function feedOrFilter(statuses: AttentionStatusFilter, nowIso: string, after: AttentionCursorKey | null): string {
  const wanted = statusSetFor(statuses);
  if (!isFeedTimestamp(nowIso)) invalid("feedOrFilter: now must be a timestamp");
  const terms = statusFilter(wanted, nowIso);
  if (after === null) return terms;
  if (!isAttentionCursorKey(after)) invalid("feedOrFilter: the cursor key is malformed");
  const s = after.score;
  const f = `"${after.firstSeenRaw}"`;
  return (
    `and(or(${terms}),or(priority_score.lt.${s},` +
    `and(priority_score.eq.${s},first_seen_at.lt.${f}),` +
    `and(priority_score.eq.${s},first_seen_at.eq.${f},id.gt.${after.id})))`
  );
}

/** Rows with their raw version and first_seen_at strings (itemFromRow rounds both to the millisecond). */
function pageRowsFrom(data: unknown): AttentionPageRow[] {
  const items = itemsFrom(data);
  const raw = data as Record<string, unknown>[];
  return items.map((item, i) => {
    const version = raw[i].updated_at;
    const firstSeenRaw = raw[i].first_seen_at;
    if (typeof version !== "string" || typeof firstSeenRaw !== "string") throw new Error(`${TABLE} read failed: row ${item.id}: timestamps are not strings`);
    return { item, version, firstSeenRaw };
  });
}

function sinceFilter(v: unknown, what: string): string {
  if (!isFeedTimestamp(v)) invalid(`${what} must be a timestamp`);
  return v;
}

/**
 * One page in (priority_score desc, first_seen_at desc, id asc) order (C5).
 * Status and cursor terms go in ONE .or() built by feedOrFilter();
 * category/band/source/kind are .eq(); the since-filters .gte(). Items come
 * back as stored, each with its raw version and first_seen_at. Throws
 * NonRetryableError on a bad query and an Error on a database error.
 */
export async function listAttentionPage(
  principal: ExecPrincipal,
  q: AttentionPageQuery,
  opts: { signal?: AbortSignal } = {}
): Promise<AttentionPageRow[]> {
  if (!isRecord(q)) invalid("listAttentionPage needs a query");
  const now = validNow(q.now);
  if (!Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > MAX_PAGE_QUERY_LIMIT) invalid(`listAttentionPage limit must be 1-${MAX_PAGE_QUERY_LIMIT}`);
  const filter = feedOrFilter(q.statuses, now.toISOString(), q.after);
  opts.signal?.throwIfAborted();
  let query = getSupabaseAdmin().from(TABLE).select(ITEM_COLUMNS).eq("principal_id", principal.id).or(filter);
  if (q.category !== undefined) query = query.eq("category", oneOf<AttentionCategory>(CATEGORIES, q.category, "category"));
  if (q.band !== undefined) query = query.eq("priority_band", oneOf<PriorityBand>(BANDS, q.band, "band"));
  if (q.source !== undefined) query = query.eq("source", oneOf<AttentionSource>(SOURCES, q.source, "source"));
  if (q.kind !== undefined) {
    if (typeof q.kind !== "string" || !KIND_PATTERN.test(q.kind)) invalid(`kind ${shown(q.kind)} is not a kind`);
    query = query.eq("kind", q.kind);
  }
  if (q.firstSeenAfter !== undefined) query = query.gte("first_seen_at", sinceFilter(q.firstSeenAfter, "firstSeenAfter"));
  if (q.updatedAfter !== undefined) query = query.gte("updated_at", sinceFilter(q.updatedAfter, "updatedAfter"));
  let ordered = query
    .order("priority_score", { ascending: false })
    .order("first_seen_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(q.limit);
  if (opts.signal) ordered = ordered.abortSignal(opts.signal);
  const { data, error } = await ordered;
  if (error) throw failure("read", error, opts.signal);
  return pageRowsFrom(data);
}

/**
 * fingerprint → stored status for these fingerprints (identity columns only;
 * a fingerprint with no row is absent). Throws NonRetryableError on a
 * malformed fingerprint and an Error on a database error.
 */
export async function listAttentionStatusByFingerprints(
  principal: ExecPrincipal,
  fingerprints: readonly string[],
  opts: { signal?: AbortSignal } = {}
): Promise<Map<string, AttentionStatus>> {
  if (!Array.isArray(fingerprints)) invalid("listAttentionStatusByFingerprints needs a list of fingerprints");
  const unique = [...new Set(fingerprints)];
  for (const fp of unique) {
    if (!isCleanId(fp, MAX_FINGERPRINT) || !FINGERPRINT_CHARS.test(fp)) invalid(`fingerprint ${shown(fp)} is malformed`);
  }
  const out = new Map<string, AttentionStatus>();
  for (const chunk of urlListChunks(unique)) {
    opts.signal?.throwIfAborted();
    // At most WRITE_CHUNK fingerprints, each unique per principal: one page.
    let query = getSupabaseAdmin().from(TABLE).select("fingerprint,status").eq("principal_id", principal.id).in("fingerprint", chunk).order("fingerprint");
    if (opts.signal) query = query.abortSignal(opts.signal);
    const { data, error } = await query;
    if (error) throw failure("read", error, opts.signal);
    if (!Array.isArray(data)) throw new Error(`${TABLE} read failed: no rows array in the response`);
    for (const row of data as unknown[]) {
      if (!isRecord(row) || typeof row.fingerprint !== "string") throw new Error(`${TABLE} read failed: malformed row`);
      out.set(row.fingerprint, oneOf<AttentionStatus>(STATUSES, row.status, "status"));
    }
  }
  return out;
}

/** The raw item by id (no screen), with its raw version and first_seen_at, or null. A malformed id is null without a read. */
export async function getAttentionItemRow(
  principal: ExecPrincipal,
  itemId: string,
  opts: { signal?: AbortSignal } = {}
): Promise<AttentionPageRow | null> {
  if (typeof itemId !== "string" || !ATTENTION_ITEM_ID.test(itemId)) return null;
  opts.signal?.throwIfAborted();
  let query = getSupabaseAdmin().from(TABLE).select(ITEM_COLUMNS).eq("principal_id", principal.id).eq("id", itemId).limit(1);
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { data, error } = await query;
  if (error) throw failure("read", error, opts.signal);
  return pageRowsFrom(data)[0] ?? null;
}

/** An item's identity (no content): what feedback records about it. */
export interface AttentionItemIdentity {
  id: string;
  fingerprint: string;
  source: AttentionSource;
  kind: string;
}

/** The item's identity columns by id, or null (a malformed id is null without a read). Throws on a database error. */
export async function getAttentionItemIdentity(
  principal: ExecPrincipal,
  itemId: string,
  opts: { signal?: AbortSignal } = {}
): Promise<AttentionItemIdentity | null> {
  if (typeof itemId !== "string" || !ATTENTION_ITEM_ID.test(itemId)) return null;
  opts.signal?.throwIfAborted();
  let query = getSupabaseAdmin().from(TABLE).select("id,fingerprint,source,kind").eq("principal_id", principal.id).eq("id", itemId).limit(1);
  if (opts.signal) query = query.abortSignal(opts.signal);
  const { data, error } = await query;
  if (error) throw failure("read", error, opts.signal);
  if (!Array.isArray(data)) throw new Error(`${TABLE} read failed: no rows array in the response`);
  const row: unknown = data[0];
  if (row === undefined) return null;
  if (!isRecord(row) || row.id !== itemId || typeof row.fingerprint !== "string" || typeof row.kind !== "string" || !KIND_PATTERN.test(row.kind)) {
    throw new Error(`${TABLE} read failed: malformed row`);
  }
  return { id: row.id, fingerprint: row.fingerprint, source: oneOf<AttentionSource>(SOURCES, row.source, "source"), kind: row.kind };
}

/** The status he sees at `now` (a snoozed item whose snooze has run out is open, with no snooze shown). Pure. */
export function effectiveAttentionItem<T extends AttentionItem>(item: T, now: Date): T {
  return effective(item, validNow(now).getTime()) as T;
}

// --- The owner-action writer (A1, C2, K2) -------------------------------------------

export type OwnerActionResult =
  | { outcome: "applied"; row: AttentionPageRow }
  | { outcome: "unchanged"; row: AttentionPageRow }
  | { outcome: "conflict"; row: AttentionPageRow }
  | { outcome: "invalid_transition"; row: AttentionPageRow }
  | { outcome: "not_found" };

/** Where a row stands for an owner action: its effective status, with resolved split by who resolved it. */
export type OwnerActionState = "open" | "seen" | "snoozed" | "dismissed" | "resolved_owner" | "resolved_auto";
type TransitionVerdict = "write" | "noop" | "invalid";

const OWNER_ACTIONS: ReadonlySet<string> = new Set<OwnerAction>(["seen", "snooze", "dismiss", "resolve", "reopen"]);

/** §3.3.2's table: action × effective state → write, no-op or invalid. */
export const OWNER_ACTION_TRANSITIONS: Readonly<Record<OwnerAction, Readonly<Record<OwnerActionState, TransitionVerdict>>>> = {
  seen: { open: "write", seen: "noop", snoozed: "invalid", dismissed: "invalid", resolved_owner: "invalid", resolved_auto: "invalid" },
  snooze: { open: "write", seen: "write", snoozed: "write", dismissed: "invalid", resolved_owner: "invalid", resolved_auto: "invalid" },
  dismiss: { open: "write", seen: "write", snoozed: "write", dismissed: "noop", resolved_owner: "invalid", resolved_auto: "invalid" },
  resolve: { open: "write", seen: "write", snoozed: "write", dismissed: "write", resolved_owner: "noop", resolved_auto: "write" },
  // An auto-resolved row isn't his to reopen: the producers reopen it whenever the situation returns (C2).
  reopen: { open: "noop", seen: "write", snoozed: "write", dismissed: "write", resolved_owner: "write", resolved_auto: "invalid" }
};

/** The row's state for an owner action at `now` (a run-out snooze is open). Pure. */
export function ownerActionState(item: AttentionItem, now: Date): OwnerActionState {
  const e = effective(item, validNow(now).getTime());
  if (e.status === "resolved") return e.resolution === "owner" ? "resolved_owner" : "resolved_auto";
  return e.status;
}

/**
 * The columns an owner action writes. Every one sets updated_at (the
 * producers' compare-and-set reads it) and none sets last_seen_at, `seen`
 * included: that column is when a producer last saw the situation (K2,
 * applyPlan's comment, lastAttentionRefresh). Each satisfies the table's
 * status / snooze_until / resolution CHECKs.
 */
export function ownerActionPatch(action: OwnerAction, nowIso: string, snoozeUntil: string | null): Record<string, unknown> {
  switch (action) {
    case "seen":
      return { status: "seen", snooze_until: null, updated_at: nowIso };
    case "snooze":
      if (snoozeUntil === null) invalid("a snooze needs snoozeUntil");
      return { status: "snoozed", snooze_until: snoozeUntil, updated_at: nowIso };
    case "dismiss":
      return { status: "dismissed", snooze_until: null, updated_at: nowIso };
    case "resolve":
      return { status: "resolved", resolution: "owner", resolved_at: nowIso, snooze_until: null, updated_at: nowIso };
    case "reopen":
      return { status: "open", snooze_until: null, resolution: null, resolved_at: null, updated_at: nowIso };
    default:
      return invalid(`unknown owner action ${shown(action)}`);
  }
}

/** C4: a snooze ends more than 60 s from now and no more than 90 days out. Returns it as ISO, or throws NonRetryableError. */
export function checkSnoozeUntil(snoozeUntil: unknown, now: Date): string {
  if (typeof snoozeUntil !== "string" || snoozeUntil.length > MAX_VERSION || !isFeedTimestamp(snoozeUntil)) invalid("snoozeUntil must be a timestamp");
  const until = Date.parse(snoozeUntil);
  const nowMs = validNow(now).getTime();
  if (!(until > nowMs + SNOOZE_MIN_AHEAD_MS) || until > nowMs + SNOOZE_MAX_AHEAD_MS) invalid("snoozeUntil must be more than a minute and at most 90 days ahead");
  return new Date(until).toISOString();
}

/**
 * A1: one owner action on one item, as a compare-and-set on the row's exact
 * updated_at (C3) and the status it was read with.
 *   1. read the row; none → not_found;
 *   2. its raw updated_at ≠ expectedUpdatedAt → conflict (with the row);
 *   3. the transition table on the effective state → unchanged (no write) or
 *      invalid_transition (no write);
 *   4. the patch, fenced on principal, id, updated_at = expectedUpdatedAt and
 *      the stored status: one row → applied (with it); none → re-read →
 *      conflict, or not_found when the row is gone.
 * The producers' content and reopen updates fence on status + updated_at too
 * (applyPlan), so his action wins a race with a sync, and a sync's change
 * since his read makes him retry (409). Bad input (an unknown action, a
 * malformed version, a snooze end outside C4) throws NonRetryableError: the
 * routes validate first, so it never comes from HTTP.
 */
export async function applyOwnerAction(
  principal: ExecPrincipal,
  itemId: string,
  action: OwnerAction,
  opts: { snoozeUntil?: string; expectedUpdatedAt: string; now?: Date; signal?: AbortSignal }
): Promise<OwnerActionResult> {
  if (!isRecord(opts)) invalid("applyOwnerAction needs options");
  const now = validNow(opts.now ?? new Date());
  if (typeof action !== "string" || !OWNER_ACTIONS.has(action)) invalid(`unknown owner action ${shown(action)}`);
  const expected = opts.expectedUpdatedAt;
  if (typeof expected !== "string" || expected.length > MAX_VERSION || !isFeedTimestamp(expected)) invalid("expectedUpdatedAt must be a timestamp");
  let snoozeUntil: string | null = null;
  if (action === "snooze") snoozeUntil = checkSnoozeUntil(opts.snoozeUntil, now);
  else if (opts.snoozeUntil !== undefined) invalid("snoozeUntil goes with snooze only");
  if (typeof itemId !== "string" || !ATTENTION_ITEM_ID.test(itemId)) return { outcome: "not_found" };

  const signal = opts.signal;
  const row = await getAttentionItemRow(principal, itemId, { signal });
  if (row === null) return { outcome: "not_found" };
  if (row.version !== expected) return { outcome: "conflict", row };
  const verdict = OWNER_ACTION_TRANSITIONS[action][ownerActionState(row.item, now)];
  if (verdict === "invalid") return { outcome: "invalid_transition", row };
  if (verdict === "noop") return { outcome: "unchanged", row };

  signal?.throwIfAborted();
  let query = getSupabaseAdmin()
    .from(TABLE)
    .update(ownerActionPatch(action, now.toISOString(), snoozeUntil))
    .eq("principal_id", principal.id)
    .eq("id", itemId)
    .eq("updated_at", expected)
    .eq("status", row.item.status)
    .select(ITEM_COLUMNS);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw failure("update", error, signal);
  const written = pageRowsFrom(data);
  if (written.length === 1) {
    console.log(`[exec-attention] ${action} applied to ${itemId} for ${principal.id}`);
    return { outcome: "applied", row: written[0] };
  }
  if (written.length > 1) throw new Error(`${TABLE} update failed: ${written.length} rows matched one id`);
  // The fence stopped it: someone (a sync, another tab) changed the row since the read.
  const current = await getAttentionItemRow(principal, itemId, { signal });
  return current === null ? { outcome: "not_found" } : { outcome: "conflict", row: current };
}
