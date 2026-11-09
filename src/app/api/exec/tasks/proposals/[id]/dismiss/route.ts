import { requireExecPrincipal } from "@/lib/exec/access";
import { withOwnSignal } from "@/lib/exec/agent/signal";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit } from "@/lib/exec/http";
import { loadSettings } from "@/lib/exec/principal";
import { dismissProposal, type DismissOutcome } from "@/lib/exec/proposals";
import type { ExecSettings } from "@/lib/exec/types";

// POST /api/exec/tasks/proposals/:id/dismiss (P5b contract §3.16.3, §3.17; Area D): set a staged task
// aside. Gate (strong) → same origin → the id's shape (400 bad_request; the body is ignored) → chat on
// (403 chat_off) → 30 decisions per 10 minutes (429 / 503) → the audit row (503 audit_unavailable) →
// dismissProposal: 200 { status: "dismissed" } · 404 not_found · 409 not_pending {status} · 503 unavailable.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/exec/tasks/proposals/:id/dismiss";
const PROPOSAL_ID = /^etp_[0-9a-f]{32}$/;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 600_000;
const ACT_TIMEOUT_MS = 20_000;

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "error");

function answerOf(o: DismissOutcome): Response {
  switch (o.kind) {
    case "dismissed":
      return jsonAnswer(200, { status: "dismissed" });
    case "not_found":
      return jsonError(404, "not_found");
    case "not_pending":
      // ui-8: confirmed elsewhere: the task id, so the card can link the task.
      return jsonError(409, "not_pending", o.taskId ? { status: o.status, taskId: o.taskId } : { status: o.status });
  }
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireExecPrincipal(req, ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  const origin = assertSameOrigin(req);
  if (!origin.ok) return origin.response;
  const principal = gate.principal;
  const proposalId = params?.id;
  if (typeof proposalId !== "string" || !PROPOSAL_ID.test(proposalId)) return jsonError(400, "bad_request");

  let settings: ExecSettings;
  try {
    settings = await loadSettings(principal.id);
  } catch (err) {
    console.error(`[exec-chat] ${ROUTE} ${principal.id}: settings read failed (${errName(err)})`);
    return jsonError(503, "unavailable");
  }
  if (!settings.chatSchemaReady || !settings.chatEnabled) return jsonError(403, "chat_off");

  const now = new Date();
  const limited = await rateLimit(principal, "proposal", RATE_LIMIT, RATE_WINDOW_MS, { now });
  if (!limited.ok) return limited.response;

  let auditId: number;
  try {
    auditId = await auditStart(principal, {
      actor: "owner",
      action: "chat.proposal.dismiss",
      target: `exec_task_proposals:${proposalId}`,
      input: { proposalId }
    });
  } catch {
    // auditStart logged why (it only throws AuditUnavailableError).
    return jsonError(503, "audit_unavailable");
  }

  let outcome: DismissOutcome;
  try {
    outcome = await withOwnSignal(ACT_TIMEOUT_MS, (signal) => dismissProposal(principal, proposalId, now, { signal }));
  } catch (err) {
    console.error(`[exec-chat] ${ROUTE} ${proposalId}: dismiss failed (${errName(err)})`);
    await auditFinish(auditId, { ok: false, result: { outcome: "unavailable" } });
    return jsonError(503, "unavailable");
  }
  await auditFinish(auditId, { ok: outcome.kind === "dismissed", result: { outcome: outcome.kind } });
  return answerOf(outcome);
}
