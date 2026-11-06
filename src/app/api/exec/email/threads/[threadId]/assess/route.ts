import { requireExecPrincipal } from "@/lib/exec/access";
import { ASSESS_ROUTE, assessThread } from "@/lib/exec/email-assess";
import { isThreadIdParam } from "@/lib/exec/email-view";
import { assertSameOrigin, jsonError } from "@/lib/exec/http";

// POST /api/exec/email/threads/:id/assess: queue a forced assessment of one
// of his filtered, failed or deferred threads. This file runs the owner gate
// (with the step-up), the same-origin check and the id shape itself (P5a K9,
// boundary rule 13); the rest (email on, the row and its screen, the state,
// the mailbox, the rate limit, the audit, the enqueue) lives in
// lib/exec/email-assess.ts. Any other method gets Next's 405.
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: { threadId: string } }) {
  const gate = await requireExecPrincipal(req, ASSESS_ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  const origin = assertSameOrigin(req);
  if (!origin.ok) return origin.response;
  if (!isThreadIdParam(params.threadId)) return jsonError(400, "bad_thread_id");
  return assessThread(gate.principal, params.threadId, new Date());
}
