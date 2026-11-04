import {
  CORRESPONDENTS_LIMIT,
  NEW_MARK_SETTLE_MS,
  SCREEN_HASH_LIMIT,
  SNAPSHOT_SKEW_MS,
  type BodySource,
  type ExecEmailThread,
  type FilterReason,
  type LastAttemptError,
  type NewCommitment,
  type ScreenVerdict,
  type ThreadSnapshot,
  type TriageError
} from "@/lib/exec/email-types";
import { screenByHashes, screenStoredRow } from "@/lib/exec/sources/mail";
import { TRIAGE_VERSION } from "@/lib/exec/triage/email";
import { NonRetryableError } from "@/lib/exec/types";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";

// The write state machine for exec_email_threads (contract §3.2, as amended by
// v3.1 A1/A3/A4/A5 and the round-4 addenda). Every writer (triage, reconcile,
// the attention pass, the store) asks planThreadWrite what it may do to a
// thread row and does exactly that, so the rules below are the single source
// of truth. Pure: no I/O, no clock (ctx.now), no logging.
//
// What it protects:
//   - Restricted mail never leaves content on a row. A restricted live read,
//     or stored-plus-read screening hashes that match a rule of THIS attempt,
//     turn any write into a tombstone, and a tombstone keeps nothing about the
//     mail but its screening hashes and snapshot (the whitelist below mirrors
//     the migration's CHECK).
//   - A stale read never resurrects or overwrites. Reads are ordered by
//     happens-before on the DD clock (A4): one that started after another
//     finished (plus a skew allowance) is newer; overlapping reads compare
//     their identity counts, then their max ingest times. Facts are written
//     only by a read at least as new as the stored one, a tombstone is left
//     only by a clean read at least that new under the current policy (a
//     strictly later read when the hash set is truncated), and a 404'd thread
//     is revived only by a read that started after the 404 read finished.
//   - Outcomes never regress. Each outcome carries the watermark of what it
//     assessed (max ingest time of his non-junk messages); an outcome older
//     than the stored one changes nothing, and at the same watermark a
//     failure, a filter or the budget never overwrites a triaged assessment
//     (A5's two watermarks: outcome_watermark guards outcomes, while
//     input_watermark moves only with a triaged write and marks what was
//     extracted).
//   - Screening hashes only grow (A1): every write stores the union of the
//     stored and new hashes; past SCREEN_HASH_LIMIT the row is marked
//     truncated for good and is stamped with a policy only when the stamp
//     is provably right.
//
// All time comparisons are on epoch milliseconds (addenda §1.9). Stored
// timestamps arrive as PostgREST text ("…+00:00", microseconds) and are
// parsed; anything written is an ISO string made from milliseconds.

// ---------------------------------------------------------------------------
// Proposals, context, plans
// ---------------------------------------------------------------------------

/** Every stored column of exec_email_threads except the key, the CAS version and updated_at (the store sets those). */
export type ThreadRowImage = Omit<ExecEmailThread, "principalId" | "threadId" | "version" | "updatedAt">;
/** The columns a plan writes, camelCase. An insert carries a full image. */
export type EmailThreadPatch = Partial<ThreadRowImage>;

/** Clone-derived display, fact and pointer columns of one read (his messages only for display). */
export type ThreadFacts = Pick<
  ExecEmailThread,
  | "accountId"
  | "subject"
  | "counterpartName"
  | "counterpartEmail"
  | "correspondents"
  | "messageCount"
  | "newestMessageId"
  | "newestInboundMessageId"
  | "newestOutboundMessageId"
  | "lastInboundAt"
  | "lastOutboundAt"
  | "newestIsOutbound"
  | "answeredState"
  | "answeredAt"
  | "answeredMessageId"
  | "partialThread"
  | "outboundAutomatedOnly"
  | "clientId"
  | "clientName"
  | "clientMatchVia"
  | "matchConfidence"
  | "clientCandidates"
>;

/** The model's assessment, already parsed and clipped by triage/email.ts. */
export type TriageAiFields = Pick<
  ExecEmailThread,
  | "summary"
  | "reason"
  | "category"
  | "urgency"
  | "importance"
  | "needsReply"
  | "mitchellPersonally"
  | "awaitingReplyFromOthers"
  | "decisionQuestion"
  | "decisionMessageId"
  | "clientSignal"
  | "automated"
  | "injectionSuspected"
>;

/** What a model run (or an attempted one) worked from. */
export interface TriageRunFields {
  /** triageContentHash of the rendered input (sha256 hex). */
  contentHash: string;
  model: string;
  /** The TRIAGE_VERSION that produced the run. */
  triageVersion: string;
  inputTruncated: boolean;
  bodySource: BodySource;
}

/**
 * The outcome of one triage job. `watermarkMs` is the max clone ingest time
 * (epoch ms) over his non-junk messages of the read, computed before the
 * prefilter; null only when the clone gave no ingest times at all.
 */
export type TriageOutcomeProposal =
  | { kind: "triaged"; watermarkMs: number | null; ai: TriageAiFields; run: TriageRunFields }
  | { kind: "filtered"; watermarkMs: number | null; reason: FilterReason }
  | { kind: "failed"; watermarkMs: number | null; error: TriageError; refusalCategory: string | null; run: TriageRunFields }
  | { kind: "deferred_budget"; watermarkMs: number | null }
  | { kind: "unchanged"; watermarkMs: number | null };

/** The live screen of one read (sources/mail.ts screenRestricted + screenHashesFor). */
export interface ReadScreen {
  verdict: ScreenVerdict;
  hashes: string[];
  truncated: boolean;
}

/** A tombstone request. `accountId` is required when the thread has no row yet (it is NOT NULL). */
export interface TombstoneProposal {
  kind: "tombstone";
  snapshot: ThreadSnapshot | null;
  hashes: string[] | null;
  truncated: boolean | null;
  policyHash: string;
  accountId?: string | null;
}

export type ThreadProposal =
  /** A full triage read: facts, screen and outcome. */
  | {
      kind: "triage";
      snapshot: ThreadSnapshot;
      screen: ReadScreen;
      /** restrictedPolicyHash of the rules `screen` was computed under. */
      policyHash: string;
      facts: ThreadFacts;
      outcome: TriageOutcomeProposal;
      commitments: NewCommitment[];
    }
  | TombstoneProposal
  /** The clone answered 404 (its own JSON) for the thread. `atMs` = that read's readDoneAtMs. */
  | { kind: "gone"; atMs: number }
  /** The attention pass re-screens a stored row under the current policy. */
  | { kind: "stamp"; policyHash: string }
  /**
   * A clean early screen on a job about to exit without a triage write
   * (junk only, backlog re-route): union the read's hashes into the row so a
   * rule added later still sees them (coherence-20, amendments-2(a)).
   */
  | { kind: "hashes"; snapshot: ThreadSnapshot; screen: ReadScreen; policyHash: string };

