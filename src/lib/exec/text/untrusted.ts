import "server-only";

import { randomBytes } from "node:crypto";
import { sanitizeText as sanitizeInvisible } from "@/lib/exec/triage/email-text";

// The one DD text wrapping module of both P5 phases (P5a contract §3.11.1,
// S4, coherence-12; Area D). DD free text that goes to a model is sanitized,
// clipped (at most 1,500 characters per item and 12,000 per input, with one
// clip marker) and wrapped in a nonce-delimited untrusted block. P5b adds its
// TextBudget and per-item renderer here and ships no agent/untrusted.ts.
//
// The block, exactly:
//   <untrusted_dd_text nonce="N">\n
//   [<header> nonce=N]\n<text>\n\n          (once per entry, in order)
//   </untrusted_dd_text>
// The header is written by code; the text was written by DD users. Inside
// the block, only a header line carrying the nonce is a boundary: the text is
// defaced so nothing in it can pass for a header or for either tag, one
// character for one, so lengths (and so every size below) are unchanged.
//
// Server-only (and server-only by transitivity too: sanitizeText and
// normalizeWhitespace come from triage/email-text.ts). No client module may
// import it.
// Nothing here logs or stores anything.

export const DD_TEXT_ITEM_CHARS = 1500;
export const DD_TEXT_RESULT_CHARS = 12000;
export const CLIP_MARKER = " \u{2026}[clipped]";
export { sanitizeText, normalizeWhitespace } from "@/lib/exec/triage/email-text";

// Stand-in for "[" and "<" where content could otherwise forge our markup.
const DEFACED = "\u{2039}";
const NONCE_BYTES = 8;
const NONCE_SHAPE = /^[0-9a-f]{16}$/;

// A line that starts like one of our entry headers: "[i3 …", "[c1 …", "[task …", "[n2 …", any case,
// leading spaces or tabs allowed, and spaces between the bracket and the ref.
const HEADER_LIKE_LINE = /^([^\S\n]*)\[(?=[^\S\n]*(?:i\d+|c\d+|task|n\d+)(?![A-Za-z0-9_]))/gim;
// Anything shaped like an untrusted block's tag, ours or P3's: "<untrusted_dd_text", "</UNTRUSTED_EMAIL>",
// "< / untrusted-anything", "<untrusted_…" with any suffix.
const BLOCK_TAG_LIKE = /<(?=\s*\/?\s*untrusted)/gi;

/**
 * The text clipped to `max` characters (default DD_TEXT_ITEM_CHARS) including
 * the marker " …[clipped]"; never cut through a surrogate pair. Unchanged when
 * it already fits.
 */
export function clipForModel(s: string, max: number = DD_TEXT_ITEM_CHARS): { text: string; clipped: boolean } {
  const text = typeof s === "string" ? s : "";
  const limit = Number.isFinite(max) ? Math.floor(max) : DD_TEXT_ITEM_CHARS;
  if (text.length <= limit) return { text, clipped: false };
  if (limit <= CLIP_MARKER.length) return { text: CLIP_MARKER.slice(0, Math.max(0, limit)), clipped: true };
  let end = limit - CLIP_MARKER.length;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: `${text.slice(0, end).trimEnd()}${CLIP_MARKER}`, clipped: true };
}

/** 16 hex characters from 8 random bytes: the block's proof of authorship. */
export function newNonce(): string {
  return randomBytes(NONCE_BYTES).toString("hex");
}

/**
 * Deface, one character for one ("[" or "<" → "‹"): every line starting with
 * "[" + (i\d+|c\d+|task|n\d+) (the bracket header form), and every
 * "<untrusted_" or "</untrusted_" look-alike with any suffix
 * (case-insensitive), which covers this module's block tags, P5b's per-item
 * `<untrusted_dd_text … id kind ref author at>` blocks and P3's email blocks.
 * Ordinary "<" and "[" elsewhere are left alone. The one DD text neutralizer
 * of both phases (coherence-12).
 */
export function neutralizeDdText(s: string): string {
  if (typeof s !== "string" || s === "") return "";
  return s.replace(HEADER_LIKE_LINE, `$1${DEFACED}`).replace(BLOCK_TAG_LIKE, DEFACED);
}

/** header written by code */
export interface UntrustedEntry {
  header: string;
  text: string;
}

function checkNonce(nonce: string): string {
  if (typeof nonce !== "string" || !NONCE_SHAPE.test(nonce)) throw new TypeError("text/untrusted: the nonce must be 16 hex characters");
  return nonce;
}

