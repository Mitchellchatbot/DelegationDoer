import { requireExecPrincipal } from "@/lib/exec/access";
import { withOwnSignal } from "@/lib/exec/agent/signal";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import { assertSameOrigin, jsonAnswer, jsonError, rateLimit, readJsonBody } from "@/lib/exec/http";
import { loadSettings } from "@/lib/exec/principal";
import { confirmProposal, type ConfirmOutcome } from "@/lib/exec/proposals";
import type { ExecSettings } from "@/lib/exec/types";

// POST /api/exec/tasks/proposals/:id/confirm (P5b contract §3.16.3, §3.17, B2, C22, C23, C43; Area D):
// create the task a chat answer staged, exactly as its card showed it. In this order, each failing closed:
//   1. owner gate with the step-up            → the gate's 401 / 404 / 503
//   2. same origin                            → 403 forbidden
//   3. the id's shape; the body { contentHash } (≤ 1 KB, exact keys) → 400 bad_request
//   4. settings: chat installed and on        → 503 unavailable / 403 chat_off
//   5. 30 decisions per 10 minutes            → 429 rate_limited {retryAfterSeconds} / 503 unavailable
//   6. the audit row (ids only: never the title or the description) → 503 audit_unavailable
//   7. confirmProposal: 200 { status: "confirmed", taskId, taskHref } · 404 not_found ·
//      409 changed {proposal} · 409 not_pending {status} · 409 in_progress · 410 expired ·
//      409 assignee_unavailable · 503 unavailable
// The confirm runs on its own controller, not the request's: a click that leaves mid-way must not stop
// a write half-done (the state machine resumes either way).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/exec/tasks/proposals/:id/confirm";
const PROPOSAL_ID = /^etp_[0-9a-f]{32}$/;
const CONTENT_HASH = /^[0-9a-f]{64}$/;
const BODY_MAX_BYTES = 1024;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 600_000;
const ACT_TIMEOUT_MS = 20_000;

const errName = (err: unknown): string => (err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "error");

/** { contentHash: <64 hex> } and nothing else. */
function parseConfirmBody(v: unknown): string | null {
  if (typeof v !== "object" || v === null || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== "contentHash") return null;
  const hash = (v as { contentHash?: unknown }).contentHash;
  return typeof hash === "string" && CONTENT_HASH.test(hash) ? hash : null;
}

function answerOf(o: ConfirmOutcome): Response {
  switch (o.kind) {
    case "confirmed":
      return jsonAnswer(200, { status: "confirmed", taskId: o.taskId, taskHref: `/tasks/${encodeURIComponent(o.taskId)}` });
    case "not_found":
      return jsonError(404, "not_found");
    case "changed":
      return jsonError(409, "changed", { proposal: o.proposal });
    case "not_pending":
      return jsonError(409, "not_pending", { status: o.status });
    case "in_progress":
      return jsonError(409, "in_progress");
    case "expired":
      return jsonError(410, "expired");
    case "assignee_unavailable":
      return jsonError(409, "assignee_unavailable");
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
  const read = await readJsonBody(req, BODY_MAX_BYTES);
  if (!read.ok) return jsonError(400, "bad_request");
  const contentHash = parseConfirmBody(read.value);
  if (contentHash === null) return jsonError(400, "bad_request");

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
      action: "chat.proposal.confirm",
      target: `exec_task_proposals:${proposalId}`,
      input: { proposalId }
    });
  } catch {
    // auditStart logged why (it only throws AuditUnavailableError).
    return jsonError(503, "audit_unavailable");
  }

  let outcome: ConfirmOutcome;
  try {
    outcome = await withOwnSignal(ACT_TIMEOUT_MS, (signal) => confirmProposal(principal, proposalId, now, { contentHash, signal }));
  } catch (err) {
    console.error(`[exec-chat] ${ROUTE} ${proposalId}: confirm failed (${errName(err)})`);
    await auditFinish(auditId, { ok: false, result: { outcome: "unavailable" } });
    return jsonError(503, "unavailable");
  }
  await auditFinish(auditId, {
    ok: outcome.kind === "confirmed",
    result: outcome.kind === "confirmed" ? { outcome: outcome.kind, taskId: outcome.taskId } : { outcome: outcome.kind }
  });
  return answerOf(outcome);
}
