// P8 morning brief: shared types, limits, job kinds and keys (P8 contract §3.1; stage 0, lead seed, frozen). Pure and
// client-safe: type-only imports. Exactly the contract's block plus the amendments p8-bindings.md records (AM-P8-9:
// BRIEF_LIMITS.purgeLogSettleMs); a change goes through the lead. Nothing here holds brief text, names or tokens.

import type { AttentionCategory, AttentionSource, FactBasis, PriorityBand } from "@/lib/exec/attention-types";
import type { SourceRef } from "@/lib/exec/types";

export const BRIEF_JOB_KINDS = Object.freeze({
  build: "exec.brief", deliver: "exec.brief-deliver", fallback: "exec.brief-fallback", prep: "exec.brief-prep",
  sweep: "exec.brief-sweep", health: "exec.brief-health", checkinSend: "exec.checkin-send",
  checkinRewrite: "exec.checkin-rewrite", opsWatch: "exec.ops-watch", accessAlert: "exec.access-alert"
} as const);

export const BRIEF_LIMITS = Object.freeze({
  // jobs (M3, C24)
  buildTimeoutMs: 240_000, gatherDeadlineMs: 45_000, composeDeadlineMs: 150_000, checkinDeadlineMs: 25_000,
  deliverTimeoutMs: 60_000, fallbackTimeoutMs: 60_000, prepTimeoutMs: 15_000, sweepTimeoutMs: 60_000,
  healthTimeoutMs: 30_000, checkinSendTimeoutMs: 30_000, checkinRewriteTimeoutMs: 60_000, opsWatchTimeoutMs: 30_000,
  accessAlertTimeoutMs: 30_000, purgeTimeoutMs: 300_000, slackCallMs: 10_000, checkinPostMs: 15_000,
  // scheduling (M3, C3–C5, C36, C39)
  watchdogDelayMs: 45 * 60_000, prepLeadMinutes: 15, cutoffFloorLocal: "12:00", cutoffAfterMs: 4 * 3_600_000,
  preModelRetries: 2, preModelRetryDelayMs: 120_000, staleBuildingMs: 10 * 60_000, neverBuiltMs: 2 * 3_600_000,
  staleDeliveringMs: 5 * 60_000, healthLocalTime: "06:00", sweepMinutes: 5, opsWatchMinutes: 15, purgeAtUtc: "03:30",
  staleBuiltMs: 10 * 60_000, checkinSendingStaleMs: 60_000, scrubHoldBackMs: 60_000,   // C48, C50, C16 (intel-11, -17, -13)
  // delivery (M2, C35)
  maxPostAttempts: 2, ambiguityRecheckDelayMs: 3_000, metadataLookbackMs: 60_000, rateLimitedRetryMaxMs: 20_000,
  // gather (M4)
  attentionPageSize: 100, attentionPages: 2, approvalItemsPerMechanism: 3, completedShown: 5, deadlinesShown: 5,
  projectsShown: 5, digestsShown: 6,
  // compose (M4)
  modelItemsMax: 80, modelItemsPerSection: 12, modelFactsPerItem: 3, modelFactChars: 240, modelTitleChars: 200,
  itemTextChars: 280, headlineChars: 160, itemRefsMax: 5, itemsPerSectionStored: 8, top3: 3, mentionsMax: 400,
  // DM (C25)
  dmBlocksMax: 45, dmLinesPerSection: 5, checkinsMessageBlocksMax: 8,
  // check-ins (M6, C8–C10, C45)
  checkinsPerBrief: 3, checkinTextChars: 600, checkinRotationDays: 5, checkinValidityMs: 48 * 3_600_000,
  checkinLookupsMax: 8, checkinHistoryTexts: 3, checkinMacHex: 32,
  // P9 F20 (Area D): the Slack lookups' own bound (the loop keeps who resolved by then); the model call's own deadline,
  // min(checkinModelMs, what is left of the build - checkinAfterModelMs), measured after the recipients are chosen; the
  // steps after the model (insert, a regenerate's chat.update) run under checkinAfterModelMs.
  checkinLookupsMs: 10_000, checkinModelMs: 60_000, checkinAfterModelMs: 10_000,
  // storage (M8, M9, C28)
  contentTtlDays: 30, rowTtlDays: 180, checkinTtlDays: 30, mentionTtlDays: 90, purgeBatch: 1_000, purgeRounds: 10,
  scrubBatch: 500, purgeLogBatch: 200, purgeLogBatchesPerRun: 10, revokedReadingPerDay: 50, fallbackDmDeletesPerDay: 50,
  // p8-bindings.md AM-P8-9 (fact (e), P7b fixer correctness-1): the Slack scrub cursor never passes a purge-log row younger
  // than this (an outbox id is allocated at insert, not at commit, so a lower id can commit after a higher one).
  purgeLogSettleMs: 15 * 60_000,
  // routes (C22, C29)
  regenerateLimit: 6, dryRunLimit: 3, routeWindowMs: 3_600_000, settingsLimit: 30, settingsWindowMs: 600_000,
  regenLockSeconds: 300,
  // network alerts (M13, C20)
  networkLookbackDays: 30, networkLearningRows: 20, networkRecentExclusionMs: 10 * 60_000, networkLogRowsMax: 5_000
});

