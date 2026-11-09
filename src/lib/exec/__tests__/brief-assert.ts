import { BRIEF_COPY } from "@/lib/exec/brief-copy";
import { BRIEF_LIMITS, type BriefGather } from "@/lib/exec/brief-types";
import type { SlackMessageParts } from "@/lib/exec/slack-types";
import { slackPartsProblems } from "./slack-assert";
import { captureConsole } from "./slack-read-assert";

// P8 shared test helper (contract §5, §0.3 rule 4; stage 0, lead-owned, frozen). Every area's tests use it:
//
//   BRIEF_TEXT_SENTINELS     values planted in fixtures that must never reach a log, an ops alert, an audit input, a job
//                            payload or result, an error message, an HTTP error body or exec_jobs.last_error
//   findBriefText(value)     every sentinel (and every Slack token prefix) inside a value, with where it was found
//   assertNoBriefText(value) throws naming the sentinel and the path only (never the value); value may be a vi.fn spy,
//                            captureConsole()'s result, a list of either, or any value (Errors, Maps, Sets, Headers walked)
//   assertDmBudget(parts)    a DM P8 posts: P6's Block Kit rules (slackPartsProblems: verbatim mrkdwn, sizes, allowed
//                            action ids, button value ≤ 200 and text ≤ 75), ≤ BRIEF_LIMITS.dmBlocksMax blocks (45; the
//                            check-ins message passes BRIEF_LIMITS.checkinsMessageBlocksMax, 8) and a non-empty fallback text
//   resolveFixtureAliases    a brief-model-output fixture → the model's raw text, its "@fp:<fingerprint>" refs replaced by
//                            the aliases assembleSections gave (and the {RLO}/{ZWSP}/{EMDASH}/{ENDASH}/{BELL} markers expanded)
//
// Pure: no server-only, no Supabase. Imports only P8's frozen types and P6's / P7a's frozen helpers.

export const BRIEF_TEXT_SENTINELS = Object.freeze({
  /** a brief line (headline, item text, top-3 title, section or pending line) */
  briefLine: "SENTINEL_BRIEF_LINE_7Q",
  /** a check-in's text (draft or sent) */
  checkinText: "SENTINEL_CHECKIN_TEXT_9Z",
  /** an email subject (or summary) the brief cites */
  emailSubject: "SENTINEL_EMAIL_SUBJECT_3K",
  /** his DD Slack user token (and, by prefix below, any Slack token) */
  token: "SENTINEL_TOKEN_xoxp_FAKE",
  /** a P7b digest summary or excerpt */
  digestSummary: "SENTINEL_DIGEST_SUMMARY_2W",
  /** a P7a item excerpt the gather must never read (GA12, N7) */
  excerpt: "SENTINEL_EXCERPT"
});
export type BriefSentinelName = keyof typeof BRIEF_TEXT_SENTINELS | "token_prefix";

/** Slack token prefixes: none may appear in any checked value (§0.3 rule 4). */
const TOKEN_PREFIXES: readonly string[] = Object.freeze(["xoxb-", "xoxp-", "xoxe-", "xoxa-", "xapp-"]);
const ENTRIES = Object.entries(BRIEF_TEXT_SENTINELS) as [keyof typeof BRIEF_TEXT_SENTINELS, string][];
const MAX_WALK_NODES = 50_000;

export interface BriefTextOptions {
  /** A label for the error message (e.g. "notifyOps"). */
  label?: string;
  /** Sentinel names allowed in this value (e.g. the page's own lines in a render test). */
  allow?: readonly BriefSentinelName[];
  /** Object keys not walked. */
  ignoreKeys?: readonly string[];
}
export interface BriefTextHit { sentinel: BriefSentinelName; path: string }

type Spy = { mock: { calls: unknown[][] } } | { calls(): unknown[][] };
const isSpy = (v: unknown): v is Spy =>
  typeof v === "function" || (typeof v === "object" && v !== null)
    ? ("mock" in (v as object) && Array.isArray((v as { mock?: { calls?: unknown } }).mock?.calls)) ||
      typeof (v as { calls?: unknown }).calls === "function"
    : false;