/** P7a (contract §3.12, AM-P7a-10): the block's tag. Default untrusted_dd_text; Slack triage renders untrusted_slack.
 *  P8 (stage-0 seed, p8-bindings.md AM-P8-13): untrusted_brief (the brief's email/Slack-derived input, §3.10.1) and
 *  untrusted_checkin (earlier check-in notes going back into the check-in model, §3.12.1). */
export type UntrustedBlockTag = "untrusted_dd_text" | "untrusted_slack" | "untrusted_brief" | "untrusted_checkin";
export interface UntrustedBlockOptions { tag?: UntrustedBlockTag }

const BLOCK_TAGS: ReadonlySet<string> = new Set<UntrustedBlockTag>(["untrusted_dd_text", "untrusted_slack", "untrusted_brief", "untrusted_checkin"]);

function tagOf(opts: UntrustedBlockOptions | undefined): UntrustedBlockTag {
  const tag = opts?.tag;
  return typeof tag === "string" && BLOCK_TAGS.has(tag) ? tag : "untrusted_dd_text";
}
const openTag = (nonce: string, tag: UntrustedBlockTag = "untrusted_dd_text") => `<${tag} nonce="${nonce}">\n`;
const closeTag = (tag: UntrustedBlockTag = "untrusted_dd_text") => `</${tag}>`;

// The header is code-written, but it carries names: one line, and no bracket or
// angle bracket that could end it early or open a tag.
function headerLine(nonce: string, header: string): string {
  const one = (typeof header === "string" ? header : "")
    .replace(/[\r\n\u{2028}\u{2029}]+/gu, " ")
    .replace(/[[\]<>]/g, (c) => (c === "[" || c === "<" ? DEFACED : "\u{203A}"))
    .trim();
  return `[${one} nonce=${nonce}]\n`;
}

function entryText(nonce: string, entry: UntrustedEntry): string {
  return `${headerLine(nonce, entry.header)}${neutralizeDdText(typeof entry.text === "string" ? entry.text : "")}\n\n`;
}

/**
 * `<untrusted_dd_text nonce="N">` + per entry `[<header> nonce=N]\n<text>` +
 * `</untrusted_dd_text>`. Renders entries in order and drops whole TRAILING
 * entries past maxTotal (default DD_TEXT_RESULT_CHARS): the first entry that
 * doesn't fit ends the block. renderedEntries says how many made it, so a
 * caller that can't lose an entry checks it (renderDdtextBatch throws,
 * §3.12.2). Entry text is neutralized here too (idempotent, length-preserving).
 */
export function renderUntrustedBlock(
  nonce: string,
  entries: readonly UntrustedEntry[],
  maxTotal: number = DD_TEXT_RESULT_CHARS,
  opts: UntrustedBlockOptions = {}
): { block: string; renderedEntries: number; droppedEntries: number } {
  checkNonce(nonce);
  const tag = tagOf(opts);
  const limit = Number.isFinite(maxTotal) ? Math.floor(maxTotal) : DD_TEXT_RESULT_CHARS;
  let size = untrustedBlockOverhead(nonce, { tag });
  const parts: string[] = [];
  for (const entry of entries) {
    const part = entryText(nonce, entry);
    if (size + part.length > limit) break;
    size += part.length;
    parts.push(part);
  }
  return { block: `${openTag(nonce, tag)}${parts.join("")}${closeTag(tag)}`, renderedEntries: parts.length, droppedEntries: entries.length - parts.length };
}

/** The characters one entry adds to a block (header line, text, separators), for packers. */
export function untrustedEntrySize(nonce: string, entry: UntrustedEntry): number {
  return entryText(checkNonce(nonce), entry).length;
}

/** The fixed open+close tag overhead of a block, for packers (opts.tag as renderUntrustedBlock's). */
export function untrustedBlockOverhead(nonce: string, opts: UntrustedBlockOptions = {}): number {
  const tag = tagOf(opts);
  return openTag(checkNonce(nonce), tag).length + closeTag(tag).length;
}

// ---------------------------------------------------------------------------
// P5b additions (P5b contract §3.6, C46, C47; Area B): the chat tools' per-item
// blocks, the per-result text budget, credential masking and the ref-marker
// deface. P5a's exports above are unchanged.
//
// A chat tool result carries DD text one item per block:
//   <untrusted_dd_text nonce="N" id="U3" kind="comment" ref="r12" author="Sam Lee" at="Nov 3, 2:02 PM EST">
//   …text…
//   </untrusted_dd_text>
// The attributes are code-written (their values neutralized and escaped); the
// text was written by DD users or by a model (kind ai_summary, attention_text).
// ---------------------------------------------------------------------------

