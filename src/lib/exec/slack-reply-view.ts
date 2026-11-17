import "server-only";

import { replyButtonValue } from "@/lib/exec/crypto";
import { findPlaceholders } from "@/lib/exec/drafts-doc";
import { formatInZone } from "@/lib/exec/format";
import { loadSettings } from "@/lib/exec/principal";
import { appOrigin } from "@/lib/exec/refs";
import { dmPost, dmUpdate, errLabel, isSlackAuthError, ownSignal } from "@/lib/exec/slack-dm";
import { openInstallationById } from "@/lib/exec/slack-install";
import { slackChannelLabel } from "@/lib/exec/slack-page";
import { fillP10, SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import { P10_LIMITS, REPLY_ACTIVE_STATUSES } from "@/lib/exec/slack-p10-types";
import type {
  ReplyBlocker,
  ReplyCardState,
  ReplyDraftRow,
  ReplyFlag,
  ReplyGenerationError,
  ReplyStatus,
  ReplyTargetFacts,
  ReplyVoiceSource
} from "@/lib/exec/slack-p10-types";
import { getChannel, listItemsForMessage } from "@/lib/exec/slack-read-store";
import type { ChannelRow, SlackItemRow } from "@/lib/exec/slack-read-types";
import { getSlackItemsByIds } from "@/lib/exec/slack-reading";
import { slackReplyPageHref } from "@/lib/exec/slack-reply-links";
import {
  getReplyCard,
  getReplyDraft,
  listReplyCards,
  listReplyCardStates,
  listReplyDraftsForMessages,
  markReplyCard,
  recordReplyCard,
  replySchemaReady,
  replyTargetFacts
} from "@/lib/exec/slack-reply-store";
import { fitsOneSection, renderReplyCard, type ReplyCardView } from "@/lib/exec/slack-reply-ui";
import type { OpenInstallation, SlackMessageParts } from "@/lib/exec/slack-types";
import { getSyncState, parseReplyTokenHealth } from "@/lib/exec/sync-state";
import type { ExecPrincipal, ExecSettings } from "@/lib/exec/types";

// P10 the reply views and the card plumbing (contract §3.5.11, §3.5.13; Area D; server-only): the DM card's view and posts,
// the page view, the new-reply view, the catch-up / Needs Attention badges. Never calls Slack on a render: every page view is
// DB reads only (the review route's one live read is reviewSlackReply's, C59).
//
//   * The destination is never input: it is the stored row's channel and thread (RPC 13 computed them, C28); the words for it
//     come from the stored channel row (slackChannelLabel's cut of its name) and the source item's author label (v1.1
//     product-5).
//   * A finance-class draft is never a card (H9): postReplyCard refuses it, and an existing card renders the finance note
//     (`off`) once its channel turns finance (C42, RK03).
//   * A card is `live` (Send in Slack) only when every C32 condition holds: internal, no placeholder, no flag, no injection
//     mark, no already-replied or edited-source blocker, send on, his DD token's last health `ok` (P10's own
//     slack-reply / token-health, C60) and a body that fits one section. Otherwise `dd_only`, with every reason in words.
//   * Logs carry ids and error codes only: never the draft's text, its note, a name or a label.

const COPY = SLACK_P10_COPY.replies;
const DAY_MS = 86_400_000;
const DRAFT_ID = /^esr_[0-9a-f]{32}$/;
const CHANNEL_ID = /^[CGD][A-Z0-9]{2,30}$/;
const TS = /^[0-9]{1,12}\.[0-9]{1,8}$/;
const MESSAGE_ID = /^ecm_[0-9a-f]{32}$/;
const GENERATION_ERRORS: ReadonlySet<string> = new Set<ReplyGenerationError>([
  "refused", "truncated", "invalid_output", "empty", "too_long", "copied_external", "timeout", "model_error", "budget",
  "context_unavailable", "reading_off", "channel", "context_deleted", "author_optout"
]);
/** The card states a draft's status maps to one to one (a `draft` is live or dd_only; any finance draft is `off`). */
const CARD_STATE_OF: Readonly<Record<Exclude<ReplyStatus, "draft">, ReplyCardState>> = Object.freeze({
  generating: "generating", generation_failed: "failed_generation", sending: "sending", sent: "sent", unknown: "unknown",
  failed: "failed", discarded: "discarded", expired: "expired", removed: "removed"
});
/** The external author's label everywhere P7a shows one (P7a's C29 label). */
const EXTERNAL_MEMBER = "External member";
const LABEL_MAX = 80;

const errName = (err: unknown): string => errLabel(err);
const logId = (id: unknown): string => (typeof id === "string" && DRAFT_ID.test(id) ? id : "(malformed)");

// ---------------------------------------------------------------------------
// The draft's place and source (product-5)
// ---------------------------------------------------------------------------

/** P7a's C19 precedence (restated): decision > request / question / action_item > commitment > unassessed > fyi. */
function precedence(i: Pick<SlackItemRow, "kind" | "assessed">): number {
  if (!i.assessed) return 3;
  if (i.kind === "decision") return 0;
  if (i.kind === "request" || i.kind === "question" || i.kind === "action_item") return 1;
  if (i.kind === "commitment") return 2;
  return 4;
}

/** The person a DM or group DM reply goes to, as P7a labels the source item's author ("External member" for an outsider). */
function personOf(item: SlackItemRow | null): string | null {
  if (item === null) return null;
  if (item.authorExternal) return EXTERNAL_MEMBER;
  const label = typeof item.authorLabel === "string" ? item.authorLabel.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) : "";
  return label.length > 0 ? label : null;
}

