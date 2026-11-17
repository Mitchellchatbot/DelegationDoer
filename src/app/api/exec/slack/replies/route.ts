import type { NextResponse } from "next/server";
import { z } from "zod";

import { requireExecPrincipal } from "@/lib/exec/access";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBodyOrError, runAudited, validateBody } from "@/lib/exec/http";
import { P10_LIMITS, type CreateReplyOutcome } from "@/lib/exec/slack-p10-types";
import { createSlackReplyDraft } from "@/lib/exec/slack-reply-create";
import { slackReplyPageHref } from "@/lib/exec/slack-reply-links";

// POST /api/exec/slack/replies (P10 contract §3.5.12, C45, C46, C49; Area D): start a Slack reply draft for one stored message
// he can see on the web. The order: the strong gate → same-origin → the body (≤ 4 KB, zod strict: { channelId, ts, itemId,
// instruction, fromDraftId }) → the create bucket (20 / 10 min) → the audit row (slack_reply.create; ids, codes and a length)
// → createSlackReplyDraft (origin web). No field names a destination: RPC 13 computes it from the stored message (C28, RS05).
// "Start a new draft with this text" passes fromDraftId and no instruction (the text is copied in SQL, never sent here).
// Answers: 201 { id, status, href } created; 200 the same for an existing active draft; 409 { error: <refusal> }; 404
// not_found. Every answer is Cache-Control: private, no-store. Logs carry the route, the principal id and an error name.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/exec/slack/replies";
const BODY_LIMIT = 4096;
const CREATE_TIMEOUT_MS = 20_000;

const CreateBody = z.object({
  channelId: z.string().regex(/^[CGD][A-Z0-9]{2,30}$/),
  ts: z.string().regex(/^[0-9]{1,12}\.[0-9]{1,8}$/),
  itemId: z.union([z.literal(""), z.string().regex(/^esl_[0-9a-f]{32}$/)]),
  instruction: z.string().max(P10_LIMITS.replyInstructionChars),
  fromDraftId: z.union([z.literal(""), z.string().regex(/^esr_[0-9a-f]{32}$/)])
}).strict();
type CreateBodyT = z.infer<typeof CreateBody>;

function privateNoStore<T extends Response | NextResponse>(res: T): T {
  res.headers.set("cache-control", "private, no-store");
  return res;
}

export async function POST(req: Request): Promise<Response> {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return privateNoStore(gate.response);
  const principal = gate.principal;
  const same = assertSameOrigin(req);
  if (!same.ok) return privateNoStore(same.response);

  const read = await readJsonBodyOrError(req, BODY_LIMIT);
  if (!read.ok) return privateNoStore(read.response);
  const valid = validateBody<CreateBodyT>(read.value, CreateBody);
  if (!valid.ok) return privateNoStore(valid.response);
  const body = valid.value;
  const instruction = body.instruction.trim() === "" ? null : body.instruction;
  // RPC 13 refuses an instruction with a from-draft copy: the copied text is the instruction.
  if (body.fromDraftId !== "" && instruction !== null) return privateNoStore(jsonError(400, "invalid", { detail: "instruction" }));

  const now = new Date();
  const limited = await rateLimit(principal, "slack_reply_create", P10_LIMITS.replyCreateLimit, P10_LIMITS.replyRouteWindowMs, { now });
  if (!limited.ok) return privateNoStore(limited.response);

  const run = await runAudited<CreateReplyOutcome>(
    principal,
    {
      actor: "owner", action: "slack_reply.create", target: "exec_slack_reply_drafts",
      input: {
        channelId: body.channelId, ts: body.ts, itemId: body.itemId === "" ? null : body.itemId, instructionChars: instruction?.length ?? 0,
        fromDraftId: body.fromDraftId === "" ? null : body.fromDraftId
      }
    },
    () => createSlackReplyDraft(principal, {
      channelId: body.channelId, ts: body.ts, itemId: body.itemId === "" ? null : body.itemId, origin: "web", instruction,
      fromDraftId: body.fromDraftId === "" ? null : body.fromDraftId
    }, { now, signal: AbortSignal.timeout(CREATE_TIMEOUT_MS) }),
    (r) => ({ ok: r.outcome !== "refused", outcome: r.outcome === "refused" ? r.reason : r.outcome })
  );
  if (!run.ok) {
    console.error(`[exec-slack-reply] ${ROUTE} unavailable for ${principal.id}`);
    return privateNoStore(run.response);
  }
  const r = run.value;
  if (r.outcome === "refused") {
    if (r.reason === "not_found") return privateNoStore(jsonError(404, "not_found"));
    return privateNoStore(jsonError(409, r.reason));
  }
  return privateNoStore(jsonAnswer(r.outcome === "created" ? 201 : 200, { id: r.id, status: r.status, href: slackReplyPageHref(r.id), existing: r.outcome === "existing" }));
}

