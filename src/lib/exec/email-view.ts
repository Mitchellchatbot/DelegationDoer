import "server-only";

import { listAttentionForThread, parseEmailFingerprint } from "@/lib/exec/attention";
import type { AttentionItem } from "@/lib/exec/attention-types";
import { isActiveClientStatus } from "@/lib/exec/correlate";
import {
  bucketOf,
  getEmailThread,
  listBucketRows,
  listCommitments,
  listSignalsForMessages,
  listThreadScreenRows,
  listTombstonedThreadIds,
  type BucketRow
} from "@/lib/exec/email-store";
import { buildEmailSrcdoc } from "@/lib/exec/email-srcdoc";
import type {
  AnsweredState,
  ClientMatchVia,
  ClientSignal,
  CommitmentDirection,
  CommitmentStatus,
  EmailBucket,
  EmailCategory,
  EmailThreadState,
  ExecCommitment,
  ExecEmailSignal,
  ExecEmailThread,
  FilterReason,
  HisMessage,
  Importance,
  LastAttemptError,
  MatchConfidence,
  MessageDirection,
  ParsedAddress,
  PrincipalMailThread,
  ReplyArtifacts,
  ThreadScreenRow,
  TriageError,
  Urgency
} from "@/lib/exec/email-types";
import { loadSettings } from "@/lib/exec/principal";
import { SATISFACTION_FRESH_DAYS } from "@/lib/exec/producers/email";
import { ddPageRef, execEmailRef } from "@/lib/exec/refs";
import { latestScoredInboundByClient, listClientMeetings, listClients, listTasksForThread } from "@/lib/exec/sources/dd";
import type { ClientHealthLabel, DdClient, DdTask, TaskPriority, TaskStatus } from "@/lib/exec/sources/dd-types";
import {
  countPendingReplyArtifacts,
  isPartialThread,
  isPinnedAccount,
  listAllReplyArtifacts,
  listReplyArtifacts,
  loadHisBodies,
  loadScreeningPolicy,
  overlayAnswered,
  pinnedAccounts,
  readPrincipalThread,
  screenRestricted,
  screenStoredRow,
  usableAccounts
} from "@/lib/exec/sources/mail";
import {
  getSyncState,
  parseAccountsState,
  parseReconState,
  parseSocketState,
  parseStaggerState,
  problemAccountIds,
  type AccountsState
} from "@/lib/exec/sync-state";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";
import type { RestrictedSenderRule } from "@/lib/restricted-senders";

// What the two email pages show (contract §3.14, L2, L12, v3.1 A2), read in
// one pass on the server, plus the pure pieces the Overview reuses.
//
// Gating, in this order, before anything about his mail is read: the
// migration applied and email switched on (else "off"), then a pinned
// mailbox (else "no pin"). The thread page answers both with a 404.
//
// The restricted-sender screen runs on every stored row before it is used
// (A2): screenStoredRow under the rules loaded strictly for this request and
// their hash H. A row that fails is dropped and counted as restricted; a
// commitment shows only when its own thread row passes; an attention item
// about a thread only when that thread's row passes and isn't gone. The rules
// read is the one read here that isn't allowed to fail soft: without it
// nothing can be screened, so it throws (the page's error boundary).
//
// Every other read fails soft into its own section ({ ok: false }): the page
// says "couldn't load" there, never a zero or an empty list. A deadline
// bounds each group of database reads; the thread page gives its side
// sections their own, started after the clone calls (which have theirs).
//
// Only rows of the mailboxes pinned to him now are shown (a row of an
// account he no longer has pinned 404s on its own page), and Assess is
// offered only where triage would run it: an assessable state on a mailbox
// that isn't a problem account.
//
// Nothing here logs message content: log lines carry the read's name and the
// error, never a subject, an address or a body.

/** A section's data, or the fact that it couldn't be read. */
export type ViewSection<T> = { ok: true; data: T } | { ok: false; error: "unavailable" };

/** Rows listed per bucket. */
export const EMAIL_LIST_LIMIT = 100;
/** Commitments listed on the Email tab. */
export const COMMITMENT_LIST_LIMIT = 20;
/** Messages whose bodies the thread page loads (the newest ones). */
export const THREAD_BODY_LIMIT = 15;
/** Every clone call a page makes (contract §0: 15 s in pages). */
export const PAGE_CLONE_TIMEOUT_MS = 15_000;
/** The whole page's database reads. */
const READ_TIMEOUT_MS = 15_000;
/** The thread page caps plain-text bodies at this many characters. */
const MAX_TEXT_BODY_CHARS = 200_000;

/** The bucket order on the page and in counts. */
export const EMAIL_BUCKETS: readonly EmailBucket[] = Object.freeze(["reply", "urgent", "important", "waiting", "filtered"]);

const UNAVAILABLE = { ok: false, error: "unavailable" } as const;
const DAY_MS = 86_400_000;
const DECISION_WINDOW_DAYS = 30;
// The worker records socket health about once a minute; older than this means it isn't running.
const SOCKET_STALE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function errMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

type Settled<T> = { ok: true; value: T } | { ok: false };

/** Run one read; never rejects. A failure is logged once, with the read's name and the error only. */
function settle<T>(what: string, run: () => Promise<T>): Promise<Settled<T>> {
  return Promise.resolve()
    .then(run)
    .then(
      (value): Settled<T> => ({ ok: true, value }),
      (err): Settled<T> => {
        console.error(`[exec-email-view] ${what} read failed: ${errMessage(err)}`);
        return { ok: false };
      }
    );
}

const ms = (iso: string | null | undefined): number | null => {
  if (typeof iso !== "string" || iso === "") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** The later of two ISO instants; null only when both are. */
function laterIso(a: string | null, b: string | null): string | null {
  const ta = ms(a);
  const tb = ms(b);
  if (ta === null) return tb === null ? null : b;
  if (tb === null) return a;
  return tb > ta ? b : a;
}

/** A thread id as a URL segment may carry one: what the clone issues (UUIDs), never a path or a filter. */
export function isThreadIdParam(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:=+-]{0,199}$/.test(v);
}