export type UntrustedKind =
  | "task_description" | "comment" | "status_note" | "handoff_note" | "extension_reason" | "task_message"
  | "eod_note" | "sod_note" | "meeting_brief" | "ai_summary" | "attention_text"
  // P7b (contract §3.15.2, bindings AM-P7b-20): Slack text (an item summary or excerpt, a digest's AI text, a live
  // message). Rendered as an <untrusted_slack …> block (the tag P7a's Slack triage uses), never as DD text, so it doesn't
  // count as an S4 DD-text block for C24.
  | "slack_text";

const UNTRUSTED_KINDS: ReadonlySet<string> = new Set<UntrustedKind>([
  "task_description", "comment", "status_note", "handoff_note", "extension_reason", "task_message",
  "eod_note", "sod_note", "meeting_brief", "ai_summary", "attention_text", "slack_text"
]);

const HIDDEN = "[hidden]";
// C46: a credential label, whole word, any case, then ":" or "=" and a value on the same line. The longer labels come
// first so "username/password" is not read as "username" + "/password".
const SECRET_LABEL =
  /(?<![A-Za-z0-9_])(username\/password|user\/pass|client[^\S\n]+secret|api[^\S\n]+key|apikey|password|passcode|secret|token|login|pwd|pass)(?![A-Za-z0-9_])[^\S\n]*[:=][^\S\n]*(?=\S)[^\n]*/gi;
// C46: a long run of key-like characters (an API key, a token) holding at least one letter and one digit.
const SECRET_RUN = /[A-Za-z0-9_-]{32,}/g;
const HAS_LETTER = /[A-Za-z]/;
const HAS_DIGIT = /[0-9]/;
// C47 (1): "[" then optional spaces, "r" (any case), 1-5 digits, optional spaces, then "]" or ",".
const REF_MARKER_LIKE = /\[(?=\s*[rR]\d{1,5}\s*[\],])/g;

/**
 * C46. A label (password, passcode, pwd, pass, login, user/pass, username/password, token, api key, apikey, secret,
 * client secret; any case, whole word) followed by ":" or "=" keeps the label and loses the value up to the end of the
 * line ("<label>: [hidden]"); a run of 32 or more characters of [A-Za-z0-9_-] holding a letter and a digit becomes
 * "[hidden]". masked = anything changed.
 */
export function maskSecrets(s: string): { text: string; masked: boolean } {
  if (typeof s !== "string" || s === "") return { text: "", masked: false };
  let masked = false;
  const labelled = s.replace(SECRET_LABEL, (_all, label: string) => {
    masked = true;
    return `${label}: ${HIDDEN}`;
  });
  const text = labelled.replace(SECRET_RUN, (run) => {
    if (!HAS_LETTER.test(run) || !HAS_DIGIT.test(run)) return run;
    masked = true;
    return HIDDEN;
  });
  return { text, masked };
}

/**
 * C47 (1): every "[" that starts "[", optional spaces, "r" (any case), 1-5 digits, optional spaces, then "]" or ","
 * becomes "‹", one character for one (P3's convention), so untrusted text can't pass for a citation marker.
 */
export function defaceRefMarkers(s: string): string {
  if (typeof s !== "string" || s === "") return "";
  return s.replace(REF_MARKER_LIKE, DEFACED);
}

/**
 * C47 (3): sanitize (invisible and bidi characters out, so none can hide a look-alike) → maskSecrets →
 * neutralizeDdText → defaceRefMarkers. Applied to every free-text value a chat tool puts in its JSON (titles, names,
 * subjects, counterparts, summaries, reasons, decision questions, commitment text, attention text, attachment names,
 * project and stage names).
 */
export function neutralizeChatText(s: string): { text: string; masked: boolean } {
  if (typeof s !== "string" || s === "") return { text: "", masked: false };
  const { text, masked } = maskSecrets(sanitizeInvisible(s));
  return { text: defaceRefMarkers(neutralizeDdText(text)), masked };
}

export interface UntrustedItem {
  kind: UntrustedKind;
  ref: string | null;
  author: string | null;
  at: string | null;
  text: string;
}

const ATTRIBUTE_CHARS = 120;
const RIGHT_DEFACED = "\u{203A}";
const BLOCK_ID = /^[A-Z][0-9]{1,4}$/;
const REF_SHAPE = /^r[0-9]{1,5}$/;
const DD_TEXT_CLOSE = "</untrusted_dd_text>";
const SLACK_TEXT_CLOSE = "</untrusted_slack>";

