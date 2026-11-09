import type { EmailDocNode } from "@/lib/email-doc";
import type { SlotStatus } from "@/lib/exec/slack-intel-types";
import type { ErrorClass } from "@/lib/exec/types";

// Shared types and constants for the Executive Assistant's drafts (P4).
//
// Lead-owned (P4 contract §3.1), seeded at stage 0 and frozen: the P4 areas
// build against these shapes in parallel, so a change goes through the
// integrator with a reason. Pure: types and constants only, importable by
// server, client and test code alike.
//
// ExecDraftRow mirrors exec_drafts one column for one, in camelCase, in the
// migration's order; timestamps are ISO strings. Content fields (subject,
// body, instruction, note, recipients) live in exec_drafts and nowhere else
// (§0.3 rule 5).

export const DRAFT_STATUSES = ["generating", "generation_failed", "draft", "saving", "saved", "sending", "sent_pending",
  "unknown", "sent", "sent_external", "gone", "discarding", "discarded"] as const;
export type ExecDraftStatus = (typeof DRAFT_STATUSES)[number];
export const TERMINAL_DRAFT_STATUSES: readonly ExecDraftStatus[] = ["sent", "sent_external", "gone", "discarded"];
export const ACTIVE_DRAFT_STATUSES: readonly ExecDraftStatus[] =
  ["generating", "generation_failed", "draft", "saving", "saved", "sending", "sent_pending", "unknown", "discarding"];
export type DraftKind = "reply" | "new";
export type DraftOrigin = "web" | "slack" | "chat";
export type ReplyMode = "reply" | "reply_all" | "follow_up";
/** generating: draft | saved | generation_failed (C6); discarding: draft | saved | unknown (C76). */
export type PriorStatus = "draft" | "saved" | "generation_failed" | "unknown";
export type GenerationError = "declined" | "truncated" | "invalid_output" | "budget" | "input_too_large"
  | "thread_unavailable" | "restricted" | "model_error" | "timeout" | "stale" | "stopped";
export type FactsStatus = "used" | "none" | "not_matched" | "medium_confidence" | "unavailable" | "recipients_outside_client";
/** P5b (F4, C45): `private_refs`, appended last, is raised for a draft started in a chat that read other private material. */
export type ReviewBlocker = "already_replied" | "newer_inbound" | "reply_scheduled" | "legacy_draft_pending"
  | "opened_in_outlook" | "changed_in_outlook" | "recipients_changed" | "reply_to_present"
  | "placeholder_in_outlook" | "thread_unavailable" | "facts_outside_client" | "unexpected_content" | "private_refs";
export const REVIEW_BLOCKERS: readonly ReviewBlocker[] = ["already_replied", "newer_inbound", "reply_scheduled",
  "legacy_draft_pending", "opened_in_outlook", "changed_in_outlook", "recipients_changed", "reply_to_present",
  "placeholder_in_outlook", "thread_unavailable", "facts_outside_client", "unexpected_content", "private_refs"];
/**
 * P5b (F7, C44): who wrote the draft's current instruction. `owner` = typed by him (every web draft, and any
 * regeneration with an instruction he sent); `assistant` = written by the chat assistant (createChatReplyDraft).
 */
export type InstructionBy = "owner" | "assistant";
export const INSTRUCTION_BY: readonly InstructionBy[] = ["owner", "assistant"];
/** C65: the output scan's codes; the flagged values are never stored. */
export type GenerationFlag = "unexpected_url" | "unexpected_email" | "unexpected_phone" | "unexpected_amount"
  | "unexpected_number" | "other_client_name" | "teammate_name";
export const GENERATION_FLAGS: readonly GenerationFlag[] = ["unexpected_url", "unexpected_email", "unexpected_phone",
  "unexpected_amount", "unexpected_number", "other_client_name", "teammate_name"];
export type CloneFlag = "send_status_unknown" | "not_found_after_send" | "verify_overdue" | "create_unconfirmed"
  | "gone_unconfirmed" | "unverified" | "signature_skipped";
