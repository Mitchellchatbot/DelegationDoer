import { z } from "zod";
import { requireExecPrincipal } from "@/lib/exec/access";
import { ATTENTION_ITEM_ID, getAttentionItemIdentity } from "@/lib/exec/attention";
import { FEEDBACK_REASONS, isValidFeedback, recordAttentionFeedback } from "@/lib/exec/attention-feedback";
import type { FeedbackReason } from "@/lib/exec/attention-types";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBodyOrError, runAudited, validateBody } from "@/lib/exec/http";
import { loadSettings } from "@/lib/exec/principal";

// POST /api/exec/attention/:id/feedback (P5a contract §3.6.3, A1, C10): his
// thumbs up or down on one item, with an optional reason code. Ids and enums
// only are stored and audited. In this order, each failing closed:
//   1. owner gate with the step-up            → the gate's 401 / 404 / 503
//   2. same origin                            → 403 forbidden
//   3. the id's shape                         → 404 not_found
//   4. the body: ≤4 KB JSON, strict schema, the vote/reason pairing
//                                             → 413 too_large / 400 invalid {detail}
//   5. the P5a migration applied (settings.ddtextSchemaReady) → 409 not_installed
//   6. 60 per 10 minutes                      → 429 rate_limited {retryAfterSeconds} / 503
//   7. the item's kind (for the audit row; no item → 404 not_found, nothing audited),
//      then the audit row and the write inside it (503 when the row can't be written)
//   200 { itemId, vote, reason }
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/exec/attention/:id/feedback";
const BODY_MAX_BYTES = 4096;
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 600_000;

const FeedbackBody = z
  .object({
    vote: z.union([z.literal(1), z.literal(-1)]),
    reason: z.enum(FEEDBACK_REASONS as [FeedbackReason, ...FeedbackReason[]]).nullable().optional()
  })
  .strict();

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  const origin = assertSameOrigin(req);
  if (!origin.ok) return origin.response;
  const principal = gate.principal;
  const itemId = params.id;
  if (typeof itemId !== "string" || !ATTENTION_ITEM_ID.test(itemId)) return jsonError(404, "not_found");

  const body = await readJsonBodyOrError(req, BODY_MAX_BYTES);
  if (!body.ok) return body.response;
  const parsed = validateBody(body.value, FeedbackBody);
  if (!parsed.ok) return parsed.response;
  const vote = parsed.value.vote;
  const reason: FeedbackReason | null = parsed.value.reason ?? null;
  // C10: "useful" goes with +1, every other reason with -1.
  if (!isValidFeedback(vote, reason)) return jsonError(400, "invalid", { detail: "reason" });

  const now = new Date();
  try {
    const settings = await loadSettings(principal.id);
    if (!settings.ddtextSchemaReady) return jsonError(409, "not_installed");
  } catch (err) {
    console.error(`[exec-attention-route] ${ROUTE} for ${principal.id}: settings unreadable (${err instanceof Error ? err.name : "error"})`);
    return jsonError(503, "unavailable");
  }

  const limited = await rateLimit(principal, "attention_feedback", RATE_LIMIT, RATE_WINDOW_MS, { now });
  if (!limited.ok) return limited.response;

  let kind: string;
  try {
    const identity = await getAttentionItemIdentity(principal, itemId);
    if (identity === null) return jsonError(404, "not_found");
    kind = identity.kind;
  } catch (err) {
    console.error(`[exec-attention-route] ${ROUTE} for ${principal.id}: item unreadable (${err instanceof Error ? err.name : "error"})`);
    return jsonError(503, "unavailable");
  }

  const audited = await runAudited(
    principal,
    { actor: "owner", action: "attention.feedback", target: `exec_attention_items:${itemId}`, input: { vote, reason, kind } },
    () => recordAttentionFeedback(principal, itemId, { vote, reason }, { now }),
    (r) => ({ ok: r.outcome === "recorded", outcome: r.outcome })
  );
  if (!audited.ok) return audited.response;
  const result = audited.value;
  if (result.outcome === "not_found") return jsonError(404, "not_found");
  return jsonAnswer(200, { itemId: result.itemId, vote: result.vote, reason: result.reason });
}
