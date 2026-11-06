import "server-only";

import { NextResponse } from "next/server";
import { withAudit } from "@/lib/exec/audit";
import { getEmailThread } from "@/lib/exec/email-store";
import { rateLimit } from "@/lib/exec/http";
import { isAssessableState, isThreadIdParam, loadEmailGate } from "@/lib/exec/email-view";
import { enqueueJob, retriageKey, triageJob } from "@/lib/exec/jobs";
import { loadScreeningPolicy, screenStoredRow, usableAccounts } from "@/lib/exec/sources/mail";
import { getSyncState, parseAccountsState, problemAccountIds } from "@/lib/exec/sync-state";
import { AuditUnavailableError, type ExecPrincipal } from "@/lib/exec/types";

// POST /api/exec/email/threads/:id/assess (contract §3.14, L18, coherence-21;
// P5a K9): "assess this thread now", the one write on the email pages. It
// queues one forced triage job on the interactive lane and nothing else; the
// handler re-reads, re-screens and decides.
//
// Checks, in this order, each failing closed. The route file itself runs the
// first three (boundary rule 13 sees the gate and the same-origin call there):
//   1. the owner gate with the step-up (a password or MFA session; a link
//      session gets the same 404 as everyone else);
//   2. same origin (http.ts's isSameOriginRequest, through assertSameOrigin):
//      403 forbidden;
//   3. the thread id's shape (checked again here);
// then assessThread:
//   4. email installed, on and pinned;
//   5. a stored row he may see: not missing, not a tombstone, not gone, and
//      passing the restricted-sender screen under the current rules;
//   6. a state Assess applies to: filtered, triage_failed or deferred_budget
//      (a triaged thread is already assessed: 409);
//   7. a mailbox triage will read: the row's account still pinned and not a
//      problem account in mail/accounts (else 409 account_unusable: the job
//      would be skipped, so it isn't queued);
//   8. at most ASSESS_LIMIT per ASSESS_WINDOW_MS, counted from the audit log by
//      http.ts's rateLimit (bucket "assess"): 429 rate_limited with
//      retryAfterSeconds and Retry-After, 503 unavailable when it can't count;
//   9. the audit row first (withAudit), then the enqueue, keyed per minute so
//      a double click queues one job.
// Answers carry status codes and short codes only, never thread content.

export const ASSESS_ROUTE = "POST /api/exec/email/threads/:id/assess";
export const ASSESS_ACTION = "email.assess";
export const ASSESS_LIMIT = 20;
export const ASSESS_WINDOW_MS = 10 * 60_000;

function answer(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Everything after the route's gate, same-origin and id checks. `now` is for tests. */
export async function assessThread(principal: ExecPrincipal, rawThreadId: string, now: Date = new Date()): Promise<NextResponse> {
  if (!isThreadIdParam(rawThreadId)) return answer(400, { error: "bad_thread_id" });
  const threadId = rawThreadId;

  try {
    const emailGate = await loadEmailGate(principal);
    if (emailGate.kind !== "on") return answer(404, { error: "email_off" });

    const row = await getEmailThread(principal, threadId);
    if (row === null || row.state === "restricted_hidden" || row.state === "gone") return answer(404, { error: "not_found" });
    const policy = await loadScreeningPolicy(principal);
    if (screenStoredRow(row, policy.rules, policy.hash).verdict === "restricted") return answer(404, { error: "not_found" });
    if (!isAssessableState(row.state)) return answer(409, { error: "not_assessable", state: row.state });
    // Triage reads only usable mailboxes (pinned, not a problem account) and
    // skips a job for any other, so the request would be accepted and never
    // run (ui-2). Refuse it here instead, and say why.
    const accounts = await getSyncState(principal, "mail", "accounts", parseAccountsState);
    if (!usableAccounts(principal, problemAccountIds(accounts?.value ?? null)).includes(row.accountId)) {
      return answer(409, { error: "account_unusable" });
    }

    const limited = await rateLimit(principal, "assess", ASSESS_LIMIT, ASSESS_WINDOW_MS, { now });
    if (!limited.ok) return limited.response;

    const minute = Math.floor(now.getTime() / 60_000);
    const job = triageJob({
      principalId: principal.id,
      lane: "interactive",
      threadId,
      reason: "assess",
      dedupeKey: retriageKey(principal.id, threadId, "assess", `m${minute}`),
      accountId: row.accountId,
      force: true
    });
    const result = await withAudit(principal, { actor: "owner", action: ASSESS_ACTION, target: `exec_email_threads:${threadId}`, input: { threadId } }, () =>
      enqueueJob(job)
    );
    return answer(202, { queued: true, duplicate: !result.enqueued });
  } catch (err) {
    // The audit row couldn't be written (so nothing was queued), or a read or
    // the enqueue failed: "try again", never a guess.
    const code = err instanceof AuditUnavailableError ? "audit_unavailable" : "unavailable";
    console.error(`[exec-email-assess] thread ${threadId}: ${code}: ${errText(err)}`);
    return answer(503, { error: code });
  }
}
