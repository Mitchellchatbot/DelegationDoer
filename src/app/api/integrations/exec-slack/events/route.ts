import { isExecEnabled } from "@/lib/exec/access";
import { kickInteractive } from "@/lib/exec/jobs";
import { ensureExecRuntime } from "@/lib/exec/runtime";
import { slackConfig, slackSigningSecret } from "@/lib/exec/slack-config";
import { parseEventEnvelope } from "@/lib/exec/slack-events";
import { gateDropFor, gateSnapshot, markV2Absent, noteEventSeen, v2CachedAbsent } from "@/lib/exec/slack-gate-cache";
import { deriveIngestFacts, ingestFactsForRpc, prefilterIngest } from "@/lib/exec/slack-ingest";
import { SlackStoreError, acceptEvent } from "@/lib/exec/slack-install";
import { SlackReadStoreError, acceptEventV2 } from "@/lib/exec/slack-read-store";
import type { AcceptEventResult, SlackEventFacts } from "@/lib/exec/slack-types";
import { SLACK_LIMITS } from "@/lib/exec/slack-types";
import { readRawBody, verifySlackSignature } from "@/lib/exec/slack-verify";

// POST /api/integrations/exec-slack/events: the Executive Assistant's Events API
// endpoint (P6 contract §3.10.1, K7, C4, C5, C37; P7a contract §3.9.2, N5, C3,
// C4, C43). Public in the middleware (src/lib/public-paths.ts): the v0
// signature over the raw bytes is the gate.
//
//   1. the body, capped at 1 MiB with a stream reader (413 + x-slack-no-retry)
//   2. the signature (401), before anything reads the body
//   3. UTF-8 + JSON (400 + x-slack-no-retry)
//   4. url_verification is answered here, whatever EXEC_ENABLED, the config or
//      the migration say (K7); an unparseable envelope is a 400, another
//      envelope type a 200 drop
//   4b. a reading event (a message, or a channel lifecycle event): its facts,
//      derived in memory by deriveIngestFacts (refs and flags, never text);
//      P6's own events (Home, uninstall, token revokes, anything else) have none
//   5. the app and team pins, 6. the feature flag: a 200 drop each (P9 F14, lead decision L2: while the flag is off a
//      deletion-type event still goes on to step 7, since it only removes data and Slack never redelivers a 2xx: a
//      message deletion, a tombstone, a conversation deleted or left, P6's app_uninstalled / tokens_revoked; the jobs
//      the ack RPC enqueues wait for re-enable, and kickInteractive does nothing while the flag is off)
//   6b. the pre-DB filter (C3): noise, hidden, bot posts that mention nobody,
//      no-op edits: a 200 drop with no database call
//   6c. a fresh gate snapshot (slack-gate-cache.ts, loaded off the ack path)
//      drops what v2 would only drop: everything while no live reading half
//      exists, everything in a deny conversation, and a NEW message in an
//      unclassified conversation or while reading isn't on. Deletes, edits and
//      lifecycle events are never dropped for "reading off" or "unclassified"
//      (C43), the assistant DM never, and neither is an event Slack authorized
//      for the bot (only P6's DM chat can use those; v2 drops the rest)
//   7. ONE database round trip in steady state: v2 on a 2 s controller (it hands
//      every P6 event to P6's v1 in the same transaction); when v2 doesn't exist
//      (a deploy ahead of the migration) v1 on the same controller, and v1
//      directly for the next 5 minutes (C4); an error or the timeout is a 500,
//      so Slack retries
//   8. kick the interactive lane when a job was enqueued
//
// No Slack call, no model call, no other read on the ack path (P6 §0.3 rule 9,
// P7a §0.3 rule 9). One log line per request: ids, codes and counts only, never
// the body, a header value, the challenge or anything derived from text
// (§0.3 rule 4), and path=<v1|v2|-> (which RPC answered).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_RETRY = Object.freeze({ "x-slack-no-retry": "1" });
const TYPE_CODE_RE = /^[a-z_.]{1,60}$/;
const REASON_CODE_RE = /^[a-z_]{1,40}$/;
const RETRY_RE = /^[0-9]{1,3}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

type Level = "info" | "warn" | "error";
/** What the RPC step answered, in one shape for both RPCs. */
type AckAnswer =
  | { outcome: "accepted"; decision: string; reason: string | null; interactive: boolean }
  | { outcome: "duplicate" }
  | { outcome: "not_installed" };

function respond(status: number, init: { json?: Record<string, string>; plain?: string; headers?: Readonly<Record<string, string>> } = {}): Response {
  const headers = new Headers({ "cache-control": "no-store", ...(init.headers ?? {}) });
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(init.json), { status, headers });
  }
  if (init.plain !== undefined) {
    headers.set("content-type", "text/plain; charset=utf-8");
    return new Response(init.plain, { status, headers });
  }
  return new Response(null, { status, headers });
}

const codeOr = (v: string | null | undefined, re: RegExp, fallback: string): string => (typeof v === "string" && re.test(v) ? v : fallback);

