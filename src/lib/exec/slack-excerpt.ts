import { SLACK_LIMITS } from "@/lib/exec/slack-types";

// P6: the K12 verbatim clip behind X1 (contract §3.6.3, C27, reuse-6; Area B;
// pure: the one import is P6's pure constants). run.ts calls it on a Slack
// turn for the answer, the recommendations and a staged task's text, with
// corpus = the text of every tool-result block the turn produced. The model
// reads mail as it does on the web and may summarize it (K12); what it may
// not do on Slack is copy more than 300 characters of any tool result word
// for word. Paraphrase and summaries pass untouched.
//
// Matching runs on a whitespace-normalized view of both sides (every run of
// Unicode whitespace becomes one space), with an index map back to the
// text's own positions, so a quote whose line breaks the model joined still
// matches and the output keeps the text's own characters before the cut.
//
// The index is built from the TEXT (an answer is at most tens of thousands of
// characters), and the corpus is streamed past it with a rolling hash, every
// hit confirmed character by character. Memory is bounded by the text, not by
// the corpus, so the whole turn's tool output is checked: a heavy turn's
// late email bodies (the ones an answer is most likely to quote) are never
// skipped. The only bound on the corpus is a CPU guard far above what a turn
// can produce (12 model calls x 8 tools); past it the OLDEST entries are the
// ones left out (entries are read newest first) and `capped` is true.

const WINDOW = 40;
/** A CPU guard, not a working limit: 8,000,000 characters is several times a turn's maximum tool output. */
const CORPUS_MAX_CHARS = 8_000_000;
const ELLIPSIS = " […]";
/** The rolling hash's base (odd) and BASE^(WINDOW-1) mod 2^32. */
const BASE = 0x01000193;
const TOP = (() => {
  let p = 1;
  for (let i = 0; i < WINDOW - 1; i++) p = Math.imul(p, BASE);
  return p;
})();

/** The characters JavaScript's \s matches, by code unit (a lookup per character, no regex per character). */
function isWhitespace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) || c === 0x20 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff
  );
}
const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** s with every whitespace run collapsed to one space, and (when asked) each output position's index in s. */
function normalize(s: string, withMap: boolean): { text: string; map: number[] } {
  // Without a map (the corpus side, possibly megabytes), the native replace: \s is exactly isWhitespace's set.
  if (!withMap) return { text: s.replace(/\s+/g, " "), map: [] };
  const out: string[] = [];
  const map: number[] = [];
  let inSpace = false;
  for (let i = 0; i < s.length; i++) {
    if (isWhitespace(s.charCodeAt(i))) {
      if (!inSpace) {
        out.push(" ");
        if (withMap) map.push(i);
        inSpace = true;
      }
      continue;
    }
    inSpace = false;
    out.push(s[i]);
    if (withMap) map.push(i);
  }
  return { text: out.join(""), map };
}

function wholeOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback;
}

/** The rolling hash of s[from, from + WINDOW) (uint32). */
function hashAt(s: string, from: number): number {
  let h = 0;
  for (let k = 0; k < WINDOW; k++) h = (Math.imul(h, BASE) + s.charCodeAt(from + k)) >>> 0;
  return h;
}

/** a[i, i + WINDOW) === b[j, j + WINDOW), without building either substring. */
function sameWindow(a: string, i: number, b: string, j: number): boolean {
  for (let k = 0; k < WINDOW; k++) if (a.charCodeAt(i + k) !== b.charCodeAt(j + k)) return false;
  return true;
}

/** Clip every verbatim run of `text` that also occurs in one of `corpus` and is longer than maxRun characters.
 *  Matching is on a whitespace-normalized view (every run of Unicode whitespace → one space, both sides), with an index map
 *  back to `text`'s positions, so a quote whose line breaks the model joined still matches. A run is found with shingles:
 *  every 40-character window of the normalized text is indexed by a rolling hash, each normalized corpus entry is streamed
 *  past the index (a hit is confirmed character by character, so a hash collision never matches), and consecutive matching
 *  windows of the normalized text form a run of length (windows + 39). Windows never span two entries. The whole corpus is
 *  read, newest entry first; only past a CPU guard of 8,000,000 characters are the oldest entries left out (`capped` true).
 *  For a run longer than maxRun, the first keep characters stay and the rest of the run is replaced by " […]" (U+2026 written
 *  as the literal character "…"). Never throws; text with no run comes back identical. */
