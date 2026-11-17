import type { NextResponse } from "next/server";
import { z } from "zod";

import { requireExecPrincipal } from "@/lib/exec/access";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBodyOrError, validateBody } from "@/lib/exec/http";
import { P10_LIMITS, REPLY_ACKABLE, type ReplyBlocker, type SendOutcome } from "@/lib/exec/slack-p10-types";
import { sendSlackReply } from "@/lib/exec/slack-reply-send";

// POST /api/exec/slack/replies/:id/send (P10 contract §3.5.12, §3.5.8, H2, C34, C36, C48; Area D): Send as you, from the
// web dialog after its explicit click. The strong gate → same-origin → the body (≤ 1 KB, zod strict { version, textSha256,
// acks }) → the send bucket (10 / 10 min; it counts slack_reply.send, which sendSlackReply writes as its first act, and the
// DM job counts the same) → sendSlackReply (path web, actor owner). No field names a destination or a text: the stored
// text posts into the stored destination (RS05); textSha256 binds the send to the exact text the dialog showed.
// Answers: 200 { kind: "sent", postedTs, permalink }; 202 { kind: "in_flight" }; 200 { kind: "back_to_draft" | "unknown", … };
// 409 { error: "needs_ack", blockers } / { error: "refused", reason, status }; 404. Every answer is Cache-Control: private,
// no-store; nothing here logs the text.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/exec/slack/replies/:id/send";
const BODY_LIMIT = 1024;
const DRAFT_ID = /^esr_[0-9a-f]{32}$/;
const SEND_TIMEOUT_MS = 40_000;

const SendBody = z.object({
  version: z.number().int().min(1).max(9999),
  textSha256: z.string().regex(/^[0-9a-f]{64}$/),
  // ReplyBlocker[] ≤ 7: placeholders are never acknowledged (C48; the send refuses them first, whatever acks say).
  acks: z.array(z.enum(["placeholders", ...REPLY_ACKABLE] as [ReplyBlocker, ...ReplyBlocker[]])).max(REPLY_ACKABLE.length)
}).strict();

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(err.name) ? err.name : "error");

function privateNoStore<T extends Response | NextResponse>(res: T): T {
  res.headers.set("cache-control", "private, no-store");
  return res;
}

/** Every SendOutcome as its answer (RU05). */
function answerOf(out: SendOutcome): NextResponse {
  switch (out.kind) {
    case "sent":
      return jsonAnswer(200, { kind: "sent", postedTs: out.postedTs, permalink: out.permalink });
    case "in_flight":
      return jsonAnswer(202, { kind: "in_flight" });
    case "back_to_draft":
      return jsonAnswer(200, { kind: "back_to_draft", reason: out.reason, version: out.version });
    case "unknown":
      return jsonAnswer(200, { kind: "unknown", reason: out.reason });
    case "needs_ack":
      return jsonError(409, "needs_ack", { blockers: out.blockers });
    case "dd_only":
      return jsonError(409, "dd_only", { blockers: out.blockers });
    default:
      if (out.reason === "not_found") return jsonError(404, "not_found");
      return jsonError(409, "refused", { reason: out.reason, ...(out.status !== undefined ? { status: out.status } : {}) });
  }
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
  const valid = validateBody<z.infer<typeof SendBody>>(read.value, SendBody);
  if (!valid.ok) return privateNoStore(valid.response);
  const body = valid.value;

  const now = new Date();
  const limited = await rateLimit(principal, "slack_reply_send", P10_LIMITS.replySendLimit, P10_LIMITS.replyRouteWindowMs, { now });
  if (!limited.ok) return privateNoStore(limited.response);

  try {
    const out = await sendSlackReply(principal, {
      id, path: "web", version: body.version, textSha256: body.textSha256, acks: body.acks, actor: "owner", now,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    });
    return privateNoStore(answerOf(out));
  } catch (err) {
    console.error(`[exec-slack-reply] ${ROUTE} unavailable for ${principal.id} (${errName(err)})`);
    return privateNoStore(jsonError(503, "unavailable"));
  }
}
