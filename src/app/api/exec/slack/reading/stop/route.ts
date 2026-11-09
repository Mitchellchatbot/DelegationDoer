import { z } from "zod";

import { requireExecPrincipal } from "@/lib/exec/access";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBodyOrError, runAudited, validateBody } from "@/lib/exec/http";
import { slackReadingSchemaReady } from "@/lib/exec/slack-install";
import { withdrawReadingGrant, type ReadingWithdrawal } from "@/lib/exec/slack-oauth";
import { getSlackSettingsView } from "@/lib/exec/slack-settings";
import type { SlackSettingsView } from "@/lib/exec/slack-types";
import { SLACK_RE } from "@/lib/exec/slack-types";
import type { ExecPrincipal } from "@/lib/exec/types";

// POST /api/exec/slack/reading/stop: Settings' "Stop reading Slack" (P7a
// contract §3.10.5, N4, C25, C42, C47). The exec mutation order: strong gate →
// same-origin → body (≤ 1 KB, zod strict, the confirmation) → the P7a schema →
// rate limit (10 / 10 min on slack.read_stop rows) → audit → act.
//
// The act (withdrawReadingGrant): his live reading half on the installation
// named, else 404. auth.revoke with the USER token, then the revoke-and-purge
// RPC (exec_slack_user_revoke: the user half marked revoked and every reading
// row deleted in one transaction) whatever Slack answered: a Slack outage never
// blocks withdrawing consent (C47), it answers 200 with warning
// "revoke_failed" and the ops alert; so does a token DD's key can't open
// (local_only: never revoked at Slack, so he must remove the access there). The bot token and the DM chat are never
// touched. Answers carry the Settings view, codes and ids only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/exec/slack/reading/stop";
const BODY_LIMIT = 1024;
const STOP_LIMIT = 10;
const STOP_WINDOW_MS = 600_000;

const StopBody = z
  .object({
    installationId: z.string().regex(SLACK_RE.installationId),
    confirm: z.literal("stop_reading")
  })
  .strict();

type StopOutcome =
  | { kind: "stopped" }
  | { kind: "local_only" }
  | { kind: "revoke_failed" }
  | { kind: "already_revoked" }
  | { kind: "not_found" };

const errName = (err: unknown): string => (err instanceof Error ? err.name : "error");

function outcomeOf(w: ReadingWithdrawal): StopOutcome {
  if (w.kind === "no_half") return { kind: "not_found" };
  if (!w.revoked) return { kind: "already_revoked" };
  if (w.slack === "revoke_failed") return { kind: "revoke_failed" };
  if (w.slack === "local_only") return { kind: "local_only" };
  return { kind: "stopped" };
}

async function settingsView(principal: ExecPrincipal): Promise<SlackSettingsView | null> {
  try {
    return await getSlackSettingsView(principal);
  } catch (err) {
    console.error(`[exec-slack] ${ROUTE}: settings view failed (${errName(err)})`);
    return null;
  }
}

export async function POST(req: Request): Promise<Response> {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  const principal = gate.principal;

  const same = assertSameOrigin(req);
  if (!same.ok) return same.response;

  const read = await readJsonBodyOrError(req, BODY_LIMIT);
  if (!read.ok) return read.response;
  const valid = validateBody(read.value, StopBody);
  if (!valid.ok) return valid.response;
  const installationId = valid.value.installationId;

  try {
    if (!(await slackReadingSchemaReady())) return jsonError(409, "not_installed");
  } catch (err) {
    console.error(`[exec-slack] ${ROUTE}: schema check failed (${errName(err)})`);
    return jsonError(503, "unavailable");
  }

  const limited = await rateLimit(principal, "slack_reading", STOP_LIMIT, STOP_WINDOW_MS);
  if (!limited.ok) return limited.response;

  const run = await runAudited(
    principal,
    { actor: "owner", action: "slack.read_stop", target: "exec_slack_installations:" + installationId, input: { installationId } },
    async () => outcomeOf(await withdrawReadingGrant(principal, installationId, "stopped")),
    (r) => ({ ok: r.kind === "stopped", outcome: r.kind })
  );
  if (!run.ok) return run.response;
  if (run.value.kind === "not_found") return jsonError(404, "not_found");
  const slack = await settingsView(principal);
  return run.value.kind === "revoke_failed" || run.value.kind === "local_only" ? jsonAnswer(200, { slack, warning: "revoke_failed" }) : jsonAnswer(200, { slack });
}
