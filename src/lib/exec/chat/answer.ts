import type { RefEntry } from "@/lib/exec/agent/types";
import { markerRefs, validateMarkers } from "@/lib/exec/chat/markers";

// Model answer text (P5b contract §3.13; Area C; pure, client-safe): link
// neutralizing (C9, §3.13.1), staged-task text (C42), the "Suggested next
// steps" splitter (C10, §3.13.3) and the finishing pipeline. Markers live in
// chat/markers.ts (bindings AM16: the split between the two files).
//
// The model can't mint links (B3): every link form in its text is made inert
// here, on the server, before anything is stored or sent; the only links chat
// shows are the source chips built from server-issued refs.

/** Stored answer limits (§2.1 CHECKs: text ≤ 40,000, recommendations ≤ 8,000; C11). */
export const ANSWER_MAX_CHARS = 40_000;
export const RECOMMENDATIONS_MAX_CHARS = 8_000;
/** At most this many distinct refs are cited by one answer (the sources CHECK, ≤ 60). */
export const MAX_CITED_REFS = 60;
/** What a clip leaves at the cut (P5a's marker text, built here: chat/** can't import text/untrusted). */
export const ANSWER_CLIP_MARKER = ` ${String.fromCharCode(0x2026)}[clipped]`;

const MARKER_ONLY = /^r\d{1,5}$/;
// One level of nested brackets in link text ("[a [b] c](url)"), any destination with one level of parens. An escaped
// bracket or paren ("\]") is a character, never the end; an escaped "[" or "!" starts nothing.
const LINK_TEXT = String.raw`\[((?:[^\[\]\\]|\\[\s\S]|\[(?:[^\[\]\\]|\\[\s\S])*\])*)\]`;
const LINK_DEST = String.raw`\((?:[^()\\]|\\[\s\S]|\((?:[^()\\]|\\[\s\S])*\))*\)`;
const IMAGE = new RegExp(String.raw`(?<!\\)!` + LINK_TEXT + LINK_DEST, "g");
const INLINE_LINK = new RegExp(String.raw`(?<!\\)` + LINK_TEXT + LINK_DEST, "g");
const REFERENCE_DEFINITION = /^ {0,3}\[(?:[^\]\\]|\\[\s\S])+\]:[ \t]*\S.*(?:\r?\n|$)/gm;
const SCHEME_AUTOLINK = /(?<!\\)<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>`|]*)>/g;
const EMAIL_AUTOLINK = /(?<!\\)<([^\s<>@`|]+@[^\s<>@`|]+)>/g;
// An autolink ("<scheme:...>", "<mail>") then every GFM autolink literal (http/https, www., a mail address, which
// also covers mailto: and xmpp:) and any other "scheme://" text. None holds a backtick (it would end the code span it
// goes in) or a pipe (a table cell splits there). The scheme (at most 32 characters, as for an autolink) and the
// address's local part are bounded so a long run of letters stays linear; what precedes a bounded match is a plain run
// that can't link on its own.
const LINK_LITERAL = String.raw`[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s<>${"`"}|]*|www\.[^\s<>${"`"}|]*|[-.\w+]{1,64}@[-\w]+(?:\.[-\w]+)+`;
const LINK_FORM = new RegExp(String.raw`(?<!\\)<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>${"`"}|]*|[^\s<>@${"`"}|]+@[^\s<>@${"`"}|]+)>|${LINK_LITERAL}`, "gi");
/** Bare URLs in a title: http/https, www. and any "scheme://" (a title is plain text, so a mail address stays as it is). */
const TITLE_URL = /[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s<>`|]*|www\.[^\s<>`|]*/gi;
const URL_TRAILING = /[.,;:!?)\]}'"*_~]+$/;
/** CommonMark's escapable characters (ASCII punctuation): a backslash before one makes it literal. */
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
/** An HTML character reference: markdown decodes it into the text the GFM autolink transform then reads. */
const CHAR_REFERENCE = /^&(?:#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/;
/** The punctuation a link literal's scheme, host or address is made of; an escape of one is undone (see inertPlain). */
const LINK_PUNCT: ReadonlySet<string> = new Set([":", "/", ".", "@", "-", "+", "_"]);

/** A backtick fence opener or closer: up to 3 spaces, then 3+ backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** True when the line opens a fence: a backtick fence whose info string holds a backtick doesn't (CommonMark 4.5). */
function opensFence(line: string, m: RegExpExecArray): boolean {
  return !(m[1][0] === "`" && line.slice(line.indexOf(m[1]) + m[1].length).includes("`"));
}

/**
 * Applies fn to the runs of whole lines outside fenced code blocks, leaving the
 * fences exactly as they are.
 */
function mapOutsideFences(text: string, fn: (s: string) => string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let plain: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  const flushPlain = () => {
    if (plain.length > 0) out.push(fn(plain.join("\n")));
    plain = [];
  };
  for (const line of lines) {
    const m = FENCE.exec(line);
    if (fence === null) {
      if (m && opensFence(line, m)) {
        flushPlain();
        fence = { ch: m[1][0], len: m[1].length };
        out.push(line);
      } else {
        plain.push(line);
      }
    } else {
      out.push(line);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && line.trim().replace(/[`~]/g, "") === "") fence = null;
    }
  }
  flushPlain();
  return out.join("\n");
}

