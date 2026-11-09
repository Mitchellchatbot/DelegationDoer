import { BRIEF_COPY, fillBrief } from "@/lib/exec/brief-copy";                                       // P8 (pure, no imports)
import type { ChatDonePayload, DisplaySource, ProposalView } from "@/lib/exec/chat/view-types";   // P5b
import { markersForDisplay } from "@/lib/exec/chat/markers";
import { draftPageHref } from "@/lib/exec/drafts-links";
import type { DraftView, ExecDraftStatus } from "@/lib/exec/drafts-types";                           // P4
import { appOrigin, isAllowedLinkUrl } from "@/lib/exec/refs";
import { PROPOSAL_PRIVACY_NOTICE, SLACK_COPY } from "@/lib/exec/slack-copy";
import { SLACK_LIMITS, SLACK_VALUE_RE } from "@/lib/exec/slack-types";
import type { MrkdwnText, PlainText, SlackBlock, SlackButton, SlackHomeView, SlackMessageParts } from "@/lib/exec/slack-types";

// P6: every Block Kit block the bot emits (contract §3.6.2, K10; Area B;
// pure: no server-only, no Supabase). Rendering rules 1-11 of §3.6.2 apply
// to every renderer; __tests__/slack-assert.ts checks them.
//
//   - Every mrkdwn object has verbatim: true (Slack auto-parses no URL,
//     channel or mention) and every plain_text emoji: false.
//   - Text a model, an email, a DD record or Slack produced goes through
//     safeMrkdwn: sanitizeChars → markdownToMrkdwn → normalizeBackticks →
//     defangUrls → escapeMrkdwn. Fixed copy goes through escapeMrkdwn only.
//   - A link appears only through slackLink (an allow-listed https URL) or as
//     a button url built from appOrigin() and a DD path; every other URL-like
//     token, bare domains and e-mail addresses included, sits in a code span.
//   - SlackMessageParts.text is always SLACK_COPY.fallbackText, never content.
//
// The code-span rules (security-5) are one scanner shared by
// normalizeBackticks, defangUrls and chunkMrkdwn, so "inside a span" means
// the same thing at every step: a ``` fence counts only when a later ```
// closes it; outside fences, a backtick opens an inline span only when the
// next backtick on the same line closes it within 1..1,000 characters.
// Everything else that looks like a backtick is replaced by U+02CB.

// --- characters (§0.3 rule 3: ranges by code point, never raw in source) ------------------------

/** U+02CB MODIFIER LETTER GRAVE ACCENT: what a backtick that pairs with nothing becomes. */
const GRAVE_ACCENT = String.fromCodePoint(0x02cb);
/** U+FFFD REPLACEMENT CHARACTER: what a lone surrogate becomes. */
const REPLACEMENT = String.fromCodePoint(0xfffd);
const BACKTICK = "`";
const FENCE = "```";

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Code units sanitizeChars drops: C0 controls but \t (U+0009) and \n (U+000A); DEL and the C1 controls (U+007F–U+009F);
 *  bidi controls U+202A–U+202E, U+2066–U+2069 and marks U+200E, U+200F, U+061C; zero-width and invisible characters
 *  U+200B–U+200D, U+2060–U+2064, U+FEFF. */
function isStripped(c: number): boolean {
  if (c < 0x20) return c !== 0x09 && c !== 0x0a;
  if (c >= 0x7f && c <= 0x9f) return true;
  if (c >= 0x200b && c <= 0x200f) return true;
  if (c >= 0x202a && c <= 0x202e) return true;
  if (c >= 0x2060 && c <= 0x2064) return true;
  if (c >= 0x2066 && c <= 0x2069) return true;
  return c === 0xfeff || c === 0x061c;
}

/** Strip C0 controls except \n and \t, DEL, bidi controls (U+202A–U+202E, U+2066–U+2069) and zero-width chars
 *  (U+200B–U+200D, U+2060, U+FEFF); lone surrogates → U+FFFD. Ranges built with String.fromCodePoint (§0.3 rule 3).
 *  (Also C1 controls, the bidi marks U+200E/U+200F/U+061C and the invisible operators U+2061–U+2064.) */
export function sanitizeChars(s: string): string {
  const str = typeof s === "string" ? s : "";
  const out: string[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (isHighSurrogate(c)) {
      if (i + 1 < str.length && isLowSurrogate(str.charCodeAt(i + 1))) {
        out.push(str[i], str[i + 1]);
        i += 1;
      } else {
        out.push(REPLACEMENT);
      }
      continue;
    }
    if (isLowSurrogate(c)) {
      out.push(REPLACEMENT);
      continue;
    }
    if (isStripped(c)) continue;
    out.push(str[i]);
  }
  return out.join("");
}

