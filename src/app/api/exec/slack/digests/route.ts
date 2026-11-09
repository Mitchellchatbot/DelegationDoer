import { z } from "zod";

import { requireExecPrincipal } from "@/lib/exec/access";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBodyOrError, runAudited, validateBody } from "@/lib/exec/http";
import { loadSettings } from "@/lib/exec/principal";
import { requestTodayDigests } from "@/lib/exec/slack-digests";
import { slackIntelSchemaReady, slackIntelState } from "@/lib/exec/slack-intel-store";
import { slackUsePolicy, type SlackIntelState } from "@/lib/exec/slack-intel-types";
import { listIntelChannels } from "@/lib/exec/slack-reading";
import type { ExecSettings } from "@/lib/exec/types";

// POST /api/exec/slack/digests: his "Build today's digest" button on the Slack tab (P7b contract §3.10.2, C15). The exec
// mutation order (P5a S2, as the tag route): strong gate → same-origin → the P7a and P7b schemas (503 not_installed) →
// rate limit (20 / 10 min on slack.digest.request audit rows) → body (≤ 1 KB, zod strict: { channelId }) → the intel state
// (anything but ok → 409 slack_off with the state) → the conversation (no row, a policy denial for "digest" or an
// archived one → 409 not_digestible: a "today" build reads a live conversation) → audit first (503 when it can't be
// written) → requestTodayDigests(…, 1): a build queued (202 queued) or one built within the hour (200 fresh).
//
// Answers carry codes and the state only; never a channel or client name. The build itself runs as exec.slack-digest,
// which re-checks the policy before it claims and before it reads.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/exec/slack/digests";
const BODY_LIMIT = 1_024;
const BUILD_LIMIT = 20;
const BUILD_WINDOW_MS = 600_000;
/** P7a's channel id shape (exec_slack_channels' CHECK). */
const CHANNEL_RE = /^[CGD][A-Z0-9]{2,30}$/;

const BuildBody = z.object({ channelId: z.string().regex(CHANNEL_RE) }).strict();

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "error");

export async function POST(req: Request): Promise<Response> {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  const principal = gate.principal;

  const same = assertSameOrigin(req);
  if (!same.ok) return same.response;

  let settings: ExecSettings;
  try {
    settings = await loadSettings(principal.id);
    if (!settings.slackReadingSchemaReady || !(await slackIntelSchemaReady())) return jsonError(503, "not_installed");
  } catch (err) {
    console.error(`[exec-slack-intel] ${ROUTE} for ${principal.id}: schema check failed (${errName(err)})`);
    return jsonError(503, "unavailable");
  }

  const limited = await rateLimit(principal, "slack_digest_build", BUILD_LIMIT, BUILD_WINDOW_MS);
  if (!limited.ok) return limited.response;

  const read = await readJsonBodyOrError(req, BODY_LIMIT);
  if (!read.ok) return read.response;
  const valid = validateBody(read.value, BuildBody);
  if (!valid.ok) return valid.response;
  const channelId = valid.value.channelId;

  let state: SlackIntelState;
  try {
    state = await slackIntelState(principal, settings);
  } catch (err) {
    console.error(`[exec-slack-intel] ${ROUTE} for ${principal.id}: state read failed (${errName(err)})`);
    return jsonError(503, "unavailable");
  }
  if (state !== "ok") return jsonError(409, "slack_off", { state });

  try {
    const ch = (await listIntelChannels(principal, { channelIds: [channelId] })).find((c) => c.channelId === channelId) ?? null;
    if (ch === null || !slackUsePolicy(state, ch, "digest").allowed || ch.isArchived) return jsonError(409, "not_digestible");
  } catch (err) {
    console.error(`[exec-slack-intel] ${ROUTE} for ${principal.id}: channel read failed (${errName(err)})`);
    return jsonError(503, "unavailable");
  }

  const run = await runAudited(
    principal,
    { actor: "owner", action: "slack.digest.request", target: "exec_slack_channels:" + channelId, input: { channelId } },
    () => requestTodayDigests(principal, [channelId], new Date(), 1),
    (queued) => ({ ok: true, outcome: queued.length > 0 ? "queued" : "fresh" })
  );
  if (!run.ok) return run.response;
  return run.value.length > 0 ? jsonAnswer(202, { status: "queued" }) : jsonAnswer(200, { status: "fresh" });
}
