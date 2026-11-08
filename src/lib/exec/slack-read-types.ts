import type { ExecLlmFeature, ExecSettings } from "@/lib/exec/types";
import type { InstallationRow } from "@/lib/exec/slack-types";

// P7a Slack reading: shared types and constants (P7a contract §3.1; stage 0,
// lead seed, frozen). Pure and client-safe: type-only imports, no
// server-only, no Supabase. Areas change nothing here; a signature changes
// only through the lead. The five functions at the bottom are the lead's own
// (real bodies, not stubs).

export const SLACK_USER_SCOPES_REQUIRED = ["channels:history", "groups:history", "channels:read", "groups:read", "users:read"] as const;
export const SLACK_USER_SCOPES_OPTIONAL = ["im:history", "im:read", "mpim:history", "mpim:read"] as const;
export type SlackUserScope = (typeof SLACK_USER_SCOPES_REQUIRED)[number] | (typeof SLACK_USER_SCOPES_OPTIONAL)[number];

export type ConvType = "channel" | "group" | "im" | "mpim";
export type ChannelClass = "unclassified" | "deny" | "hub" | "finance" | "external" | "standard";
export type DenyReason = "assistant_dm" | "dd_bot_dm" | "self_dm" | "bot_im" | "fb_list" | "lead_name";
export type HubKind = "outbound" | "client_email";
export type WatchState = "watched" | "muted" | "unwatched";
export type MuteSource = "owner" | "default_finance" | "slack";
export type ReadingState = "none" | "discovering" | "ready" | "revoked";
export type UserRevokeReason = "stopped" | "tokens_revoked" | "disconnected" | "app_uninstalled" | "installation_revoked";
export type SlackItemKind = "request" | "question" | "decision" | "commitment" | "action_item" | "fyi";
export type TriageState = "pending" | "assessed" | "unassessed" | "refused" | "failed" | "skipped";
export type ItemSourceClass = "public" | "private" | "finance";
export type RateClass = "triage" | "sweep" | "probe" | "discovery";
export type MeteredMethod =
  | "conversations.history" | "conversations.replies" | "conversations.info" | "users.conversations"
  | "conversations.list" | "users.list" | "users.info" | "chat.getPermalink";
export type LifecycleKind = "created" | "rename" | "archive" | "unarchive" | "deleted" | "left" | "shared" | "unshared" | "id_changed";
/** exec_slack_deleted.reason: an event (message_deleted, or a tombstone event), absence in a fully paged window, or a
 *  tombstone seen in a sweep or triage fetch (C16). */
export type DeletedReason = "event" | "absent" | "tombstone";

/** exec_slack_messages.reasons bits (N8). */
export const REASON = Object.freeze({ dm: 1, mention: 2, hisThread: 4 } as const);

export const SLACK_READ_JOB_KINDS = Object.freeze({
  discover: "exec.slack-discover", classify: "exec.slack-classify", sweep: "exec.slack-read-sweep", probe: "exec.slack-probe",
  triage: "exec.slack-triage", attention: "exec.slack-attention", rekey: "exec.slack-rekey",
  userCheck: "exec.slack-user-check", readPurge: "exec.slack-read-purge", recheck: "exec.slack-read-recheck"
} as const);