export type OwnerResolution = "sent" | "not_sent";
/** check (C70) and stop_generation (C71) are v2 owner actions on the resolve route (K26). */
export type ResolveAction = "mark_sent" | "not_sent_new_draft" | "copy_to_new_draft" | "keep_outlook_version"
  | "check" | "stop_generation";
/** findSentCopy's answer (C54); mail.ts re-exports it. */
export type SentCopyResult = "found" | "not_found" | "unsupported";
/** The clone registry's statuses (CL2C §2.1). */
export type CloneDraftStatus = "creating" | "saved" | "sending" | "sent_pending_verification" | "sent"
  | "sent_mismatch" | "sent_external" | "unknown" | "gone" | "deleted";

export type EaReadinessReason = "no_pin" | "multiple_principals" | "token_missing" | "base_url_missing"
  | "clone_unreachable" | "cl2_missing" | "cl2_not_ready" | "me_failed" | "me_no_auth" | "not_scoped"
  | "wrong_scopes" | "wrong_accounts" | "token_expired";
export type SendTokenReason = "token_missing" | "malformed" | "not_scoped" | "wrong_scopes" | "wrong_accounts" | "token_expired";
export type SendUnavailable = "send_off" | "clone_send_off" | "send_token" | EaReadinessReason;

/** A recipient as DD stores and shows it: address trimmed + lowercased; name sanitized, ≤256, or null. */
export interface DraftAddress { address: string; name: string | null }
/** The parent message's addresses, his own removed (reply_candidates). */
export interface ReplyCandidates { from: DraftAddress; to: DraftAddress[]; cc: DraftAddress[] }
/** The read-back's addresses at review (review_recipients). */
export interface ReviewRecipients {
  from: DraftAddress | null; sender: DraftAddress | null; replyTo: DraftAddress[];
  to: DraftAddress[]; cc: DraftAddress[]; bcc: DraftAddress[];
}
export interface DraftUsage {
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  costUsd: number; latencyMs: number; requestId: string | null;
}

/** exec_drafts, camelCase, one field per column of §2.1, same order. Timestamps are ISO strings. */
export interface ExecDraftRow {
  id: string; principalId: string; accountId: string; kind: DraftKind; origin: DraftOrigin;
  status: ExecDraftStatus; priorStatus: PriorStatus | null; version: number; savedVersion: number | null;
  generationSeq: number; threadId: string | null; parentMessageId: string | null; replyMode: ReplyMode | null;
  threadSubject: string | null; replyCandidates: ReplyCandidates | null; threadAddresses: string[];
  toRecipients: DraftAddress[]; ccRecipients: DraftAddress[]; bccRecipients: DraftAddress[];
  subject: string | null; bodyDoc: EmailDocNode | null; bodyHtml: string | null; bodyText: string | null;
  instruction: string | null; noteForMitchell: string | null; placeholders: string[];
  reviewRecipients: ReviewRecipients | null; recipientsSig: string | null;
  screenHashes: string[]; screenTruncated: boolean; screenedPolicyHash: string | null;
  renderNonce: string; model: string | null;
  usage: DraftUsage | null; generationError: GenerationError | null; generationFlags: GenerationFlag[];
  factsStatus: FactsStatus | null; clientId: string | null; generatedAt: string | null;
  outlookGraphId: string | null; internetMessageId: string | null; conversationId: string | null; webLink: string | null;
  contentHash: string | null; observedContentHash: string | null;
  reviewHash: string | null; reviewAt: string | null; reviewBlockers: ReviewBlocker[];
  confirmHash: string | null; saveAttemptKey: string | null; saveVersion: number | null; saveTimezone: string | null;
  saveIfContentHash: string | null;
  saveStartedAt: string | null; discardAttemptKey: string | null; discardStartedAt: string | null;
  sendAttemptKey: string | null; sendStartedAt: string | null; sendAcceptedAt: string | null; sentAt: string | null;
  sentAuditId: number | null; sentMismatch: boolean; unverified: boolean; goneUnconfirmed: boolean;
  signatureSkipped: boolean; outlookEdited: boolean; restrictedPurged: boolean; usesPrivateRefs: boolean;
  cloneFlags: CloneFlag[]; ownerResolution: OwnerResolution | null; openedInOutlookAt: string | null;
  lastErrorCode: string | null; lastErrorAt: string | null; nextCheckAt: string | null; checkCount: number;
  goneAt: string | null; createdAt: string; updatedAt: string; terminalAt: string | null;
  contentPurgedAt: string | null; expiresAt: string | null;
  /** P5b (F7): exec_drafts.instruction_by, the column P5b's migration appends after expires_at. */
  instructionBy: InstructionBy;
  /**
   * P5b (review security-2): exec_drafts.chat_message_id, the chat answer whose create_draft wrote it; copied to P4's
   * successor (T43 / T45), so the purge by id reaches drafts no card names. Null for every web draft.
   */
  chatMessageId: string | null;
  /**
   * P7b (§3.17.2 E2; stage-0 seed, OPTIONAL until Area E's loader maps the columns, bindings AM-P7b-11):
   * exec_drafts.purpose / generated_version / client_update_facts. Absent or a missing column = "reply" / null / null.
   */
  purpose?: DraftPurpose;
  generatedVersion?: number | null;
  clientUpdateFacts?: ClientUpdateFactsRecord | null;
}