/** The assistant's page for one thread. */
export function threadHref(threadId: string): string {
  return `/executive/email/${encodeURIComponent(threadId)}`;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type EmailGate =
  | { kind: "off"; settings: ExecSettings }
  | { kind: "no_pin"; settings: ExecSettings }
  | { kind: "on"; settings: ExecSettings; pinned: readonly string[] };

/**
 * Whether email intelligence runs for him (L1): the migration applied, email
 * switched on, and a pinned mailbox. A failed settings read throws.
 */
export async function loadEmailGate(principal: ExecPrincipal): Promise<EmailGate> {
  const settings = await loadSettings(principal.id);
  if (!settings.emailSchemaReady || !settings.emailEnabled) return { kind: "off", settings };
  const pinned = pinnedAccounts(principal);
  if (pinned.length === 0) return { kind: "no_pin", settings };
  return { kind: "on", settings, pinned };
}

// ---------------------------------------------------------------------------
// Screening and buckets (pure)
// ---------------------------------------------------------------------------

/** The strict, applicable rules and their hash H, as loadScreeningPolicy returns them. */
export interface ScreeningPolicy {
  rules: readonly RestrictedSenderRule[];
  hash: string;
}

/** Rows that pass the render-time screen, and how many didn't. */
export function screenRows<R extends Pick<ThreadScreenRow, "state" | "screenHashes" | "screenTruncated" | "screenedPolicyHash">>(
  rows: readonly R[],
  policy: ScreeningPolicy
): { kept: R[]; dropped: number } {
  const kept: R[] = [];
  let dropped = 0;
  for (const row of rows) {
    if (screenStoredRow(row, policy.rules, policy.hash).verdict === "restricted") dropped += 1;
    else kept.push(row);
  }
  return { kept, dropped };
}

/**
 * Stored rows of the mailboxes pinned to him now (ui-3). A row of a mailbox
 * he no longer has pinned (re-pinned after a reconnect gave it a new id) is
 * left out of every list, count and item: its thread page 404s, and the
 * conversation shows again under the account it lives on now.
 */
export function pinnedRows<R extends Pick<ThreadScreenRow, "accountId">>(principal: ExecPrincipal, rows: readonly R[]): R[] {
  return rows.filter((r) => isPinnedAccount(principal, r.accountId));
}

/** pinnedRows over a by-thread map (commitments and attention items hang off these rows). */
export function pinnedRowMap<R extends Pick<ThreadScreenRow, "accountId">>(principal: ExecPrincipal, rows: ReadonlyMap<string, R>): Map<string, R> {
  return new Map([...rows].filter(([, r]) => isPinnedAccount(principal, r.accountId)));
}

/** The message ids whose CL1 signals the buckets need: each row's newest inbound and its anchor. */
export function signalMessageIds(rows: readonly Pick<BucketRow, "newestInboundMessageId" | "newestMessageId">[]): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.newestInboundMessageId) ids.add(r.newestInboundMessageId);
    if (r.newestMessageId) ids.add(r.newestMessageId);
  }
  return [...ids];
}

/** When the row last saw mail either way (ISO), for sorting and display. */
export function lastActivityAt(row: Pick<BucketRow, "lastInboundAt" | "lastOutboundAt">): string | null {
  return laterIso(row.lastInboundAt, row.lastOutboundAt);
}

function byActivityDesc(a: BucketRow, b: BucketRow): number {
  const ta = ms(lastActivityAt(a)) ?? 0;
  const tb = ms(lastActivityAt(b)) ?? 0;
  return tb - ta || (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0);
}

export interface Bucketed {
  counts: Record<EmailBucket, number>;
  /** Each bucket's rows, newest activity first, all of them (the caller caps). */
  rows: Record<EmailBucket, BucketRow[]>;
  /** Threads that ask him for a decision and still await his reply (≤30 d). */
  decisionAsks: number;
}

/** The overlaid answered state of a stored row (L3, A3): the newest inbound's CL1 signal and DD's reply artifacts. */
export function answeredOf(
  row: Pick<ExecEmailThread, "answeredState" | "newestInboundMessageId">,
  signals: ReadonlyMap<string, Pick<ExecEmailSignal, "messageId" | "removedAt">>,
  artifacts: ReplyArtifacts | undefined
): AnsweredState | null {
  const inbound = row.newestInboundMessageId ? signals.get(row.newestInboundMessageId) : undefined;
  return overlayAnswered(row, inbound, artifacts);
}

/** Buckets (L12) over rows that already passed the screen. */
export function bucketize(
  rows: readonly BucketRow[],
  signals: ReadonlyMap<string, ExecEmailSignal>,
  artifacts: ReadonlyMap<string, ReplyArtifacts>,
  now: Date
): Bucketed {
  const counts = Object.fromEntries(EMAIL_BUCKETS.map((b) => [b, 0])) as Record<EmailBucket, number>;
  const lists = Object.fromEntries(EMAIL_BUCKETS.map((b) => [b, [] as BucketRow[]])) as Record<EmailBucket, BucketRow[]>;
  let decisionAsks = 0;
  for (const row of rows) {
    const art = artifacts.get(row.threadId);
    for (const bucket of bucketOf(row, signals, art, now)) {
      counts[bucket] += 1;
      lists[bucket].push(row);
    }
    const inboundAt = ms(row.lastInboundAt);
    if (
      row.state === "triaged" &&
      typeof row.decisionQuestion === "string" &&
      row.decisionQuestion.trim() !== "" &&
      answeredOf(row, signals, art) === "awaiting_reply" &&
      inboundAt !== null &&
      now.getTime() - inboundAt <= DECISION_WINDOW_DAYS * DAY_MS
    ) {
      decisionAsks += 1;
    }
  }
  for (const b of EMAIL_BUCKETS) lists[b].sort(byActivityDesc);
  return { counts, rows: lists, decisionAsks };
}

/**
 * Commitments whose own thread row exists, isn't a tombstone or gone, and
 * passes the screen (A2). Everything else is dropped and counted.
 */