export const BRIEF_SECTION_KEYS = [
  "emails", "slack", "client_requests", "progress", "work", "delayed", "blockers", "approvals", "decisions", "commitments"
] as const;
export type BriefSectionKey = (typeof BRIEF_SECTION_KEYS)[number];

// ---- ownership (M1) ----
export type BriefOwner = "exec" | "legacy" | "exec_page_only";
export type BriefOwnerReason =
  | "exec_disabled" | "not_installed" | "exec_delivered" | "brief_off" | "legacy_delivered" | "not_superseding"
  | "no_installation" | "owns";
export interface BriefOwnershipFacts {
  /** EXEC_ENABLED === "true" and the principal is enabled (C2). */
  execEnabled: boolean;
  tablesReady: boolean;
  briefEnabled: boolean;
  supersede: boolean;
  installationActive: boolean;
  /** The day's exec_briefs row has delivered_at or fallback_sent_at. */
  execDeliveredToday: boolean;
  /** A daily_briefings row was delivered inside this local day. */
  legacyDeliveredToday: boolean;
}
export interface BriefOwnershipVerdict { owner: BriefOwner; reason: BriefOwnerReason }

// ---- the row (M2) ----
export type BriefStatus = "building" | "built" | "delivering" | "delivered" | "delivery_unknown" | "page_only" | "failed";
export type BriefPageOnlyReason =
  | "legacy_delivered" | "not_superseding" | "no_installation" | "after_cutoff" | "after_fallback" | "delivery_failed"
  | "rate_limited" | "ownership_lapsed" | "regenerated" | "screen_unavailable";
export type BriefFailReason = "pre_model" | "post_model" | "stale_build" | "never_built";
export type BriefUnknownReason = "ambiguous_twice" | "lookup_failed" | "stale_delivering";
export type BriefMode = "ai" | "deterministic";
export type BriefModeReason = "refused" | "truncated" | "budget" | "invalid_output" | "model_error" | "timeout";
export type BriefTrigger = "schedule" | "retry" | "regenerate";
export type BriefDeliverMode = "full" | "same_day" | "late";
export type BriefChannel = "exec_bot" | "dd_bot_fallback" | "page_only" | "none" | "unknown";

export interface BriefRow {
  id: string; principalId: string; localDate: string; tz: string; scheduledAt: string; rev: number;
  status: BriefStatus; statusReason: string | null; owner: BriefOwner | null; ownerReason: BriefOwnerReason | null;
  mode: BriefMode | null; modeReason: BriefModeReason | null; content: BriefContent | null;
  buildStartedAt: string | null; builtAt: string | null; regenLockUntil: string | null; regenSeq: number; noveltyMarkedAt: string | null;
  deliveryStartedAt: string | null; postAttempts: number; deliveredAt: string | null; slackChannelId: string | null;
  slackTs: string | null; checkinsTs: string | null; lateNoteTs: string | null; fallbackSentAt: string | null;
  fallbackSlackTs: string | null; fallbackChannelId: string | null; fallbackDeleteAfter: string | null; fallbackDeletedAt: string | null;
  fallbackErrorCode: string | null; scrubbedAt: string | null; dmFollowedAt: string | null;
  errorCode: string | null; contentExpiresAt: string; contentPurgedAt: string | null; expiresAt: string;
  createdAt: string; updatedAt: string;
}

