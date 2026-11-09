import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { CANONICAL_ORIGIN } from "@/lib/canonical-origin";
import { requireExecSession } from "@/lib/exec/access";
import { auditEvent, auditFinish, auditStart } from "@/lib/exec/audit";
import { SecretUnavailableError, cryptoConfigured, sealSecret, signState, verifyState } from "@/lib/exec/crypto";
import { isSameOriginRequest, jsonError, rateLimit } from "@/lib/exec/http";
import { appOrigin } from "@/lib/exec/refs";
import { SLACK_REDIRECT_URI, slackConfig, type SlackConfig } from "@/lib/exec/slack-config";
import { consumeOAuthState, isSlackSchemaMissing, issueOAuthState, saveInstallation, slackSchemaReady } from "@/lib/exec/slack-install";
import { SLACK_BOT_SCOPES, SLACK_LIMITS, SLACK_RE, type SlackConnectResult } from "@/lib/exec/slack-types";
import { SlackApiError, authTest, exchangeOAuthCode, lookupUserByEmail, openDm, revokeToken, type OAuthAccessResult } from "@/lib/exec/sources/slack";
import type { ExecPrincipal } from "@/lib/exec/types";

// P6 OAuth install (contract §3.10.3-4, K5, C1, C2, C24, C25, C44, C45; Area C;
// server-only): the start and callback steps GET /api/integrations/exec-slack/start
// and /callback call, and the canonical-host check start and the Settings page
// share.
//
// Start: strong session → canonical host → same-origin → config → schema →
// session bound → rate limit → audit → a single-use state (a sha256(nonce) row
// bound to the principal, the auth user and the session, 10 minutes; an HMAC'd
// token carrying the nonce) → 302 to Slack's authorize URL with the six bot
// scopes and no user_scope (K1).
//
// Callback: strong session → the query (state / code / error) → the state's mac
// → CONSUME the row (always first, so a state is single-use whatever happens
// next) → expiry and the binding → Slack's answer, checked in order: team,
// enterprise, app, the exact scope set, the installer's identity
// (users.lookupByEmail of the principal's email with the new bot token must be
// authed_user.id), auth.test, the DM → seal the bot token → save. Nothing is
// stored unless every check passes. An unexpected user token is revoked at once
// and never stored (K1); the bot token is never revoked here (that would
// uninstall the app for the valid installer too, C25, C44).
//
// Every answer is a 303 to the Settings page with ?slack=<code> (wrong_host: on
// the canonical origin), the gate's own answer, a 403, or start's 302 to Slack;
// each carries Cache-Control: no-store and Referrer-Policy: no-referrer.
//
// Logging: result codes and Slack error codes only (§0.3 rule 4). The OAuth
// query values are only ever held in variables named oauthCode / oauthState
// (B-P6-5), and no token, email or Slack name reaches a log, an audit row or a
// redirect.

