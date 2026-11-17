import type { NextResponse } from "next/server";
import { z } from "zod";

import { requireExecPrincipal } from "@/lib/exec/access";
import { auditEvent } from "@/lib/exec/audit";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBodyOrError, validateBody } from "@/lib/exec/http";
import { fillP10, SLACK_P10_COPY } from "@/lib/exec/slack-p10-copy";
import { P10_LIMITS } from "@/lib/exec/slack-p10-types";
import { reviewSlackReply } from "@/lib/exec/slack-reply-send";

// POST /api/exec/slack/replies/:id/review (P10 contract §3.5.12, C59, v1.1 product-6; Area D): every blocker the send would
// raise now, before the send dialog opens, so he acknowledges them all at once. Read-only: no draft change, no CAS, no post,
// no token call (reviewSlackReply); one live read (the newer-messages read, P7a's triage class). The strong gate →
// same-origin → the body (≤ 1 KB, zod strict { version }) → the edit bucket (60 / 10 min; reviews share it with edit and
// discard) → reviewSlackReply → one audit event slack_reply.review (the id, the version, the blocker count). 200 { version,
// blockers, destination }; 409 { error: "refused", reason, status }; 404. Every answer is Cache-Control: private, no-store.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/exec/slack/replies/:id/review";
const BODY_LIMIT = 1024;
const DRAFT_ID = /^esr_[0-9a-f]{32}$/;
const TIMEOUT_MS = 20_000;

const ReviewBody = z.object({ version: z.number().int().min(1).max(9999) }).strict();

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(err.name) ? err.name : "error");

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
  const valid = validateBody<z.infer<typeof ReviewBody>>(read.value, ReviewBody);
  if (!valid.ok) return privateNoStore(valid.response);
  const version = valid.value.version;

  const now = new Date();
  const limited = await rateLimit(principal, "slack_reply_edit", P10_LIMITS.replyEditLimit, P10_LIMITS.replyRouteWindowMs, { now });
  if (!limited.ok) return privateNoStore(limited.response);

  let review: Awaited<ReturnType<typeof reviewSlackReply>>;
  try {
    review = await reviewSlackReply(principal, { id, version, now, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    console.error(`[exec-slack-reply] ${ROUTE} unavailable for ${principal.id} (${errName(err)})`);
    return privateNoStore(jsonError(503, "unavailable"));
  }
  await auditEvent(principal, {
    actor: "owner", action: "slack_reply.review", target: `exec_slack_reply_drafts:${id}`,
    input: { draftId: id, version, blockers: review.kind === "ok" ? review.blockers.length : 0 },
    result: { outcome: review.kind === "ok" ? "ok" : review.reason }, ok: review.kind === "ok"
  });
  if (review.kind === "ok") {
    const destination = fillP10(SLACK_P10_COPY.replies.destination, { place: review.place, thread: review.inThread ? SLACK_P10_COPY.replies.thread : "" });
    return privateNoStore(jsonAnswer(200, { version: review.version, blockers: review.blockers, destination, place: review.place, inThread: review.inThread }));
  }
  if (review.reason === "not_found") return privateNoStore(jsonError(404, "not_found"));
  return privateNoStore(jsonError(409, "refused", { reason: review.reason, ...(review.status !== undefined ? { status: review.status } : {}) }));
}
