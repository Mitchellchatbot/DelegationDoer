import "server-only";

import type { OwnerTokenVerdict } from "@/lib/exec/brief-types";
import { authTest, postAsOwnerInConversation, SlackApiError } from "@/lib/exec/sources/slack";
import type { InstallationRow, OwnerPostTarget } from "@/lib/exec/slack-types";
import { escapeMrkdwn } from "@/lib/exec/slack-ui";
import type { ExecPrincipal } from "@/lib/exec/types";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

// P10 posting as him (contract §3.5.7, C39, B-P10-8, -9, -11; Area D; server-only): his DD token (users.slack_user_token of
// principal.userId, read here only), the auth.test binding, OwnerPostTarget (built here only), the post. Imported only by
// slack-reply-send.ts (named ⊆ { verifyReplyToken, postReplyAsOwner, ReplyTokenVerdict }) and by
// handlers/slack-reply-token-check.ts (named ⊆ { verifyReplyToken, ReplyTokenVerdict }).
//
//   * His token is read by principal.userId, never by e-mail and never from the environment (no SLACK_USER_TOKEN fallback,
//     P8 M6). checkin-post.ts's read and binding are copied, not imported (B-P8-2: that module's importers are pinned).
//   * auth.test must answer the installation's own Slack user and team and no bot id; anything else is a verdict, never a post.
//   * The token never leaves this module: callers get a verdict (a state and a code) or a posted ts. The OwnerPostTarget that
//     carries it is frozen, built only here from the stored draft's channel, and its JSON and inspect forms leave it out.
//   * The text posted is escapeMrkdwn(the stored text): Slack shows &lt; as <, so people read exactly what he approved, and no
//     link, mention or special mention can form (C34).
//   * Nothing here logs, ever.

/** P8's union (brief-types.ts), type-only import. */
export type ReplyTokenVerdict = OwnerTokenVerdict;

/** auth.test codes that mean the token itself is dead (P6's dead-token set). */
const REVOKED_CODES: ReadonlySet<string> = new Set(["invalid_auth", "token_revoked", "account_inactive", "not_authed"]);
const CODE = /^[a-z0-9_]{1,60}$/;
/** A token goes into a header: visible ASCII only (sources/slack.ts refuses anything else). */
const TOKEN_SHAPE = /^[\x21-\x7e]{1,500}$/;
const PG_CODE = /^[A-Z0-9]{2,10}$/;

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
    throw new Error(`slack-reply-post: users read failed (${typeof error.code === "string" && PG_CODE.test(error.code) ? error.code : "error"})`);
  }
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  const value = row?.slack_user_token;
  const token = typeof value === "string" ? value.trim() : "";
  return token.length > 0 ? token : null;
}

/** C39's binding: auth.test of his token must answer the installation's own user and team, and no bot. */
async function bindToken(token: string | null, installation: InstallationRow, signal: AbortSignal | undefined): Promise<ReplyTokenVerdict> {
  if (token === null) return { state: "missing" };
  if (!TOKEN_SHAPE.test(token)) return { state: "revoked", code: "not_authed" };
  if (!installation || typeof installation.userId !== "string" || typeof installation.teamId !== "string") return { state: "error", code: "no_installation" };
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

/** C39: users.slack_user_token of principal.userId (never env, never by email); auth.test must answer the installation's userId
 *  and teamId and no botId. Copies checkin-post.ts's read and binding (that module may not be imported, B-P8-2). A read
 *  failure is { state: "error", code: "token_read_failed" }; the caller's abort is rethrown. Writes nothing. */
export async function verifyReplyToken(principal: ExecPrincipal, installation: InstallationRow, opts?: { signal?: AbortSignal }): Promise<ReplyTokenVerdict> {
  const signal = opts?.signal;
  let token: string | null;
  try {
    token = await readOwnerToken(principal, signal);
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    return { state: "error", code: "token_read_failed" };
  }
  return bindToken(token, installation, signal);
}

/** B-P10-9: the only OwnerPostTarget, built here and nowhere else, from the stored draft's channel; frozen, and its JSON and
 *  inspect forms leave the token out. */
function ownerPostTarget(token: string, channelId: string): OwnerPostTarget {
  const target = { token, channelId };
  Object.defineProperty(target, "toJSON", { value: () => ({ channelId }), enumerable: false });
  Object.defineProperty(target, Symbol.for("nodejs.util.inspect.custom"), { value: () => `OwnerPostTarget { channelId: '${channelId}' }`, enumerable: false });
  return Object.freeze(target);
}

/** Re-reads and re-verifies the token (no token crosses a module boundary); not ok → { refused }. Builds
 *  OwnerPostTarget { token, channelId: post.channelId } and calls postAsOwnerInConversation(target, { channel: post.channelId,
 *  threadTs: post.threadTs, text: escapeMrkdwn(post.text) }, { signal }). SlackApiError propagates unchanged.
 *  C36: everything before the post call proves nothing was posted, so a timeout or abort of opts.signal there is a refusal
 *  ({ state: "error", code: "timeout" }), never an error the caller would have to treat as "maybe posted". */
export async function postReplyAsOwner(principal: ExecPrincipal, installation: InstallationRow,
  post: { channelId: string; threadTs: string | null; text: string }, opts: { signal: AbortSignal }): Promise<{ ts: string } | { refused: ReplyTokenVerdict }> {
  const signal = opts?.signal;
  let token: string | null;
  let verdict: ReplyTokenVerdict;
  try {
    token = await readOwnerToken(principal, signal);
    verdict = await bindToken(token, installation, signal);
  } catch (err) {
    if (isAbort(err, signal)) return { refused: { state: "error", code: "timeout" } };
    return { refused: { state: "error", code: "token_read_failed" } };
  }
  if (verdict.state !== "ok" || token === null) return { refused: verdict };
  if (signal?.aborted) return { refused: { state: "error", code: "timeout" } };
  const target = ownerPostTarget(token, post.channelId);
  return postAsOwnerInConversation(target, { channel: post.channelId, threadTs: post.threadTs, text: escapeMrkdwn(post.text) }, { signal });
}