const START_ROUTE = "GET /api/integrations/exec-slack/start";
const CALLBACK_ROUTE = "GET /api/integrations/exec-slack/callback";
const SETTINGS_PATH = "/executive/settings";
const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const CANONICAL_HOST = new URL(CANONICAL_ORIGIN).host;
const STATE_PURPOSE = "slack-oauth";
const STATE_PAYLOAD_RE = /^s1\.([0-9a-f]{64})\.([0-9]{10})$/;
const QUERY_MAX = Object.freeze({ state: 400, code: 400, error: 100 });
const CONNECT_LIMIT = 10;
const CONNECT_WINDOW_MS = 600_000;
const SLACK_CODE_RE = /^[a-z0-9_]{1,60}$/;

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** The two headers every answer carries, on a copy of `res` (the gate's NextResponse included). */
function guarded(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function redirectTo(location: string, status: 302 | 303): Response {
  return new Response(null, { status, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

/** 303 to appOrigin() + "/executive/settings?slack=<result>" (C24). */
function settingsRedirect(result: SlackConnectResult, who?: string): Response {
  const q = new URLSearchParams({ slack: result });
  if (who !== undefined) q.set("who", who);
  return redirectTo(`${appOrigin()}${SETTINGS_PATH}?${q.toString()}`, 303);
}

const sha256hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const errName = (err: unknown): string => (err instanceof Error ? err.name : "error");
const slackCode = (err: unknown): string =>
  err instanceof SlackApiError && SLACK_CODE_RE.test(err.code) ? err.code : errName(err);
/** A failed Slack call: a retryable one (timeout, network, 5xx, rate limit) → slack_unavailable, anything else → `fallback`. */
const slackFailure = <F extends SlackConnectResult>(err: unknown, fallback: F): F | "slack_unavailable" =>
  err instanceof SlackApiError && err.errorClass === "retryable" ? "slack_unavailable" : fallback;

// ---------------------------------------------------------------------------
// The canonical host (C45)
// ---------------------------------------------------------------------------

/** C45: the first comma-separated x-forwarded-host value, else Host, trimmed, lowercased, trailing dot and any ":443"
 *  stripped, equals new URL(CANONICAL_ORIGIN).host. Takes a Request's headers or next/headers' headers().
 *  An empty first x-forwarded-host value counts as absent (Host decides); no host at all is false. */
export function isCanonicalRequestHost(headers: Pick<Headers, "get">): boolean {
  const forwarded = headers.get("x-forwarded-host");
  let host = forwarded !== null ? (forwarded.split(",")[0] ?? "").trim() : "";
  if (host === "") host = (headers.get("host") ?? "").trim();
  host = host.toLowerCase();
  if (host.endsWith(":443")) host = host.slice(0, -":443".length);
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host !== "" && host === CANONICAL_HOST;
}

// ---------------------------------------------------------------------------
// Start (§3.10.3)
// ---------------------------------------------------------------------------

/** §3.10.3: every answer a 303 to appOrigin() + "/executive/settings?slack=<code>" (wrong_host: to CANONICAL_ORIGIN), or the
 *  gate's 401/404/503 JSON, a 403 { error: "forbidden" }, or the 302 to Slack's authorize URL. Cache-Control no-store,
 *  Referrer-Policy no-referrer. */
export async function startSlackInstall(req: Request): Promise<Response> {
  try {
    return await start(req);
  } catch (err) {
    console.error(`[exec-slack] oauth start unavailable (${errName(err)})`);
    return settingsRedirect("unavailable");
  }
}

async function start(req: Request): Promise<Response> {
  // 1. The strong session.
  const session = await requireExecSession(req, START_ROUTE, { requireStrongSignIn: true });
  if (!session.ok) return guarded(session.response);

  // 1b. The canonical host (C45): Slack sends the callback to the canonical redirect URL, and a session on another host
  // (host-only cookies) isn't one there, so a start anywhere else could never finish.
  if (!isCanonicalRequestHost(req.headers)) return redirectTo(`${CANONICAL_ORIGIN}${SETTINGS_PATH}?slack=wrong_host`, 303);

  // 2. A navigation from DD itself.
  if (!isSameOriginRequest(req)) return guarded(jsonError(403, "forbidden"));

  // 3. Configured.
  const cfg = slackConfig();
  if (cfg === null || !cryptoConfigured()) return settingsRedirect("not_configured");

  // 4. The P6 migration is applied.
  try {
    if (!(await slackSchemaReady())) return settingsRedirect("not_installed");
  } catch (err) {
    console.error(`[exec-slack] oauth start: schema check failed (${errName(err)})`);
    return settingsRedirect("unavailable");
  }

  // 5. The session id the state is bound to.
  const { principal, authUserId, sessionId } = session;
  if (sessionId === null) return settingsRedirect("session_unbound");

  // 6. Ten starts per ten minutes (the slack.oauth.start audit rows). A count that can't be read fails closed.
  const limited = await rateLimit(principal, "slack_connect", CONNECT_LIMIT, CONNECT_WINDOW_MS);
  if (!limited.ok) return settingsRedirect(limited.response.status === 429 ? "rate_limited" : "unavailable");

  // 7. On record before the state exists.
  let auditId: number;
  try {
    auditId = await auditStart(principal, { actor: "owner", action: "slack.oauth.start", target: "exec_oauth_states", input: {} });
  } catch {
    return settingsRedirect("unavailable");
  }

  // 8. The state: a single-use row keyed by sha256(nonce) (C1), and the signed token that carries the nonce (C2).
  const nonce = randomBytes(32).toString("hex");
  const exp = Math.floor(Date.now() / 1000) + SLACK_LIMITS.oauthStateTtlSec;
  let oauthState: string;
  try {
    oauthState = signState(STATE_PURPOSE, `s1.${nonce}.${exp}`);
    await issueOAuthState(principal, { nonceHash: sha256hex(nonce), authUserId, sessionId, ttlSeconds: SLACK_LIMITS.oauthStateTtlSec });
  } catch (err) {
    const result: SlackConnectResult = isSlackSchemaMissing(err) ? "not_installed" : "unavailable";
    await auditFinish(auditId, { ok: false, error: result });
    console.error(`[exec-slack] oauth start ${result} (${errName(err)})`);
    return settingsRedirect(result);
  }

  // 9. To Slack: the six bot scopes, no user_scope (K1), the canonical redirect URL (K3), our workspace.
  await auditFinish(auditId, { ok: true });
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    scope: SLACK_BOT_SCOPES.join(","),
    redirect_uri: SLACK_REDIRECT_URI,
    state: oauthState,
    team: cfg.teamId
  });
  return redirectTo(`${AUTHORIZE_URL}?${q.toString()}`, 302);
}

// ---------------------------------------------------------------------------
// Callback (§3.10.4)
// ---------------------------------------------------------------------------

type CallbackQuery = { ok: true; oauthState: string | null; oauthCode: string | null; oauthError: string | null } | { ok: false };

/** state ≤ 400, code ≤ 400, error ≤ 100; a repeated key or a longer value is refused. An empty value counts as absent. */
function readCallbackQuery(url: string): CallbackQuery {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return { ok: false };
  }
  const one = (key: keyof typeof QUERY_MAX): string | null | undefined => {
    const all = params.getAll(key);
    if (all.length > 1) return undefined;
    const v = all[0];
    if (v === undefined || v === "") return null;
    return v.length <= QUERY_MAX[key] ? v : undefined;
  };
  const oauthState = one("state");
  const oauthCode = one("code");
  const oauthError = one("error");
  if (oauthState === undefined || oauthCode === undefined || oauthError === undefined) return { ok: false };
  return { ok: true, oauthState, oauthCode, oauthError };
}

/** §3.10.4: the callback; nothing is stored unless every check passes. Same redirect convention as start. */
export async function finishSlackInstall(req: Request): Promise<Response> {
  try {
    return await finish(req);
  } catch (err) {
    console.error(`[exec-slack] oauth callback unavailable (${errName(err)})`);
    return settingsRedirect("unavailable");
  }
}

async function finish(req: Request): Promise<Response> {
  // 1. The strong session.
  const session = await requireExecSession(req, CALLBACK_ROUTE, { requireStrongSignIn: true });
  if (!session.ok) return guarded(session.response);
  const principal = session.principal;

  // 2. The query.
  const query = readCallbackQuery(req.url);
  if (!query.ok || query.oauthState === null) return settingsRedirect("state_invalid");
  const { oauthState, oauthCode, oauthError } = query;

  // 3. The token's mac and shape.
  let payload: string | null;
  try {
    payload = verifyState(STATE_PURPOSE, oauthState);
  } catch (err) {
    console.error(`[exec-slack] oauth callback: state key unavailable (${errName(err)})`);
    return settingsRedirect(err instanceof SecretUnavailableError ? "not_configured" : "unavailable");
  }
  const parts = payload === null ? null : STATE_PAYLOAD_RE.exec(payload);
  if (parts === null) return settingsRedirect("state_invalid");

  // 4. Consume the row first, always: single use, expired or not (C1 v2).
  let row: Awaited<ReturnType<typeof consumeOAuthState>>;
  try {
    row = await consumeOAuthState(sha256hex(parts[1]));
  } catch (err) {
    console.error(`[exec-slack] oauth callback: state store failed (${errName(err)})`);
    return settingsRedirect(isSlackSchemaMissing(err) ? "not_installed" : "unavailable");
  }
  if (row === null) return settingsRedirect("state_invalid");
  if (!(Date.parse(row.expiresAt) > Date.now())) return settingsRedirect("state_expired");

  // 5. Issued to this principal, this auth user and this very session.
  if (
    row.principalId !== principal.id ||
    row.authUserId !== session.authUserId ||
    session.sessionId === null ||
    row.sessionId !== session.sessionId
  ) {
    return settingsRedirect("state_invalid");
  }

  // 6-22. Every outcome from here on is on record as slack.install.
  const outcome = await install(principal, oauthCode, oauthError);
  if (outcome.result === "connected") {
    await auditEvent(principal, {
      actor: "owner",
      action: "slack.install",
      target: `exec_slack_installations:${outcome.id}`,
      input: { replaced: outcome.replaced, scopes: outcome.scopes }
    });
    console.info(`[exec-slack] oauth callback connected (${outcome.id}, replaced ${outcome.replaced})`);
    return settingsRedirect("connected");
  }
  await auditEvent(principal, { actor: "owner", action: "slack.install", target: "exec_slack_installations", input: {}, ok: false, error: outcome.result });
  console.warn(`[exec-slack] oauth callback ${outcome.result}`);
  return outcome.result === "wrong_user" ? settingsRedirect("wrong_user", outcome.who) : settingsRedirect(outcome.result);
}

type InstallOutcome =
  | { result: "connected"; id: string; replaced: boolean; scopes: number }
  | { result: "wrong_user"; who: string }
  | { result: Exclude<SlackConnectResult, "connected" | "wrong_user"> };

/** auth.revoke on a token Slack should never have handed us (K1). Best-effort: a failure is logged by code. */
async function revokeUnexpected(userToken: string): Promise<void> {
  try {
    await revokeToken(userToken);
  } catch (err) {
    console.warn(`[exec-slack] oauth callback: an unexpected user grant could not be revoked (${slackCode(err)})`);
  }
}

/** The exact bot scope set (C44): missing first, then extra; null when equal. */
function scopeVerdict(granted: readonly string[]): "missing_scopes" | "extra_scopes" | null {
  const got = new Set(granted);
  const want: ReadonlySet<string> = new Set(SLACK_BOT_SCOPES);
  for (const s of want) if (!got.has(s)) return "missing_scopes";
  for (const s of got) if (!want.has(s)) return "extra_scopes";
  return null;
}

/** Steps 6-20: Slack's answer and the save. Never throws (a throw from the save is `unavailable`). */
async function install(principal: ExecPrincipal, oauthCode: string | null, oauthError: string | null): Promise<InstallOutcome> {
  // 6. Cancelled in Slack.
  if (oauthError !== null) return { result: "denied" };
  // 7. A code, and a configured app.
  if (oauthCode === null) return { result: "state_invalid" };
  const cfg: SlackConfig | null = slackConfig();
  if (cfg === null || !cryptoConfigured()) return { result: "not_configured" };

  // 8. The exchange (HTTP Basic, the canonical redirect URL).
  let access: OAuthAccessResult;
  try {
    access = await exchangeOAuthCode({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, code: oauthCode, redirectUri: SLACK_REDIRECT_URI });
  } catch (err) {
    console.warn(`[exec-slack] oauth callback: exchange failed (${slackCode(err)})`);
    return { result: slackFailure(err, "exchange_failed") };
  }

  // 10 (first, whatever else fails): a user token is never kept (K1).
  if (access.authedUserToken !== null) await revokeUnexpected(access.authedUserToken);

  // 9. A bot token.
  const botToken = access.accessToken;
  if (access.tokenType !== "bot" || !botToken.startsWith("xoxb-")) return { result: "exchange_failed" };
  // 11-13. The workspace, not an org-wide install, our app.
  if (access.isEnterpriseInstall || access.enterprisePresent) return { result: "enterprise" };
  if (access.teamId !== cfg.teamId) return { result: "wrong_team" };
  if (access.appId !== cfg.appId) return { result: "wrong_app" };
  // 14. Exactly the six bot scopes (C44): nothing stored, the bot token not revoked either way.
  const scopes = scopeVerdict(access.scope);
  if (scopes !== null) return { result: scopes };
  // 15. Well-formed ids.
  const botUserId = access.botUserId;
  const authedUserId = access.authedUserId;
  if (botUserId === null || !SLACK_RE.user.test(botUserId) || authedUserId === null || !SLACK_RE.user.test(authedUserId)) {
    return { result: "exchange_failed" };
  }

  // 16-17. The installer is the principal: his DD email's Slack member, as the new bot token sees it (K5).
  if (typeof principal.email !== "string" || principal.email.length === 0) return { result: "identity_not_found" };
  let member: Awaited<ReturnType<typeof lookupUserByEmail>>;
  try {
    member = await lookupUserByEmail(botToken, principal.email);
  } catch (err) {
    console.warn(`[exec-slack] oauth callback: identity lookup failed (${slackCode(err)})`);
    return { result: slackFailure(err, "exchange_failed") };
  }
  if (member === null || member.deleted || member.isBot) return { result: "identity_not_found" };
  if (member.id !== authedUserId) return { result: "wrong_user", who: authedUserId };

  // 18. The token is the bot user Slack named, in our workspace.
  let me: Awaited<ReturnType<typeof authTest>>;
  try {
    me = await authTest(botToken);
  } catch (err) {
    console.warn(`[exec-slack] oauth callback: auth check failed (${slackCode(err)})`);
    return { result: slackFailure(err, "exchange_failed") };
  }
  const botId = me.botId;
  if (me.teamId !== cfg.teamId || me.userId !== botUserId || botId === null || !SLACK_RE.bot.test(botId)) return { result: "exchange_failed" };

  // 19. The bot's DM with him: the one channel it ever posts to (K11).
  let dmChannelId: string;
  try {
    dmChannelId = await openDm(botToken, authedUserId);
  } catch (err) {
    console.warn(`[exec-slack] oauth callback: DM open failed (${slackCode(err)})`);
    return { result: "slack_unavailable" };
  }
  if (!SLACK_RE.dm.test(dmChannelId)) return { result: "slack_unavailable" };

  // 20. Sealed for this principal, then saved (a reinstall replaces the token in place and keeps his data, K5).
  try {
    const sealed = sealSecret(botToken, `exec_slack_installations.bot_token:${principal.id}`);
    const saved = await saveInstallation(principal, {
      teamId: cfg.teamId,
      appId: cfg.appId,
      botUserId,
      botId,
      botTokenSealed: sealed,
      keyId: sealed.split(".")[1] ?? "",
      botScopes: [...SLACK_BOT_SCOPES],
      userId: authedUserId,
      dmChannelId
    });
    return { result: "connected", id: saved.id, replaced: saved.replaced, scopes: SLACK_BOT_SCOPES.length };
  } catch (err) {
    console.error(`[exec-slack] oauth callback: save failed (${errName(err)})`);
    return { result: "unavailable" };
  }
}
