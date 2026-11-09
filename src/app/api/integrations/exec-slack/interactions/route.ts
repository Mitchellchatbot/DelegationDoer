import { isExecEnabled } from "@/lib/exec/access";
import { kickInteractive } from "@/lib/exec/jobs";
import { ensureExecRuntime } from "@/lib/exec/runtime";
import { slackConfig, slackSigningSecret } from "@/lib/exec/slack-config";
import { parseActionPayload } from "@/lib/exec/slack-events";
import { SlackStoreError, acceptAction } from "@/lib/exec/slack-install";
import type { AcceptActionResult } from "@/lib/exec/slack-types";
import { SLACK_ACTION_IDS, SLACK_LIMITS } from "@/lib/exec/slack-types";
import { readRawBody, verifySlackSignature } from "@/lib/exec/slack-verify";

// POST /api/integrations/exec-slack/interactions: the Executive Assistant's
// Interactivity endpoint (P6 contract §3.10.2, K8, C12, C13, C36). Public in
// the middleware; the v0 signature is the gate.
//
//   1. the body, capped at 1 MiB (413)   2. the signature (401)
//   3. the payload (400 when unparseable; another payload type is a 200)
//   4. the app and team pins, 5. the feature flag: a 200, nothing done
//   6. a URL button (Open in DD): Slack opened the link itself, a 200, no RPC
//   7. ONE database round trip: RPC 2 on a 2 s controller checks the owner
//      (user = the installation's user, C13), the DM channel and the action,
//      and enqueues exec.slack-action; an error or the timeout is a 500, so
//      Slack shows the clicker an error (C36)
//   8. kick the interactive lane when a job was enqueued
//
// Slack is answered within its 3 s: no P4/P5b/Slack call happens here (the
// job does them). The payload's response_url, message, view and state are
// never read (C12); the trigger id goes to the RPC as the dedupe key only and
// is never logged (§0.3 rule 4).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const LOGGED_ACTION_IDS: ReadonlySet<string> = new Set<string>([...SLACK_ACTION_IDS, "ea_open_dd"]);
const REASON_CODE_RE = /^[a-z_]{1,40}$/;

type Level = "info" | "warn" | "error";

function respond(status: number, json?: Record<string, string>): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (json === undefined) return new Response(null, { status, headers });
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(json), { status, headers });
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
  let actionCode = "-";
  const log = (level: Level, outcome: string, reason: string): void => {
    const at = `[exec-slack] interactions ${outcome} reason=${reason} action=${actionCode}`;
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
      return respond(413);
    }
    raw = read.body;
  } catch {
    log("warn", "rejected", "unreadable");
    return respond(400);
  }

  // 2. The signature.
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
    return respond(401, { error: "unauthorized" });
  }

  // 3. The payload: only `payload`, only the ids RPC 2 checks.
  let form: string;
  try {
    form = UTF8.decode(raw);
  } catch {
    log("warn", "rejected", "bad_utf8");
    return respond(400);
  }
  const parsed = parseActionPayload(form);
  if (parsed.kind === "invalid") {
    log("warn", "rejected", "invalid");
    return respond(400);
  }
  if (parsed.kind === "other") {
    log("info", "dropped", "other_type");
    return respond(200);
  }
  const facts = parsed.facts;
  actionCode = LOGGED_ACTION_IDS.has(facts.actionId) ? facts.actionId : "other";

  // 4. Ours: the app and the workspace.
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

  // 5. The feature flag.
  if (!isExecEnabled()) {
    log("info", "dropped", "disabled");
    return respond(200);
  }

  // 6. Open in DD is a URL button: Slack already opened the link, there is nothing to do.
  if (parsed.linkOnly) {
    log("info", "dropped", "link_only");
    return respond(200);
  }

  // 7. One RPC, 2 s.
  let result: AcceptActionResult;
  try {
    ensureExecRuntime();
    result = await withAckTimeout((signal) => acceptAction(facts, { signal }));
  } catch (err) {
    log("error", "failed", failureCode(err));
    return respond(500, { error: "unavailable" });
  }
  if (result.outcome === "enqueued") {
    // 8. Wake the interactive lane (the runner's own poll is the backstop).
    try {
      kickInteractive();
    } catch {
      // Never fails the ack: the job is durable.
    }
    log("info", "enqueued", "enqueued");
  } else if (result.outcome === "ignored") {
    log("info", "ignored", REASON_CODE_RE.test(result.reason) ? result.reason : "unknown");
  } else {
    log("info", result.outcome === "duplicate" ? "duplicate" : "dropped", result.outcome === "duplicate" ? "duplicate" : "schema_missing");
  }
  return respond(200);
}