/**
 * What a plan is judged against. The store reloads `rules` and
 * `currentPolicyHash` (H) for every compare-and-set attempt (A1); callers that
 * plan directly (the attention pass's bulk stamp) pass what they loaded.
 */
export interface WriteContext {
  rules: readonly RestrictedSenderRule[];
  currentPolicyHash: string;
  now: Date;
  /** exec_settings.retention_days_email. */
  retentionDays: number;
}

export type PlanSkipReason =
  /** Nothing would change. */
  | "noop"
  /** The proposal needs an existing row (gone, stamp, hashes). */
  | "no_row"
  /** A 404 for a tombstone: it stays a tombstone. */
  | "tombstone"
  /** stamp: the row is already screened under the current policy. */
  | "already_stamped"
  /** stamp: the row's hash set is truncated, so only a fresh read can clear it (the caller re-triages). */
  | "needs_fresh_read"
  /** stamp: a tombstone that is clean under the current rules (the caller re-triages; a clean read can exit it). */
  | "needs_retriage"
  /** triage: the read can't prove it is at least as new as the tombstone, or was screened under another policy. */
  | "stale_vs_tombstone"
  /** triage: the read didn't start after the 404 read finished. */
  | "stale_vs_gone"
  /** triage: leaving a tombstone or a gone row (or creating a row) needs a written outcome, and this one writes none. */
  | "needs_outcome";

export type WritePlan =
  | { action: "skip"; reason: PlanSkipReason }
  | { action: "write"; patch: EmailThreadPatch; insert: boolean; commitmentsToUpsert: NewCommitment[] }
  /** The caller runs the tombstone procedure around this write. The patch is the full row image. */
  | { action: "tombstone"; patch: EmailThreadPatch; insert: boolean };

// ---------------------------------------------------------------------------
// The tombstone whitelist (mirrors exec_email_threads_tombstone_whitelist)
// ---------------------------------------------------------------------------

/**
 * Every content column and the value it must hold on a restricted_hidden row.
 * The migration's CHECK refuses anything else; this is the same list, so the
 * planner refuses it first (rule 6) and a tombstone write nulls all of it.
 */
export const TOMBSTONE_EMPTY = Object.freeze({
  goneAt: null,
  subject: null,
  counterpartName: null,
  counterpartEmail: null,
  // Frozen too: the whitelist is what rule 6 checks against.
  correspondents: Object.freeze([]) as unknown as string[],
  messageCount: 0,
  newestMessageId: null,
  newestInboundMessageId: null,
  newestOutboundMessageId: null,
  lastInboundAt: null,
  lastOutboundAt: null,
  newestIsOutbound: null,
  answeredState: null,
  answeredAt: null,
  answeredMessageId: null,
  partialThread: false,
  outboundAutomatedOnly: false,
  clientId: null,
  clientName: null,
  clientMatchVia: null,
  matchConfidence: null,
  clientCandidates: 0,
  summary: null,
  reason: null,
  category: null,
  urgency: null,
  importance: null,
  needsReply: null,
  mitchellPersonally: null,
  awaitingReplyFromOthers: null,
  decisionQuestion: null,
  decisionMessageId: null,
  clientSignal: null,
  automated: null,
  injectionSuspected: false,
  filterReason: null,
  triageError: null,
  refusalCategory: null,
  contentHash: null,
  model: null,
  triageVersion: null,
  attemptedVersion: null,
  inputWatermark: null,
  outcomeWatermark: null,
  inputTruncated: false,
  bodySource: null,
  triagedAt: null,
  deferredAt: null,
  lastAttemptAt: null,
  lastAttemptError: null
} satisfies { [K in keyof ThreadRowImage]?: ThreadRowImage[K] });

export type TombstoneEmptyKey = keyof typeof TOMBSTONE_EMPTY;

/** The columns a tombstone keeps: no mail content, only what keeps it closed and lets it expire. */
export const TOMBSTONE_KEPT = Object.freeze([
  "accountId",
  "state",
  "snapshotIdentityCount",
  "snapshotMaxCreatedAt",
  "snapshotMaxSentAt",
  "snapshotReadStartedAt",
  "snapshotReadDoneAt",
  "screenHashes",
  "screenTruncated",
  "screenedPolicyHash",
  "firstSeenAt",
  "expiresAt"
] as const satisfies readonly (keyof ThreadRowImage)[]);

const IMAGE_KEYS = [...(Object.keys(TOMBSTONE_EMPTY) as TombstoneEmptyKey[]), ...TOMBSTONE_KEPT] as (keyof ThreadRowImage)[];

/** Timestamp columns: compared as instants, never as text ("Z" and "+00:00" are the same time). */
const TIME_KEYS: ReadonlySet<keyof ThreadRowImage> = new Set<keyof ThreadRowImage>([
  "snapshotMaxCreatedAt",
  "snapshotMaxSentAt",
  "snapshotReadStartedAt",
  "snapshotReadDoneAt",
  "goneAt",
  "lastInboundAt",
  "lastOutboundAt",
  "answeredAt",
  "inputWatermark",
  "outcomeWatermark",
  "triagedAt",
  "deferredAt",
  "lastAttemptAt",
  "firstSeenAt",
  "expiresAt"
]);

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const MAX_DATE_MS = 8.64e15;
const HEX64 = /^[0-9a-f]{64}$/;

function refuse(message: string): never {
  // Store refusals are programming errors (L6): the job dead-letters instead
  // of retrying the same bug. Messages name fields, never values.
  throw new NonRetryableError(`email state: ${message}`);
}

/** A stored or proposed timestamp as epoch ms; null for null/unparseable. */
export function toMs(iso: string | null | undefined): number | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function isoOf(ms: number, field: string): string {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) refuse(`${field} is not a usable time`);
  return new Date(ms).toISOString();
}

function msField(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > MAX_DATE_MS) refuse(`${field} must be epoch milliseconds`);
  return v;
}

function msOrNull(v: unknown, field: string): number | null {
  return v === null ? null : msField(v, field);
}