export function screenCommitments(
  commitments: readonly ExecCommitment[],
  rowsByThread: ReadonlyMap<string, ThreadScreenRow>,
  policy: ScreeningPolicy
): { kept: ExecCommitment[]; dropped: number } {
  const kept: ExecCommitment[] = [];
  let dropped = 0;
  for (const c of commitments) {
    const row = rowsByThread.get(c.threadId);
    if (!row || row.state === "gone" || screenStoredRow(row, policy.rules, policy.hash).verdict === "restricted") dropped += 1;
    else kept.push(c);
  }
  return { kept, dropped };
}

export interface EmailItemScreen {
  /** Email is on (installed, enabled, pinned): its items may show at all. */
  emailOn: boolean;
  /** null when the rules couldn't be read. */
  policy: ScreeningPolicy | null;
  /** The thread rows of the items' threads; null when that read failed. */
  rowsByThread: ReadonlyMap<string, ThreadScreenRow> | null;
}

/**
 * Source-"email" attention items that may be shown (A2, coherence-9): none
 * while email is off; none when the screen couldn't run (`unchecked`); a
 * thread or commitment item only when its thread has a row that isn't gone
 * and passes the screen. Satisfaction and health items aren't about a
 * thread; the producer screened them. Items from other sources pass as they are.
 */
export function screenEmailAttention(
  items: readonly AttentionItem[],
  screen: EmailItemScreen
): { items: AttentionItem[]; dropped: number; unchecked: boolean } {
  const out: AttentionItem[] = [];
  let dropped = 0;
  let unchecked = false;
  for (const item of items) {
    if (item.source !== "email") {
      out.push(item);
      continue;
    }
    if (!screen.emailOn) {
      dropped += 1;
      continue;
    }
    if (screen.policy === null || screen.rowsByThread === null) {
      dropped += 1;
      unchecked = true;
      continue;
    }
    const parsed = parseEmailFingerprint(item.fingerprint);
    if (parsed === null) {
      dropped += 1;
      continue;
    }
    if (parsed.threadId === null) {
      out.push(item);
      continue;
    }
    const row = screen.rowsByThread.get(parsed.threadId);
    if (!row || row.state === "gone" || screenStoredRow(row, screen.policy.rules, screen.policy.hash).verdict === "restricted") {
      dropped += 1;
      continue;
    }
    out.push(item);
  }
  return { items: out, dropped, unchecked };
}

/** The thread ids the email items hang off (for listThreadScreenRows). */
export function emailItemThreadIds(items: readonly AttentionItem[]): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.source !== "email") continue;
    const threadId = parseEmailFingerprint(item.fingerprint)?.threadId;
    if (threadId) ids.add(threadId);
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

export interface EmailClientView {
  id: string | null;
  name: string;
  via: ClientMatchVia | null;
  confidence: MatchConfidence | null;
}

/** One stored thread as a list row. Times are ISO; the page formats them in his zone. */
export interface EmailRowView {
  threadId: string;
  href: string;
  /** His newest message's subject (≤200), or null. */
  subject: string | null;
  counterpartName: string | null;
  counterpartEmail: string | null;
  messageCount: number;
  lastActivityAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  state: EmailThreadState;
  answered: AnsweredState | null;
  summary: string | null;
  reason: string | null;
  category: EmailCategory | null;
  urgency: Urgency | null;
  importance: Importance | null;
  needsReply: boolean | null;
  decisionQuestion: string | null;
  clientSignal: ClientSignal | null;
  injectionSuspected: boolean;
  client: EmailClientView | null;
  /** Flagged in Outlook (CL1 signal of the anchor message). */
  flagged: boolean;
  partialThread: boolean;
  filterReason: FilterReason | null;
  triageError: TriageError | null;
  lastAttemptError: LastAttemptError | null;
  /** Filtered, failed or deferred, on a mailbox triage can read: Assess can run the model on it. */
  assessable: boolean;
}

const ASSESSABLE: ReadonlySet<EmailThreadState> = new Set<EmailThreadState>(["filtered", "triage_failed", "deferred_budget"]);

export function isAssessableState(state: EmailThreadState): boolean {
  return ASSESSABLE.has(state);
}

function clientView(row: Pick<BucketRow, "clientId" | "clientName" | "clientMatchVia" | "matchConfidence">): EmailClientView | null {
  if (!row.clientName && !row.clientId) return null;
  return { id: row.clientId, name: row.clientName ?? "Client", via: row.clientMatchVia, confidence: row.matchConfidence };
}

/**
 * One stored row as the page shows it. `accountUsable: false` (its mailbox is
 * a problem account) withholds Assess: triage reads only usable mailboxes and
 * would skip the job (ui-2). Unknown (the mailbox state couldn't be read)
 * leaves it to the route, which checks again.
 */
export function rowView(
  row: BucketRow,
  signals: ReadonlyMap<string, ExecEmailSignal>,
  artifacts: ReplyArtifacts | undefined,
  opts: { accountUsable?: boolean } = {}
): EmailRowView {
  const anchor = row.newestInboundMessageId ?? row.newestMessageId;
  return {
    threadId: row.threadId,
    href: threadHref(row.threadId),
    subject: row.subject,
    counterpartName: row.counterpartName,
    counterpartEmail: row.counterpartEmail,
    messageCount: row.messageCount,
    lastActivityAt: lastActivityAt(row),
    lastInboundAt: row.lastInboundAt,
    lastOutboundAt: row.lastOutboundAt,
    state: row.state,
    answered: answeredOf(row, signals, artifacts),
    summary: row.summary,
    reason: row.reason,
    category: row.category,
    urgency: row.urgency,
    importance: row.importance,
    needsReply: row.needsReply,
    decisionQuestion: row.decisionQuestion,
    clientSignal: row.clientSignal,
    injectionSuspected: row.injectionSuspected,
    client: clientView(row),
    flagged: anchor !== null && signals.get(anchor)?.flagged === true,
    partialThread: row.partialThread,
    filterReason: row.filterReason,
    triageError: row.triageError,
    lastAttemptError: row.lastAttemptError,
    assessable: isAssessableState(row.state) && opts.accountUsable !== false
  };
}

