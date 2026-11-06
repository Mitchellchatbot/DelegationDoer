import { createHash } from "node:crypto";
import type { NextResponse } from "next/server";
import { requireExecPrincipal } from "@/lib/exec/access";
import { auditFinish, auditStart } from "@/lib/exec/audit";
import { findPlaceholders } from "@/lib/exec/drafts-doc";
import { applyDraftPatch, auditCode, graphIdFp, guard, mapSendResult, newKeyNonce, nextCheckAt, sendKey, type DraftPatch } from "@/lib/exec/drafts-state";
import { casDraft, getDraft } from "@/lib/exec/drafts-store";
import { DRAFT_LIMITS } from "@/lib/exec/drafts-types";
import {
  DRAFT_BODY_LIMITS,
  SendBody,
  answerDraftRoute,
  clearReview,
  draftsSwitchedOn,
  loadDraftGates,
  loadRowOrThrow,
  parseDraftBody,
  requireDraftId,
  requireDraftsOn,
  requireInstalled,
  requireRateLimit,
  requireUsableAccount,
  screenOrPurge,
  sendRecipientContext,
  sendUnavailableFor,
  transitionOptions
} from "@/lib/exec/drafts";
import { alertTransition, casTransition, draftReconcileKick, KICK_DELAY_MS } from "@/lib/exec/handlers/draft-reconcile";
import { isSameOriginRequest, jsonAnswer, jsonError } from "@/lib/exec/http";
import { enqueueJob } from "@/lib/exec/jobs";
import { checkRecipients, recipientsSignature } from "@/lib/exec/recipients";
import { sendSavedDraft, sendTokenReadiness, type SendOutcome } from "@/lib/exec/send";
import { getEaReadiness, peekEaReadiness, type EaReadiness } from "@/lib/exec/sources/mail";
import type { ExecPrincipal } from "@/lib/exec/types";

// GET /api/exec/drafts/:id/send (R9, C36): is Send ready for this draft, and
// why not; the only place outside a send that runs sendTokenReadiness (it
// writes the clone-ea/send-token verdict). POST (R10): send exactly the
// reviewed Outlook draft, once (L10, §3.12.4).
//
// The send flow lives in this file because only it may import send.ts (B3).
// Its order is fixed: the gate and same-origin, the body, the switches, the
// rate limit, readiness (EA, the clone's send switch, the send token), the
// row and its account, the screens with fresh rules, the guards (the review's
// hash, age and Outlook stamp, the acks, placeholders), the recipients again
// with fresh rules, the audit row (fails closed), the counted CAS saved ->
// sending, ONE sendSavedDraft call (no retry, no GET in between, the stored
// review hash as the confirm hash, never the request's signal), the CAS of the
// mapped outcome on the attempt key, the audit finish, the kick. Answers carry
// a status and a code, never clone text, a token, the read-back or recipients.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROBE_ROUTE = "GET /api/exec/drafts/:id/send";
const SEND_ROUTE = "POST /api/exec/drafts/:id/send";

