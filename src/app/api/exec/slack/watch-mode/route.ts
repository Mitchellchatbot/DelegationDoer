import { z } from "zod";

import { requireExecPrincipal } from "@/lib/exec/access";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBodyOrError, runAudited, validateBody } from "@/lib/exec/http";
import { enqueueJob } from "@/lib/exec/jobs";
import { updateWatchMode } from "@/lib/exec/settings";
import { getReadingHalf, slackReadingSchemaReady } from "@/lib/exec/slack-install";
import { unwatchUnjoined } from "@/lib/exec/slack-read-store";
import { SLACK_READ_JOB_KINDS } from "@/lib/exec/slack-read-types";
import { getSlackSettingsView } from "@/lib/exec/slack-settings";
import type { SlackSettingsView } from "@/lib/exec/slack-types";
import type { ExecPrincipal, ExecSettings, WatchMode } from "@/lib/exec/types";

// PUT /api/exec/slack/watch-mode: the picker's watch-mode radio (P7a contract
// §3.10.7, N12, C30, P7-5). Its own route because P5a's settings fields have no
// choice kind. The exec mutation order: strong gate → same-origin → body (≤ 1
// KB, zod strict) → the P7a schema → rate limit (60 / 10 min, shared with the
// picker) → audit (settings.watch_mode) → act.
//
// The act: updateWatchMode, a compare-and-set on exec_settings.updated_at.
// Applied to member_only: every unjoined channel row he never set himself stops
// being watched (unwatchUnjoined). Applied to active_public while reading is on:
// one exec.slack-probe now (bulk, deduplicated per minute), which finds active
// unjoined public channels lazily (≤ 10 calls a minute, P7-5). Answers carry the
// Settings view, codes and ids only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "PUT /api/exec/slack/watch-mode";
const BODY_LIMIT = 1024;
const CHANNELS_LIMIT = 60;
const CHANNELS_WINDOW_MS = 600_000;
/** §3.11.4: the probe's attempts. */
const PROBE_MAX_ATTEMPTS = 1;

const ModeBody = z
  .object({
    watchMode: z.enum(["member_only", "active_public"]),
    expectedVersion: z.string().min(1).max(64).nullable()
  })
  .strict();

type ModeOutcome =
  | { kind: "updated"; mode: WatchMode; probe: "enqueued" | "deduplicated" | "not_reading" | "failed" | "none"; unwatched: number | null }
  | { kind: "conflict" }
  | { kind: "invalid" }
  | { kind: "not_installed" };

const errName = (err: unknown): string => (err instanceof Error ? err.name : "error");

/** Reading is on: a live reading half, discovered, and his switch on (the gate's readingOn, for him). */
async function readingOn(principal: ExecPrincipal, settings: ExecSettings): Promise<boolean> {
  if (settings.slackReadingEnabled !== true) return false;
  const half = await getReadingHalf(principal);
  return half !== null && half.reading.hasToken && half.reading.discoveredAt !== null
    && (half.reading.state === "discovering" || half.reading.state === "ready");
}

async function changeMode(principal: ExecPrincipal, mode: WatchMode, expectedVersion: string | null): Promise<ModeOutcome> {
  const r = await updateWatchMode(principal, mode, { expectedVersion });
  if (r.outcome === "conflict") return { kind: "conflict" };
  if (r.outcome === "not_installed") return { kind: "not_installed" };
  if (r.outcome !== "updated") return { kind: "invalid" };
  if (mode === "member_only") return { kind: "updated", mode, probe: "none", unwatched: await unwatchUnjoined(principal) };
  if (!(await readingOn(principal, r.snapshot.settings))) return { kind: "updated", mode, probe: "not_reading", unwatched: null };
  try {
    const minute = Math.floor(Date.now() / 60_000);
    const job = await enqueueJob({
      kind: SLACK_READ_JOB_KINDS.probe,
      lane: "bulk",
      principalId: principal.id,
      payload: {},
      dedupeKey: `slack-probe-now:${principal.id}:${minute}`,
      maxAttempts: PROBE_MAX_ATTEMPTS
    });
    return { kind: "updated", mode, probe: job.enqueued ? "enqueued" : "deduplicated", unwatched: null };
  } catch (err) {
    // The mode is saved; the scheduled probe (every 15 minutes) finds the channels anyway.
    console.error(`[exec-slack] ${ROUTE}: probe not enqueued for ${principal.id} (${errName(err)})`);
    return { kind: "updated", mode, probe: "failed", unwatched: null };
  }
}

async function settingsView(principal: ExecPrincipal): Promise<SlackSettingsView | null> {
  try {
    return await getSlackSettingsView(principal);
  } catch (err) {
    console.error(`[exec-slack] ${ROUTE}: settings view failed (${errName(err)})`);
    return null;
  }
}

export async function PUT(req: Request): Promise<Response> {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  const principal = gate.principal;

  const same = assertSameOrigin(req);
  if (!same.ok) return same.response;

  const read = await readJsonBodyOrError(req, BODY_LIMIT);
  if (!read.ok) return read.response;
  const valid = validateBody(read.value, ModeBody);
  if (!valid.ok) return valid.response;
  const { watchMode, expectedVersion } = valid.value;

  try {
    if (!(await slackReadingSchemaReady())) return jsonError(409, "not_installed");
  } catch (err) {
    console.error(`[exec-slack] ${ROUTE}: schema check failed (${errName(err)})`);
    return jsonError(503, "unavailable");
  }

  const limited = await rateLimit(principal, "slack_channels", CHANNELS_LIMIT, CHANNELS_WINDOW_MS);
  if (!limited.ok) return limited.response;

  const run = await runAudited(
    principal,
    { actor: "owner", action: "settings.watch_mode", target: "exec_settings:" + principal.id, input: { watchMode } },
    () => changeMode(principal, watchMode, expectedVersion),
    (r) => ({ ok: r.kind === "updated", outcome: r.kind })
  );
  if (!run.ok) return run.response;
  const r = run.value;
  if (r.kind === "not_installed") return jsonError(409, "not_installed");
  if (r.kind === "invalid") return jsonError(400, "invalid", { detail: "watchMode" });
  const slack = await settingsView(principal);
  return r.kind === "conflict" ? jsonError(409, "conflict", { slack }) : jsonAnswer(200, { slack });
}