/** P7b: exec_drafts.purpose (N17, C10). */
export type DraftPurpose = "reply" | "client_update";
/** P7b (§3.8.3): stored on exec_drafts.client_update_facts: counts and slot statuses only, never text. Defined here (pure)
 *  because it is a draft column; client-update-facts.ts re-exports it (bindings AM-P7b-12). */
export interface ClientUpdateFactsRecord {
  completed: { status: SlotStatus; count: number }; teamWork: { status: SlotStatus; count: number }; publicSlack: { status: SlotStatus; count: number };
  lastUpdate: { teamEmailSentAt: string | null; workReportedAt: string | null } | null;
}
/** P4's pack fact (drafts-pack.ts re-exports it). P7b (§3.17.2 E2): class widens to "public" for the public_slack slot and a
 *  fact may name its slot; P4's reply packs keep class "internal" and no slot (assertPackAllowed). */
export interface PackFact {
  id: string; clientId: string; class: "internal" | "public"; line: string;
  slot?: "open" | "completed" | "team_work" | "public_slack";
}

export type RecipientBadge = "external" | "role" | "not_in_thread" | "added_in_outlook";
export interface RecipientView extends DraftAddress { badges: RecipientBadge[] }

export interface DraftCapabilities {
  canEdit: boolean; canRegenerate: boolean; canSave: boolean; canReview: boolean; canDiscard: boolean;
  /** Restricted rows with an Outlook draft to delete: restricted_purged ∧ linked ∧ status ∈ {saved, draft} (C13). */
  canDeleteRestricted: boolean;
  canOpenInOutlook: boolean;
  /** Includes "check" (C70) and "stop_generation" (C71) where they apply; "keep_outlook_version" only after a change in Outlook (C53). */
  resolve: ResolveAction[];
  /** Why drafting is off for this row, or null. */
  draftsUnavailable: EaReadinessReason | "drafts_off" | "mailbox_problem" | null;
  /** Why Send is off (Review & send hidden), or null. Display only: the send route re-checks. */
  sendUnavailable: SendUnavailable | null;
}

