import "server-only";

import { createHash } from "node:crypto";
import { CLONE_GRAPH_ID_RE, CLONE_IDEMPOTENCY_KEY_RE, CloneEaError, decodeTokenClaims, parseCloneSendAccepted } from "@/lib/exec/clone-ea-types";
import type { SendTokenReason } from "@/lib/exec/drafts-types";
import { CLONE_EA_PATHS, cloneEaFetch, type CloneEaResponse } from "@/lib/exec/sources/clone-ea";
import { putSyncState } from "@/lib/exec/sync-state";
import { NonRetryableError, type ExecPrincipal } from "@/lib/exec/types";

// The send path (P4 contract §3.4; Area B). The only reader of the send token
// (boundary B1) and imported only by the send route (B3); its imports are
// limited to server-only, node:crypto, types, drafts-types, clone-ea-types,
// sources/clone-ea and sync-state (B6).
//
// sendSavedDraft makes exactly one POST /api/outlook-drafts/:graphId/send, never
// retries, never takes a caller signal (L10.4), never recomputes the confirm
// hash (it sends the one it is given) and never writes anything but the
// clone-ea/send-token verdict. Every answer, transport failure and timeout
// comes back as a SendOutcome: the route maps it (§2.6.5) and does the CAS.

export type SendOutcome =
  | { kind: "accepted"; internetMessageId: string | null; replay: boolean }
  /** Every non-202 answer, transport and timeout included. */
  | { kind: "error"; error: CloneEaError };
export interface SendTokenReadiness {
  ok: boolean; reason: SendTokenReason | null; expiresAt: string | null; checkedAt: string; tokenFp: string | null;
}

/** C4: the send call's fetch timeout (CL2 does up to 60 s of pre-send reads plus 30 s on /send). */
export const SEND_TIMEOUT_MS = 150_000;
const HEX64_RE = /^[0-9a-f]{64}$/;
const JTI_RE = /^[A-Za-z0-9_-]{16,64}$/;
// Date's own range: past it toISOString throws.
const MAX_DATE_MS = 8.64e15;

/** The only reader of the send token (B1): per call, trimmed; null when unset or blank. A rotation needs no code change. */
function readSendToken(): string | null {
  const raw = process.env.MISSIVE_EA_SEND_TOKEN;
  const token = typeof raw === "string" ? raw.trim() : "";
  return token.length > 0 ? token : null;
}

const fingerprint = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);
const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

function setEqual(a: readonly unknown[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const x of left) if (!right.has(x as string)) return false;
  return true;
}

/** The offline checks of §3.4, in the contract's order; the first failed check is the reason. */
function judgeSendToken(principal: ExecPrincipal, token: string | null, nowMs: number): { reason: SendTokenReason | null; expiresAt: string | null } {
  if (token === null) return { reason: "token_missing", expiresAt: null };
  const claims = decodeTokenClaims(token);
  if (claims === null) return { reason: "malformed", expiresAt: null };
  const exp = typeof claims.exp === "number" && Number.isFinite(claims.exp) && Math.abs(claims.exp * 1000) <= MAX_DATE_MS ? claims.exp * 1000 : null;
  const expiresAt = exp === null ? null : new Date(exp).toISOString();
  if (!hasOwn(claims, "scope")) return { reason: "not_scoped", expiresAt };
  const scope = claims.scope;
  if (!Array.isArray(scope) || scope.length !== 1 || scope[0] !== "send") return { reason: "wrong_scopes", expiresAt };
  const accounts = claims.accounts;
  if (!Array.isArray(accounts) || !accounts.every((a) => typeof a === "string") || !setEqual(accounts, principal.mailAccountIds)) {
    return { reason: "wrong_accounts", expiresAt };
  }
  if (exp === null) return { reason: "malformed", expiresAt };
  if (exp <= nowMs) return { reason: "token_expired", expiresAt };
  if (typeof claims.jti !== "string" || !JTI_RE.test(claims.jti)) return { reason: "malformed", expiresAt };
  return { reason: null, expiresAt };
}

