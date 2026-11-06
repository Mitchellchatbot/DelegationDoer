// Shared types and constants for the Executive Assistant's email intelligence (P3).
//
// Lead-owned (contract §3.1 + v3.1 amendments). The P3 areas build against these
// shapes in parallel, so change them only through the integrator, with a reason.
//
// Conventions
// - ExecEmailThread / ExecCommitment / ExecEmailSignal mirror the columns of
//   exec_email_threads / exec_commitments / exec_email_signals one for one, in
//   camelCase. Timestamps are ISO strings as PostgREST returns them; integer
//   columns are numbers.
// - Nothing here carries a message body. The only free text exec may store is the
//   §0 carve-out: the subject (≤200 chars, from his newest message), the clipped
//   AI fields, and a commitment's text and verified evidence excerpt.
// - Snapshot times are epoch milliseconds (numbers) so they compare as numbers on
//   both sides (v3.1 A4); the stored columns are timestamptz and are converted on
//   read.

import type { ExecDraftStatus } from "@/lib/exec/drafts-types";
import type { SourceRef } from "@/lib/exec/types";

// ---------------------------------------------------------------------------
// Constants shared across areas
// ---------------------------------------------------------------------------

/** How far back the first enable (and the age gates) look. L10. */
export const EMAIL_BACKFILL_DAYS = 14;
/** CL1's feed settle horizon: rows newer than this may still be committing. */
export const FEED_SETTLE_MS = 120_000;
/** Settled margin for [NEW] marks and the commitment filter (v3.1 A5). */
export const NEW_MARK_SETTLE_MS = 120_000;
/** Clock-skew allowance between DD processes for happens-before ordering (v3.1 A4). */
export const SNAPSHOT_SKEW_MS = 5_000;
/** Most screening hashes kept per row; beyond this screen_truncated is set (L11, A1). */
export const SCREEN_HASH_LIMIT = 600;
/** Most display correspondents per row (his messages only). */
export const CORRESPONDENTS_LIMIT = 50;

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------

/** v3.1: there is no "pending" state (nothing produced it). */
export type EmailThreadState = "triaged" | "filtered" | "triage_failed" | "deferred_budget" | "restricted_hidden" | "gone";
export type TriageError = "refusal" | "truncated" | "invalid_output" | "input_too_large";
export type LastAttemptError = TriageError | "budget";
export type FilterReason = "unreplyable" | "automated_hint";
export type Urgency = "critical" | "high" | "normal" | "low";
export type Importance = "high" | "normal" | "low";
export type EmailCategory =
  | "client"
  | "prospect"
  | "partner_vendor"
  | "internal_team"
  | "finance_admin"
  | "legal"
  | "recruiting"
  | "personal"
  | "newsletter_marketing"
  | "notification"
  | "calendar"
  | "other";
export type ClientSignal = "none" | "complaint" | "churn_risk" | "outage_or_breakage" | "billing_or_legal_dispute" | "praise";
export type MatchConfidence = "high" | "medium" | "low";
export type ClientMatchVia = "exact" | "domain";
/** What the row stores: derived from the clone thread only (L3). */
export type StoredAnsweredState = "awaiting_reply" | "answered" | "no_inbound";
/** What readers show: the stored state plus the read-time overlay (L3, A3). */
/** The read-time overlay states: P3's three plus P4's reply_sent_pending (an exec draft sent from DD, its Sent copy not yet in the feed; L15). */
export type AnsweredState = StoredAnsweredState | "handled_in_outlook" | "reply_scheduled" | "draft_pending" | "reply_sent_pending";
export type BodySource = "html" | "text" | "preview_stub" | "mixed" | "empty";
export type CommitmentDirection = "mitchell_owes" | "owed_to_mitchell";
export type CommitmentStatus = "open" | "followed_up" | "expired";
export type EmailBucket = "reply" | "urgent" | "important" | "waiting" | "filtered";
/** Exact reasons only (addenda §1.8): there is no catch-all "retriage". */
export type TriageReason =
  | "event"
  | "reconcile"
  | "backfill"
  | "assess"
  | "budget_retry"
  | "policy"
  | "version"
  | "flag"
  | "dead_letter"
  | "runbook";
export type ScreenVerdict = "clean" | "restricted";
export type MessageDirection = "inbound" | "outbound";
export type OutlookImportance = "low" | "normal" | "high";

// ---------------------------------------------------------------------------
// Mail read shapes (sources/mail.ts)
// ---------------------------------------------------------------------------

/** A parsed address: the display name as written (sanitized) or null; the email trimmed and lowercased. */
export interface ParsedAddress {
  name: string | null;
  email: string;
}