/** mapOutsideFences, and inside the runs fn sees only the text outside inline code spans. */
function mapOutsideCode(text: string, fn: (s: string) => string): string {
  return mapOutsideFences(text, (s) => mapInline(s, fn));
}

/** Inline code spans: a run of n backticks up to the next run of exactly n. Unmatched runs are plain text. */
function mapInline(text: string, fn: (s: string) => string): string {
  let out = "";
  let plainStart = 0;
  let i = 0;
  while (i < text.length) {
    // An escaped character outside code is literal: "\`" opens no code span.
    if (text[i] === "\\" && i + 1 < text.length && ASCII_PUNCT.test(text[i + 1])) {
      i += 2;
      continue;
    }
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    let n = 0;
    while (text[i + n] === "`") n += 1;
    let j = i + n;
    let close = -1;
    while (j < text.length) {
      if (text[j] === "`") {
        let k = 0;
        while (text[j + k] === "`") k += 1;
        if (k === n) {
          close = j;
          break;
        }
        j += k;
      } else {
        j += 1;
      }
    }
    if (close === -1) {
      i += n;
      continue;
    }
    out += fn(text.slice(plainStart, i)) + text.slice(i, close + n);
    i = close + n;
    plainStart = i;
  }
  return out + fn(text.slice(plainStart));
}

/** Steps (1)-(3) of §3.13.1, repeated until nothing changes (a replacement can leave a new link: "[[a](b)](c)"). */
function convertLinkSyntax(text: string): string {
  let t = text;
  for (;;) {
    const next = t
      // (1) images → their alt text
      .replace(IMAGE, (_w, alt: string) => alt)
      // (2) inline links → their text, or the marker when the text is exactly one
      .replace(INLINE_LINK, (_w, label: string) => {
        const inner = label.trim();
        return MARKER_ONLY.test(inner) ? `[${inner}]` : label;
      })
      // (3) reference definitions → removed (the line goes)
      .replace(REFERENCE_DEFINITION, "");
    if (next === t) return t;
    t = next;
  }
}

/** One plain stretch of a line (no code span in it): autolinks and link literals into code spans, the rest inert. */
function inertPlain(seg: string, afterSpan: boolean, beforeSpan: boolean): string {
  // The GFM autolink transform reads the text after escapes are undone, so "https:\//x" or "www\.x" is still a link:
  // undo those escapes first, so the literal is found and wrapped.
  let s = "";
  for (let i = 0; i < seg.length; i += 1) {
    if (seg[i] === "\\" && i + 1 < seg.length && ASCII_PUNCT.test(seg[i + 1])) {
      s += LINK_PUNCT.has(seg[i + 1]) ? seg[i + 1] : seg[i] + seg[i + 1];
      i += 1;
    } else {
      s += seg[i];
    }
  }
  let out = "";
  let last = 0;
  for (const m of s.matchAll(LINK_FORM)) {
    const start = m.index ?? 0;
    // An autolink keeps its inner text; a literal loses its trailing punctuation, which stays plain text.
    const tail = m[1] !== undefined ? "" : (URL_TRAILING.exec(m[0])?.[0] ?? "");
    const core = m[1] !== undefined ? m[1] : m[0].slice(0, m[0].length - tail.length);
    if (core === "") continue;
    out += inertText(s.slice(last, start), true);
    // A backtick next to the span would join its run and change which runs pair up.
    if (out.endsWith("`") || (out === "" && afterSpan)) out += " ";
    out += `\`${core}\``;
    last = start + m[0].length - tail.length;
    if (last === s.length && beforeSpan) out += " ";
  }
  return out + inertText(s.slice(last), false);
}