/** A proposed ISO time (facts), checked; null stays null. */
function isoOrNullField(v: unknown, field: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || toMs(v) === null) refuse(`${field} is not a timestamp`);
  return v;
}

// Postgres text can't hold NUL, and a lone surrogate from a clip in the middle
// of an emoji is invalid in the JSON PostgREST sends. Either would fail the
// write for the whole thread, so text is cleaned and clipped by code point
// (char_length counts code points too).
function cleanText(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/\u0000/g, "").replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
}

function clip(v: unknown, max: number, field: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") refuse(`${field} must be text`);
  const points = Array.from(cleanText(v));
  const s = (points.length > max ? points.slice(0, max) : points).join("");
  return s.length > 0 ? s : null;
}

function idOrNull(v: unknown, field: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || v.length === 0 || v.length > 200) refuse(`${field} must be an id`);
  return v;
}

function boolOrNull(v: unknown, field: string): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "boolean") refuse(`${field} must be a boolean`);
  return v;
}

function bool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") refuse(`${field} must be a boolean`);
  return v;
}

function count(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) refuse(`${field} must be a whole number`);
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string): T | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) refuse(`${field} is not an allowed value`);
  return v as T;
}

function hashField(v: unknown, field: string): string {
  if (typeof v !== "string" || !HEX64.test(v)) refuse(`${field} must be a sha256 hex digest`);
  return v;
}

function hashList(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((h) => typeof h !== "string" || h.length === 0)) refuse(`${field} must be a list of screening hashes`);
  return v as string[];
}

/** The stored hashes of a row. Unreadable ones can't be screened, so the write is refused rather than guessed. */
function storedHashes(row: ExecEmailThread): string[] {
  return hashList(row.screenHashes, "the stored screen_hashes");
}

/** A stored truncation flag: anything but an explicit false counts as truncated (fail closed). */
const storedTruncated = (row: ExecEmailThread | null): boolean => row !== null && row.screenTruncated !== false;

/** union(a, b), sorted; `stored` is what fits in a row, `all` is what a screen must see. */
function mergeHashes(a: readonly string[], b: readonly string[]): { all: string[]; stored: string[]; overflow: boolean } {
  const all = [...new Set([...a, ...b])].sort();
  return { all, stored: all.slice(0, SCREEN_HASH_LIMIT), overflow: all.length > SCREEN_HASH_LIMIT };
}

function checkSnapshot(s: unknown, field: string): ThreadSnapshot {
  if (typeof s !== "object" || s === null) refuse(`${field} is missing`);
  const o = s as Record<string, unknown>;
  count(o.identityCount, `${field}.identityCount`);
  msOrNull(o.maxCreatedAtMs, `${field}.maxCreatedAtMs`);
  msOrNull(o.maxSentAtMs, `${field}.maxSentAtMs`);
  msField(o.readStartedAtMs, `${field}.readStartedAtMs`);
  msField(o.readDoneAtMs, `${field}.readDoneAtMs`);
  return s as ThreadSnapshot;
}

function checkScreen(s: unknown, field: string): ReadScreen {
  if (typeof s !== "object" || s === null) refuse(`${field} is missing`);
  const o = s as Record<string, unknown>;
  if (o.verdict !== "clean" && o.verdict !== "restricted") refuse(`${field}.verdict is not a verdict`);
  hashList(o.hashes, `${field}.hashes`);
  bool(o.truncated, `${field}.truncated`);
  return s as ReadScreen;
}

function checkContext(ctx: WriteContext): void {
  if (!ctx || !Array.isArray(ctx.rules)) refuse("the write context has no rules");
  hashField(ctx.currentPolicyHash, "the current policy hash");
  if (!(ctx.now instanceof Date) || !Number.isFinite(ctx.now.getTime())) refuse("the write context has no clock");
  if (!Number.isSafeInteger(ctx.retentionDays) || ctx.retentionDays < 1 || ctx.retentionDays > 3650) {
    refuse("the retention days are out of range");
  }
}

// ---------------------------------------------------------------------------
// Snapshot ordering (A4)
// ---------------------------------------------------------------------------

/**
 * The snapshot behind a stored row's facts, or null when the row has none
 * (snapshot_read_done_at null: never read, or a tombstone written without one).
 * A missing start time reads as the end time, which can only make the row look
 * newer, so it fails closed.
 */
export function rowSnapshot(
  row: Pick<
    ExecEmailThread,
    "snapshotIdentityCount" | "snapshotMaxCreatedAt" | "snapshotMaxSentAt" | "snapshotReadStartedAt" | "snapshotReadDoneAt"
  >
): ThreadSnapshot | null {
  const readDoneAtMs = toMs(row.snapshotReadDoneAt);
  if (readDoneAtMs === null) return null;
  return {
    identityCount: Number.isSafeInteger(row.snapshotIdentityCount) && row.snapshotIdentityCount >= 0 ? row.snapshotIdentityCount : 0,
    maxCreatedAtMs: toMs(row.snapshotMaxCreatedAt),
    maxSentAtMs: toMs(row.snapshotMaxSentAt),
    readStartedAtMs: toMs(row.snapshotReadStartedAt) ?? readDoneAtMs,
    readDoneAtMs
  };
}

const orMin = (ms: number | null): number => (ms === null ? Number.NEGATIVE_INFINITY : ms);

/**
 * a is newer than b (A4). The clone has one primary, so a read that started
 * after another finished (beyond SNAPSHOT_SKEW_MS of clock skew between DD
 * processes) saw a state at least as new. Overlapping reads can't be ordered
 * by time, so the one that saw more distinct messages wins, then the later
 * max ingest time. No stored snapshot: anything is newer.
 */
export function newerSnapshot(a: ThreadSnapshot, b: ThreadSnapshot | null): boolean {
  if (b === null) return true;
  if (a.readStartedAtMs > b.readDoneAtMs + SNAPSHOT_SKEW_MS) return true;
  if (b.readStartedAtMs > a.readDoneAtMs + SNAPSHOT_SKEW_MS) return false;
  if (a.identityCount !== b.identityCount) return a.identityCount > b.identityCount;
  return orMin(a.maxCreatedAtMs) > orMin(b.maxCreatedAtMs);
}

/** ¬newer(b, a): a is at least as new as b. No stored snapshot: true. */
export function sameOrNewerSnapshot(a: ThreadSnapshot, b: ThreadSnapshot | null): boolean {
  return b === null || !newerSnapshot(b, a);
}