/** GET /api/exec/drafts/:id. Restricted rows (C11) carry no content: every content field null/empty. */
export interface DraftView {
  id: string; kind: DraftKind; status: ExecDraftStatus; version: number; savedVersion: number | null;
  staleLink: boolean; restricted: boolean;
  threadId: string | null; threadSubject: string | null; replyMode: ReplyMode | null;
  parentFrom: DraftAddress | null; replyCandidates: ReplyCandidates | null;
  to: RecipientView[]; cc: RecipientView[]; bcc: RecipientView[];
  subject: string | null; bodyDoc: EmailDocNode | null; bodyText: string | null;
  instruction: string | null; noteForMitchell: string | null; placeholders: string[];
  factsStatus: FactsStatus | null; injectionSuspected: boolean; generationFlags: GenerationFlag[];
  generationError: GenerationError | null; lastError: { code: string; at: string } | null;
  /** webLink is the clone's link; the UI never puts it in an href (C69). changedSinceSaved: observed ≠ content hash (C66). */
  outlook: { linked: boolean; webLink: string | null; openedAt: string | null; signatureSkipped: boolean; edited: boolean;
    changedSinceSaved: boolean };
  review: { valid: boolean; at: string | null; expiresAt: string | null; blockers: ReviewBlocker[] };
  /**
   * pastHorizon (additive, ui-8): an `unknown` row is 30 min or more past send_started_at (C68), computed by the
   * server so the banner's wording doesn't hang on capabilities that are emptied while drafts are unavailable.
   */
  sent: { at: string | null; mismatch: boolean; unverified: boolean; ownerResolution: OwnerResolution | null; pastHorizon: boolean };
  gone: { at: string | null; unconfirmed: boolean; holdUntil: string | null };
  cloneFlags: CloneFlag[];
  mailTimezone: { zone: string; mapped: boolean };
  capabilities: DraftCapabilities;
  createdAt: string; updatedAt: string;
  /** Additive (integrator): the facts client's DD name, for the "<client>" copy (§3.13.4). Absent when the row has no facts client, is restricted, or the name couldn't be read. */
  clientName?: string | null;
  /**
   * P5b (F5, C45): the draft was started in a chat that also read other email, team notes or other clients' records,
   * so Save asks for "I've checked it" (confirmPrivate) and Send for the private_refs acknowledgement. A flag, not
   * content: kept on restricted rows.
   */
  usesPrivateRefs: boolean;
  /** P5b (F5, C44): who wrote the current instruction. Kept on restricted rows, where `instruction` is null. */
  instructionBy: InstructionBy;
  /** P7b (§3.17.2 E2, E5; stage-0 seed, OPTIONAL until Area E's view mapping lands): absent = "reply" / null. Counts and
   *  statuses only (the panel's "Client update. Used: …" line); clientName is the facts client's DD name. */
  purpose?: DraftPurpose;
  clientUpdate?: (ClientUpdateFactsRecord & { clientName: string | null }) | null;
}

export type DraftAttention = "unknown" | "sent_mismatch" | "gone_unconfirmed" | "outlook_changed" | "generation_failed"
  | "restricted" | "stale_link";
export interface DraftListItem {
  id: string; kind: DraftKind; status: ExecDraftStatus; threadId: string | null;
  /** Thread subject (reply) or subject (new); null when restricted. */
  label: string | null;
  /** "Jane Doe" / "Jane Doe +2"; null when restricted. */
  toSummary: string | null;
  updatedAt: string; sentAt: string | null; restricted: boolean; attention: DraftAttention | null;
}

/** The clone read-back as the confirm dialog and the "changed" views show it. Never stored. */
export interface ReadBackView {
  from: DraftAddress | null; sender: DraftAddress | null; replyTo: DraftAddress[];
  to: RecipientView[]; cc: RecipientView[]; bcc: RecipientView[];
  subject: string;
  /** Built on the server by P3's builder through readBackSrcdoc (§3.13.1): P4's CSP first, remote images blocked. */
  srcdoc: string;
  remoteImageCount: number;
  /** The body was longer than P3's MAX_EMAIL_HTML_CHARS and the preview is cut (the dialog says so). */
  truncated: boolean;
  attachments: { name: string; size: number; isInline: boolean; contentType: string | null }[];
  signatureSkipped: boolean;
  /** The clone's contentHash of exactly this read-back: the browser posts it back as seenContentHash (C53, C66). */
  contentHash: string;
}

export interface ReviewResult {
  status: ExecDraftStatus;
  readBack: ReadBackView | null;
  /** Non-null only when the review has no errors; the browser posts it back to send. */
  reviewHash: string | null;
  reviewExpiresAt: string | null;
  blockers: ReviewBlocker[];
  /** Codes that forbid Send: RecipientError codes, "placeholders", "subject_required". */
  errors: string[];
  warnings: { code: "external_domain" | "role_address" | "reply_to_present"; value: string | null }[];
  sendUnavailable: SendUnavailable | null;
  /** Additive (integrator): the facts client's DD name for the facts_outside_client copy; absent as on DraftView. */
  clientName?: string | null;
  /**
   * Additive (ui-4): each recipient error with the address it names (DD's lowercased address, never a display
   * name, C75), so the dialog can say which recipient is the problem; absent from older answers.
   */
  errorEntries?: { code: string; address: string | null }[];
}

