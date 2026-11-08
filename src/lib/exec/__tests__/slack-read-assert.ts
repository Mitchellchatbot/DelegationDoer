import { vi } from "vitest";

import { SENTINELS } from "./slack-assert";

// P7a test helper (contract §5, §0.3 rule 4; stage -1, lead-owned, frozen).
// Every test file that touches Slack data feeds SLACK_TEXT_SENTINELS in (a
// message text, a file name, a channel topic, a user token, an AI summary, an
// excerpt, …) and proves none comes out through console.*, notifyOps, an audit
// input, a job payload or result, an RPC argument (except exec_slack_write_items'
// text fields: pass ignoreKeys: ITEM_TEXT_KEYS), an HTTP response or a thrown
// error, with assertNoSlackText.
//
//   const out = captureConsole();
//   ... run the code ...
//   assertNoSlackText(out.calls(), { label: "console" });
//   assertNoSlackText(rpcArgs, { label: "write_items", ignoreKeys: ITEM_TEXT_KEYS });
//
// The fixtures under fixtures/slack-*.json and fixtures/slack-history/*.json
// carry these same values.

/** One recognizable value per kind of Slack content §0.3 rule 4 forbids in logs, payloads, results, errors and responses. */
export const SLACK_TEXT_SENTINELS = Object.freeze({
  /** A Slack message text (text, a rich_text element, an attachment, previous_message). */
  text: "SENTINEL-SLACK-TEXT-7f3a",
  /** A file name / title (files[].name). */
  fileName: "SENTINEL-FILE-7f3a-termination-letter.pdf",
  /** A channel topic or purpose. */
  topic: "SENTINEL-TOPIC-7f3a",
  /** His user token (xoxp-), as Slack issues it at the read consent. */
  userToken: "xoxp-SENTINEL-7777777777-8888888888888-sentinelreadingtoken000",
  /** An AI summary (exec_slack_items.summary). */
  summary: "SENTINEL-SUMMARY",
  /** An excerpt (exec_slack_items.excerpt) as a test writes it directly. */
  excerpt: "SENTINEL-EXCERPT-7f3a",
  /** An author's display / real name (users.info label, exec_slack_items.author_label). */
  authorName: "Sentinel Slackauthor",
  /** A due text (exec_slack_items.due_text). */
  dueText: "SENTINEL-DUE-7f3a",
  /** A channel name: stored in exec_slack_channels.name and shown in Settings, never logged (allow it for Settings views). */
  channelName: "sentinel-channel-7f3a",
  /** DD's own text inside a DD-template post (C49: never in a triage prompt, never stored). */
  ddText: "SENTINEL-DD-TEXT-7f3a"
});
export type SlackTextSentinelName = keyof typeof SLACK_TEXT_SENTINELS;

/** exec_slack_write_items' text-bearing row keys: the one RPC argument allowed to hold Slack text (§0.3 rule 6). */
export const ITEM_TEXT_KEYS: readonly string[] = Object.freeze(["excerpt", "summary", "due_text", "author_label"]);

export interface SlackTextOptions {
  /** Named in the failure message only. */
  label?: string;
  /** Sentinels this value may legitimately hold (e.g. channelName in a Settings view). */
  allow?: readonly SlackTextSentinelName[];
  /** Object keys skipped at every depth (their values aren't checked), e.g. ITEM_TEXT_KEYS for exec_slack_write_items' rows. */
  ignoreKeys?: readonly string[];
  /** Also check P6's SENTINELS (slack-assert.ts) and any Slack token prefix (xoxa-/xoxb-/xoxp-/xoxe-). Default true. */
  p6?: boolean;
}

export interface SlackTextHit { sentinel: SlackTextSentinelName | `p6:${string}` | "token"; path: string }

const ANY_TOKEN = /xox[abpe]-/;
const MAX_WALK_NODES = 50_000;
const P7A_ENTRIES = Object.entries(SLACK_TEXT_SENTINELS) as [SlackTextSentinelName, string][];
const P6_ENTRIES = Object.entries(SENTINELS) as [string, string][];

/**
 * Every sentinel found in `value`, with the path where it was found (never the value itself). Walks strings, arrays,
 * plain objects (keys too), Maps, Sets, Errors (name, message, stack, cause, own fields), Headers, URLSearchParams,
 * Uint8Arrays (decoded as UTF-8) and a Response's / Request's headers. Never throws.
 */
export function findSlackText(value: unknown, opts: SlackTextOptions = {}): SlackTextHit[] {
  const allow = new Set<string>(opts.allow ?? []);
  const ignore = new Set<string>(opts.ignoreKeys ?? []);
  const p6 = opts.p6 !== false;
  const hits: SlackTextHit[] = [];
  const seen = new Set<unknown>();
  const queue: { v: unknown; path: string }[] = [{ v: value, path: "$" }];
  const checkString = (s: string, path: string) => {
    for (const [name, needle] of P7A_ENTRIES) if (!allow.has(name) && s.includes(needle)) hits.push({ sentinel: name, path });
    if (p6) {
      for (const [name, needle] of P6_ENTRIES) if (s.includes(needle)) hits.push({ sentinel: `p6:${name}`, path });
      if (!allow.has("userToken") && ANY_TOKEN.test(s)) hits.push({ sentinel: "token", path });
    }
  };
  for (let i = 0; i < queue.length && i < MAX_WALK_NODES; i++) {
    const { v, path } = queue[i];
    if (typeof v === "string") {
      checkString(v, path);
      continue;
    }
    if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") continue;
    if (typeof v === "function" || typeof v === "symbol") continue;
    if (seen.has(v)) continue;
    seen.add(v);
    try {
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
      if (typeof Response !== "undefined" && (v instanceof Response || v instanceof Request)) {
        queue.push({ v: v.headers, path: `${path}.headers` });
        if (v instanceof Request) queue.push({ v: v.url, path: `${path}.url` });
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
      if (typeof v === "object") {
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
          if (ignore.has(k)) continue;
          queue.push({ v: k, path: `${path}<key>` }, { v: x, path: `${path}.${k}` });
        }
      }
    } catch {
      // A hostile getter or a revoked proxy: skip the node.
    }
  }
  return hits;
}

/** Throws one Error listing every sentinel found (names and paths only, never a value). */
export function assertNoSlackText(value: unknown, opts: SlackTextOptions = {}): void {
  const hits = findSlackText(value, opts);
  if (hits.length === 0) return;
  const list = hits.slice(0, 20).map((h) => `${h.sentinel} at ${h.path}`).join("; ");
  throw new Error(`Slack text leaked${opts.label ? ` (${opts.label})` : ""}: ${list}${hits.length > 20 ? ` (+${hits.length - 20} more)` : ""}`);
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

/**
 * Spies on console.log/info/warn/error/debug (silenced) for the rest of the test (vitest's restoreMocks restores
 * them). calls() returns every call's arguments, grouped by method (log, info, warn, error, debug), each group in order;
 * assertClean(opts) = assertNoSlackText(calls(), { label: "console", ...opts }).
 */
export function captureConsole(): { calls(): unknown[][]; assertClean(opts?: SlackTextOptions): void } {
  const spies = CONSOLE_METHODS.map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  const calls = () => spies.flatMap((s) => s.mock.calls as unknown[][]);
  return { calls, assertClean: (opts = {}) => assertNoSlackText(calls(), { label: "console", ...opts }) };
}
