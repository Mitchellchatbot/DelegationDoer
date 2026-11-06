import { requireExecPrincipal } from "@/lib/exec/access";
import { CreateDraftBody, DRAFT_BODY_LIMITS, answerDraftRoute, createDraft, listDraftItems, parseDraftBody } from "@/lib/exec/drafts";
import { isSameOriginRequest, jsonAnswer, jsonError } from "@/lib/exec/http";

// GET /api/exec/drafts (R1): the Drafts views, DB only (C19, C46); POST (R2):
// create a reply or a new draft (T01-T04). Owner gate with the step-up first,
// same-origin next on the mutation (B11); everything else is drafts.ts's.
// Answers carry ids, statuses and codes; the list carries his own labels.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LIST_ROUTE = "GET /api/exec/drafts";
const CREATE_ROUTE = "POST /api/exec/drafts";
const LIMIT_RE = /^[0-9]{1,3}$/;

export async function GET(req: Request) {
  const gate = await requireExecPrincipal(req, LIST_ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  const principal = gate.principal;
  return answerDraftRoute(LIST_ROUTE, async () => {
    const params = new URL(req.url).searchParams;
    const view = params.get("view") ?? "active";
    if (view !== "active" && view !== "recent" && view !== "all") return jsonError(400, "bad_request");
    const rawLimit = params.get("limit");
    let limit: number | undefined;
    if (rawLimit !== null) {
      if (!LIMIT_RE.test(rawLimit)) return jsonError(400, "bad_request");
      limit = Number(rawLimit);
      if (limit < 1 || limit > 50) return jsonError(400, "bad_request");
    }
    const cursor = params.get("cursor");
    if (cursor !== null && cursor.length > 200) return jsonError(400, "bad_request");
    const page = await listDraftItems(principal, { view, cursor, limit });
    return jsonAnswer(200, { items: page.items, nextCursor: page.nextCursor });
  });
}

export async function POST(req: Request) {
  const gate = await requireExecPrincipal(req, CREATE_ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  if (!isSameOriginRequest(req)) return jsonError(403, "forbidden");
  const principal = gate.principal;
  return answerDraftRoute(CREATE_ROUTE, async () => {
    const input = await parseDraftBody(req, DRAFT_BODY_LIMITS.create, CreateDraftBody);
    const created = await createDraft(principal, input);
    return created.existing
      ? jsonAnswer(200, { id: created.id, status: created.status, existing: true })
      : jsonAnswer(201, { id: created.id, status: created.status });
  });
}