/** The place phrase (replies.place) for a stored channel row and the source item's author. Pure. */
export function replyPlace(ch: Pick<ChannelRow, "convType" | "name" | "isPrivate"> | null, convType: ChannelRow["convType"], person: string | null): string {
  const place = COPY.place;
  if (convType === "im") return person !== null ? fillP10(place.dm, { person }) : place.dmUnknown;
  if (convType === "mpim") return person !== null ? fillP10(place.group, { person }) : place.groupUnknown;
  if (ch === null) return place.unknown;
  const label = slackChannelLabel({ convType, name: ch.name });
  if (!label.startsWith("#")) return place.unknown;
  const channel = label.slice(1);
  return fillP10(convType === "group" || ch.isPrivate ? place.private : place.channel, { channel });
}

/** "Reply in {place}{thread}" (C28: a channel reply always goes in a thread; a DM reply where its message is). */
export function replyDestination(place: string, inThread: boolean): string {
  return fillP10(COPY.destination, { place, thread: inThread ? COPY.thread : "" });
}

/** What the views say about a draft's source: its place, the item the draft answers (summary, author, permalink). */
export interface ReplySource {
  place: string; inThread: boolean; destination: string; summary: string | null; authorLabel: string | null; sourcePermalink: string | null;
}

/** Reads the stored channel row and the source message's items (DB only; each read failing on its own leaves its part out). */
export async function replySourceOf(principal: ExecPrincipal, row: Pick<ReplyDraftRow, "channelId" | "convType" | "sourceTs" | "itemId" | "replyThreadTs">):
  Promise<ReplySource> {
  const [ch, items] = await Promise.all([
    getChannel(principal, row.channelId).catch((err: unknown) => {
      console.warn(`[exec-slack-reply] channel row unavailable (${errName(err)})`);
      return null;
    }),
    listItemsForMessage(principal, row.channelId, row.sourceTs).catch((err: unknown) => {
      console.warn(`[exec-slack-reply] source items unavailable (${errName(err)})`);
      return [] as SlackItemRow[];
    })
  ]);
  const item = items.find((i) => i.id === row.itemId) ?? [...items].sort((a, b) => precedence(a) - precedence(b))[0] ?? null;
  const person = personOf(item);
  const place = replyPlace(ch, row.convType, person);
  const inThread = row.replyThreadTs !== null;
  return {
    place, inThread, destination: replyDestination(place, inThread),
    summary: item !== null && item.assessed && typeof item.summary === "string" && item.summary.trim() !== "" ? item.summary : null,
    authorLabel: person,
    sourcePermalink: item?.permalink ?? null
  };
}

// ---------------------------------------------------------------------------
// Blockers known without a live read (the card's C32 table, the page's staticBlockers)
// ---------------------------------------------------------------------------