/** a started strictly after b finished (plus skew): the only order that holds across hard deletes (amendments-7(d)). */
function happensAfter(a: ThreadSnapshot, b: ThreadSnapshot | null): boolean {
  return b !== null && a.readStartedAtMs > b.readDoneAtMs + SNAPSHOT_SKEW_MS;
}

function snapshotColumns(s: ThreadSnapshot | null): Pick<
  ThreadRowImage,
  "snapshotIdentityCount" | "snapshotMaxCreatedAt" | "snapshotMaxSentAt" | "snapshotReadStartedAt" | "snapshotReadDoneAt"
> {
  if (s === null) {
    return { snapshotIdentityCount: 0, snapshotMaxCreatedAt: null, snapshotMaxSentAt: null, snapshotReadStartedAt: null, snapshotReadDoneAt: null };
  }
  return {
    snapshotIdentityCount: s.identityCount,
    snapshotMaxCreatedAt: s.maxCreatedAtMs === null ? null : isoOf(s.maxCreatedAtMs, "snapshot.maxCreatedAtMs"),
    snapshotMaxSentAt: s.maxSentAtMs === null ? null : isoOf(s.maxSentAtMs, "snapshot.maxSentAtMs"),
    snapshotReadStartedAt: isoOf(s.readStartedAtMs, "snapshot.readStartedAtMs"),
    snapshotReadDoneAt: isoOf(s.readDoneAtMs, "snapshot.readDoneAtMs")
  };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * When a thread row expires: its newest activity (inbound or outbound) plus
 * the retention days, else first_seen_at plus them. Never "now", so rewrites
 * of an old thread don't keep extending what is kept.
 */
export function threadExpiresAt(
  row: Pick<ExecEmailThread, "lastInboundAt" | "lastOutboundAt" | "firstSeenAt">,
  retentionDays: number,
  now: Date
): string {
  const activity = [toMs(row.lastInboundAt), toMs(row.lastOutboundAt)].filter((t): t is number => t !== null);
  const base = activity.length > 0 ? Math.max(...activity) : (toMs(row.firstSeenAt) ?? now.getTime());
  return isoOf(base + retentionDays * DAY_MS, "expires_at");
}

/** When a commitment expires: greatest(message_sent_at, due_at) plus the retention days (§2.1). */
export function commitmentExpiresAt(c: { messageSentAt: string; dueAt: string | null }, retentionDays: number): string {
  const sent = toMs(c.messageSentAt);
  if (sent === null) refuse("commitment.messageSentAt is not a timestamp");
  const due = toMs(c.dueAt);
  return isoOf(Math.max(sent, due ?? sent) + retentionDays * DAY_MS, "commitment expires_at");
}

// ---------------------------------------------------------------------------
// Row images
// ---------------------------------------------------------------------------

function imageOf(row: ExecEmailThread): ThreadRowImage {
  const out: Record<string, unknown> = {};
  for (const k of IMAGE_KEYS) {
    const v = row[k];
    out[k] = Array.isArray(v) ? [...v] : v;
  }
  return out as ThreadRowImage;
}

/** The starting image of a row that doesn't exist yet. */
function newImage(accountId: string, nowIso: string): ThreadRowImage {
  return {
    ...TOMBSTONE_EMPTY,
    correspondents: [],
    accountId,
    // Always replaced by the outcome before the plan is returned.
    state: "triaged",
    ...snapshotColumns(null),
    screenHashes: [],
    screenTruncated: false,
    screenedPolicyHash: null,
    firstSeenAt: nowIso,
    expiresAt: nowIso
  };
}

function sameValue(key: keyof ThreadRowImage, a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  }
  if (TIME_KEYS.has(key) && typeof a === "string" && typeof b === "string") {
    const ta = toMs(a);
    const tb = toMs(b);
    if (ta !== null && tb !== null) return ta === tb;
  }
  return a === b;
}

/**
 * Rule 6 and the gone invariant. A tombstone holds no content (the CHECK's
 * list); a gone row, and only a gone row, has gone_at. Planner output that
 * breaks either is a bug, refused before it reaches the database.
 */
export function assertThreadRowInvariants(image: Pick<ThreadRowImage, "state"> & Partial<ThreadRowImage>): void {
  if (image.state === "restricted_hidden") {
    for (const key of Object.keys(TOMBSTONE_EMPTY) as TombstoneEmptyKey[]) {
      if (!(key in image)) continue;
      if (!sameValue(key, image[key], TOMBSTONE_EMPTY[key])) refuse(`a tombstone would carry ${key}`);
    }
  }
  if ("goneAt" in image && (image.state === "gone") !== (image.goneAt !== null && image.goneAt !== undefined)) {
    refuse("gone_at must be set exactly on gone rows");
  }
}

function finish(
  row: ExecEmailThread | null,
  next: ThreadRowImage,
  kind: "write" | "tombstone",
  commitments: NewCommitment[] = []
): WritePlan {
  assertThreadRowInvariants(next);
  if (kind === "tombstone") {
    // The full image: whatever the row held, every content column is written
    // empty, not just the ones that differ.
    return { action: "tombstone", patch: { ...next, correspondents: [...next.correspondents] }, insert: row === null };
  }
  if (row === null) return { action: "write", patch: { ...next }, insert: true, commitmentsToUpsert: commitments };
  const current = imageOf(row);
  const patch: Record<string, unknown> = {};
  for (const k of IMAGE_KEYS) if (!sameValue(k, current[k], next[k])) patch[k] = next[k];
  if (Object.keys(patch).length === 0) return { action: "skip", reason: "noop" };
  return { action: "write", patch: patch as EmailThreadPatch, insert: false, commitmentsToUpsert: commitments };
}

const skip = (reason: PlanSkipReason): WritePlan => ({ action: "skip", reason });

// ---------------------------------------------------------------------------
// Rule 1: tombstone (always allowed: the fail-closed direction)
// ---------------------------------------------------------------------------

type TombstoneInput = Omit<TombstoneProposal, "kind">;

