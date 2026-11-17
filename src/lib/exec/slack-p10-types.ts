// P10 shared types and constants (contract §3.1; stage 0, lead seed, frozen). Pure and client-safe: type-only imports.
import type { ConvType, SlackItemKind } from "@/lib/exec/slack-read-types";

export const P10_JOB_KINDS = Object.freeze({
  leadCount: "exec.slack-lead-count",
  replyGenerate: "exec.slack-rdraft-generate",
  replyPlan: "exec.slack-rdraft-plan",
  replySend: "exec.slack-rdraft-send",
  replyAct: "exec.slack-rdraft-act",
  replySweep: "exec.slack-rdraft-sweep",
  voiceRefresh: "exec.slack-voice-refresh",
  replyTokenCheck: "exec.slack-reply-token-check"   // v1.1 product-4 (C60)
} as const);

export const P10_LIMITS = Object.freeze({
  // lead counts (C13-C24)
  leadRunTimeoutMs: 300_000, leadRunBoxMs: 240_000, leadLeaseMs: 330_000, leadPagesPerRun: 100, leadPagesPerChannel: 10,
  leadPageLimit: 100, leadPageLimitRetry: 25, leadFinalDays: 7, leadMemberPages: 20, leadEveryInWindow: 2, leadEveryOffWindow: 6,
  leadBriefRows: 12, leadDmRows: 8, leadLabelChars: 120, leadClassifyDelayMs: 11 * 60_000, leadFailingRuns: 3, leadMapChunk: 200,
  // v1.1: correctness-2 (per-day fallback, final-pass retry), correctness-11 (retention clamp), product-10 (fix lists)
  leadPagesPerDay: 10, leadFinalRetryMs: 6 * 3_600_000, leadRetentionMinDays: 7, leadRetentionMaxDays: 365,
  leadNotMemberMax: 50, leadFixListMax: 50, readAllPreviewMax: 50,
  // reply drafts (C26-C52)
  replyTextChars: 4_000, replyModelTextChars: 1_200, replyInstructionChars: 2_000, replyNoteChars: 400, replyPlaceholdersMax: 20,
  replyContextMax: 80, replyThreadReplies: 50, replyAfterTarget: 10, replyImBefore: 15, replyMessageChars: 1_500,
  replyBlockChars: 12_000, replyCopiedExternalWords: 12, replyMaxTokens: 8_000,
  // v1.1 correctness-1: pack 20 s + model 55 s + finish 5 s inside the 90 s job; a generating row older than 300 s is stale (X12).
  replyGenerateTimeoutMs: 90_000, replyModelDeadlineMs: 55_000, replyPackDeadlineMs: 20_000, replyFinishMs: 5_000,
  replyGeneratingStaleMs: 300_000,
  replyPostMs: 15_000, replySendJobTimeoutMs: 45_000, replyActJobTimeoutMs: 30_000, replySendingStaleMs: 60_000,
  replyIdleDays: 7, replyContentDays: 7, replyRowDays: 30, replyVerifyDelaysMs: Object.freeze([60_000, 300_000, 1_800_000]),
  // v1.1 security-7 / product-3: "It didn't post" only after the third check (sending_at + 31 min at the latest).
  replyVerifyHorizonMs: 31 * 60_000,
  replyPerQuestion: 3, replyCreateLimit: 20, replyEditLimit: 60, replySendLimit: 10, replyRouteWindowMs: 600_000,
  autoPerRun: 5, autoPerDay: 15, autoCardsPerDay: 10, autoMaxAgeMs: 24 * 3_600_000, planMinutes: 10,
  sweepMinutes: 5, sweepTimeoutMs: 120_000, sweepPurgeLogBatch: 200, sweepPurgeLogBatches: 10, purgeLogSettleMs: 15 * 60_000,
  // v1.1 product-4 (C60): the daily token check
  tokenCheckTimeoutMs: 30_000, tokenCheckLocalTime: "06:10",
  // voice (C25)
  voiceConversations: 10, voiceSamplesMax: 60, voiceSamplesMin: 8, voiceSampleChars: 400, voiceSampleMinWords: 3,
  voiceLookbackDays: 30, voiceTtlDays: 30, voiceStaleDays: 8, voiceTimeoutMs: 240_000, voiceBoxMs: 180_000,
  voiceLocalTime: "04:40", voiceIsoWeekday: 7, voiceMaxTokens: 4_000
});