/** Attachment metadata only; never bytes. */
export interface HisAttachment {
  id: string;
  filename: string;
  contentType: string | null;
  size: number | null;
  inline: boolean;
}

/** One of HIS messages (account_id ∈ the usable pinned accounts), normalized. */
export interface HisMessage {
  id: string;
  threadId: string;
  accountId: string;
  direction: MessageDirection;
  folder: string;
  /** /spam|junk/i on folder. */
  isJunk: boolean;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  subject: string;
  from: ParsedAddress | null;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  /** ISO, for display. */
  sentAt: string;
  /** Clone ingest time as epoch ms (Number of the raw digits); null when the clone didn't return it. */
  createdAtMs: number | null;
  /** Normalized from the clone's INTEGER 0/1 or boolean. */
  isAutomated: boolean;
  attachments: HisAttachment[];
  bodyDeferred: boolean;
  bodyHtml: string | null;
  bodyText: string | null;
}

/**
 * Address metadata for EVERY message of the clone thread, any account (restricted
 * screening, partial-thread detection, snapshots). from/to/cc are the RAW values
 * exactly as missive-client's normalizeMessage returns them, never parsed, so the
 * screen sees what DD's own messagesMatch sees.
 */
export interface MessageMeta {
  id: string;
  accountId: string | null;
  direction: MessageDirection;
  from: string;
  to: string[];
  cc: string[];
  rfcMessageId: string | null;
  inReplyTo: string | null;
  /** Epoch ms. */
  createdAtMs: number | null;
  /** ISO. */
  sentAt: string | null;
}

/** The clone snapshot behind a read (v3.1 A4 + addenda). All times are epoch ms. */
export interface ThreadSnapshot {
  /** Distinct (account_id, direction, rfc message_id) over every message; empty rfc ids each count once. */
  identityCount: number;
  maxCreatedAtMs: number | null;
  /** Max sent_at over every message: list-mode skip rule only, never used for ordering. */
  maxSentAtMs: number | null;
  /** DD clock just before the clone request. */
  readStartedAtMs: number;
  /** DD clock after the clone response. */
  readDoneAtMs: number;
}

export interface PrincipalMailThread {
  threadId: string;
  /** The clone thread's participants, raw. */
  participants: string[];
  /** His messages only, deduplicated by (rfc id, direction), ascending (sentAt, id). Never empty. */
  his: HisMessage[];
  /** Every message of the thread, metadata only. */
  all: MessageMeta[];
  snapshot: ThreadSnapshot;
  /** The clone thread's last_message_at (ISO), for list-mode reconcile keys. */
  lastMessageAt: string | null;
}

/**
 * not_found carries the 404 read's own readDoneAtMs (DD clock after the clone
 * answered): the gone proposal's time (amendments-7(a)), so only a read that
 * started after this 404 read finished can ever revive the row.
 */
export type ReadThreadResult =
  | { kind: "ok"; thread: PrincipalMailThread }
  | { kind: "not_found"; readDoneAtMs: number }
  | { kind: "not_his" };

// ---------------------------------------------------------------------------
// Stored rows
// ---------------------------------------------------------------------------

/** exec_email_threads, camelCase. On a restricted_hidden row every content column is null/false/0 (whitelist CHECK). */
export interface ExecEmailThread {
  principalId: string;
  threadId: string;
  accountId: string;
  state: EmailThreadState;
  version: number;

  // Snapshot behind the stored facts (allowed on tombstones).
  snapshotIdentityCount: number;
  snapshotMaxCreatedAt: string | null;
  snapshotMaxSentAt: string | null;
  snapshotReadStartedAt: string | null;
  snapshotReadDoneAt: string | null;
  goneAt: string | null;

  // Screening (allowed on tombstones; monotonic union, v3.1 A1).
  screenHashes: string[];
  screenTruncated: boolean;
  screenedPolicyHash: string | null;

  // Display (his messages only).
  subject: string | null;
  counterpartName: string | null;
  counterpartEmail: string | null;
  correspondents: string[];
  messageCount: number;

  // Pointers (clone message row ids).
  newestMessageId: string | null;
  newestInboundMessageId: string | null;
  newestOutboundMessageId: string | null;

  // Deterministic facts.
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  newestIsOutbound: boolean | null;
  answeredState: StoredAnsweredState | null;
  answeredAt: string | null;
  answeredMessageId: string | null;
  partialThread: boolean;
  outboundAutomatedOnly: boolean;
  clientId: string | null;
  clientName: string | null;
  clientMatchVia: ClientMatchVia | null;
  matchConfidence: MatchConfidence | null;
  clientCandidates: number;