// ---- gather and compose (M4) ----
export type SectionState = "ok" | "not_connected" | "off" | "unavailable";
export type NoveltyVerdict = "new" | "changed" | "escalated" | "pending" | "unchanged";

/** One gathered item, in memory only. Untrusted text (email/Slack-derived) is wrapped before any model sees it. */
export interface BriefInputItem {
  alias: string;                 // "i1".."iN" in priority order across the whole gather
  fingerprint: string;           // the attention fingerprint, or a P8 synthetic one (§3.8)
  stateHash: string;
  section: BriefSectionKey;
  source: AttentionSource;
  kind: string;
  category: AttentionCategory;
  band: PriorityBand;
  score: number;
  basis: FactBasis;              // the strongest basis among its facts: ai > derived > record
  title: string;                 // ≤ 200
  facts: string[];               // ≤ 3, each ≤ 240
  next: string | null;           // ≤ 200
  refs: SourceRef[];             // ≤ 5; URLs already passed isAllowedLinkUrl or are null
  threadIds: string[];           // P3 thread ids it rests on
  slackKeys: string[];           // "m:<channel>:<ts>" | "d:<channel>:<YYYY-MM-DD>"
  slackChannels: string[];
  untrusted: boolean;
  occurredAt: string | null;
}
export interface BriefSectionGather {
  key: BriefSectionKey;
  state: SectionState;
  /** A BRIEF_COPY.state key when state ≠ "ok". */
  stateNote: BriefStateNote | null;
  items: BriefInputItem[];
  /** Small named counters for the section's context line (e.g. reply, urgent for emails). */
  stats: Record<string, number>;
}
export type BriefStateNote =
  | "email_off" | "email_no_pin" | "email_unavailable" | "slack_not_installed" | "slack_not_connected" | "slack_reading_revoked"
  | "slack_reading_off" | "slack_discovering" | "slack_unavailable" | "ddtext_off" | "unavailable";
export interface BriefGather {
  localDate: string; tz: string; nowIso: string;
  sections: BriefSectionGather[];          // the 10 keys, BRIEF_SECTION_KEYS order
  restrictedEmail: number | null;          // null: couldn't be read
  slackUnanswered: number | null;
  failures: string[];                      // the read names that failed (ids only)
}

export interface BriefItem {
  id: string;                              // "b1".."bN" inside one content
  text: string;                            // ≤ 280
  kind: "fact" | "recommendation";
  basis: FactBasis;                        // "ai" for every model-written line
  band: PriorityBand;
  aliases: string[]; fps: string[]; refs: SourceRef[];
  threadIds: string[]; slackKeys: string[]; slackChannels: string[];
  scrubbed?: true;
}
export interface BriefPendingLine {
  fp: string; title: string; band: PriorityBand; since: string | null; refs: SourceRef[];
  threadIds: string[]; slackKeys: string[]; slackChannels: string[];
}
export interface BriefTopItem {
  itemId: string | null;                   // the BriefItem that cites it, when one does
  alias: string; fp: string; title: string; next: string | null; refs: SourceRef[];
  threadIds: string[]; slackKeys: string[]; slackChannels: string[];
}
export interface BriefSectionContent {
  key: BriefSectionKey; state: SectionState; stateNote: BriefStateNote | null;
  items: BriefItem[]; pending: BriefPendingLine[]; unchanged: number; more: number; stats: Record<string, number>;
}
export interface BriefContent {
  v: 1;
  localDate: string; tz: string; rev: number; builtAt: string; trigger: BriefTrigger;
  mode: BriefMode; modeReason: BriefModeReason | null; top3Fallback: boolean;
  headline: string | null;
  sections: BriefSectionContent[];
  top3: BriefTopItem[];
  novelty: Record<string, NoveltyVerdict>;
  counts: { new: number; changed: number; escalated: number; pending: number; unchanged: number;
    restrictedEmail: number | null; slackUnanswered: number | null };
  failures: string[];
  scrubbed?: true;
  /** intel-14: set (with headline null) by a scrub that changed anything; the headline can't be scrubbed by ref. */
  headlineScrubbed?: true;
}
/** The model's raw shape (validated in brief-validate.ts, never stored as is). */
export interface BriefModelOutput {
  headline: string;
  sections: { key: string; items: { text: string; refs: string[]; kind: string }[] }[];
  top3: string[];
}