/** x-slack-retry-num for the log line (the facts carry the same value). */
function retryOf(header: string | null): number {
  const t = (header ?? "").trim();
  if (!RETRY_RE.test(t)) return 0;
  const n = Number(t);
  return n <= 100 ? n : 0;
}

/** What failed on the ack, as a code: never an error message. */
function failureCode(err: unknown): string {
  if (err instanceof SlackStoreError || err instanceof SlackReadStoreError) {
    return err.pgCode && /^[A-Za-z0-9]{1,10}$/.test(err.pgCode) ? `store_${err.pgCode.toLowerCase()}` : "store";
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "timeout";
  return "error";
}

/** Runs the RPC step on a fresh controller that aborts after SLACK_LIMITS.ackRpcTimeoutMs; answers by then even if the call ignores it. */
async function withAckTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = new DOMException("the Slack ack timed out", "TimeoutError");
      controller.abort(reason);
      reject(reason);
    }, SLACK_LIMITS.ackRpcTimeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** P9 F14: the lifecycle events that only remove data (the conversation is gone, or the bot left it). */
const DELETION_LIFECYCLES: ReadonlySet<string> = new Set(["deleted", "left"]);
/** P9 F14: P6's events that revoke the installation (its uninstall check and purge follow). */
const P6_DELETION_EVENTS: ReadonlySet<string> = new Set(["app_uninstalled", "tokens_revoked"]);

/**
 * P9 F14 (lead decision L2): whether an event only removes data, so it goes to the ack RPC even while EXEC_ENABLED is off: a
 * message deletion (derived kind "delete": message_deleted, and a thread parent's tombstone, a message_changed whose message is
 * Slack's tombstone), a conversation deleted or left (lifecycle), and P6's app_uninstalled / tokens_revoked. Reads only the
 * event type and the derived facts.
 */
function isDeletionEvent(derived: ReturnType<typeof deriveIngestFacts>, eventType: string): boolean {
  if (P6_DELETION_EVENTS.has(eventType)) return true;
  if (derived === null) return false;
  if (derived.facts.kind === "delete") return true;
  return derived.facts.kind === "lifecycle" && derived.facts.lc !== null && DELETION_LIFECYCLES.has(derived.facts.lc);
}

function fromV1(r: AcceptEventResult): AckAnswer {
  return r.outcome === "accepted" ? { outcome: "accepted", decision: r.decision, reason: r.reason, interactive: r.interactive } : r;
}

/**
 * Step 7 on one signal: v2 (or v1 while v2 is known absent), falling back to v1 when v2 answers function-not-found.
 * trace.path names the RPC in flight, so a failure's log line says which one failed: "v2", "v1 v2=missing", "v1"; once
 * v2 answers, v2's own path (P6's events report "v1": v2 handed them to v1 inside its transaction).
 */
async function ack(facts: SlackEventFacts, ingest: Record<string, unknown> | null, signal: AbortSignal, trace: { path: string }): Promise<AckAnswer> {
  if (!v2CachedAbsent()) {
    trace.path = "v2";
    const r = await acceptEventV2(facts, ingest, { signal });
    if (r.outcome !== "v2_missing") {
      if (r.outcome === "accepted") {
        trace.path = r.path;
        return { outcome: "accepted", decision: r.decision, reason: r.reason, interactive: r.interactive === true };
      }
      if (r.outcome === "duplicate") {
        trace.path = r.path;
        return { outcome: "duplicate" };
      }
      return { outcome: "not_installed" };
    }
    markV2Absent();
    trace.path = "v1 v2=missing";
    return fromV1(await acceptEvent(facts, { signal }));
  }
  trace.path = "v1";
  return fromV1(await acceptEvent(facts, { signal }));
}

