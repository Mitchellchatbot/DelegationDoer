import { isExecEnabled } from "@/lib/exec/access";
import { kickInteractive } from "@/lib/exec/jobs";
import { ensureExecRuntime } from "@/lib/exec/runtime";
import { slackConfig, slackSigningSecret } from "@/lib/exec/slack-config";
import { parseEventEnvelope } from "@/lib/exec/slack-events";
import { SlackStoreError, acceptEvent } from "@/lib/exec/slack-install";
import type { AcceptEventResult } from "@/lib/exec/slack-types";
import { SLACK_LIMITS } from "@/lib/exec/slack-types";
import { readRawBody, verifySlackSignature } from "@/lib/exec/slack-verify";

// POST /api/integrations/exec-slack/events: the Executive Assistant's Events API
// endpoint (P6 contract §3.10.1, K7, C4, C5, C37). Public in the middleware
// (src/lib/public-paths.ts): the v0 signature over the raw bytes is the gate.
//
//   1. the body, capped at 1 MiB with a stream reader (413 + x-slack-no-retry)
//   2. the signature (401), before anything reads the body
//   3. UTF-8 + JSON (400 + x-slack-no-retry)
//   4. url_verification is answered here, whatever EXEC_ENABLED, the config or
//      the migration say (K7); an unparseable envelope is a 400, another
//      envelope type a 200 drop
//   5. the app and team pins, 6. the feature flag: a 200 drop each
//   7. ONE database round trip: RPC 1 on a 2 s controller inserts the event
//      (the PK dedupes), applies the routing rule and enqueues in one
//      transaction; an error or the timeout is a 500, so Slack retries
//   8. kick the interactive lane when a job was enqueued
//
// No Slack call, no model call, no other read on the ack path (§0.3 rule 9).
// One log line per request: ids, codes and counts only, never the body, a
// header value or the challenge (§0.3 rule 4).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_RETRY = Object.freeze({ "x-slack-no-retry": "1" });
const TYPE_CODE_RE = /^[a-z_.]{1,60}$/;
const REASON_CODE_RE = /^[a-z_]{1,40}$/;
const RETRY_RE = /^[0-9]{1,3}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

type Level = "info" | "warn" | "error";

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
  if (err instanceof SlackStoreError) return err.pgCode ? `store_${err.pgCode.toLowerCase()}` : "store";
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "timeout";
  return "error";
}

/** Runs one RPC on a fresh controller that aborts after SLACK_LIMITS.ackRpcTimeoutMs; answers by then even if the call ignores it. */
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

export async function POST(req: Request): Promise<Response> {
  const retry = retryOf(req.headers.get("x-slack-retry-num"));
  let eventId: string | null = null;
  let eventType: string | null = null;
  const log = (level: Level, outcome: string, reason: string): void => {
    const at = `[exec-slack] events ${outcome} reason=${reason} event=${eventId ?? "-"} type=${eventType ?? "-"} retry=${retry}`;
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
  const facts = parsed.facts;
  eventId = facts.eventId;
  eventType = codeOr(facts.eventType, TYPE_CODE_RE, "unknown");

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

  // 6. The feature flag: off is a 200 drop here (Slack needs a 2xx), not the exec gates' 404.
  if (!isExecEnabled()) {
    log("info", "dropped", "disabled");
    return respond(200);
  }

  // 7. One RPC, 2 s.
  let result: AcceptEventResult;
  try {
    ensureExecRuntime();
    result = await withAckTimeout((signal) => acceptEvent(facts, { signal }));
  } catch (err) {
    log("error", "failed", failureCode(err));
    return respond(500, { json: { error: "unavailable" } });
  }
  if (result.outcome === "not_installed") {
    log("warn", "dropped", "schema_missing");
    return respond(200);
  }
  if (result.outcome === "duplicate") {
    log("info", "duplicate", "duplicate");
    return respond(200);
  }

  // 8. A job is waiting: wake the interactive lane (the runner's own poll is the backstop).
  if (result.interactive) {
    try {
      kickInteractive();
    } catch {
      // Never fails the ack: the job is durable and the next poll claims it.
    }
  }
  if (result.decision === "drop") log("info", "dropped", codeOr(result.reason, REASON_CODE_RE, "unknown"));
  else log("info", "accepted", result.decision);
  return respond(200);
}
