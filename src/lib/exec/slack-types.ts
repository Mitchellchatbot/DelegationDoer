import type { ErrorClass, WatchMode } from "@/lib/exec/types";
import type {
  DenyReason,
  MuteSource,
  SlackReadingViewState,
  UserRevokeReason,
  WatchState
} from "@/lib/exec/slack-read-types";

// P6 Slack app: shared types and constants (P6 contract §3.1; stage 0, lead
// seed, frozen). Pure and client-safe: one type-only import, no server-only,
// no Supabase. Areas change nothing here; a signature changes only through
// the lead.
//
// P7a stage -1 (lead, P7a contract §3.20.3, additive): SlackMethod gains the
// seven read methods, SlackConnectResult the five read codes, and the views
// gain the reading half (SlackSettingsView.reading?, SlackSystemSummary.reading?,
// PickerRow, SlackReadingView, SlackReadingSummary; P7a §3.16). The two view
// fields are optional so every P6 literal still compiles: absent = the P7a
// pieces haven't filled them (treated as "not installed" / no row).

export const SLACK_BOT_SCOPES = ["chat:write", "im:history", "im:read", "im:write", "users:read", "users:read.email"] as const;
export type SlackBotScope = (typeof SLACK_BOT_SCOPES)[number];

export const SLACK_JOB_KINDS = Object.freeze({
  reply: "exec.slack-reply", action: "exec.slack-action", card: "exec.slack-card", home: "exec.slack-home",
  uninstall: "exec.slack-uninstall", sweep: "exec.slack-sweep", dmPurge: "exec.slack-dm-purge"
} as const);

export const SLACK_LIMITS = Object.freeze({
  sectionChars: 3_000, sectionSafeChars: 2_990, blocksPerMessage: 50, blocksPerHome: 100, contextElements: 10,
  linkLabelChars: 120, draftPreviewChars: 1_500, emailExcerptChars: 300, questionChars: 4_000,
  staleEventMs: 15 * 60_000, stalePlaceholderMs: 10 * 60_000, eventRetentionHours: 25,
  httpTimeoutMs: 10_000, ackRpcTimeoutMs: 2_000, signatureWindowSec: 300, bodyMaxBytes: 1_048_576,
  oauthStateTtlSec: 600, actionValueChars: 200, homeItems: 5, dmPurgeMaxDeletes: 80, dmPurgeMaxPages: 5,
  replyTimeoutMs: 300_000, actionTimeoutMs: 420_000, cardTimeoutMs: 30_000, homeTimeoutMs: 30_000,
  uninstallTimeoutMs: 60_000, sweepTimeoutMs: 60_000, dmPurgeTimeoutMs: 120_000, ownTimeoutMs: 10_000,
  // v2
  homeSectionTimeoutMs: 8_000, followupsPerSweep: 20, verbatimRunChars: 300, verbatimKeepChars: 280,
  inlineCodeSpanMaxChars: 1_000
});

/** Every Slack Web API method P6 calls (fake-slack-api.ts keys its handlers by these); P7a (§3.6.1) adds the seven reads. */
export type SlackMethod =
  | "oauth.v2.access" | "auth.test" | "auth.revoke" | "users.lookupByEmail" | "conversations.open"
  | "conversations.history" | "conversations.replies" | "chat.postMessage" | "chat.update" | "chat.delete" | "views.publish"
  | "conversations.list" | "users.conversations" | "conversations.info" | "users.list" | "users.info" | "bots.info" | "chat.getPermalink";

/** C43: what a ledger row records about one bot post (no text). */
export type SlackPostKind = "answer" | "note" | "draft" | "proposal";
export interface SlackPostLedger { kind: SlackPostKind; messageId?: string | null; refId?: string | null }
/** C42: RPC 7's answer. changedAt is the value markPostFollowed stores. */
export interface RedactionFollowups {
  answers: { ts: string; messageId: string; conversationId: string; changedAt: string }[];
  drafts: { ts: string; draftId: string; changedAt: string }[];
  /** (c) proposal cards whose proposal was redacted after the card last showed it (additive: a card can post after (a) followed its answer). */
  proposals?: { ts: string; proposalId: string; changedAt: string }[];
}

/** Slack ids and ts values (the RPCs re-check the same patterns). */
export const SLACK_RE = Object.freeze({
  team: /^T[A-Z0-9]{2,30}$/, app: /^A[A-Z0-9]{2,30}$/, user: /^[UW][A-Z0-9]{2,30}$/, bot: /^B[A-Z0-9]{2,30}$/,
  dm: /^D[A-Z0-9]{2,30}$/, ts: /^[0-9]{1,12}\.[0-9]{1,8}$/, eventId: /^Ev[A-Za-z0-9]{2,40}$/,
  trigger: /^[A-Za-z0-9.]{1,200}$/, installationId: /^esi_[0-9a-f]{32}$/
});

