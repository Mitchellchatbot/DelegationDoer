import "server-only";

import { createHash } from "node:crypto";
import { GENERIC_EMAIL_DOMAINS } from "@/lib/calendar-client-match";
import { sanitizeForAudit } from "@/lib/exec/audit";
import {
  CLONE_GRAPH_ID_RE,
  CloneEaError,
  decodeTokenClaims,
  parseCloneAuthMe,
  parseCloneDeleted,
  parseCloneDraftRead,
  parseCloneReadBack,
  parseCloneStatus,
  type CloneDeleted,
  type CloneDraftRead,
  type CloneEaRoute,
  type CloneReadBack
} from "@/lib/exec/clone-ea-types";
import { listDraftArtifacts } from "@/lib/exec/drafts-store";
import type { DraftAddress, DraftKind, EaReadinessReason, SentCopyResult } from "@/lib/exec/drafts-types";
import {
  SCREEN_HASH_LIMIT,
  type AnsweredState,
  type ExecEmailSignal,
  type ExecEmailThread,
  type HisAttachment,
  type HisMessage,
  type MessageDirection,
  type MessageMeta,
  type OutlookImportance,
  type ParsedAddress,
  type PrincipalMailThread,
  type ReadThreadResult,
  type ReplyArtifacts,
  type ScreenVerdict,
  type StoredAnsweredState,
  type ThreadScreenRow,
  type ThreadSnapshot
} from "@/lib/exec/email-types";
import { notifyOps } from "@/lib/exec/ops";
import { countEnabledMailPinnedPrincipals } from "@/lib/exec/principal";
import { CLONE_EA_PATHS, cloneEaBaseUrl, cloneEaFetch, type CloneEaCall, type CloneEaResponse } from "@/lib/exec/sources/clone-ea";
import { getSyncState, parseEaTokenState, putSyncState, type EaTokenState, type MailAccountProblem, type MailAccountStatus } from "@/lib/exec/sync-state";
import { NonRetryableError, type ExecPrincipal, type RestrictedPolicy } from "@/lib/exec/types";
import { cidPattern } from "@/lib/inline-cid";
import {
  fetchMessageBody,
  getThread,
  listAccountsFresh,
  listMessagesFeed,
  listThreadsPaged,
  MissiveHttpError,
  toStringArray,
  type MissiveFeedMessage,
  type MissiveMessage,
  type MissiveThreadDetail
} from "@/lib/missive-client";
import {
  addressDomain,
  messagesMatch,
  normalizeAddresses,
  ruleFromRow,
  threadMatches,
  type MessageLike,
  type RestrictedRuleRow,
  type RestrictedSenderRule
} from "@/lib/restricted-senders";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// The assistant's only door to mail (contract §3.5, L2, L3, L11, L17, A2).
//
// No clone read is scoped to a mailbox on its own: getThread and the body and
// attachment reads take bare ids and return every account's data, and a thread
// can hold mail from several of the team's 31 mailboxes. So every function
// here takes the principal and enforces his pin (exec_principals.mail_account_ids):
//   - reads of his mail keep only messages whose account_id is pinned (and
//     usable); anything else is metadata for screening, never content;
//   - an account id or message id from outside the pin is a MailScopeError,
//     a programming error that kills the job rather than retrying it;
//   - an empty pin refuses everything.
// boundary.test.ts makes this the only exec module that imports missive-client.
//
// Restricted senders (L2, L11, A1, A2). DD's own matchers decide; this module
// adds a strict rule loader (DD's fails open, the assistant must fail closed),
// one-way screening hashes that are stored instead of addresses, and
// screenStoredRow, the screen every consumer of stored rows runs.
//
// Every clone call carries a timeout combined with the caller's signal
// (withTimeout below). Clone HTTP errors come back as CloneHttpError, which
// keeps the status (so the job runner classifies 401/403/404/5xx correctly)
// but not the response text, which can echo request values.
//
// Nothing here logs or returns message content except to its caller: bodies,
// subjects and addresses stay in memory, in the objects handed back.

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A mail read reached outside the principal's pinned accounts. Never retried. */
export class MailScopeError extends NonRetryableError {
  constructor(message: string) {
    super(message, "fatal");
    this.name = "MailScopeError";
  }
}

/**
 * A non-2xx answer from the clone, without the response text. `status` drives
 * the job runner's classification (401/403 auth, 404 fatal, 429/5xx retryable).
 */
export class CloneHttpError extends Error {
  readonly status: number;
  /** The error body was the clone's own JSON (a real "not found", say). */
  readonly jsonBody: boolean;
  readonly retryAfterMs?: number;
  readonly errorClass?: "retryable";
  constructor(operation: string, err: MissiveHttpError) {
    super(`clone ${operation} answered HTTP ${err.status}`);
    this.name = "CloneHttpError";
    this.status = err.status;
    this.jsonBody = err.jsonBody;
    if (err.retryAfterMs !== undefined) this.retryAfterMs = err.retryAfterMs;
    // A 404 that isn't the clone's own JSON is an edge or proxy page (a
    // redeploy, a misrouted URL), not "this thread is gone". Retry it, bounded
    // by the job's attempts, instead of acting on it.
    if (err.status === 404 && !err.jsonBody) this.errorClass = "retryable";
  }
}

/** The restricted-sender rules couldn't be read. Retryable: nothing may be screened as clean meanwhile. */
export class RestrictedRulesError extends Error {
  constructor(table: string, message: string) {
    super(`restricted-sender rules unavailable (${table}): ${message}`);
    this.name = "RestrictedRulesError";
  }
}

/** A DD table read for mail (reply artifacts) failed. Callers show "couldn't load", never zero. */
export class MailReadError extends Error {
  readonly table: string;
  constructor(table: string, message: string) {
    super(`mail read failed (${table}): ${message}`);
    this.name = "MailReadError";
    this.table = table;
  }
}

// ---------------------------------------------------------------------------
// The pin
// ---------------------------------------------------------------------------

/** His pinned clone account ids, deduplicated. Empty means nothing may be read. */
export function pinnedAccounts(principal: ExecPrincipal): readonly string[] {
  return Object.freeze([...new Set(principal.mailAccountIds.filter((id) => typeof id === "string" && id.length > 0))]);
}

export function isPinnedAccount(principal: ExecPrincipal, accountId: string | null | undefined): boolean {
  return typeof accountId === "string" && accountId.length > 0 && principal.mailAccountIds.includes(accountId);
}

/**
 * Pinned accounts minus the problem accounts the last reconcile recorded in
 * mail/accounts (problemAccountIds in sync-state.ts). What a missing accounts
 * state means is the caller's decision; the pin itself was verified when it
 * was set.
 */
export function usableAccounts(principal: ExecPrincipal, problemAccountIds: ReadonlySet<string>): readonly string[] {
  return Object.freeze(pinnedAccounts(principal).filter((id) => !problemAccountIds.has(id)));
}

function requirePin(principal: ExecPrincipal, operation: string): readonly string[] {
  const pinned = pinnedAccounts(principal);
  if (pinned.length === 0) throw new MailScopeError(`${operation}: principal ${principal.id} has no pinned mail account`);
  return pinned;
}

function requirePinnedAccount(principal: ExecPrincipal, accountId: string, operation: string): void {
  requirePin(principal, operation);
  if (!isPinnedAccount(principal, accountId)) {
    throw new MailScopeError(`${operation}: account ${String(accountId)} is not pinned for principal ${principal.id}`);
  }
}

/** The accounts a read may treat as his: `usable` when given (it must sit inside the pin), else the pin. */
function allowedAccounts(principal: ExecPrincipal, usable: readonly string[] | undefined, operation: string): ReadonlySet<string> {
  const pinned = requirePin(principal, operation);
  if (usable === undefined) return new Set(pinned);
  for (const id of usable) {
    if (!isPinnedAccount(principal, id)) {
      throw new MailScopeError(`${operation}: usable account ${String(id)} is not pinned for principal ${principal.id}`);
    }
  }
  return new Set(usable);
}

// ---------------------------------------------------------------------------
// Clone calls: a timeout combined with the caller's signal
// ---------------------------------------------------------------------------

export interface CloneCallOptions {
  signal?: AbortSignal;
  /** Per call. Default 30 s (the job budget); pages pass 15 s. */
  timeoutMs?: number;
}

const DEFAULT_CLONE_TIMEOUT_MS = 30_000;