function tombstoneImage(row: ExecEmailThread | null, t: TombstoneInput, ctx: WriteContext): ThreadRowImage {
  const policyHash = hashField(t.policyHash, "tombstone.policyHash");
  const proposed = t.hashes === null || t.hashes === undefined ? [] : hashList(t.hashes, "tombstone.hashes");
  const snapshot = t.snapshot === null || t.snapshot === undefined ? null : checkSnapshot(t.snapshot, "tombstone.snapshot");
  // Tombstones keep and union their hashes too (A1): a rule removal is only
  // ever judged against everything this thread was ever seen with.
  const union = mergeHashes(row === null ? [] : storedHashes(row), proposed);
  const rowSnap = row === null ? null : rowSnapshot(row);
  const accountId = row?.accountId ?? idOrNull(t.accountId, "tombstone.accountId");
  if (!accountId) refuse("a tombstone for a thread with no row needs its account id");
  const nowIso = ctx.now.toISOString();
  const firstSeenAt = row?.firstSeenAt ?? nowIso;
  // Expiry comes from the activity the row had before it was emptied, and a
  // tombstone keeps the expiry it got when it was first written.
  const expiresAt =
    row?.state === "restricted_hidden" ? row.expiresAt : threadExpiresAt(row ?? { lastInboundAt: null, lastOutboundAt: null, firstSeenAt }, ctx.retentionDays, ctx.now);
  let kept = snapshot !== null && newerSnapshot(snapshot, rowSnap) ? snapshot : rowSnap;
  // A content row emptied without a read of its own (reconcile's ruled feed
  // row, the attention pass's stamp, a restricted gone row) is dated to the
  // moment it was emptied: the verdict comes from what that writer saw just
  // now, and the stored read is older. Kept as it was, a truncated tombstone
  // whose ruled hash fell past the cap could be left by any in-flight read
  // that started after the old stored read but before the ruled mail
  // arrived (data-1): rule 5(c) needs a read that started after read_done.
  // Only read_done moves, and only forward, so the row can only look newer:
  // fail closed. A tombstone that already exists keeps its own snapshot.
  if (snapshot === null && kept !== null && row !== null && row.state !== "restricted_hidden") {
    kept = { ...kept, readDoneAtMs: Math.max(kept.readDoneAtMs, ctx.now.getTime()) };
  }
  return {
    ...TOMBSTONE_EMPTY,
    correspondents: [],
    accountId,
    state: "restricted_hidden",
    ...snapshotColumns(kept),
    screenHashes: union.stored,
    screenTruncated: storedTruncated(row) || t.truncated === true || union.overflow,
    screenedPolicyHash: policyHash,
    firstSeenAt,
    expiresAt
  };
}

/**
 * The full row image of a tombstone (§3.2): every content column empty (the
 * whitelist), hashes = union(stored, proposed) with A1's truncation rule,
 * the snapshot replaced only by a newer one (a proposal without one, over a
 * content row, keeps the row's but dated done at ctx.now: data-1),
 * screened_policy_hash = the proposal's. `p.accountId` is needed only when
 * there is no row.
 */
export function tombstonePatch(current: ExecEmailThread | null, p: TombstoneInput, ctx: WriteContext): EmailThreadPatch {
  checkContext(ctx);
  return tombstoneImage(current, p, ctx);
}

function planTombstone(row: ExecEmailThread | null, t: TombstoneInput, ctx: WriteContext): WritePlan {
  const next = tombstoneImage(row, t, ctx);
  // An existing tombstone is refreshed in place (hashes, a newer snapshot,
  // the stamp); anything else becomes one through the tombstone procedure.
  return finish(row, next, row?.state === "restricted_hidden" ? "write" : "tombstone");
}

// ---------------------------------------------------------------------------
// Rule 2: gone (the clone's own 404 for the thread)
// ---------------------------------------------------------------------------

function planGone(row: ExecEmailThread | null, p: { atMs: number }, ctx: WriteContext): WritePlan {
  const atMs = msField(p.atMs, "gone.atMs");
  if (row === null) return skip("no_row");
  if (row.state === "restricted_hidden") return skip("tombstone");
  // A gone row keeps its content under retention and is screened like a live
  // one; one that is restricted (or truncated and screened under another
  // policy, so possibly restricted) can never be re-read, so it is emptied.
  const screen = screenStoredRow(row, ctx.rules, ctx.currentPolicyHash);
  if (screen.verdict === "restricted") {
    return planTombstone(row, { snapshot: null, hashes: null, truncated: null, policyHash: ctx.currentPolicyHash }, ctx);
  }
  // A later 404 only moves gone_at forward: revival needs a read that started
  // after the last 404 read finished.
  const prior = row.state === "gone" ? toMs(row.goneAt) : null;
  const next: ThreadRowImage = {
    ...imageOf(row),
    state: "gone",
    goneAt: isoOf(prior === null ? atMs : Math.max(prior, atMs), "gone_at"),
    screenedPolicyHash: ctx.currentPolicyHash
  };
  return finish(row, next, "write");
}

// ---------------------------------------------------------------------------
// Rule 4: stamp (the attention pass's re-screen under the current policy)
// ---------------------------------------------------------------------------

/**
 * Rule 4's decision for one stored row under the current policy, on the
 * screen columns alone, so the attention pass can decide over its narrow
 * RescreenRows (listRescreenBatch) and bulk-stamp:
 *   "stamp"            write screened_policy_hash = H (stampScreened; a
 *                      tombstone still restricted under H is stamped too);
 *   "tombstone"        the row must be emptied (applyThreadProposal with the
 *                      stamp proposal runs the tombstone procedure);
 *   "needs_fresh_read" truncated hashes under another policy (a live row, or a
 *                      clean truncated tombstone): enqueue a policy re-triage;
 *   "needs_retriage"   a tombstone clean under H: enqueue a policy re-triage;
 *   "already_stamped" / "no_row": nothing to do.
 */
export type StampDecision = "no_row" | "already_stamped" | "stamp" | "tombstone" | "needs_fresh_read" | "needs_retriage";

export function stampDecision(
  row: Pick<ExecEmailThread, "state" | "screenHashes" | "screenTruncated" | "screenedPolicyHash"> | null,
  ctx: Pick<WriteContext, "rules" | "currentPolicyHash">
): StampDecision {
  if (row === null) return "no_row";
  const H = ctx.currentPolicyHash;
  if (row.screenedPolicyHash === H) return "already_stamped";
  if (row.state === "restricted_hidden") {
    // Still restricted under H: record that, so the pass stops revisiting it.
    if (!Array.isArray(row.screenHashes) || screenByHashes(row.screenHashes, ctx.rules).verdict === "restricted") return "stamp";
    // Clean under H. Only a fresh, clean read can leave a tombstone; a
    // truncated one needs a strictly later read (rule 5(c)).
    return row.screenTruncated !== false ? "needs_fresh_read" : "needs_retriage";
  }
  const screen = screenStoredRow(row, ctx.rules, H);
  if (screen.verdict === "restricted") {
    // Truncated and screened under another policy: the missing hashes might
    // match. A live row gets a fresh read; a gone one can't, so it is emptied.
    if (screen.reason === "stale_truncated" && row.state !== "gone") return "needs_fresh_read";
    return "tombstone";
  }
  return "stamp";
}