export type SlackActionId =
  | "ea_draft_save" | "ea_draft_regen" | "ea_card_refresh" | "ea_task_create" | "ea_task_dismiss" | "ea_fb_up" | "ea_fb_down";
/** URL buttons: acked by the route, never enqueued. */
export type SlackLinkActionId = "ea_open_dd";
export const SLACK_ACTION_IDS: readonly SlackActionId[] =
  ["ea_draft_save", "ea_draft_regen", "ea_card_refresh", "ea_task_create", "ea_task_dismiss", "ea_fb_up", "ea_fb_down"];

/** C14 value formats. */
export const SLACK_VALUE_RE = Object.freeze({
  draft: /^d1\.(ed_[0-9a-f]{32})\.([0-9]{1,9})$/,          // v2: no ".p" suffix (C15)
  proposal: /^t1\.(etp_[0-9a-f]{32})\.([0-9a-f]{64})$/,
  feedback: /^f1\.(ecm_[0-9a-f]{32})$/
});

export type ReplyState = "queued" | "started" | "placeholder" | "answered" | "failed" | "skipped" | "swept";
export type SlackEventDecision = "reply" | "home" | "revoke" | "revoke_check" | "drop";
export type RevokeReason = "app_uninstalled" | "tokens_revoked" | "disconnected";

/** What the events route passes to RPC 1 (§2.1.6), derived from the envelope; no text. */
export interface SlackEventFacts {
  eventId: string; teamId: string; apiAppId: string; eventType: string; eventTime: number; retryNum: number;
  channel: string | null; channelType: string | null; user: string | null; ts: string | null; threadTs: string | null;
  hasBotId: boolean; hasAppId: boolean; subtype: string | null; hidden: boolean; textIsString: boolean; hasMessage: boolean;
  tab: string | null; revokedBotIds: string[]; revokedUserIds: string[];
}
export type AcceptEventResult =
  | { outcome: "accepted"; decision: SlackEventDecision; reason: string | null; enqueued: boolean; interactive: boolean }
  | { outcome: "duplicate" }
  | { outcome: "not_installed" };            // the RPC or table is missing (migration not applied)

/** What the interactions route passes to RPC 2 (§2.1.7). */
export interface SlackActionFacts {
  teamId: string; apiAppId: string; userId: string; triggerId: string; actionId: string; value: string;
  containerType: string; channelId: string | null; messageTs: string | null;
}
export type AcceptActionResult =
  | { outcome: "enqueued" } | { outcome: "duplicate" } | { outcome: "ignored"; reason: string } | { outcome: "not_installed" };

/** Job payloads (references only, K7). */
export interface SlackReplyPayload { event_id: string; installation_id: string; channel: string; ts: string; thread_ts: string | null; event_time: number }
export interface SlackActionPayload { installation_id: string; action_id: SlackActionId; value: string; channel_id: string; message_ts: string }
/** sched = the scheduling job's id (ctx.job.id) as a string; i = the delay's index (C11: dedupe slack-card:<ts>:<sched>:<i>). */
export interface SlackCardPayload { installation_id: string; kind: "draft"; id: string; channel_id: string; message_ts: string; sched: string; i: number }
export interface SlackHomePayload { installation_id: string; slack_user_id: string }
export interface SlackUninstallPayload { installation_id: string; mode: "purge" | "check"; event_time?: number }

export interface InstallationRow {
  id: string; principalId: string; teamId: string; appId: string; botUserId: string; botId: string;
  keyId: string | null; botScopes: string[]; userId: string; dmChannelId: string;
  installedAt: string; updatedAt: string; revokedAt: string | null; revokeReason: RevokeReason | null;
  lastDmAt: string | null; lastErrorCode: string | null; lastErrorAt: string | null; purgedAt: string | null;
  hasToken: boolean;                       // bot_token_enc is not null (the blob itself never leaves slack-install.ts unopened)
}
/** The only object that carries a usable bot token (opened in memory, never logged, never serialized). */
export interface DmTarget { readonly token: string; readonly dmChannelId: string }
export interface OpenInstallation { row: InstallationRow; target: DmTarget }

/** Block Kit subset P6 emits. */
export type MrkdwnText = { type: "mrkdwn"; text: string; verbatim: true };
export type PlainText = { type: "plain_text"; text: string; emoji: false };
export type SlackButton = {
  type: "button"; action_id: SlackActionId | SlackLinkActionId; text: PlainText; value?: string; url?: string;
  style?: "primary" | "danger";
  confirm?: { title: PlainText; text: PlainText; confirm: PlainText; deny: PlainText };
};
export type SlackBlock =
  | { type: "section"; block_id?: string; text: MrkdwnText }
  | { type: "context"; block_id?: string; elements: MrkdwnText[] }
  | { type: "actions"; block_id: string; elements: SlackButton[] }
  | { type: "header"; text: PlainText }
  | { type: "divider" };