/** Escapes what could still make a link or an image, or change where code spans are: "](", "]:", "<" (autolinks,
 *  HTML), a character reference ("https&#58;//x" decodes into a link literal), a backtick no code span pairs. Escape
 *  pairs are kept; a lone backslash right before a span this code adds is doubled, so it can't escape the backtick. */
function inertText(s: string, beforeInsert: boolean): string {
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "\\") {
      if (i + 1 < s.length && ASCII_PUNCT.test(s[i + 1])) {
        out += ch + s[i + 1];
        i += 1;
      } else {
        out += i === s.length - 1 && beforeInsert ? "\\\\" : ch;
      }
    } else if (ch === "]" && (s[i + 1] === "(" || s[i + 1] === ":")) {
      out += "\\]";
    } else if (ch === "<" || ch === "`" || (ch === "&" && CHAR_REFERENCE.test(s.slice(i)))) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Markdown that react-markdown + remark-gfm render with no link and no image, whatever its block structure (C9, C42,
 * b-security-1). Line by line: a code span is kept only when its closing run is on the same line and it holds no "|"
 * (a table cell would split it); every other backtick is escaped, so the kept spans are exactly the code markdown
 * sees. A backtick fence never opens here (its run is escaped); a tilde fence or an indented block only shows the
 * escapes. Outside the kept spans, autolinks and link literals go into code spans and inertText escapes the rest:
 * with "](" and "]:" escaped no inline link or image closes and no definition exists, so no reference link or
 * footnote resolves. Idempotent.
 */
function inertMarkdown(text: string): string {
  return text
    .split(/(\r\n|\r|\n)/)
    .map((part, idx) => (idx % 2 === 1 ? part : inertLine(part)))
    .join("");
}

function inertLine(line: string): string {
  let out = "";
  let plainStart = 0;
  let afterSpan = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\") {
      i += i + 1 < line.length && ASCII_PUNCT.test(line[i + 1]) ? 2 : 1;
      continue;
    }
    if (ch !== "`") {
      i += 1;
      continue;
    }
    let n = 0;
    while (line[i + n] === "`") n += 1;
    // The closer: the next run of exactly n backticks (a backslash is literal inside a span).
    let close = -1;
    let j = i + n;
    while (j < line.length) {
      if (line[j] !== "`") {
        j += 1;
        continue;
      }
      let k = 0;
      while (line[j + k] === "`") k += 1;
      if (k === n) {
        close = j;
        break;
      }
      j += k;
    }
    if (close === -1 || line.slice(i + n, close).includes("|")) {
      i += n;
      continue;
    }
    out += inertPlain(line.slice(plainStart, i), afterSpan, true) + line.slice(i, close + n);
    i = close + n;
    plainStart = i;
    afterSpan = true;
  }
  return out + inertPlain(line.slice(plainStart), afterSpan, false);
}

/** C9: every link form inert (order §3.13.1): images → alt text, inline links → their text ("[r12](x)" → "[r12]"),
 *  definitions removed, then outside fenced code inertMarkdown (autolinks, URLs and mail addresses into code spans;
 *  "](", "]:", "<", character references and unpaired backticks escaped). Markers survive. */
export function neutralizeLinks(text: string): string {
  return mapOutsideFences(convertLinkSyntax(String(text ?? "")), inertMarkdown);
}