const unwrap = (v: unknown): unknown => {
  if (!isSpy(v)) return v;
  return "mock" in (v as object) ? (v as { mock: { calls: unknown[][] } }).mock.calls : (v as { calls(): unknown[][] }).calls();
};

/** Every sentinel and token prefix in `value`, with the path where it was found. Never throws. */
export function findBriefText(value: unknown, opts: BriefTextOptions = {}): BriefTextHit[] {
  const allow = new Set<string>(opts.allow ?? []);
  const ignore = new Set(opts.ignoreKeys ?? []);
  const hits: BriefTextHit[] = [];
  const seen = new Set<unknown>();
  const root = Array.isArray(value) ? value.map(unwrap) : unwrap(value);
  const queue: { v: unknown; path: string }[] = [{ v: root, path: "$" }];
  for (let i = 0; i < queue.length && i < MAX_WALK_NODES; i++) {
    const { v, path } = queue[i];
    if (typeof v === "string") {
      for (const [name, needle] of ENTRIES) if (!allow.has(name) && v.includes(needle)) hits.push({ sentinel: name, path });
      if (!allow.has("token_prefix") && TOKEN_PREFIXES.some((p) => v.includes(p))) hits.push({ sentinel: "token_prefix", path });
      continue;
    }
    if (v === null || v === undefined || (typeof v !== "object" && typeof v !== "function")) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    try {
      if (isSpy(v)) {
        queue.push({ v: unwrap(v), path: `${path}.calls` });
        continue;
      }
      if (v instanceof Error) {
        queue.push({ v: v.name, path: `${path}.name` }, { v: v.message, path: `${path}.message` }, { v: v.stack, path: `${path}.stack` },
          { v: (v as { cause?: unknown }).cause, path: `${path}.cause` });
        for (const [k, x] of Object.entries(v as unknown as Record<string, unknown>)) if (!ignore.has(k)) queue.push({ v: x, path: `${path}.${k}` });
        continue;
      }
      if (typeof Headers !== "undefined" && v instanceof Headers) {
        v.forEach((val, key) => queue.push({ v: key, path: `${path}[header]` }, { v: val, path: `${path}[${key}]` }));
        continue;
      }
      if (v instanceof URLSearchParams) {
        queue.push({ v: v.toString(), path });
        continue;
      }
      if (v instanceof Uint8Array) {
        queue.push({ v: new TextDecoder().decode(v), path });
        continue;
      }
      if (v instanceof Map) {
        for (const [k, x] of v) queue.push({ v: k, path: `${path}<key>` }, { v: x, path: `${path}<${typeof k === "string" ? k : "?"}>` });
        continue;
      }
      if (v instanceof Set) {
        let j = 0;
        for (const x of v) queue.push({ v: x, path: `${path}{${j++}}` });
        continue;
      }
      if (Array.isArray(v)) {
        v.forEach((x, j) => queue.push({ v: x, path: `${path}[${j}]` }));
        continue;
      }
      if (typeof v === "function") continue;
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (ignore.has(k)) continue;
        queue.push({ v: k, path: `${path}<key>` }, { v: x, path: `${path}.${k}` });
      }
    } catch {
      // A hostile getter or a revoked proxy: skip the node.
    }
  }
  return hits;
}

