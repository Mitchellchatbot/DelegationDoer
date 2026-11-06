import { z } from "zod";
import { requireExecPrincipal } from "@/lib/exec/access";
import { ATTENTION_ITEM_ID, applyOwnerAction, checkSnoozeUntil, isFeedTimestamp, type AttentionPageRow } from "@/lib/exec/attention";
import { attentionFeedItem, screenAttentionItems } from "@/lib/exec/attention-read";
import type { AttentionFeedItem, OwnerAction } from "@/lib/exec/attention-types";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBodyOrError, runAudited, validateBody } from "@/lib/exec/http";
import type { ExecPrincipal } from "@/lib/exec/types";

// PATCH /api/exec/attention/:id (P5a contract §3.6.2, A1, C2-C4): one owner
// action on one Needs Attention item (seen, snooze, dismiss, resolve, reopen),
// a compare-and-set on the version he loaded. In this order, each failing closed:
//   1. owner gate with the step-up            → the gate's 401 / 404 / 503
//   2. same origin                            → 403 forbidden
//   3. the id's shape                         → 404 not_found
//   4. the body: ≤4 KB JSON, strict schema    → 413 too_large / 400 invalid {detail}
//   5. (no setting gates this route)
//   6. 120 actions per 10 minutes             → 429 rate_limited {retryAfterSeconds} / 503
//   7. the audit row, then the action inside it (a conflict, an invalid
//      transition or a missing row finishes the row ok = false) → 503 when
//      the row can't be written
//   8. the returned row through the screen (an email item now withheld comes
//      back as item: null, hidden: true)
//   200 { changed: true|false, item }, 409 { error: "conflict"|"invalid_transition", item }, 404 { error: "not_found" }
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "PATCH /api/exec/attention/:id";
const BODY_MAX_BYTES = 4096;
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 600_000;

const OWNER_ACTIONS = ["seen", "snooze", "dismiss", "resolve", "reopen"] as const satisfies readonly OwnerAction[];
const PatchBody = z
  .object({
    action: z.enum(OWNER_ACTIONS),
    snoozeUntil: z.string().max(64).optional(),
    expectedUpdatedAt: z.string().min(1).max(64).refine(isFeedTimestamp)
  })
  .strict();

/** The row as the response shows it: screened (C3); null when the screen withholds it now. */
async function shownItem(principal: ExecPrincipal, row: AttentionPageRow, now: Date): Promise<AttentionFeedItem | null> {
  try {
    const screened = await screenAttentionItems(principal, [attentionFeedItem(row, now)]);
    return screened.items[0] ?? null;
  } catch {
    return null;
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  const origin = assertSameOrigin(req);
  if (!origin.ok) return origin.response;
  const principal = gate.principal;
  const itemId = params.id;
  if (typeof itemId !== "string" || !ATTENTION_ITEM_ID.test(itemId)) return jsonError(404, "not_found");

  const body = await readJsonBodyOrError(req, BODY_MAX_BYTES);
  if (!body.ok) return body.response;
  const parsed = validateBody(body.value, PatchBody);
  if (!parsed.ok) return parsed.response;
  const { action, expectedUpdatedAt } = parsed.value;
  const now = new Date();
  // C4: snoozeUntil goes with a snooze, and only then: more than a minute and at most 90 days ahead.
  let snoozeUntil: string | undefined;
  if (action === "snooze") {
    try {
      snoozeUntil = checkSnoozeUntil(parsed.value.snoozeUntil, now);
    } catch {
      return jsonError(400, "invalid", { detail: "snoozeUntil" });
    }
  } else if (parsed.value.snoozeUntil !== undefined) {
    return jsonError(400, "invalid", { detail: "snoozeUntil" });
  }

  const limited = await rateLimit(principal, "attention_action", RATE_LIMIT, RATE_WINDOW_MS, { now });
  if (!limited.ok) return limited.response;

  const audited = await runAudited(
    principal,
    { actor: "owner", action: `attention.${action}`, target: `exec_attention_items:${itemId}`, input: { action, snoozeUntil: snoozeUntil ?? null } },
    () => applyOwnerAction(principal, itemId, action, { snoozeUntil, expectedUpdatedAt, now }),
    (r) => ({ ok: r.outcome === "applied" || r.outcome === "unchanged", outcome: r.outcome })
  );
  if (!audited.ok) return audited.response;
  const result = audited.value;
  if (result.outcome === "not_found") return jsonError(404, "not_found");

  const item = await shownItem(principal, result.row, now);
  const itemPart = item === null ? { item: null, hidden: true } : { item };
  switch (result.outcome) {
    case "applied":
      return jsonAnswer(200, { changed: true, ...itemPart });
    case "unchanged":
      return jsonAnswer(200, { changed: false, ...itemPart });
    case "conflict":
      return jsonError(409, "conflict", itemPart);
    case "invalid_transition":
      return jsonError(409, "invalid_transition", itemPart);
  }
}