/** Raw HTML comments, declarations, processing instructions and tags (closed or cut off at the end of the text), until
 *  none is left (removing one can join a new one: "<<b>b>"). An escaped "<" is text. */
function stripMarkup(text: string): string {
  let t = text;
  for (;;) {
    const next = t
      .replace(/(?<!\\)<!--[\s\S]*?(?:-->|$)/g, "")
      .replace(/(?<!\\)<[!?][^>]*(?:>|$)/g, "")
      .replace(/(?<!\\)<\/?[A-Za-z][^>]*(?:>|$)/g, "");
    if (next === t) return t;
    t = next;
  }
}

const LINE_SEPARATORS = new RegExp(`\\r\\n|\\r|\\n|${String.fromCharCode(0x2028)}|${String.fromCharCode(0x2029)}`, "g");

function wrapTitleUrls(s: string): string {
  return s.replace(SCHEME_AUTOLINK, "`$1`").replace(EMAIL_AUTOLINK, "`$1`").replace(TITLE_URL, (url) => {
    const tail = URL_TRAILING.exec(url)?.[0] ?? "";
    const core = tail ? url.slice(0, url.length - tail.length) : url;
    return core.length === 0 ? url : `\`${core}\`${tail}`;
  });
}

/**
 * C42 (b-security-1). A description: link syntax converted, raw HTML removed, then inertMarkdown over all of it (DD's
 * task page renders it with MarkdownBody, react-markdown + remark-gfm), so no link or image can render. A title (DD
 * shows it as plain text): link syntax converted, autolinks and URLs into code spans, raw HTML removed, every line
 * break → a space. Trimmed; idempotent. Used by propose_task before the insert and by the confirm before the tasks
 * insert.
 */
export function neutralizeTaskText(text: string, kind: "title" | "description"): string {
  let t = String(text ?? "");
  if (kind === "title") return stripMarkup(mapOutsideCode(convertLinkSyntax(t), wrapTitleUrls)).replace(LINE_SEPARATORS, " ").trim();
  // Every pass ends inert. An escape the pass adds can let the next pass's link syntax reach further ("[a]:" became
  // "[a\]:"), so repeat until the text is stable: the confirm, which applies this again, then inserts the same text.
  for (let pass = 0; pass < MAX_NEUTRALIZE_PASSES; pass += 1) {
    const next = inertMarkdown(stripMarkup(convertLinkSyntax(t))).trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

/** Passes before neutralizeTaskText stops looking for a fixpoint (each pass's output is already inert). */
const MAX_NEUTRALIZE_PASSES = 8;

/** The first n UTF-16 units of s, never ending on the first half of a surrogate pair (Postgres's json refuses a lone half). */
export function clipUnits(s: string, n: number): string {
  const limit = Math.max(0, Math.floor(n));
  if (s.length <= limit) return s;
  const code = s.charCodeAt(limit - 1);
  return s.slice(0, limit > 0 && code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit);
}

/** s with every lone surrogate replaced by U+FFFD, as TextEncoder does. */
export function wellFormedText(s: string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
    if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      i += 1;
      continue;
    }
    out += s.slice(from, i) + String.fromCharCode(0xfffd);
    from = i + 1;
  }
  return from === 0 ? s : out + s.slice(from);
}

/**
 * A staged task's text, fitted to max (C42, C46): masked, neutralized, masked again (removing markup can join a label
 * and its value) and neutralized last, so the stored text is inert; then, when too long, clipped without splitting a
 * surrogate pair and neutralized again (a clip can cut a code span open), until it fits.
 */
export function stagedTaskText(raw: string, kind: "title" | "description", max: number, mask: (s: string) => string): string {
  let t = neutralizeTaskText(mask(neutralizeTaskText(mask(wellFormedText(String(raw ?? ""))), kind)), kind);
  let budget = Math.max(0, Math.floor(max));
  while (t.length > max && budget > 0) {
    t = neutralizeTaskText(clipUnits(t, budget), kind);
    budget -= Math.max(1, t.length - max);
  }
  return t.length > max ? "" : t;
}