// An attribute value: one line, neutralized, the four markup characters replaced, at most 120 characters.
function attributeValue(raw: string): string {
  const one = neutralizeChatText(raw).text.replace(/\s+/g, " ").trim();
  const escaped = one.replace(/["<>&]/g, (c) => (c === '"' ? "'" : c === "<" ? DEFACED : c === ">" ? RIGHT_DEFACED : "+"));
  return clipForModel(escaped, ATTRIBUTE_CHARS).text;
}


function itemText(text: string): { text: string; masked: boolean } {
  const { text: maskedText, masked } = maskSecrets(sanitizeInvisible(typeof text === "string" ? text : ""));
  // Mask BEFORE the clip (C46), so a clip can't cut a secret in half and leave its tail.
  return { text: clipForModel(defaceRefMarkers(neutralizeDdText(maskedText)).trim(), DD_TEXT_ITEM_CHARS).text, masked };
}

function renderItem(nonce: string, id: string, item: UntrustedItem, text: string): string {
  const attrs = [`nonce="${nonce}"`, `id="${id}"`, `kind="${item.kind}"`];
  if (item.ref !== null && REF_SHAPE.test(item.ref)) attrs.push(`ref="${item.ref}"`);
  if (typeof item.author === "string" && item.author.trim() !== "") attrs.push(`author="${attributeValue(item.author)}"`);
  if (typeof item.at === "string" && item.at.trim() !== "") attrs.push(`at="${attributeValue(item.at)}"`);
  if (item.kind === "slack_text") return `<untrusted_slack ${attrs.join(" ")}>\n${text}\n${SLACK_TEXT_CLOSE}`;
  return `<untrusted_dd_text ${attrs.join(" ")}>\n${text}\n${DD_TEXT_CLOSE}`;
}

function checkItem(nonce: string, id: string, item: UntrustedItem): void {
  checkNonce(nonce);
  if (typeof id !== "string" || !BLOCK_ID.test(id)) throw new TypeError("text/untrusted: a block id is a letter and 1-4 digits");
  if (!item || !UNTRUSTED_KINDS.has(item.kind)) throw new TypeError("text/untrusted: unknown untrusted item kind");
}

/**
 * One chat block per item. text = maskSecrets → neutralizeDdText → defaceRefMarkers → clipForModel(DD_TEXT_ITEM_CHARS);
 * attribute values neutralized, `"` `<` `>` `&` replaced, at most 120 characters each; ref, author and at are left out
 * when absent. The nonce is newNonce() (16 hex), one per tool result.
 */
export function renderUntrustedItemBlock(nonce: string, id: string, item: UntrustedItem): { block: string; masked: boolean } {
  checkItem(nonce, id, item);
  const { text, masked } = itemText(item.text);
  return { block: renderItem(nonce, id, item, text), masked };
}

/**
 * One tool result's untrusted items under the S4 budget: at most `totalChars` (default DD_TEXT_RESULT_CHARS) of item
 * text, each item clipped to DD_TEXT_ITEM_CHARS first. Once an item doesn't fit, it and every later item are refused
 * (counted in `omitted`), so what is shown is always a prefix of what the tool offered.
 */
export class TextBudget {
  private readonly nonce: string;
  private readonly total: number;
  private used = 0;
  private refusedOnce = false;
  private omittedCount = 0;
  private anyMasked = false;
  private readonly kept: { id: string; ref: string | null; block: string }[] = [];

  constructor(nonce: string, totalChars: number = DD_TEXT_RESULT_CHARS) {
    this.nonce = checkNonce(nonce);
    this.total = Number.isFinite(totalChars) && totalChars >= 0 ? Math.floor(totalChars) : DD_TEXT_RESULT_CHARS;
  }

  /**
   * Adds one item; returns its block id ("U<n>", in order) or null when the result budget is spent (the caller marks
   * the entry text_omitted: true). An item with no text left after neutralizing is not a block: null, not counted.
   */
  add(item: UntrustedItem): string | null {
    const { text, masked } = itemText(item?.text ?? "");
    if (text === "") return null;
    if (this.refusedOnce || this.used + text.length > this.total) {
      this.refusedOnce = true;
      this.omittedCount += 1;
      return null;
    }
    const id = `U${this.kept.length + 1}`;
    checkItem(this.nonce, id, item);
    this.used += text.length;
    if (masked) this.anyMasked = true;
    const ref = item.ref !== null && REF_SHAPE.test(item.ref) ? item.ref : null;
    this.kept.push({ id, ref, block: renderItem(this.nonce, id, item, text) });
    return id;
  }

  /** The kept blocks in order; each non-empty. */
  blocks(): { id: string; ref: string | null; block: string }[] {
    return this.kept.map((b) => ({ ...b }));
  }

  get omitted(): number {
    return this.omittedCount;
  }

  /** C46: some kept item was masked; the result then carries the note "Some credential-like text was hidden." */
  get masked(): boolean {
    return this.anyMasked;
  }
}
