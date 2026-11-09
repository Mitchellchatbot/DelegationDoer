import { captureConsole, findSlackText, type SlackTextOptions } from "./slack-read-assert";

// P7b test helper (contract §5.0, §0.3 rule 4; stage 0, lead-owned, frozen). Every test file of Areas B–E calls
// assertNoSlackLeak in afterEach with the spies it recorded: console.*, notifyOps, audit inputs, job payloads and
// results, RPC arguments, HTTP bodies and thrown errors. It fails on any INTEL_SENTINELS value, on P7a's
// SLACK_TEXT_SENTINELS and P6's SENTINELS, and on any Slack token prefix (xoxa-/xoxb-/xoxp-/xoxe-), naming the
// sentinel and the path only (never the value).
//
//   const out = captureConsole();
//   ... run the code ...
//   afterEach(() => assertNoSlackLeak({ console: out, notifyOps, audit: auditSpy, jobs: enqueueSpy, results, http, errors }));
//
// The fixtures under fixtures/slack-intel/*.json carry these same literals (gen-fixtures.cjs in the lead's stage-0
// scratch). A value a surface may legitimately hold (e.g. a channel name on the Slack page) is passed in `allow`.

/** One recognizable value per kind of content §0.3 rule 4 forbids in P7b's logs, payloads, results, errors and responses. */
export const INTEL_SENTINELS = Object.freeze({
  /** Slack message text (a live read, a stored message, a digest input). */
  slackText: "SENTINEL-INTEL-SLACK-TEXT-9c1d",
  /** P7a's stored excerpt (exec_slack_items.excerpt), as a test writes it. */
  excerpt: "SENTINEL-INTEL-EXCERPT-9c1d",
  /** A channel name (exec_slack_channels.name): shown on the page, never logged. */
  channelName: "sentinel-intel-channel-9c1d",
  /** A client (or project) name read for a channel or a draft. */
  clientName: "Sentinel Intelclient 9c1d",
  /** eod_client_work worked_on / results text. */
  eodWork: "SENTINEL-INTEL-EOD-WORK-9c1d",
  /** His user token (xoxp-). */
  userToken: "xoxp-SENTINEL-INTEL-1111111111-2222222222222-intelreadingtoken0000",
  /** A Slack permalink. */
  permalink: "https://scaledai.slack.com/archives/C0ACMESEO/p1794060000000100",
  /** An AI summary, highlight, decision or question (an item summary or a digest field). */
  summary: "SENTINEL-INTEL-SUMMARY-9c1d",
  /** A search_slack query. */
  query: "SENTINEL-INTEL-QUERY-9c1d",
  /** A DD task title. */
  taskTitle: "SENTINEL-INTEL-TASK-TITLE-9c1d",
  /** A drafter instruction (his message, ToolContext.question). */
  instruction: "SENTINEL-INTEL-INSTRUCTION-9c1d",
  /** A Slack display name or a DD user's name. */
  authorName: "Sentinel Intelauthor",
  /** An email address. */
  email: "sentinel.intel.9c1d@example.com",
  /** DD's own text inside a DD post (an anchor: never a digest or search input). */
  ddText: "SENTINEL-INTEL-DD-TEXT-9c1d",
  /** An opted-out author's text (never kept, never rendered). */
  optedOutText: "SENTINEL-INTEL-OPTOUT-TEXT-9c1d",
  /** An external (Slack Connect) author's text (summarized only; never returned by live search). */
  externalText: "SENTINEL-INTEL-EXTERNAL-TEXT-9c1d",
  /** Another bot's text (counted, never rendered). */
  botText: "SENTINEL-INTEL-BOT-TEXT-9c1d"
});
export type IntelSentinelName = keyof typeof INTEL_SENTINELS;

/** Something that recorded calls: a vi.fn / vi.spyOn mock, captureConsole()'s result, or a plain list of recorded values. */
export type LeakSource = { mock: { calls: unknown[][] } } | { calls(): unknown[][] } | readonly unknown[] | null | undefined;

export interface IntelLeakSpies {
  /** captureConsole() (or its calls()). */
  console?: LeakSource;
  /** notifyOps (P2a's ops alert) spy. */
  notifyOps?: LeakSource;
  /** audit inputs: auditStart / auditFinish / auditEvent spies, or the recorded entries. */
  audit?: LeakSource | readonly LeakSource[];
  /** job payloads: enqueueJob / enqueueJobs spies, or the inputs. */
  jobs?: LeakSource | readonly LeakSource[];
  /** handler and job results (values). */
  results?: readonly unknown[];
  /** RPC / store arguments that must stay references only (e.g. a fake db's recorded calls). */
  rpc?: LeakSource | readonly LeakSource[];
  /** HTTP response bodies (parsed JSON or text) and Responses. */
  http?: readonly unknown[];
  /** thrown errors and rejection reasons. */
  errors?: readonly unknown[];
  /** anything else, by label. */
  extra?: Readonly<Record<string, unknown>>;
}