/** The blockers a draft row and its target facts show without reading Slack, in REPLY order. */
export function staticReplyBlockers(row: ReplyDraftRow, facts: ReplyTargetFacts): ReplyBlocker[] {
  const out: ReplyBlocker[] = [];
  const text = typeof row.text === "string" ? row.text : "";
  if (findPlaceholders(text).length > 0) out.push("placeholders");
  if (row.external || facts.external) out.push("external");
  if (row.flags.length > 0) out.push("flags");
  if (row.injectionSuspected) out.push("injection");
  const since = Date.parse(row.generatedAt ?? row.createdAt);
  const responded = facts.respondedAt !== null ? Date.parse(facts.respondedAt) : Number.NaN;
  if (Number.isFinite(responded) && Number.isFinite(since) && responded > since) out.push("already_replied");
  if (facts.found && facts.message && (facts.editedTs ?? null) !== (row.sourceEditedTs ?? null)) out.push("source_edited");
  return out;
}

/** The three send switches (C53, §3.5.8 step 6). */
const sendOn = (s: ExecSettings): boolean => s.slackP10SchemaReady && s.slackRepliesEnabled && s.slackReplySendEnabled;

/** P10's own token health (slack-reply / token-health, C60): "ok" only when the last verdict stored says so. */
async function tokenHealthOk(principal: ExecPrincipal): Promise<boolean> {
  try {
    const got = await getSyncState(principal, "slack-reply", "token-health", parseReplyTokenHealth);
    return got !== null && got.value.state === "ok";
  } catch (err) {
    console.warn(`[exec-slack-reply] token health unavailable (${errName(err)})`);
    return false;
  }
}

/** The back-to-draft or failed-rewrite sentence of a `draft` row with a status_reason; else null. */
function draftReasonText(row: ReplyDraftRow): string | null {
  const code = row.statusReason;
  if (row.status !== "draft" || code === null) return null;
  if (GENERATION_ERRORS.has(code)) return fillP10(COPY.rewriteFailed, { reason: COPY.reasons[code as ReplyGenerationError] });
  const reasons = COPY.sendReasons as Readonly<Record<string, string>>;
  return fillP10(COPY.backToDraft, { reason: Object.prototype.hasOwnProperty.call(reasons, code) ? reasons[code] : reasons.other });
}

/** While DD is still checking an `unknown` row (verify_checks < 3): sending_at + replyVerifyHorizonMs, else null (product-3). */
function verifyingUntilOf(row: ReplyDraftRow): string | null {
  if (row.status !== "unknown" || row.verifyChecks >= P10_LIMITS.replyVerifyDelaysMs.length || row.sendingAt === null) return null;
  const at = Date.parse(row.sendingAt);
  return Number.isFinite(at) ? new Date(at + P10_LIMITS.replyVerifyHorizonMs).toISOString() : null;
}

// ---------------------------------------------------------------------------
// The DM card (§3.5.11)
// ---------------------------------------------------------------------------

/** The card's state and its reasons, from the stored row, the facts, the switches and his token health (C32). */
function cardStateOf(row: ReplyDraftRow, facts: ReplyTargetFacts, settings: ExecSettings, tokenOk: boolean):
  { state: ReplyCardState; ddReasons: ReplyCardView["ddReasons"] } {
  if (row.finance || facts.finance) return { state: "off", ddReasons: [] };
  if (row.status !== "draft") return { state: CARD_STATE_OF[row.status], ddReasons: [] };
  const reasons: ReplyCardView["ddReasons"] = [...staticReplyBlockers(row, facts)];
  // Reading paused or the target gone: DD can't run the send-time checks (C53), so the card can't send.
  if ((!facts.readingLive || !facts.channelOk || !facts.message || facts.deleted) && !reasons.includes("unchecked")) reasons.push("unchecked");
  if (!sendOn(settings)) reasons.push("send_off");
  if (!tokenOk) reasons.push("token");
  if (!fitsOneSection(row.text)) reasons.push("too_long");
  return { state: reasons.length === 0 ? "live" : "dd_only", ddReasons: reasons };
}