export type DraftErrorCode = "not_found" | "forbidden" | "bad_request" | "invalid" | "drafts_off" | "send_off"
  | "drafts_unavailable" | "send_unavailable" | "rate_limited" | "version_conflict" | "state_conflict"
  | "review_required" | "review_expired" | "acks_missing" | "recipients_blocked" | "placeholders" | "empty_body"
  | "unsafe_markup" | "instruction_required" | "subject_required" | "thread_unavailable" | "mailbox_problem"
  | "audit_unavailable" | "unavailable" | "hold" | "sent_copy_found"
  /** P5b (F3, C45): Save of a usesPrivateRefs draft without confirmPrivate: true (409, nothing written). */
  | "private_refs_unconfirmed";

export const DRAFT_LIMITS = Object.freeze({
  instructionChars: 2_000, bodyDocBytes: 65_536, bodyTextChars: 20_000, docDepth: 20, docNodes: 5_000,
  maxRecipients: 20, noteChars: 400, paragraphs: 12, paragraphChars: 2_000, signOffChars: 80,
  modelSubjectChars: 200, subjectChars: 998, placeholderMax: 20,
  reviewTtlMs: 600_000, generatingStaleMs: 300_000, savingStaleMs: 360_000, discardingStaleMs: 360_000,
  sendingStaleMs: 180_000, goneRecheckMs: [120_000, 360_000, 960_000], goneHoldMs: 900_000,
  sendHorizonMs: 1_800_000, sentPendingMaxMs: 86_400_000, idleDays: 30, recentSentDays: 7,
  activeListLimit: 200, pageLimit: 50, estimatedTokenCeiling: 60_000,
  // v2: liveness (C68), follow-ups (C69, §2.6.5), the sweep (C67), deadlines (C72)
  failedCheckRetryMs: 300_000, slowAfterMs: 86_400_000, slowCheckMs: 21_600_000, slowCheckUntilMs: 1_209_600_000,
  openedFollowUpMs: [25_000, 120_000, 600_000], notFoundFollowUpMs: [120_000, 360_000, 960_000],
  claimMs: 420_000, replayTimeoutMs: 150_000, replayStartWithinMs: 60_000, replayGiveUpMs: 86_400_000,
  reconcileStartBudgetMs: 170_000, generationDeadlineMs: 120_000, voiceStartBudgetMs: 230_000, outcomeWriteTimeoutMs: 10_000
});
/** L7. Global flag: callers reset lastIndex or use String.prototype.match. */
export const PLACEHOLDER_RE = /\[[^\]\n]{1,80}\]/g;
/** CL2 D7: the six IANA zones the clone maps; any other zone quotes in UTC (L19). */
export const CL2_MAPPED_TIMEZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix",
  "America/Los_Angeles", "UTC"] as const;
export const DRAFT_JOB_KINDS = Object.freeze({
  generate: "exec.draft-generate", reconcile: "exec.draft-reconcile", voice: "exec.voice-refresh"
} as const);
/** C51: the only keys a P4 audit input may carry (a boundary test checks every call site). */
export const AUDIT_INPUT_KEYS: readonly string[] = ["draftId", "threadId", "accountId", "version", "kind", "origin",
  "graphIdFp", "reviewHashPrefix", "recipientCount", "externalDomainCount", "acks", "outcome", "code",
  "httpStatus", "draftStatus", "replay", "costUsd", "factsStatus", "counts", "action", "generationSeq",
  "checkedOutlook", "flags"];
/** /executive/email/drafts/new seeds (§3.13.2) and new-draft suggestions; shared by drafts.ts and the components. */
export interface NewDraftSeed {
  kind: "reply"; threadId: string; threadSubject: string | null; parentFrom: DraftAddress;
  to: DraftAddress[]; cc: DraftAddress[]; candidates: ReplyCandidates; mode: ReplyMode; injectionSuspected: boolean;
}
export interface RecipientSuggestion { address: string; name: string | null; source: "internal" | "client" | "correspondent" }
export type { ErrorClass };
