import type { MatchConfidence } from "@/lib/exec/email-types";
// P7a's pure types module (P7aC §3.1; §0.6.1 R9). P7b declares none of these locally.
import type { ChannelRow, SlackItemKind, SlackItemRow } from "@/lib/exec/slack-read-types";
import { compareTs, msToTs, tsToMs } from "@/lib/exec/slack-read-types";
import { localDateString } from "@/lib/exec/time";

// P7b Slack intelligence: shared types, limits and the read policy (P7b contract §3.1; stage 0, lead seed, frozen).
// Pure and client-safe: no server-only, no Supabase; imports only P7a's pure slack-read-types, P3's email-types (a
// type) and P2a's pure time.ts (bindings AM-P7b-3). Areas change nothing here; a signature changes only through the
// lead. Every function here has its real body (the lead's own, like P7a's five in slack-read-types.ts).
//
//   * slackUsePolicy: the one channel-level read gate (§0.3 rule 7). Fails closed: only a `watched` channel is ever
//     allowed, and only while the intel state is "ok".
//   * slackItemPolicy: whether one stored P7a item may be shown. It mirrors P7a's FINAL C20 screen exactly
//     (attention-read.ts slackScreenAllows, the rule listOpenSlackItems applies; bindings AM-P7b-2): a channel that
//     isn't watched shows an item only under an owner or Slack mute, only when the item bypasses mutes, and never on a
//     finance channel (class or finance name); finance items and finance channels are withheld on surface "slack".
//     Plus the left-channel row P7b adds. The item paths read through the facade's screened getSlackItemsByIds first
//     (P7a's own slackScreenRows + slackScreenAllows), so this is a second, never looser, gate.
//   * slackPrivacyOf: P7-3 + N10 + N1's finance class (incl. finance_name).

export type { ChannelRow, SlackItemKind, SlackItemRow };
/** P7a's comparator (numeric; throws TypeError on a malformed ts) and ms→ts formatter, re-exported so P7b and P8
 *  (P8C B5) bind to one implementation. */
export { compareTs, msToTs };

export type SlackIntelState = "not_installed" | "not_connected" | "reading_revoked" | "reading_off" | "discovering" | "ok";
export type SlackPrivacy = "public" | "private" | "group_dm" | "dm" | "external" | "finance";
/** Where a channel-level Slack read is going (§0.3 rule 7). */
export type SlackUse = "page" | "chat_web" | "chat_slack" | "digest" | "draft" | "brief" | "live_read";
/** Where a stored P7a item is being shown (catch-up, search hits, open items, project rows, get_source). */
export type SlackItemUse = "page" | "chat_web" | "chat_slack";
export type SlackDenyReason = "state" | "never_watch" | "hub" | "unclassified" | "inaccessible" | "unwatched" | "muted"
  | "finance" | "dm" | "not_public" | "archived" | "not_bypass";
export type ChannelLinkVia = "tag" | "name";
export type MessageLinkVia = "dd_post" | "dd_link" | "domain";
export type DigestStatus = "building" | "built" | "empty" | "stale" | "failed" | "skipped_cap";
export type SlotStatus = "used" | "none" | "unavailable" | "not_connected" | "off";

export const SLACK_INTEL_JOB_KINDS = Object.freeze({
  correlate: "exec.slack-correlate", digest: "exec.slack-digest", digestPlan: "exec.slack-digest-plan", sweep: "exec.slack-intel-sweep"
} as const);

export const SLACK_INTEL_LIMITS = Object.freeze({
  // correlation
  nameRuleMinSlugChars: 4, unlinkedBatch: 1_000, linkUpsertChunk: 500, rulesBatch: 2_000, maxPathsPerMessage: 20,
  // digests
  digestSummaryChars: 1_200, digestLineChars: 200, digestLines: 6, digestMaxMessages: 600, digestMessageChars: 1_000,
  digestInputTokenCeiling: 60_000, digestHistoryPages: 5, digestThreadReads: 10, digestVerbatimMaxRun: 160,
  digestVerbatimKeep: 140, digestPlanMaxChannels: 60, digestRebuildDays: 7, digestTodayMinGapMs: 3_600_000,
  digestTimeoutMs: 120_000, digestRetryJobs: 30, digestRebuildJobsMax: 200,
  // search
  searchQueryChars: 200, searchLiveChannels: 3, searchLivePages: 2, searchLivePageSize: 200, searchLiveThreads: 5,
  searchLiveDaysMax: 30, searchLiveBudgetMs: 30_000, searchLiveHistoryCalls: 8, searchLiveReplyCalls: 8,
  searchPermalinksPerCall: 10, searchTextChars: 280,
  // chat and the sweep
  consultedRefs: 600, consultedChannels: 200, redactChunk: 500, purgeLogBatch: 500, sweepTimeBoxMs: 60_000, forgetChunk: 500,
  // client update
  ownerInstructionChars: 2_000, completedWindowDays: 14, completedFacts: 8, teamWorkWindowDays: 14, teamWorkEntries: 6,
  teamWorkEntryChars: 300, publicSlackWindowDays: 30, publicSlackFacts: 8, projectsShown: 3, clientUpdateTimeoutMs: 60_000,
  clientUpdatesPerTurn: 1,
  // page and brief
  catchUpRows: 50, catchUpWindowDays: 14, catchUpReadRows: 200, projectLinkedRows: 10, projectClientItems: 10,
  projectClientDigests: 5, projectMentions: 5, projectWindowDays: 30, briefDigests: 6, overviewReadTimeoutMs: 8_000
});