export interface SlackMessageParts { blocks: SlackBlock[]; text: string }   // text = the neutral fallback, always
export interface SlackHomeView { type: "home"; blocks: SlackBlock[] }

export type SlackConnectResult =
  | "connected" | "denied" | "state_invalid" | "state_expired" | "not_configured" | "not_installed" | "session_unbound"
  | "rate_limited" | "unavailable" | "slack_unavailable" | "exchange_failed" | "enterprise" | "wrong_team" | "wrong_app"
  | "missing_scopes" | "identity_not_found" | "wrong_user"
  | "wrong_host" | "extra_scopes"                                    // v2: C45, C44
  | "read_connected" | "read_not_connected" | "missing_user_scopes" | "extra_user_scopes" | "read_taken";   // P7a §3.10.4, §3.17

export interface SlackSettingsView {
  schema: boolean;                         // the P6 migration is applied
  configured: boolean;                     // slackConfig() !== null && cryptoConfigured()
  state: "not_connected" | "connected" | "error" | "revoked";
  installationId: string | null; teamId: string | null; dmChannelId: string | null; userId: string | null;
  installedAt: string | null; scopes: string[]; lastDmAt: string | null;
  lastErrorCode: string | null; lastErrorAt: string | null;
  revokedAt: string | null; revokeReason: RevokeReason | null;
  /** (additive) The read failed: the section says so and offers nothing, rather than showing "not connected" (Connect). */
  readFailed?: true;
  /** P7a (§3.16; Area E fills it in getSlackSettingsView): the reading half. Optional so P6 literals compile; absent = not filled. */
  reading?: SlackReadingView;
}
export interface SlackSystemSummary {
  state: "connected" | "error" | "revoked" | "not_connected"; lastDmAt: string | null; lastErrorCode: string | null; revokedAt: string | null;
  /** P7a (§3.20.3, M12; Area A fills it in slackSystemSummary): the System card's reading row. null = nothing to show or not
   *  readable; optional so P6 literals compile (absent = null). */
  reading?: SlackReadingSummary | null;
}
/** P7a §3.20.3: the reading half on the System card. v2Missing = v2MissingWithSchemaAt() within the last hour (C48). */
export interface SlackReadingSummary {
  state: SlackReadingViewState; lastEventAt: string | null; lastSweepAt: string | null; blockedMethods: number; pendingTriage: number;
  userErrorCode: string | null; v2Missing: boolean;
  /** Integrator (§3.20.4 "Stopped {date}"): when the reading half was stopped; set on the revoked state only. Additive, optional. */
  revokedAt?: string | null;
}

/** P7a §3.16 (C29): one picker row (public and private channels; never a deny row). */
export interface PickerRow { channelId: string; name: string; kind: "public" | "private"; class: "standard" | "external" | "finance" | "hub" | "unclassified";
  financeName: boolean;   // C10: badgeFinance and the finance confirmation for class finance OR a Slack Connect finance-named channel
  watchState: WatchState; muteSource: MuteSource | null; isMember: boolean; activity30d: number | null; lastActivityAt: string | null;
  version: string; canChange: boolean }   // canChange false for hub/unclassified and for a left private conversation
/** P7a §3.16: the Settings reading view (getSlackReadingView, slack-reading-settings.ts; fail soft). */
export interface SlackReadingView {
  state: SlackReadingViewState; switchOn: boolean; settingsVersion: string | null; watchMode: WatchMode;
  installationId: string | null; scopes: string[]; dmsGranted: boolean; groupDmsGranted: boolean;
  consentedAt: string | null; discoveredAt: string | null; revokedAt: string | null; revokeReason: UserRevokeReason | null; lastErrorCode: string | null;
  counts: { watched: number; muted: number; unwatched: number; never: number; neverByReason: Partial<Record<DenyReason, number>>;
            hubs: number; dms: { watched: number; total: number }; groupDms: { watched: number; total: number } };
  channels: PickerRow[];   // ≤ 1,000: watched, then muted, then unwatched; by name
  lastEventAt: string | null; lastSweepAt: string | null; pendingTriage: number; openItems: number;
  capUsd: number; effectiveCapUsd: number; spentTodayUsd: number | null; retentionDaysSlack: number;
  /** (additive, P7a fixer ui-3) DD couldn't read the view (a store error, a timeout, the page's deadline): state is "error" but
   *  nothing was rejected by Slack; the section says so (readFailed) and offers at most Stop reading, never Allow. */
  readFailed?: true;
}
export type SlackErrorClassOf = (code: string) => ErrorClass;
export const slackClientTurnId = (ts: string): string => `slk_${ts.replace(".", "_")}`;
export const slackConversationKey = (channel: string, rootTs: string): string => `slkc_${channel}_${rootTs.replace(".", "_")}`;