export interface CommitmentView {
  id: string;
  threadId: string;
  threadHref: string;
  /** The thread's subject when the page knows it (a row in the 30-day window), else null. */
  threadSubject: string | null;
  direction: CommitmentDirection;
  text: string;
  counterparty: string | null;
  dueAt: string | null;
  dueText: string | null;
  status: CommitmentStatus;
  followedUpAt: string | null;
  overdue: boolean;
  messageSentAt: string;
  /** The verified quote the commitment was read from (thread page only). */
  evidence: string | null;
}

export function commitmentView(
  c: ExecCommitment,
  now: Date,
  subjects: ReadonlyMap<string, string | null>,
  withEvidence: boolean
): CommitmentView {
  const due = ms(c.dueAt);
  return {
    id: c.id,
    threadId: c.threadId,
    threadHref: threadHref(c.threadId),
    threadSubject: subjects.get(c.threadId) ?? null,
    direction: c.direction,
    text: c.text,
    counterparty: c.counterparty,
    dueAt: c.dueAt,
    dueText: c.dueText,
    status: c.status,
    followedUpAt: c.followedUpAt,
    overdue: c.status === "open" && due !== null && due < now.getTime(),
    messageSentAt: c.messageSentAt,
    evidence: withEvidence ? c.evidenceExcerpt : null
  };
}