// ---- lead counts ----
export type LeadKind = "vob" | "nonvob" | "calendly" | "zap_errors" | "other";
export const LEAD_KINDS_SHOWN: readonly Exclude<LeadKind, "other">[] = ["vob", "nonvob", "calendly", "zap_errors"];
export type LeadLink = "fb_id" | "fb_name" | "fb_sibling" | "ambiguous" | "none";
/** C12: what readHistoryShapes returns per message. Nothing else ever leaves the reader. */
export interface LeadPostShape {
  ts: string; reply: boolean; bot: boolean; excluded: boolean; hidden: boolean;
  subtypeClass: "none" | "bot_message" | "tombstone" | "other";
}
/** The ids the reader excludes inside itself (the DD bot's user / bot / app ids; USLACKBOT is always excluded). */
export interface LeadExclusions { userIds: readonly string[]; botIds: readonly string[]; appIds: readonly string[] }
/** One typed-list row (exec_slack_fb_lead_channels_v2; name in channelSlug's form). v1.1 product-10: i = the row's position among
 *  its task's rows, in the order the function returns them (the run stores { taskId, i } for listed-not-member entries). */
export interface FbLeadListRow { taskId: string; clientId: string | null; clientLabel: string; name: string | null; channelId: string | null; i: number }
export interface LeadMarkerRow { channelId: string; convType: ConvType; class: string; denyReason: string | null; listed: boolean }
export interface LeadMapRow { channelId: string; kind: LeadKind; link: LeadLink; taskId: string | null; clientId: string | null; clientLabel: string | null }
export interface LeadChannelState {
  channelId: string; kind: LeadKind; link: LeadLink; countedFrom: string | null; finalThrough: string | null;
  countedAt: string | null; lastErrorCode: string | null;
  // v1.1: correctness-2 (the final-pass retry rule) and product-2 / product-9 (per-client coverage of a day)
  finalAttemptAt: string | null; taskId: string | null; clientId: string | null; clientLabel: string | null;
}
export interface LeadDayCount { day: string; n: number; skipped: number; complete: boolean }
export interface LeadSummaryRow {
  groupKey: string; clientId: string | null; taskId: string | null; clientLabel: string | null; kind: LeadKind; day: string;
  n: number; channels: number; complete: boolean; oldestCountedAt: string | null;
}
export interface LeadCoverage {
  channels: number; linked: number; unlinked: number; ambiguous: number; otherKind: number; withError: number;
  neverCounted: number; oldestCountedAt: string | null; skippedToday: number;
}
/** exec_sync_state slack / lead-run (C21): counts and codes only. */
export interface LeadRunSummary {
  at: string; complete: boolean; partial: boolean; needsFinal: number; channels: number; counted: number; pages: number;
  listedNotMember: number; classifyEnqueued: number; errors: Record<string, number>; failingRuns: number;
  /** v1.1 product-2: the code the run ended on when it failed (auth, store, dd_read …), else null. */
  failCode: string | null;
  /** v1.1 product-10: typed-list entries that match no member channel, as (DD task id, position in that onboarding's
   *  exec_slack_fb_lead_channels_v2 rows), ≤ leadNotMemberMax. Never a name or a channel id. */
  notMember: { taskId: string; i: number }[];
}
export interface LeadTriple { vob: number; nonvob: number; calendly: number }
export interface LeadClientCounts {
  label: string; clientId: string | null; vob: number; nonvob: number; calendly: number; zapErrors: number; complete: boolean;
  /** v1.1 product-9: the kinds with a counted channel for this client in this window (zap_errors included); a line prints
   *  exactly these (zeros included), never a kind the client has no counted channel for. */
  kinds: LeadKind[];
}
/** exec_briefs.content.leads (§3.8): one local day, built deterministically, ≤ leadBriefRows rows. */
export interface BriefLeads {
  v: 1; localDate: string; rows: LeadClientCounts[]; more: number;
  totals: { vob: number; nonvob: number; calendly: number; zapErrors: number };
  /** v1.1 product-9: the kinds counted for any client that day (the "All clients" line prints these). */
  totalKinds: LeadKind[];
  unlinked: number; incomplete: boolean; asOf: string | null;
  /** v1.1 product-2: linked, non-other lead channels with no complete row for localDate, and whether the job is failing. */
  notCounted: number; failing: boolean;
  /** v1.1 product-2: localDate differs from the brief zone's yesterday (the title then shows the date). */
  dated: boolean;
  /** v1.1 product-2: lead counts are on but no run has finished yet. */
  firstRun: boolean;
  /** P10 fixer ui-12 (additive, optional: a block stored before it has none): the unlinked group's lead posts by kind (VOB,
   *  non-VOB, Calendly; never Zapier errors), so "Not linked to a client: {counts}" prints a counts line, as the Slack tab
   *  does. `unlinked` is then their sum. */
  unlinkedCounts?: LeadTriple & { kinds: LeadKind[] };
}
/** v1.1 product-2: the block when lead counts are on but the read failed (rendered, never silently dropped: P8 M4). */
export interface BriefLeadsUnavailable { v: 1; unavailable: true; localDate: string }
export type BriefLeadsBlock = BriefLeads | BriefLeadsUnavailable;
/** v1.1 product-10: "first_run" = switched on, no run summary yet. */
export type LeadsViewState = "off" | "not_installed" | "reading_off" | "first_run" | "no_channels" | "ok" | "unavailable";
export interface LeadCountsView {
  state: LeadsViewState; asOf: string | null; tz: string;
  /** v1.1 product-9: the "All clients" row (linked clients only; the unlinked group stays its own row). */
  totals: { today: LeadTriple; yesterday: LeadTriple; last7: LeadTriple; kinds: LeadKind[] } | null;
  clients: { label: string; clientId: string | null; today: LeadTriple; yesterday: LeadTriple; last7: LeadTriple;
    kinds: LeadKind[]; zapToday: number; zapYesterday: number; incomplete: boolean }[];   // v1.1 product-19: Zapier per day
  unlinked: { today: LeadTriple; yesterday: LeadTriple; last7: LeadTriple } | null;
  coverage: (LeadCoverage & { listedNotMember: number; lastRunAt: string | null; lastError: string | null }) | null;
  /** v1.1 product-10: what to fix. hrefs are https://slack.com/app_redirect?channel=<id>&team=<team> (the only place a lead
   *  channel id may appear on a page, LP06); notMember names are as typed on the FB card (DD data). Each list ≤ leadFixListMax. */
  fix: { unlinked: { href: string; kind: LeadKind }[]; ambiguous: { href: string; kind: LeadKind }[];
    notMember: { client: string; names: string[] }[]; more: number } | null;
  /** P10 fixer correctness-3 (additive, optional): some counted lead channel (linked or not) has no whole count for a day of
   *  the 7-day window (today: not counted since local midnight; a past day: not covered by its final pass), or a row is a
   *  lower bound. The card then shows `incomplete`. */
  incomplete?: boolean;
}

