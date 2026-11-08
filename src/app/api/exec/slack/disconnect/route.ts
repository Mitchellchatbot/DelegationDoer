import { z } from "zod";

import { requireExecPrincipal } from "@/lib/exec/access";
import { SecretUnavailableError } from "@/lib/exec/crypto";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBodyOrError, runAudited, validateBody } from "@/lib/exec/http";
import { getActiveInstallation, openActiveInstallation, revokeInstallation, slackSchemaReady } from "@/lib/exec/slack-install";
import { withdrawReadingGrant } from "@/lib/exec/slack-oauth";
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
//
// P7a (contract §3.10.8, N4, C47): with a live reading half, the USER token goes
// first. While his user token is alive Slack keeps the app installed (PLAT
// §3), so the act first withdraws the reading grant (withdrawReadingGrant:
// auth.revoke with the user token, then the revoke-and-purge RPC, whatever
// Slack answered), then runs P6's bot revoke unchanged. If the bot revoke then
// fails, reading is already stopped and purged: 503 slack_unavailable carries
// the Settings view so the banner can say so. A failed user revoke still
// disconnects: 200 with warning "revoke_failed".
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

type DisconnectOutcome = (
  | { kind: "revoked" }
  | { kind: "local_only" }
  | { kind: "already_revoked" }
  | { kind: "not_found" }
  | { kind: "slack_unavailable" }
) & {
  /** P7a: present when a live reading half was withdrawn first; revokeFailed when Slack refused the user token's revoke (C47). */
  reading?: { revokeFailed: boolean };
};

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
  // P7a: a live reading half is withdrawn first (its user token revoked, its data purged), whatever Slack answers (C47).
  // Without the P7a schema (a P6-only database) there is no reading half, and this is P6's Disconnect exactly.
  let reading: { revokeFailed: boolean } | undefined;
  const withdrawn = await withdrawReadingGrant(principal, installationId, "disconnected");
  // P7a fixer ui-7: a token the key couldn't open was never revoked at Slack either (local_only).
  if (withdrawn.kind === "withdrawn") reading = { revokeFailed: withdrawn.slack === "revoke_failed" || withdrawn.slack === "local_only" };
  const withReading = <T extends DisconnectOutcome>(o: T): T => (reading === undefined ? o : { ...o, reading });
  if (target !== null) {
    try {
      // "revoked" and "already_invalid" both continue; anything else leaves the row as it was.
      await revokeToken(target.token, { timeoutMs: SLACK_LIMITS.httpTimeoutMs });
    } catch (err) {
      const code = err instanceof SlackApiError && SLACK_CODE_RE.test(err.code) ? err.code : errName(err);
      console.warn(`[exec-slack] disconnect ${installationId}: Slack refused the token revoke (${code}); ${reading === undefined ? "nothing changed" : "reading was stopped"}`);
      return withReading({ kind: "slack_unavailable" });
    }
  }
  const { revoked } = await revokeInstallation(installationId, "disconnected");
  if (!revoked) return withReading({ kind: "already_revoked" });
  return withReading(target === null ? { kind: "local_only" } : { kind: "revoked" });
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
  const done = run.value;
  if (done.kind === "not_found") return jsonError(404, "not_found");
  if (done.kind === "slack_unavailable") {
    // P6's answer when nothing changed; with the reading half already stopped, the view so Settings can show it (disconnectHalf).
    return done.reading === undefined ? jsonError(503, "slack_unavailable") : jsonError(503, "slack_unavailable", { slack: await settingsView(principal) });
  }
  const slack = await settingsView(principal);
  return done.reading?.revokeFailed === true ? jsonAnswer(200, { slack, warning: "revoke_failed" }) : jsonAnswer(200, { slack });
}
