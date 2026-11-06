import { requireExecPrincipal } from "@/lib/exec/access";
import {
  DRAFT_BODY_LIMITS,
  DiscardBody,
  EditDraftBody,
  answerDraftRoute,
  discardDraft,
  editDraft,
  getDraftView,
  parseDraftBody,
  requireDraftId
} from "@/lib/exec/drafts";
import { isSameOriginRequest, jsonAnswer, jsonError } from "@/lib/exec/http";

// GET /api/exec/drafts/:id (R3, DB only, C19), PATCH (R4: edit, T13-T15) and
// DELETE (R5: discard, T36-T39; a restricted saved draft's Delete, T59).
// Owner gate with the step-up first, same-origin next on the mutations (B11).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VIEW_ROUTE = "GET /api/exec/drafts/:id";
const EDIT_ROUTE = "PATCH /api/exec/drafts/:id";
const DISCARD_ROUTE = "DELETE /api/exec/drafts/:id";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireExecPrincipal(req, VIEW_ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  const principal = gate.principal;
  return answerDraftRoute(VIEW_ROUTE, async () => {
    const id = requireDraftId(params.id);
    const view = await getDraftView(principal, id);
    if (view === null) return jsonError(404, "not_found");
    return jsonAnswer(200, { ...view });
  });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireExecPrincipal(req, EDIT_ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  if (!isSameOriginRequest(req)) return jsonError(403, "forbidden");
  const principal = gate.principal;
  return answerDraftRoute(EDIT_ROUTE, async () => {
    const id = requireDraftId(params.id);
    const input = await parseDraftBody(req, DRAFT_BODY_LIMITS.patch, EditDraftBody);
    const view = await editDraft(principal, id, input);
    return jsonAnswer(200, { ...view });
  });
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireExecPrincipal(req, DISCARD_ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  if (!isSameOriginRequest(req)) return jsonError(403, "forbidden");
  const principal = gate.principal;
  return answerDraftRoute(DISCARD_ROUTE, async () => {
    const id = requireDraftId(params.id);
    const input = await parseDraftBody(req, DRAFT_BODY_LIMITS.other, DiscardBody);
    const r = await discardDraft(principal, id, input);
    return jsonAnswer(200, { status: r.status, code: r.code, readBack: r.readBack, view: r.view });
  });
}
