import { requireExecPrincipal } from "@/lib/exec/access";
import { DRAFT_BODY_LIMITS, SaveBody, answerDraftRoute, parseDraftBody, requireDraftId, saveDraft } from "@/lib/exec/drafts";
import { isSameOriginRequest, jsonAnswer, jsonError } from "@/lib/exec/http";

// POST /api/exec/drafts/:id/save (R7: T16-T25): save to his Outlook Drafts
// (CL2 create, or recreate for a stale link), in the request, audited first,
// with the clone call's own timeout and never the request's signal (L9).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/exec/drafts/:id/save";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  if (!isSameOriginRequest(req)) return jsonError(403, "forbidden");
  const principal = gate.principal;
  return answerDraftRoute(ROUTE, async () => {
    const id = requireDraftId(params.id);
    const input = await parseDraftBody(req, DRAFT_BODY_LIMITS.other, SaveBody);
    const r = await saveDraft(principal, id, input);
    if (r.status === "saving") return jsonAnswer(202, { status: "saving", code: r.code ?? "outcome_unknown", view: r.view });
    return jsonAnswer(200, {
      status: r.status,
      code: r.code,
      ...(r.readBack !== null ? { readBack: r.readBack } : {}),
      ...(r.retryAfterSec !== undefined ? { retryAfterSec: r.retryAfterSec } : {}),
      view: r.view
    });
  });
}