export const SLACK_READ_LIMITS = Object.freeze({
  excerptChars: 280, summaryChars: 200, dueTextChars: 60, authorLabelChars: 80, mentionsMax: 20,
  contextMessages: 8, messageChars: 1_500, blockChars: 12_000,
  sweepIntervalMin: 30, offWindowEvery: 6, workDayStart: "08:00", workDayEnd: "19:00",
  overlapMs: 10 * 60_000, lookbackDays: 7, deepEveryMs: 3 * 3_600_000, deepMaxPages: 5, normalMaxPages: 3, pageLimit: 200,
  sweepTimeBoxMs: 120_000, sweepTimeoutMs: 180_000, sweepTargets: 200,
  probeIntervalMin: 15, probeTimeBoxMs: 60_000, probeTimeoutMs: 90_000, probeStaleDays: 7, probeTargets: 30,
  activeThreshold: 10, activeWindowDays: 30, probePageLimit: 100,
  discoverTimeBoxMs: 240_000, discoverTimeoutMs: 300_000, discoverChunk: 200,
  classifyTimeoutMs: 60_000, classifyCatchUpMs: 3_600_000, triageTimeoutMs: 90_000, attentionTimeoutMs: 120_000,
  rekeyTimeoutMs: 60_000, userCheckTimeoutMs: 30_000, readPurgeTimeoutMs: 120_000, recheckTimeoutMs: 60_000,
  triageMaxAttempts: 6, permalinksPerJob: 10, rateWaitMaxMs: 10_000, rateBatch: 5,
  gateFreshMs: 5 * 60_000, gateRefreshMs: 60_000, gateActiveWindowMs: 10 * 60_000, v2AbsentMs: 5 * 60_000,
  attentionWindowDays: 14, commitmentOverdueMaxDays: 30, deletedMarkerHours: 26, purgeLogDays: 7,
  ddBotTtlMs: 24 * 3_600_000, classifierContextTtlMs: 10 * 60_000, slackCapShare: 0.2,
  outageMissed: 20, outageAgeMs: 30 * 60_000, pickerRows: 1_000
});

/** C17: the features the Slack sub-cap sums. P7b appends its digest feature. */
export const SLACK_CAP_FEATURES: readonly ExecLlmFeature[] = Object.freeze(["slack_triage"] as ExecLlmFeature[]);
/** C19: the attention kinds of source "slack" one sync owns. P7b appends its kinds (the sync scope is this array). */
export const SLACK_ATTENTION_KINDS = ["slack_decision", "slack_request", "slack_commitment", "slack_unassessed"] as const;
export type SlackAttentionKind = (typeof SLACK_ATTENTION_KINDS)[number];

/** The opened user token. Built only by slack-install.ts; passed only to sources/slack.ts reads (B-P7a-7). Never logged. */
export interface ReadTarget { readonly userToken: string; readonly teamId: string; readonly userId: string }
export interface ReadingHalf {
  state: ReadingState; scopes: SlackUserScope[]; installedAt: string | null; revokedAt: string | null;
  revokeReason: UserRevokeReason | null; discoveredAt: string | null; purgedAt: string | null;
  lastErrorCode: string | null; lastErrorAt: string | null; hasToken: boolean;
}
export interface ReadingInstallation { row: InstallationRow; reading: ReadingHalf; target: ReadTarget }

/** §2.4, camelCased. Derived in memory from one event; carries no text. */
export interface IngestFacts {
  kind: "msg" | "edit" | "delete" | "lifecycle"; conv: ConvType | null;
  ts: string | null; threadTs: string | null; editedTs: string | null; deletedTs: string | null;
  author: string | null; authorTeam: string | null; parentUser: string | null; mentions: string[];
  isBot: boolean; appId: string | null; ddTemplate: boolean; broadcast: boolean; question: boolean;
  len: 0 | 1 | 2 | 3; hints: number; files: boolean; extShared: boolean;
  authUser: string | null; authIsBot: boolean;
  lc: LifecycleKind | null; name: string | null; newChannel: string | null; isExtShared: boolean | null;
  /** C46: extractDdPaths of the effective message (DD-relative paths, ≤ 20; DD ids, not Slack text). [] for delete/lifecycle. */
  ddPaths: string[];
}
export type PrefilterDrop = "hidden" | "noise_subtype" | "bot_no_mention" | "edit_noop" | "no_channel";

export type AcceptEventV2Result =
  | { outcome: "accepted"; decision: string; reason: string | null; recorded?: boolean; enqueued?: boolean; interactive?: boolean; path: "v1" | "v2" }
  | { outcome: "duplicate"; path: "v1" | "v2" }
  | { outcome: "v2_missing" }
  | { outcome: "not_installed" };