/** The button values from the STORED row (B-P10-14 (b): only this module makes them); null when the MAC key is unavailable. */
function buttonValueOf(row: ReplyDraftRow): string | null {
  try {
    return replyButtonValue({ draftId: row.id, version: row.version, channelId: row.channelId, replyThreadTs: row.replyThreadTs, text: row.text ?? "" });
  } catch (err) {
    console.warn(`[exec-slack-reply] ${logId(row.id)}: no button value (${errName(err)})`);
    return null;
  }
}

/** The card's view from the stored row, the target facts, the settings and his token health (C32; P10's own `slack-reply` /
 *  `token-health`, C60, v1.1 product-4); null when the row is gone. v1.1: notSentPrefix comes from opts.clickOutcome; the place
 *  phrase from the stored channel row (slackChannelLabel) and the item's author label (product-5); fitsOneSection (security-2). */
export async function replyCardParts(principal: ExecPrincipal, draftId: string, now: Date,
  opts?: { clickOutcome?: "dd_only" | "needs_ack"; blockers?: readonly ReplyBlocker[] }): Promise<{ parts: SlackMessageParts; state: ReplyCardState; version: number } | null> {
  const row = await getReplyDraft(principal, draftId);
  if (row === null) return null;
  const [settings, facts, tokenOk, source] = await Promise.all([
    loadSettings(principal.id), replyTargetFacts(principal, row.id), tokenHealthOk(principal), replySourceOf(principal, row)
  ]);
  const computed = cardStateOf(row, facts, settings, tokenOk);
  // v1.1 product-8: the last click on the card ended dd_only / needs_ack (blockers only the send's live read finds: newer
  // messages, his own reply, an outside author): the card says so and sends him to DD with those reasons in words.
  const clicked = opts?.clickOutcome !== undefined && computed.state === "live";
  const state: ReplyCardState = clicked ? "dd_only" : computed.state;
  const ddReasons: ReplyCardView["ddReasons"] = clicked || computed.state === "dd_only"
    ? [...new Set([...computed.ddReasons, ...(opts?.blockers ?? [])])] : computed.ddReasons;
  const value = state === "live" || state === "dd_only" || state === "failed_generation" ? buttonValueOf(row) : null;
  const checkingUntil = verifyingUntilOf(row);
  const reasonText = state === "unknown"
    ? checkingUntil !== null ? fillP10(COPY.unknown, { time: formatInZone(checkingUntil, principal.timezone, "time", now) }) : COPY.unknownChecked
    : state === "removed" ? COPY.removed
      : state === "live" || state === "dd_only" ? draftReasonText(row) : null;
  // P10 fixer security-3 (H9): a finance-class card (`off`) withdraws what it showed: no place, no AI summary of the message, no
  // author label, no permalink (the channel's new finance name included); only the finance line.
  const off = state === "off";
  const view: ReplyCardView = {
    draftId: row.id, state, version: row.version, destination: off ? COPY.place.unknown : source.destination, place: off ? COPY.place.unknown : source.place,
    inThread: off ? false : source.inThread, external: off ? false : row.external || facts.external, summary: off ? null : source.summary,
    authorLabel: off ? null : source.authorLabel, sourcePermalink: off ? null : source.sourcePermalink,
    text: state === "live" || state === "dd_only" ? row.text : null,
    note: state === "live" || state === "dd_only" ? row.note : null,
    placeholders: state === "live" || state === "dd_only" ? findPlaceholders(row.text ?? "") : [],
    flags: state === "live" || state === "dd_only" ? [...row.flags] : [],
    fitsOneSection: fitsOneSection(row.text), ddReasons, notSentPrefix: opts?.clickOutcome !== undefined,
    generationError: row.generationError, edited: row.edited, voiceSource: row.voiceSource, checkingUntil,
    ddHref: `${appOrigin()}${slackReplyPageHref(row.id)}`, permalink: row.postedPermalink,
    sendValue: state === "live" ? value : null, actValue: value, reasonText
  };
  return { parts: renderReplyCard(view), state, version: row.version };
}

/** The card of a draft that no longer exists (cascaded away, or never readable again): cardRemoved, no content, no buttons. */
export function removedReplyCardParts(draftId: string): SlackMessageParts {
  return renderReplyCard({
    draftId, state: "removed", version: 0, destination: COPY.place.unknown, place: COPY.place.unknown, inThread: false, external: false,
    summary: null, authorLabel: null, sourcePermalink: null, text: null, note: null, placeholders: [], flags: [], fitsOneSection: false,
    ddReasons: [], notSentPrefix: false, generationError: null, edited: false, voiceSource: null, checkingUntil: null,
    ddHref: `${appOrigin()}${slackReplyPageHref(draftId)}`, permalink: null, sendValue: null, actValue: null, reasonText: null
  });
}