/** Overdue first, then by due date, undated last (listCommitments' order, made explicit). */
function commitmentOrder(a: CommitmentView, b: CommitmentView): number {
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  const da = ms(a.dueAt);
  const db = ms(b.dueAt);
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Freshness (mail/accounts, mail/socket, mail/recon:<account>, mail/stagger)
// ---------------------------------------------------------------------------

export interface MailboxStatus {
  accountId: string;
  /** His mailbox's own address, as the clone reports it. */
  address: string | null;
  lastSyncedAt: string | null;
  /** The clone's last sync error is newer than its last good sync. */
  failingSince: string | null;
  /** The clone's error text, secret-scrubbed and clipped by reconcile (≤200 chars). */
  failingError: string | null;
  /** Why the account is unusable (mail/accounts problems), or null. */
  problem: string | null;
}

export interface AccountsFreshness {
  /** When reconcile last checked his mailboxes; null = it never has ("not synced yet"). */
  checkedAt: string | null;
  mailboxes: MailboxStatus[];
}

export interface SocketFreshness {
  connected: boolean;
  observedAt: string;
  lastEventAt: string | null;
  /** The worker hasn't reported for a while: the state shown may be old. */
  stale: boolean;
}

export interface SyncFreshness {
  /** CL1's message feed: "feed" on every mailbox, "list" when one has no feed (no Outlook signals), "unknown" before the first probe. */
  signals: "available" | "unavailable" | "unknown";
  /** The first backfill or the bulk queue hasn't caught up yet. */
  catchingUp: boolean;
  /** When the last staggered job is due, if that is still ahead. */
  catchingUpUntil: string | null;
}

/** L13: how many active clients have satisfaction scores fresh enough to raise an item. */
export interface SatisfactionFreshness {
  /** Active clients whose newest scored inbound email was scored at most `freshDays` ago. */
  fresh: number;
  /** Active clients (status empty or "active", as DD's own pages read it). */
  active: number;
  /** The freshness window in days: the satisfaction producer's own gate. */
  freshDays: number;
}

export interface EmailFreshness {
  accounts: ViewSection<AccountsFreshness>;
  socket: ViewSection<SocketFreshness | null>;
  sync: ViewSection<SyncFreshness>;
  satisfaction: ViewSection<SatisfactionFreshness>;
}

/**
 * L13's "fresh for N of M active clients". M counts the active clients; N
 * those whose newest scored inbound email is at most SATISFACTION_FRESH_DAYS
 * old, the same per-client gate the satisfaction producer applies, so N is
 * how many clients can raise a satisfaction item at all (the scores come from
 * a scorer that may not be running). Counts only: nothing about any client or
 * message is shown.
 */
export function satisfactionFreshness(
  clients: readonly Pick<DdClient, "id" | "status">[],
  latestScored: ReadonlyMap<string, string>,
  now: Date
): SatisfactionFreshness {
  const windowMs = SATISFACTION_FRESH_DAYS * DAY_MS;
  let active = 0;
  let fresh = 0;
  for (const c of clients) {
    if (!isActiveClientStatus(c.status)) continue;
    active += 1;
    const scored = ms(latestScored.get(c.id));
    if (scored !== null && now.getTime() - scored <= windowMs) fresh += 1;
  }
  return { fresh, active, freshDays: SATISFACTION_FRESH_DAYS };
}

function accountsFreshness(state: AccountsState | null, pinned: readonly string[]): AccountsFreshness {
  if (state === null) return { checkedAt: null, mailboxes: pinned.map((id) => ({ accountId: id, address: null, lastSyncedAt: null, failingSince: null, failingError: null, problem: null })) };
  const byId = new Map(state.accounts.map((a) => [a.id, a]));
  const problems = new Map(state.problems.map((p) => [p.accountId, String(p.reason)]));
  return {
    checkedAt: state.checkedAt,
    mailboxes: pinned.map((id) => {
      const a = byId.get(id);
      const failing =
        a !== undefined && a.lastSyncError !== null && (ms(a.lastSyncedAt) === null || (ms(a.lastSyncErrorAt) ?? 0) >= (ms(a.lastSyncedAt) ?? 0));
      return {
        accountId: id,
        address: a?.email ?? null,
        lastSyncedAt: a?.lastSyncedAt ?? null,
        failingSince: failing ? (a?.lastSyncErrorAt ?? null) : null,
        failingError: failing ? (a?.lastSyncError ?? null) : null,
        problem: problems.get(id) ?? null
      };
    })
  };
}

/** Mail sync health in one line's worth (the Overview's System card). */
export interface MailSummary {
  /** When reconcile last checked his mailboxes; null = never ("not synced yet"). */
  checkedAt: string | null;
  /** The most recent good sync over his mailboxes. */
  lastSyncedAt: string | null;
  /** The earliest "failing since" over his mailboxes, when any is failing. */
  failingSince: string | null;
  /** Pinned mailboxes reconcile found unusable. */
  problems: number;
  socket: { connected: boolean; stale: boolean; observedAt: string } | null;
}

export function summarizeMail(
  accounts: AccountsState | null,
  socket: { connected: boolean; observedAt: string } | null,
  pinned: readonly string[],
  now: Date
): MailSummary {
  const f = accountsFreshness(accounts, pinned);
  let lastSyncedAt: string | null = null;
  let failingSince: string | null = null;
  for (const m of f.mailboxes) {
    lastSyncedAt = laterIso(lastSyncedAt, m.lastSyncedAt);
    if (m.failingSince !== null && (failingSince === null || (ms(m.failingSince) ?? 0) < (ms(failingSince) ?? 0))) failingSince = m.failingSince;
  }
  return {
    checkedAt: f.checkedAt,
    lastSyncedAt,
    failingSince,
    problems: f.mailboxes.filter((m) => m.problem !== null).length,
    socket:
      socket === null
        ? null
        : { connected: socket.connected, observedAt: socket.observedAt, stale: now.getTime() - (ms(socket.observedAt) ?? 0) > SOCKET_STALE_MS }
  };
}

async function readFreshness(
  principal: ExecPrincipal,
  pinned: readonly string[],
  now: Date,
  signal: AbortSignal,
  accounts: Promise<Settled<{ value: AccountsState; rev: number } | null>>
): Promise<EmailFreshness> {
  const [acc, sock, stagger, recons, sat] = await Promise.all([
    accounts,
    settle("mail/socket", () => getSyncState(principal, "mail", "socket", parseSocketState, { signal })),
    settle("mail/stagger", () => getSyncState(principal, "mail", "stagger", parseStaggerState, { signal })),
    settle("mail/recon", () => Promise.all(pinned.map((id) => getSyncState(principal, "mail", `recon:${id}`, parseReconState, { signal })))),
    settle("satisfaction freshness", async () => {
      const [clients, latestScored] = await Promise.all([listClients(principal, { signal }), latestScoredInboundByClient(principal, { signal, now })]);
      return satisfactionFreshness(clients, latestScored, now);
    })
  ]);
  const accountsSection: ViewSection<AccountsFreshness> = acc.ok
    ? { ok: true, data: accountsFreshness(acc.value?.value ?? null, pinned) }
    : UNAVAILABLE;
  const socketSection: ViewSection<SocketFreshness | null> = sock.ok
    ? {
        ok: true,
        data:
          sock.value === null
            ? null
            : {
                connected: sock.value.value.connected,
                observedAt: sock.value.value.observedAt,
                lastEventAt: sock.value.value.lastEventAt,
                stale: now.getTime() - (ms(sock.value.value.observedAt) ?? 0) > SOCKET_STALE_MS
              }
      }
    : UNAVAILABLE;
  let syncSection: ViewSection<SyncFreshness> = UNAVAILABLE;
  if (stagger.ok && recons.ok) {
    // Reconcile reads only usable mailboxes, so a problem account's recon row
    // stays empty and would read as "catching up" for as long as it is a
    // problem (ui-4): progress is judged over the other pinned mailboxes.
    // Every one a problem: no catching-up line (the mailbox lines say why).
    const problems = acc.ok ? problemAccountIds(acc.value?.value ?? null) : new Set<string>();
    const states = recons.value.flatMap((r, i) => (problems.has(pinned[i]) ? [] : [r?.value ?? null]));
    const modes = states.map((s) => s?.mode ?? null);
    const signals = modes.some((m) => m === "list") ? "unavailable" : modes.length > 0 && modes.every((m) => m === "feed") ? "available" : "unknown";
    const backfillPending = states.some((s) => s === null || s.backfill === null || s.backfill.enqueuedAt === null);
    const until = stagger.value?.value.lastRunAfter ?? null;
    const queueAhead = until !== null && (ms(until) ?? 0) > now.getTime();
    syncSection = { ok: true, data: { signals, catchingUp: backfillPending || queueAhead, catchingUpUntil: queueAhead ? until : null } };
  }
  const satisfactionSection: ViewSection<SatisfactionFreshness> = sat.ok ? { ok: true, data: sat.value } : UNAVAILABLE;
  return { accounts: accountsSection, socket: socketSection, sync: syncSection, satisfaction: satisfactionSection };
}

// ---------------------------------------------------------------------------
// /executive/email
// ---------------------------------------------------------------------------

export interface EmailBucketsView {
  counts: Record<EmailBucket, number>;
  /** Each bucket's rows, newest first, at most EMAIL_LIST_LIMIT. */
  lists: Record<EmailBucket, EmailRowView[]>;
  limit: number;
}

export interface EmailCommitmentsView {
  /** Overdue first, at most `limit`. */
  items: CommitmentView[];
  total: number;
  overdue: number;
  limit: number;
}

export interface EmailDraftsView {
  draftsPending: number;
  scheduledReplies: number;
}

export type EmailTabView =
  | { state: "off"; generatedAt: string; timezone: string }
  | { state: "no_pin"; generatedAt: string; timezone: string }
  | {
      state: "on";
      generatedAt: string;
      timezone: string;
      freshness: EmailFreshness;
      buckets: ViewSection<EmailBucketsView>;
      /** Tombstones plus stored rows the screen dropped. */
      restricted: ViewSection<number>;
      drafts: ViewSection<EmailDraftsView>;
      commitments: ViewSection<EmailCommitmentsView>;
    };

/**
 * Everything /executive/email shows. Throws only for the gate's settings
 * read and the strict rules read; every other read fails into its section.
 */
export async function getEmailTab(principal: ExecPrincipal, now: Date = new Date()): Promise<EmailTabView> {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("exec email tab: now must be a valid Date");
  const generatedAt = now.toISOString();
  const timezone = principal.timezone;
  const gate = await loadEmailGate(principal);
  if (gate.kind !== "on") return { state: gate.kind, generatedAt, timezone };

  const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
  const policy: ScreeningPolicy = await loadScreeningPolicy(principal, { signal });

  const rowsRead = settle("bucket rows", () => listBucketRows(principal, now, { signal }));
  const artifactsRead = settle("reply artifacts", () => listAllReplyArtifacts(principal, { signal }));
  const tombstonesRead = settle("tombstones", () => listTombstonedThreadIds(principal, { signal }));
  const draftsRead = settle("draft counts", () => countPendingReplyArtifacts(principal, { signal }));
  const commitmentsRead = settle("commitments", () => listCommitments(principal, { statuses: ["open"] }, { signal }));
  const accountsRead = settle("mail/accounts", () => getSyncState(principal, "mail", "accounts", parseAccountsState, { signal }));

  // Rows of mailboxes no longer pinned are left out before the screen (ui-3).
  const screened = rowsRead.then((r) => (r.ok ? { ok: true as const, value: screenRows(pinnedRows(principal, r.value), policy) } : { ok: false as const }));
  const signalsRead = screened.then((s) =>
    s.ok ? settle("signals", () => listSignalsForMessages(principal, signalMessageIds(s.value.kept), { signal })) : ({ ok: false } as const)
  );
  const commitmentRowsRead = commitmentsRead.then((c) =>
    c.ok
      ? settle("commitment threads", async () =>
          pinnedRowMap(principal, await listThreadScreenRows(principal, [...new Set(c.value.map((x) => x.threadId))], { signal }))
        )
      : ({ ok: false } as const)
  );

  const bucketsSection = (async (): Promise<ViewSection<EmailBucketsView>> => {
    const [s, sig, art, acc] = await Promise.all([screened, signalsRead, artifactsRead, accountsRead]);
    if (!s.ok || !sig.ok || !art.ok) return UNAVAILABLE;
    // Assess isn't offered on a problem account (ui-2); with the mailbox state unreadable the route decides.
    const problems = acc.ok ? problemAccountIds(acc.value?.value ?? null) : null;
    const b = bucketize(s.value.kept, sig.value, art.value, now);
    const lists = Object.fromEntries(
      EMAIL_BUCKETS.map((bucket) => [
        bucket,
        b.rows[bucket]
          .slice(0, EMAIL_LIST_LIMIT)
          .map((row) => rowView(row, sig.value, art.value.get(row.threadId), problems === null ? {} : { accountUsable: !problems.has(row.accountId) }))
      ])
    ) as Record<EmailBucket, EmailRowView[]>;
    return { ok: true, data: { counts: b.counts, lists, limit: EMAIL_LIST_LIMIT } };
  })();

  const restrictedSection = (async (): Promise<ViewSection<number>> => {
    const [s, t] = await Promise.all([screened, tombstonesRead]);
    if (!s.ok || !t.ok) return UNAVAILABLE;
    return { ok: true, data: t.value.length + s.value.dropped };
  })();

  const draftsSection = draftsRead.then((d): ViewSection<EmailDraftsView> => (d.ok ? { ok: true, data: d.value } : UNAVAILABLE));

  const commitmentsSection = (async (): Promise<ViewSection<EmailCommitmentsView>> => {
    const [c, rows, s] = await Promise.all([commitmentsRead, commitmentRowsRead, screened]);
    if (!c.ok || !rows.ok) return UNAVAILABLE;
    const subjects = new Map<string, string | null>(s.ok ? s.value.kept.map((r) => [r.threadId, r.subject]) : []);
    const views = screenCommitments(c.value, rows.value, policy)
      .kept.map((x) => commitmentView(x, now, subjects, false))
      .sort(commitmentOrder);
    return {
      ok: true,
      data: { items: views.slice(0, COMMITMENT_LIST_LIMIT), total: views.length, overdue: views.filter((v) => v.overdue).length, limit: COMMITMENT_LIST_LIMIT }
    };
  })();

  const [freshness, buckets, restricted, drafts, commitments] = await Promise.all([
    readFreshness(principal, gate.pinned, now, signal, accountsRead),
    bucketsSection,
    restrictedSection,
    draftsSection,
    commitmentsSection
  ]);
  return { state: "on", generatedAt, timezone, freshness, buckets, restricted, drafts, commitments };
}

// ---------------------------------------------------------------------------
// /executive/email/[threadId]
// ---------------------------------------------------------------------------

export interface AttachmentView {
  filename: string;
  contentType: string | null;
  size: number | null;
  inline: boolean;
}

export type MessageBodyView =
  | {
      kind: "html";
      /** The frame's document with remote images withheld (the default). */
      srcdoc: string;
      /** The same with remote images allowed, only when there are some to show. */
      imagesSrcdoc: string | null;
      remoteImages: number;
      inlineImages: number;
      truncated: boolean;
    }
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "empty" }
  /** Older than the newest THREAD_BODY_LIMIT, or the body couldn't be fetched. */
  | { kind: "not_loaded" };

