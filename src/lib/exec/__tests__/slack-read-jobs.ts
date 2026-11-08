import { DEFAULT_SETTINGS } from "@/lib/exec/principal";
import type {
  CandidateRow,
  ChannelRow,
  ReadingHalf,
  ReadingInstallation,
  SlackItemRow,
  SlackUserScope
} from "@/lib/exec/slack-read-types";
import type { InstallationRow } from "@/lib/exec/slack-types";
import type { SlackReadMessage } from "@/lib/exec/sources/slack";
import type { ExecJobRow, ExecPrincipal, ExecSettings, JobContext } from "@/lib/exec/types";

import { SLACK_TEXT_SENTINELS as S } from "./slack-read-assert";

// P7a Area D test support (contract §5.5-§5.14): plain builders for the job tests. The handlers run their REAL
// slack-read.ts glue, sources/slack.ts (over fake-slack-api.ts's fetch stub) and the pure modules; the test files mock
// slack-read-store, slack-install, slack-rate, dd-bot, sources/dd, jobs, sync-state, ops, audit and the model at the module
// boundary. Ids are AM-P7a-21's: team T0SCALED, him U0MITCH, the assistant DM D0MITCH, its bot U0BOT, the DD bot U0DDBOT /
// A0DDAPP, the partner team T0PARTNER, the opted-out author U0OPTOUT; now = 2026-11-08T15:00:00Z (ts 1794150000).

export const NOW = new Date("2026-11-08T15:00:00.000Z");
export const NOW_MS = NOW.getTime();
export const NOW_TS = "1794150000.000000";
export const hex32 = (n: number): string => n.toString(16).padStart(32, "0");
export const INST = `esi_${hex32(1)}`;
export const PID = "ep_1";
export const HIM = "U0MITCH";
export const TEAM = "T0SCALED";
export const NINE: SlackUserScope[] = ["channels:history", "groups:history", "channels:read", "groups:read", "users:read", "im:history", "im:read", "mpim:history", "mpim:read"];
export const DD_BOT = { userId: "U0DDBOT", appId: "A0DDAPP" };

/** Mitchell (his email is P6's sentinel-free value; nothing here may leave in a log). */
export const PRINCIPAL = Object.freeze({
  id: PID, userId: "u_1", email: "mitchell@scaledai.org", name: "Mitchell", timezone: "America/New_York",
  mailAccountIds: [], slackTeamId: null, slackUserId: null
}) as unknown as ExecPrincipal;

export function settings(over: Partial<ExecSettings> = {}): ExecSettings {
  return { ...DEFAULT_SETTINGS, principalId: PID, slackReadingSchemaReady: true, slackReadingEnabled: true, dailyCostCapUsd: 15, slackDailyCapUsd: 2, ...over };
}

export function installationRow(over: Partial<InstallationRow> = {}): InstallationRow {
  return {
    id: INST, principalId: PID, teamId: TEAM, appId: "A0EXEC", botUserId: "U0BOT", botId: "B0BOT", keyId: "0a1b2c3d", botScopes: ["chat:write"],
    userId: HIM, dmChannelId: "D0MITCH", installedAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", revokedAt: null,
    revokeReason: null, lastDmAt: null, lastErrorCode: null, lastErrorAt: null, purgedAt: null, hasToken: true, ...over
  };
}

export function readingHalf(over: Partial<ReadingHalf> = {}): ReadingHalf {
  return {
    state: "ready", scopes: [...NINE], installedAt: "2026-11-01T00:00:00.000Z", revokedAt: null, revokeReason: null,
    discoveredAt: "2026-11-01T01:00:00.000Z", purgedAt: null, lastErrorCode: null, lastErrorAt: null, hasToken: true, ...over
  };
}

/** The opened reading half, with the user-token sentinel (it must never leave sources/slack.ts's Authorization header). */
export function readingInstallation(over: { row?: Partial<InstallationRow>; reading?: Partial<ReadingHalf> } = {}): ReadingInstallation {
  const row = installationRow(over.row);
  return { row, reading: readingHalf(over.reading), target: Object.freeze({ userToken: S.userToken, teamId: row.teamId, userId: row.userId }) };
}

