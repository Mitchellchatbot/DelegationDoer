import { assertDmBudget } from "@/lib/exec/brief-slack-ui";
import { isAllowedLinkUrl } from "@/lib/exec/refs";
import { fillP10, SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import type {
  ReplyBlocker,
  ReplyCardState,
  ReplyFlag,
  ReplyGenerationError,
  ReplyVoiceSource
} from "@/lib/exec/slack-p10-types";
import { SLACK_LIMITS } from "@/lib/exec/slack-types";
import type { MrkdwnText, PlainText, SlackBlock, SlackButton, SlackMessageParts } from "@/lib/exec/slack-types";
import { chunkMrkdwn, escapeMrkdwn, safeMrkdwn, sanitizeChars, section, slackLink } from "@/lib/exec/slack-ui";

// P10 the DM card (contract §3.5.11, K10 as amended, C31, C32, C38; Area D; pure: P6's slack-ui primitives, P8's
// assertDmBudget, refs' allow-list and the P10 copy, nothing else).
//
//   * The draft body is ONE section(escapeMrkdwn(stored text)) (K10 amended, v1.1 security-2): byte-identical to the `text`
//     the sender posts (RS01), never safeMrkdwn, never chunked while the card can send it. section() is verbatim: true and
//     escapeMrkdwn escapes & < >, so nothing in it links, mentions or broadcasts in the bot's DM. A draft too long for one
//     section is chunked for reading only, and that card can't send (dd_only, too_long).
//   * Every other model or person text (the summary, the note, the destination's names) goes through safeMrkdwn; fixed copy
//     through escapeMrkdwn; links only through slackLink (allow-listed) or an allow-listed DD button url.
//   * The top-level text is SLACK_P10_COPY.replies.cardFallback, never content. ≤ 12 blocks, asserted with assertDmBudget.
//   * Send exists only on a `live` card, with Block Kit's confirm (C32); Discard always confirms, Rewrite confirms when he
//     edited the text (v1.1 product-15).

export interface ReplyCardView {
  draftId: string; state: ReplyCardState; version: number;
  destination: string;                 // SLACK_P10_COPY.replies.destination filled ("Reply in {place}{thread}", v1.1 product-5)
  place: string; inThread: boolean;    // v1.1 product-5: for cardConfirmText's {place}{thread}
  external: boolean;
  summary: string | null;              // P7a's item summary (≤ 200, AI-written), never the excerpt
  authorLabel: string | null;          // v1.1 product-5: P7a's item author label, for "a message from {person}" when summary is null
  sourcePermalink: string | null;      // v1.1 product-5: the item's permalink (allow-listed), "Open the message in Slack"
  text: string | null; note: string | null; placeholders: string[]; flags: ReplyFlag[];
  /** v1.1 security-2: escapeMrkdwn(text).length ≤ sectionSafeChars. False → never `live` (Send only from DD). */
  fitsOneSection: boolean;
  /** v1.1 product-8: every reason the card isn't live, in words (cardDdReasons): the blockers plus send off, an unchecked
   *  token and a draft too long to show in one section. */
  ddReasons: (ReplyBlocker | "send_off" | "token" | "too_long")[];
  notSentPrefix: boolean;              // v1.1 product-8: the last click on this card ended dd_only / needs_ack: "Nothing was posted"
  generationError: ReplyGenerationError | null;   // v1.1 product-8: failed_generation's reason and next step
  edited: boolean;                     // v1.1 product-15: Rewrite asks first when he edited the text
  voiceSource: ReplyVoiceSource | null;           // v1.1 product-12: the style line
  checkingUntil: string | null;        // v1.1 product-3: unknown, while DD is still checking (sending_at + replyVerifyHorizonMs)
  ddHref: string; permalink: string | null;
  sendValue: string | null;            // replyButtonValue(stored row) when state is live; else null
  actValue: string | null;             // the same value for Rewrite / Discard
  reasonText: string | null;           // the failure or back-to-draft reason copy
}

const COPY = SLACK_P10_COPY.replies;
/** §3.5.11: a card is at most 12 blocks. */
export const REPLY_CARD_BLOCKS_MAX = 12;
/** Slack's own limits on a confirm object's plain texts (title 100, text 300, buttons 30). */
const CONFIRM_TITLE_MAX = 100;
const CONFIRM_TEXT_MAX = 300;
const CONFIRM_BUTTON_MAX = 30;
const BUTTON_TEXT_MAX = 75;
const HEADER_MAX = 150;
/** RK01 / ST07: the confirm's {place} is clipped to 80 characters (the longest a fill may use). */
const CONFIRM_PLACE_MAX = 80;
/** The longest a summary, a note or a label is shown before it is clipped with "…". */
const SUMMARY_MAX = 300;
const NOTE_MAX = 400;
const PERSON_MAX = 80;
/** A draft too long for one section is shown, for reading only, in at most this many sections (the rest is clipped). */
const READ_ONLY_PIECES_MAX = 4;

/** The generation errors after which trying again can help (v1.1 product-8). */
const RETRYABLE: ReadonlySet<ReplyGenerationError> = new Set<ReplyGenerationError>([
  "refused", "truncated", "invalid_output", "empty", "too_long", "copied_external", "timeout", "model_error", "context_unavailable"
]);

const mrkdwn = (text: string): MrkdwnText => ({ type: "mrkdwn", text, verbatim: true });
const plain = (text: string): PlainText => ({ type: "plain_text", text, emoji: false });
const context = (texts: readonly string[]): SlackBlock => ({ type: "context", elements: texts.map(mrkdwn) });

/** Clip to max UTF-16 units without splitting a surrogate pair; "…" marks a cut. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = Math.max(0, max - 1);
  const c = s.charCodeAt(cut);
  if (cut > 0 && c >= 0xdc00 && c <= 0xdfff) cut -= 1;
  return `${s.slice(0, cut)}…`;
}

/** Content for a plain_text object: controls and bidi stripped, whitespace collapsed, clipped. */
function plainContent(s: unknown, max: number): string {
  return clip(sanitizeChars(typeof s === "string" ? s : "").replace(/\s+/g, " ").trim(), max);
}

/** A person's or a model's short text as mrkdwn (K10): one line, clipped, through safeMrkdwn. */
function safeLine(s: unknown, max: number): string {
  const one = sanitizeChars(typeof s === "string" ? s : "").replace(/\s+/g, " ").trim();
  return one.length > 0 ? safeMrkdwn(clip(one, max)) : "";
}

/** A list of copy words joined "a, b and c". */
function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** escapeMrkdwn(text): exactly what the sender posts (slack-reply-post.ts), so the card he confirms on shows what will post. */
export function replyBodyMrkdwn(text: string): string {
  return escapeMrkdwn(typeof text === "string" ? text : "");
}

/** v1.1 security-2: the draft body fits ONE section once escaped (escapeMrkdwn(text).length ≤ sectionSafeChars). */
export function fitsOneSection(text: string | null): boolean {
  return typeof text === "string" && text.length > 0 && replyBodyMrkdwn(text).length <= SLACK_LIMITS.sectionSafeChars;
}

/** The DD url as a button, only when allow-listed (C38: Edit in DD and its siblings never carry another url). */
function ddButton(url: string, label: string): SlackButton | null {
  if (typeof url !== "string" || !url.startsWith("https://") || !isAllowedLinkUrl(url)) return null;
  return { type: "button", action_id: "ea_open_dd", text: plain(plainContent(label, BUTTON_TEXT_MAX)), url };
}

type Confirm = NonNullable<SlackButton["confirm"]>;
function confirm(title: string, text: string, yes: string, no: string): Confirm {
  return {
    title: plain(plainContent(title, CONFIRM_TITLE_MAX)),
    text: plain(plainContent(text, CONFIRM_TEXT_MAX)),
    confirm: plain(plainContent(yes, CONFIRM_BUTTON_MAX)),
    deny: plain(plainContent(no, CONFIRM_BUTTON_MAX))
  };
}

/** A button value P6's route and v3 accept (≤ 200, the reply pattern); anything else → no button. */
const usableValue = (v: string | null): v is string => typeof v === "string" && v.length > 0 && v.length <= SLACK_LIMITS.actionValueChars;

/** The Send confirm's text: cardConfirmText with the place (≤ 80) and the thread suffix (RK01, ST07). */
export function replyConfirmText(place: string, inThread: boolean): string {
  return fillP10(COPY.cardConfirmText, { place: plainContent(place, CONFIRM_PLACE_MAX) || COPY.place.unknown, thread: inThread ? COPY.thread : "" });
}

function sendButton(v: ReplyCardView): SlackButton | null {
  if (!usableValue(v.sendValue)) return null;
  return {
    type: "button", action_id: "ea_sr_send", style: "primary", value: v.sendValue, text: plain(plainContent(COPY.send, BUTTON_TEXT_MAX)),
    confirm: confirm(COPY.cardConfirmTitle, replyConfirmText(v.place, v.inThread), COPY.cardConfirmYes, COPY.cardConfirmNo)
  };
}

function rewriteButton(v: ReplyCardView, label: string): SlackButton | null {
  if (!usableValue(v.actValue)) return null;
  const b: SlackButton = { type: "button", action_id: "ea_sr_rewrite", value: v.actValue, text: plain(plainContent(label, BUTTON_TEXT_MAX)) };
  if (v.edited) b.confirm = confirm(COPY.cardRewriteConfirmTitle, COPY.cardRewriteConfirmText, COPY.cardRewriteConfirmYes, COPY.cardConfirmNo);
  return b;
}

function discardButton(v: ReplyCardView): SlackButton | null {
  if (!usableValue(v.actValue)) return null;
  return {
    type: "button", action_id: "ea_sr_discard", style: "danger", value: v.actValue, text: plain(plainContent(COPY.discard, BUTTON_TEXT_MAX)),
    confirm: confirm(COPY.cardDiscardConfirmTitle, COPY.cardDiscardConfirmText, COPY.cardDiscardConfirmYes, COPY.cardConfirmNo)
  };
}

/** The buttons each state offers (v1.1 product-8, product-15). Terminal states and `off` offer none. */
function actionsFor(v: ReplyCardView): SlackButton[] {
  const retryable = v.generationError !== null && RETRYABLE.has(v.generationError);
  const list: (SlackButton | null)[] = (() => {
    switch (v.state) {
      case "live":
        return [sendButton(v), rewriteButton(v, COPY.rewrite), ddButton(v.ddHref, COPY.cardEditInDd), discardButton(v)];
      case "dd_only":
        return [ddButton(v.ddHref, COPY.cardDdOnly), rewriteButton(v, COPY.rewrite), discardButton(v)];
      case "failed_generation":
        return [retryable ? rewriteButton({ ...v, edited: false }, COPY.cardTryAgain) : null, ddButton(v.ddHref, COPY.cardEditInDd), discardButton(v)];
      case "generating":
      case "sending":
        return [ddButton(v.ddHref, COPY.cardEditInDd)];
      case "unknown":
        return [ddButton(v.ddHref, COPY.cardOpenInDd)];
      default:
        return [];
    }
  })();
  return list.filter((b): b is SlackButton => b !== null);
}

/** "Replying to: <summary>" / "a message from {person}", with "Open the message in Slack" beside it (v1.1 product-5). */
function replyingToBlock(v: ReplyCardView): SlackBlock | null {
  const summary = safeLine(v.summary, SUMMARY_MAX);
  const person = plainContent(v.authorLabel, PERSON_MAX);
  const what = summary.length > 0 ? summary : person.length > 0 ? safeMrkdwn(fillP10(COPY.replyingToFrom, { person })) : "";
  const link = slackLink(v.sourcePermalink, COPY.openMessage);
  if (what.length === 0 && link === null) return null;
  const parts = [what, link].filter((p): p is string => typeof p === "string" && p.length > 0);
  return section(`*${escapeMrkdwn(COPY.replyingTo)}:* ${parts.join(" · ")}`);
}

/** The state's own line, in place of a body (null where the card shows the draft text). */
function stateLine(v: ReplyCardView): string | null {
  switch (v.state) {
    case "generating":
      return escapeMrkdwn(v.version >= 1 ? COPY.rewriting : COPY.generating);
    case "sending":
      return escapeMrkdwn(COPY.sending);
    case "sent": {
      const link = slackLink(v.permalink, COPY.sentLink);
      return link === null ? escapeMrkdwn(COPY.cardSent) : `${escapeMrkdwn(COPY.cardSent)} ${link}`;
    }
    case "unknown":
      return escapeMrkdwn(v.reasonText ?? (v.checkingUntil !== null ? COPY.unknown : COPY.unknownChecked));
    case "failed":
      return escapeMrkdwn(COPY.failed);
    case "discarded":
      return escapeMrkdwn(COPY.discarded);
    case "expired":
      return escapeMrkdwn(COPY.expired);
    case "removed":
      return escapeMrkdwn(v.reasonText ?? COPY.cardRemoved);
    case "off":
      return escapeMrkdwn(COPY.finance);
    case "failed_generation": {
      const error = v.generationError;
      const reason = error !== null ? COPY.reasons[error] : COPY.reasons.model_error;
      let line = fillP10(COPY.generationFailed, { reason });
      if (error !== null && RETRYABLE.has(error)) line = `${line} ${COPY.tryAgainHint}`;
      else if (error === "budget" || error === "reading_off") line = `${line} ${COPY.nextSteps[error]}`;
      return escapeMrkdwn(line);
    }
    default:
      return null;
  }
}

/** The draft's own text blocks: one exact section, or (too long for one) escaped pieces for reading only. */
function bodyBlocks(v: ReplyCardView, room: number): SlackBlock[] {
  if (typeof v.text !== "string" || v.text.length === 0) return [];
  const body = replyBodyMrkdwn(v.text);
  if (v.fitsOneSection && body.length <= SLACK_LIMITS.sectionSafeChars) return [section(body)];
  const pieces = chunkMrkdwn(body);
  const max = Math.max(1, Math.min(READ_ONLY_PIECES_MAX, room));
  if (pieces.length <= max) return pieces.map((p) => section(p));
  const kept = pieces.slice(0, max);
  kept[max - 1] = `${kept[max - 1]}…`;
  return kept.map((p) => section(p));
}

/** ≤ 12 blocks; top-level text = SLACK_P10_COPY.replies.cardFallback (never content); links only through slackLink
 *  (allow-listed). Every model or person text through safeMrkdwn (K10) EXCEPT the draft body (K10 amended, v1.1 security-2):
 *  section(escapeMrkdwn(text)), byte-identical to the text the sender posts (RS01). Asserted with P8's assertDmBudget. */
export function renderReplyCard(v: ReplyCardView): SlackMessageParts {
  const blocks: SlackBlock[] = [{ type: "header", text: plain(plainContent(COPY.cardTitle, HEADER_MAX)) }];
  // P10 fixer security-3 (H9): the finance card is the header and the finance line only, whatever the view carries (no
  // destination, summary, author, permalink, text or button): it is what withdraws a card whose conversation turned finance.
  if (v.state === "off") {
    blocks.push(section(escapeMrkdwn(COPY.finance)));
    const parts: SlackMessageParts = { blocks, text: COPY.cardFallback };
    assertDmBudget(parts, REPLY_CARD_BLOCKS_MAX);
    return parts;
  }
  // The destination (+ the outside-people line) and the style the draft used.
  const top = [safeLine(v.destination, 200) || escapeMrkdwn(COPY.place.unknown)];
  if (v.external) top.push(escapeMrkdwn(COPY.external));
  if (v.voiceSource !== null && (v.state === "live" || v.state === "dd_only")) top.push(escapeMrkdwn(COPY.style[v.voiceSource]));
  blocks.push(context(top));
  const replying = replyingToBlock(v);
  if (replying !== null) blocks.push(replying);

  const showsText = v.state === "live" || v.state === "dd_only";
  if (showsText) {
    // A rewrite that failed or a send Slack refused: the reason, above the text it left (backToDraft / rewriteFailed).
    if (v.reasonText !== null && v.reasonText.length > 0) blocks.push(context([escapeMrkdwn(v.reasonText)]));
    const actions = actionsFor(v);
    // Header, destination, replying-to, reason, then the body; after it the details line, the why line and the actions.
    const after = 1 + (v.state === "dd_only" ? 1 : 0) + (actions.length > 0 ? 1 : 0);
    const body = bodyBlocks(v, REPLY_CARD_BLOCKS_MAX - blocks.length - after);
    if (body.length > 0) blocks.push(...body);
    else blocks.push(section(escapeMrkdwn(COPY.cardRemoved)));
    const details: string[] = [];
    const note = safeLine(v.note, NOTE_MAX);
    if (note.length > 0) details.push(`*${escapeMrkdwn(COPY.note)}:* ${note}`);
    if (v.placeholders.length > 0) {
      details.push(escapeMrkdwn(fillP10(COPY.placeholders, { list: plainContent(v.placeholders.join(", "), 300) })));
    }
    if (v.flags.length > 0) details.push(escapeMrkdwn(fillP10(COPY.flags, { list: listWords(v.flags.map((f) => COPY.flagNames[f])) })));
    details.push(escapeMrkdwn(COPY.cardCopyHint));
    blocks.push(context(details));
    if (v.state === "dd_only") {
      const reasons: string[] = v.ddReasons.map((r): unknown => COPY.cardDdReasons[r]).filter((w): w is string => typeof w === "string");
      const why = fillP10(COPY.cardDdWhy, { reasons: listWords(reasons.length > 0 ? reasons : [COPY.cardDdReasons.unchecked]) });
      blocks.push(context([escapeMrkdwn(v.notSentPrefix ? `${COPY.cardNotSent} ${why}` : why)]));
    }
    if (actions.length > 0) blocks.push({ type: "actions", block_id: `ea_sr_${v.state}`, elements: actions });
  } else {
    const line = stateLine(v);
    if (line !== null && line.length > 0) blocks.push(section(line));
    if (v.state === "unknown" && v.checkingUntil !== null) blocks.push(context([escapeMrkdwn(COPY.cardChecking)]));
    const actions = actionsFor(v);
    if (actions.length > 0) blocks.push({ type: "actions", block_id: `ea_sr_${v.state}`, elements: actions });
  }
  const parts: SlackMessageParts = { blocks, text: COPY.cardFallback };
  assertDmBudget(parts, REPLY_CARD_BLOCKS_MAX);
  return parts;
}
