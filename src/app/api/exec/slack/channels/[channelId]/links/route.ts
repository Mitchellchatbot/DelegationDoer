import { z } from "zod";

import { requireExecPrincipal } from "@/lib/exec/access";
import { isActiveClientStatus } from "@/lib/exec/correlate";
import { kickSlackCorrelate } from "@/lib/exec/handlers/slack-correlate";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBodyOrError, runAudited, validateBody } from "@/lib/exec/http";
import { loadSettings } from "@/lib/exec/principal";
import { listChannelLinks, setChannelTags, slackIntelSchemaReady } from "@/lib/exec/slack-intel-store";
import type { SlackChannelLink } from "@/lib/exec/slack-intel-types";
import { listClients, listProjects } from "@/lib/exec/sources/dd";
import type { ExecPrincipal } from "@/lib/exec/types";

// PUT /api/exec/slack/channels/:channelId/links: his client and project tags for one conversation, from the Settings picker
// (P7b contract §3.10.1, N18, C2, C25). The exec mutation order (P5a S2): strong gate → same-origin → the id's shape (404) →
// the P7b and P7a schemas (503 not_installed) → rate limit (60 / 10 min on slack.channel.links audit rows) → body (≤ 2 KB, zod
// strict) → the tags name an active client and existing projects (422) → audit first (503 when it can't be written) → act.
//
// The act is exec_slack_set_channel_links (setChannelTags), which REPLACES the conversation's tags and refuses, in SQL, any
// conversation the correlator never reads (C25: class deny, hub or unclassified, a 1:1 DM, an unwatched or left one:
// 409 not_taggable); a tag is high by definition and survives the correlator (its rule columns are separate, C2). Then the
// correlator is kicked, so the conversation's verdict and its messages' links follow within a minute. Answers carry ids,
// codes and the link row; an error never carries a client, project or channel name.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "PUT /api/exec/slack/channels/:id/links";
const BODY_LIMIT = 2_048;
const LINKS_LIMIT = 60;
const LINKS_WINDOW_MS = 600_000;
/** exec_slack_channel_links' channel CHECK (§2.1.2). */
const CHANNEL_RE = /^[CGD][A-Z0-9]{2,30}$/;
/** exec_slack_channel_links.tag_client_name's CHECK: 1–200 characters. */
const CLIENT_NAME_MAX = 200;

const LinksBody = z
  .object({
    clientId: z.string().min(1).max(100).nullable(),
    projectIds: z.array(z.string().min(1).max(100)).max(10)
  })
  .strict();

const errName = (err: unknown): string => (err instanceof Error ? err.name : "error");

type TagOutcome = "ok" | "not_found" | "not_taggable";

/** The client and projects named by the body, checked against DD: null when they pass, else the 422 code. */
async function checkTags(principal: ExecPrincipal, clientId: string | null, projectIds: readonly string[]):
  Promise<{ ok: true; client: { id: string; name: string } | null } | { ok: false; code: "unknown_client" | "inactive_client" | "unknown_project" }> {
  let client: { id: string; name: string } | null = null;
  if (clientId !== null) {
    const found = (await listClients(principal)).find((c) => c.id === clientId);
    const name = typeof found?.name === "string" ? found.name.slice(0, CLIENT_NAME_MAX) : "";
    if (found === undefined || name.trim().length === 0) return { ok: false, code: "unknown_client" };
    if (!isActiveClientStatus(found.status)) return { ok: false, code: "inactive_client" };
    client = { id: found.id, name };
  }
  if (projectIds.length > 0) {
    const known = new Set((await listProjects(principal)).map((p) => p.id));
    if (projectIds.some((id) => !known.has(id))) return { ok: false, code: "unknown_project" };
  }
  return { ok: true, client };
}

export async function PUT(req: Request, { params }: { params: { channelId: string } }): Promise<Response> {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  const principal = gate.principal;

  const same = assertSameOrigin(req);
  if (!same.ok) return same.response;

  const channelId = params?.channelId;
  if (typeof channelId !== "string" || !CHANNEL_RE.test(channelId)) return jsonError(404, "not_found");

  try {
    const settings = await loadSettings(principal.id);
    if (!settings.slackReadingSchemaReady || !(await slackIntelSchemaReady())) return jsonError(503, "not_installed");
  } catch (err) {
    console.error(`[exec-slack-intel] ${ROUTE} for ${principal.id}: schema check failed (${errName(err)})`);
    return jsonError(503, "unavailable");
  }

  const limited = await rateLimit(principal, "slack_links", LINKS_LIMIT, LINKS_WINDOW_MS);
  if (!limited.ok) return limited.response;

  const read = await readJsonBodyOrError(req, BODY_LIMIT);
  if (!read.ok) return read.response;
  const valid = validateBody(read.value, LinksBody);
  if (!valid.ok) return valid.response;
  const clientId = valid.value.clientId;
  const projectIds = [...new Set(valid.value.projectIds)];

  let client: { id: string; name: string } | null;
  try {
    const checked = await checkTags(principal, clientId, projectIds);
    if (!checked.ok) return jsonError(422, checked.code);
    client = checked.client;
  } catch (err) {
    console.error(`[exec-slack-intel] ${ROUTE} for ${principal.id}: DD read failed (${errName(err)})`);
    return jsonError(503, "unavailable");
  }

  const run = await runAudited(
    principal,
    {
      actor: "owner",
      action: "slack.channel.links",
      target: "exec_slack_channels:" + channelId,
      input: { channelId, hasClient: client !== null, projectCount: projectIds.length }
    },
    (): Promise<TagOutcome> => setChannelTags(principal, { channelId, client, projectIds }),
    (outcome) => ({ ok: outcome === "ok", outcome })
  );
  if (!run.ok) return run.response;
  if (run.value === "not_found") return jsonError(404, "not_found");
  if (run.value === "not_taggable") return jsonError(409, "not_taggable");

  // The verdict and the message links follow the tag on the next correlate run; the 15-minute schedule is the backstop.
  try {
    await kickSlackCorrelate(principal);
  } catch (err) {
    console.error(`[exec-slack-intel] ${ROUTE} for ${principal.id}: correlate kick failed (${errName(err)})`);
  }

  // The stored row, with its generated verdict. The tags are written: a failed read-back answers 200 with links null.
  let links: SlackChannelLink | null = null;
  try {
    links = (await listChannelLinks(principal, { channelIds: [channelId] })).get(channelId) ?? null;
  } catch (err) {
    console.error(`[exec-slack-intel] ${ROUTE} for ${principal.id}: read-back failed (${errName(err)})`);
  }
  return jsonAnswer(200, { links });
}
