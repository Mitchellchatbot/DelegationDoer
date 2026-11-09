import type { ComposeInput } from "@/lib/exec/brief-compose";
import { bandRank, contentSections, deterministicTop3, gatherItems, noveltyAndCounts, topItemFrom, verdictOf } from "@/lib/exec/brief-sections";
import { BRIEF_LIMITS, BRIEF_SECTION_KEYS } from "@/lib/exec/brief-types";
import type { BriefContent, BriefInputItem, BriefItem, BriefSectionKey, BriefTopItem, BriefTrigger } from "@/lib/exec/brief-types";
import { clipExcerpt } from "@/lib/exec/refs";
import type { SourceRef } from "@/lib/exec/types";

// P8 validate (contract §3.10.2, M4; Area C; pure, B-P8-5): the model's text → stored content, or the reason it can't be
// used. Every refs[] and top3 entry must be an input alias; an unknown alias drops the whole item; an invalid top3 falls
// back to the deterministic top 3. ComposeInput is a type-only import (erased). The model's text is never logged, and
// nothing a line says becomes a link: links come only from the cited items' refs (BC16).
//
// "Input alias" = an alias the model was shown: every gathered item except the unchanged ones, which renderBriefInput
// counts but never sends (§3.10.1). A citation of anything else (an unchanged item's alias, i0, I1, "i1 ", a tag) is
// unknown and drops its line (BC17: the validator is the injection defence).

export type ValidateResult = { ok: true; content: BriefContent } | { ok: false; reason: "parse" | "shape" | "no_items" };

// Code points cleanModelLine removes or rewrites (§0.3 rule 3: built with String.fromCodePoint, never typed as escapes).
//   whitespace → space: U+0009-U+000D (tab, LF, VT, FF, CR), U+0085 (next line), U+2028 / U+2029 (line / paragraph separator)
//   removed: the rest of C0 (U+0000-U+001F), DEL U+007F, C1 (U+0080-U+009F), U+061C (Arabic letter mark), U+180E (Mongolian
//            vowel separator), U+200B-U+200F (zero width space / non-joiner / joiner, LRM, RLM), U+202A-U+202E (bidi
//            embeddings and overrides), U+2060-U+2064 (word joiner, invisible operators), U+2066-U+2069 (bidi isolates),
//            U+FEFF (BOM / zero width no-break space)
//   dashes → ", ": U+2014 (em dash), U+2013 (en dash)
const EM_DASH = String.fromCodePoint(0x2014);
const EN_DASH = String.fromCodePoint(0x2013);
const isWhitespaceCode = (c: number): boolean => (c >= 0x09 && c <= 0x0d) || c === 0x85 || c === 0x2028 || c === 0x2029;
const isStrippedCode = (c: number): boolean =>
  c <= 0x1f || c === 0x7f || (c >= 0x80 && c <= 0x9f) || c === 0x061c || c === 0x180e || (c >= 0x200b && c <= 0x200f) ||
  (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2064) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff;
const DASH_RUN = new RegExp(`\\s*[${EM_DASH}${EN_DASH}]+\\s*`, "g");

/** Strip C0/DEL/bidi/zero-width (String.fromCodePoint ranges, §0.3 rule 3), collapse whitespace, replace em/en dashes
 *  (U+2014, U+2013) with ", ", clip with clipExcerpt. Empty → "". */
