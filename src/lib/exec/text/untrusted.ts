import "server-only";

import { randomBytes } from "node:crypto";

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

const openTag = (nonce: string) => `<untrusted_dd_text nonce="${nonce}">\n`;
const CLOSE_TAG = "</untrusted_dd_text>";

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
  maxTotal: number = DD_TEXT_RESULT_CHARS
): { block: string; renderedEntries: number; droppedEntries: number } {
  checkNonce(nonce);
  const limit = Number.isFinite(maxTotal) ? Math.floor(maxTotal) : DD_TEXT_RESULT_CHARS;
  let size = untrustedBlockOverhead(nonce);
  const parts: string[] = [];
  for (const entry of entries) {
    const part = entryText(nonce, entry);
    if (size + part.length > limit) break;
    size += part.length;
    parts.push(part);
  }
  return { block: `${openTag(nonce)}${parts.join("")}${CLOSE_TAG}`, renderedEntries: parts.length, droppedEntries: entries.length - parts.length };
}

/** The characters one entry adds to a block (header line, text, separators), for packers. */
export function untrustedEntrySize(nonce: string, entry: UntrustedEntry): number {
  return entryText(checkNonce(nonce), entry).length;
}

/** The fixed open+close tag overhead of a block, for packers. */
export function untrustedBlockOverhead(nonce: string): number {
  return openTag(checkNonce(nonce)).length + CLOSE_TAG.length;
}
