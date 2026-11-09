import "server-only";

import { renderCheckinPost } from "@/lib/exec/brief-slack-ui";
import type { OwnerTokenVerdict, TokenHealthState } from "@/lib/exec/brief-types";
import { authTest, openDm, postInDm, SlackApiError } from "@/lib/exec/sources/slack";
import { SLACK_RE, type DmTarget, type InstallationRow } from "@/lib/exec/slack-types";
import { putSyncState } from "@/lib/exec/sync-state";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P8 posting as Mitchell (contract §3.12.2, M6, C7, C19; Area D; server-only). The only module that reads his DD Slack user
// token (B-P8-2) and builds its DmTarget (B-P8-12); imported only by handlers/checkin-send.ts and handlers/brief-health.ts.
// The token never leaves this module and is never logged: callers get a verdict (ids and codes) or a posted message's
// channel and ts. No SLACK_USER_TOKEN fallback, ever (M6): the token is users.slack_user_token of principal.userId only.

export type { OwnerTokenVerdict };

/** auth.test codes that mean the token itself is dead (P6's dead-token set). */
const REVOKED_CODES: ReadonlySet<string> = new Set(["invalid_auth", "token_revoked", "account_inactive", "not_authed"]);
const CODE = /^[a-z0-9_]{1,60}$/;
/** A token goes into a header: visible ASCII only (sources/slack.ts refuses anything else). */
const TOKEN_SHAPE = /^[\x21-\x7e]{1,500}$/;

const codeOf = (err: unknown): string => (err instanceof SlackApiError && CODE.test(err.code) ? err.code : "error");

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"));
}

/** His DD user token (users.slack_user_token of principal.userId), or null when empty. A read failure throws a code-only error. */
async function readOwnerToken(principal: ExecPrincipal, signal: AbortSignal | undefined): Promise<string | null> {
  const userId = principal?.userId;
  if (typeof userId !== "string" || userId.length === 0) return null;
  let q = getSupabaseAdmin().from("users").select("slack_user_token").eq("id", userId).limit(1);
  if (signal) q = q.abortSignal(signal);
  const { data, error } = await q;
  if (error) {
    signal?.throwIfAborted();
    throw new Error(`checkin-post: users read failed (${typeof error.code === "string" && /^[A-Z0-9]{2,10}$/.test(error.code) ? error.code : "error"})`);
  }
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  const value = row?.slack_user_token;
  const token = typeof value === "string" ? value.trim() : "";
  return token.length > 0 ? token : null;
}

/** The C19 binding: auth.test of his token must answer the installation's own user and team. */
async function verifyToken(token: string | null, installation: InstallationRow, signal: AbortSignal | undefined): Promise<OwnerTokenVerdict> {
  if (token === null) return { state: "missing" };
  if (!TOKEN_SHAPE.test(token)) return { state: "revoked", code: "not_authed" };
  try {
    const who = await authTest(token, { signal });
    if (who.userId === installation.userId && who.teamId === installation.teamId && who.botId === null) {
      return { state: "ok", userId: who.userId, teamId: who.teamId };
    }
    return { state: "mismatch" };
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    const code = codeOf(err);
    return REVOKED_CODES.has(code) ? { state: "revoked", code } : { state: "error", code };
  }
}

/**
 * Reads his DD user token by principal.userId (never by email, never env: no SLACK_USER_TOKEN fallback, M6). Empty →
 * { state: "missing" }. authTest(token) (P6 client): userId === installation.userId and teamId === installation.teamId → ok;
 * otherwise mismatch. invalid_auth / token_revoked / account_inactive / not_authed → revoked(code); other errors → error(code).
 * Writes TokenHealthState to exec_sync_state (brief / token-health).
 */
export async function verifyOwnerUserToken(principal: ExecPrincipal, installation: InstallationRow, now: Date,
  opts?: { signal?: AbortSignal }): Promise<OwnerTokenVerdict> {
  const signal = opts?.signal;
  let verdict: OwnerTokenVerdict;
  try {
    verdict = await verifyToken(await readOwnerToken(principal, signal), installation, signal);
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    verdict = { state: "error", code: "token_read_failed" };
  }
  const checkedAt = (now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date()).toISOString();
  const health: TokenHealthState = { state: verdict.state, checkedAt };
  try {
    await putSyncState(principal, "brief", "token-health", health);
  } catch (err) {
    console.warn(`[exec-brief] token health not stored (principal ${principal.id}): ${err instanceof Error ? err.name : "error"}`);
  }
  return verdict;
}

/** B-P8-12: his DmTarget for his IM with one person, built here and nowhere else; its JSON and inspect forms leave the token out. */
function ownerTarget(token: string, dmChannelId: string): DmTarget {
  const target = { token, dmChannelId };
  Object.defineProperty(target, "toJSON", { value: () => ({ dmChannelId }), enumerable: false });
  Object.defineProperty(target, Symbol.for("nodejs.util.inspect.custom"), { value: () => `DmTarget { dmChannelId: '${dmChannelId}' }`, enumerable: false });
  return Object.freeze(target);
}

/**
 * Re-reads and re-verifies the token (so no token crosses a module boundary); not ok → { refused: verdict }. Then openDm(token,
 * recipientSlackId) (his IM with that person) and postInDm({ token, dmChannelId: channel }, { channel, ...renderCheckinPost(text) },
 * { signal }) (C7). SlackApiError propagates unchanged for the caller to classify.
 */
export async function postCheckinAsOwner(principal: ExecPrincipal, installation: InstallationRow, recipientSlackId: string, text: string,
  opts: { signal: AbortSignal }): Promise<{ channel: string; ts: string } | { refused: OwnerTokenVerdict }> {
  const signal = opts?.signal;
  if (typeof recipientSlackId !== "string" || !SLACK_RE.user.test(recipientSlackId)) return { refused: { state: "error", code: "bad_recipient" } };
  let token: string | null;
  try {
    token = await readOwnerToken(principal, signal);
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    return { refused: { state: "error", code: "token_read_failed" } };
  }
  const verdict = await verifyToken(token, installation, signal);
  if (verdict.state !== "ok" || token === null) return { refused: verdict };
  const channel = await openDm(token, recipientSlackId, { signal });
  if (!SLACK_RE.dm.test(channel)) throw new SlackApiError("conversations.open", "bad_response", { errorClass: "fatal" });
  const { ts } = await postInDm(ownerTarget(token, channel), { channel, ...renderCheckinPost(text) }, { signal });
  return { channel, ts };
}