// ---- check-ins (M6) ----
export type CheckinStatus = "proposed" | "sending" | "sent" | "unknown" | "failed" | "expired";
export interface CheckinRow {
  id: string; briefId: string; principalId: string; localDate: string; briefRev: number; rev: number;
  recipientUserId: string; recipientSlackId: string; text: string; status: CheckinStatus; statusReason: string | null;
  sendingAt: string | null; sentAt: string | null; slackChannelId: string | null; slackTs: string | null;
  auditId: number | null; expiresAt: string; purgeAt: string; createdAt: string; updatedAt: string;
}
export interface NewCheckin {
  briefId: string; localDate: string; briefRev: number; recipientUserId: string; recipientSlackId: string; text: string;
  expiresAt: string; purgeAt: string;
}
export interface CheckinCandidate {
  userId: string; firstName: string; departments: string[]; role: "department_head" | "worker";
  daysSinceLast: number | null; openTasks: number; slackUserId: string;
}
/** What a renderer gets per row; value is the button value, present only while the row can be sent. */
export interface CheckinView {
  id: string; firstName: string; text: string; status: CheckinStatus; statusReason: string | null;
  sentAt: string | null; value: string | null;
}
export type OwnerTokenVerdict =
  | { state: "ok"; userId: string; teamId: string }
  | { state: "mismatch" } | { state: "missing" } | { state: "revoked"; code: string } | { state: "error"; code: string };
export interface TokenHealthState { state: OwnerTokenVerdict["state"] | "no_installation"; checkedAt: string }

// ---- job payloads (references only, §0.3 rule 5) ----
export interface BriefBuildPayload {
  local_date: string; scheduled_at: string; trigger: BriefTrigger;
  /** regenerate: the claimed row and rev (the route claims synchronously, §3.17.4). */
  brief_id?: string; expected_rev?: number;
  /** retry: 1 or 2 (C5). */
  retry?: number;
}
export interface BriefDeliverPayload { brief_id: string; local_date: string; rev: number; mode: BriefDeliverMode }
export interface BriefFallbackPayload { local_date: string; scheduled_at: string }
export interface BriefPrepPayload { local_date: string }
export interface CheckinActionPayload {
  installation_id: string; checkin_id: string; rev: number; value: string; channel_id: string; message_ts: string;
}
export interface AccessAlertPayload { net: string; family: string; at: string }

// ---- keys ----
export const briefJobKey = (principalId: string, localDate: string): string => `exec.brief:${principalId}:${localDate}`;
export const briefRetryKey = (principalId: string, localDate: string, n: number): string => `exec.brief:${principalId}:${localDate}:r${n}`;
/** C47 (intel-12): rev = the rev the claim saw; seq = the claim's regen_seq, so every regenerate claim gets a fresh key. */
export const briefRegenKey = (principalId: string, localDate: string, rev: number, seq: number): string =>
  `exec.brief:${principalId}:${localDate}:g${rev}.${seq}`;
export const briefDeliverKey = (principalId: string, localDate: string, rev: number, mode: BriefDeliverMode): string =>
  `exec.brief-deliver:${principalId}:${localDate}:${rev}:${mode}`;
export const slackMessageBriefKey = (channelId: string, ts: string): string => `m:${channelId}:${ts}`;
export const slackDigestBriefKey = (channelId: string, localDate: string): string => `d:${channelId}:${localDate}`;
export const BRIEF_METADATA_EVENT = "exec_brief";
