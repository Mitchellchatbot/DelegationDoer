import { requireExecPrincipal } from "@/lib/exec/access";
import { DRAFT_BODY_LIMITS, RegenerateBody, answerDraftRoute, parseDraftBody, requestRegeneration, requireDraftId } from "@/lib/exec/drafts";
import { isSameOriginRequest, jsonAnswer, jsonError } from "@/lib/exec/http";

// POST /api/exec/drafts/:id/regenerate (R6: T10-T12): a new generation of the
// same draft; the current content stays until it succeeds (C6).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/exec/drafts/:id/regenerate";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  if (!isSameOriginRequest(req)) return jsonError(403, "forbidden");
  const principal = gate.principal;
  return answerDraftRoute(ROUTE, async () => {
    const id = requireDraftId(params.id);
    const input = await parseDraftBody(req, DRAFT_BODY_LIMITS.other, RegenerateBody);
    const view = await requestRegeneration(principal, id, input);
    return jsonAnswer(202, { ...view });
  });
}