function planStamp(row: ExecEmailThread | null, p: { policyHash: string }, ctx: WriteContext): WritePlan {
  hashField(p.policyHash, "stamp.policyHash");
  const decision = stampDecision(row, ctx);
  if (row === null || decision === "no_row") return skip("no_row");
  switch (decision) {
    case "stamp":
      return finish(row, { ...imageOf(row), screenedPolicyHash: ctx.currentPolicyHash }, "write");
    case "tombstone":
      return planTombstone(row, { snapshot: null, hashes: null, truncated: null, policyHash: ctx.currentPolicyHash }, ctx);
    default:
      return skip(decision);
  }
}

// ---------------------------------------------------------------------------
// hashes: union a clean early screen into a row the job won't otherwise write
// ---------------------------------------------------------------------------

function planHashes(
  row: ExecEmailThread | null,
  p: { snapshot: ThreadSnapshot; screen: ReadScreen; policyHash: string },
  ctx: WriteContext
): WritePlan {
  const snapshot = checkSnapshot(p.snapshot, "hashes.snapshot");
  const screen = checkScreen(p.screen, "hashes.screen");
  const policyHash = hashField(p.policyHash, "hashes.policyHash");
  if (row === null) return skip("no_row");
  const H = ctx.currentPolicyHash;
  if (screen.verdict === "restricted") {
    return planTombstone(row, { snapshot, hashes: screen.hashes, truncated: screen.truncated, policyHash }, ctx);
  }
  const union = mergeHashes(storedHashes(row), screen.hashes);
  if (screenByHashes(union.all, ctx.rules).verdict === "restricted") {
    return planTombstone(row, { snapshot, hashes: screen.hashes, truncated: screen.truncated, policyHash: H }, ctx);
  }
  const truncated = storedTruncated(row) || screen.truncated || union.overflow;
  const next: ThreadRowImage = { ...imageOf(row), screenHashes: union.stored, screenTruncated: truncated };
  // A tombstone's stamp is left alone: stamping a clean one with H would stop
  // the attention pass from ever sending it back for the re-triage that can
  // exit it. A live row is stamped when its complete hashes were just
  // screened clean under H, or when this read is newer than its facts and was
  // itself screened clean under H.
  if (row.state !== "restricted_hidden" && (!truncated || (newerSnapshot(snapshot, rowSnapshot(row)) && policyHash === H))) {
    next.screenedPolicyHash = H;
  }
  return finish(row, next, "write");
}

// ---------------------------------------------------------------------------
// Rule 5: triage
// ---------------------------------------------------------------------------

const ANSWERED_STATES = ["awaiting_reply", "answered", "no_inbound"] as const;
const MATCH_VIA = ["exact", "domain"] as const;
const CONFIDENCES = ["high", "medium", "low"] as const;
const CATEGORIES = [
  "client",
  "prospect",
  "partner_vendor",
  "internal_team",
  "finance_admin",
  "legal",
  "recruiting",
  "personal",
  "newsletter_marketing",
  "notification",
  "calendar",
  "other"
] as const;
const URGENCIES = ["critical", "high", "normal", "low"] as const;
const IMPORTANCES = ["high", "normal", "low"] as const;
const CLIENT_SIGNALS = ["none", "complaint", "churn_risk", "outage_or_breakage", "billing_or_legal_dispute", "praise"] as const;
const FILTER_REASONS = ["unreplyable", "automated_hint"] as const;
const TRIAGE_ERRORS = ["refusal", "truncated", "invalid_output", "input_too_large"] as const;
const BODY_SOURCES = ["html", "text", "preview_stub", "mixed", "empty"] as const;

/** The facts as stored: checked, clipped to the column limits (§2.1), cleaned. */
function factColumns(f: ThreadFacts): ThreadFacts {
  if (typeof f !== "object" || f === null) refuse("triage.facts is missing");
  const accountId = idOrNull(f.accountId, "facts.accountId");
  if (!accountId) refuse("facts.accountId is required");
  if (!Array.isArray(f.correspondents)) refuse("facts.correspondents must be a list");
  const correspondents: string[] = [];
  for (const c of f.correspondents) {
    // Display addresses of his messages; an over-long one is dropped, not cut.
    if (typeof c === "string" && c.length > 0 && c.length <= 320 && !c.includes("\u0000") && !correspondents.includes(c)) correspondents.push(c);
    if (correspondents.length === CORRESPONDENTS_LIMIT) break;
  }
  const email = typeof f.counterpartEmail === "string" && f.counterpartEmail.length > 0 && f.counterpartEmail.length <= 320 ? f.counterpartEmail : null;
  return {
    accountId,
    subject: clip(f.subject, 200, "facts.subject"),
    counterpartName: clip(f.counterpartName, 120, "facts.counterpartName"),
    counterpartEmail: email === null ? null : clip(email, 320, "facts.counterpartEmail"),
    correspondents,
    messageCount: count(f.messageCount, "facts.messageCount"),
    newestMessageId: idOrNull(f.newestMessageId, "facts.newestMessageId"),
    newestInboundMessageId: idOrNull(f.newestInboundMessageId, "facts.newestInboundMessageId"),
    newestOutboundMessageId: idOrNull(f.newestOutboundMessageId, "facts.newestOutboundMessageId"),
    lastInboundAt: isoOrNullField(f.lastInboundAt, "facts.lastInboundAt"),
    lastOutboundAt: isoOrNullField(f.lastOutboundAt, "facts.lastOutboundAt"),
    newestIsOutbound: boolOrNull(f.newestIsOutbound, "facts.newestIsOutbound"),
    answeredState: oneOf(f.answeredState, ANSWERED_STATES, "facts.answeredState"),
    answeredAt: isoOrNullField(f.answeredAt, "facts.answeredAt"),
    answeredMessageId: idOrNull(f.answeredMessageId, "facts.answeredMessageId"),
    partialThread: bool(f.partialThread, "facts.partialThread"),
    outboundAutomatedOnly: bool(f.outboundAutomatedOnly, "facts.outboundAutomatedOnly"),
    clientId: idOrNull(f.clientId, "facts.clientId"),
    clientName: clip(f.clientName, 200, "facts.clientName"),
    clientMatchVia: oneOf(f.clientMatchVia, MATCH_VIA, "facts.clientMatchVia"),
    matchConfidence: oneOf(f.matchConfidence, CONFIDENCES, "facts.matchConfidence"),
    clientCandidates: count(f.clientCandidates, "facts.clientCandidates")
  };
}