  // AI fields (set only by a triaged outcome; kept through later failures).
  summary: string | null;
  reason: string | null;
  category: EmailCategory | null;
  urgency: Urgency | null;
  importance: Importance | null;
  needsReply: boolean | null;
  mitchellPersonally: boolean | null;
  awaitingReplyFromOthers: boolean | null;
  decisionQuestion: string | null;
  decisionMessageId: string | null;
  clientSignal: ClientSignal | null;
  automated: boolean | null;
  injectionSuspected: boolean;

  // Run metadata.
  filterReason: FilterReason | null;
  triageError: TriageError | null;
  refusalCategory: string | null;
  contentHash: string | null;
  model: string | null;
  triageVersion: string | null;
  attemptedVersion: string | null;
  /** "Extracted through": advanced only by a triaged write (v3.1 A5). */
  inputWatermark: string | null;
  /** Advanced by every outcome; the outcome guard compares against it (v3.1 A5). */
  outcomeWatermark: string | null;
  inputTruncated: boolean;
  bodySource: BodySource | null;
  triagedAt: string | null;
  deferredAt: string | null;
  lastAttemptAt: string | null;
  lastAttemptError: LastAttemptError | null;

  firstSeenAt: string;
  updatedAt: string;
  expiresAt: string;
}

/** exec_commitments, camelCase. */
export interface ExecCommitment {
  id: string;
  principalId: string;
  /** sha256 hex of direction + message id + normalized evidence excerpt. */
  fingerprint: string;
  source: "email" | "slack";
  threadId: string;
  messageId: string;
  accountId: string;
  direction: CommitmentDirection;
  text: string;
  counterparty: string | null;
  dueAt: string | null;
  dueText: string | null;
  status: CommitmentStatus;
  followedUpAt: string | null;
  evidenceExcerpt: string;
  sourceRef: SourceRef;
  messageSentAt: string;
  messageCreatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

/** A commitment extracted by triage, before it is stored. */
export type NewCommitment = Omit<
  ExecCommitment,
  "id" | "principalId" | "fingerprint" | "status" | "followedUpAt" | "createdAt" | "updatedAt" | "expiresAt" | "messageCreatedAt"
> & {
  /** The cited message's clone ingest time, epoch ms (rule (i) compares it). */
  messageCreatedAtMs: number | null;
  /** Set when a later qualifying message already follows it up (the step-9 rule applied at birth). */
  bornFollowedUpAt: string | null;
};

/** One feed row's signals, as the reconcile passes upsert them (exec_email_upsert_signals). */
export interface EmailSignalInput {
  messageId: string;
  threadId: string;
  accountId: string;
  direction: MessageDirection;
  flagged: boolean | null;
  importance: OutlookImportance | null;
  unread: boolean | null;
  /** ISO. */
  removedAt: string | null;
  webLink: string | null;
  /** ISO of COALESCE(signals_updated_at, created_at) (addenda / amendments-5). */
  signalsAt: string;
}

/** The columns every render-time and producer screen needs (screenStoredRow). */
export type ThreadScreenRow = Pick<
  ExecEmailThread,
  "threadId" | "accountId" | "state" | "screenHashes" | "screenTruncated" | "screenedPolicyHash"
>;

/** exec_email_signals, camelCase: one row per message of his, written only from the CL1 feed (v3.1 A3). */
export interface ExecEmailSignal {
  principalId: string;
  messageId: string;
  threadId: string;
  accountId: string;
  direction: MessageDirection;
  flagged: boolean | null;
  importance: OutlookImportance | null;
  unread: boolean | null;
  removedAt: string | null;
  webLink: string | null;
  signalsAt: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Read-side helpers' shapes
// ---------------------------------------------------------------------------

export interface EmailBucketCounts {
  reply: number;
  urgent: number;
  important: number;
  waiting: number;
  filtered: number;
  /** Tombstones plus rows dropped by the render-time screen. */
  restrictedHidden: number;
  draftsPending: number;
  scheduledReplies: number;
}

/** DD-side reply artifacts for a thread (read-time overlay, never stored). */
export interface ReplyArtifacts {
  scheduledFor: string | null;
  draftPending: boolean;
  /** P4 (X1): the thread's active exec draft, for the list chips only; absent when the exec table isn't installed or wasn't read. */
  execDraft?: { id: string; status: ExecDraftStatus } | null;
  /** P4 (X1): parent message ids of exec drafts in sending / sent_pending / sent / sent_external whose send is at most 7 days old. */
  execSentParents?: readonly string[];
}