// ---- reply drafts ----
export type ReplyOrigin = "web" | "chat" | "slack" | "auto";
export type ReplyStatus = "generating" | "generation_failed" | "draft" | "sending" | "sent" | "unknown" | "failed" | "discarded" | "expired" | "removed";
export const REPLY_ACTIVE_STATUSES: readonly ReplyStatus[] = ["generating", "generation_failed", "draft", "sending", "unknown"];
export type ReplyFlag = "unexpected_url" | "unexpected_email" | "unexpected_phone" | "unexpected_amount" | "unexpected_number" | "mention" | "broadcast";
export const REPLY_FLAGS: readonly ReplyFlag[] =
  ["unexpected_url", "unexpected_email", "unexpected_phone", "unexpected_amount", "unexpected_number", "mention", "broadcast"];
export type ReplyGenerationError = "refused" | "truncated" | "invalid_output" | "empty" | "too_long" | "copied_external" | "timeout"
  | "model_error" | "budget" | "context_unavailable" | "reading_off" | "channel" | "context_deleted" | "author_optout";
export type ReplyBlocker = "placeholders" | "external" | "flags" | "injection" | "already_replied" | "source_edited" | "newer_messages" | "unchecked";
export const REPLY_ACKABLE: readonly Exclude<ReplyBlocker, "placeholders">[] =
  ["external", "flags", "injection", "already_replied", "source_edited", "newer_messages", "unchecked"];
export type ReplyVoiceSource = "slack" | "email" | "house";
export interface ReplyDraftRow {
  id: string; installationId: string; channelId: string; convType: ConvType; itemId: string | null; sourceTs: string;
  sourceThreadTs: string | null; replyThreadTs: string | null; origin: ReplyOrigin; status: ReplyStatus; statusReason: string | null;
  version: number; generationSeq: number; text: string | null; instruction: string | null; note: string | null; placeholders: string[];
  edited: boolean; flags: ReplyFlag[]; injectionSuspected: boolean; voiceSource: ReplyVoiceSource | null;
  generationError: ReplyGenerationError | null; contextTs: string[]; contextAuthors: string[]; contextLatestTs: string | null;
  sourceEditedTs: string | null; external: boolean; finance: boolean; generatedAt: string | null; sendingAt: string | null;
  auditId: number | null; sentAt: string | null; postedTs: string | null; postedPermalink: string | null; sentTextSha256: string | null;
  sentWordsSha256: string | null;   // v1.1 correctness-7
  verifyChecks: number; ownerResolution: "posted" | "not_posted" | null; chatMessageId: string | null; terminalAt: string | null;
  contentPurgedAt: string | null; expiresAt: string; createdAt: string; updatedAt: string;
}
export type CreateReplyRefusal = "not_reading" | "channel" | "message" | "deleted" | "author_optout" | "item" | "off" | "not_installed"
  | "screen" | "not_found" | "not_stored" | "finance_slack" | "cap" | "rate_limited"
  // v1.1: security-6 / correctness-13 (RPC 13's from-draft checks), security-7 (the pre-check found the post), correctness-1
  // (the generation job couldn't be queued; X12 already closed the attempt)
  | "from_draft" | "from_draft_mismatch" | "already_posted" | "unavailable";