function aiColumns(ai: TriageAiFields): TriageAiFields {
  if (typeof ai !== "object" || ai === null) refuse("outcome.ai is missing");
  return {
    summary: clip(ai.summary, 400, "ai.summary"),
    reason: clip(ai.reason, 160, "ai.reason"),
    category: oneOf(ai.category, CATEGORIES, "ai.category"),
    urgency: oneOf(ai.urgency, URGENCIES, "ai.urgency"),
    importance: oneOf(ai.importance, IMPORTANCES, "ai.importance"),
    needsReply: boolOrNull(ai.needsReply, "ai.needsReply"),
    mitchellPersonally: boolOrNull(ai.mitchellPersonally, "ai.mitchellPersonally"),
    awaitingReplyFromOthers: boolOrNull(ai.awaitingReplyFromOthers, "ai.awaitingReplyFromOthers"),
    decisionQuestion: clip(ai.decisionQuestion, 200, "ai.decisionQuestion"),
    decisionMessageId: idOrNull(ai.decisionMessageId, "ai.decisionMessageId"),
    clientSignal: oneOf(ai.clientSignal, CLIENT_SIGNALS, "ai.clientSignal"),
    automated: boolOrNull(ai.automated, "ai.automated"),
    injectionSuspected: bool(ai.injectionSuspected, "ai.injectionSuspected")
  };
}

function runColumns(run: TriageRunFields): Pick<ThreadRowImage, "contentHash" | "inputTruncated" | "bodySource"> & { model: string; triageVersion: string } {
  if (typeof run !== "object" || run === null) refuse("outcome.run is missing");
  const model = clip(run.model, 200, "run.model");
  const triageVersion = clip(run.triageVersion, 100, "run.triageVersion");
  if (!model || !triageVersion) refuse("run.model and run.triageVersion are required");
  const bodySource = oneOf(run.bodySource, BODY_SOURCES, "run.bodySource");
  if (bodySource === null) refuse("run.bodySource is required");
  return {
    contentHash: hashField(run.contentHash, "run.contentHash"),
    model,
    triageVersion,
    inputTruncated: bool(run.inputTruncated, "run.inputTruncated"),
    bodySource
  };
}

function checkOutcome(o: TriageOutcomeProposal): void {
  if (typeof o !== "object" || o === null) refuse("triage.outcome is missing");
  if (!["triaged", "filtered", "failed", "deferred_budget", "unchanged"].includes(o.kind)) refuse("triage.outcome.kind is unknown");
  msOrNull(o.watermarkMs, "outcome.watermarkMs");
}

/** The outcome written in full (rule (f)). AI fields are set only by a triaged outcome and kept through the others. */
function writeOutcome(next: ThreadRowImage, o: Exclude<TriageOutcomeProposal, { kind: "unchanged" }>, nowIso: string): void {
  const w = o.watermarkMs === null ? null : isoOf(o.watermarkMs, "outcome.watermarkMs");
  next.outcomeWatermark = w;
  next.lastAttemptAt = nowIso;
  switch (o.kind) {
    case "triaged": {
      Object.assign(next, aiColumns(o.ai), runColumns(o.run));
      next.state = "triaged";
      next.filterReason = null;
      next.triageError = null;
      next.refusalCategory = null;
      next.triagedAt = nowIso;
      next.deferredAt = null;
      next.lastAttemptError = null;
      // Only a triaged write moves "extracted through" (A5).
      next.inputWatermark = w;
      return;
    }
    case "filtered": {
      const reason = oneOf(o.reason, FILTER_REASONS, "outcome.reason");
      if (reason === null) refuse("outcome.reason is required");
      next.state = "filtered";
      next.filterReason = reason;
      next.triageError = null;
      next.refusalCategory = null;
      next.deferredAt = null;
      next.lastAttemptError = null;
      return;
    }
    case "failed": {
      const error = oneOf(o.error, TRIAGE_ERRORS, "outcome.error");
      if (error === null) refuse("outcome.error is required");
      const run = runColumns(o.run);
      next.state = "triage_failed";
      next.triageError = error;
      next.refusalCategory = clip(o.refusalCategory, 60, "outcome.refusalCategory");
      next.filterReason = null;
      // The hash of the input that failed (a refusal is not re-sent while it
      // is unchanged). model and triage_version keep describing the AI
      // fields, which a failure leaves in place.
      next.contentHash = run.contentHash;
      next.inputTruncated = run.inputTruncated;
      next.bodySource = run.bodySource;
      next.deferredAt = null;
      next.lastAttemptError = error;
      return;
    }
    case "deferred_budget": {
      next.state = "deferred_budget";
      next.deferredAt = nowIso;
      next.filterReason = null;
      next.triageError = null;
      next.refusalCategory = null;
      next.lastAttemptError = "budget";
      return;
    }
  }
}

/** A failure, filter or budget at the watermark a triaged row already has: record the attempt only. */
function writeAttempt(next: ThreadRowImage, o: TriageOutcomeProposal, nowIso: string): void {
  next.lastAttemptAt = nowIso;
  let error: LastAttemptError | null = null;
  if (o.kind === "failed") error = oneOf(o.error, TRIAGE_ERRORS, "outcome.error");
  else if (o.kind === "deferred_budget") error = "budget";
  next.lastAttemptError = error;
}

/**
 * Rule (i): the commitments a triaged write may store. x is the row's
 * input_watermark as read in this attempt; a commitment survives when its
 * message was ingested after x minus the settle margin (a message committed
 * late, behind a newer one, still counts), or always on a first extraction.
 * The per-message dedupe happens in the insert RPC at write time.
 */
function keptCommitments(commitments: readonly NewCommitment[], xMs: number | null): NewCommitment[] {
  if (!Array.isArray(commitments)) refuse("triage.commitments must be a list");
  if (xMs === null) return [...commitments];
  return commitments.filter((c) => typeof c.messageCreatedAtMs === "number" && Number.isFinite(c.messageCreatedAtMs) && c.messageCreatedAtMs > xMs - NEW_MARK_SETTLE_MS);
}