/** Posts a card in his DM (thread = the chat thread, or top level), P6 ledger kind "note" with no ref (AM-P8-2) through dmPost,
 *  then recordReplyCard (expires_at = now + retention_days_chat). Never for a finance-class draft. Never throws (logged by id). */
export async function postReplyCard(principal: ExecPrincipal, inst: OpenInstallation, threadTs: string | null, messageId: string | null,
  draftId: string, origin: "slack" | "auto"): Promise<boolean> {
  return (await postReplyCardOutcome(principal, inst, threadTs, messageId, draftId, origin)).posted;
}

/** postReplyCard with one more fact for P6's postCards loop: whether Slack refused the bot token (an auth-class failure stops
 *  the loop, §3.5.11). Never throws. */
export async function postReplyCardOutcome(principal: ExecPrincipal, inst: OpenInstallation, threadTs: string | null, messageId: string | null,
  draftId: string, origin: "slack" | "auto"): Promise<{ posted: boolean; authFailed: boolean }> {
  try {
    if (typeof draftId !== "string" || !DRAFT_ID.test(draftId) || !inst || (threadTs !== null && !TS.test(threadTs))) return { posted: false, authFailed: false };
    const now = new Date();
    const card = await replyCardParts(principal, draftId, now);
    // H9 / RK03: a finance-class draft never reaches the assistant DM; a gone draft has nothing to show.
    if (card === null || card.state === "off") return { posted: false, authFailed: false };
    const { ts } = await dmPost(principal, inst, threadTs, card.parts,
      { kind: "note", messageId: typeof messageId === "string" && MESSAGE_ID.test(messageId) ? messageId : null, refId: null }, { signal: ownSignal() });
    const settings = await loadSettings(principal.id);
    const days = Number.isFinite(settings.retentionDaysChat) && settings.retentionDaysChat > 0 ? settings.retentionDaysChat : 30;
    await recordReplyCard(principal, {
      installationId: inst.row.id, dmChannelId: inst.row.dmChannelId, dmTs: ts, threadTs, draftId, origin, version: card.version,
      state: card.state, expiresAt: new Date(Date.now() + days * DAY_MS)
    });
    return { posted: true, authFailed: false };
  } catch (err) {
    console.warn(`[exec-slack-reply] ${logId(draftId)}: card not posted (${errName(err)})`);
    return { posted: false, authFailed: isSlackAuthError(err) };
  }
}

/** One orphan card (its draft row is gone: cascaded away with its message, or purged) turns into cardRemoved, then
 *  markReplyCard(removed). Never throws; true when the card was updated. */
export async function removeReplyCard(principal: ExecPrincipal, card: { installationId: string; dmChannelId: string; dmTs: string }): Promise<boolean> {
  try {
    const stored = await getReplyCard(card.installationId, card.dmTs);
    if (stored === null || stored.principalId !== principal.id) return false;
    const inst = await openInstallationById(principal, card.installationId);
    if (inst === null || inst.row.dmChannelId !== card.dmChannelId) return false;
    await dmUpdate(inst, card.dmTs, removedReplyCardParts(stored.draftId), { signal: ownSignal() });
    await markReplyCard(card.installationId, card.dmTs, stored.renderedVersion, "removed");
    return true;
  } catch (err) {
    console.warn(`[exec-slack-reply] an orphan card wasn't updated (${errName(err)})`);
    return false;
  }
}

/** P10 fixer security-1: how many drafts the sweep re-checks per pass (one RPC 17 read each, plus the row for a live card). */
export const CARD_RECHECKS_PER_PASS = 25;

