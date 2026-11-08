import { z } from "zod";

import { requireExecPrincipal } from "@/lib/exec/access";
import { SecretUnavailableError } from "@/lib/exec/crypto";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBodyOrError, runAudited, validateBody } from "@/lib/exec/http";
import { getActiveInstallation, openActiveInstallation, revokeInstallation, slackSchemaReady } from "@/lib/exec/slack-install";
import { getSlackSettingsView } from "@/lib/exec/slack-settings";
import type { DmTarget, SlackSettingsView } from "@/lib/exec/slack-types";
import { SLACK_LIMITS, SLACK_RE } from "@/lib/exec/slack-types";
import { SlackApiError, revokeToken } from "@/lib/exec/sources/slack";
import type { ExecPrincipal } from "@/lib/exec/types";

// POST /api/exec/slack/disconnect: Settings' Disconnect (P6 contract §3.10.5,
// K15, C23). The exec mutation order: strong gate → same-origin → body (≤ 1 KB,
// zod strict) → schema → rate limit (10 / 10 min) → audit → act.
//
// The act: his active installation must be the one named. With its token
// opened, auth.revoke on the BOT token first; Slack unreachable (or any other
// refusal) changes nothing locally (503 slack_unavailable), while a token
// Slack already considers dead is fine. A token that can't be opened here
// (SecretUnavailableError) skips Slack: the row is still revoked locally
// (local_only). Then RPC 3 marks the row revoked and enqueues the purge
// (C18). Answers carry the Settings view, codes and ids only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/exec/slack/disconnect";
const BODY_LIMIT = 1024;
const DISCONNECT_LIMIT = 10;
const DISCONNECT_WINDOW_MS = 600_000;
const SLACK_CODE_RE = /^[a-z0-9_]{1,60}$/;

const DisconnectBody = z
  .object({
    installationId: z.string().regex(SLACK_RE.installationId),
    confirm: z.literal("disconnect")
  })
  .strict();

type DisconnectOutcome =
  | { kind: "revoked" }
  | { kind: "local_only" }
  | { kind: "already_revoked" }
  | { kind: "not_found" }
  | { kind: "slack_unavailable" };

const errName = (err: unknown): string => (err instanceof Error ? err.name : "error");

async function disconnect(principal: ExecPrincipal, installationId: string): Promise<DisconnectOutcome> {
  let target: DmTarget | null = null;
  try {
    const open = await openActiveInstallation(principal);
    if (open === null || open.row.id !== installationId) return { kind: "not_found" };
    target = open.target;
  } catch (err) {
    // The token can't be opened here (a rotated or missing key): revoke locally only.
    if (!(err instanceof SecretUnavailableError)) throw err;
    const row = await getActiveInstallation(principal);
    if (row === null || row.id !== installationId) return { kind: "not_found" };
  }
  if (target !== null) {
    try {
      // "revoked" and "already_invalid" both continue; anything else leaves the row as it was.
      await revokeToken(target.token, { timeoutMs: SLACK_LIMITS.httpTimeoutMs });
    } catch (err) {
      const code = err instanceof SlackApiError && SLACK_CODE_RE.test(err.code) ? err.code : errName(err);
      console.warn(`[exec-slack] disconnect ${installationId}: Slack refused the token revoke (${code}); nothing changed`);
      return { kind: "slack_unavailable" };
    }
  }
  const { revoked } = await revokeInstallation(installationId, "disconnected");
  if (!revoked) return { kind: "already_revoked" };
  return target === null ? { kind: "local_only" } : { kind: "revoked" };
}

async function settingsView(principal: ExecPrincipal): Promise<SlackSettingsView | null> {
  try {
    return await getSlackSettingsView(principal);
  } catch (err) {
    console.error(`[exec-slack] disconnect: settings view failed (${errName(err)})`);
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
  const valid = validateBody(read.value, DisconnectBody);
  if (!valid.ok) return valid.response;
  const installationId = valid.value.installationId;

  try {
    if (!(await slackSchemaReady())) return jsonError(409, "not_installed");
  } catch (err) {
    console.error(`[exec-slack] ${ROUTE}: schema check failed (${errName(err)})`);
    return jsonError(503, "unavailable");
  }

  const limited = await rateLimit(principal, "slack_disconnect", DISCONNECT_LIMIT, DISCONNECT_WINDOW_MS);
  if (!limited.ok) return limited.response;

  const run = await runAudited(
    principal,
    { actor: "owner", action: "slack.disconnect", target: "exec_slack_installations:" + installationId, input: { installationId } },
    () => disconnect(principal, installationId),
    (r) => ({ ok: r.kind === "revoked", outcome: r.kind })
  );
  if (!run.ok) return run.response;
  if (run.value.kind === "not_found") return jsonError(404, "not_found");
  if (run.value.kind === "slack_unavailable") return jsonError(503, "slack_unavailable");
  return jsonAnswer(200, { slack: await settingsView(principal) });
}