/**
 * Offline decode, no network (L4: a misconfiguration check, not a security
 * check). Writes the clone-ea/send-token verdict fire-and-forget (§2.3): codes,
 * the expiry and the token's fingerprint only, never the token or a claim.
 */
export function sendTokenReadiness(principal: ExecPrincipal, now: Date = new Date()): SendTokenReadiness {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new NonRetryableError("sendTokenReadiness: now must be a valid Date");
  const token = readSendToken();
  const tokenFp = token === null ? null : fingerprint(token);
  const { reason, expiresAt } = judgeSendToken(principal, token, nowMs);
  const verdict: SendTokenReadiness = { ok: reason === null, reason, expiresAt, checkedAt: new Date(nowMs).toISOString(), tokenFp };
  void putSyncState(principal, "clone-ea", "send-token", {
    ok: verdict.ok,
    reason: verdict.reason,
    checkedAt: verdict.checkedAt,
    expiresAt: verdict.expiresAt,
    tokenFp: verdict.tokenFp
  }).catch((err: unknown) => {
    console.warn(`[exec-drafts] clone-ea/send-token verdict not written: ${err instanceof Error ? err.name : "error"}`);
  });
  return verdict;
}

/** Exactly one POST /api/outlook-drafts/:graphId/send. Never retries, never takes a caller signal. */
export async function sendSavedDraft(principal: ExecPrincipal,
  input: { accountId: string; graphId: string; confirmHash: string; idempotencyKey: string }): Promise<SendOutcome> {
  // Refusals before any fetch: programming errors (the route checks these first), never a clone call.
  const readiness = sendTokenReadiness(principal);
  if (!readiness.ok) throw new NonRetryableError(`sendSavedDraft: the send token is not ready (${readiness.reason ?? "unknown"})`);
  if (typeof input.accountId !== "string" || !principal.mailAccountIds.includes(input.accountId)) {
    throw new NonRetryableError(`sendSavedDraft: the account is not pinned for principal ${principal.id}`);
  }
  if (typeof input.graphId !== "string" || !CLONE_GRAPH_ID_RE.test(input.graphId)) throw new NonRetryableError("sendSavedDraft: graphId is malformed");
  if (typeof input.confirmHash !== "string" || !HEX64_RE.test(input.confirmHash)) {
    throw new NonRetryableError("sendSavedDraft: confirmHash is not 64 hex characters");
  }
  if (typeof input.idempotencyKey !== "string" || !CLONE_IDEMPOTENCY_KEY_RE.test(input.idempotencyKey)) {
    throw new NonRetryableError("sendSavedDraft: idempotencyKey is malformed");
  }
  const token = readSendToken();
  if (token === null) throw new NonRetryableError("sendSavedDraft: the send token is not configured");

  let res: CloneEaResponse;
  try {
    res = await cloneEaFetch({
      route: "send",
      method: "POST",
      path: CLONE_EA_PATHS.send(input.graphId),
      token,
      // CL2 C2: the body's key equals the header's.
      json: { confirmHash: input.confirmHash, idempotencyKey: input.idempotencyKey },
      idempotencyKey: input.idempotencyKey,
      timeoutMs: SEND_TIMEOUT_MS
    });
  } catch (err) {
    return { kind: "error", error: err instanceof CloneEaError ? err : new CloneEaError({ route: "send", status: null, body: null, code: "transport" }) };
  }
  try {
    const accepted = parseCloneSendAccepted(res.body);
    return { kind: "accepted", internetMessageId: accepted.internetMessageId, replay: res.replay };
  } catch {
    // A 2xx means the clone accepted the send; an unreadable body is an unknown outcome, never "nothing happened" (security-8).
    return { kind: "error", error: new CloneEaError({ route: "send", status: res.status, body: null, code: "invalid_body", replay: res.replay }) };
  }
}