/** P10 fixer security-1 (H9, §3.5.9 step 6): the drafts whose DM cards are wrong now although the draft row didn't change, so
 *  the sweep re-renders them: any card (not yet `removed` / `off`) whose conversation is now finance-class (the card becomes the
 *  finance line: H9 withdraws the draft text, the summary and Send from the assistant DM), and any `live` card that couldn't
 *  send now (the channel turned external, reading paused, sending off, his token unchecked, a static blocker), which becomes
 *  "Check and send in DD". Never dd_only → live (a click's own dd_only stays until the draft changes). At most
 *  CARD_RECHECKS_PER_PASS drafts a pass: drafts with a live or dd_only card first (they carry the text and Send); when there are
 *  more, a slice chosen by the pass's 5-minute bucket, so every draft is re-checked within a bounded number of passes. Reads
 *  only (DB: the cards, RPC 17, the row, the settings and P10's token health); a read that fails skips that draft. */
export async function replyCardsOutOfDate(principal: ExecPrincipal, now: Date): Promise<string[]> {
  const cards = await listReplyCardStates(principal);
  if (cards.length === 0) return [];
  const showsText = (states: readonly ReplyCardState[]) => states.includes("live") || states.includes("dd_only");
  const byId = (a: { draftId: string }, b: { draftId: string }) => (a.draftId < b.draftId ? -1 : a.draftId > b.draftId ? 1 : 0);
  const first = cards.filter((c) => showsText(c.states)).sort(byId);
  const rest = cards.filter((c) => !showsText(c.states)).sort(byId);
  const bucket = Math.floor(now.getTime() / (P10_LIMITS.sweepMinutes * 60_000));
  const slice = <T,>(list: T[], room: number): T[] => {
    if (room <= 0) return [];
    if (list.length <= room) return list;
    const at = (bucket % Math.ceil(list.length / room)) * room;
    return list.slice(at, at + room);
  };
  const picked = [...slice(first, CARD_RECHECKS_PER_PASS), ...slice(rest, CARD_RECHECKS_PER_PASS - Math.min(first.length, CARD_RECHECKS_PER_PASS))];
  let settings: ExecSettings | null = null;
  let tokenOk = false;
  const out: string[] = [];
  for (const c of picked) {
    try {
      const facts = await replyTargetFacts(principal, c.draftId);
      if (facts.finance) {
        out.push(c.draftId);
        continue;
      }
      if (!c.states.includes("live")) continue;
      const row = await getReplyDraft(principal, c.draftId);
      if (row === null) continue;   // its cards are listOrphanReplyCards'
      if (settings === null) [settings, tokenOk] = await Promise.all([loadSettings(principal.id), tokenHealthOk(principal)]);
      if (cardStateOf(row, facts, settings, tokenOk).state !== "live") out.push(c.draftId);
    } catch (err) {
      console.warn(`[exec-slack-reply] ${logId(c.draftId)}: card not re-checked (${errName(err)})`);
    }
  }
  return out;
}

/** chat.update of every card of the draft (dmUpdate), then markReplyCard; a missing row renders cardRemoved. Never throws.
 *  v1.1: clickOutcome (the send job's dd_only / needs_ack) adds the "Nothing was posted" prefix (product-8); blockers (additive)
 *  are that answer's reasons, shown in words. */
export async function rerenderReplyCards(principal: ExecPrincipal, draftId: string,
  opts?: { now?: Date; clickOutcome?: "dd_only" | "needs_ack"; blockers?: readonly ReplyBlocker[] }): Promise<number> {
  let updated = 0;
  try {
    if (typeof draftId !== "string" || !DRAFT_ID.test(draftId)) return 0;
    const cards = await listReplyCards(principal, draftId);
    if (cards.length === 0) return 0;
    const now = opts?.now instanceof Date && Number.isFinite(opts.now.getTime()) ? opts.now : new Date();
    const card = await replyCardParts(principal, draftId, now, opts?.clickOutcome !== undefined ? { clickOutcome: opts.clickOutcome, blockers: opts.blockers ?? [] } : undefined);
    const parts = card?.parts ?? removedReplyCardParts(draftId);
    const opened = new Map<string, OpenInstallation | null>();
    for (const c of cards) {
      try {
        if (!opened.has(c.installationId)) opened.set(c.installationId, await openInstallationById(principal, c.installationId));
        const inst = opened.get(c.installationId) ?? null;
        if (inst === null || inst.row.dmChannelId !== c.dmChannelId) continue;
        await dmUpdate(inst, c.dmTs, parts, { signal: ownSignal() });
        await markReplyCard(c.installationId, c.dmTs, card?.version ?? c.renderedVersion, card?.state ?? "removed");
        updated += 1;
      } catch (err) {
        console.warn(`[exec-slack-reply] ${logId(draftId)}: a card wasn't updated (${errName(err)})`);
      }
    }
  } catch (err) {
    console.warn(`[exec-slack-reply] ${logId(draftId)}: cards not re-rendered (${errName(err)})`);
  }
  return updated;
}

