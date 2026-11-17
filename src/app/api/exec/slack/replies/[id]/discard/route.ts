import type { NextResponse } from "next/server";
import { z } from "zod";

import { requireExecPrincipal } from "@/lib/exec/access";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBodyOrError, runAudited, validateBody } from "@/lib/exec/http";
import { P10_LIMITS, type ReplyStatus } from "@/lib/exec/slack-p10-types";
import { getReplyDraft, stepReplyDraft } from "@/lib/exec/slack-reply-store";
import { rerenderReplyCards } from "@/lib/exec/slack-reply-view";

// POST /api/exec/slack/replies/:id/discard (P10 contract §3.5.12, §2.1.16 X1, C49; Area D): Discard nulls the text at once.
// The strong gate → same-origin → the body (≤ 1 KB, zod strict { version 0..9999 }) → the edit bucket (60 / 10 min) → the
// audit row (slack_reply.discard) → X1, fenced on the version. 200 { status: "discarded" }; 409 { error: "conflict", status,
// version } when the draft moved on; 404. The DM cards follow. Every answer is Cache-Control: private, no-store.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/exec/slack/replies/:id/discard";
const BODY_LIMIT = 1024;
const DRAFT_ID = /^esr_[0-9a-f]{32}$/;

const DiscardBody = z.object({ version: z.number().int().min(0).max(9999) }).strict();

type DiscardOutcome = { outcome: "discarded" } | { outcome: "conflict"; status: ReplyStatus; version: number } | { outcome: "not_found" };

function privateNoStore<T extends Response | NextResponse>(res: T): T {
  res.headers.set("cache-control", "private, no-store");
  return res;
}

export async function POST(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return privateNoStore(gate.response);
  const principal = gate.principal;
  const same = assertSameOrigin(req);
  if (!same.ok) return privateNoStore(same.response);
  const id = typeof params?.id === "string" ? params.id : "";
  if (!DRAFT_ID.test(id)) return privateNoStore(jsonError(404, "not_found"));

  const read = await readJsonBodyOrError(req, BODY_LIMIT);
  if (!read.ok) return privateNoStore(read.response);
  const valid = validateBody<z.infer<typeof DiscardBody>>(read.value, DiscardBody);
  if (!valid.ok) return privateNoStore(valid.response);
  const version = valid.value.version;

  const now = new Date();
  const limited = await rateLimit(principal, "slack_reply_edit", P10_LIMITS.replyEditLimit, P10_LIMITS.replyRouteWindowMs, { now });
  if (!limited.ok) return privateNoStore(limited.response);

  const run = await runAudited<DiscardOutcome>(
    principal,
    { actor: "owner", action: "slack_reply.discard", target: `exec_slack_reply_drafts:${id}`, input: { draftId: id, version } },
    async () => {
      if (await stepReplyDraft(principal, id, { t: "discard", version }, now)) return { outcome: "discarded" };
      const row = await getReplyDraft(principal, id);
      return row === null ? { outcome: "not_found" } : { outcome: "conflict", status: row.status, version: row.version };
    },
    (r) => ({ ok: r.outcome === "discarded", outcome: r.outcome })
  );
  if (!run.ok) return privateNoStore(run.response);
  const r = run.value;
  if (r.outcome === "discarded") {
    await rerenderReplyCards(principal, id, { now });
    return privateNoStore(jsonAnswer(200, { status: "discarded" }));
  }
  if (r.outcome === "not_found") return privateNoStore(jsonError(404, "not_found"));
  return privateNoStore(jsonError(409, "conflict", { status: r.status, version: r.version }));
}