const HEADING = /^\s*(?:#{1,3}\s*)?(?:\*\*|__)?\s*suggested next steps\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;

/** C10: split at the last "Suggested next steps" heading line. */
export function splitAnswer(text: string): { answer: string; recommendations: string } {
  const lines = String(text ?? "").split("\n");
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (HEADING.test(lines[i])) {
      at = i;
      break;
    }
  }
  if (at === -1) return { answer: lines.join("\n").trim(), recommendations: "" };
  return { answer: lines.slice(0, at).join("\n").trim(), recommendations: lines.slice(at + 1).join("\n").trim() };
}

/** Clip to at most max characters, the marker included; never splits a surrogate pair. */
export function clipAnswerText(s: string, max: number): string {
  const limit = Math.max(0, Math.floor(max));
  if (s.length <= limit) return s;
  if (limit <= ANSWER_CLIP_MARKER.length) return s.slice(0, limit);
  let cut = limit - ANSWER_CLIP_MARKER.length;
  const code = s.charCodeAt(cut);
  if (cut > 0 && code >= 0xdc00 && code <= 0xdfff) cut -= 1;
  return s.slice(0, cut) + ANSWER_CLIP_MARKER;
}

/** A marker or a marker group (markers.ts's MARKER_GROUP). */
const MARKER_GROUP_ANY = /\[(r\d{1,5}(?:\s*,\s*r\d{1,5})*)\]/g;

/** The whole pipeline: neutralizeLinks → validateMarkers (refs.citable) → splitAnswer → clip (answer 40,000 − reserveChars,
 *  recommendations 8,000) → at most 60 cited refs (later markers removed and counted as unknown). reserveChars leaves room
 *  for a note the caller appends (C11, b-agent-5). */
export function finalizeAnswer(raw: string, refs: { citable(ref: string): RefEntry | null }, opts?: { reserveChars?: number }): {
  answer: string; recommendations: string; cited: RefEntry[]; unknownMarkers: number } {
  const reserve = Math.max(0, Math.floor(opts?.reserveChars ?? 0));
  const isCitable = (ref: string): boolean => {
    try {
      return refs.citable(ref) !== null;
    } catch {
      return false;
    }
  };
  const validated = validateMarkers(neutralizeLinks(String(raw ?? "")), isCitable);
  let unknownMarkers = validated.unknown;
  const split = splitAnswer(validated.text);
  const clipped = {
    answer: clipAnswerText(split.answer, ANSWER_MAX_CHARS - reserve),
    recommendations: clipAnswerText(split.recommendations, RECOMMENDATIONS_MAX_CHARS)
  };
  // At most 60 distinct refs, by first use over the answer then the recommendations; later ones removed and counted.
  const keep = new Set<string>();
  for (const ref of [...markerRefs(clipped.answer), ...markerRefs(clipped.recommendations)]) {
    if (keep.size >= MAX_CITED_REFS) break;
    keep.add(ref);
  }
  // Removing a marker can join the text around it into a new one ("[r61[r62]]" → "[r61]"), so prune until nothing
  // changes: every marker left is then a single kept ref, and the text and `cited` agree.
  const prune = (s: string) => {
    let cur = s;
    for (;;) {
      const next = cur.replace(MARKER_GROUP_ANY, (_whole, inner: string) => {
        let kept = "";
        for (const ref of inner.split(",").map((x) => x.trim())) {
          if (keep.has(ref)) kept += `[${ref}]`;
          else unknownMarkers += 1;
        }
        return kept;
      });
      if (next === cur) return cur;
      cur = next;
    }
  };
  const answer = prune(clipped.answer);
  const recommendations = prune(clipped.recommendations);
  const cited: RefEntry[] = [];
  const seen = new Set<string>();
  for (const ref of [...markerRefs(answer), ...markerRefs(recommendations)]) {
    if (seen.has(ref) || !keep.has(ref)) continue;
    if (cited.length >= MAX_CITED_REFS) break;
    seen.add(ref);
    let entry: RefEntry | null = null;
    try {
      entry = refs.citable(ref);
    } catch {
      entry = null;
    }
    if (entry) cited.push(entry);
  }
  return { answer, recommendations, cited, unknownMarkers };
}
