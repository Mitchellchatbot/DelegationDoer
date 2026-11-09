import { z } from "zod";

import { requireExecPrincipal } from "@/lib/exec/access";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBodyOrError, runAudited, validateBody } from "@/lib/exec/http";
import { getReadingHalf, slackReadingSchemaReady } from "@/lib/exec/slack-install";
import { getChannel, setWatch, type SetWatchOutcome } from "@/lib/exec/slack-read-store";
// The one PickerRow converter (Area E): the route answers exactly the rows the Settings page renders.
import { pickerRowFromChannel } from "@/lib/exec/slack-reading-settings";
import type { PickerRow } from "@/lib/exec/slack-types";
import type { ExecPrincipal } from "@/lib/exec/types";

// PATCH /api/exec/slack/channels/:channelId: one row of the Settings picker
// (P7a contract §3.10.6, N11, N12, C10, C29). The exec mutation order: strong
// gate → same-origin → the id's shape (a public or private channel, C… / G…;
// never a DM, which the picker shows only as a summary) → body (≤ 1 KB, zod
// strict) → the P7a schema → a live reading half → rate limit (60 / 10 min,
// shared with the watch mode) → audit → act.
//
// The act is exec_slack_set_watch (setWatch), a compare-and-set on the row's
// version (its updated_at) that also enforces, in SQL: a deny, hub or
// unclassified conversation can't be changed (refused: nothing in Settings can
// turn deny into anything else, §0.3 rule 7); watching a finance-class channel
// or a finance-named Slack Connect channel needs confirm "finance_channel"
// (C10); a mute keeps every stored item (N11: the screen hides them, they
// expire at their TTL). Answers: the row as the picker shows it, codes, ids.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "PATCH /api/exec/slack/channels/:channelId";
const BODY_LIMIT = 1024;
const CHANNELS_LIMIT = 60;
const CHANNELS_WINDOW_MS = 600_000;
/** §3.10.6: public (C…) and private (G…) channels only; upper case, as Slack writes ids. */
const PICKER_CHANNEL_RE = /^[CG][A-Z0-9]{2,30}$/;

const WatchBody = z
  .object({
    watchState: z.enum(["watched", "muted", "unwatched"]),
    expectedVersion: z.string().max(64),
    confirm: z.literal("finance_channel").optional()
  })
  .strict();

const errName = (err: unknown): string => (err instanceof Error ? err.name : "error");

type WatchOutcome =
  | { kind: "updated"; row: PickerRow }
  | { kind: "conflict"; row: PickerRow }
  | { kind: "confirmation_required" }
  | { kind: "refused" }
  | { kind: "not_found" };

async function applyWatch(principal: ExecPrincipal, channelId: string, watchState: "watched" | "muted" | "unwatched", expected: string, finance: boolean): Promise<WatchOutcome> {
  const r: SetWatchOutcome = await setWatch(principal, channelId, watchState, expected, finance);
  if (r.outcome === "confirmation_required") return { kind: "confirmation_required" };
  if (r.outcome === "refused") return { kind: "refused" };
  if (r.outcome === "not_found") return { kind: "not_found" };
  const current = await getChannel(principal, channelId);
  const row = current === null ? null : pickerRowFromChannel(current);
  if (row === null) return current === null ? { kind: "not_found" } : { kind: "refused" };
  return { kind: r.outcome, row };
}

export async function PATCH(req: Request, { params }: { params: { channelId: string } }): Promise<Response> {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  const principal = gate.principal;

  const same = assertSameOrigin(req);
  if (!same.ok) return same.response;

  const channelId = params?.channelId;
  if (typeof channelId !== "string" || !PICKER_CHANNEL_RE.test(channelId)) return jsonError(400, "invalid", { detail: "channelId" });

  const read = await readJsonBodyOrError(req, BODY_LIMIT);
  if (!read.ok) return read.response;
  const valid = validateBody(read.value, WatchBody);
  if (!valid.ok) return valid.response;
  const { watchState, expectedVersion, confirm } = valid.value;

  try {
    if (!(await slackReadingSchemaReady())) return jsonError(409, "not_installed");
    const half = await getReadingHalf(principal);
    if (half === null || (half.reading.state !== "discovering" && half.reading.state !== "ready")) return jsonError(404, "not_found");
  } catch (err) {
    console.error(`[exec-slack] ${ROUTE}: reading check failed (${errName(err)})`);
    return jsonError(503, "unavailable");
  }

  const limited = await rateLimit(principal, "slack_channels", CHANNELS_LIMIT, CHANNELS_WINDOW_MS);
  if (!limited.ok) return limited.response;

  const run = await runAudited(
    principal,
    { actor: "owner", action: "slack.channel_watch", target: "exec_slack_channels:" + channelId, input: { channelId, watchState } },
    () => applyWatch(principal, channelId, watchState, expectedVersion, confirm === "finance_channel"),
    (r) => ({ ok: r.kind === "updated", outcome: r.kind })
  );
  if (!run.ok) return run.response;
  const r = run.value;
  switch (r.kind) {
    case "updated":
      return jsonAnswer(200, { channel: r.row });
    case "conflict":
      return jsonError(409, "conflict", { channel: r.row });
    case "confirmation_required":
      return jsonError(400, "confirmation_required", { field: "finance_channel" });
    case "refused":
      return jsonError(409, "refused");
    case "not_found":
      return jsonError(404, "not_found");
  }
}
