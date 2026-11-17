import type { NextResponse } from "next/server";
import { z } from "zod";

import { requireExecPrincipal } from "@/lib/exec/access";
import { findPlaceholders } from "@/lib/exec/drafts-doc";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBodyOrError, runAudited, validateBody } from "@/lib/exec/http";
import { loadSettings } from "@/lib/exec/principal";
import { P10_LIMITS } from "@/lib/exec/slack-p10-types";
import { editReplyDraft, replySchemaReady } from "@/lib/exec/slack-reply-store";
import { getReplyDraftPageView, rerenderReplyCards } from "@/lib/exec/slack-reply-view";
import { sanitizeChars } from "@/lib/exec/slack-ui";

// GET / PATCH /api/exec/slack/replies/:id (P10 contract §3.5.12, C34, C49; Area D).
//
//   GET    the reply page's view (getReplyDraftPageView: DB reads only, never a Slack call); 404 when there is no such draft
//          of his.
//   PATCH  his edit: the strong gate → same-origin → the body (≤ 16 KB, zod strict { version 1..9999, text 1..4,000 }) → the
//          edit bucket (60 / 10 min) → the audit row (slack_reply.edit; the id, the version and a length) → RPC 16 with the
//          stored form sanitizeChars(NFC(text)) (C34) and its placeholders recomputed; 200 { version }; 409 { status, version }
//          on a lost CAS; 404. The DM cards follow the new text.
//
// Every answer is Cache-Control: private, no-store; nothing here logs the text.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GET_ROUTE = "GET /api/exec/slack/replies/:id";
const PATCH_ROUTE = "PATCH /api/exec/slack/replies/:id";
const BODY_LIMIT = 16_384;
const DRAFT_ID = /^esr_[0-9a-f]{32}$/;
const DAY_MS = 86_400_000;

const EditBody = z.object({
  version: z.number().int().min(1).max(9999),
  text: z.string().min(1).max(P10_LIMITS.replyTextChars)
}).strict();

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(err.name) ? err.name : "error");

function privateNoStore<T extends Response | NextResponse>(res: T): T {
  res.headers.set("cache-control", "private, no-store");
  return res;
}

export async function GET(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const gate = await requireExecPrincipal(req, GET_ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return privateNoStore(gate.response);
  try {
    const view = await getReplyDraftPageView(gate.principal, typeof params?.id === "string" ? params.id : "", new Date());
    if (view.state === "not_found") return privateNoStore(jsonError(404, "not_found"));
    return privateNoStore(jsonAnswer(200, { ...view }));
  } catch (err) {
    console.error(`[exec-slack-reply] ${GET_ROUTE} unavailable for ${gate.principal.id} (${errName(err)})`);
    return privateNoStore(jsonError(503, "unavailable"));
  }
}

type EditOutcome =
  | { outcome: "updated"; version: number } | { outcome: "conflict"; status: string; version: number } | { outcome: "not_found" }
  | { outcome: "not_installed" };

export async function PATCH(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const gate = await requireExecPrincipal(req, PATCH_ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return privateNoStore(gate.response);
  const principal = gate.principal;
  const same = assertSameOrigin(req);
  if (!same.ok) return privateNoStore(same.response);
  const id = typeof params?.id === "string" ? params.id : "";
  if (!DRAFT_ID.test(id)) return privateNoStore(jsonError(404, "not_found"));

  const read = await readJsonBodyOrError(req, BODY_LIMIT);
  if (!read.ok) return privateNoStore(read.response);
  const valid = validateBody<z.infer<typeof EditBody>>(read.value, EditBody);
  if (!valid.ok) return privateNoStore(valid.response);
  // C34: what is stored (and later posted, and shown on the card he confirms on) is exactly this form.
  const stored = sanitizeChars(valid.value.text.normalize("NFC"));
  if (stored.trim().length === 0 || stored.length > P10_LIMITS.replyTextChars) return privateNoStore(jsonError(400, "invalid", { detail: "text" }));

  const now = new Date();
  try {
    const settings = await loadSettings(principal.id);
    if (!settings.slackP10SchemaReady || !(await replySchemaReady())) return privateNoStore(jsonError(409, "not_installed"));
  } catch (err) {
    console.error(`[exec-slack-reply] ${PATCH_ROUTE} unavailable for ${principal.id} (${errName(err)})`);
    return privateNoStore(jsonError(503, "unavailable"));
  }
  const limited = await rateLimit(principal, "slack_reply_edit", P10_LIMITS.replyEditLimit, P10_LIMITS.replyRouteWindowMs, { now });
  if (!limited.ok) return privateNoStore(limited.response);

  const run = await runAudited<EditOutcome>(
    principal,
    { actor: "owner", action: "slack_reply.edit", target: `exec_slack_reply_drafts:${id}`, input: { draftId: id, version: valid.value.version, textChars: stored.length } },
    () => editReplyDraft(principal, id, valid.value.version, stored, findPlaceholders(stored), new Date(now.getTime() + P10_LIMITS.replyIdleDays * DAY_MS)),
    (r) => ({ ok: r.outcome === "updated", outcome: r.outcome })
  );
  if (!run.ok) return privateNoStore(run.response);
  const r = run.value;
  switch (r.outcome) {
    case "updated":
      await rerenderReplyCards(principal, id, { now });
      return privateNoStore(jsonAnswer(200, { version: r.version }));
    case "conflict":
      return privateNoStore(jsonError(409, "conflict", { status: r.status, version: r.version }));
    case "not_found":
      return privateNoStore(jsonError(404, "not_found"));
    default:
      return privateNoStore(jsonError(409, "not_installed"));
  }
}