export function cleanModelLine(s: string, max: number): string {
  if (typeof s !== "string" || s.length === 0) return "";
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) as number;
    if (isWhitespaceCode(code)) out += " ";
    else if (!isStrippedCode(code)) out += ch;
  }
  const text = out
    .replace(DASH_RUN, ", ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,]+/, "")
    .replace(/[\s,]+$/, "")
    .replace(/ ,/g, ",");
  return text === "" ? "" : clipExcerpt(text, max);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SECTION_KEYS: ReadonlySet<string> = new Set<string>(BRIEF_SECTION_KEYS);
const KINDS: ReadonlySet<string> = new Set(["fact", "recommendation"]);

/** The aliases the model was shown (every item but the unchanged ones), alias → item. */
function shownAliases(input: ComposeInput): Map<string, BriefInputItem> {
  const out = new Map<string, BriefInputItem>();
  for (const item of gatherItems(input.gather)) {
    if (verdictOf(input.verdicts, item.fingerprint) === "unchanged") continue;
    out.set(item.alias, item);
  }
  return out;
}

/** A list of distinct strings, each a shown alias, between 1 and max long; null on any violation. */
function aliasList(v: unknown, shown: ReadonlyMap<string, BriefInputItem>, min: number, max: number): string[] | null {
  if (!Array.isArray(v) || v.length < min || v.length > max) return null;
  const seen = new Set<string>();
  for (const a of v) {
    if (typeof a !== "string" || !shown.has(a) || seen.has(a)) return null;
    seen.add(a);
  }
  return [...seen];
}

const union = (lists: readonly string[][]): string[] => [...new Set(lists.flat())];

/** One kept line: basis "ai", the highest band among its aliases, the union of their fps, refs (≤ 5, first seen) and keys. */
function lineOf(id: string, text: string, kind: "fact" | "recommendation", aliases: string[], shown: ReadonlyMap<string, BriefInputItem>): BriefItem {
  const items = aliases.map((a) => shown.get(a) as BriefInputItem);
  const band = items.reduce((best, i) => (bandRank(i.band) > bandRank(best) ? i.band : best), items[0].band);
  const refs: SourceRef[] = [];
  const seen = new Set<string>();
  for (const r of items.flatMap((i) => i.refs)) {
    const key = `${r.system}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ ...r });
    if (refs.length >= BRIEF_LIMITS.itemRefsMax) break;
  }
  return {
    id, text, kind, basis: "ai", band, aliases: [...aliases], fps: union(items.map((i) => [i.fingerprint])), refs,
    threadIds: union(items.map((i) => i.threadIds)), slackKeys: union(items.map((i) => i.slackKeys)), slackChannels: union(items.map((i) => i.slackChannels))
  };
}

/** The model's text → stored content, or the reason it can't be used. */
export function validateBriefOutput(raw: string, input: ComposeInput,
  meta: { rev: number; builtAt: string; trigger: BriefTrigger }): ValidateResult {
  // 1. JSON and shape.
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : "");
  } catch {
    return { ok: false, reason: "parse" };
  }
  if (!isRecord(parsed) || typeof parsed.headline !== "string" || !Array.isArray(parsed.sections) || !Array.isArray(parsed.top3)) {
    return { ok: false, reason: "shape" };
  }
  const shown = shownAliases(input);

  // 2. Sections and lines: a known key, first occurrence; a line needs clean text, a known kind and 1-5 distinct shown aliases.
  const lines = new Map<BriefSectionKey, BriefItem[]>();
  for (const s of parsed.sections) {
    if (!isRecord(s) || typeof s.key !== "string" || !SECTION_KEYS.has(s.key) || lines.has(s.key as BriefSectionKey)) continue;
    const key = s.key as BriefSectionKey;
    const kept: BriefItem[] = [];
    for (const it of Array.isArray(s.items) ? s.items : []) {
      if (kept.length >= BRIEF_LIMITS.itemsPerSectionStored) break;
      if (!isRecord(it)) continue;
      const text = cleanModelLine(typeof it.text === "string" ? it.text : "", BRIEF_LIMITS.itemTextChars);
      if (text === "" || typeof it.kind !== "string" || !KINDS.has(it.kind)) continue;
      const aliases = aliasList(it.refs, shown, 1, BRIEF_LIMITS.itemRefsMax);
      if (aliases === null) continue;
      kept.push(lineOf("", text, it.kind as "fact" | "recommendation", aliases, shown));
    }
    lines.set(key, kept);
  }

  // Ids in stored order (BRIEF_SECTION_KEYS order, then the model's order within a section).
  let id = 0;
  for (const key of BRIEF_SECTION_KEYS) for (const line of lines.get(key) ?? []) line.id = `b${++id}`;

  // 3. Nothing usable while there was something new to say.
  const all = BRIEF_SECTION_KEYS.flatMap((key) => lines.get(key) ?? []);
  const novelInput = [...shown.values()].some((i) => {
    const v = verdictOf(input.verdicts, i.fingerprint);
    return v === "new" || v === "changed" || v === "escalated";
  });
  if (all.length === 0 && novelInput) return { ok: false, reason: "no_items" };

  // 4. Top 3: distinct shown aliases, at most 3; any violation (or an empty list while there are items he should act on) → the
  //    deterministic top 3, flagged, mode still "ai".
  const items = gatherItems(input.gather);
  const fallback = deterministicTop3(items, input.verdicts);
  const chosen = aliasList(parsed.top3, shown, 0, BRIEF_LIMITS.top3);
  const useFallback = chosen === null || (chosen.length === 0 && fallback.length > 0);
  const firstCiting = (alias: string) => all.find((l) => l.aliases.includes(alias))?.id ?? null;
  const top3: BriefTopItem[] = useFallback
    ? fallback.map((i) => topItemFrom(i, firstCiting(i.alias)))
    : (chosen as string[]).map((a) => topItemFrom(shown.get(a) as BriefInputItem, firstCiting(a)));

  // 5. Headline.
  const headline = cleanModelLine(parsed.headline, BRIEF_LIMITS.headlineChars);

  // 6, 7. Every section in order with the gather's state, notes, stats, pending lines and counts; novelty and its counts.
  const { novelty, counts } = noveltyAndCounts(input.gather, input.verdicts);
  return {
    ok: true,
    content: {
      v: 1, localDate: input.gather.localDate, tz: input.gather.tz, rev: meta.rev, builtAt: meta.builtAt, trigger: meta.trigger,
      mode: "ai", modeReason: null, top3Fallback: useFallback, headline: headline === "" ? null : headline,
      sections: contentSections(input.gather, input.verdicts, lines), top3, novelty, counts, failures: [...input.gather.failures]
    }
  };
}
