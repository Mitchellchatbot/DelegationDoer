import type { NextResponse } from "next/server";
import { z } from "zod";

import { requireExecPrincipal } from "@/lib/exec/access";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBodyOrError, runAudited, validateBody } from "@/lib/exec/http";
import { P10_LIMITS, type ReplyStatus } from "@/lib/exec/slack-p10-types";
import { getReplyDraft, stepReplyDraft } from "@/lib/exec/slack-reply-store";
import { rerenderReplyCards } from "@/lib/exec/slack-reply-view";

// POST /api/exec/slack/replies/:id/resolve (P10 contract §3.5.12, C37, v1.1 security-7, product-3; Area D): his answer about an
// `unknown` send. "It posted" (X9 → sent, owner_resolution posted) is accepted any time; "It didn't post" (X10 → failed,
// owner_resolution not_posted) only after DD's third read-only check (verify_checks = 3): before it, 409 { error: "too_early",
// until } (X10's own fence repeats the rule in SQL's plain-row CAS). The strong gate → same-origin → the body (≤ 1 KB, zod
// strict { action }) → the send bucket (10 / 10 min, shared with send) → the audit row (slack_reply.resolve). 200 { status };
// 409 { error: "not_unknown", status } for any other status; 404. Nothing here posts. Every answer is private, no-store.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/exec/slack/replies/:id/resolve";
const BODY_LIMIT = 1024;
const DRAFT_ID = /^esr_[0-9a-f]{32}$/;

const ResolveBody = z.object({ action: z.enum(["posted", "not_posted"]) }).strict();

type ResolveOutcome =
  | { outcome: "resolved"; status: ReplyStatus } | { outcome: "not_found" } | { outcome: "not_unknown"; status: ReplyStatus }
  | { outcome: "too_early"; until: string | null } | { outcome: "conflict"; status: ReplyStatus };

function privateNoStore<T extends Response | NextResponse>(res: T): T {
  res.headers.set("cache-control", "private, no-store");
  return res;
}

export async function POST(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return privateNoStore(gate.response);
  const principal = gate.principal;
  const same = assertSameOrigin(req);
  if (!same.ok) return privateNoStore(same.response);
  const id = typeof params?.id === "string" ? params.id : "";
  if (!DRAFT_ID.test(id)) return privateNoStore(jsonError(404, "not_found"));

  const read = await readJsonBodyOrError(req, BODY_LIMIT);
  if (!read.ok) return privateNoStore(read.response);
  const valid = validateBody<z.infer<typeof ResolveBody>>(read.value, ResolveBody);
  if (!valid.ok) return privateNoStore(valid.response);
  const action = valid.value.action;

  const now = new Date();
  const limited = await rateLimit(principal, "slack_reply_send", P10_LIMITS.replySendLimit, P10_LIMITS.replyRouteWindowMs, { now });
  if (!limited.ok) return privateNoStore(limited.response);

  const run = await runAudited<ResolveOutcome>(
    principal,
    { actor: "owner", action: "slack_reply.resolve", target: `exec_slack_reply_drafts:${id}`, input: { draftId: id, action } },
    async () => {
      const row = await getReplyDraft(principal, id);
      if (row === null) return { outcome: "not_found" };
      if (row.status !== "unknown") return { outcome: "not_unknown", status: row.status };
      if (action === "not_posted") {
        // v1.1 security-7 / product-3: "It didn't post" only once DD has checked Slack three times and found nothing.
        if (row.verifyChecks < P10_LIMITS.replyVerifyDelaysMs.length) {
          const sending = row.sendingAt !== null ? Date.parse(row.sendingAt) : Number.NaN;
          return { outcome: "too_early", until: Number.isFinite(sending) ? new Date(sending + P10_LIMITS.replyVerifyHorizonMs).toISOString() : null };
        }
        const moved = await stepReplyDraft(principal, id, { t: "owner_not_posted", at: now.toISOString() }, now);
        return moved ? { outcome: "resolved", status: "failed" } : { outcome: "conflict", status: row.status };
      }
      const moved = await stepReplyDraft(principal, id, { t: "owner_posted", at: now.toISOString() }, now);
      return moved ? { outcome: "resolved", status: "sent" } : { outcome: "conflict", status: row.status };
    },
    (r) => ({ ok: r.outcome === "resolved", outcome: r.outcome })
  );
  if (!run.ok) return privateNoStore(run.response);
  const r = run.value;
  switch (r.outcome) {
    case "resolved":
      await rerenderReplyCards(principal, id, { now });
      return privateNoStore(jsonAnswer(200, { status: r.status }));
    case "not_found":
      return privateNoStore(jsonError(404, "not_found"));
    case "too_early":
      return privateNoStore(jsonError(409, "too_early", { until: r.until }));
    default:
      return privateNoStore(jsonError(409, "not_unknown", { status: r.status }));
  }
}