export interface MessageView {
  id: string;
  direction: MessageDirection;
  isJunk: boolean;
  isAutomated: boolean;
  from: ParsedAddress | null;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  subject: string;
  sentAt: string;
  attachments: AttachmentView[];
  body: MessageBodyView;
}

export interface TaskView {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  isDraft: boolean;
  href: string;
}

export interface ClientContextView {
  id: string;
  name: string;
  via: ClientMatchVia | null;
  confidence: MatchConfidence | null;
  candidates: number;
  /** The label DD shows (a leader's override wins), or null when it has none. */
  health: ClientHealthLabel | null;
  healthOverridden: boolean;
  meetings: { id: string; title: string; meetingAt: string }[];
}

export interface EmailThreadView {
  generatedAt: string;
  timezone: string;
  threadId: string;
  /** live: the clone answered; clone_unavailable / account_problem: stored sections only. */
  mode: "live" | "clone_unavailable" | "account_problem";
  /** The stored row's display and AI fields. */
  thread: EmailRowView & { answeredAt: string | null; triagedAt: string | null };
  /** The overlay inputs (CL1 signals, DD reply artifacts) couldn't be read: `thread.answered` is the stored state. */
  answeredUnchecked: boolean;
  /** His messages, newest first; null unless live. */
  messages: MessageView[] | null;
  /** Some bodies couldn't be fetched in time. */
  bodiesFailed: boolean;
  partialThread: boolean;
  /** The Outlook link (the stored CL1 web link, allowlisted), or null. */
  outlookUrl: string | null;
  /** /inboxes/... for his account, or null when it can't apply. */
  ddInboxUrl: string | null;
  commitments: ViewSection<CommitmentView[]>;
  tasks: ViewSection<TaskView[]>;
  client: ViewSection<ClientContextView | null>;
  attention: ViewSection<AttentionItem[]>;
}

