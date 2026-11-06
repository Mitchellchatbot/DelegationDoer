import { requireExecPrincipal } from "@/lib/exec/access";
import { DRAFT_BODY_LIMITS, OutlookOpenedBody, answerDraftRoute, markOutlookOpened, parseDraftBody, requireDraftId } from "@/lib/exec/drafts";
import { isSameOriginRequest, jsonAnswer, jsonError } from "@/lib/exec/http";

// POST /api/exec/drafts/:id/outlook-opened (R11: T41): the Open in Outlook
// button stamps the row before it navigates (C69): the review is cleared, the
// follow-up checks are scheduled and the sweep is kicked.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/exec/drafts/:id/outlook-opened";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  if (!isSameOriginRequest(req)) return jsonError(403, "forbidden");
  const principal = gate.principal;
  return answerDraftRoute(ROUTE, async () => {
    const id = requireDraftId(params.id);
    await parseDraftBody(req, DRAFT_BODY_LIMITS.other, OutlookOpenedBody);
    const view = await markOutlookOpened(principal, id);
    return jsonAnswer(200, { ...view });
  });
}