export interface IntelLeakOptions {
  /** Named in the failure message. */
  label?: string;
  /** Sentinels (INTEL and P7a names) these spies may legitimately hold. */
  allow?: readonly (IntelSentinelName | NonNullable<SlackTextOptions["allow"]>[number])[];
  /** Object keys skipped at every depth. */
  ignoreKeys?: readonly string[];
}

export interface IntelLeakHit { spy: string; sentinel: string; path: string }

const INTEL_ENTRIES = Object.entries(INTEL_SENTINELS) as [IntelSentinelName, string][];
const INTEL_NAMES: ReadonlySet<string> = new Set(Object.keys(INTEL_SENTINELS));
const MAX_WALK_NODES = 50_000;

function recorded(src: LeakSource): unknown {
  if (src === null || src === undefined) return [];
  if (Array.isArray(src)) return src;
  const s = src as { mock?: { calls?: unknown[][]; results?: { value: unknown }[] }; calls?: () => unknown[][] };
  if (s.mock && Array.isArray(s.mock.calls)) return { calls: s.mock.calls, results: (s.mock.results ?? []).map((r) => r?.value) };
  if (typeof s.calls === "function") return s.calls();
  return src;
}

function many(src: LeakSource | readonly LeakSource[] | undefined): unknown {
  if (src === undefined) return [];
  // A list of spies or a list of values: a spy element is unwrapped, a value element is kept as it is.
  if (Array.isArray(src)) return src.map((x) => (x && typeof x === "object" && ("mock" in x || typeof (x as { calls?: unknown }).calls === "function") ? recorded(x as LeakSource) : x));
  return recorded(src as LeakSource);
}

/** Every INTEL sentinel in `value` (strings, keys, arrays, objects, Maps, Sets, Errors with cause, Headers,
 *  URLSearchParams, Uint8Arrays, Responses' headers), with the path where it was found. Never throws. */
export function findIntelText(value: unknown, opts: { allow?: readonly string[]; ignoreKeys?: readonly string[] } = {}): { sentinel: IntelSentinelName; path: string }[] {
  const allow = new Set(opts.allow ?? []);
  const ignore = new Set(opts.ignoreKeys ?? []);
  const hits: { sentinel: IntelSentinelName; path: string }[] = [];
  const seen = new Set<unknown>();
  const queue: { v: unknown; path: string }[] = [{ v: value, path: "$" }];
  for (let i = 0; i < queue.length && i < MAX_WALK_NODES; i++) {
    const { v, path } = queue[i];
    if (typeof v === "string") {
      for (const [name, needle] of INTEL_ENTRIES) if (!allow.has(name) && v.includes(needle)) hits.push({ sentinel: name, path });
      continue;
    }
    if (v === null || v === undefined || typeof v !== "object") continue;
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

/** Every leak in the recorded spies: INTEL_SENTINELS, P7a's SLACK_TEXT_SENTINELS, P6's SENTINELS and token prefixes. */
export function findSlackLeaks(spies: IntelLeakSpies, opts: IntelLeakOptions = {}): IntelLeakHit[] {
  const allowIntel = (opts.allow ?? []).filter((n) => INTEL_NAMES.has(n));
  const allowP7a = (opts.allow ?? []).filter((n) => !INTEL_NAMES.has(n)) as NonNullable<SlackTextOptions["allow"]>;
  const groups: [string, unknown][] = [
    ["console", recorded(spies.console)],
    ["notifyOps", recorded(spies.notifyOps)],
    ["audit", many(spies.audit)],
    ["jobs", many(spies.jobs)],
    ["results", spies.results ?? []],
    ["rpc", many(spies.rpc)],
    ["http", spies.http ?? []],
    ["errors", spies.errors ?? []],
    ...Object.entries(spies.extra ?? {})
  ];
  const out: IntelLeakHit[] = [];
  for (const [spy, value] of groups) {
    for (const h of findIntelText(value, { allow: allowIntel, ignoreKeys: opts.ignoreKeys })) out.push({ spy, sentinel: h.sentinel, path: h.path });
    for (const h of findSlackText(value, { allow: allowP7a, ignoreKeys: opts.ignoreKeys })) out.push({ spy, sentinel: String(h.sentinel), path: h.path });
  }
  return out;
}

/** Throws one Error listing every leak found (spy, sentinel name and path only, never a value). */
export function assertNoSlackLeak(spies: IntelLeakSpies, opts: IntelLeakOptions = {}): void {
  const hits = findSlackLeaks(spies, opts);
  if (hits.length === 0) return;
  const list = hits.slice(0, 20).map((h) => `${h.sentinel} in ${h.spy} at ${h.path}`).join("; ");
  throw new Error(`Slack or client content leaked${opts.label ? ` (${opts.label})` : ""}: ${list}${hits.length > 20 ? ` (+${hits.length - 20} more)` : ""}`);
}

export { captureConsole };