export function channelRow(over: Partial<ChannelRow> = {}): ChannelRow {
  return {
    channelId: "C0GENERAL", installationId: INST, convType: "channel", class: "standard", denyReason: null, hubKind: null, financeName: false,
    watchState: "watched", muteSource: null, watchSetByOwnerAt: null, name: S.channelName, imUserId: null, isMember: true, isPrivate: false,
    isExtShared: false, extEver: false, isArchived: false, histWatermarkTs: "1794146400.000100", deepSweptAt: "2026-11-08T14:00:00.000Z",
    sweptAt: "2026-11-08T14:30:00.000Z", lastEventTs: null, lastActivityTs: null, activity30d: null, probedAt: null,
    classifiedAt: "2026-11-01T01:00:00.000Z", leftAt: null, updatedAt: "2026-11-01T01:00:00.000Z", ...over
  };
}

export function candidate(over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    ts: "1794149000.000100", threadTs: null, authorUserId: "U0JANE", authorExternal: false, reasons: 2, triageState: "pending",
    contentHash: null, editedTs: null, respondedTs: null, ...over
  };
}

let itemSeq = 0;
export function itemRow(over: Partial<SlackItemRow> = {}): SlackItemRow {
  return {
    id: `esl_${hex32(++itemSeq)}`, channelId: "C0GENERAL", ts: "1794140000.000100", kind: "request", threadTs: null, authorUserId: "U0JANE",
    authorLabel: S.authorName, authorExternal: false, assessed: true, addressedToYou: true, needsResponse: true, bypassMute: false,
    urgency: "normal", summary: S.summary, excerpt: S.excerpt, dueText: null, dueAt: null, commitmentDirection: null, sourceClass: "public",
    permalink: null, respondedTs: null, respondedAt: null, acknowledgedAt: null, expiresAt: "2027-02-01T00:00:00.000Z",
    createdAt: "2026-11-08T12:00:00.000Z", ...over
  };
}

/** A SlackReadMessage (sources/slack.ts's parsed shape). */
export function readMessage(ts: string, over: Partial<SlackReadMessage> = {}): SlackReadMessage {
  return {
    ts, threadTs: null, user: "U0JANE", userTeam: TEAM, botId: null, botProfile: false, appId: null, subtype: null, hidden: false,
    text: `${S.text} hello there, can you take a look?`, blocks: null, attachments: null, replyCount: 0, latestReply: null, parentUserId: null,
    editedTs: null, reactedUserIds: [], fileCount: 0, ...over
  };
}

let jobSeq = 0;
export function jobCtx(kind: string, payload: Record<string, unknown>, over: { principal?: ExecPrincipal | null; signal?: AbortSignal; dedupeKey?: string | null;
  lane?: "interactive" | "bulk" } = {}): JobContext {
  const id = ++jobSeq;
  const job: ExecJobRow = {
    id, kind, lane: over.lane ?? "bulk", principal_id: over.principal === null ? null : PID, payload, dedupe_key: over.dedupeKey ?? null, status: "running",
    attempts: 1, max_attempts: 1, run_after: NOW.toISOString(), locked_by: "worker-under-test", locked_until: null, heartbeat_at: null, last_error: null,
    result: null, created_at: NOW.toISOString(), started_at: NOW.toISOString(), finished_at: null
  };
  return { job, principal: over.principal === undefined ? PRINCIPAL : over.principal, signal: over.signal ?? new AbortController().signal, workerId: "worker-under-test" };
}

/** A conversations.history / replies page in Slack's own shape (fake-slack-api answers it). */
export function historyPage(messages: readonly Record<string, unknown>[], opts: { hasMore?: boolean; nextCursor?: string } = {}): Record<string, unknown> {
  return {
    ok: true, messages: messages.map((m) => structuredClone(m)), has_more: opts.hasMore === true, pin_count: 0,
    response_metadata: { next_cursor: opts.nextCursor ?? "" }
  };
}

/** A raw Slack message (the CH / CR shape). */
export function rawMessage(ts: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "message", user: "U0JANE", text: `${S.text} hello there, can you take a look?`, ts, team: TEAM, ...extra };
}

