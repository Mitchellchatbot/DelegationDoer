import type { NextResponse } from "next/server";
import { z } from "zod";

import { requireExecPrincipal } from "@/lib/exec/access";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBodyOrError, runAudited, validateBody } from "@/lib/exec/http";
import { P10_LIMITS } from "@/lib/exec/slack-p10-types";
import { regenerateSlackReplyDraft } from "@/lib/exec/slack-reply-create";

// POST /api/exec/slack/replies/:id/regenerate (P10 contract §3.5.12, C49, C51; Area D): Rewrite, with his new instruction or
// ("" ) the last one kept. The strong gate → same-origin → the body (≤ 4 KB, zod strict { version 0..9999, instruction ≤
// 2,000 }) → the create bucket (20 / 10 min, shared with create) → the audit row (slack_reply.regenerate) →
// regenerateSlackReplyDraft (origin web; RPC 14's CAS on the version). 202 { generationSeq }; 409 { error: busy | conflict |
// off | unavailable }; 404. Every answer is Cache-Control: private, no-store.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/exec/slack/replies/:id/regenerate";
const BODY_LIMIT = 4096;
const DRAFT_ID = /^esr_[0-9a-f]{32}$/;
const TIMEOUT_MS = 20_000;

const RegenerateBody = z.object({
  version: z.number().int().min(0).max(9999),
  instruction: z.string().max(P10_LIMITS.replyInstructionChars)
}).strict();

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
  const valid = validateBody<z.infer<typeof RegenerateBody>>(read.value, RegenerateBody);
  if (!valid.ok) return privateNoStore(valid.response);
  const instruction = valid.value.instruction.trim() === "" ? null : valid.value.instruction;

  const now = new Date();
  const limited = await rateLimit(principal, "slack_reply_create", P10_LIMITS.replyCreateLimit, P10_LIMITS.replyRouteWindowMs, { now });
  if (!limited.ok) return privateNoStore(limited.response);

  const run = await runAudited(
    principal,
    {
      actor: "owner", action: "slack_reply.regenerate", target: `exec_slack_reply_drafts:${id}`,
      input: { draftId: id, version: valid.value.version, instructionChars: instruction?.length ?? 0 }
    },
    () => regenerateSlackReplyDraft(principal, { id, version: valid.value.version, instruction, origin: "web" }, { now, signal: AbortSignal.timeout(TIMEOUT_MS) }),
    (r) => ({ ok: r.outcome === "queued", outcome: r.outcome })
  );
  if (!run.ok) return privateNoStore(run.response);
  const r = run.value;
  if (r.outcome === "queued") return privateNoStore(jsonAnswer(202, { generationSeq: r.generationSeq }));
  if (r.outcome === "not_found") return privateNoStore(jsonError(404, "not_found"));
  return privateNoStore(jsonError(409, r.outcome));
}