export type CreateReplyOutcome =
  | { outcome: "created" | "existing"; id: string; status: ReplyStatus; version: number; generationSeq: number; edited: boolean }   // v1.1 product-7: edited
  | { outcome: "refused"; reason: CreateReplyRefusal };
export interface ReplyTargetFacts {
  found: boolean; readingLive: boolean; channelOk: boolean; finance: boolean; external: boolean; message: boolean; deleted: boolean;
  editedTs: string | null; respondedAt: string | null; itemUrgency: "critical" | "high" | "normal" | "low" | null;
}
/** The model's raw output (SLACK_REPLY_SCHEMA_V1). */
export interface ReplyModelOutput { text: string; note_for_mitchell: string; placeholders: string[]; injection_suspected: boolean }
export type ReplyCardState = "generating" | "failed_generation" | "live" | "dd_only" | "sending" | "sent" | "unknown" | "failed"
  | "discarded" | "expired" | "removed" | "off";
export type SendPath = "web" | "dm";
export type SendRefusal = "not_found" | "not_draft" | "stale" | "text_changed" | "mac_mismatch" | "not_canonical" | "send_off"
  | "rate_limited" | "reading_off" | "target" | "finance_slack" | "placeholders" | "audit_unavailable" | "lost_race" | "token_missing"
  | "token_mismatch" | "token_revoked" | "token_error" | "key_unavailable" | "card" | "unknown_status";
export type SendOutcome =
  | { kind: "sent"; postedTs: string; permalink: string | null }
  | { kind: "in_flight" }
  | { kind: "unknown"; reason: string }
  | { kind: "back_to_draft"; reason: string; version: number }
  | { kind: "needs_ack"; blockers: ReplyBlocker[] }
  | { kind: "dd_only"; blockers: ReplyBlocker[] }
  | { kind: "refused"; reason: SendRefusal; status?: ReplyStatus };
/** v1.1 product-6 (C59): the review call's answer: every blocker the send would raise now, before the dialog opens. */
export type ReplyReview =
  | { kind: "ok"; version: number; blockers: ReplyBlocker[]; place: string; inThread: boolean }
  | { kind: "refused"; reason: SendRefusal; status?: ReplyStatus };
export interface ReplyActionPayload {
  installation_id: string; action: "send" | "rewrite" | "discard"; draft_id: string; version: number; value: string;
  channel_id: string; message_ts: string;
}
export interface ReplyGeneratePayload { draft_id: string; seq: number }
/** Which items "Draft reply" is offered for (C45). */
export const REPLY_OFFER_KINDS: readonly SlackItemKind[] = ["request", "question", "decision"];

// ---- the Slack voice profile (C25) ----
export type SlackVoiceFormality = "very_casual" | "casual" | "neutral" | "formal";
export type SlackVoiceLength = "one_liner" | "short" | "medium" | "long";
export type SlackVoiceCapitalization = "mostly_lowercase" | "standard";
export type SlackVoicePunctuation = "minimal" | "standard";
export type SlackVoiceGreeting = "none" | "name_only" | "hey_name" | "hi_name" | "mixed";
export type SlackVoiceEmoji = "never" | "rarely" | "sometimes" | "often";
export type SlackVoiceFrequency = "never" | "sometimes" | "often";
export interface SlackVoiceProfileRow {
  status: "ready" | "insufficient" | "failed";
  formality: SlackVoiceFormality | null; typicalLength: SlackVoiceLength | null; capitalization: SlackVoiceCapitalization | null;
  punctuation: SlackVoicePunctuation | null; greeting: SlackVoiceGreeting | null; emoji: SlackVoiceEmoji | null;
  abbreviations: SlackVoiceFrequency | null; exclamations: SlackVoiceFrequency | null; bullets: SlackVoiceFrequency | null;
  sampleCount: number; sampleRefs: string[]; sampleChannels: string[]; samplesHash: string | null; model: string | null;
  promptVersion: string; lastAttemptError: string | null; builtAt: string; expiresAt: string;
}