const errorName = (err: unknown): string => (err instanceof Error && err.name !== "" ? err.name : "error");

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireExecPrincipal(req, PROBE_ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  const principal = gate.principal;
  return answerDraftRoute(PROBE_ROUTE, async () => {
    const id = requireDraftId(params.id);
    const gates = await loadDraftGates(principal);
    requireInstalled(gates);
    await loadRowOrThrow(principal, id);
    const token = sendTokenReadiness(principal);
    let ea: EaReadiness | null = null;
    try {
      ea = await peekEaReadiness(principal);
    } catch {
      ea = null;
    }
    if (ea === null || !ea.ok) {
      // ui-2: a missing or failed verdict is proven again here, so a clone or token that recovered gives the
      // capabilities back (the view itself stays DB-only, C19). getEaReadiness's 60 s failure cache bounds this to
      // one /api/auth/me check a minute; it never touches Graph.
      try {
        ea = await getEaReadiness(principal);
      } catch (err) {
        console.warn(`[exec-drafts] ${PROBE_ROUTE}: readiness could not be re-checked (${errorName(err)})`);
      }
    }
    let reason = sendUnavailableFor(gates.settings, ea, token);
    if (reason === null && !draftsSwitchedOn(gates, principal)) reason = "send_off";
    // draftsReady (additive): the EA verdict on its own, for the panel's "drafts unavailable" re-check.
    return jsonAnswer(200, { sendReady: reason === null, reason, draftsReady: ea !== null && ea.ok });
  });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const gate = await requireExecPrincipal(req, SEND_ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  if (!isSameOriginRequest(req)) return jsonError(403, "forbidden");
  const principal = gate.principal;
  return answerDraftRoute(SEND_ROUTE, () => sendDraft(principal, req, params.id));
}

async function sendDraft(principal: ExecPrincipal, req: Request, rawId: string): Promise<NextResponse> {
  const now = new Date();
  // 3-4. G3 and G4 (≤ 8 KB, zod).
  const id = requireDraftId(rawId);
  const body = await parseDraftBody(req, DRAFT_BODY_LIMITS.other, SendBody);

  // 5. G5 / G5b: installed, drafts on, send on.
  const gates = await loadDraftGates(principal);
  requireInstalled(gates);
  requireDraftsOn(gates, principal, { send: true });

  // 6. G7: at most 10 sends in 10 minutes.
  await requireRateLimit(principal, "draft.send", now);

  // 7. G8: EA readiness, the clone's send switch for his accounts, the send token.
  let ea: EaReadiness;
  try {
    ea = await getEaReadiness(principal);
  } catch (err) {
    console.warn(`[exec-drafts] ${SEND_ROUTE}: readiness could not be checked (${errorName(err)})`);
    return jsonError(503, "unavailable");
  }
  if (!ea.ok) return jsonError(409, "send_unavailable", { reason: ea.reason ?? "clone_unreachable" });
  if (ea.cl2Send === "off" || ea.cl2Send === null || !ea.sendEnabled) return jsonError(409, "send_unavailable", { reason: "clone_send_off" });
  if (!sendTokenReadiness(principal, now).ok) return jsonError(409, "send_unavailable", { reason: "send_token" });

  // 8. G9 + G6: the row, and its account still usable.
  const loaded = await loadRowOrThrow(principal, id);
  requireUsableAccount(gates, loaded.accountId);

  // 9. G10: the screens with freshly loaded rules; restricted → purged (T54), 404.
  const screened = await screenOrPurge(principal, loaded);
  if (screened.restricted) return jsonError(404, "not_found");
  const row = screened.row;

  // 10. G11: saved, linked, current, not purged, no doubt about an earlier send; then the review.
  const g = guard("send", row, { now, draftsOn: true, sendOn: true, draftsReady: true, sendReady: true, restricted: false });
  if (!g.ok && g.code !== "review_required" && g.code !== "review_expired") {
    return jsonError(g.code === "not_found" ? 404 : 409, g.code, g.code === "state_conflict" ? { status: row.status } : {});
  }
  if (row.reviewHash === null || row.reviewHash !== body.reviewHash) return jsonError(409, "review_required");
  if (!g.ok) return jsonError(409, g.code);
  const missing = row.reviewBlockers.filter((b) => !body.acks.includes(b));
  if (missing.length > 0) return jsonError(409, "acks_missing", { blockers: missing });
  const placeholders = findPlaceholders(`${row.bodyText ?? ""}${row.kind === "new" && row.subject !== null ? `\n${row.subject}` : ""}`);
  if (placeholders.length > 0) return jsonError(422, "placeholders", { placeholders });

  // 11. The reviewed recipients again, with fresh rules; a refusal clears the review.
  const reviewed = row.reviewRecipients;
  if (reviewed === null) return jsonError(409, "review_required");
  const check = checkRecipients(
    { to: reviewed.to, cc: reviewed.cc, bcc: reviewed.bcc, from: reviewed.from, sender: reviewed.sender, replyTo: reviewed.replyTo },
    sendRecipientContext(row, gates, screened.policy.rules)
  );
  if (!check.ok) {
    await clearReview(principal, row, now);
    return jsonError(422, "recipients_blocked", { errors: check.errors.map((e) => ({ code: e.code, address: e.address })) });
  }

  // 12. The audit row first; an outage answers 503 audit_unavailable and nothing else runs.
  const graphId = row.outlookGraphId as string;
  const confirmHash = row.reviewHash;
  const auditId = await auditStart(principal, {
    actor: "owner",
    action: "draft.send",
    target: `exec_drafts:${id}`,
    input: {
      draftId: id,
      version: row.version,
      graphIdFp: graphIdFp(graphId),
      reviewHashPrefix: confirmHash.slice(0, 12),
      recipientCount: reviewed.to.length + reviewed.cc.length + reviewed.bcc.length,
      externalDomainCount: check.warnings.filter((w) => w.code === "external_domain").length,
      acks: [...body.acks]
    }
  });

  // 13. T30: the counted CAS saved → sending on (id, principal, status, version, review_hash). A double click loses here.
  const key = sendKey(id, row.version, newKeyNonce());
  // data-5 (C4): the attempt's clock starts at the CAS, not at the request, so the checks before it (readiness,
  // the screens, the audit row) never eat into the stale sweep's margin over the 150 s send.
  const casAt = new Date();
  const sendingPatch: DraftPatch = {
    status: "sending",
    prior_status: null,
    confirm_hash: confirmHash,
    send_attempt_key: key,
    send_started_at: casAt.toISOString(),
    sent_audit_id: auditId,
    // ui-9 (L10): the recipients he confirmed are the ones the clone sends (the reviewed read-back), so they are
    // what the row keeps: the sent banner and chips name them, not DD's earlier list (an Outlook edit may differ).
    to_recipients: reviewed.to,
    cc_recipients: reviewed.cc,
    bcc_recipients: reviewed.bcc,
    recipients_sig: recipientsSignature({ to: reviewed.to, cc: reviewed.cc, bcc: reviewed.bcc }),
    check_count: 0,
    last_error_code: null,
    last_error_at: null,
    next_check_at: new Date(casAt.getTime() + DRAFT_LIMITS.sendingStaleMs).toISOString(),
    updated_at: casAt.toISOString()
  };
  if (!(await casDraft(principal, id, { status: "saved", version: row.version, reviewHash: confirmHash }, sendingPatch))) {
    await auditFinish(auditId, { ok: false, error: "not_saved" });
    const current = await getDraft(principal, id);
    return jsonError(409, "state_conflict", { status: current?.status ?? null });
  }
  const sending = applyDraftPatch(row, sendingPatch);

  // 14. Exactly one send; send.ts's own 150 s timeout; never the request's signal.
  let outcome: SendOutcome;
  try {
    outcome = await sendSavedDraft(principal, { accountId: row.accountId, graphId, confirmHash, idempotencyKey: key });
  } catch (err) {
    // send.ts refuses before any fetch (its own readiness re-check): nothing was sent; back to saved, the review kept.
    console.warn(`[exec-drafts] ${id}: the send was refused before any request (${errorName(err)})`);
    const base: DraftPatch = { status: "saved", last_error_code: "send_unavailable", last_error_at: now.toISOString(), updated_at: now.toISOString() };
    await casDraft(principal, id, { status: ["sending", "unknown"], sendAttemptKey: key }, { ...base, next_check_at: nextCheckAt(applyDraftPatch(sending, base), now) });
    await auditFinish(auditId, { ok: false, error: "send_unavailable" });
    return jsonError(409, "send_unavailable", { reason: "send_token" });
  }

  // 15. §2.6.5 (its default included: an unlisted answer is unknown, never saved) → the CAS on the attempt key.
  const t = mapSendResult(sending, outcome, now, transitionOptions(gates));
  const landed = await casTransition(principal, sending, t, now, null);
  if (landed === "missed") console.warn(`[exec-drafts] ${id}: the send outcome lost its CAS (the row moved on)`);

  // 16. The audit finish (never throws).
  const failure = outcome.kind === "error" ? outcome.error : null;
  const ok = t.to === "sent_pending" || t.to === "sent";
  await auditFinish(auditId, {
    ok,
    result: {
      outcome: t.to,
      code: t.code,
      httpStatus: failure === null ? 202 : failure.status,
      draftStatus: failure === null ? null : failure.draftStatus,
      replay: outcome.kind === "accepted" ? outcome.replay : failure !== null && failure.replay
    },
    error: ok ? undefined : auditCode(t.code)
  });

  // 17. The kick (C18) and the row's ops alert, both best-effort.
  if (t.to === "sent_pending" || t.to === "unknown") {
    const tag = `a${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16)}`;
    try {
      await enqueueJob(draftReconcileKick(principal, new Date(now.getTime() + KICK_DELAY_MS), tag));
    } catch (err) {
      console.warn(`[exec-drafts] ${id}: the reconcile kick was not queued (${errorName(err)})`);
    }
  }
  alertTransition(t, id, "send");

  // 18. The answer: a status and a code.
  if (t.to === "sent_pending" && t.code === "accepted") return jsonAnswer(202, { status: "sent_pending", code: "accepted" });
  const retryAfterSec = failure !== null && failure.kind === "throttled" && failure.retryAfterMs !== null
    ? Math.max(1, Math.ceil(failure.retryAfterMs / 1000))
    : null;
  return jsonAnswer(200, { status: t.to, code: t.code, ...(retryAfterSec !== null ? { retryAfterSec } : {}) });
}