export function clipVerbatimRuns(text: string, corpus: readonly string[], opts?: { maxRun?: number /* 300 */; keep?: number /* 280 */ }):
  { text: string; clipped: number; capped: boolean } {
  const source = typeof text === "string" ? text : "";
  try {
    const entries = Array.isArray(corpus) ? corpus.filter((c): c is string => typeof c === "string" && c.length > 0) : [];
    const total = entries.reduce((n, c) => n + c.length, 0);
    const capped = total > CORPUS_MAX_CHARS;
    const maxRun = Math.max(1, wholeOr(opts?.maxRun, SLACK_LIMITS.verbatimRunChars));
    const keep = Math.min(maxRun, wholeOr(opts?.keep, SLACK_LIMITS.verbatimKeepChars));
    if (source.length === 0 || entries.length === 0) return { text: source, clipped: 0, capped };

    const { text: normText, map } = normalize(source, true);
    // A run is at least one window long, so a text shorter than a window holds none; nor can one at or under maxRun.
    if (normText.length < WINDOW || normText.length <= maxRun) return { text: source, clipped: 0, capped };

    // The text's windows by hash: hash → the window starts not yet seen in the corpus.
    const last = normText.length - WINDOW;
    const open = new Map<number, number[]>();
    let h = hashAt(normText, 0);
    for (let i = 0; ; i++) {
      const starts = open.get(h);
      if (starts) starts.push(i);
      else open.set(h, [i]);
      if (i === last) break;
      h = (Math.imul((h - Math.imul(normText.charCodeAt(i), TOP)) | 0, BASE) + normText.charCodeAt(i + WINDOW)) >>> 0;
    }
    const matched = new Uint8Array(last + 1);

    // The corpus, newest entry first, past the index (a window found once is done: it leaves the index).
    let budget = CORPUS_MAX_CHARS;
    for (let e = entries.length - 1; e >= 0 && budget > 0 && open.size > 0; e--) {
      const entry = entries[e];
      const piece = entry.length > budget ? entry.slice(entry.length - budget) : entry;
      budget -= piece.length;
      const norm = normalize(piece, false).text;
      if (norm.length < WINDOW) continue;
      const end = norm.length - WINDOW;
      let c = hashAt(norm, 0);
      for (let j = 0; ; j++) {
        const starts = open.get(c);
        if (starts) {
          let kept = 0;
          for (const i of starts) {
            if (sameWindow(normText, i, norm, j)) matched[i] = 1;
            else starts[kept++] = i;
          }
          if (kept === 0) open.delete(c);
          else starts.length = kept;
          if (open.size === 0) break;
        }
        if (j === end) break;
        c = (Math.imul((c - Math.imul(norm.charCodeAt(j), TOP)) | 0, BASE) + norm.charCodeAt(j + WINDOW)) >>> 0;
      }
    }

    // Runs of consecutive matching windows, as normalized [start, end).
    const runs: [number, number][] = [];
    let runStart = -1;
    for (let i = 0; i <= last; i++) {
      if (matched[i] === 1) {
        if (runStart < 0) runStart = i;
      } else if (runStart >= 0) {
        runs.push([runStart, i - 1 + WINDOW]);
        runStart = -1;
      }
    }
    if (runStart >= 0) runs.push([runStart, last + WINDOW]);
    if (runs.length === 0) return { text: source, clipped: 0, capped };

    let out = "";
    let prev = 0;
    let clipped = 0;
    for (const [start, end] of runs) {
      if (end - start <= maxRun) continue;
      let cut = map[start + keep];
      let stop = map[end - 1] + 1;
      // Never leave half of a surrogate pair on either side of the cut.
      if (cut > 0 && isLowSurrogate(source.charCodeAt(cut)) && isHighSurrogate(source.charCodeAt(cut - 1))) cut -= 1;
      if (stop < source.length && isLowSurrogate(source.charCodeAt(stop)) && isHighSurrogate(source.charCodeAt(stop - 1))) stop += 1;
      if (cut < prev) cut = prev;
      out += source.slice(prev, cut) + ELLIPSIS;
      prev = stop;
      clipped += 1;
    }
    if (clipped === 0) return { text: source, clipped: 0, capped };
    out += source.slice(prev);
    return { text: out, clipped, capped };
  } catch {
    return { text: source, clipped: 0, capped: false };
  }
}
