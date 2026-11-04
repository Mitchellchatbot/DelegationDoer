import "server-only";

import { NextResponse } from "next/server";
import { requireExecPrincipal } from "@/lib/exec/access";
import { withAudit } from "@/lib/exec/audit";
import { getEmailThread } from "@/lib/exec/email-store";
import { isAssessableState, isThreadIdParam, loadEmailGate } from "@/lib/exec/email-view";
import { enqueueJob, retriageKey, triageJob } from "@/lib/exec/jobs";
import { loadScreeningPolicy, screenStoredRow, usableAccounts } from "@/lib/exec/sources/mail";
import { getSyncState, parseAccountsState, problemAccountIds } from "@/lib/exec/sync-state";
import { AuditUnavailableError, type ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// POST /api/exec/email/threads/:id/assess (contract §3.14, L18, coherence-21):
// "assess this thread now", the one write on the email pages. It queues one
// forced triage job on the interactive lane and nothing else; the handler
// re-reads, re-screens and decides.
//
// Checks, in this order, each failing closed:
//   1. the owner gate with the step-up (a password or MFA session; a link
//      session gets the same 404 as everyone else);
//   2. same origin: Sec-Fetch-Site says same-origin, or (without it) the
//      Origin's host is this request's Host / X-Forwarded-Host, so another
//      site can't make his browser call it;
//   3. the thread id's shape;
//   4. email installed, on and pinned;
//   5. a stored row he may see: not missing, not a tombstone, not gone, and
//      passing the restricted-sender screen under the current rules;
//   6. a state Assess applies to: filtered, triage_failed or deferred_budget
//      (a triaged thread is already assessed: 409);
//   7. a mailbox triage will read: the row's account still pinned and not a
//      problem account in mail/accounts (else 409 account_unusable: the job
//      would be skipped, so it isn't queued);
//   8. at most ASSESS_LIMIT per ASSESS_WINDOW_MS, counted from the audit log;
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

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when the request comes from a page on this same site: the browser's
 * Sec-Fetch-Site says same-origin, or, from a browser that doesn't send it,
 * the Origin's host equals Host (or X-Forwarded-Host behind a proxy). No
 * header to go on is a refusal.
 */
export function isSameOriginRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site.trim().toLowerCase() === "same-origin";
  const origin = hostOf(req.headers.get("origin"));
  if (origin === null) return false;
  const hosts = [req.headers.get("host"), req.headers.get("x-forwarded-host")]
    .flatMap((h) => (h ? h.split(",") : []))
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
  return hosts.includes(origin);
}

/** How many assessments he started since `sinceIso` (audit rows). Throws when it can't count. */
async function recentAssessments(principal: ExecPrincipal, sinceIso: string): Promise<number> {
  const { count, error } = await getSupabaseAdmin()
    .from("exec_audit_log")
    .select("id", { count: "exact", head: true })
    .eq("principal_id", principal.id)
    .eq("action", ASSESS_ACTION)
    .gte("created_at", sinceIso);
  if (error) throw new Error(`exec_audit_log count failed: ${error.message}`);
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("exec_audit_log count failed: no count came back");
  return count;
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** The whole route. `now` is for tests. */
export async function assessThread(req: Request, rawThreadId: string, now: Date = new Date()): Promise<NextResponse> {
  const gate = await requireExecPrincipal(req, ASSESS_ROUTE, { requireStrongSignIn: true });
  if (!gate.ok) return gate.response;
  const principal = gate.principal;

  if (!isSameOriginRequest(req)) return answer(403, { error: "cross_origin" });
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

    const since = new Date(now.getTime() - ASSESS_WINDOW_MS).toISOString();
    if ((await recentAssessments(principal, since)) >= ASSESS_LIMIT) return answer(429, { error: "rate_limited" });

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