/** & → &amp;, < → &lt;, > → &gt; (& first). Applied to every piece of text P6 puts in a text object, code spans included. */
export function escapeMrkdwn(s: string): string {
  const str = typeof s === "string" ? s : "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- the code-span scanner (security-5) ------------------------------------------------------------

interface CodeRegions {
  /** [start, end) of every closed ``` block, both markers included. */
  fences: [number, number][];
  /** [start, end) of every well-formed inline span, both backticks included. */
  spans: [number, number][];
  /** Backtick positions that belong to neither (an unclosed fence's three included). */
  stray: number[];
}

/** Characters between two backticks as Slack shows them: escaped text counts each entity as one (chunkMrkdwn's view). */
function displayedLength(s: string, from: number, to: number): number {
  return s.slice(from, to).replace(/&(?:amp|lt|gt);/g, "x").length;
}

function scanCode(s: string, measure: (s: string, from: number, to: number) => number = (_s, from, to) => to - from): CodeRegions {
  const fenceStarts: number[] = [];
  for (let i = s.indexOf(FENCE); i !== -1; i = s.indexOf(FENCE, i + 3)) fenceStarts.push(i);
  const fences: [number, number][] = [];
  const stray: number[] = [];
  for (let k = 0; k + 1 < fenceStarts.length; k += 2) fences.push([fenceStarts[k], fenceStarts[k + 1] + 3]);
  const inFenceToken = new Set<number>();
  for (const start of fenceStarts) for (let j = 0; j < 3; j++) inFenceToken.add(start + j);
  if (fenceStarts.length % 2 === 1) {
    const open = fenceStarts[fenceStarts.length - 1];
    stray.push(open, open + 1, open + 2);
  }

  // Single backticks between the closed fences, paired segment by segment.
  const spans: [number, number][] = [];
  const segments: [number, number][] = [];
  let cursor = 0;
  for (const [a, b] of fences) {
    segments.push([cursor, a]);
    cursor = b;
  }
  segments.push([cursor, s.length]);
  for (const [from, to] of segments) {
    const ticks: number[] = [];
    for (let i = s.indexOf(BACKTICK, from); i !== -1 && i < to; i = s.indexOf(BACKTICK, i + 1)) if (!inFenceToken.has(i)) ticks.push(i);
    let k = 0;
    while (k < ticks.length) {
      const open = ticks[k];
      const close = ticks[k + 1];
      if (close !== undefined) {
        const inner = s.slice(open + 1, close);
        const len = measure(s, open + 1, close);
        if (!/[\r\n]/.test(inner) && len >= 1 && len <= SLACK_LIMITS.inlineCodeSpanMaxChars) {
          spans.push([open, close + 1]);
          k += 2;
          continue;
        }
      }
      stray.push(open);
      k += 1;
    }
  }
  return { fences, spans, stray };
}

/** security-5: make backtick pairing unambiguous BEFORE defangUrls, so no URL can sit outside a span Slack really renders.
 *  - a ``` fence counts only when a later ``` closes it; an unclosed opening fence's three backticks each become U+02CB;
 *  - outside fenced blocks, an inline span is well-formed only when a backtick is closed by the next backtick on the SAME
 *    line with 1..SLACK_LIMITS.inlineCodeSpanMaxChars (1,000) characters between them; every other backtick (a lone one,
 *    an odd one out, one whose span would cross a line break or exceed the cap) becomes U+02CB;
 *  U+02CB (modifier letter grave accent) is built with String.fromCodePoint(0x02cb) (§0.3 rule 3). Pure, idempotent. */
export function normalizeBackticks(s: string): string {
  const str = typeof s === "string" ? s : "";
  if (!str.includes(BACKTICK)) return str;
  const { stray } = scanCode(str);
  if (stray.length === 0) return str;
  const chars = str.split("");
  for (const i of stray) chars[i] = GRAVE_ACCENT;
  return chars.join("");
}

// --- URL defanging -------------------------------------------------------------------------------

const DOMAIN = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}/;
const URL_LIKE = new RegExp(
  [
    /[a-z][a-z0-9+.-]{1,20}:\/\/[^\s`]+/.source,                                  // (a) scheme://…
    /(?:mailto|tel|sms|slack|javascript|data|file):[^\s`]+/.source,               // (b) the opaque schemes
    /www\.[^\s`]+/.source,                                                        // (c) www.…
    `[a-z0-9_.%+-]+@${DOMAIN.source}`,                                            // (d) local@domain
    // (e) a bare domain at a word boundary, optional /path. The boundary is "no letter or digit next to it" rather than
    // \b, so a domain inside Markdown emphasis (_evil.example_) or after an underscore is still caught.
    `(?<![a-z0-9])${DOMAIN.source}(?![a-z0-9])(?:\\/[^\\s\`]*)?`
  ].join("|"),
  "gi"
);
/** Left outside the span when a token ends with them (")" and "]" only when they don't close an opener in the token). */
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", "\"", "*", "_", "~"]);

const count = (s: string, ch: string) => s.split(ch).length - 1;

function splitTrailing(token: string): [string, string] {
  let end = token.length;
  while (end > 0) {
    const ch = token[end - 1];
    const head = token.slice(0, end);
    if (TRAILING.has(ch) || (ch === ")" && count(head, ")") > count(head, "(")) || (ch === "]" && count(head, "]") > count(head, "["))) {
      end -= 1;
      continue;
    }
    break;
  }
  return [token.slice(0, end), token.slice(end)];
}

function clipChars(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = Math.max(0, max - 1);
  if (cut > 0 && isLowSurrogate(s.charCodeAt(cut)) && isHighSurrogate(s.charCodeAt(cut - 1))) cut -= 1;
  return `${s.slice(0, cut)}…`;
}

/** The [start, end) ranges of s outside every closed fence and well-formed span, in order. */
function textRanges(s: string, regions: CodeRegions): [number, number][] {
  const code = [...regions.fences, ...regions.spans].sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  let cursor = 0;
  for (const [a, b] of code) {
    if (a > cursor) out.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < s.length) out.push([cursor, s.length]);
  return out;
}

/** Outside the code spans and code blocks that normalizeBackticks left well-formed, wrap every URL-like token in a code span (backticks never inside the token):
 *  (a) [a-z][a-z0-9+.-]{1,20}:// followed by [^\s`]+ ; (b) (?:mailto|tel|sms|slack|javascript|data|file):[^\s`]+ ;
 *  (c) www\.[^\s`]+ ; (d) local@domain e-mail tokens ; (e) bare domains: (?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}
 *      at a word boundary, with an optional /path [^\s`]* — case-insensitive. Trailing . , ; : ! ? ) ] are left outside the span.
 *  (Also ' " * _ ~ at the end; ")" and "]" only when unbalanced. A token longer than the span cap is clipped with "…"; a token
 *  touching a backtick gets a space between, so the new span never runs into another.) */
export function defangUrls(s: string): string {
  const str = typeof s === "string" ? s : "";
  if (str.length === 0) return str;
  const ranges = textRanges(str, scanCode(str));
  let out = "";
  let cursor = 0;
  for (const [from, to] of ranges) {
    out += str.slice(cursor, from);
    const piece = str.slice(from, to);
    let last = 0;
    let rebuilt = "";
    for (const m of piece.matchAll(URL_LIKE)) {
      const at = m.index ?? 0;
      const [core, tail] = splitTrailing(m[0]);
      if (core.length === 0) continue;
      const before = from + at - 1 >= 0 ? str[from + at - 1] : "";
      const afterIndex = from + at + core.length;
      const after = tail.length > 0 ? tail[0] : afterIndex < str.length ? str[afterIndex] : "";
      rebuilt += piece.slice(last, at);
      rebuilt += `${before === BACKTICK ? " " : ""}\`${clipChars(core, SLACK_LIMITS.inlineCodeSpanMaxChars)}\`${after === BACKTICK ? " " : ""}`;
      rebuilt += tail;
      last = at + m[0].length;
    }
    out += rebuilt + piece.slice(last);
    cursor = to;
  }
  return out + str.slice(cursor);
}

// --- Markdown → mrkdwn ---------------------------------------------------------------------------

const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const LIST_MARKER = /^([ \t]*)[-*+][ \t]+/;

function inlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "*$1*")
    .replace(/__(?=\S)(.+?)(?<=\S)__/g, "*$1*")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "~$1~");
}

