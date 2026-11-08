import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { CANONICAL_ORIGIN } from "@/lib/canonical-origin";
import { requireExecSession } from "@/lib/exec/access";
import { auditEvent, auditFinish, auditStart } from "@/lib/exec/audit";
import { SecretUnavailableError, cryptoConfigured, sealSecret, signState, verifyState } from "@/lib/exec/crypto";
import { isSameOriginRequest, jsonError, rateLimit } from "@/lib/exec/http";
import { enqueueJob } from "@/lib/exec/jobs";
import { notifyOps } from "@/lib/exec/ops";
import { appOrigin } from "@/lib/exec/refs";
import { SLACK_REDIRECT_URI, slackConfig, type SlackConfig } from "@/lib/exec/slack-config";
import {
  SlackStoreError,
  consumeOAuthState,
  getReadingHalf,
  isSlackSchemaMissing,
  issueOAuthState,
  openReadingInstallation,
  recordUserTokenError,
  saveInstallation,
  saveReadingConsent,
  slackReadingSchemaReady,
  slackSchemaReady
} from "@/lib/exec/slack-install";
import { userRevoke } from "@/lib/exec/slack-read-store";
import {
  SLACK_READ_JOB_KINDS,
  SLACK_USER_SCOPES_OPTIONAL,
  SLACK_USER_SCOPES_REQUIRED,
  type ReadingHalf,
  type SlackUserScope
} from "@/lib/exec/slack-read-types";
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
//
// P7a (contract §3.10.3-4, §3.10.5, §3.10.8, N4, C25, C27, C47): the second
// consent. start?purpose=read (only with the P7a migration and an active bot
// installation) asks Slack for the bot's exact scopes plus the nine user scopes
// (five required, four optional) under a state row marked purpose 'read'. Its
// callback runs every check of the install, then: a user token Slack issued as
// one (xoxp-, token_type user), the installation's own Slack member, the
// required user scopes and nothing outside the nine, and auth.test of the user
// token naming him in our workspace. Only then is the token sealed (its own
// context, exec_slack_installations.user_token:<principal>) and saved with the
// replaced bot token in one update; discovery is enqueued. Every failure after
// the exchange revokes the user token Slack handed over (best-effort, never a
// bot token) and stores nothing. The user token is held only in a local named
// oauthUserToken. A plain install keeps K1 (a returned user token is revoked)
// unless a live reading half exists (C27: then it is ignored, neither stored
// nor revoked). withdrawReadingGrant is Stop reading's act and Disconnect's
// first part: auth.revoke with the user token, then the revoke-and-purge RPC
// whatever Slack answered (C47).

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
/** P7a (§3.10.3 step 9r): the nine user scopes, required first, in the order Slack's consent screen lists them. */
const USER_SCOPE_PARAM = [...SLACK_USER_SCOPES_REQUIRED, ...SLACK_USER_SCOPES_OPTIONAL].join(",");
const USER_SCOPES_REQUIRED: ReadonlySet<string> = new Set(SLACK_USER_SCOPES_REQUIRED);
const USER_SCOPES_ALLOWED: ReadonlySet<string> = new Set([...SLACK_USER_SCOPES_REQUIRED, ...SLACK_USER_SCOPES_OPTIONAL]);
/** The two sealing contexts (each + the principal id): neither blob opens as the other. */
const BOT_TOKEN_CONTEXT = "exec_slack_installations.bot_token:";
const USER_TOKEN_CONTEXT = "exec_slack_installations.user_token:";
/** A P7a column missing (42703 / PGRST204): the database is P6's, so there is no reading half. */
const COLUMN_MISSING_CODES: ReadonlySet<string> = new Set(["42703", "PGRST204"]);

/** What a start or a callback is for: P6's bot install, or P7a's read consent. */
type OAuthPurpose = "install" | "read";

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

/** §3.10.3 step 0: absent → install; exactly "read" → read; anything else or repeated → null (state_invalid). */
function purposeOf(url: string): OAuthPurpose | null {
  let all: string[];
  try {
    all = new URL(url).searchParams.getAll("purpose");
  } catch {
    return null;
  }
  if (all.length === 0) return "install";
  return all.length === 1 && all[0] === "read" ? "read" : null;
}