// ---------------------------------------------------------------------------
// The pages (§3.5.13)
// ---------------------------------------------------------------------------

export interface ReplyDraftPageView {
  state: "not_installed" | "off" | "not_found" | "ok";
  draft: null | {
    id: string; status: ReplyStatus; statusReason: string | null; version: number; text: string | null; note: string | null;
    placeholders: string[]; flags: ReplyFlag[]; injection: boolean; external: boolean; finance: boolean; destination: string;
    summary: string | null; sourcePermalink: string | null; generationError: ReplyGenerationError | null; edited: boolean;
    sentAt: string | null; postedPermalink: string | null; ownerResolution: "posted" | "not_posted" | null;
    staticBlockers: ReplyBlocker[];      // external, flags, injection, placeholders: known without a live read (the full set comes from the review, C59)
    sendOff: boolean; readingOff: boolean; canSend: boolean; canEdit: boolean;
    // v1.1
    place: string; inThread: boolean; authorLabel: string | null;   // product-5
    voiceSource: ReplyVoiceSource | null;                             // product-12
    /** product-3 / security-7: while status is unknown and verify_checks < 3: sending_at + replyVerifyHorizonMs; else null. */
    verifyingUntil: string | null;
    /** product-3 / security-7: status unknown and verify_checks = 3 (the two answers show only then). */
    canResolve: boolean;
  };
}

/** Whether the P10 reply pages are installed and on (the schema, the switch, the tables). */
async function repliesState(principal: ExecPrincipal, signal: AbortSignal | undefined): Promise<{ settings: ExecSettings; state: "not_installed" | "off" | "ok" }> {
  const settings = await loadSettings(principal.id);
  if (!settings.slackP10SchemaReady || !(await replySchemaReady({ signal }))) return { settings, state: "not_installed" };
  if (!settings.slackRepliesEnabled) return { settings, state: "off" };
  return { settings, state: "ok" };
}

export async function getReplyDraftPageView(principal: ExecPrincipal, id: string, now: Date, opts?: { signal?: AbortSignal }): Promise<ReplyDraftPageView> {
  const signal = opts?.signal;
  const gate = await repliesState(principal, signal);
  if (gate.state !== "ok") return { state: gate.state, draft: null };
  if (typeof id !== "string" || !DRAFT_ID.test(id)) return { state: "not_found", draft: null };
  const row = await getReplyDraft(principal, id, { signal });
  if (row === null) return { state: "not_found", draft: null };
  const [facts, source] = await Promise.all([replyTargetFacts(principal, row.id, { signal }), replySourceOf(principal, row)]);
  const blockers = staticReplyBlockers(row, facts).filter((b) => b === "placeholders" || b === "external" || b === "flags" || b === "injection");
  const sendOff = !sendOn(gate.settings);
  const readingOff = !facts.readingLive;
  const placeholders = row.text !== null ? findPlaceholders(row.text) : [];
  const targetOk = facts.found && facts.channelOk && facts.message && !facts.deleted;
  const isDraft = row.status === "draft" && row.text !== null && row.contentPurgedAt === null;
  const verifyingUntil = verifyingUntilOf(row);
  void now;
  return {
    state: "ok",
    draft: {
      id: row.id, status: row.status, statusReason: row.statusReason, version: row.version, text: row.text, note: row.note, placeholders,
      flags: [...row.flags], injection: row.injectionSuspected, external: row.external || facts.external, finance: row.finance || facts.finance,
      destination: source.destination, summary: source.summary, sourcePermalink: source.sourcePermalink, generationError: row.generationError,
      edited: row.edited, sentAt: row.sentAt, postedPermalink: row.postedPermalink, ownerResolution: row.ownerResolution,
      staticBlockers: blockers, sendOff, readingOff,
      // C48: placeholders are a hard stop; every other blocker is acknowledged in the dialog after the review (C59).
      canSend: isDraft && !sendOff && !readingOff && targetOk && placeholders.length === 0,
      canEdit: isDraft,
      place: source.place, inThread: source.inThread, authorLabel: source.authorLabel, voiceSource: row.voiceSource,
      verifyingUntil, canResolve: row.status === "unknown" && row.verifyChecks >= P10_LIMITS.replyVerifyDelaysMs.length
    }
  };
}