type TriageProposal = Extract<ThreadProposal, { kind: "triage" }>;

function planTriage(row: ExecEmailThread | null, p: TriageProposal, ctx: WriteContext): WritePlan {
  const snapshot = checkSnapshot(p.snapshot, "triage.snapshot");
  const screen = checkScreen(p.screen, "triage.screen");
  const policyHash = hashField(p.policyHash, "triage.policyHash");
  checkOutcome(p.outcome);
  const facts = factColumns(p.facts);
  const H = ctx.currentPolicyHash;

  // (a) The read is restricted: tombstone, stamped with the policy it was
  // screened under (P3 screens dd_only exactly as hidden, L31).
  if (screen.verdict === "restricted") {
    return planTombstone(row, { snapshot, hashes: screen.hashes, truncated: screen.truncated, policyHash, accountId: facts.accountId }, ctx);
  }

  // (b) Everything this thread was ever seen with, under the rules of this
  // attempt. A stale read can't hide an address a newer read stored.
  const union = mergeHashes(row === null ? [] : storedHashes(row), screen.hashes);
  if (screenByHashes(union.all, ctx.rules).verdict === "restricted") {
    return planTombstone(row, { snapshot, hashes: screen.hashes, truncated: screen.truncated, policyHash: H, accountId: facts.accountId }, ctx);
  }
  const truncated = storedTruncated(row) || screen.truncated || union.overflow;
  const rowSnap = row === null ? null : rowSnapshot(row);

  let factsApply: boolean;
  let leaving: "tombstone" | "gone" | null = null;
  if (row?.state === "restricted_hidden") {
    // (c) Leave a tombstone only on a clean read screened under the current
    // policy that is at least as new (strictly later when any hashes may be
    // missing, A1/amendments-7(d)). Its facts then apply in full.
    const fresh = truncated ? happensAfter(snapshot, rowSnap) : sameOrNewerSnapshot(snapshot, rowSnap);
    if (policyHash !== H || !fresh) return skip("stale_vs_tombstone");
    leaving = "tombstone";
    factsApply = true;
  } else if (row?.state === "gone") {
    // (d) A clone 404 is permanent; only a read that started after the 404
    // read finished may write here again (amendments-7(a)).
    const goneAtMs = toMs(row.goneAt);
    if (goneAtMs === null || !(snapshot.readStartedAtMs > goneAtMs + SNAPSHOT_SKEW_MS)) return skip("stale_vs_gone");
    leaving = "gone";
    factsApply = sameOrNewerSnapshot(snapshot, rowSnap);
  } else {
    // (e) Facts only from a read at least as new as the stored one.
    factsApply = row === null || sameOrNewerSnapshot(snapshot, rowSnap);
  }

  // (f) The outcome, against the stored outcome watermark. A row being
  // created or left (tombstone, gone) has nothing to compare with.
  const o = p.outcome;
  const w = o.watermarkMs;
  const s = row === null || leaving !== null ? null : toMs(row.outcomeWatermark);
  let mode: "full" | "attempt" | "none";
  if (o.kind === "unchanged") mode = "none";
  else if (row === null || leaving !== null || s === null) mode = "full";
  else if (w === null || w < s) mode = "none";
  else if (w > s) mode = "full";
  else if (o.kind === "triaged") mode = sameOrNewerSnapshot(snapshot, rowSnap) ? "full" : "none";
  else mode = row.state === "triaged" ? "attempt" : "full";
  if ((row === null || leaving !== null) && mode !== "full") return skip("needs_outcome");

  const nowIso = ctx.now.toISOString();
  const next: ThreadRowImage = row === null ? newImage(facts.accountId, nowIso) : imageOf(row);
  if (factsApply) Object.assign(next, facts, snapshotColumns(snapshot));
  // (e′) Monotonic screening hashes, sticky truncation (A1).
  next.screenHashes = union.stored;
  next.screenTruncated = truncated;
  // (g) Stamp H only when it is provably right: the complete hash set was
  // just screened clean under H, or this read (newer than the stored facts)
  // was itself screened clean under H. Otherwise the stamp stays and the
  // attention pass sends the row to a fresh re-triage.
  if (!truncated || (factsApply && policyHash === H)) next.screenedPolicyHash = H;
  if (mode === "full") writeOutcome(next, o as Exclude<TriageOutcomeProposal, { kind: "unchanged" }>, nowIso);
  else if (mode === "attempt") writeAttempt(next, o, nowIso);
  if (leaving === "gone") next.goneAt = null;
  // (h) The version sweep keys on this; a budget deferral didn't attempt anything.
  if (o.kind !== "deferred_budget") next.attemptedVersion = TRIAGE_VERSION;
  if (factsApply) next.expiresAt = threadExpiresAt(next, ctx.retentionDays, ctx.now);

  // (i) Commitments ride only on a triaged outcome written in full.
  const xMs = row === null || leaving === "tombstone" ? null : toMs(row.inputWatermark);
  const commitments = mode === "full" && o.kind === "triaged" ? keptCommitments(p.commitments, xMs) : [];
  return finish(row, next, "write", commitments);
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * What a writer may do to one thread row. `current` is the row as read in
 * this attempt (null: none). Never does I/O. Throws NonRetryableError for a
 * malformed proposal or context, which is always a programming error.
 */
export function planThreadWrite(current: ExecEmailThread | null, p: ThreadProposal, ctx: WriteContext): WritePlan {
  checkContext(ctx);
  if (current !== null && (typeof current !== "object" || typeof current.state !== "string")) refuse("the stored row is malformed");
  switch (p?.kind) {
    case "tombstone":
      return planTombstone(current, p, ctx);
    case "gone":
      return planGone(current, p, ctx);
    case "stamp":
      return planStamp(current, p, ctx);
    case "hashes":
      return planHashes(current, p, ctx);
    case "triage":
      return planTriage(current, p, ctx);
    default:
      return refuse("unknown proposal kind");
  }
}

/** Whether a stamp plan's skip asks the caller for a policy re-triage (the attention pass). */
export function stampNeedsRetriage(plan: WritePlan): boolean {
  return plan.action === "skip" && (plan.reason === "needs_fresh_read" || plan.reason === "needs_retriage");
}

export type { ScreenVerdict };