export type EmailThreadPage = { kind: "not_found" } | { kind: "ok"; view: EmailThreadView };

export interface EmailThreadPageOptions {
  /**
   * A fresh deadline for one group of database reads (the default:
   * AbortSignal.timeout(READ_TIMEOUT_MS)). The page takes one for its first
   * reads and another for the side sections. A test seam: the page passes nothing.
   */
  deadline?: () => AbortSignal;
}

const NOT_FOUND = { kind: "not_found" } as const;

/** His messages, newest first, with the newest THREAD_BODY_LIMIT bodies built into frame documents. */
function messageViews(his: readonly HisMessage[], loaded: ReadonlySet<string>): MessageView[] {
  return [...his].reverse().map((m) => ({
    id: m.id,
    direction: m.direction,
    isJunk: m.isJunk,
    isAutomated: m.isAutomated,
    from: m.from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    sentAt: m.sentAt,
    attachments: m.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size, inline: a.inline })),
    body: bodyView(m, loaded.has(m.id))
  }));
}

function bodyView(m: HisMessage, loaded: boolean): MessageBodyView {
  if (!loaded || m.bodyDeferred) return { kind: "not_loaded" };
  const html = typeof m.bodyHtml === "string" ? m.bodyHtml : "";
  if (html.trim() !== "") {
    const shown = buildEmailSrcdoc(html, { showRemoteImages: false });
    const images = shown.remoteImages > 0 ? buildEmailSrcdoc(html, { showRemoteImages: true }).srcdoc : null;
    return {
      kind: "html",
      srcdoc: shown.srcdoc,
      imagesSrcdoc: images,
      remoteImages: shown.remoteImages,
      inlineImages: shown.inlineImages,
      truncated: shown.truncated
    };
  }
  const text = typeof m.bodyText === "string" ? m.bodyText : "";
  if (text.trim() !== "") {
    const truncated = text.length > MAX_TEXT_BODY_CHARS;
    return { kind: "text", text: truncated ? text.slice(0, MAX_TEXT_BODY_CHARS) : text, truncated };
  }
  return { kind: "empty" };
}

/**
 * His messages for the page, the newest THREAD_BODY_LIMIT with bodies (15 s).
 * A body load that fails or times out keeps the messages, marked, with
 * whatever bodies arrived before it.
 */
async function liveMessages(principal: ExecPrincipal, threadId: string, t: PrincipalMailThread): Promise<{ messages: MessageView[]; failed: boolean }> {
  const newest = [...t.his].reverse().slice(0, THREAD_BODY_LIMIT).map((m) => m.id);
  const loaded = new Set<string>();
  let failed = false;
  try {
    await loadHisBodies(principal, t, newest, { timeoutMs: PAGE_CLONE_TIMEOUT_MS, signal: AbortSignal.timeout(PAGE_CLONE_TIMEOUT_MS) });
    for (const id of newest) loaded.add(id);
  } catch (err) {
    console.error(`[exec-email-view] bodies of thread ${threadId} failed: ${errMessage(err)}`);
    failed = true;
    // Bodies that did arrive before the failure are still shown.
    for (const m of t.his) if (newest.includes(m.id) && !m.bodyDeferred) loaded.add(m.id);
  }
  return { messages: messageViews(t.his, loaded), failed };
}

function ddInboxUrl(accountId: string, threadId: string): string | null {
  const path = `/inboxes/${encodeURIComponent(accountId)}?thread=${encodeURIComponent(threadId)}&acct=${encodeURIComponent(accountId)}`;
  return ddPageRef(path, "Open in DD inbox").url;
}

function taskView(t: DdTask): TaskView {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    dueDate: t.dueDate,
    isDraft: t.isDraft,
    href: `/tasks/${encodeURIComponent(t.id)}`
  };
}

/**
 * Everything /executive/email/[threadId] shows, or not_found (the page's
 * 404) when the thread isn't one he may see here: email off or not
 * installed, no pin, no stored row, a tombstone or gone row, a row the
 * stored screen or the live screen marks restricted, a thread the clone no
 * longer has or that isn't his. Throws (the error boundary) only for the
 * gate's settings read, the strict rules read, the row read and the
 * mailbox-state read; the clone failing falls back to the stored sections.
 */