export interface SlackChannelLink {
  channelId: string;
  tagClientId: string | null; tagClientName: string | null; tagProjectIds: string[]; taggedAt: string | null;
  /** P3's five verdict columns (generated). */
  clientId: string | null; clientName: string | null; clientMatchVia: ChannelLinkVia | null;
  matchConfidence: Extract<MatchConfidence, "high" | "low"> | null; clientCandidates: number;
}
export interface SlackMessageLink {
  channelId: string; ts: string;
  clientId: string | null; clientName: string | null; clientMatchVia: MessageLinkVia | null;
  matchConfidence: MatchConfidence | null; clientCandidates: number;
  taskIds: string[]; projectIds: string[]; emailThreadIds: string[]; checkedAt: string;
}
export interface DigestLine { msg: string /* the message ts */; text: string }
export interface SlackDigestRow {
  id: string; channelId: string; localDate: string; tz: string; fromTs: string; toTs: string; status: DigestStatus;
  summary: string | null; highlights: DigestLine[]; decisions: DigestLine[]; openQuestions: DigestLine[];
  sourceTs: string[]; counts: { human: number; bot: number; ddPost: number; external: number; threads: number };
  privacy: SlackPrivacy | null; partial: boolean; fullDay: boolean; injectionSuspected: boolean; rebuilds: number;
  model: string | null; costUsd: number | null; requestedAt: string; builtAt: string | null; expiresAt: string;
}
export interface SlackCatchUpCounts { unanswered: number; decisionsPending: number; notAssessed: number }

/** Job payloads (references only, §0.3 rule 5). */
export interface SlackDigestPayload { channel_id: string; local_date: string; mode: "plan" | "today" | "rebuild" }
export interface SlackIntelSweepPayload { reason: "schedule" | "finish_recheck" }

/** msToTs(d.getTime()) (P7a's format): the oldest/latest bounds of a local day and "now". Throws TypeError on an invalid
 *  or negative Date (P7a's msToTs). */
export function tsOfDate(d: Date): string {
  if (!(d instanceof Date)) throw new TypeError("tsOfDate: not a Date");
  return msToTs(d.getTime());
}

/** The local date of a ts in tz ("YYYY-MM-DD"), through P7a's tsToMs (throws TypeError on a malformed ts). */
export function localDateOfTs(ts: string, tz: string): string {
  return localDateString(new Date(tsToMs(ts)), tz);
}

const isFinanceChannel = (ch: Pick<ChannelRow, "class" | "financeName">): boolean => ch.class === "finance" || ch.financeName === true;

/** P7-3 + N10 + N1's finance class (incl. finance_name, p7a-sec-4). Fails closed: an unknown conv_type is "private". */
export function slackPrivacyOf(ch: Pick<ChannelRow, "convType" | "isPrivate" | "class" | "isExtShared" | "extEver" | "financeName">): SlackPrivacy {
  if (isFinanceChannel(ch)) return "finance";
  if (ch.class === "external" || ch.isExtShared === true || ch.extEver === true) return "external";
  if (ch.convType === "channel" && ch.isPrivate === false) return "public";
  if (ch.convType === "channel" || ch.convType === "group") return "private";
  if (ch.convType === "mpim") return "group_dm";
  if (ch.convType === "im") return "dm";
  return "private";
}

type Deny = { allowed: false; reason: SlackDenyReason };
type Allow = { allowed: true; privacy: SlackPrivacy };
const deny = (reason: SlackDenyReason): Deny => ({ allowed: false, reason });

/** Rows 1–5 of slackUsePolicy (shared with slackItemPolicy and storedSearchChannels): state, deny, hub, unclassified, left.
 *  null when they pass. */
function baseDeny(state: SlackIntelState, ch: ChannelRow | null): Deny | null {
  if (state !== "ok") return deny("state");
  if (ch === null || ch === undefined) return deny("unclassified");
  if (ch.class === "deny") return deny("never_watch");
  if (ch.class === "hub") return deny("hub");
  if (ch.class === "unclassified") return deny("unclassified");
  // Any class outside P7a's six (a value this build doesn't know) fails closed like an unclassified row.
  if (ch.class !== "standard" && ch.class !== "external" && ch.class !== "finance") return deny("unclassified");
  if (ch.leftAt !== null && ch.leftAt !== undefined) return deny("inaccessible");
  return null;
}

/** §0.3 rule 7: the one channel-level read gate. `state` is the principal's SlackIntelState. First matching row wins
 *  (§3.1's table; the state row is checked before the null channel, both deny). */