function convertLine(line: string): string {
  const heading = HEADING.exec(line);
  if (heading) {
    const body = heading[1].replace(/\*\*|__/g, "").trim();
    return body.length > 0 ? `*${body}*` : "";
  }
  const listed = line.replace(LIST_MARKER, "$1• ");
  // Inline code is kept as written: only the text between spans is converted.
  return listed
    .split(/(`[^`\n]+`)/)
    .map((part, i) => (i % 2 === 1 ? part : inlineMarkdown(part)))
    .join("");
}

/** Model Markdown → Slack mrkdwn: **x** / __x__ → *x*; ~~x~~ → ~x~; "#… " heading lines → *…*; "- " / "* " / "+ " list
 *  markers → "• "; fenced and inline code kept; images and links are already text (P5b C9). Pure; no escaping. */
export function markdownToMrkdwn(s: string): string {
  const str = typeof s === "string" ? s : "";
  if (str.length === 0) return str;
  const { fences } = scanCode(str);
  const lines = str.split("\n");
  const out: string[] = [];
  let offset = 0;
  for (const line of lines) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    // A line touching a closed fence (a marker on it, or inside the block) is code: kept as written.
    const inCode = fences.some(([a, b]) => a < end + 1 && b > start);
    out.push(inCode ? line : convertLine(line));
  }
  return out.join("\n");
}

/** The pipeline for any text a model, an email or a person wrote:
 *  sanitizeChars → markdownToMrkdwn → normalizeBackticks → defangUrls → escapeMrkdwn. */
export function safeMrkdwn(s: string): string {
  return escapeMrkdwn(defangUrls(normalizeBackticks(markdownToMrkdwn(sanitizeChars(s)))));
}

// --- links ---------------------------------------------------------------------------------------

/** A link's url, escaped, stays well inside a section's 3,000 characters next to its label. */
const LINK_URL_MAX = 2_000;

/** <url|label> only when isAllowedLinkUrl(url) (refs.ts), the scheme is https, and url has no whitespace, "|", "<", ">"
 *  or "`"; & in the url → &amp;; label = escapeMrkdwn(sanitizeChars(label)) clipped to 120 with "…" and its "|" → "¦".
 *  Otherwise null (callers then render the label as plain safe text). */
export function slackLink(url: string | null, label: string): string | null {
  if (typeof url !== "string" || url.length === 0 || url.length > LINK_URL_MAX) return null;
  if (!url.startsWith("https://") || /[\s|<>`]/.test(url)) return null;
  if (!isAllowedLinkUrl(url)) return null;
  let text = sanitizeChars(typeof label === "string" ? label : "").replace(/\s+/g, " ").trim();
  if (text.length === 0) text = new URL(url).hostname;
  text = clipChars(text, SLACK_LIMITS.linkLabelChars).replace(/\|/g, "¦");
  return `<${url.replace(/&/g, "&amp;")}|${escapeMrkdwn(text)}>`;
}

/** A link where one is allowed, else the label as plain safe text: never the text "null". */
function linkOrLabel(url: string | null, label: string): string {
  return slackLink(url, label) ?? safeMrkdwn(label);
}

// --- chunking ------------------------------------------------------------------------------------

/** Split already-escaped mrkdwn into ≤ max-character pieces: prefer "\n\n", then "\n", then " "; never inside an "&…;" entity
 *  and never inside a well-formed inline code span (treated as atomic like an entity; a span is ≤ 1,000 characters, so it
 *  always fits); a piece that ends inside a ``` fence gets a closing fence and the next piece reopens it. */
export function chunkMrkdwn(s: string, max: number = SLACK_LIMITS.sectionSafeChars): string[] {
  const text = typeof s === "string" ? s : "";
  if (text.trim().length === 0) return [];
  const limit = Number.isInteger(max) && max >= 32 ? max : SLACK_LIMITS.sectionSafeChars;
  if (text.length <= limit) return [text];
  const n = text.length;

  // Cut positions p (a piece is text[pos, p)) that fall strictly inside something. Never: an entity, or a fence marker
  // (with the one character next to it, so a piece never ends on a bare opening marker). Only when nothing else fits: an
  // inline span. Inside a fenced block a cut is allowed: that piece closes the fence and the next reopens it.
  const hard = new Uint8Array(n + 1);
  for (const m of text.matchAll(/&#?[a-z0-9]{1,10};/gi)) {
    const a = m.index ?? 0;
    for (let p = a + 1; p < a + m[0].length; p++) hard[p] = 1;
  }
  const regions = scanCode(text, displayedLength);
  const inSpan = new Uint8Array(n + 1);
  const inFence = new Uint8Array(n + 1);
  const fenceEnd = new Int32Array(n + 1);
  for (const [a, b] of regions.spans) for (let p = a + 1; p < b; p++) inSpan[p] = 1;
  for (const [a, b] of regions.fences) {
    for (let p = a + 1; p < Math.min(b, a + 4); p++) hard[p] = 1;
    for (let p = Math.max(a + 1, b - 3); p < b; p++) hard[p] = 1;
    for (let p = a + 4; p <= b - 4; p++) {
      inFence[p] = 1;
      fenceEnd[p] = b;
    }
  }

  const pieces: string[] = [];
  const push = (piece: string) => {
    if (piece.trim().length > 0) pieces.push(piece);
  };
  let pos = 0;
  let reopen = false;
  while (pos < n) {
    const prefix: string = reopen ? FENCE : "";
    const room: number = limit - prefix.length;
    if (n - pos <= room) {
      push(prefix + text.slice(pos));
      break;
    }
    const start: number = pos;
    const end: number = start + room;
    const ok = (p: number, strict: boolean): boolean => {
      if (p <= start || p > end) return false;
      if (hard[p] === 1) return false;
      if (strict && inSpan[p] === 1) return false;
      if (inFence[p] === 1 && p > end - FENCE.length) return false;
      return !(p < n && isLowSurrogate(text.charCodeAt(p)) && isHighSurrogate(text.charCodeAt(p - 1)));
    };
    let cut: { p: number; skip: number } | null = null;
    search: for (const strict of [true, false]) {
      for (const minFill of [Math.floor(room / 2), 1]) {
        for (const sep of ["\n\n", "\n", " "]) {
          for (let i = text.lastIndexOf(sep, end); i > pos; i = text.lastIndexOf(sep, i - 1)) {
            if (i - pos < minFill) break;
            if (ok(i, strict)) {
              cut = { p: i, skip: sep.length };
              break search;
            }
          }
        }
      }
      for (let p = end; p > pos; p--) {
        if (ok(p, strict)) {
          cut = { p, skip: 0 };
          break search;
        }
      }
    }
    if (cut === null) cut = { p: end, skip: 0 };
    const fenced: boolean = inFence[cut.p] === 1;
    // Nothing but whitespace left in the block: close it here and drop its own closing marker, rather than opening an
    // empty block at the top of the next piece.
    if (fenced && text.slice(cut.p + cut.skip, fenceEnd[cut.p] - FENCE.length).trim().length === 0) {
      push(prefix + text.slice(pos, cut.p) + FENCE);
      pos = fenceEnd[cut.p];
      reopen = false;
      continue;
    }
    push(prefix + text.slice(pos, cut.p) + (fenced ? FENCE : ""));
    pos = cut.p + cut.skip;
    reopen = fenced;
  }
  return pieces;
}

// --- blocks --------------------------------------------------------------------------------------

const mrkdwn = (text: string): MrkdwnText => ({ type: "mrkdwn", text, verbatim: true });
const plain = (text: string): PlainText => ({ type: "plain_text", text, emoji: false });
const context = (texts: readonly string[]): SlackBlock => ({ type: "context", elements: texts.map(mrkdwn) });
const divider = (): SlackBlock => ({ type: "divider" });
const parts = (blocks: SlackBlock[]): SlackMessageParts => ({ blocks, text: SLACK_COPY.fallbackText });

/** { type: "section", text: { type: "mrkdwn", text, verbatim: true } }: the only way a section is built. */
export function section(text: string, blockId?: string): SlackBlock {
  return typeof blockId === "string" && blockId.length > 0
    ? { type: "section", block_id: blockId, text: mrkdwn(text) }
    : { type: "section", text: mrkdwn(text) };
}

/** Numbers only (rule 10): {name} → the number, else "—". */
function fillNumbers(template: string, vars: Readonly<Record<string, string | number>> | undefined): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (_whole, name: string) => {
    const v = vars?.[name];
    const num = typeof v === "number" ? v : typeof v === "string" && /^[0-9]{1,12}$/.test(v) ? Number(v) : NaN;
    return Number.isFinite(num) ? Math.round(num).toLocaleString("en-US") : "—";
  });
}

/** A fixed template whose {name} slots take content: the template's own text escaped, each value through safeMrkdwn. */
function fillContent(template: string, values: Readonly<Record<string, string | null>>): string {
  return template
    .split(/(\{[a-zA-Z]+\})/)
    .map((part, i) => {
      if (i % 2 === 0) return escapeMrkdwn(part);
      const raw = values[part.slice(1, -1)];
      const shown = typeof raw === "string" ? safeMrkdwn(clipChars(raw.replace(/\s+/g, " ").trim(), 80)) : "";
      return shown.length > 0 ? shown : "—";
    })
    .join("");
}

/** A DD page as an absolute, allow-listed button url; null when the result isn't allowed. */
function ddUrl(path: string): string | null {
  const url = path.startsWith("https://") ? path : `${appOrigin()}${path}`;
  return isAllowedLinkUrl(url) && url.length <= LINK_URL_MAX ? url : null;
}

function openButton(path: string | null): SlackButton | null {
  const url = path === null ? null : ddUrl(path);
  return url === null ? null : { type: "button", action_id: "ea_open_dd", text: plain(SLACK_COPY.openInDd), url };
}

export function renderPlaceholder(): SlackMessageParts {
  return parts([section(escapeMrkdwn(SLACK_COPY.placeholder))]);
}

export function renderNote(key: SlackNoteKey, vars?: Record<string, string | number>): SlackMessageParts {
  const sentence: string = SLACK_COPY.notes[key] ?? SLACK_COPY.notes.failed;
  return parts([section(escapeMrkdwn(fillNumbers(sentence, vars)))]);
}

// --- answers -------------------------------------------------------------------------------------

const FEEDBACK_MESSAGE_ID = /^ecm_[0-9a-f]{32}$/;

function sourceBlocks(sources: readonly DisplaySource[] | undefined): SlackBlock[] {
  const items: string[] = [];
  (Array.isArray(sources) ? sources : []).forEach((s, i) => {
    if (!s || typeof s !== "object" || !s.source) return;
    const n = Number.isInteger(s.n) && s.n > 0 ? s.n : i + 1;
    const raw = typeof s.source.label === "string" ? s.source.label.replace(/\s+/g, " ").trim() : "";
    const label = raw.length > 0 ? raw : "source";
    const shown = slackLink(typeof s.source.url === "string" ? s.source.url : null, label) ?? safeMrkdwn(clipChars(label, SLACK_LIMITS.linkLabelChars));
    items.push(`[${n}] ${shown}`);
  });
  if (items.length === 0) return [];
  const elements = [`*${escapeMrkdwn(SLACK_COPY.sourcesLabel)}*`, ...items];
  const blocks: SlackBlock[] = [];
  for (let i = 0; i < elements.length; i += SLACK_LIMITS.contextElements) blocks.push(context(elements.slice(i, i + SLACK_LIMITS.contextElements)));
  return blocks;
}

function feedbackBlock(messageId: string): SlackBlock | null {
  if (typeof messageId !== "string" || !FEEDBACK_MESSAGE_ID.test(messageId)) return null;
  const value = `f1.${messageId}`;
  return {
    type: "actions",
    block_id: "ea_fb",
    elements: [
      { type: "button", action_id: "ea_fb_up", text: plain(SLACK_COPY.feedbackUp), value },
      { type: "button", action_id: "ea_fb_down", text: plain(SLACK_COPY.feedbackDown), value }
    ]
  };
}

/** redacted: true (C42's re-render of a redacted answer) → no feedback buttons and no "Thanks, noted." line. */
export function renderAnswer(done: ChatDonePayload, opts: { feedback: 1 | -1 | null; redacted?: boolean }): SlackMessageParts {
  // C10: an answer stopped by the Slack job's own timeout shows the fixed note, never its partial text.
  if (done.status === "aborted") return renderNote("timedOut");
  const redacted = opts?.redacted === true;
  const numbering = new Map<string, number>((Array.isArray(done.sources) ? done.sources : []).map((s) => [s.ref, s.n]));
  const answerText = typeof done.answer === "string" ? done.answer : "";
  const recText = typeof done.recommendations === "string" ? done.recommendations : "";
  const answerChunks = chunkMrkdwn(safeMrkdwn(markersForDisplay(answerText, numbering)));
  const recChunks = recText.trim().length > 0 ? chunkMrkdwn(safeMrkdwn(markersForDisplay(recText, numbering))) : [];

  const content: SlackBlock[] = answerChunks.map((c) => section(c));
  const suggested: SlackBlock[] = recChunks.length > 0 ? [section(`*${escapeMrkdwn(SLACK_COPY.suggested)}*`), ...recChunks.map((c) => section(c))] : [];
  if (content.length === 0 && suggested.length === 0) content.push(section(escapeMrkdwn(SLACK_COPY.notes.unrenderable)));

  const tail: SlackBlock[] = [];
  if (done.saved === false) tail.push(context([escapeMrkdwn(SLACK_COPY.notSaved)]));
  if (!redacted) tail.push(...sourceBlocks(done.sources));
  if (done.status === "complete" && !redacted) {
    if (opts?.feedback === 1 || opts?.feedback === -1) tail.push(context([escapeMrkdwn(SLACK_COPY.feedbackThanks)]));
    else {
      const fb = feedbackBlock(done.messageId);
      if (fb) tail.push(fb);
    }
  }

  // C38: over 50 blocks, drop answer and recommendation pieces from the end and say so, before the sources.
  let body = [...content, ...suggested];
  if (body.length + tail.length > SLACK_LIMITS.blocksPerMessage) {
    const room = Math.max(0, SLACK_LIMITS.blocksPerMessage - tail.length - 1);
    body = body.slice(0, room);
    // A "Suggested" heading left with nothing under it goes too.
    if (suggested.length > 0 && body[body.length - 1] === suggested[0]) body.pop();
    body.push(section(escapeMrkdwn(SLACK_COPY.didntFit)));
  }
  return parts([...body, ...tail]);
}

// --- draft cards ---------------------------------------------------------------------------------

export type DraftCardStatus = keyof typeof SLACK_COPY.draftStatus;
export type ProposalCardStatus = keyof typeof SLACK_COPY.proposalStatus;
export type SlackNoteKey = keyof typeof SLACK_COPY.notes;

const DRAFT_STATUS_OF: Readonly<Record<ExecDraftStatus, DraftCardStatus>> = Object.freeze({
  generating: "drafting",
  generation_failed: "failed",
  draft: "ready",
  saving: "saving",
  saved: "saved",
  sending: "sending",
  sent_pending: "sending",
  sent: "sent",
  sent_external: "sent",
  unknown: "check",
  gone: "gone",
  discarding: "gone",
  discarded: "gone"
});

const draftStatusLine = (status: DraftCardStatus): SlackBlock =>
  context([escapeMrkdwn(SLACK_COPY.draftStatus[status] ?? SLACK_COPY.draftStatus.check)]);

/** True when DD's draft panel would warn about this AI-written draft: the source email looked like it addressed the
 *  assistant (injectionSuspected), or the draft added something unchecked (generationFlags: a link, an amount, another
 *  client's name…). Slack shows neither warning, so such a draft is saved only from DD, next to them (like C15). */
export function draftNeedsDdCheck(view: Pick<DraftView, "injectionSuspected" | "generationFlags"> | null | undefined): boolean {
  if (!view) return false;
  return view.injectionSuspected === true || (Array.isArray(view.generationFlags) && view.generationFlags.length > 0);
}

/** The line under a card left to its own status: a draft that can't be saved from Slack never reads "Ready to save". */
function ownDraftStatus(view: DraftView): DraftCardStatus | null {
  const own = DRAFT_STATUS_OF[view.status] ?? "check";
  if (own !== "ready") return own;
  // A private-refs draft: draftPrivateRefs above already says to check and save it in DD.
  if (view.usesPrivateRefs) return null;
  if (draftNeedsDdCheck(view)) return "checkInDd";
  const caps = view.capabilities;
  if (caps?.canSave !== true) return caps?.draftsUnavailable ? "unavailable" : "checkInDd";
  return "ready";
}

function draftHeaderLine(view: DraftView): string {
  const to = Array.isArray(view.to) ? view.to : [];
  const names = to
    .slice(0, 3)
    .map((r) => safeMrkdwn(clipChars(String(r?.name ?? r?.address ?? "").replace(/\s+/g, " ").trim(), 80)))
    .filter((n) => n.length > 0);
  const recipients = names.length > 0 ? `${names.join(", ")}${to.length > 3 ? ` +${to.length - 3}` : ""}` : "—";
  const rawSubject = view.subject ?? view.threadSubject ?? "";
  const subject = safeMrkdwn(clipChars(String(rawSubject).replace(/\s+/g, " ").trim(), 250));
  return `${escapeMrkdwn("To: ")}${recipients} · ${escapeMrkdwn("Subject: ")}${subject.length > 0 ? subject : "—"}`;
}

export function renderDraftCard(view: DraftView | null, opts: { status?: DraftCardStatus; draftId: string }): SlackMessageParts {
  const blocks: SlackBlock[] = [section(escapeMrkdwn(SLACK_COPY.draftHeader))];
  if (view === null) {
    blocks.push(draftStatusLine(opts?.status ?? "gone"));
    return parts(blocks);
  }
  const id = typeof view.id === "string" && view.id.length > 0 ? view.id : opts?.draftId ?? "";
  const open = id.length > 0 ? openButton(draftPageHref(id)) : null;
  // AM7: a restricted row shows only "hidden" (and Open in DD), whatever status an action result asks for.
  if (view.restricted) {
    blocks.push(draftStatusLine("hidden"));
    if (open) blocks.push({ type: "actions", block_id: "ea_draft", elements: [open] });
    return parts(blocks);
  }
  const status = opts?.status ?? ownDraftStatus(view);

  blocks.push(context([draftHeaderLine(view)]));
  const body = typeof view.bodyText === "string" ? view.bodyText : "";
  if (body.trim().length > 0) {
    const clipped = body.length > SLACK_LIMITS.draftPreviewChars;
    const preview = clipChars(body, SLACK_LIMITS.draftPreviewChars);
    for (const chunk of chunkMrkdwn(safeMrkdwn(preview))) blocks.push(section(chunk));
    if (clipped) blocks.push(context([escapeMrkdwn(SLACK_COPY.draftPreviewClipped)]));
  }
  const note = typeof view.noteForMitchell === "string" ? safeMrkdwn(clipChars(view.noteForMitchell.trim(), 500)) : "";
  if (note.length > 0) blocks.push(context([note]));
  // C15: a private-refs draft is checked and saved in DD, next to its full body; Slack offers no Save for it.
  if (view.usesPrivateRefs) blocks.push(context([escapeMrkdwn(SLACK_COPY.draftPrivateRefs)]));
  if (status !== null) blocks.push(draftStatusLine(status));

  const value = `d1.${view.id}.${view.version}`;
  const valued = SLACK_VALUE_RE.draft.test(value);
  const caps = view.capabilities;
  const buttons: SlackButton[] = [];
  // C15 and DD's draft warnings: no Save from Slack for a private-refs draft or one DD would warn about.
  if (valued && caps?.canSave === true && view.usesPrivateRefs !== true && !draftNeedsDdCheck(view)) {
    buttons.push({ type: "button", action_id: "ea_draft_save", text: plain(SLACK_COPY.draftSave), value, style: "primary" });
  }
  if (valued && caps?.canRegenerate === true) buttons.push({ type: "button", action_id: "ea_draft_regen", text: plain(SLACK_COPY.draftRegenerate), value });
  if (valued && (view.status === "generating" || view.status === "saving")) {
    buttons.push({ type: "button", action_id: "ea_card_refresh", text: plain(SLACK_COPY.draftRefresh), value });
  }
  if (open) buttons.push(open);
  if (buttons.length > 0) blocks.push({ type: "actions", block_id: "ea_draft", elements: buttons });
  return parts(blocks);
}

// --- proposal cards ------------------------------------------------------------------------------

const PROPOSAL_STATUS_OF: Readonly<Record<ProposalView["status"], ProposalCardStatus | null>> = Object.freeze({
  pending: null,
  confirming: "creating",
  confirmed: "created",
  dismissed: "dismissed",
  withdrawn: "removed",
  expired: "expired"
});

function proposalStatusLine(status: ProposalCardStatus, view: ProposalView | null): SlackBlock {
  let text = escapeMrkdwn(SLACK_COPY.proposalStatus[status] ?? SLACK_COPY.proposalStatus.failed);
  if (status === "created" && view && typeof view.taskHref === "string" && view.taskHref.length > 0) {
    const link = slackLink(ddUrl(view.taskHref), SLACK_COPY.openTask);
    if (link) text += ` ${link}`;
  }
  return context([text]);
}

export function renderProposalCard(view: ProposalView | null, opts: { status?: ProposalCardStatus; proposalId: string }): SlackMessageParts {
  const blocks: SlackBlock[] = [section(escapeMrkdwn(SLACK_COPY.proposalHeader))];
  if (view === null) {
    blocks.push(proposalStatusLine(opts?.status ?? "removed", null));
    return parts(blocks);
  }
  // A withdrawn or redacted proposal shows neither its title nor its description, whatever the status (C20).
  if (view.redacted || view.status === "withdrawn") {
    blocks.push(proposalStatusLine("removed", view));
    return parts(blocks);
  }
  const status = opts?.status ?? PROPOSAL_STATUS_OF[view.status] ?? null;

  for (const chunk of chunkMrkdwn(safeMrkdwn(typeof view.title === "string" ? view.title : ""))) blocks.push(section(chunk));
  for (const chunk of chunkMrkdwn(safeMrkdwn(typeof view.description === "string" ? view.description : ""))) blocks.push(section(chunk));
  blocks.push(
    context([
      fillContent(SLACK_COPY.proposalFields, {
        assignee: view.assigneeName,
        department: view.departmentName,
        client: view.clientName,
        priority: view.priority,
        due: view.dueOn
      })
    ])
  );
  if (view.privacyNotice) blocks.push(context([escapeMrkdwn(PROPOSAL_PRIVACY_NOTICE)]));
  if (status !== null) blocks.push(proposalStatusLine(status, view));

  // Buttons only on a pending proposal, and only while no action result other than "changed" is shown.
  const showButtons = view.status === "pending" && (opts?.status === undefined || opts.status === "changed");
  const value = `t1.${view.id}.${view.contentHash}`;
  if (showButtons && SLACK_VALUE_RE.proposal.test(value)) {
    blocks.push({
      type: "actions",
      block_id: "ea_task",
      elements: [
        { type: "button", action_id: "ea_task_create", text: plain(SLACK_COPY.proposalCreate), value, style: "primary" },
        { type: "button", action_id: "ea_task_dismiss", text: plain(SLACK_COPY.proposalDismiss), value }
      ]
    });
  }
  return parts(blocks);
}

// --- App Home ------------------------------------------------------------------------------------

/** P8 (§3.21.3, K13; stage-0 seed): the App Home's brief line. state keys BRIEF_COPY.home; time and tz fill homeSchedule
 *  ("Daily at {time} ({tz})"); sentAt is the formatted send time BRIEF_COPY.home.delivered shows, or null. */
export interface OwnerHomeBrief { state: keyof typeof BRIEF_COPY.home; time: string; tz: string; sentAt: string | null }

export interface OwnerHomeInput {
  /** aiAssessed (additive): the item is a model's reading (P5a's DDTEXT_AI_KINDS), labelled as the web labels it. */
  attention: { ok: true; items: { band: "critical" | "high" | "normal"; title: string; href: string; aiAssessed?: boolean }[]; hiddenEmail: number; emailScreen: "ok" | "none" | "unavailable" } | { ok: false };
  email: { state: "off" | "no_pin" } | { state: "on"; counts: { reply: number; urgent: number; important: number; waiting: number } | null; restricted: number | null };
  updatedAt: string; timezone: string;
  /** P8 (§3.21.3; stage-0 seed, OPTIONAL so P6's literals compile, p8-bindings.md AM-P8-15): absent or null renders
   *  SLACK_COPY.homeBrief as before. Area D renders BRIEF_COPY.home[state] + the schedule context in its place. */
  brief?: OwnerHomeBrief | null;
}

/** "Nov 7, 3:04 PM EST" in his zone (UTC when the zone is unknown); null for a bad timestamp. */
function formatUpdated(iso: string, timezone: string): string | null {
  const ms = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return null;
  const format = (timeZone: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(ms));
  try {
    return format(typeof timezone === "string" && timezone.length > 0 ? timezone : "UTC");
  } catch {
    try {
      return format("UTC");
    } catch {
      return null;
    }
  }
}

/** P8 (§3.21.3, K13): the brief's state line (BRIEF_COPY.home[state], {time} = the send time) and its schedule context; null (the
 *  Home job couldn't read the brief line) → SLACK_COPY.homeBrief as before. Fixed copy and short labels only, all escaped. */
function homeBriefBlocks(brief: OwnerHomeBrief | null): SlackBlock[] {
  const state = brief?.state;
  if (brief === null || typeof state !== "string" || !Object.prototype.hasOwnProperty.call(BRIEF_COPY.home, state)) {
    return [section(escapeMrkdwn(SLACK_COPY.homeBrief))];
  }
  const label = (v: unknown) => clipChars(sanitizeChars(typeof v === "string" ? v : "").replace(/\s+/g, " ").trim(), 40);
  const sentAt = label(brief.sentAt);
  const line = fillBrief(BRIEF_COPY.home[state], { time: sentAt.length > 0 ? sentAt : "—" });
  const out: SlackBlock[] = [section(escapeMrkdwn(line))];
  const time = label(brief.time);
  const tz = label(brief.tz);
  if (time.length > 0 && tz.length > 0) out.push(context([escapeMrkdwn(fillBrief(BRIEF_COPY.homeSchedule, { time, tz }))]));
  return out;
}

export function renderOwnerHome(input: OwnerHomeInput): SlackHomeView {
  const blocks: SlackBlock[] = [
    { type: "header", text: plain(SLACK_COPY.homeHeader) },
    section(escapeMrkdwn(SLACK_COPY.ask)),
    divider(),
    section(escapeMrkdwn(SLACK_COPY.homeNeedsYou))
  ];
  const attention = input?.attention;
  if (attention && attention.ok === true) {
    const items = (Array.isArray(attention.items) ? attention.items : []).slice(0, SLACK_LIMITS.homeItems);
    for (const item of items) {
      const band = SLACK_COPY.bandLabels[item.band] ?? SLACK_COPY.bandLabels.normal;
      const title = safeMrkdwn(clipChars(String(item.title ?? "").replace(/\s+/g, " ").trim(), 200));
      // A model's reading is labelled in the text, never shown as a record fact (P5a's AI-assessed label).
      const basis = item.aiAssessed === true ? ` · _${escapeMrkdwn(SLACK_COPY.aiAssessed)}_` : "";
      blocks.push(section(`*${escapeMrkdwn(band)}* · ${title.length > 0 ? title : "—"}${basis} · ${linkOrLabel(item.href, SLACK_COPY.openInDd)}`));
    }
    if (items.length === 0) blocks.push(section(escapeMrkdwn(SLACK_COPY.homeNothing)));
    if (typeof attention.hiddenEmail === "number" && attention.hiddenEmail > 0) {
      blocks.push(context([escapeMrkdwn(fillNumbers(SLACK_COPY.homeHiddenEmail, { n: attention.hiddenEmail }))]));
    }
    if (attention.emailScreen === "unavailable") blocks.push(context([escapeMrkdwn(SLACK_COPY.homeEmailUnavailable)]));
  } else {
    blocks.push(section(escapeMrkdwn(SLACK_COPY.homeAttentionFailed)));
  }

  blocks.push(divider(), section(escapeMrkdwn(SLACK_COPY.homeEmail)));
  const email = input?.email;
  if (email && email.state === "on") {
    blocks.push(section(escapeMrkdwn(email.counts ? fillNumbers(SLACK_COPY.homeEmailCounts, email.counts) : SLACK_COPY.homeEmailCountsFailed)));
    if (typeof email.restricted === "number" && email.restricted > 0) {
      // K12: restricted-sender mail appears only as a count, with a link into DD.
      blocks.push(
        section(`${escapeMrkdwn(fillNumbers(SLACK_COPY.restrictedCount, { n: email.restricted }))} ${linkOrLabel(`${appOrigin()}/executive/email`, SLACK_COPY.openDd)}`)
      );
    }
  } else {
    blocks.push(section(escapeMrkdwn(SLACK_COPY.homeEmailOff)));
  }

  blocks.push(divider(), ...homeBriefBlocks(input?.brief ?? null));
  const updated = formatUpdated(input?.updatedAt, input?.timezone);
  if (updated !== null) blocks.push(context([escapeMrkdwn(SLACK_COPY.homeUpdated.replace("{time}", updated))]));
  return { type: "home", blocks: blocks.slice(0, SLACK_LIMITS.blocksPerHome) };
}

export function renderNeutralHome(): SlackHomeView {
  return { type: "home", blocks: [section(escapeMrkdwn(SLACK_COPY.neutralHome))] };
}