/** Throws one Error listing every hit (sentinel name and path only, never a value). */
export function assertNoBriefText(value: unknown, opts: BriefTextOptions = {}): void {
  const hits = findBriefText(value, opts);
  if (hits.length === 0) return;
  const where = hits.slice(0, 20).map((h) => `${h.sentinel} at ${h.path}`).join("; ");
  throw new Error(`brief text leaked${opts.label ? ` into ${opts.label}` : ""}: ${where}${hits.length > 20 ? ` (+${hits.length - 20} more)` : ""}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Model-output fixtures (fixtures/brief-model-output/*.json, §5.7)
// ---------------------------------------------------------------------------------------------------------------------

/** Hostile-character markers the fixtures use so the files stay ASCII (§0.3 rule 3): expanded here with String.fromCodePoint.
 *  {RLO} U+202E right-to-left override, {ZWSP} U+200B zero width space, {EMDASH} U+2014, {ENDASH} U+2013, {BELL} U+0007. */
export const FIXTURE_CHAR_MARKERS: Readonly<Record<string, string>> = Object.freeze({
  "{RLO}": String.fromCodePoint(0x202e),
  "{ZWSP}": String.fromCodePoint(0x200b),
  "{EMDASH}": String.fromCodePoint(0x2014),
  "{ENDASH}": String.fromCodePoint(0x2013),
  "{BELL}": String.fromCodePoint(0x0007)
});

/** fingerprint → alias over every item of the gather (assembleSections' aliases). */
export function aliasesByFingerprint(gather: BriefGather): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of gather.sections) for (const i of s.items) out.set(i.fingerprint, i.alias);
  return out;
}

/** A fixture value with every "@fp:<fingerprint>" string replaced by that fingerprint's alias (an unknown fingerprint throws:
 *  a fixture bug), every marker expanded, and every "_"-prefixed key (fixture notes) dropped. */
export function resolveFixtureValue(value: unknown, gather: BriefGather): unknown {
  const aliases = aliasesByFingerprint(gather);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.startsWith("@fp:")) {
        const alias = aliases.get(v.slice(4));
        if (alias === undefined) throw new Error(`fixture cites a fingerprint the gather has no alias for: ${v.slice(4)}`);
        return alias;
      }
      let s = v;
      for (const [marker, ch] of Object.entries(FIXTURE_CHAR_MARKERS)) s = s.split(marker).join(ch);
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!k.startsWith("_")) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value);
}

/** The model's raw text for a model-output fixture: JSON of its resolved `output` (validateBriefOutput's `raw`). */
export function resolveFixtureAliases(fixture: { output: unknown }, gather: BriefGather): string {
  return JSON.stringify(resolveFixtureValue(fixture.output, gather));
}

/** P8's fixed, neutral top-level texts (C25): a brief DM, the late and scrubbed notes, the check-ins message, the DD-bot
 *  mini-brief and the network alert. P6's rule ("text is SLACK_COPY.fallbackText") is P6's; P8's messages use these. */
const P8_FALLBACK_TEXTS: ReadonlySet<string> = new Set([
  BRIEF_COPY.dmFallbackText, BRIEF_COPY.checkinsFallbackText, BRIEF_COPY.fallbackText, BRIEF_COPY.networkFallbackText
]);
const P6_FALLBACK_PROBLEM = "text: not SLACK_COPY.fallbackText";

export interface DmBudgetOptions {
  /** renderCheckinPost only: Mitchell's own note is its text (§3.16), so any non-empty text is accepted. */
  anyText?: boolean;
}

/** The problems assertDmBudget would throw for (empty = within budget). */
export function dmBudgetProblems(parts: SlackMessageParts, max: number = BRIEF_LIMITS.dmBlocksMax, opts: DmBudgetOptions = {}): string[] {
  const out = slackPartsProblems(parts).filter((p) => p !== P6_FALLBACK_PROBLEM);
  const blocks = Array.isArray(parts?.blocks) ? parts.blocks : [];
  if (blocks.length === 0) out.push("no blocks");
  if (blocks.length > max) out.push(`${blocks.length} blocks > ${max}`);
  if (typeof parts?.text !== "string" || parts.text.trim() === "") out.push("no fallback text");
  else if (opts.anyText !== true && !P8_FALLBACK_TEXTS.has(parts.text)) out.push("text: not one of P8's fixed fallback texts");
  return out;
}

/** §3.16 / C25: throws listing every problem (never a block's text). */
export function assertDmBudget(parts: SlackMessageParts, max: number = BRIEF_LIMITS.dmBlocksMax, opts: DmBudgetOptions = {}): void {
  const problems = dmBudgetProblems(parts, max, opts);
  if (problems.length > 0) throw new Error(`DM over budget or malformed: ${problems.slice(0, 20).join("; ")}`);
}

export { captureConsole };