/** Job payloads (references only). */
export interface SlackDiscoverPayload { installation_id?: string; reason?: "consent" | "retry" }   // scheduled daily runs: {}
export interface SlackClassifyPayload { installation_id: string; channel: string }
export interface SlackSweepPayload { reason?: "brief" | "owner" | "discover" }                     // scheduled runs: {}
export interface SlackTriagePayload { installation_id: string; channel: string; root: string; mode: "window" | "retriage"; ts?: string }
export interface SlackRekeyPayload { installation_id: string; old_channel: string; new_channel: string }
export interface SlackUserCheckPayload { installation_id: string; event_time: number }
export interface SlackReadPurgePayload { installation_id: string; reason: "app_uninstalled" | "recheck" | "uninstall_job" }

export interface ChannelRow {
  channelId: string; installationId: string; convType: ConvType; class: ChannelClass; denyReason: DenyReason | null;
  hubKind: HubKind | null; financeName: boolean; watchState: WatchState; muteSource: MuteSource | null; watchSetByOwnerAt: string | null;
  name: string | null; imUserId: string | null; isMember: boolean; isPrivate: boolean; isExtShared: boolean; extEver: boolean;
  isArchived: boolean; histWatermarkTs: string | null; deepSweptAt: string | null; sweptAt: string | null;
  lastEventTs: string | null; lastActivityTs: string | null; activity30d: number | null; probedAt: string | null;
  classifiedAt: string | null; leftAt: string | null; updatedAt: string;
}
/** What sources/slack.ts returns per conversation, and what the classifier reads. */
export interface ConversationMeta {
  id: string; convType: ConvType; name: string | null; isMember: boolean; isPrivate: boolean;
  isExtShared: boolean; isPendingExtShared: boolean; isArchived: boolean; imUser: string | null;
}
export interface Classification {
  class: ChannelClass; denyReason: DenyReason | null; hubKind: HubKind | null;
  /** C10/C45: isFinanceName(name) for a named finance/external channel; false for every other class and for im/mpim. */
  financeName: boolean;
  defaultWatch: WatchState; defaultMute: "default_finance" | "slack" | null;
}
/** One exec_slack_apply_classes row (identical key set). */
export interface ClassRow {
  channel_id: string; conv_type: ConvType; class: ChannelClass; deny_reason: DenyReason | null; hub_kind: HubKind | null;
  finance_name: boolean;
  default_watch: WatchState; default_mute: "default_finance" | "slack" | null; name: string | null; im_user_id: string | null;
  is_member: boolean; is_private: boolean; is_ext_shared: boolean; is_archived: boolean;
}
/** One exec_slack_note_messages row (identical key set; anchors set author null, reasons 0, author_external false).
 *  dd_paths: extractDdPaths of the message (C46), [] when none. */
export interface NoteRow { ts: string; thread_ts: string | null; role: "candidate" | "anchor"; author: string | null; author_external: boolean; reasons: number; dd_paths: string[] }
export interface FromHimRow { ts: string; thread_ts: string | null; mentions: string[] }
export interface CandidateRow {
  ts: string; threadTs: string | null; authorUserId: string | null; authorExternal: boolean; reasons: number;
  triageState: TriageState; contentHash: string | null; editedTs: string | null; respondedTs: string | null;
}
/** One exec_slack_write_items row (identical key set). source_class is the TS twin's value; SQL derives and stores its own
 *  (C45) and reports a difference as class_mismatch. author_internal_verified: users.info confirmed our team and the
 *  message's user_team (when present) is ours; without it SQL nulls the excerpt in a shared conversation (C33). */
export interface ItemWriteRow {
  ts: string; kind: SlackItemKind; author: string | null; author_label: string | null; author_external: boolean;
  author_internal_verified: boolean;
  assessed: boolean; addressed: boolean; needs_response: boolean; bypass_mute: boolean;
  urgency: "critical" | "high" | "normal" | "low"; summary: string | null; excerpt: string | null;
  due_text: string | null; due_at: string | null; direction: "mitchell_owes" | "owed_to_mitchell" | null;
  source_class: ItemSourceClass;
}
export interface ItemOutcome { ts: string; state: Exclude<TriageState, "pending">; content_hash: string | null }
export interface SlackItemRow {
  id: string; channelId: string; ts: string; kind: SlackItemKind; threadTs: string | null; authorUserId: string | null;
  authorLabel: string | null; authorExternal: boolean; assessed: boolean; addressedToYou: boolean; needsResponse: boolean;
  bypassMute: boolean; urgency: "critical" | "high" | "normal" | "low"; summary: string | null; excerpt: string | null;
  dueText: string | null; dueAt: string | null; commitmentDirection: "mitchell_owes" | "owed_to_mitchell" | null;
  sourceClass: ItemSourceClass; permalink: string | null; respondedTs: string | null; respondedAt: string | null;
  acknowledgedAt: string | null; expiresAt: string; createdAt: string;
}
export type SlackReadingViewState = "not_installed" | "bot_not_connected" | "not_consented" | "discovering" | "paused" | "on" | "revoked" | "error";

