import { requireExecPrincipal } from "@/lib/exec/access";
import { DRAFT_BODY_LIMITS, ReviewBody, answerDraftRoute, parseDraftBody, requireDraftId, reviewDraft } from "@/lib/exec/drafts";
import { isSameOriginRequest, jsonAnswer, jsonError } from "@/lib/exec/http";

// POST /api/exec/drafts/:id/review (R8: T27-T29): the read-back of the saved
// Outlook draft, checked (recipients, placeholders, the facts gate, the
// blockers), its hash stored for the send that may follow (L10.1).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/exec/drafts/:id/review";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  if (!isSameOriginRequest(req)) return jsonError(403, "forbidden");
  const principal = gate.principal;
  return answerDraftRoute(ROUTE, async () => {
    const id = requireDraftId(params.id);
    const input = await parseDraftBody(req, DRAFT_BODY_LIMITS.other, ReviewBody);
    const result = await reviewDraft(principal, id, input);
    return jsonAnswer(200, { ...result });
  });
}
