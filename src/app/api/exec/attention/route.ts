import { requireExecPrincipal } from "@/lib/exec/access";
import { decodeAttentionCursor, listScreenedAttention, parseAttentionFilters } from "@/lib/exec/attention-read";
import { jsonAnswer, jsonError } from "@/lib/exec/http";

// GET /api/exec/attention (P5a contract §3.6.1, S3): one page of his Needs
// Attention feed through the screened accessor, for the full feed's "Load
// more" and the filters. Owner gate with the step-up first; a read, so no
// same-origin check, no audit row (the access log has it) and no rate limit.
//   400 {error:"invalid", detail:"<param>"}  a bad or repeated query parameter
//   400 {error:"invalid_cursor"}             a cursor made for other filters, or edited
//   503 {error:"unavailable"}                the store couldn't be read
//   200 { generatedAt, items, nextCursor, hiddenEmail, emailScreen }
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "GET /api/exec/attention";
const PARAMS = ["status", "category", "band", "source", "kind", "firstSeenAfter", "updatedAfter", "cursor", "limit"] as const;
const READ_TIMEOUT_MS = 15_000;

export async function GET(req: Request) {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  const principal = gate.principal;

  const query = new URL(req.url).searchParams;
  const input: Record<string, string | undefined> = {};
  for (const name of PARAMS) {
    const values = query.getAll(name);
    if (values.length > 1) return jsonError(400, "invalid", { detail: name });
    input[name] = values[0];
  }
  const parsed = parseAttentionFilters(input);
  if (!parsed.ok) return jsonError(400, "invalid", { detail: parsed.detail });
  const filters = parsed.filters;
  if (typeof filters.cursor === "string" && decodeAttentionCursor(filters.cursor, filters) === null) return jsonError(400, "invalid_cursor");

  const now = new Date();
  try {
    const page = await listScreenedAttention(principal, filters, { now, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    return jsonAnswer(200, {
      generatedAt: now.toISOString(),
      items: page.items,
      nextCursor: page.nextCursor,
      hiddenEmail: page.hiddenEmail,
      emailScreen: page.emailScreen
    });
  } catch (err) {
    console.error(`[exec-attention-route] ${ROUTE} for ${principal.id}: unavailable (${err instanceof Error ? err.name : "error"})`);
    return jsonError(503, "unavailable");
  }
}