/**
 * A signal that aborts when `signal` does or after `timeoutMs`, whichever is
 * first. Built by hand rather than with AbortSignal.any, and `done()` removes
 * the listener and the timer, so a long-lived job signal doesn't collect one
 * listener per clone call.
 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): { signal: AbortSignal; done: () => void } {
  const ms = timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
  if (!Number.isFinite(ms) || ms <= 0) throw new NonRetryableError(`clone call timeout must be a positive number of ms (got ${ms})`);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    // Named TimeoutError so the job runner retries it like any other timeout.
    const err = new Error(`clone call timed out after ${ms} ms`);
    err.name = "TimeoutError";
    controller.abort(err);
  }, ms);
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

async function cloneCall<T>(operation: string, opts: CloneCallOptions, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timed = withTimeout(opts.signal, opts.timeoutMs);
  try {
    return await call(timed.signal);
  } catch (err) {
    throw err instanceof MissiveHttpError ? new CloneHttpError(operation, err) : err;
  } finally {
    timed.done();
  }
}

const isCloneNotFound = (err: unknown): boolean => err instanceof CloneHttpError && err.status === 404 && err.jsonBody;

/** At most `limit` of `fn` running at once; the first failure stops new work and rejects. */
async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next];
      next += 1;
      try {
        await fn(item);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---------------------------------------------------------------------------
// Clone times
// ---------------------------------------------------------------------------

// Date's own range: ±8.64e15 ms. Anything past it would make toISOString throw.
const MAX_DATE_MS = 8.64e15;

/**
 * A clone time as epoch ms. The clone stores BIGINT epoch-ms, which pg hands
 * over as a digit string; some fields arrive as numbers or ISO strings
 * (timestamptz, or already normalized). null when it is none of these.
 */
export function cloneTimeToMs(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && Math.abs(v) <= MAX_DATE_MS ? Math.trunc(v) : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^\d{1,16}$/.test(s)) {
    const n = Number(s);
    return n <= MAX_DATE_MS ? n : null;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** cloneTimeToMs as an ISO string ("…Z"), or null. */
export function cloneTimeToIso(v: unknown): string | null {
  const ms = cloneTimeToMs(v);
  return ms === null ? null : new Date(ms).toISOString();
}

const isoMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

// ---------------------------------------------------------------------------
// Addresses (display): "Name <a@x>" lists, quote- and bracket-aware
// ---------------------------------------------------------------------------

const MAX_NAME_CHARS = 200;
const EMAIL_SHAPE = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+$/;

/**
 * Display names come from senders, so they are cleaned before anyone shows
 * them: control characters, zero-width and bidi-override characters (which
 * can make a name read differently from what it is) become spaces, runs of
 * whitespace collapse, and the result is clipped.
 */
function cleanName(raw: string): string | null {
  let out = "";
  for (const ch of raw) {
    const c = ch.codePointAt(0) as number;
    const invisible =
      c < 0x20 ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x2028 && c <= 0x202e) ||
      (c >= 0x2060 && c <= 0x2069) ||
      c === 0xfeff;
    out += invisible ? " " : ch;
  }
  let name = out.replace(/\s+/g, " ").trim();
  // A fully quoted name: drop the quotes and unescape \" and \\.
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\(["\\])/g, "$1").trim();
  name = name.replace(/^['"]+|['"]+$/g, "").trim();
  if (!name) return null;
  return name.length > MAX_NAME_CHARS ? name.slice(0, MAX_NAME_CHARS) : name;
}

/**
 * Split on "," and ";" that sit outside double quotes, <angle brackets> and
 * (comments). With `quotes` false, a quote is an ordinary character: the
 * fallback for a string whose quotes don't balance.
 */
function splitTopLevel(s: string, quotes: boolean): { parts: string[]; balanced: boolean } {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inQuote) {
      current += ch;
      if (ch === "\\" && i + 1 < s.length) {
        current += s[i + 1];
        i += 1;
      } else if (ch === '"') {
        inQuote = false;
      }
      continue;
    }
    if (ch === '"' && quotes) inQuote = true;
    else if (ch === "<") angle += 1;
    else if (ch === ">" && angle > 0) angle -= 1;
    else if (ch === "(") paren += 1;
    else if (ch === ")" && paren > 0) paren -= 1;
    else if ((ch === "," || ch === ";") && angle === 0 && paren === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return { parts, balanced: !inQuote };
}

/** The last <…> outside quotes: [start, end] of the brackets, or null. */
function angleAddress(s: string): [number, number] | null {
  let inQuote = false;
  let found: [number, number] | null = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inQuote) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') inQuote = true;
    else if (ch === "<") {
      const close = s.indexOf(">", i + 1);
      if (close === -1) break;
      found = [i, close];
      i = close;
    }
  }
  return found;
}

/** One address token → { name, email }, or null when it holds no usable address. */
function parseOneAddress(token: string): ParsedAddress | null {
  const s = token.trim();
  if (!s.includes("@")) return null;
  let email: string;
  let name: string | null;
  const angle = angleAddress(s) ?? (/<[^>]*>/.test(s) ? angleAddress(s.replace(/"/g, " ")) : null);
  if (angle) {
    email = s.slice(angle[0] + 1, angle[1]);
    name = cleanName(s.slice(0, angle[0]) + " " + s.slice(angle[1] + 1));
  } else {
    // No brackets: the address is the last whitespace-separated word holding
    // an "@" (stray punctuation trimmed); anything else is the name.
    const words = s.split(/\s+/);
    let at = -1;
    for (let i = words.length - 1; i >= 0; i -= 1) {
      if (words[i].includes("@")) {
        at = i;
        break;
      }
    }
    if (at === -1) return null;
    email = words[at].replace(/^["'(]+|["'),;:.]+$/g, "");
    name = cleanName(words.filter((_, i) => i !== at).join(" "));
  }
  email = email.trim().toLowerCase();
  if (email.startsWith("mailto:")) email = email.slice("mailto:".length);
  if (!EMAIL_SHAPE.test(email)) return null;
  return { name: name && name.toLowerCase() !== email ? name : null, email };
}

/**
 * An address list → parsed addresses, in order.
 *
 * The clone's to/cc arrive pre-split by missive-client's toStringArray, which
 * cuts on every "," and ";", quotes or not: `"Doe, Jane" <j@x>` becomes
 * ['"Doe', 'Jane" <j@x>'], and Graph's unquoted `Doe, Jane <j@x>` becomes
 * ['Doe', 'Jane <j@x>']. So an array is re-joined with ", " (restoring the
 * separator it cut) and parsed again aware of quotes, <brackets> and
 * (comments). A fragment with no "@" is a piece of the next address's display
 * name and merges forward into it; a trailing one is dropped.
 */
export function parseAddressList(raw: unknown): ParsedAddress[] {
  const joined = Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === "string").join(", ")
    : typeof raw === "string"
      ? raw
      : "";
  if (!joined.trim()) return [];
  let split = splitTopLevel(joined, true);
  if (!split.balanced) split = splitTopLevel(joined, false);

  const out: ParsedAddress[] = [];
  let pending: string[] = [];
  for (const part of split.parts) {
    const token = part.trim();
    if (!token) continue;
    const parsed = parseOneAddress(token);
    if (parsed) {
      if (pending.length > 0) {
        out.push({ name: cleanName([...pending, parsed.name ?? ""].filter(Boolean).join(", ")), email: parsed.email });
        pending = [];
      } else {
        out.push(parsed);
      }
    } else if (!token.includes("@")) {
      pending.push(token);
    } else {
      // An "@" that isn't an address: neither an address nor part of a name.
      pending = [];
    }
  }
  return out;
}

/** The first address of `raw` (a From field), or null. */
export function parseAddress(raw: unknown): ParsedAddress | null {
  return parseAddressList(raw)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Restricted senders: the strict loader, the screens, the policy hash
// ---------------------------------------------------------------------------

const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
const IN_CHUNK = 200;

function from(table: string, columns: string, options?: { count: "exact"; head: true }) {
  return getSupabaseAdmin().from(table).select(columns, options);
}
type Query = ReturnType<typeof from>;

/** Every row of a query, in pages ordered by unique columns. Throws `fail(…)` on any error. */
async function pageAll<Row>(
  table: string,
  build: () => Query,
  orderBy: readonly string[],
  signal: AbortSignal | undefined,
  fail: (table: string, message: string) => Error
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let query = build();
    for (const column of orderBy) query = query.order(column, { ascending: true });
    query = query.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw fail(table, error.message);
    if (!Array.isArray(data)) throw fail(table, "the response carried no rows");
    for (const row of data) rows.push(row as Row);
    if (data.length < PAGE_SIZE) return rows;
  }
  throw fail(table, `too many rows (more than ${MAX_PAGES * PAGE_SIZE})`);
}

function chunks<T>(items: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const rulesFail = (table: string, message: string) => new RestrictedRulesError(table, message);

/**
 * Every enabled restricted-sender rule with its viewers, mapped exactly as
 * DD's fetchRules maps them (ruleFromRow: pattern trimmed and lowercased, a
 * non-"exact" kind is "domain"). Unlike fetchRules it THROWS on any error or
 * malformed row instead of returning [] ("nothing is restricted"), so a failed
 * read can never screen mail as clean.
 */
export async function loadRestrictedRulesStrict(opts: { signal?: AbortSignal } = {}): Promise<RestrictedSenderRule[]> {
  const rows = await pageAll<Record<string, unknown>>(
    "restricted_senders",
    () => from("restricted_senders", "id, pattern, match_kind, label").eq("enabled", true),
    ["id"],
    opts.signal,
    rulesFail
  );
  const ruleRows: RestrictedRuleRow[] = rows.map((r) => {
    if (typeof r.id !== "string" || !r.id || typeof r.pattern !== "string" || typeof r.match_kind !== "string") {
      throw new RestrictedRulesError("restricted_senders", "a rule row is malformed");
    }
    return { id: r.id, pattern: r.pattern, match_kind: r.match_kind, label: typeof r.label === "string" ? r.label : "" };
  });
  if (ruleRows.length === 0) return [];

  const viewers = new Map<string, Set<string>>();
  for (const chunk of chunks(ruleRows.map((r) => r.id))) {
    const viewerRows = await pageAll<Record<string, unknown>>(
      "restricted_sender_viewers",
      () => from("restricted_sender_viewers", "rule_id, user_id").in("rule_id", chunk),
      ["rule_id", "user_id"],
      opts.signal,
      rulesFail
    );
    for (const v of viewerRows) {
      if (typeof v.rule_id !== "string" || typeof v.user_id !== "string") {
        throw new RestrictedRulesError("restricted_sender_viewers", "a viewer row is malformed");
      }
      let set = viewers.get(v.rule_id);
      if (!set) viewers.set(v.rule_id, (set = new Set<string>()));
      set.add(v.user_id);
    }
  }
  return ruleRows.map((r) => ruleFromRow(r, viewers.get(r.id) ?? new Set<string>()));
}

/** The rules that apply to him: those he isn't a viewer on (as restrictionsFor drops them). */
export function applicableRules(rules: readonly RestrictedSenderRule[], principal: ExecPrincipal): RestrictedSenderRule[] {
  return rules.filter((r) => !r.viewerUserIds.has(principal.userId));
}

/**
 * The hash of the screening policy: what decides "restricted" for him. P3
 * builds no dd_only mode (L31), so every policy hashes as "hidden" and the
 * hash moves only when the applicable rules' (kind, pattern) set moves. It is
 * what rows are stamped with (screened_policy_hash) and what the attention
 * pass compares to find rows screened under older rules.
 */
export function restrictedPolicyHash(policy: RestrictedPolicy, rules: readonly RestrictedSenderRule[]): string {
  void policy; // every policy screens as "hidden" in P3 (L31)
  const entries = [...new Set(rules.map((r) => `${r.matchKind === "exact" ? "exact" : "domain"}:${r.pattern}`))].sort();
  return createHash("sha256").update(JSON.stringify({ v: "screen-v1", policy: "hidden", rules: entries }), "utf8").digest("hex");
}

/**
 * The applicable rules and the current policy hash H, loaded strictly. What
 * every writer, the attention pass and every page screens with (A1, A2).
 */
export async function loadScreeningPolicy(
  principal: ExecPrincipal,
  opts: { signal?: AbortSignal } = {}
): Promise<{ rules: RestrictedSenderRule[]; hash: string }> {
  const rules = applicableRules(await loadRestrictedRulesStrict(opts), principal);
  return { rules, hash: restrictedPolicyHash("hidden", rules) };
}

/** What a screen needs from a message: the raw address fields as missive-client returns them. */
export type ScreenableMessage = Pick<MessageMeta, "from" | "to" | "cc">;

export interface ScreenInput {
  all: readonly ScreenableMessage[];
  participants: readonly string[];
}

export interface ScreenResult {
  verdict: ScreenVerdict;
  /** Every applicable rule that matched (ids only, for logs and tests). */
  ruleIds: string[];
}

// Never spread a list field: a string spread explodes into characters, none
// with an "@" (restricted-senders' asList, mirrored).
function fieldList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") return [v];
  return [];
}

const asMessageLike = (m: ScreenableMessage): MessageLike => ({
  from_addr: typeof m.from === "string" ? m.from : "",
  to_addrs: fieldList(m.to),
  cc_addrs: fieldList(m.cc)
});

/**
 * The live screen (L2): DD's own messagesMatch over the from/to/cc of every
 * message of the clone thread, any account, or DD's threadMatches over the
 * thread's participants.
 */
export function screenRestricted(t: ScreenInput, rules: readonly RestrictedSenderRule[]): ScreenResult {
  const list = [...rules];
  const msgs = t.all.map(asMessageLike);
  const thread = { participants: fieldList(t.participants) };
  const hit = messagesMatch(msgs, list) ?? threadMatches(thread, list);
  if (!hit) return { verdict: "clean", ruleIds: [] };
  const ruleIds = list.filter((r) => messagesMatch(msgs, [r]) !== null || threadMatches(thread, [r]) !== null).map((r) => r.id);
  return { verdict: "restricted", ruleIds };
}

const sha32 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32);

/**
 * The stored stand-in for the thread's addresses (L11): for every address
 * restricted-senders would extract (normalizeAddresses over from/to/cc of
 * every message and over the participants), sha256("a:"+address) and
 * sha256("d:"+suffix) for its domain (addressDomain) and every suffix after a
 * ".", first 32 hex. A domain rule matches exactly when "d:"+pattern is in the
 * set, an exact rule when "a:"+pattern is, so screenByHashes ≡ addressMatches
 * without keeping a single address. Sorted; beyond SCREEN_HASH_LIMIT the first
 * 600 are kept and `truncated` is set (the row then fails closed whenever the
 * policy moves).
 */
export function screenHashesFor(t: ScreenInput): { hashes: string[]; truncated: boolean } {
  const emails = new Set<string>();
  const add = (field: string | null | undefined) => {
    for (const email of normalizeAddresses(field)) emails.add(email);
  };
  for (const m of t.all) {
    add(typeof m.from === "string" ? m.from : null);
    for (const x of fieldList(m.to)) add(x);
    for (const x of fieldList(m.cc)) add(x);
  }
  for (const p of fieldList(t.participants)) add(p);

  const hashes = new Set<string>();
  for (const email of emails) {
    hashes.add(sha32(`a:${email}`));
    const domain = addressDomain(email);
    hashes.add(sha32(`d:${domain}`));
    for (let dot = domain.indexOf("."); dot !== -1; dot = domain.indexOf(".", dot + 1)) hashes.add(sha32(`d:${domain.slice(dot + 1)}`));
  }
  const sorted = [...hashes].sort();
  return sorted.length > SCREEN_HASH_LIMIT
    ? { hashes: sorted.slice(0, SCREEN_HASH_LIMIT), truncated: true }
    : { hashes: sorted, truncated: false };
}

/** Screen stored hashes against the rules (see screenHashesFor). */
export function screenByHashes(hashes: readonly string[], rules: readonly RestrictedSenderRule[]): ScreenResult {
  const set = new Set(hashes);
  const ruleIds = rules
    .filter((r) => set.has(sha32(r.matchKind === "exact" ? `a:${r.pattern}` : `d:${r.pattern}`)))
    .map((r) => r.id);
  return { verdict: ruleIds.length > 0 ? "restricted" : "clean", ruleIds };
}

export type StoredScreenReason = "tombstone" | "rule_match" | "stale_truncated" | "unscreenable";

/**
 * The screen every consumer of a stored thread row runs before using it
 * (A2): the Email list and counts, the commitments card, the thread page's
 * fallback, the Overview, the producers. Restricted when the row is a
 * tombstone, when its stored hashes match a current rule, or when its hash
 * set was truncated and it was last screened under another policy (the
 * missing hashes might match a new rule). A row whose hashes can't be read
 * is restricted too. `currentPolicyHash` is restrictedPolicyHash of the rules
 * just loaded (loadScreeningPolicy). A "gone" row is screened like a live one.
 */
export function screenStoredRow(
  row: Pick<ThreadScreenRow, "state" | "screenHashes" | "screenTruncated" | "screenedPolicyHash">,
  rules: readonly RestrictedSenderRule[],
  currentPolicyHash: string
): ScreenResult & { reason: StoredScreenReason | null } {
  if (row.state === "restricted_hidden") return { verdict: "restricted", ruleIds: [], reason: "tombstone" };
  if (!Array.isArray(row.screenHashes)) return { verdict: "restricted", ruleIds: [], reason: "unscreenable" };
  const byHash = screenByHashes(row.screenHashes, rules);
  if (byHash.verdict === "restricted") return { ...byHash, reason: "rule_match" };
  // Anything but an explicit false counts as truncated: fail closed.
  if (row.screenTruncated !== false && row.screenedPolicyHash !== currentPolicyHash) {
    return { verdict: "restricted", ruleIds: [], reason: "stale_truncated" };
  }
  return { verdict: "clean", ruleIds: [], reason: null };
}

// ---------------------------------------------------------------------------
// Reading his thread
// ---------------------------------------------------------------------------

const JUNK_FOLDER = /spam|junk/i;
const MAX_THREAD_ID_CHARS = 200;

function checkThreadId(threadId: unknown, operation: string): asserts threadId is string {
  if (typeof threadId !== "string" || threadId.length === 0 || threadId.length > MAX_THREAD_ID_CHARS || /[\x00-\x1f\x7f]/.test(threadId)) {
    throw new NonRetryableError(`${operation}: the thread id is malformed`);
  }
}

/** An RFC Message-ID as stored (trimmed), or null. Dedupe and identity compare these exactly. */
function rfcId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

/** An RFC id for matching a reply to its parent: brackets and case don't matter. */
function rfcKey(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim().replace(/^<+|>+$/g, "").trim().toLowerCase();
  return s ? s : null;
}

function directionOf(v: unknown): MessageDirection | null {
  return v === "inbound" || v === "outbound" ? v : null;
}

// Content ids of each of his messages' attachments, in order, so `inline` can
// be worked out again once a deferred body arrives (loadHisBodies). Kept off
// the HisAttachment shape on purpose.
const contentIds = new WeakMap<HisMessage, (string | null)[]>();

// A content id is not an inline signal on its own (Outlook stamps one on
// ordinary PDFs); the body has to reference cid:<id>.
function isInline(contentId: string | null, bodyHtml: string | null): boolean {
  return contentId !== null && bodyHtml !== null && cidPattern(contentId).test(bodyHtml);
}

function hisMessageOf(m: MissiveMessage, threadId: string): HisMessage | null {
  const direction = directionOf(m.direction);
  if (!direction || typeof m.account_id !== "string") return null;
  const folder = typeof m.folder === "string" ? m.folder : "";
  const createdAtMs = cloneTimeToMs(m.created_at);
  const bodyHtml = typeof m.body_html === "string" ? m.body_html : null;
  const rawAttachments = Array.isArray(m.attachments)
    ? m.attachments.filter((a) => typeof a === "object" && a !== null && typeof a.id === "string" && a.id.length > 0)
    : [];
  const ids = rawAttachments.map((a) => (typeof a.content_id === "string" && a.content_id ? a.content_id : null));
  const attachments: HisAttachment[] = rawAttachments.map((a, i) => ({
    id: a.id,
    filename: typeof a.filename === "string" && a.filename ? a.filename : "attachment",
    contentType: typeof a.content_type === "string" && a.content_type ? a.content_type : null,
    size: typeof a.size_bytes === "number" && Number.isFinite(a.size_bytes) ? a.size_bytes : null,
    inline: isInline(ids[i], bodyHtml)
  }));
  const message: HisMessage = {
    id: m.id,
    threadId,
    accountId: m.account_id,
    direction,
    folder,
    isJunk: JUNK_FOLDER.test(folder),
    rfcMessageId: rfcId(m.message_id),
    inReplyTo: rfcId(m.in_reply_to),
    subject: typeof m.subject === "string" ? m.subject : "",
    from: parseAddress(m.from_addr),
    to: parseAddressList(m.to_addrs),
    cc: parseAddressList(m.cc_addrs),
    // normalizeMessage made sent_at ISO, or "" when the clone sent nothing usable.
    sentAt: m.sent_at || (createdAtMs !== null ? new Date(createdAtMs).toISOString() : new Date(0).toISOString()),
    createdAtMs,
    // L3: the clone's INTEGER 0/1 (a boolean from some builds).
    isAutomated: Boolean(Number(m.is_automated)),
    attachments,
    bodyDeferred: m.body_deferred === true,
    bodyHtml,
    bodyText: typeof m.body_text === "string" ? m.body_text : null
  };
  contentIds.set(message, ids);
  return message;
}

function metaOf(m: MissiveMessage): MessageMeta {
  return {
    id: m.id,
    accountId: typeof m.account_id === "string" && m.account_id ? m.account_id : null,
    direction: m.direction === "outbound" ? "outbound" : "inbound",
    // Raw, exactly as normalizeMessage returns them: the screen must see what
    // DD's messagesMatch sees.
    from: typeof m.from_addr === "string" ? m.from_addr : "",
    to: fieldList(m.to_addrs),
    cc: fieldList(m.cc_addrs),
    rfcMessageId: rfcId(m.message_id),
    inReplyTo: rfcId(m.in_reply_to),
    createdAtMs: cloneTimeToMs(m.created_at),
    sentAt: m.sent_at ? m.sent_at : null
  };
}

const sentMs = (m: Pick<HisMessage, "sentAt" | "createdAtMs">): number => isoMs(m.sentAt) ?? m.createdAtMs ?? 0;

function byTime(a: HisMessage, b: HisMessage): number {
  return sentMs(a) - sentMs(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** One copy per (rfc id, direction), the lowest clone id; messages without an rfc id are all kept. */
function dedupeHis(messages: readonly HisMessage[]): HisMessage[] {
  const kept = new Map<string, HisMessage>();
  const loose: HisMessage[] = [];
  for (const m of messages) {
    if (!m.rfcMessageId) {
      loose.push(m);
      continue;
    }
    const key = JSON.stringify([m.rfcMessageId, m.direction]);
    const prev = kept.get(key);
    if (!prev || m.id < prev.id) kept.set(key, m);
  }
  return [...kept.values(), ...loose].sort(byTime);
}

/** The snapshot behind a read (A4): over EVERY message of the clone thread, any account. */
function snapshotOf(all: readonly MessageMeta[], readStartedAtMs: number, readDoneAtMs: number): ThreadSnapshot {
  const identities = new Set<string>();
  let maxCreatedAtMs: number | null = null;
  let maxSentAtMs: number | null = null;
  for (const m of all) {
    identities.add(m.rfcMessageId ? JSON.stringify([m.accountId, m.direction, m.rfcMessageId]) : JSON.stringify(["#", m.id]));
    if (m.createdAtMs !== null) maxCreatedAtMs = maxCreatedAtMs === null ? m.createdAtMs : Math.max(maxCreatedAtMs, m.createdAtMs);
    const sent = isoMs(m.sentAt);
    if (sent !== null) maxSentAtMs = maxSentAtMs === null ? sent : Math.max(maxSentAtMs, sent);
  }
  return { identityCount: identities.size, maxCreatedAtMs, maxSentAtMs, readStartedAtMs, readDoneAtMs };
}

export interface ReadThreadOptions extends CloneCallOptions {
  /** The accounts that count as his (pinned minus problem accounts). Default: the whole pin. */
  usable?: readonly string[];
}

/**
 * His view of one clone thread.
 *   - snapshot.readStartedAtMs is the clock just before getThread (deferred
 *     bodies), readDoneAtMs just after it answers; identityCount, the max
 *     created/sent times are over every message of the thread, any account.
 *   - his: messages on an allowed account (`usable`, else the pin), one per
 *     (rfc id, direction) keeping the lowest clone id, rows without an rfc id
 *     kept as they are, Junk flagged, ascending (sentAt, id). Only these carry
 *     subjects and bodies.
 *   - all: every message as metadata (raw address fields), participants: the
 *     thread's, raw. Both are for screening and snapshots only.
 * not_found: the clone's own 404 for the thread. not_his: none of its messages
 * are on an allowed account (always the case when `usable` is empty).
 */
export async function readPrincipalThread(
  principal: ExecPrincipal,
  threadId: string,
  opts: ReadThreadOptions = {}
): Promise<ReadThreadResult> {
  checkThreadId(threadId, "readPrincipalThread");
  const allowed = allowedAccounts(principal, opts.usable, "readPrincipalThread");
  if (allowed.size === 0) return { kind: "not_his" };

  const readStartedAtMs = Date.now();
  let detail: MissiveThreadDetail;
  try {
    detail = await cloneCall("thread read", opts, (signal) => getThread(threadId, { deferBodies: true, signal }));
  } catch (err) {
    // The 404 read is done now: its readDoneAtMs dates the gone proposal (amendments-7(a)).
    if (isCloneNotFound(err)) return { kind: "not_found", readDoneAtMs: Date.now() };
    throw err;
  }
  const readDoneAtMs = Date.now();

  const messages = (Array.isArray(detail.messages) ? detail.messages : []).filter(
    (m): m is MissiveMessage =>
      typeof m === "object" && m !== null && typeof m.id === "string" && m.id.length > 0 && (m.thread_id == null || m.thread_id === threadId)
  );
  const all = messages.map(metaOf);
  const his = dedupeHis(
    messages
      .filter((m) => typeof m.account_id === "string" && allowed.has(m.account_id))
      .map((m) => hisMessageOf(m, threadId))
      .filter((m): m is HisMessage => m !== null)
  );
  if (his.length === 0) return { kind: "not_his" };

  const thread: PrincipalMailThread = {
    threadId,
    participants: fieldList(detail.thread?.participants),
    his,
    all,
    snapshot: snapshotOf(all, readStartedAtMs, readDoneAtMs),
    lastMessageAt: cloneTimeToIso(detail.thread?.last_message_at)
  };
  return { kind: "ok", thread };
}

const BODY_CONCURRENCY = 4;

/**
 * Fill in the bodies of the given messages of `t` (in place). Every id must be
 * one of t.his on a pinned account, checked before anything is fetched, else
 * MailScopeError. Messages that already carry a body are left alone. A body
 * the clone no longer has (its JSON 404) loads as empty. At most 4 at a time,
 * each with its own timeout.
 */
export async function loadHisBodies(
  principal: ExecPrincipal,
  t: PrincipalMailThread,
  messageIds: readonly string[],
  opts: CloneCallOptions = {}
): Promise<void> {
  requirePin(principal, "loadHisBodies");
  const byId = new Map(t.his.map((m) => [m.id, m]));
  const targets: HisMessage[] = [];
  for (const id of new Set(messageIds)) {
    const m = byId.get(id);
    if (!m) throw new MailScopeError(`loadHisBodies: message ${String(id)} is not one of his messages in thread ${t.threadId}`);
    if (!isPinnedAccount(principal, m.accountId)) {
      throw new MailScopeError(`loadHisBodies: message ${m.id} is on account ${m.accountId}, which is not pinned for principal ${principal.id}`);
    }
    if (m.bodyDeferred) targets.push(m);
  }
  await eachLimited(targets, BODY_CONCURRENCY, async (m) => {
    let body: { body_html: string | null; body_text: string | null };
    try {
      body = await cloneCall("message body", opts, (signal) => fetchMessageBody(m.id, { signal }));
    } catch (err) {
      if (!isCloneNotFound(err)) throw err;
      body = { body_html: null, body_text: null };
    }
    m.bodyHtml = typeof body.body_html === "string" ? body.body_html : null;
    m.bodyText = typeof body.body_text === "string" ? body.body_text : null;
    m.bodyDeferred = false;
    const ids = contentIds.get(m);
    if (ids) m.attachments = m.attachments.map((a, i) => ({ ...a, inline: isInline(ids[i] ?? null, m.bodyHtml) }));
  });
}

// ---------------------------------------------------------------------------
// Listing (reconcile)
// ---------------------------------------------------------------------------

const MAX_LIST_LIMIT = 200;

function pageLimit(limit: unknown, operation: string): number {
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    throw new NonRetryableError(`${operation}: limit must be a positive integer`);
  }
  return Math.min(limit, MAX_LIST_LIMIT);
}

function isoParam(value: unknown, operation: string, name: string): string {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new NonRetryableError(`${operation}: ${name} must be an ISO time`);
  // Re-rendered by toISOString: only digits, "-", ":", ".", "T" and "Z", so
  // nothing can close the quotes it is sent in.
  return new Date(ms).toISOString();
}

export interface ThreadListPage {
  threads: { threadId: string; lastMessageAt: string | null }[];
  hasMore: boolean;
  /** The page size the clone actually used (it clamps to 1..200). */
  limitEchoed: number;
}

/**
 * Threads touching one of his pinned accounts whose last_message_at is after
 * `afterIso` (list-mode reconcile). Always scoped by mailbox_id; the q string
 * is built here as `after:"<ISO>"`, never from input; no folder filter (so
 * Inbox, Sent and Junk all come back) and never a before: bound. `snoozed`
 * asks for the threads the clone otherwise hides. Only ids and times come
 * back: the list's aggregates (last_from, last_snippet, …) span every account
 * and are dropped.
 */
export async function listPrincipalThreadsSince(
  principal: ExecPrincipal,
  accountId: string,
  opts: { afterIso: string; limit: number; offset: number; snoozed?: boolean } & CloneCallOptions
): Promise<ThreadListPage> {
  requirePinnedAccount(principal, accountId, "listPrincipalThreadsSince");
  const after = isoParam(opts.afterIso, "listPrincipalThreadsSince", "afterIso");
  const limit = pageLimit(opts.limit, "listPrincipalThreadsSince");
  if (typeof opts.offset !== "number" || !Number.isInteger(opts.offset) || opts.offset < 0) {
    throw new NonRetryableError("listPrincipalThreadsSince: offset must be a non-negative integer");
  }
  const page = await cloneCall("thread list", opts, (signal) =>
    listThreadsPaged({
      mailboxId: accountId,
      q: `after:"${after}"`,
      limit,
      offset: opts.offset,
      ...(opts.snoozed ? { snoozed: true } : {}),
      signal
    })
  );
  return {
    threads: (Array.isArray(page.threads) ? page.threads : [])
      .filter((t) => typeof t === "object" && t !== null && typeof t.id === "string" && t.id.length > 0)
      .map((t) => ({ threadId: t.id, lastMessageAt: cloneTimeToIso(t.last_message_at) })),
    hasMore: page.hasMore === true,
    limitEchoed: page.limit
  };
}

/**
 * One row of his CL1 messages feed. Times are epoch ms (addenda §1.9);
 * signalsAtMs is COALESCE(signals_updated_at, created_at), the feed's own
 * "changed" position. There is no automated flag (the feed has none) and no
 * subject. from/to/cc are the raw address fields, for screening only: never
 * store, log or render them.
 */
export interface FeedRow {
  messageId: string;
  threadId: string;
  accountId: string;
  direction: MessageDirection;
  folder: string;
  isJunk: boolean;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  sentAtMs: number | null;
  createdAtMs: number;
  signalsAtMs: number;
  /** Graph's flag status, lowercased ("notflagged" | "flagged" | "complete"), or null when unknown. */
  flagStatus: string | null;
  isRead: boolean | null;
  /** Outlook importance; anything outside low/normal/high is null. */
  importance: OutlookImportance | null;
  /** The Outlook web link: an https URL of at most 2048 characters, else null. */
  webLink: string | null;
  /** Set when the message left the folders the clone syncs (archived, deleted or moved). */
  removedAtMs: number | null;
  from: string;
  to: string[];
  cc: string[];
}

export type FeedPage =
  | { supported: false }
  | {
      supported: true;
      rows: FeedRow[];
      /** Never null: page while hasMore, then poll again later from it. */
      nextCursor: string;
      hasMore: boolean;
      /** The clone's settle horizon as ISO (rows stamped after it aren't served yet). */
      settledThrough: string | null;
      settledThroughMs: number | null;
    };

const MAX_WEB_LINK_CHARS = 2048;
const MAX_CURSOR_CHARS = 512;

function feedRowOf(m: MissiveFeedMessage, accountId: string): FeedRow {
  const fail = (what: string): never => {
    throw new Error(`messages feed: row ${typeof m.id === "string" ? m.id : "?"} is malformed (${what})`);
  };
  if (typeof m.id !== "string" || !m.id) fail("id");
  if (typeof m.thread_id !== "string" || !m.thread_id) fail("thread_id");
  // The feed is per account; a row from any other account must never be read as his.
  if (m.account_id !== accountId) fail("account_id");
  const direction = directionOf(m.direction) ?? fail("direction");
  const createdAtMs = cloneTimeToMs(m.created_at) ?? fail("created_at");
  const signalsAtMs = cloneTimeToMs(m.signals_updated_at) ?? createdAtMs;
  const folder = typeof m.folder === "string" ? m.folder : "";
  const flag = typeof m.flag_status === "string" && m.flag_status ? m.flag_status.trim().toLowerCase().slice(0, 32) : null;
  const importance = typeof m.importance === "string" ? m.importance.trim().toLowerCase() : null;
  const webLink =
    typeof m.web_link === "string" && m.web_link.length <= MAX_WEB_LINK_CHARS && /^https:\/\//i.test(m.web_link) ? m.web_link : null;
  return {
    messageId: m.id,
    threadId: m.thread_id,
    accountId,
    direction,
    folder,
    isJunk: JUNK_FOLDER.test(folder),
    rfcMessageId: rfcId(m.message_id),
    inReplyTo: rfcId(m.in_reply_to),
    sentAtMs: cloneTimeToMs(m.sent_at),
    createdAtMs,
    signalsAtMs,
    flagStatus: flag,
    isRead: typeof m.is_read === "boolean" ? m.is_read : null,
    importance: importance === "low" || importance === "normal" || importance === "high" ? importance : null,
    webLink,
    removedAtMs: cloneTimeToMs(m.removed_at),
    from: typeof m.from_addr === "string" ? m.from_addr : "",
    to: toStringArray(m.to_addrs),
    cc: toStringArray(m.cc_addrs)
  };
}

/**
 * One page of one pinned account's CL1 feed (order "created": new rows;
 * "changed": rows whose signals changed too). `cursor` wins over `sinceIso`.
 * `{ supported: false }` from a pre-CL1 clone (cached by missive-client). A
 * row that isn't well-formed, or belongs to another account, throws: the
 * cursor must not move past a row that couldn't be read. `direction` (P4,
 * X2(c)) asks the clone for one direction only and is omitted from the
 * request when absent.
 */
export async function listPrincipalMessagesFeed(
  principal: ExecPrincipal,
  accountId: string,
  opts: { order: "created" | "changed"; cursor: string | null; sinceIso: string | null; limit: number; direction?: "inbound" | "outbound" } &
    CloneCallOptions
): Promise<FeedPage> {
  requirePinnedAccount(principal, accountId, "listPrincipalMessagesFeed");
  if (opts.order !== "created" && opts.order !== "changed") {
    throw new NonRetryableError("listPrincipalMessagesFeed: order must be created or changed");
  }
  if (opts.direction !== undefined && opts.direction !== "inbound" && opts.direction !== "outbound") {
    throw new NonRetryableError("listPrincipalMessagesFeed: direction must be inbound or outbound");
  }
  if (opts.cursor !== null && (typeof opts.cursor !== "string" || !opts.cursor || opts.cursor.length > MAX_CURSOR_CHARS)) {
    throw new NonRetryableError("listPrincipalMessagesFeed: cursor is malformed");
  }
  const since = opts.cursor || opts.sinceIso === null ? null : isoParam(opts.sinceIso, "listPrincipalMessagesFeed", "sinceIso");
  const limit = pageLimit(opts.limit, "listPrincipalMessagesFeed");
  const page = await cloneCall("messages feed", opts, (signal) =>
    listMessagesFeed({
      accountId,
      order: opts.order,
      cursor: opts.cursor,
      since,
      limit,
      ...(opts.direction === undefined ? {} : { direction: opts.direction }),
      signal
    })
  );
  if (!page.supported) return { supported: false };
  const settledThroughMs = cloneTimeToMs(page.settled_through);
  return {
    supported: true,
    rows: page.messages.map((m) => feedRowOf(m, accountId)),
    nextCursor: page.next_cursor,
    hasMore: page.has_more,
    settledThrough: settledThroughMs === null ? null : new Date(settledThroughMs).toISOString(),
    settledThroughMs
  };
}

/** screenRestricted for one feed row (amendments-3: reconcile screens every row of his it sees). */
export function screenFeedRow(row: Pick<FeedRow, "from" | "to" | "cc">, rules: readonly RestrictedSenderRule[]): ScreenResult {
  return screenRestricted({ all: [row], participants: [] }, rules);
}

/** screenHashesFor one feed row: what a tombstone proposal built from a feed row unions in. */
export function feedRowScreenHashes(row: Pick<FeedRow, "from" | "to" | "cc">): { hashes: string[]; truncated: boolean } {
  return screenHashesFor({ all: [row], participants: [] });
}

// ---------------------------------------------------------------------------
// Mailbox health and the team's own addresses
// ---------------------------------------------------------------------------

const MAX_SYNC_ERROR_CHARS = 200;

// The clone's sync error can carry a token-ish string or an address; it is
// scrubbed by the audit sanitizer, flattened and clipped before it is stored.
function safeSyncError(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const scrubbed = sanitizeForAudit(v);
  const s = (typeof scrubbed === "string" ? scrubbed : "sync error withheld").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length > MAX_SYNC_ERROR_CHARS ? `${s.slice(0, MAX_SYNC_ERROR_CHARS - 1)}…` : s;
}

/**
 * His pinned mailboxes as the clone reports them, and which ones can't be
 * used: not_found (gone from the clone), email_mismatch (no longer his
 * address: never read someone else's mailbox), not_microsoft (not the Graph
 * connection the pin was made for). A failed read throws.
 */
export async function checkPinnedAccounts(
  principal: ExecPrincipal,
  opts: CloneCallOptions = {}
): Promise<{ accounts: MailAccountStatus[]; problems: MailAccountProblem[] }> {
  const pinned = requirePin(principal, "checkPinnedAccounts");
  const list = await cloneCall("account list", opts, (signal) => listAccountsFresh({ signal }));
  const byId = new Map((Array.isArray(list) ? list : []).filter((a) => a && typeof a.id === "string").map((a) => [a.id, a]));
  const accounts: MailAccountStatus[] = [];
  const problems: MailAccountProblem[] = [];
  for (const id of pinned) {
    const a = byId.get(id);
    if (!a) {
      problems.push({ accountId: id, reason: "not_found" });
      continue;
    }
    const email = (typeof a.email === "string" ? a.email : "").trim().toLowerCase();
    accounts.push({
      id,
      email,
      lastSyncedAt: cloneTimeToIso(a.last_synced_at),
      lastSyncError: safeSyncError(a.last_sync_error),
      lastSyncErrorAt: cloneTimeToIso(a.last_sync_error_at)
    });
    if (email !== principal.email) problems.push({ accountId: id, reason: "email_mismatch" });
    else if ((typeof a.provider === "string" ? a.provider : "").trim().toLowerCase() !== "microsoft") {
      problems.push({ accountId: id, reason: "not_microsoft" });
    }
  }
  return { accounts, problems };
}

/** The company's own domain: always internal, whether or not a mailbox on it is connected. */
const COMPANY_DOMAIN = "scaledai.org";

/**
 * The team's own addresses for correlation (L14): every connected account's
 * address, and their domains minus free-mail providers, plus scaledai.org.
 * The caller (the client matcher) still removes domains a client claims. A
 * failed read throws.
 */
export async function listInternalAddresses(
  principal: ExecPrincipal,
  opts: CloneCallOptions = {}
): Promise<{ addresses: string[]; domains: string[] }> {
  requirePin(principal, "listInternalAddresses");
  const list = await cloneCall("account list", opts, (signal) => listAccountsFresh({ signal }));
  const addresses = new Set<string>();
  const domains = new Set<string>([COMPANY_DOMAIN]);
  for (const a of Array.isArray(list) ? list : []) {
    const email = (typeof a?.email === "string" ? a.email : "").trim().toLowerCase();
    const at = email.lastIndexOf("@");
    if (at <= 0 || at === email.length - 1) continue;
    addresses.add(email);
    const domain = email.slice(at + 1);
    if (!GENERIC_EMAIL_DOMAINS.has(domain)) domains.add(domain);
  }
  return { addresses: [...addresses].sort(), domains: [...domains].sort() };
}

// ---------------------------------------------------------------------------
// Answered (L3), the read-time overlay, partial threads (L17)
// ---------------------------------------------------------------------------

export interface AnsweredFacts {
  state: StoredAnsweredState;
  /** When the first qualifying reply after the newest inbound went out. */
  answeredAt: string | null;
  answeredMessageId: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  newestInbound: HisMessage | null;
  newestOutbound: HisMessage | null;
  /** The newest of his messages that count (no junk, no self-copies). */
  newestMessage: HisMessage | null;
  /** The newest of his (non-junk) messages is outbound; null with no messages. */
  newestIsOutbound: boolean | null;
  /** He has outbound messages here and every one is automated (a bulk send). */
  outboundAutomatedOnly: boolean;
  /** L4: the newest inbound message, else the newest message (outbound-only threads). */
  anchorMessageId: string | null;
}

/**
 * Answered state from his messages only (L3). Junk is ignored. For the newest
 * inbound message m_in, the thread is answered when one of his outbound
 * messages was sent after it (strictly), isn't automated, and addresses its
 * sender (that address in its to/cc, both lowercased) or replies to it
 * (in_reply_to = m_in's Message-ID). Otherwise awaiting_reply; no inbound at
 * all is no_inbound.
 *
 * `ownAddresses` (optional): his own addresses. An inbound message from one of
 * them is a copy of his own mail (a self-cc), not mail to answer, and is left
 * out like junk.
 */
export function computeAnswered(his: readonly HisMessage[], opts: { ownAddresses?: Iterable<string> } = {}): AnsweredFacts {
  const own = new Set([...(opts.ownAddresses ?? [])].map((a) => a.trim().toLowerCase()));
  const messages = his.filter((m) => !m.isJunk && !(m.direction === "inbound" && m.from !== null && own.has(m.from.email))).sort(byTime);
  const inbound = messages.filter((m) => m.direction === "inbound");
  const outbound = messages.filter((m) => m.direction === "outbound");
  const newestInbound = inbound[inbound.length - 1] ?? null;
  const newestOutbound = outbound[outbound.length - 1] ?? null;
  const newest = messages[messages.length - 1] ?? null;

  let state: StoredAnsweredState = "no_inbound";
  let answer: HisMessage | null = null;
  if (newestInbound) {
    const inAt = sentMs(newestInbound);
    const sender = newestInbound.from?.email ?? null;
    const parent = rfcKey(newestInbound.rfcMessageId);
    answer =
      outbound.find(
        (o) =>
          sentMs(o) > inAt &&
          !o.isAutomated &&
          ((sender !== null && [...o.to, ...o.cc].some((a) => a.email === sender)) || (parent !== null && rfcKey(o.inReplyTo) === parent))
      ) ?? null;
    state = answer ? "answered" : "awaiting_reply";
  }
  return {
    state,
    answeredAt: answer?.sentAt ?? null,
    answeredMessageId: answer?.id ?? null,
    lastInboundAt: newestInbound?.sentAt ?? null,
    lastOutboundAt: newestOutbound?.sentAt ?? null,
    newestInbound,
    newestOutbound,
    newestMessage: newest,
    newestIsOutbound: newest ? newest.direction === "outbound" : null,
    outboundAutomatedOnly: outbound.length > 0 && outbound.every((m) => m.isAutomated),
    anchorMessageId: newestInbound?.id ?? newest?.id ?? null
  };
}

/**
 * What a reader shows (L3 + A3), never stored. Only a stored awaiting_reply
 * is overlaid, in this order: handled_in_outlook when the signals row of the
 * row's newest inbound message (and only that message: a new inbound after an
 * archive is awaiting again) says it left his folders; reply_scheduled when a
 * DD reply is scheduled; draft_pending when a draft awaits approval. null for
 * a row with no answered state (a tombstone).
 *
 * P4 (X2(a), L15, C45): reply_sent_pending comes right after
 * handled_in_outlook: an exec draft replying to the row's newest inbound
 * message (and only that message: a newer inbound is awaiting again) was sent
 * from DD or from Outlook within 7 days and the feed hasn't shown the Sent
 * copy yet. A ready or saved exec draft never changes the overlay.
 */
export function overlayAnswered(
  row: Pick<ExecEmailThread, "answeredState" | "newestInboundMessageId">,
  inboundSignal: Pick<ExecEmailSignal, "messageId" | "removedAt"> | undefined,
  artifacts?: ReplyArtifacts
): AnsweredState | null {
  const stored = row.answeredState;
  if (stored === null) return null;
  if (stored !== "awaiting_reply") return stored;
  if (
    inboundSignal !== undefined &&
    row.newestInboundMessageId !== null &&
    inboundSignal.messageId === row.newestInboundMessageId &&
    inboundSignal.removedAt !== null &&
    inboundSignal.removedAt !== undefined
  ) {
    return "handled_in_outlook";
  }
  if (row.newestInboundMessageId !== null && artifacts?.execSentParents?.includes(row.newestInboundMessageId)) return "reply_sent_pending";
  if (artifacts?.scheduledFor) return "reply_scheduled";
  if (artifacts?.draftPending) return "draft_pending";
  return "awaiting_reply";
}

/** L17: one of his messages replies to a message that isn't in the thread (any account). */
export function isPartialThread(his: readonly HisMessage[], all: readonly MessageMeta[]): boolean {
  const known = new Set(all.map((m) => rfcKey(m.rfcMessageId)).filter((k): k is string => k !== null));
  return his.some((m) => {
    const parent = rfcKey(m.inReplyTo);
    return parent !== null && !known.has(parent);
  });
}

// ---------------------------------------------------------------------------
// DD-side reply artifacts (read-time overlay; metadata only, never bodies)
// ---------------------------------------------------------------------------

const readFail = (table: string, message: string) => new MailReadError(table, message);

function addArtifact(out: Map<string, ReplyArtifacts>, threadId: unknown, patch: (a: ReplyArtifacts) => void): void {
  if (typeof threadId !== "string" || !threadId) return;
  let a = out.get(threadId);
  if (!a) out.set(threadId, (a = { scheduledFor: null, draftPending: false }));
  patch(a);
}

function scheduleInto(out: Map<string, ReplyArtifacts>, rows: readonly Record<string, unknown>[]): void {
  for (const r of rows) {
    const at = typeof r.scheduled_for === "string" ? isoMs(r.scheduled_for) : null;
    if (at === null) continue;
    // The earliest pending send is the one he'll see go out first.
    addArtifact(out, r.thread_id, (a) => {
      if (a.scheduledFor === null || at < (isoMs(a.scheduledFor) ?? Infinity)) a.scheduledFor = new Date(at).toISOString();
    });
  }
}

function draftsInto(out: Map<string, ReplyArtifacts>, rows: readonly Record<string, unknown>[]): void {
  for (const r of rows) addArtifact(out, r.source_thread_id, (a) => (a.draftPending = true));
}

/** A short code for a failed read: the error's `code` property, else its name. Never a message. */
function errorCodeOf(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code.slice(0, 64);
    if (err instanceof Error && err.name) return err.name;
  }
  return "unknown";
}

/**
 * P4 (X2(b), C73): merge the exec drafts' artifacts (the thread's active draft
 * and the parents of drafts sent from DD in the last 7 days) into `out`. The
 * exec table not being installed is already "no exec fields" (listDraftArtifacts
 * answers an empty map). Any other exec read error fails OPEN: one log line
 * with the code and the legacy artifacts without exec fields, never a throw,
 * because P3's attention pass reads artifacts where "any failure throws" and
 * the Email tab drops its whole bucket section on an artifacts failure.
 */
async function mergeExecArtifacts(
  principal: ExecPrincipal,
  out: Map<string, ReplyArtifacts>,
  threadIds: readonly string[] | "all",
  signal: AbortSignal | undefined
): Promise<void> {
  let exec: Awaited<ReturnType<typeof listDraftArtifacts>>;
  try {
    exec = await listDraftArtifacts(principal, threadIds, new Date(), { signal });
  } catch (err) {
    console.warn(`[exec-drafts] artifacts unavailable ${errorCodeOf(err)}`);
    return;
  }
  for (const [threadId, a] of exec) {
    addArtifact(out, threadId, (artifacts) => {
      artifacts.execDraft = a.execDraft;
      artifacts.execSentParents = a.execSentParents;
    });
  }
}

/**
 * Reply artifacts for these threads, his accounts only: a pending
 * scheduled_emails row (scheduledFor = the earliest) and a pending,
 * undismissed email_drafts row with source_thread_id (draftPending). Threads
 * with neither are absent. A failed read throws.
 */
export async function listReplyArtifacts(
  principal: ExecPrincipal,
  threadIds: readonly string[],
  opts: { signal?: AbortSignal } = {}
): Promise<Map<string, ReplyArtifacts>> {
  const pinned = [...requirePin(principal, "listReplyArtifacts")];
  const ids = [...new Set(threadIds.filter((id) => typeof id === "string" && id.length > 0))];
  const out = new Map<string, ReplyArtifacts>();
  for (const chunk of chunks(ids)) {
    scheduleInto(
      out,
      await pageAll<Record<string, unknown>>(
        "scheduled_emails",
        () => from("scheduled_emails", "id, thread_id, scheduled_for").eq("status", "pending").in("account_id", pinned).in("thread_id", chunk),
        ["id"],
        opts.signal,
        readFail
      )
    );
    draftsInto(
      out,
      await pageAll<Record<string, unknown>>(
        "email_drafts",
        () =>
          from("email_drafts", "id, source_thread_id")
            .eq("status", "pending")
            .is("dismissed_at", null)
            .in("account_id", pinned)
            .in("source_thread_id", chunk),
        ["id"],
        opts.signal,
        readFail
      )
    );
  }
  await mergeExecArtifacts(principal, out, ids, opts.signal);
  return out;
}

/** listReplyArtifacts for every thread of his that has one. */
export async function listAllReplyArtifacts(principal: ExecPrincipal, opts: { signal?: AbortSignal } = {}): Promise<Map<string, ReplyArtifacts>> {
  const pinned = [...requirePin(principal, "listAllReplyArtifacts")];
  const out = new Map<string, ReplyArtifacts>();
  scheduleInto(
    out,
    await pageAll<Record<string, unknown>>(
      "scheduled_emails",
      () => from("scheduled_emails", "id, thread_id, scheduled_for").eq("status", "pending").in("account_id", pinned),
      ["id"],
      opts.signal,
      readFail
    )
  );
  draftsInto(
    out,
    await pageAll<Record<string, unknown>>(
      "email_drafts",
      () =>
        from("email_drafts", "id, source_thread_id")
          .eq("status", "pending")
          .is("dismissed_at", null)
          .in("account_id", pinned)
          .not("source_thread_id", "is", null),
      ["id"],
      opts.signal,
      readFail
    )
  );
  await mergeExecArtifacts(principal, out, "all", opts.signal);
  return out;
}

async function headCount(build: () => Query, table: string, signal: AbortSignal | undefined): Promise<number> {
  let query = build();
  if (signal) query = query.abortSignal(signal);
  const { count, error } = await query;
  if (error) throw new MailReadError(table, error.message);
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new MailReadError(table, "no count came back");
  return count;
}

/**
 * Counts for the drafts card, his accounts only: pending, undismissed drafts
 * (any kind) and pending scheduled sends. A failed read throws; it never
 * reads as zero.
 */
export async function countPendingReplyArtifacts(
  principal: ExecPrincipal,
  opts: { signal?: AbortSignal } = {}
): Promise<{ draftsPending: number; scheduledReplies: number }> {
  const pinned = [...requirePin(principal, "countPendingReplyArtifacts")];
  const head = { count: "exact", head: true } as const;
  const [draftsPending, scheduledReplies] = await Promise.all([
    headCount(
      () => from("email_drafts", "id", head).eq("status", "pending").is("dismissed_at", null).in("account_id", pinned),
      "email_drafts",
      opts.signal
    ),
    headCount(() => from("scheduled_emails", "id", head).eq("status", "pending").in("account_id", pinned), "scheduled_emails", opts.signal)
  ]);
  return { draftsPending, scheduledReplies };
}

// ---------------------------------------------------------------------------
// P4: Outlook drafts through CL2 (contract §3.3; Area B implements)
// ---------------------------------------------------------------------------
//
// This file is the ONLY reader of the EA (draft) token (boundary B2) and never
// falls back to the legacy clone token (L3). Every draft function, in this
// order: requirePinnedAccount (a foreign account is a MailScopeError before
// any I/O), getEaReadiness (not ok → EaUnavailableError), the token (empty →
// EaUnavailableError("token_missing")), the CL2 body exactly per §3.3's table
// (recipients as { address, name } with the name omitted when empty),
// cloneEaFetch with the C4 timeout (an own AbortController, never a caller's
// signal), the clone-ea-types parser (a read-back whose accountId isn't
// pinned → MailScopeError), and on an `auth` error the readiness cache is
// invalidated before the error is rethrown. Nothing here logs a token, a
// body or an address: log lines carry codes.

// C4: the per-call timeouts of the CL2 routes.
const EA_PROBE_TIMEOUT_MS = 10_000;
const EA_CREATE_TIMEOUT_MS = 200_000;
const EA_RECREATE_TIMEOUT_MS = 340_000;
const EA_DELETE_TIMEOUT_MS = 200_000;
const EA_READ_TIMEOUT_MS = 60_000;
// C37: the readiness cache.
const EA_OK_TTL_MS = 300_000;
const EA_FAIL_TTL_MS = 60_000;
// §2.3: where the verdict is persisted.
const EA_SOURCE = "clone-ea" as const;
const EA_TOKEN_KEY = "ea-token";
// L4: the scopes the draft token must carry, sorted and joined.
const EA_SCOPES = "draft,read";
// C54: the Sent-copy search.
const SENT_COPY_PAGE_TIMEOUT_MS = 15_000;
const SENT_COPY_MARGIN_MS = 300_000;
const SENT_COPY_MAX_PAGES = 5;
const SENT_COPY_PAGE_LIMIT = 200;

/** The only reader of the EA token (B2): trimmed; null when unset or blank. Never MISSIVE_API_TOKEN. */
function readEaToken(): string | null {
  const raw = process.env.MISSIVE_EA_TOKEN;
  const token = typeof raw === "string" ? raw.trim() : "";
  return token.length > 0 ? token : null;
}

/** First 12 hex of sha256(token): what logs, verdicts and the cache key carry instead of the token. */
const tokenFingerprint = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);
const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const x of left) if (!right.has(x)) return false;
  return true;
}

interface CachedReadiness {
  verdict: EaReadiness;
  until: number;
}
const readinessCache = new Map<string, CachedReadiness>();
const readinessKey = (principal: ExecPrincipal, tokenFp: string | null): string => `${principal.id}:${tokenFp ?? "-"}`;

/** One CL2 probe for the readiness check: the parsed answer, or null on any clone answer or failure. */
async function probeClone<T>(route: CloneEaRoute, path: string, token: string | null, parse: (body: unknown) => T): Promise<T | null> {
  try {
    const res = await cloneEaFetch({ route, method: "GET", path, token, timeoutMs: EA_PROBE_TIMEOUT_MS });
    return parse(res.body);
  } catch (err) {
    if (err instanceof CloneEaError) return null;
    throw err;
  }
}

/** L4's checks, in the contract's order (§3.3 "getEaReadiness"); the first failed check is the reason. */
async function computeEaReadiness(principal: ExecPrincipal, token: string | null, tokenFp: string | null, nowMs: number): Promise<EaReadiness> {
  const checkedAt = new Date(nowMs).toISOString();
  let expiresAt: string | null = null;
  let cl2Ready: boolean | null = null;
  let cl2Send: EaReadiness["cl2Send"] = null;
  const fail = (reason: EaReadinessReason): EaReadiness => ({ ok: false, reason, cl2Ready, cl2Send, sendEnabled: false, expiresAt, checkedAt, tokenFp });

  const pinned = pinnedAccounts(principal);
  if (pinned.length === 0) return fail("no_pin");
  if ((await countEnabledMailPinnedPrincipals()) > 1) return fail("multiple_principals");
  if (token === null) return fail("token_missing");
  try {
    cloneEaBaseUrl();
  } catch {
    return fail("base_url_missing");
  }
  const claims = decodeTokenClaims(token);
  if (claims === null || !hasOwn(claims, "scope")) return fail("not_scoped");
  const exp = typeof claims.exp === "number" && Number.isFinite(claims.exp) && Math.abs(claims.exp * 1000) <= MAX_DATE_MS ? claims.exp * 1000 : null;
  if (exp !== null) expiresAt = new Date(exp).toISOString();
  if (exp !== null && exp <= nowMs) return fail("token_expired");

  const status = await probeClone("status", CLONE_EA_PATHS.status(), null, parseCloneStatus);
  if (status === null) return fail("clone_unreachable");
  if (status.cl2 === null) return fail("cl2_missing");
  cl2Ready = status.cl2.ready;
  cl2Send = status.cl2.send;
  if (status.cl2.ready !== true) return fail("cl2_not_ready");

  const me = await probeClone("auth_me", CLONE_EA_PATHS.authMe(), token, parseCloneAuthMe);
  if (me === null) return fail("me_failed");
  if (me.auth === null) return fail("me_no_auth");
  if (me.auth.kind !== "scoped") return fail("not_scoped");
  if ([...me.auth.scopes].sort().join(",") !== EA_SCOPES) return fail("wrong_scopes");
  if (!sameSet(me.auth.accounts, pinned)) return fail("wrong_accounts");
  const meExp = me.auth.expiresAt === null ? NaN : Date.parse(me.auth.expiresAt);
  if (Number.isFinite(meExp)) {
    expiresAt = new Date(meExp).toISOString();
    if (meExp <= nowMs) return fail("token_expired");
  }
  return { ok: true, reason: null, cl2Ready, cl2Send, sendEnabled: me.auth.sendEnabled === true, expiresAt, checkedAt, tokenFp };
}

/** §2.3: the verdict as clone-ea/ea-token, best-effort (a failed write is logged with the key and never fails the check). */
async function persistEaVerdict(principal: ExecPrincipal, verdict: EaReadiness): Promise<void> {
  const state: EaTokenState = {
    ok: verdict.ok,
    reason: verdict.reason,
    checkedAt: verdict.checkedAt,
    cl2Ready: verdict.cl2Ready,
    cl2Send: verdict.cl2Send,
    sendEnabled: verdict.ok ? verdict.sendEnabled : null,
    expiresAt: verdict.expiresAt,
    tokenFp: verdict.tokenFp
  };
  try {
    await putSyncState(principal, EA_SOURCE, EA_TOKEN_KEY, state);
  } catch (err) {
    console.warn(`[exec-drafts] ${EA_SOURCE}/${EA_TOKEN_KEY} verdict not written: ${err instanceof Error ? err.name : "error"}`);
  }
}

function readinessFromState(state: EaTokenState): EaReadiness {
  return {
    ok: state.ok,
    reason: state.reason,
    cl2Ready: state.cl2Ready,
    cl2Send: state.cl2Send,
    sendEnabled: state.sendEnabled === true,
    expiresAt: state.expiresAt,
    checkedAt: state.checkedAt,
    tokenFp: state.tokenFp
  };
}

/** Drafting is unavailable for a configuration reason (L4); never retried (errorClass "fatal"). */
export class EaUnavailableError extends NonRetryableError {
  readonly reason: EaReadinessReason;
  constructor(reason: EaReadinessReason) {
    super(`EA drafting unavailable: ${reason}`, "fatal");
    this.name = "EaUnavailableError";
    this.reason = reason;
  }
}
export interface EaReadiness {
  ok: boolean; reason: EaReadinessReason | null;
  cl2Ready: boolean | null; cl2Send: "off" | "all" | "some" | null;
  /** /api/auth/me auth.sendEnabled: the clone's EA_SEND_ENABLED covers his accounts. */
  sendEnabled: boolean;
  expiresAt: string | null; checkedAt: string; tokenFp: string | null;
}
/**
 * L4 + C37: cached per process (ok 5 min, failure 60 s), keyed by principal id
 * + token fp, so a rotated token misses. `fresh` bypasses the cache. Each fresh
 * check writes clone-ea/ea-token and, when it fails, raises the rate-limited ops
 * alert clone-ea-readiness:<reason> (the reason only). A failed DB read of the
 * principal count throws (nothing is cached): the caller's operation fails
 * closed instead of reporting a verdict that wasn't computed.
 */
export async function getEaReadiness(principal: ExecPrincipal, opts: { fresh?: boolean } = {}): Promise<EaReadiness> {
  const token = readEaToken();
  const tokenFp = token === null ? null : tokenFingerprint(token);
  const key = readinessKey(principal, tokenFp);
  const nowMs = Date.now();
  if (opts.fresh !== true) {
    const hit = readinessCache.get(key);
    if (hit !== undefined && hit.until > nowMs) return hit.verdict;
  }
  const verdict = await computeEaReadiness(principal, token, tokenFp, nowMs);
  readinessCache.set(key, { verdict, until: nowMs + (verdict.ok ? EA_OK_TTL_MS : EA_FAIL_TTL_MS) });
  await persistEaVerdict(principal, verdict);
  if (!verdict.ok && verdict.reason !== null) {
    void notifyOps({ key: `clone-ea-readiness:${verdict.reason}`, title: `EA drafting unavailable: ${verdict.reason}` });
  }
  return verdict;
}
/** The cached verdict (expired or not), else the persisted clone-ea/ea-token verdict; never a network call (C19). */
export async function peekEaReadiness(principal: ExecPrincipal): Promise<EaReadiness | null> {
  const token = readEaToken();
  const hit = readinessCache.get(readinessKey(principal, token === null ? null : tokenFingerprint(token)));
  if (hit !== undefined) return hit.verdict;
  const stored = await getSyncState(principal, EA_SOURCE, EA_TOKEN_KEY, parseEaTokenState);
  return stored === null ? null : readinessFromState(stored.value);
}
/** Forget every cached verdict: after an auth answer from the clone, and in tests. */
export function invalidateEaReadiness(): void {
  readinessCache.clear();
}

function checkGraphId(graphId: unknown, operation: string): asserts graphId is string {
  if (typeof graphId !== "string" || !CLONE_GRAPH_ID_RE.test(graphId)) throw new NonRetryableError(`${operation}: the Outlook draft id is malformed`);
}

/** CL2's recipient shape: `name` only when there is one (CL2C §3.0.3). */
function wireAddresses(list: readonly DraftAddress[]): { address: string; name?: string }[] {
  return list.map((a) => (a.name !== null && a.name.length > 0 ? { address: a.address, name: a.name } : { address: a.address }));
}

/** A parser's invalid_body error rethrown with the answer's real HTTP status and replay flag. */
function parseAnswer<T>(route: CloneEaRoute, res: CloneEaResponse, parse: (body: unknown) => T): T {
  try {
    return parse(res.body);
  } catch (err) {
    if (err instanceof CloneEaError && err.kind === "invalid_body") {
      throw new CloneEaError({ route, status: res.status, body: null, code: "invalid_body", replay: res.replay });
    }
    throw err;
  }
}

/** A live read-back must be for one of his pinned accounts; the clone's own token scoping is not trusted on its own. */
function assertReadBackPinned(principal: ExecPrincipal, read: CloneDraftRead, operation: string): void {
  if (read.live && !isPinnedAccount(principal, read.accountId)) {
    throw new MailScopeError(`${operation}: the read-back is for account ${read.accountId}, which is not pinned for principal ${principal.id}`);
  }
}

/** §3.3's order for every draft function: pin, readiness, token, the call, the parse; an auth answer drops the cache. */
async function eaCall<T>(
  principal: ExecPrincipal,
  operation: string,
  accountId: string,
  call: Omit<CloneEaCall, "token">,
  parse: (body: unknown) => T
): Promise<{ value: T; replay: boolean }> {
  requirePinnedAccount(principal, accountId, operation);
  const readiness = await getEaReadiness(principal);
  if (!readiness.ok) throw new EaUnavailableError(readiness.reason ?? "token_missing");
  const token = readEaToken();
  if (token === null) throw new EaUnavailableError("token_missing");
  try {
    const res = await cloneEaFetch({ ...call, token });
    return { value: parseAnswer(call.route, res, parse), replay: res.replay };
  } catch (err) {
    if (err instanceof CloneEaError && err.kind === "auth") invalidateEaReadiness();
    throw err;
  }
}

export interface ReplyDraftInput {
  threadId: string; parentMessageId: string; accountId: string;
  to: DraftAddress[]; cc: DraftAddress[]; bodyHtml: string; timezone: string; idempotencyKey: string;
}
export interface NewDraftInput {
  accountId: string; to: DraftAddress[]; cc: DraftAddress[]; bcc: DraftAddress[];
  subject: string; bodyHtml: string; timezone: string; idempotencyKey: string;
}
export interface RecreateInput {
  accountId: string; graphId: string; kind: DraftKind;
  to: DraftAddress[]; cc: DraftAddress[]; bcc: DraftAddress[]; subject: string | null;
  bodyHtml: string; timezone: string; ifContentHash: string | null; idempotencyKey: string;
}
/** POST /api/threads/:threadId/outlook-draft: { parentMessageId, to, cc, bodyHtml, timezone }; never accountId, bcc or subject (C23). */
export async function createReplyDraft(principal: ExecPrincipal, input: ReplyDraftInput): Promise<{ readBack: CloneReadBack; replay: boolean }> {
  requirePinnedAccount(principal, input.accountId, "createReplyDraft");
  checkThreadId(input.threadId, "createReplyDraft");
  const { value, replay } = await eaCall(
    principal,
    "createReplyDraft",
    input.accountId,
    {
      route: "create_reply",
      method: "POST",
      path: CLONE_EA_PATHS.createReply(input.threadId),
      json: { parentMessageId: input.parentMessageId, to: wireAddresses(input.to), cc: wireAddresses(input.cc), bodyHtml: input.bodyHtml, timezone: input.timezone },
      idempotencyKey: input.idempotencyKey,
      timeoutMs: EA_CREATE_TIMEOUT_MS
    },
    (body) => parseCloneReadBack("create_reply", body)
  );
  assertReadBackPinned(principal, value, "createReplyDraft");
  return { readBack: value, replay };
}
/** POST /api/compose/outlook-draft: { accountId, to, cc, bcc, subject, bodyHtml, timezone }. */
export async function createNewDraft(principal: ExecPrincipal, input: NewDraftInput): Promise<{ readBack: CloneReadBack; replay: boolean }> {
  const { value, replay } = await eaCall(
    principal,
    "createNewDraft",
    input.accountId,
    {
      route: "create_new",
      method: "POST",
      path: CLONE_EA_PATHS.createNew(),
      json: {
        accountId: input.accountId,
        to: wireAddresses(input.to),
        cc: wireAddresses(input.cc),
        bcc: wireAddresses(input.bcc),
        subject: input.subject,
        bodyHtml: input.bodyHtml,
        timezone: input.timezone
      },
      idempotencyKey: input.idempotencyKey,
      timeoutMs: EA_CREATE_TIMEOUT_MS
    },
    (body) => parseCloneReadBack("create_new", body)
  );
  assertReadBackPinned(principal, value, "createNewDraft");
  return { readBack: value, replay };
}
/** GET /api/outlook-drafts/:graphId: the live read-back, or the registry view (live: false) when the live read failed on a non-saved row. */
export async function getOutlookDraft(principal: ExecPrincipal, input: { accountId: string; graphId: string }): Promise<CloneDraftRead> {
  requirePinnedAccount(principal, input.accountId, "getOutlookDraft");
  checkGraphId(input.graphId, "getOutlookDraft");
  const { value } = await eaCall(
    principal,
    "getOutlookDraft",
    input.accountId,
    { route: "get_draft", method: "GET", path: CLONE_EA_PATHS.draft(input.graphId), timeoutMs: EA_READ_TIMEOUT_MS },
    (body) => parseCloneDraftRead("get_draft", body)
  );
  assertReadBackPinned(principal, value, "getOutlookDraft");
  return value;
}
/** PATCH /api/outlook-drafts/:graphId: reply { to, cc, bodyHtml, timezone, ifContentHash? }; new { to, cc, bcc, subject, bodyHtml, timezone, ifContentHash? }. */
export async function recreateOutlookDraft(principal: ExecPrincipal, input: RecreateInput): Promise<{ readBack: CloneReadBack; replay: boolean }> {
  requirePinnedAccount(principal, input.accountId, "recreateOutlookDraft");
  checkGraphId(input.graphId, "recreateOutlookDraft");
  if (input.kind !== "reply" && input.kind !== "new") throw new NonRetryableError("recreateOutlookDraft: kind must be reply or new");
  // CL2 checks the kind-specific rules after the claim and stores a 400 under the key: refuse a body it would refuse before any I/O.
  if (input.kind === "new" && typeof input.subject !== "string") throw new NonRetryableError("recreateOutlookDraft: a new draft needs a subject");
  const ifContentHash = input.ifContentHash === null ? {} : { ifContentHash: input.ifContentHash };
  const json =
    input.kind === "reply"
      ? { to: wireAddresses(input.to), cc: wireAddresses(input.cc), bodyHtml: input.bodyHtml, timezone: input.timezone, ...ifContentHash }
      : {
          to: wireAddresses(input.to),
          cc: wireAddresses(input.cc),
          bcc: wireAddresses(input.bcc),
          subject: input.subject,
          bodyHtml: input.bodyHtml,
          timezone: input.timezone,
          ...ifContentHash
        };
  const { value, replay } = await eaCall(
    principal,
    "recreateOutlookDraft",
    input.accountId,
    { route: "recreate", method: "PATCH", path: CLONE_EA_PATHS.draft(input.graphId), json, idempotencyKey: input.idempotencyKey, timeoutMs: EA_RECREATE_TIMEOUT_MS },
    (body) => parseCloneReadBack("recreate", body)
  );
  assertReadBackPinned(principal, value, "recreateOutlookDraft");
  return { readBack: value, replay };
}
/** DELETE /api/outlook-drafts/:graphId: {} or { ifContentHash }. */
export async function deleteOutlookDraft(principal: ExecPrincipal,
  input: { accountId: string; graphId: string; ifContentHash: string | null; idempotencyKey: string }): Promise<{ deleted: CloneDeleted; replay: boolean }> {
  requirePinnedAccount(principal, input.accountId, "deleteOutlookDraft");
  checkGraphId(input.graphId, "deleteOutlookDraft");
  const { value, replay } = await eaCall(
    principal,
    "deleteOutlookDraft",
    input.accountId,
    {
      route: "delete",
      method: "DELETE",
      path: CLONE_EA_PATHS.draft(input.graphId),
      json: input.ifContentHash === null ? {} : { ifContentHash: input.ifContentHash },
      idempotencyKey: input.idempotencyKey,
      timeoutMs: EA_DELETE_TIMEOUT_MS
    },
    parseCloneDeleted
  );
  return { deleted: value, replay };
}

export type { SentCopyResult } from "@/lib/exec/drafts-types";
/**
 * C54 (legacy-token reads, L3). A reply draft (a thread id, or `thread`: the
 * thread already read by the caller, C63, used instead of a new read) is found
 * when one of his outbound messages in the thread carries the draft's
 * internetMessageId (brackets and case ignored); a thread that can't be read
 * as his is not_found. A new draft is searched in his outbound CL1 feed from
 * 5 minutes before `sinceMs` (the row's send_started_at ?? opened_in_outlook_at
 * ?? created_at), at most 5 pages of 200; a pre-CL1 clone is `unsupported`.
 * A read error throws (the caller never treats it as "not found").
 */
export async function findSentCopy(principal: ExecPrincipal,
  input: { accountId: string; internetMessageId: string; threadId: string | null; sinceMs: number; thread?: PrincipalMailThread }): Promise<SentCopyResult> {
  requirePinnedAccount(principal, input.accountId, "findSentCopy");
  const wanted = rfcKey(typeof input.internetMessageId === "string" ? input.internetMessageId : null);
  if (wanted === null) throw new NonRetryableError("findSentCopy: internetMessageId is empty");
  if (input.thread !== undefined || input.threadId !== null) {
    let thread = input.thread ?? null;
    if (thread === null) {
      const read = await readPrincipalThread(principal, input.threadId as string, { timeoutMs: SENT_COPY_PAGE_TIMEOUT_MS });
      if (read.kind !== "ok") return "not_found";
      thread = read.thread;
    }
    return thread.his.some((m) => m.direction === "outbound" && rfcKey(m.rfcMessageId) === wanted) ? "found" : "not_found";
  }
  if (typeof input.sinceMs !== "number" || !Number.isFinite(input.sinceMs)) throw new NonRetryableError("findSentCopy: sinceMs must be a number");
  const sinceIso = new Date(Math.max(0, input.sinceMs - SENT_COPY_MARGIN_MS)).toISOString();
  let cursor: string | null = null;
  for (let page = 0; page < SENT_COPY_MAX_PAGES; page += 1) {
    const feed = await listPrincipalMessagesFeed(principal, input.accountId, {
      order: "created",
      cursor,
      sinceIso,
      limit: SENT_COPY_PAGE_LIMIT,
      direction: "outbound",
      timeoutMs: SENT_COPY_PAGE_TIMEOUT_MS
    });
    if (!feed.supported) return "unsupported";
    if (feed.rows.some((r) => r.direction === "outbound" && rfcKey(r.rfcMessageId) === wanted)) return "found";
    if (!feed.hasMore) break;
    cursor = feed.nextCursor;
  }
  return "not_found";
}