export function slackUsePolicy(state: SlackIntelState, ch: ChannelRow | null, use: SlackUse):
  { allowed: true; privacy: SlackPrivacy } | { allowed: false; reason: SlackDenyReason } {
  const base = baseDeny(state, ch);
  if (base !== null) return base;
  const c = ch as ChannelRow;
  if (c.watchState === "unwatched") return deny("unwatched");
  if (c.watchState === "muted") return deny("muted");
  if (c.watchState !== "watched") return deny("unwatched");
  if (isFinanceChannel(c) && (use === "chat_slack" || use === "draft" || use === "brief")) return deny("finance");
  if (c.convType === "im" && (use === "digest" || use === "draft")) return deny("dm");
  const privacy = slackPrivacyOf(c);
  if (use === "draft" && privacy !== "public") return deny("not_public");
  if (use === "live_read" && c.isArchived === true) return deny("archived");
  // An unknown use (a value this build doesn't know) fails closed.
  if (!USES.has(use)) return deny("state");
  return { allowed: true, privacy } satisfies Allow;
}
const USES: ReadonlySet<string> = new Set<SlackUse>(["page", "chat_web", "chat_slack", "digest", "draft", "brief", "live_read"]);
const ITEM_USES: ReadonlySet<string> = new Set<SlackItemUse>(["page", "chat_web", "chat_slack"]);

/** P7a's C20 bypass (slackScreenAllows): a channel that isn't watched shows an item only when it is muted by him or by
 *  Slack (never "Don't watch", never a finance default mute, never an unknown or null mute source) and isn't a finance
 *  channel by class or name. */
function bypassChannel(ch: ChannelRow): boolean {
  return ch.watchState === "muted" && (ch.muteSource === "owner" || ch.muteSource === "slack") && !isFinanceChannel(ch);
}

/** C7 + P7a's final C20 (attention-read.ts slackScreenAllows; bindings AM-P7b-2): whether one stored P7a item may be
 *  shown. Rows 1–5 of slackUsePolicy; then a channel that isn't watched → allowed only through bypassChannel and the
 *  item's bypassMute, else deny "not_bypass"; then a finance item or channel on "chat_slack" → deny "finance";
 *  otherwise allow, privacy "finance" for a finance item, else slackPrivacyOf(ch). */
export function slackItemPolicy(state: SlackIntelState, ch: ChannelRow | null, item: Pick<SlackItemRow, "bypassMute" | "sourceClass">,
  use: SlackItemUse): { allowed: true; privacy: SlackPrivacy } | { allowed: false; reason: SlackDenyReason } {
  const base = baseDeny(state, ch);
  if (base !== null) return base;
  const c = ch as ChannelRow;
  if (!ITEM_USES.has(use)) return deny("state");
  if (item === null || item === undefined) return deny("not_bypass");
  if (c.watchState !== "watched" && !(bypassChannel(c) && item.bypassMute === true)) return deny("not_bypass");
  // An item whose source class this build doesn't know counts as finance (fails closed on Slack).
  const financeItem = item.sourceClass !== "public" && item.sourceClass !== "private";
  if (use === "chat_slack" && (financeItem || isFinanceChannel(c))) return deny("finance");
  return { allowed: true, privacy: financeItem ? "finance" : slackPrivacyOf(c) };
}

/** The channel sets a stored search may pass to RPC 5: `full` = slackUsePolicy allowed for this use (watched only);
 *  `bypass` = channels that pass rows 1–5 and are muted by him or Slack and aren't finance (bypassChannel), whose
 *  bypass_mute items slackItemPolicy may show (page/chat only; never for draft/brief/digest). Unwatched channels, finance
 *  default mutes and finance channels that aren't watched are in neither (bindings AM-P7b-2). Deduped, in input order. */
export function storedSearchChannels(state: SlackIntelState, channels: Iterable<ChannelRow>, use: SlackItemUse):
  { full: string[]; bypass: string[] } {
  const full: string[] = [];
  const bypass: string[] = [];
  if (state !== "ok" || !ITEM_USES.has(use)) return { full, bypass };
  const seen = new Set<string>();
  for (const ch of channels) {
    if (!ch || typeof ch.channelId !== "string" || seen.has(ch.channelId)) continue;
    seen.add(ch.channelId);
    if (slackUsePolicy(state, ch, use).allowed) full.push(ch.channelId);
    else if (baseDeny(state, ch) === null && bypassChannel(ch)) bypass.push(ch.channelId);
  }
  return { full, bypass };
}

/** Chat consulted keys (§2.1.5). */
export const slackMessageKey = (channelId: string, ts: string): string => `m:${channelId}:${ts}`;
export const slackDigestKey = (channelId: string, localDate: string, rebuilds: number): string => `d:${channelId}:${localDate}:${rebuilds}`;
export const SLACK_ITEM_KINDS: readonly SlackItemKind[] = Object.freeze(["request", "question", "decision", "commitment", "action_item", "fyi"] as SlackItemKind[]);
