import { requireExecPrincipal } from "@/lib/exec/access";
import { DRAFT_BODY_LIMITS, ResolveBody, answerDraftRoute, parseDraftBody, requireDraftId, resolveDraft } from "@/lib/exec/drafts";
import { isSameOriginRequest, jsonAnswer, jsonError } from "@/lib/exec/http";

// POST /api/exec/drafts/:id/resolve (R12: T42-T49): his explicit choices on an
// unknown or gone draft (L14), keep the Outlook version (C53), Check again
// (C70) and Stop (C71).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/exec/drafts/:id/resolve";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  if (!isSameOriginRequest(req)) return jsonError(403, "forbidden");
  const principal = gate.principal;
  return answerDraftRoute(ROUTE, async () => {
    const id = requireDraftId(params.id);
    const input = await parseDraftBody(req, DRAFT_BODY_LIMITS.other, ResolveBody);
    const r = await resolveDraft(principal, id, input);
    return jsonAnswer(200, {
      status: r.status,
      newDraftId: r.newDraftId,
      code: r.code,
      ...(r.readBack !== null ? { readBack: r.readBack } : {}),
      ...(r.view !== null ? { view: r.view } : {})
    });
  });
}