export async function getNewReplyView(principal: ExecPrincipal, q: { channelId: string; ts: string }, opts?: { signal?: AbortSignal }):
  Promise<{ state: "not_installed" | "off" | "not_allowed" | "ok"; existingId: string | null; destination: string | null; summary: string | null }> {
  const signal = opts?.signal;
  const none = { existingId: null, destination: null, summary: null };
  const gate = await repliesState(principal, signal);
  if (gate.state !== "ok") return { state: gate.state, ...none };
  if (!gate.settings.slackReadingSchemaReady || !gate.settings.slackReadingEnabled) return { state: "off", ...none };
  if (typeof q?.channelId !== "string" || !CHANNEL_ID.test(q.channelId) || typeof q.ts !== "string" || !TS.test(q.ts)) {
    return { state: "not_allowed", ...none };
  }
  // One active draft per message (C45): an open one is where he goes.
  const existing = (await listReplyDraftsForMessages(principal, [{ channelId: q.channelId, ts: q.ts }], { signal })).get(`${q.channelId}:${q.ts}`) ?? null;
  if (existing !== null && (REPLY_ACTIVE_STATUSES as readonly string[]).includes(existing.status)) {
    return { state: "ok", existingId: existing.id, destination: null, summary: null };
  }
  // C45 / C46: a stored message with at least one item the screen lets him see on the web.
  const items = await listItemsForMessage(principal, q.channelId, q.ts);
  if (items.length === 0) return { state: "not_allowed", ...none };
  const shown = await getSlackItemsByIds(principal, items.map((i) => i.id), { surface: "web", signal });
  if (shown.length === 0) return { state: "not_allowed", ...none };
  const item = [...shown].sort((a, b) => precedence(a) - precedence(b))[0];
  const ch = await getChannel(principal, q.channelId);
  if (ch === null) return { state: "not_allowed", ...none };
  const person = personOf(item);
  const place = replyPlace(ch, ch.convType, person);
  // C28: a channel reply always goes in a thread; a DM reply goes where its message is (P7a stores a reply's root in threadTs).
  const inThread = ch.convType === "channel" || ch.convType === "group" || item.threadTs !== null;
  return {
    state: "ok", existingId: null, destination: replyDestination(place, inThread),
    summary: item.assessed && typeof item.summary === "string" && item.summary.trim() !== "" ? item.summary : null
  };
}

/** The draft's message (its channel and ts), for "Start a new draft with this text" after "It didn't post" (RPC 13's
 *  p_from_draft wants the same channel and message in the body); null for any other status or a gone row. DB only. */
export async function replyDraftSource(principal: ExecPrincipal, id: string, opts?: { signal?: AbortSignal }): Promise<{ channelId: string; ts: string } | null> {
  const row = await getReplyDraft(principal, id, opts?.signal ? { signal: opts.signal } : undefined);
  if (row === null || row.status !== "failed" || row.ownerResolution !== "not_posted") return null;
  return { channelId: row.channelId, ts: row.sourceTs };
}

/** v1.1 product-16: sentAt for "Replied {time}". Key "<channel>:<ts>". The newest draft per message, active first. */
export async function replyBadgesFor(principal: ExecPrincipal, keys: readonly { channelId: string; ts: string }[], opts?: { signal?: AbortSignal }):
  Promise<Map<string, { id: string; status: ReplyStatus; sentAt: string | null }>> {
  const wanted = (Array.isArray(keys) ? keys : []).filter((k) => k && typeof k.channelId === "string" && CHANNEL_ID.test(k.channelId)
    && typeof k.ts === "string" && TS.test(k.ts));
  if (wanted.length === 0) return new Map();
  return listReplyDraftsForMessages(principal, wanted, opts?.signal ? { signal: opts.signal } : undefined);
}