async function start(req: Request): Promise<Response> {
  // 0. What the flow is for (P7a): P6's install, or the read consent.
  const purpose = purposeOf(req.url);
  if (purpose === null) return settingsRedirect("state_invalid");

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

  // 5r. The read consent needs the P7a migration and an active bot installation to add the user half to.
  if (purpose === "read") {
    try {
      if (!(await slackReadingSchemaReady())) return settingsRedirect("not_installed");
      if ((await readingHalfOrNone(principal)) === null) return settingsRedirect("read_not_connected");
    } catch (err) {
      console.error(`[exec-slack] oauth start: reading check failed (${errName(err)})`);
      return settingsRedirect("unavailable");
    }
  }

  // 6. Ten starts per ten minutes (the slack.oauth.start audit rows). A count that can't be read fails closed.
  const limited = await rateLimit(principal, "slack_connect", CONNECT_LIMIT, CONNECT_WINDOW_MS);
  if (!limited.ok) return settingsRedirect(limited.response.status === 429 ? "rate_limited" : "unavailable");

  // 7. On record before the state exists.
  let auditId: number;
  try {
    auditId = await auditStart(principal, { actor: "owner", action: "slack.oauth.start", target: "exec_oauth_states", input: purpose === "read" ? { purpose } : {} });
  } catch {
    return settingsRedirect("unavailable");
  }

  // 8. The state: a single-use row keyed by sha256(nonce) (C1), and the signed token that carries the nonce (C2).
  const nonce = randomBytes(32).toString("hex");
  const exp = Math.floor(Date.now() / 1000) + SLACK_LIMITS.oauthStateTtlSec;
  let oauthState: string;
  try {
    oauthState = signState(STATE_PURPOSE, `s1.${nonce}.${exp}`);
    await issueOAuthState(principal, {
      nonceHash: sha256hex(nonce),
      authUserId,
      sessionId,
      ttlSeconds: SLACK_LIMITS.oauthStateTtlSec,
      ...(purpose === "read" ? { purpose } : {})
    });
  } catch (err) {
    const result: SlackConnectResult = isSlackSchemaMissing(err) ? "not_installed" : "unavailable";
    await auditFinish(auditId, { ok: false, error: result });
    console.error(`[exec-slack] oauth start ${result} (${errName(err)})`);
    return settingsRedirect(result);
  }

  // 9. To Slack: the six bot scopes, no user_scope (K1), the canonical redirect URL (K3), our workspace.
  // 9r. The read consent: the same, plus the nine user scopes (the manifest marks the last four optional, P7-1).
  await auditFinish(auditId, { ok: true });
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    scope: SLACK_BOT_SCOPES.join(","),
    ...(purpose === "read" ? { user_scope: USER_SCOPE_PARAM } : {}),
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

  // P7a: a read consent's state continues on its own steps (§3.10.4), on record as slack.read_consent.
  if (row.purpose === "read") return finishReadConsent(principal, oauthCode, oauthError);

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

  // 10 (first, whatever else fails): a user token is never kept (K1). P7a C27: while a live reading half exists the
  // returned user token is ignored instead (never stored, never revoked), so a Reconnect never kills his reading grant.
  if (access.authedUserToken !== null) {
    const live = await hasLiveUserHalf(principal);
    if (live === false) await revokeUnexpected(access.authedUserToken);
    else if (live === null) console.warn("[exec-slack] oauth callback: a returned user grant was left alone (the reading half couldn't be read)");
  }

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

// ---------------------------------------------------------------------------
// P7a: the read consent's callback (§3.10.4, purpose = read)
// ---------------------------------------------------------------------------

/** A reading half that is live: a user token and reading_state discovering|ready. */
const isLiveReading = (r: ReadingHalf): boolean => r.hasToken && (r.state === "discovering" || r.state === "ready");

/** getReadingHalf, with the P7a schema missing (its columns or tables: a P6-only database) read as "no reading half".
 *  Any other error throws. */
async function readingHalfOrNone(principal: ExecPrincipal): Promise<Awaited<ReturnType<typeof getReadingHalf>>> {
  try {
    return await getReadingHalf(principal);
  } catch (err) {
    if (isSlackSchemaMissing(err) || (err instanceof SlackStoreError && err.pgCode !== null && COLUMN_MISSING_CODES.has(err.pgCode))) return null;
    throw err;
  }
}

/** C27: does the principal hold a live reading half? false without one (or without the P7a schema); null when it can't be read. */
async function hasLiveUserHalf(principal: ExecPrincipal): Promise<boolean | null> {
  try {
    const half = await readingHalfOrNone(principal);
    return half !== null && isLiveReading(half.reading);
  } catch (err) {
    console.warn(`[exec-slack] oauth callback: reading half unreadable (${errName(err)})`);
    return null;
  }
}

/** A failed read consent: auth.revoke on the user grant Slack just made, best-effort. Only a user token (xoxp-) is ever
 *  revoked here: anything else in that field could be the bot's own token, whose revoke would uninstall the app. */
async function revokeUserGrant(oauthUserToken: string | null): Promise<void> {
  if (oauthUserToken === null || !oauthUserToken.startsWith("xoxp-")) return;
  await revokeUnexpected(oauthUserToken);
}

/** §3.10.4 step 18r2: the granted user scopes, deduplicated; the required five must be there and nothing outside the nine. */
function userScopeVerdict(granted: readonly string[]): "missing_user_scopes" | "extra_user_scopes" | null {
  const got = new Set(granted);
  for (const s of USER_SCOPES_REQUIRED) if (!got.has(s)) return "missing_user_scopes";
  for (const s of got) if (!USER_SCOPES_ALLOWED.has(s)) return "extra_user_scopes";
  return null;
}

type ReadConsentOutcome =
  | { result: "read_connected"; id: string; scopes: number; optional: number }
  | { result: "wrong_user"; who: string }
  | { result: Exclude<SlackConnectResult, "read_connected" | "wrong_user" | "connected"> };

async function finishReadConsent(principal: ExecPrincipal, oauthCode: string | null, oauthError: string | null): Promise<Response> {
  const outcome = await readConsent(principal, oauthCode, oauthError);
  if (outcome.result === "read_connected") {
    // Scope counts only: never the token, never a name (§0.3 rule 4).
    await auditEvent(principal, {
      actor: "owner",
      action: "slack.read_consent",
      target: `exec_slack_installations:${outcome.id}`,
      input: { scopes: outcome.scopes, optional: outcome.optional }
    });
    console.info(`[exec-slack] oauth callback read_connected (${outcome.id}, ${outcome.scopes} user scopes)`);
    return settingsRedirect("read_connected");
  }
  await auditEvent(principal, { actor: "owner", action: "slack.read_consent", target: "exec_slack_installations", input: {}, ok: false, error: outcome.result });
  console.warn(`[exec-slack] oauth callback read consent ${outcome.result}`);
  return outcome.result === "wrong_user" ? settingsRedirect("wrong_user", outcome.who) : settingsRedirect(outcome.result);
}

/** Steps 6-20r2 for purpose = read: Slack's answer, the user half's checks and the save. Never throws. */
async function readConsent(principal: ExecPrincipal, oauthCode: string | null, oauthError: string | null): Promise<ReadConsentOutcome> {
  // 6-7. Cancelled in Slack; a code and a configured app.
  if (oauthError !== null) return { result: "denied" };
  if (oauthCode === null) return { result: "state_invalid" };
  const cfg: SlackConfig | null = slackConfig();
  if (cfg === null || !cryptoConfigured()) return { result: "not_configured" };

  // 8. The exchange (HTTP Basic, the canonical redirect URL).
  let access: OAuthAccessResult;
  try {
    access = await exchangeOAuthCode({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, code: oauthCode, redirectUri: SLACK_REDIRECT_URI });
  } catch (err) {
    console.warn(`[exec-slack] oauth callback: read exchange failed (${slackCode(err)})`);
    return { result: slackFailure(err, "exchange_failed") };
  }
  // The one holder of the user token (B-P6-5). Every refusal below revokes it first: nothing is stored on any of them.
  const oauthUserToken = access.authedUserToken;
  const refuse = async (outcome: ReadConsentOutcome): Promise<ReadConsentOutcome> => {
    await revokeUserGrant(oauthUserToken);
    return outcome;
  };

  // 9. A bot token (K5's in-place replacement saves it with the user half).
  const botToken = access.accessToken;
  if (access.tokenType !== "bot" || !botToken.startsWith("xoxb-")) return refuse({ result: "exchange_failed" });
  // 9r. A user token Slack issued as one. (10r: P6's step 10, which revokes it, is skipped.) An absent type reads as none.
  if (oauthUserToken === null || !oauthUserToken.startsWith("xoxp-") || access.authedUserTokenType !== "user") {
    return refuse({ result: "exchange_failed" });
  }
  // 11-13. The workspace, not an org-wide install, our app.
  if (access.isEnterpriseInstall || access.enterprisePresent) return refuse({ result: "enterprise" });
  if (access.teamId !== cfg.teamId) return refuse({ result: "wrong_team" });
  if (access.appId !== cfg.appId) return refuse({ result: "wrong_app" });
  // 14. Exactly the six bot scopes.
  const botScopes = scopeVerdict(access.scope);
  if (botScopes !== null) return refuse({ result: botScopes });
  // 15. Well-formed ids.
  const botUserId = access.botUserId;
  const authedUserId = access.authedUserId;
  if (botUserId === null || !SLACK_RE.user.test(botUserId) || authedUserId === null || !SLACK_RE.user.test(authedUserId)) {
    return refuse({ result: "exchange_failed" });
  }

  // 16-17. The consenting member is the principal: his DD email's Slack member, as the new bot token sees it (K5).
  if (typeof principal.email !== "string" || principal.email.length === 0) return refuse({ result: "identity_not_found" });
  let member: Awaited<ReturnType<typeof lookupUserByEmail>>;
  try {
    member = await lookupUserByEmail(botToken, principal.email);
  } catch (err) {
    console.warn(`[exec-slack] oauth callback: read identity lookup failed (${slackCode(err)})`);
    return refuse({ result: slackFailure(err, "exchange_failed") });
  }
  if (member === null || member.deleted || member.isBot) return refuse({ result: "identity_not_found" });
  if (member.id !== authedUserId) return refuse({ result: "wrong_user", who: authedUserId });

  // 18. The bot token is the bot user Slack named, in our workspace.
  let me: Awaited<ReturnType<typeof authTest>>;
  try {
    me = await authTest(botToken);
  } catch (err) {
    console.warn(`[exec-slack] oauth callback: read bot auth check failed (${slackCode(err)})`);
    return refuse({ result: slackFailure(err, "exchange_failed") });
  }
  const botId = me.botId;
  if (me.teamId !== cfg.teamId || me.userId !== botUserId || botId === null || !SLACK_RE.bot.test(botId)) return refuse({ result: "exchange_failed" });

  // 18r1. The user half belongs on his active installation, the one whose member he is.
  let half: Awaited<ReturnType<typeof getReadingHalf>>;
  try {
    half = await readingHalfOrNone(principal);
  } catch (err) {
    console.error(`[exec-slack] oauth callback: reading half unreadable (${errName(err)})`);
    return refuse({ result: "unavailable" });
  }
  if (half === null) return refuse({ result: "read_not_connected" });
  if (half.row.userId !== authedUserId) return refuse({ result: "wrong_user", who: authedUserId });

  // 18r2. Every required user scope, nothing outside the nine; the optional four may have been declined.
  const granted = [...new Set(access.authedUserScope ?? [])];
  const userScopes = userScopeVerdict(granted);
  if (userScopes !== null) return refuse({ result: userScopes });

  // 18r3. The user token is his, in our workspace.
  try {
    const mine = await authTest(oauthUserToken);
    if (mine.teamId !== cfg.teamId || mine.userId !== authedUserId) return refuse({ result: "exchange_failed" });
  } catch (err) {
    console.warn(`[exec-slack] oauth callback: user auth check failed (${slackCode(err)})`);
    return refuse({ result: slackFailure(err, "exchange_failed") });
  }

  // 19. The bot's DM with him (K11), as P6's install reads it.
  let dmChannelId: string;
  try {
    dmChannelId = await openDm(botToken, authedUserId);
  } catch (err) {
    console.warn(`[exec-slack] oauth callback: read DM open failed (${slackCode(err)})`);
    return refuse({ result: "slack_unavailable" });
  }
  if (!SLACK_RE.dm.test(dmChannelId)) return refuse({ result: "slack_unavailable" });

  // 20r. Both tokens sealed for this principal under their own contexts, saved in one update of the active row.
  const scopesGranted = granted.filter((x): x is SlackUserScope => USER_SCOPES_ALLOWED.has(x));
  const optional = scopesGranted.filter((x) => !USER_SCOPES_REQUIRED.has(x)).length;
  let saved: Awaited<ReturnType<typeof saveReadingConsent>>;
  try {
    const sealedBot = sealSecret(botToken, `${BOT_TOKEN_CONTEXT}${principal.id}`);
    const sealedUser = sealSecret(oauthUserToken, `${USER_TOKEN_CONTEXT}${principal.id}`);
    saved = await saveReadingConsent(principal, {
      teamId: cfg.teamId,
      appId: cfg.appId,
      botUserId,
      botId,
      botTokenSealed: sealedBot,
      keyId: sealedBot.split(".")[1] ?? "",
      botScopes: [...SLACK_BOT_SCOPES],
      userId: authedUserId,
      dmChannelId,
      userTokenSealed: sealedUser,
      userKeyId: sealedUser.split(".")[1] ?? "",
      userScopes: scopesGranted
    });
  } catch (err) {
    console.error(`[exec-slack] oauth callback: read consent save failed (${errName(err)})`);
    return refuse({ result: "unavailable" });
  }
  if (saved.outcome === "taken") return refuse({ result: "read_taken" });
  if (saved.outcome === "no_installation") return refuse({ result: "read_not_connected" });

  // 20r2. Discovery first (N2): metadata only, whatever the switch says (C8). A failed enqueue is covered by the daily run.
  try {
    await enqueueJob({
      kind: SLACK_READ_JOB_KINDS.discover,
      lane: "bulk",
      principalId: principal.id,
      payload: { installation_id: saved.id, reason: "consent" },
      dedupeKey: `slack-discover:consent:${saved.id}:${saved.installedAtMs}`,
      maxAttempts: 3
    });
  } catch (err) {
    console.error(`[exec-slack] oauth callback: discovery not enqueued (${saved.id}, ${errName(err)})`);
  }
  return { result: "read_connected", id: saved.id, scopes: scopesGranted.length, optional };
}

// ---------------------------------------------------------------------------
// P7a: withdrawing the read consent (§3.10.5 Stop reading, §3.10.8 Disconnect's first part; N4, C25, C47)
// ---------------------------------------------------------------------------

export type ReadingWithdrawal =
  /** No live reading half on this installation (none, revoked, or another installation's id). */
  | { kind: "no_half" }
  /** The user half is revoked and its data purged (revoked: false when another call got there first). slack says what Slack
   *  answered: the token revoked or already dead, not tried (the key can't open it here), or the revoke failed (C47). */
  | { kind: "withdrawn"; slack: "revoked" | "already_invalid" | "local_only" | "revoke_failed"; revoked: boolean };

/**
 * The principal's live reading half on `installationId` (reading_state discovering|ready), withdrawn: auth.revoke with
 * the user token (10 s), then exec_slack_user_revoke (marks the half revoked and purges every reading row in one
 * transaction) WHATEVER Slack answered: withdrawing consent never waits for Slack (C47). A token the key can't open
 * here (SecretUnavailableError) skips Slack ("local_only": the token is still live at Slack). A failed revoke, and a
 * local-only withdrawal, are recorded as user_last_error_code 'revoke_failed' and sent to ops with ids and codes only
 * (failedCode "key_unavailable" for the latter), so Settings asks him to remove the access in Slack. The bot token is never touched. Without the P7a schema (a P6-only database) there
 * is no reading half. Other store errors throw (the routes answer 503).
 */
export async function withdrawReadingGrant(principal: ExecPrincipal, installationId: string, reason: "stopped" | "disconnected"): Promise<ReadingWithdrawal> {
  const half = await readingHalfOrNone(principal);
  if (half === null || half.row.id !== installationId) return { kind: "no_half" };
  if (half.reading.state !== "discovering" && half.reading.state !== "ready") return { kind: "no_half" };

  let open: Awaited<ReturnType<typeof openReadingInstallation>> = null;
  try {
    open = await openReadingInstallation(principal, installationId);
  } catch (err) {
    // The token can't be opened here (a rotated or missing key): withdraw locally only.
    if (!(err instanceof SecretUnavailableError)) throw err;
  }
  let slack: "revoked" | "already_invalid" | "local_only" | "revoke_failed" = "local_only";
  let failedCode = "network";
  if (open === null) failedCode = "key_unavailable";
  else {
    try {
      slack = await revokeToken(open.target.userToken, { timeoutMs: SLACK_LIMITS.httpTimeoutMs });
    } catch (err) {
      slack = "revoke_failed";
      if (err instanceof SlackApiError) failedCode = SLACK_CODE_RE.test(err.code) ? err.code : "slack_error";
    }
  }
  const { revoked } = await userRevoke(installationId, reason);
  // P7a fixer ui-7: a token we couldn't even try to revoke is as live at Slack as one whose revoke failed.
  if (slack === "revoke_failed" || slack === "local_only") {
    await recordUserTokenError(installationId, "revoke_failed");
    console.warn(`[exec-slack] reading ${reason} ${installationId}: the Slack revoke failed (${failedCode}); reading data purged`);
    await notifyOps({
      key: "exec-slack-read-revoke-failed",
      title: "Executive Assistant: Slack reading token not revoked",
      detail: "installation " + installationId + ": auth.revoke " + (slack === "local_only" ? "not attempted" : "failed") + " (" + failedCode + "); reading data was purged, the token may still be live in Slack"
    });
  }
  return { kind: "withdrawn", slack, revoked };
}