export async function POST(req: Request): Promise<Response> {
  const retry = retryOf(req.headers.get("x-slack-retry-num"));
  let eventId: string | null = null;
  let eventType: string | null = null;
  // Which RPC answered (or failed): "-" until step 7 starts one.
  const trace = { path: "-" };
  const log = (level: Level, outcome: string, reason: string): void => {
    const at = `[exec-slack] events ${outcome} reason=${reason} event=${eventId ?? "-"} type=${eventType ?? "-"} retry=${retry} path=${trace.path}`;
    if (level === "error") console.error(at);
    else if (level === "warn") console.warn(at);
    else console.info(at);
  };

  // 1. The raw bytes, capped.
  let raw: Buffer;
  try {
    const read = await readRawBody(req, SLACK_LIMITS.bodyMaxBytes);
    if (!read.ok) {
      log("warn", "rejected", "too_large");
      return respond(413, { headers: NO_RETRY });
    }
    raw = read.body;
  } catch {
    log("warn", "rejected", "unreadable");
    return respond(400, { headers: NO_RETRY });
  }

  // 2. The signature, before anything looks at the bytes.
  const verdict = verifySlackSignature(
    {
      secret: slackSigningSecret(),
      timestampHeader: req.headers.get("x-slack-request-timestamp"),
      signatureHeader: req.headers.get("x-slack-signature"),
      rawBody: raw
    },
    Date.now()
  );
  if (!verdict.ok) {
    log("warn", "rejected", verdict.reason);
    return respond(401, { json: { error: "unauthorized" } });
  }

  // 3. UTF-8, then JSON.
  let json: unknown;
  try {
    json = JSON.parse(UTF8.decode(raw));
  } catch {
    log("warn", "rejected", "bad_json");
    return respond(400, { headers: NO_RETRY });
  }

  // 4. The envelope. url_verification is answered before the flag, the config or the migration is consulted (K7).
  const parsed = parseEventEnvelope(json, req.headers.get("x-slack-retry-num"));
  if (parsed.kind === "url_verification") {
    log("info", "challenge", "url_verification");
    return respond(200, { plain: parsed.challenge });
  }
  if (parsed.kind === "invalid") {
    log("warn", "rejected", "invalid");
    return respond(400, { headers: NO_RETRY });
  }
  if (parsed.kind === "other") {
    eventType = codeOr(parsed.type, TYPE_CODE_RE, "unknown");
    log("info", "dropped", "other_type");
    return respond(200);
  }
  eventId = parsed.facts.eventId;
  eventType = codeOr(parsed.facts.eventType, TYPE_CODE_RE, "unknown");

  // 4b. A reading event's facts, derived in memory (refs and flags only; the only step that reads text). null for P6's events.
  // deriveIngestFacts never throws on a malformed shape; if it ever did, the event goes down P6's path (v1 drops it).
  let derived: ReturnType<typeof deriveIngestFacts> = null;
  try {
    derived = deriveIngestFacts(json);
  } catch {
    derived = null;
  }
  // A lifecycle event's channel is where deriveIngestFacts found it (§2.5); P6's facts read only event.channel as a string.
  const facts: SlackEventFacts =
    derived !== null && derived.facts.kind === "lifecycle" ? { ...parsed.facts, channel: derived.channel } : parsed.facts;

  // 5. Ours: the app and the workspace.
  const cfg = slackConfig();
  if (cfg === null) {
    log("warn", "dropped", "not_configured");
    return respond(200);
  }
  if (facts.apiAppId !== cfg.appId) {
    log("warn", "dropped", "wrong_app");
    return respond(200);
  }
  if (facts.teamId !== cfg.teamId) {
    log("warn", "dropped", "wrong_team");
    return respond(200);
  }

  // 6. The feature flag: off is a 200 drop here (Slack needs a 2xx), not the exec gates' 404. P9 F14: a deletion-type event goes on.
  if (!isExecEnabled() && !isDeletionEvent(derived, parsed.facts.eventType)) {
    log("info", "dropped", "disabled");
    return respond(200);
  }

  if (derived !== null) {
    // 6b. The pre-DB filter (C3): the subtype first, then hidden, then a bot that mentions nobody. No database call.
    // (A throw there would only skip a drop: v2 validates every fact again.)
    let pre: ReturnType<typeof prefilterIngest>;
    try {
      pre = prefilterIngest(json, derived.facts);
    } catch {
      pre = "pass";
    }
    if (pre !== "pass") {
      log("info", "dropped", pre);
      return respond(200);
    }
    // 6c. The warm gate (C3, C43). The refresh runs off the ack path while events flow; this call only records the time.
    noteEventSeen();
    const snapshot = gateSnapshot();
    // An event Slack authorized for the bot is never the gate's: only P6's DM chat can use one (v2 hands it to v1, or drops
    // it not_his_view), and a snapshot that missed a just-opened assistant DM must not cost him a message.
    if (snapshot !== null && !derived.facts.authIsBot) {
      const drop = gateDropFor(snapshot, derived.channel, derived.facts.kind);
      if (drop !== null) {
        log("info", "dropped", drop);
        return respond(200);
      }
    }
  }

  // 7. One RPC, 2 s (two only right after a deploy that precedes the migration: v2 missing, then v1 on the same controller).
  const ingest = derived !== null ? ingestFactsForRpc(derived.facts) : null;
  let answer: AckAnswer;
  try {
    ensureExecRuntime();
    answer = await withAckTimeout((signal) => ack(facts, ingest, signal, trace));
  } catch (err) {
    log("error", "failed", failureCode(err));
    return respond(500, { json: { error: "unavailable" } });
  }
  if (answer.outcome === "not_installed") {
    log("warn", "dropped", "schema_missing");
    return respond(200);
  }
  if (answer.outcome === "duplicate") {
    log("info", "duplicate", "duplicate");
    return respond(200);
  }

  // 8. A job is waiting: wake the interactive lane (the runner's own poll is the backstop).
  if (answer.interactive) {
    try {
      kickInteractive();
    } catch {
      // Never fails the ack: the job is durable and the next poll claims it.
    }
  }
  if (answer.decision === "drop") log("info", "dropped", codeOr(answer.reason, REASON_CODE_RE, "unknown"));
  else log("info", "accepted", codeOr(answer.decision, REASON_CODE_RE, "unknown"));
  return respond(200);
}