// ---------------------------------------------------------------------------
// Snake_case rows for fake-slack-read-db (the tests that run the real store)
// ---------------------------------------------------------------------------

export const TOKEN_KEY = Buffer.alloc(32, 0xa1).toString("base64");
type DbRow = Record<string, unknown>;

/** His installation with a live reading half (bot and user tokens sealed for the principal; EXEC_TOKEN_KEY = TOKEN_KEY). */
export function installationDbRow(seal: (plain: string, context: string) => string, over: DbRow = {}): DbRow {
  const pid = (over.principal_id as string | undefined) ?? PID;
  const bot = seal("xoxb-area-d-test-bot", `exec_slack_installations.bot_token:${pid}`);
  const user = seal(S.userToken, `exec_slack_installations.user_token:${pid}`);
  return {
    id: INST, principal_id: pid, team_id: TEAM, app_id: "A0EXEC", bot_user_id: "U0BOT", bot_id: "B0BOT", bot_token_enc: bot, key_id: bot.split(".")[1],
    bot_scopes: ["chat:write"], user_id: HIM, user_token_enc: user, user_scopes: [...NINE], slack_dm_channel_id: "D0MITCH",
    installed_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z", revoked_at: null, revoke_reason: null, last_dm_at: null,
    last_error_code: null, last_error_at: null, purged_at: null, user_key_id: user.split(".")[1], user_installed_at: "2026-11-01T00:00:00.000Z",
    user_revoked_at: null, user_revoke_reason: null, user_last_error_code: null, user_last_error_at: null, reading_state: "ready",
    discovered_at: "2026-11-01T01:00:00.000Z", reading_purged_at: null, ...over
  };
}

export function channelDbRow(over: DbRow = {}): DbRow {
  return {
    principal_id: PID, installation_id: INST, channel_id: "C0GENERAL", conv_type: "channel", class: "standard", deny_reason: null, hub_kind: null,
    finance_name: false, watch_state: "watched", mute_source: null, watch_set_by_owner_at: null, name: "general", im_user_id: null, is_member: true,
    is_private: false, is_ext_shared: false, ext_ever: false, is_archived: false, hist_watermark_ts: null, deep_swept_at: null, swept_at: null,
    last_event_ts: null, last_activity_ts: null, activity_30d: null, probed_at: null, classified_at: "2026-11-01T01:00:00.000Z",
    seen_at: "2026-11-01T01:00:00.000Z", left_at: null, created_at: "2026-11-01T01:00:00.000Z", updated_at: "2026-11-01T01:00:00.000Z", ...over
  };
}

export function messageDbRow(over: DbRow = {}): DbRow {
  return {
    principal_id: PID, channel_id: "C0GENERAL", ts: "1794140000.000100", thread_ts: null, role: "candidate", author_user_id: "U0JANE", author_external: false,
    is_dd_post: false, dd_paths: [], reasons: 2, triage_state: "pending", content_hash: null, edited_ts: null, responded_ts: null, responded_at: null,
    acknowledged_at: null, assessed_at: null, expires_at: "2027-02-01T00:00:00.000Z", created_at: "2026-11-07T00:00:00.000Z",
    updated_at: "2026-11-07T00:00:00.000Z", ...over
  };
}

let dbItemSeq = 0;
export function itemDbRow(over: DbRow = {}): DbRow {
  return {
    id: `esl_${hex32(1000 + ++dbItemSeq)}`, principal_id: PID, channel_id: "C0GENERAL", ts: "1794140000.000100", kind: "request", thread_ts: null,
    author_user_id: "U0JANE", author_label: S.authorName, author_external: false, assessed: true, addressed_to_you: true, needs_response: true,
    bypass_mute: false, urgency: "normal", summary: S.summary, excerpt: S.excerpt, due_text: null, due_at: null, commitment_direction: null,
    source_class: "public", permalink: null, responded_ts: null, responded_at: null, acknowledged_at: null, expires_at: "2027-02-01T00:00:00.000Z",
    created_at: "2026-11-08T12:00:00.000Z", updated_at: "2026-11-08T12:00:00.000Z", ...over
  };
}