// ---------------------------------------------------------------------------
// The lead's functions (frozen behaviour, real bodies)
// ---------------------------------------------------------------------------

/** SLACK_RE.ts (slack-types.ts): seconds, a dot, a fraction. Kept local so this file's imports stay type-only. */
const TS = /^([0-9]{1,12})\.([0-9]{1,8})$/;
const FINGERPRINT = /^slack:msg:([CGD][A-Z0-9]{2,30}):([0-9]{1,12}\.[0-9]{1,8})$/;

function tsParts(ts: unknown, fn: string): { sec: number; frac: string } {
  const m = typeof ts === "string" ? TS.exec(ts) : null;
  if (!m) throw new TypeError(`${fn}: not a Slack ts`);
  return { sec: Number(m[1]), frac: m[2] };
}

/** Numeric compare of two Slack ts strings that match SLACK_RE.ts (throws TypeError otherwise). Never string compare. */
export function compareTs(a: string, b: string): number {
  const x = tsParts(a, "compareTs");
  const y = tsParts(b, "compareTs");
  if (x.sec !== y.sec) return x.sec < y.sec ? -1 : 1;
  // The fraction is a decimal fraction of a second: right-pad to the longest form (8 digits) and compare as integers.
  const fx = Number(x.frac.padEnd(8, "0"));
  const fy = Number(y.frac.padEnd(8, "0"));
  return fx === fy ? 0 : fx < fy ? -1 : 1;
}

/** floor(seconds × 1000 + micro / 1000); micro = the fraction read as microseconds (digits past the sixth dropped). */
export function tsToMs(ts: string): number {
  const { sec, frac } = tsParts(ts, "tsToMs");
  const micro = Number(frac.padEnd(6, "0").slice(0, 6));
  return Math.floor(sec * 1000 + micro / 1000);
}

/** `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, "0")}` of a whole, non-negative ms value. */
export function msToTs(ms: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) throw new TypeError("msToTs: not a non-negative time");
  const whole = Math.floor(ms);
  return `${Math.floor(whole / 1000)}.${String((whole % 1000) * 1000).padStart(6, "0")}`;
}

export const slackMsgFingerprint = (channel: string, ts: string): string => `slack:msg:${channel}:${ts}`;

/** "slack:msg:<C|G|D…>:<ts>" → parts; anything else → null. */
export function parseSlackMsgFingerprint(fp: string): { channelId: string; ts: string } | null {
  const m = typeof fp === "string" ? FINGERPRINT.exec(fp) : null;
  return m ? { channelId: m[1], ts: m[2] } : null;
}

function money(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** C17: floor(min(slackDailyCapUsd, 0.2 × dailyCostCapUsd) × 100) / 100; ≤ 0 → 0 (paused). */
export function effectiveSlackCapUsd(s: Pick<ExecSettings, "slackDailyCapUsd" | "dailyCostCapUsd">): number {
  const slack = money(s?.slackDailyCapUsd);
  const daily = money(s?.dailyCostCapUsd) * SLACK_READ_LIMITS.slackCapShare;
  // As P5b's effectiveChatCapUsd: the epsilon keeps a product like 0.2 × 15 (= 3.0000000000000004) or 0.2 × 0.35
  // (= 0.06999…) from flooring a cent away.
  const cents = Math.floor(Math.min(slack, daily) * 100 + 1e-6);
  return cents > 0 ? cents / 100 : 0;
}