export async function getEmailThreadPage(
  principal: ExecPrincipal,
  threadId: string,
  now: Date = new Date(),
  opts: EmailThreadPageOptions = {}
): Promise<EmailThreadPage> {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("exec email thread: now must be a valid Date");
  if (!isThreadIdParam(threadId)) return NOT_FOUND;
  const gate = await loadEmailGate(principal);
  if (gate.kind !== "on") return NOT_FOUND;

  const deadline = opts.deadline ?? (() => AbortSignal.timeout(READ_TIMEOUT_MS));
  const signal = deadline();
  const policy: ScreeningPolicy = await loadScreeningPolicy(principal, { signal });
  const row = await getEmailThread(principal, threadId, { signal });
  if (row === null || row.state === "restricted_hidden" || row.state === "gone") return NOT_FOUND;
  // The stored screen first: a row a current rule matches (or a stale
  // truncated one) is not shown, live read or not.
  if (screenStoredRow(row, policy.rules, policy.hash).verdict === "restricted") return NOT_FOUND;
  if (!isPinnedAccount(principal, row.accountId)) return NOT_FOUND;

  const accounts = await getSyncState(principal, "mail", "accounts", parseAccountsState, { signal });
  const problems = problemAccountIds(accounts?.value ?? null);

  let mode: EmailThreadView["mode"] = "live";
  let t: PrincipalMailThread | null = null;
  if (problems.has(row.accountId)) {
    mode = "account_problem";
  } else {
    let live: Awaited<ReturnType<typeof readPrincipalThread>> | null = null;
    try {
      live = await readPrincipalThread(principal, threadId, {
        usable: usableAccounts(principal, problems),
        timeoutMs: PAGE_CLONE_TIMEOUT_MS
      });
    } catch (err) {
      console.error(`[exec-email-view] live read of thread ${threadId} failed, showing stored sections: ${errMessage(err)}`);
      mode = "clone_unavailable";
    }
    if (live !== null) {
      if (live.kind !== "ok") return NOT_FOUND;
      // The live screen, over every message of the thread and its
      // participants, before any body is fetched (L2).
      if (screenRestricted({ all: live.thread.all, participants: live.thread.participants }, policy.rules).verdict === "restricted") return NOT_FOUND;
      t = live.thread;
    }
  }

  // The side sections read DD's own tables under a deadline of their own,
  // started only now that the thread may be shown (ui-1). The clone calls
  // above and the body load below can take 15 s each: a deadline shared with
  // them would already have run out, failing every section exactly when the
  // clone is slow or down, the case these stored sections exist for. They run
  // alongside the body load; none of them needs it.
  const sectionSignal = deadline();
  const signalIds = [row.newestInboundMessageId, row.newestMessageId].filter((id): id is string => typeof id === "string" && id !== "");
  const sides = Promise.all([
    settle("signals", () => listSignalsForMessages(principal, signalIds, { signal: sectionSignal })),
    settle("reply artifacts", () => listReplyArtifacts(principal, [threadId], { signal: sectionSignal })),
    settle("commitments", () =>
      listCommitments(principal, { statuses: ["open", "followed_up", "expired"], threadIds: [threadId] }, { signal: sectionSignal })
    ),
    settle("linked tasks", () => listTasksForThread(principal, threadId, { signal: sectionSignal })),
    settle("client context", async (): Promise<ClientContextView | null> => {
      if (!row.clientId) return null;
      const clientId = row.clientId;
      const [clients, meetings] = await Promise.all([
        listClients(principal, { signal: sectionSignal }),
        listClientMeetings(principal, clientId, 3, { signal: sectionSignal })
      ]);
      const client = clients.find((c) => c.id === clientId);
      return {
        id: clientId,
        name: client?.name ?? row.clientName ?? "Client",
        via: row.clientMatchVia,
        confidence: row.matchConfidence,
        candidates: row.clientCandidates,
        health: client ? (client.healthOverrideLabel ?? client.healthLabel) : null,
        healthOverridden: client ? client.healthOverrideLabel !== null : false,
        meetings
      };
    }),
    settle("thread attention", () => listAttentionForThread(principal, threadId, { now, signal: sectionSignal }))
  ]);
  const [[signalsRead, artifactsRead, commitmentsRead, tasksRead, clientRead, attentionRead], bodies] = await Promise.all([
    sides,
    t === null ? Promise.resolve(null) : liveMessages(principal, threadId, t)
  ]);
  const messages = bodies?.messages ?? null;
  const bodiesFailed = bodies?.failed ?? false;
  const livePartial = t !== null && isPartialThread(t.his, t.all);

  // A2 on the thread page: its items are about this thread, whose row just
  // passed the screen; the same screen drops anything that isn't (a
  // fingerprint naming another thread never shows here).
  const attentionItems = attentionRead.ok
    ? screenEmailAttention(attentionRead.value, { emailOn: true, policy, rowsByThread: new Map([[threadId, row]]) }).items.filter(
        (item) => parseEmailFingerprint(item.fingerprint)?.threadId === threadId
      )
    : null;
  const signals = signalsRead.ok ? signalsRead.value : new Map<string, ExecEmailSignal>();
  const artifacts = artifactsRead.ok ? artifactsRead.value.get(threadId) : undefined;
  // Triage reads only usable mailboxes, so Assess on a problem account would
  // be accepted and then skipped (ui-2): it isn't offered there.
  const base = rowView(row, signals, artifacts, { accountUsable: mode !== "account_problem" });
  const webLinkSignal = (row.newestInboundMessageId ? signals.get(row.newestInboundMessageId) : undefined) ?? (row.newestMessageId ? signals.get(row.newestMessageId) : undefined);
  const subjects = new Map<string, string | null>([[threadId, row.subject]]);

  return {
    kind: "ok",
    view: {
      generatedAt: now.toISOString(),
      timezone: principal.timezone,
      threadId,
      mode,
      thread: { ...base, answeredAt: row.answeredAt, triagedAt: row.triagedAt },
      answeredUnchecked: !signalsRead.ok || !artifactsRead.ok,
      messages,
      bodiesFailed,
      partialThread: row.partialThread || livePartial,
      outlookUrl: signalsRead.ok ? execEmailRef({ threadId, webLink: webLinkSignal?.webLink ?? null, label: row.subject }).url : null,
      ddInboxUrl: mode === "account_problem" ? null : ddInboxUrl(row.accountId, threadId),
      commitments: commitmentsRead.ok
        ? { ok: true, data: commitmentsRead.value.map((c) => commitmentView(c, now, subjects, true)).sort(commitmentOrder) }
        : UNAVAILABLE,
      tasks: tasksRead.ok ? { ok: true, data: tasksRead.value.map(taskView) } : UNAVAILABLE,
      client: clientRead.ok ? { ok: true, data: clientRead.value } : UNAVAILABLE,
      attention: attentionItems !== null ? { ok: true, data: attentionItems } : UNAVAILABLE
    }
  };
}
