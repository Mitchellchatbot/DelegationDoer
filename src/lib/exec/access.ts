import "server-only";

import { isIP } from "node:net";
import { headers } from "next/headers";
import { notFound as renderNotFound } from "next/navigation";
import { NextResponse } from "next/server";
import { isOwner } from "@/lib/access";
import { cache } from "@/lib/safe-cache";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getSupabaseServer } from "@/lib/supabase-server";
import { loadPrincipalForUser, loadSettings } from "@/lib/exec/principal";
import type { ExecPrincipal, ExecSurface } from "@/lib/exec/types";
import { chatEmailOn } from "@/lib/exec/chat/email-on";
import { notifyOps } from "@/lib/exec/ops";

// The gate in front of every Executive AI Assistant page and API route.
//
//   const gate = await requireExecPrincipal(req, "GET /api/exec/overview");
//   if (!gate.ok) return gate.response;
//   // ...use gate.principal
//
// Identity comes from GoTrue: auth.getUser() sends the access token to the
// auth server, which checks it. Nothing here decodes the cookie to decide who
// is asking. session.ts does decode it locally and trusts the middleware to
// have verified it, and the plan's P0 list shows the middleware skips some
// paths, which is not good enough in front of CEO data.
//
// The chain is session → users row → v1 owner guard → (step-up) → enabled exec
// principal. Anyone who isn't the owner gets a 404, the status a missing route
// gets, and nothing of the feature: no data and no wording that names it.
// How far that hides the routes themselves is spelled out at
// requireExecPrincipalForPage and in next.config.mjs. Every failure denies.
// Nothing here falls back to "allow".
//
// The step-up: any leader can mint a one-time sign-in link for the owner's
// account (users/[id]/magic-link; the team signs in as him by agreement), and
// the session it opens passes every identity check above. Since 2026-11-10
// the assistant opens for those sessions too (the team's call), so the
// step-up is OFF unless EXEC_REQUIRE_PASSWORD_SIGNIN=true (isStepUpOn). When
// on, a surface that asks for it (requireStrongSignIn; the page gate always
// asks) admits only a password sign-in with no one-time link anywhere in its
// record (signInIsStrong reads GoTrue's amr; a second factor can only add to a
// password sign-in, never replace it, P9 F1), and every refusal leaves one
// access-log row (route + " step_up_refused") and a daily-keyed ops alert,
// without waiting on either. Even when on, a link session can set a new
// password from DD's Settings and sign in with it (P9's authenticator closed
// that; it was removed on 2026-11-10). docs/exec-assistant.md §14 has both.

export function isExecEnabled(): boolean {
  return process.env.EXEC_ENABLED === "true";
}

/**
 * Whether the step-up runs: only when EXEC_REQUIRE_PASSWORD_SIGNIN is "true". Off (the default since 2026-11-10), a
 * surface that asks for it admits every session on the owner's account, the team's sign-in link sessions included.
 */
export function isStepUpOn(): boolean {
  return process.env.EXEC_REQUIRE_PASSWORD_SIGNIN === "true";
}

export type ExecAccessResult = { ok: true; principal: ExecPrincipal } | { ok: false; response: NextResponse };

export interface ExecGateOptions {
  /**
   * This surface asks for the step-up (P9 F1). It runs only while isStepUpOn(): then only a password sign-in with no
   * one-time link (signInIsStrong) is admitted, anything else gets the same 404 plus a refusal row and an ops alert, and
   * a session that can't be read for an outage gets a 503. Either way, every admitted access to the surface goes
   * through the P8 new-network check. requireExecPrincipalForPage always sets it, and so does every exec API route
   * (boundary rule 13). It is opt-in only because requireExecPrincipal predates it and P2a's tests pin its behaviour
   * without it.
   */
  requireStrongSignIn?: boolean;
}

/** P9 (F2 step 3): what a refused step-up's access-log row appends to the gate's route. */
export const STEP_UP_REFUSED_SUFFIX = " step_up_refused";

/** P9 (F2 step 3, L4): the refusal's ops alert. Daily-keyed (UTC); the detail carries the sign-in methods and aal. */
export const STEP_UP_REFUSED_OPS = Object.freeze({
  key: (utcDate: string) => `exec-step-up-refused:${utcDate}`,
  title: "A session on the owner's account that wasn't a password sign-in was refused"
});

export interface AccessLogEntry {
  principalId: string | null;
  authUserId: string | null;
  sessionId: string | null;
  ip: string | null;
  userAgent: string | null;
  route: string;
  surface: ExecSurface;
  /** P6 (§3.8): surface "slack" only (the exec_access_log_slack_surface_check CHECK). */
  slackUserId?: string | null;
  slackEventId?: string | null;
}

/** P6 (contract §3.8, C3): requireExecPrincipal's result plus the verified auth user id and session id (the OAuth binding). */
export type ExecSessionResult =
  | { ok: true; principal: ExecPrincipal; authUserId: string; sessionId: string | null }
  | { ok: false; response: NextResponse };


// Column caps for exec_access_log. Header values come from the client, so
// none of them may grow a row without bound.
const MAX_USER_AGENT = 400;
const MAX_IP = 64;
const MAX_ID = 128;
const MAX_ROUTE = 200;
/** exec_access_log.slack_user_id / slack_event_id (P6 §3.8): Slack ids are far shorter; the CHECKs hold the shapes. */
const MAX_SLACK_ID = 40;

type ExecDenied = { ok: false; response: NextResponse };

function deny(status: 401 | 404 | 503, error: string): ExecDenied {
  return { ok: false, response: NextResponse.json({ error }, { status }) };
}

const notFound = () => deny(404, "not found");
const unauthorized = () => deny(401, "unauthorized");
// Infrastructure failures (env missing, auth server or database unreachable)
// are a 503, not a 401 or 404. A wrong "not signed in" or "not found" would
// send the owner chasing a permissions problem during an outage.
const authUnavailable = () => deny(503, "auth unavailable");

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * auth-js reports a network failure or a 502/503/504/52x gateway answer as an
 * AuthRetryableFetchError, and GoTrue's own 429 or 5xx as an error carrying
 * that status. Both are returned in `error`, not thrown, and both mean "can't
 * tell right now", not "this caller is signed out".
 */
function isAuthOutage(error: { name?: string; status?: number }): boolean {
  if (error.name === "AuthRetryableFetchError") return true;
  return typeof error.status === "number" && (error.status === 429 || error.status >= 500);
}

/** Cut to n UTF-16 units without splitting a surrogate pair. Postgres rejects a lone half. */
function clip(value: string | null | undefined, n: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length <= n) return value;
  const code = value.charCodeAt(n - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

/**
 * Who the request is from, as an ExecPrincipal, or the response to send instead.
 * `route` names the endpoint in the access log, e.g. "GET /api/exec/overview".
 * The gates are requireExecSession's; this keeps the result shape every exec
 * route was written against.
 */
export async function requireExecPrincipal(req: Request, route: string, opts: ExecGateOptions = {}): Promise<ExecAccessResult> {
  const session = await requireExecSession(req, route, opts);
  return session.ok ? { ok: true, principal: session.principal } : session;
}

/**
 * P6 (contract §3.8, C3): requireExecPrincipal's gates 1–8 exactly, also
 * returning the auth user id GoTrue verified and the session id the access log
 * records (with requireStrongSignIn, the strong token's own session_id). The
 * Slack OAuth start binds its state row to both, and the callback refuses a
 * state issued to another sign-in (C1). Like requireExecPrincipal, it is a
 * principal path (boundary PRINCIPAL_EXPORTS, B-P6-7).
 */
export async function requireExecSession(req: Request, route: string, opts: ExecGateOptions = {}): Promise<ExecSessionResult> {
  // 1. Feature flag. Off looks exactly like a route that doesn't exist.
  if (!isExecEnabled()) return notFound();

  // 2. Verified identity.
  let supabase: ReturnType<typeof getSupabaseServer>;
  try {
    supabase = getSupabaseServer();
  } catch (err) {
    console.error(`[exec-access] ${route}: auth client unavailable: ${errMessage(err)}`);
    return authUnavailable();
  }

  let authUserId: string;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error && isAuthOutage(error)) {
      console.error(`[exec-access] ${route}: auth server unavailable: ${error.name}: ${error.message}`);
      return authUnavailable();
    }
    if (error || !data.user?.id) {
      // "No session" is the ordinary signed-out case and not worth a line.
      // Anything else (GoTrue unreachable, a token it rejected) still denies,
      // but is logged so an auth outage doesn't pass for a run of plain 401s.
      if (error && error.name !== "AuthSessionMissingError") {
        console.warn(`[exec-access] ${route}: getUser refused the session: ${error.name}: ${error.message}`);
      }
      return unauthorized();
    }
    authUserId = data.user.id;
  } catch (err) {
    // getUser() reports auth failures in `error`. A throw means the client
    // itself broke, which is an outage, not a verdict on the caller.
    console.error(`[exec-access] ${route}: getUser threw: ${errMessage(err)}`);
    return authUnavailable();
  }

  // 3. The DD users row linked to that auth account (users.auth_user_id is unique).
  let userRow: { id: string; email: string | null } | null;
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("users")
      .select("id,email")
      .eq("auth_user_id", authUserId)
      .maybeSingle();
    if (error) {
      console.error(`[exec-access] ${route}: users lookup failed: ${error.message}`);
      return authUnavailable();
    }
    userRow = (data as { id: string; email: string | null } | null) ?? null;
  } catch (err) {
    console.error(`[exec-access] ${route}: users lookup threw: ${errMessage(err)}`);
    return authUnavailable();
  }
  if (!userRow?.id) return notFound();

  // 4. v1 guard. This is the only place exec code calls isOwner: authority
  // runs through the principal everywhere else, so adding a second executive
  // later means changing this line and nothing downstream.
  if (!isOwner({ email: userRow.email ?? "" })) return notFound();

  // 5. Step-up, when asked for and switched on (isStepUpOn): how this session
  // was signed in (P9 F1). Only the owner's account gets this far, so only a
  // session on it ever sees this answer: 404 for anything but a password
  // sign-in (or a session that can't be read), 503 when the session can't be
  // read for an outage. Each refusal is recorded without holding the 404
  // (recordStepUpRefusal). Off, every session on his account goes on.
  let checkedToken: string | null = null;
  if (opts.requireStrongSignIn && isStepUpOn()) {
    const session = await readAccessToken(supabase, route);
    if (!session.ok) return session.outage ? authUnavailable() : notFound();
    if (!signInIsStrong(session.token, authUserId)) {
      // The amr methods only ("otp"): computed first, so the log line never names the session's token.
      const methods = signInMethods(session.token, authUserId);
      console.warn(`[exec-access] ${route}: step-up refused a session on the owner's account (sign-in: ${methods})`);
      recordStepUpRefusal(req, route, userRow.id, authUserId, session.token);
      return notFound();
    }
    checkedToken = session.token;
  }

  // 6. The enabled principal for that user.
  let principal: ExecPrincipal | null;
  try {
    principal = await loadPrincipalForUser(userRow.id);
  } catch (err) {
    console.error(`[exec-access] ${route}: principal lookup failed: ${errMessage(err)}`);
    return authUnavailable();
  }
  if (!principal) return notFound();

  // 7–8. Record the access. Both steps are best-effort and never deny: the
  // caller is already verified, and losing a log row must not lock the owner out.
  const token = checkedToken ?? (await readSessionToken(supabase, authUserId, route));
  const sessionId = token !== null ? sessionIdFromAccessToken(token, authUserId) : null;
  const entry: AccessLogEntry = {
    principalId: principal.id,
    authUserId,
    sessionId,
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent"),
    route,
    surface: "web"
  };
  await logAccess(entry);

  // 9. P8 (M13, C20): an admitted password sign-in (signInIsStrong) on a surface that asks for the step-up, from a
  // network or browser family not seen lately, raises an alert (an exec-bot DM to him and an ops alert), whether or not
  // the step-up is switched on. The team's sign-in link sessions, admitted while it is off, never raise it: they are
  // expected, and the alert carries nothing that would tell him who it was. Fire-and-forget: the request never waits
  // on it, and the module is loaded lazily (it imports jobs.ts, which imports this file). A failure is logged by route
  // and error name only.
  if (opts.requireStrongSignIn && token !== null && signInIsStrong(token, authUserId)) noteWebAccess(principal, entry);

  return { ok: true, principal, authUserId, sessionId };
}

/**
 * P9 (F2 step 3, L4): a refused step-up leaves one exec_access_log row (the gate's route + STEP_UP_REFUSED_SUFFIX,
 * surface web, the same session, IP and user agent every access row carries; principal_id from the enabled principal,
 * null when it can't be read) and a daily-keyed ops alert (sign-in methods and aal; never the token). Fire-and-forget:
 * the 404 never waits on either, and nothing here throws.
 */
function recordStepUpRefusal(req: Request, route: string, ddUserId: string, authUserId: string, token: string): void {
  try {
    const sessionId = sessionIdFromAccessToken(token, authUserId);
    const ip = clientIp(req);
    const userAgent = req.headers.get("user-agent");
    const detail = `${signInMethods(token, authUserId)} aal=${tokenAal(token, authUserId)}`;
    void (async () => {
      let principalId: string | null = null;
      try {
        principalId = (await loadPrincipalForUser(ddUserId))?.id ?? null;
      } catch {
        principalId = null;
      }
      await logAccess({ principalId, authUserId, sessionId, ip, userAgent, route: `${route}${STEP_UP_REFUSED_SUFFIX}`, surface: "web" });
      // The title is a literal (= STEP_UP_REFUSED_OPS.title, pinned by ui/page-access.test.ts): boundary B-P8-6 reads any
      // other .title handed to an alert as content.
      await notifyOps({
        key: STEP_UP_REFUSED_OPS.key(new Date().toISOString().slice(0, 10)),
        title: "A session on the owner's account that wasn't a password sign-in was refused",
        detail
      });
    })().catch((err: unknown) => console.warn(`[exec-access] ${route}: the step-up refusal could not be recorded (${errorName(err)})`));
  } catch (err) {
    console.warn(`[exec-access] ${route}: the step-up refusal could not be recorded (${errorName(err)})`);
  }
}

/** The token's aal claim when it is a short lower-case word ("aal1"), else "?"; for a refusal alert only. */
function tokenAal(token: string, expectedSub: string): string {
  const aal = accessTokenClaims(token, expectedSub)?.aal;
  return typeof aal === "string" && /^[a-z0-9]{1,8}$/.test(aal) ? aal : "?";
}

function noteWebAccess(principal: ExecPrincipal, entry: AccessLogEntry): void {
  const sighting = { ip: entry.ip, userAgent: entry.userAgent, now: new Date() };
  void import("@/lib/exec/handlers/access-alert")
    .then((m) => m.noteStrongWebAccess(principal, sighting))
    .catch((err: unknown) => console.warn(`[exec-access] ${entry.route}: new-network check unavailable (${errorName(err)})`));
}

/** An Error's class name for a log line (never its message), or "error". */
function errorName(err: unknown): string {
  return err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "error";
}

// A server-component page has no Request, so the page gate builds one from
// the incoming headers. requireExecPrincipal reads exactly these off it (the
// client IP and user agent, for the access log) and never its URL; identity
// comes from the session cookie through getSupabaseServer().
const PAGE_FORWARDED_HEADERS = ["user-agent", "x-forwarded-for", "x-real-ip"] as const;

/**
 * The gate for an exec page, called first, before the page renders anything:
 *
 *   const principal = await requireExecPrincipalForPage("GET /executive");
 *
 * Same checks as requireExecPrincipal, asking for the step-up: while it is
 * switched on (isStepUpOn), a session on the owner's account opened by a
 * one-time sign-in link gets the 404 too; off (the default), every session on
 * his account opens these pages. A 401 or 404 renders Next's
 * not-found page, the one a missing route gets (a signed-out browser was
 * already sent to /login by the middleware, so a 401 here is a session
 * GoTrue refused). It doesn't hide that the route exists from signed-in
 * staff: the segment's loading.tsx has streamed by then, so the not-found
 * page arrives in a 200 response (a soft 404, as on /scale). What never
 * reaches them is the feature itself: no text, data or nav row. A 503
 * throws to the segment's error.tsx instead: during an outage a 404 would
 * tell the owner his page is gone. Anything else also 404s, so a new deny
 * status can't fall through to rendering.
 *
 * Memoized per request: every caller in one render shares the first call, so
 * a page costs one auth check and one access-log row however many components
 * ask.
 */
export const requireExecPrincipalForPage: (route: string) => Promise<ExecPrincipal> = cache(
  async (route: string): Promise<ExecPrincipal> => {
    const incoming = headers();
    const forwarded = new Headers();
    for (const name of PAGE_FORWARDED_HEADERS) {
      const value = incoming.get(name);
      if (value !== null) forwarded.set(name, value);
    }
    // The URL is a placeholder (.internal is reserved and never resolves).
    const gate = await requireExecPrincipal(new Request("https://exec.internal/", { headers: forwarded }), route, {
      requireStrongSignIn: true
    });
    if (gate.ok) return gate.principal;
    if (gate.response.status === 503) throw new Error("exec: temporarily unavailable");
    renderNotFound();
  }
);

/** The Sidebar row for the exec pages. */
export interface ExecNavItem {
  href: string;
  label: string;
}

const EXEC_NAV_ITEM: ExecNavItem = Object.freeze({ href: "/executive", label: "Executive AI" });

/**
 * True when this request's session would pass the page gate's step-up: always while it is switched off (the
 * default); on, when the cookie session's token is a strong sign-in for its user (signInIsStrong with the sub bound).
 * P9 (F1, AM-P9-12): the same check the page gate makes, so with the step-up on a link session gets no nav row and no
 * routing. Visibility only; the callers swallow every error.
 */
async function sessionPassesStepUp(): Promise<boolean> {
  if (!isStepUpOn()) return true;
  const { data, error } = await getSupabaseServer().auth.getSession();
  if (error) return false;
  const token = data.session?.access_token;
  const userId = data.session?.user?.id;
  if (typeof token !== "string" || typeof userId !== "string" || userId === "") return false;
  return signInIsStrong(token, userId);
}

/**
 * The Sidebar row for the exec pages, or null when this request shouldn't see
 * it: the flag is off, the user isn't the owner, or (with the step-up switched
 * on) the session isn't one the page gate admits. The
 * Sidebar is a client component, so the row's label and link reach a browser
 * only in this value, sent with the page the server drew it on. Visibility
 * only: the page gate is the control. Never throws; a session it can't read
 * gets no row.
 */
export async function execNavItemFor(user: Parameters<typeof isOwner>[0]): Promise<ExecNavItem | null> {
  if (!isExecEnabled() || !isOwner(user)) return null;
  try {
    return (await sessionPassesStepUp()) ? EXEC_NAV_ITEM : null;
  } catch {
    // The row is a convenience; a broken read just leaves it out.
    return null;
  }
}

/**
 * True when the AI drawer should answer through the assistant for this
 * request (P5b contract §3.19.10, B10): EXEC_ENABLED, the owner, a session
 * the page gate's step-up admits (any session while it is switched off; a
 * strong sign-in when on, P9 F1), an enabled principal, and chatSchemaReady ∧
 * chatEnabled ∧ askAiUsesExec. Never throws (false on any error); never hands
 * out a principal. Visibility only: /api/exec/chat gates for real. The
 * (main) layout passes the answer to the drawer as one boolean, so everyone
 * else and the legacy route are unchanged.
 */
export async function execAskAiRoutingFor(user: Parameters<typeof isOwner>[0] & { id: string }): Promise<boolean> {
  return (await execAskAiRoutingStateFor(user)).routed;
}

/**
 * execAskAiRoutingFor's answer and, when routed, chatEmailOn for the drawer's copy (ui-10), from the same reads.
 * Never throws ({ routed: false, emailOn: false } on any error).
 */
export async function execAskAiRoutingStateFor(user: Parameters<typeof isOwner>[0] & { id: string }): Promise<{ routed: boolean; emailOn: boolean }> {
  const off = { routed: false, emailOn: false };
  try {
    if (!isExecEnabled() || !isOwner(user) || typeof user?.id !== "string" || user.id === "") return off;
    if (!(await sessionPassesStepUp())) return off;
    const principal = await loadPrincipalForUser(user.id);
    if (!principal) return off;
    const settings = await loadSettings(principal.id);
    const routed = settings.chatSchemaReady === true && settings.chatEnabled === true && settings.askAiUsesExec === true;
    return routed ? { routed, emailOn: chatEmailOn(settings, principal) } : off;
  } catch {
    // A convenience like the nav row: any failure keeps the drawer as it is.
    return off;
  }
}

type AccessTokenRead = { ok: true; token: string } | { ok: false; outage: boolean };

/**
 * The session's access token, for the step-up. getUser() has already had
 * GoTrue verify the session these cookies hold, and getSession() reads the
 * same cookies; signInIsStrong also binds the token to the verified user.
 */
async function readAccessToken(supabase: ReturnType<typeof getSupabaseServer>, route: string): Promise<AccessTokenRead> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      if (isAuthOutage(error)) {
        console.error(`[exec-access] ${route}: session unreadable for the sign-in check: ${error.name}: ${error.message}`);
        return { ok: false, outage: true };
      }
      console.warn(`[exec-access] ${route}: session unreadable for the sign-in check: ${error.message}`);
      return { ok: false, outage: false };
    }
    const token = data.session?.access_token;
    return typeof token === "string" && token.length > 0 ? { ok: true, token } : { ok: false, outage: false };
  } catch (err) {
    // As with getUser: a throw means the client broke, not a verdict on the caller.
    console.error(`[exec-access] ${route}: getSession threw: ${errMessage(err)}`);
    return { ok: false, outage: true };
  }
}

// One-time sign-in links and codes, as GoTrue names them in the amr claim.
// DD's admin-minted links (signin/[claimId], generateLink) use the implicit
// flow, which GoTrue records as "otp"; the PKCE flow records "magiclink". A
// recovery, invite, signup or email-change link opens a session too.
const ONE_TIME_SIGN_IN_METHODS: ReadonlySet<string> = new Set(["otp", "magiclink", "recovery", "invite", "email/signup", "email_change"]);

/**
 * True when the session behind `token` was signed in with a password and no
 * one-time link appears anywhere in its record, whatever its aal. GoTrue
 * writes `amr` into every access token: how the session was authenticated
 * ([{ method, timestamp }], and a refresh keeps the list). A second factor
 * (aal2) can only add to a password sign-in, never replace it: a link session
 * that enrols and verifies its own authenticator reaches aal2 with amr
 * [totp, otp], and is still a link session (P9 F1). Anything else is false, a
 * token that doesn't say included.
 *
 * Reads the payload WITHOUT verifying the signature, so call it only on a
 * token whose session GoTrue already confirmed; with `expectedSub`, a token
 * for anyone else is false.
 */
export function signInIsStrong(token: string, expectedSub?: string): boolean {
  const claims = accessTokenClaims(token, expectedSub);
  if (!claims) return false;
  const methods = amrMethods(claims);
  if (methods === null || methods.length === 0) return false;
  if (methods.some((method) => method === null || ONE_TIME_SIGN_IN_METHODS.has(method))) return false;
  return methods.includes("password");
}

/** Each amr entry's method (null for an entry without one), or null when amr isn't a list. */
function amrMethods(claims: Record<string, unknown>): (string | null)[] | null {
  if (!Array.isArray(claims.amr)) return null;
  return claims.amr.map((entry: unknown) => {
    const method = typeof entry === "object" && entry !== null ? (entry as { method?: unknown }).method : undefined;
    return typeof method === "string" ? method : null;
  });
}

/** How a token says its session was signed in, for a log line ("otp"); nothing else from the token. */
function signInMethods(token: string, expectedSub: string): string {
  const claims = accessTokenClaims(token, expectedSub);
  if (!claims) return "unreadable, or not the verified user's token";
  const methods = amrMethods(claims) ?? [];
  return methods.length > 0 ? (clip(methods.map((method) => method ?? "?").join(", "), 80) ?? "") : "none recorded";
}

// The cookie session's access token, read when the step-up didn't already read
// it: for the session id (which device/session made the call, for the access
// log only) and the new-network check's sign-in method, never for identity,
// which step 2 already settled. GoTrue's user object carries neither. Every
// reader binds it to the verified user (sessionIdFromAccessToken and
// signInIsStrong take authUserId), so a token for anyone else yields no
// session id and no alert. Best effort: null (and a log line) when it can't
// be read; never a denial.
async function readSessionToken(
  supabase: ReturnType<typeof getSupabaseServer>,
  authUserId: string,
  route: string
): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      console.warn(`[exec-access] ${route}: no session id for the access log: ${error.message}`);
      return null;
    }
    const token = data.session?.access_token;
    if (!token) return null;
    if (!sessionIdFromAccessToken(token, authUserId)) console.warn(`[exec-access] ${route}: access token carried no usable session_id`);
    return token;
  } catch (err) {
    console.warn(`[exec-access] ${route}: no session id for the access log: ${errMessage(err)}`);
    return null;
  }
}

/**
 * Insert one exec_access_log row. Never throws; a failed write is logged and the request goes on.
 *
 * P6 (§3.8, K9): a surface "slack" row whose entry carries the Slack ids
 * (slackUserId / slackEventId, either one set, null included) also writes
 * slack_user_id and slack_event_id, each clipped to 40. No other row names
 * those columns, so web rows (and P2a's Slack-surface rows without the ids)
 * keep writing exactly as before, also before the P6 migration adds them.
 * The Slack DM job passes null for the auth user, session, IP and user agent:
 * the request came from Slack's servers, not from his browser (CODE §10).
 */
export async function logAccess(entry: AccessLogEntry): Promise<void> {
  const row: Record<string, unknown> = {
    principal_id: entry.principalId,
    auth_user_id: clip(entry.authUserId, MAX_ID),
    session_id: clip(entry.sessionId, MAX_ID),
    ip: clip(entry.ip, MAX_IP),
    user_agent: clip(entry.userAgent, MAX_USER_AGENT),
    route: clip(entry.route, MAX_ROUTE) ?? "",
    surface: entry.surface
  };
  if (entry.surface === "slack" && (entry.slackUserId !== undefined || entry.slackEventId !== undefined)) {
    row.slack_user_id = clip(entry.slackUserId ?? null, MAX_SLACK_ID);
    row.slack_event_id = clip(entry.slackEventId ?? null, MAX_SLACK_ID);
  }
  try {
    const { error } = await getSupabaseAdmin()
      .from("exec_access_log")
      .insert(row);
    if (error) console.error(`[exec-access] access log write failed (${entry.route}): ${error.message}`);
  } catch (err) {
    console.error(`[exec-access] access log write failed (${entry.route}): ${errMessage(err)}`);
  }
}

/**
 * C21: the right-most X-Forwarded-For entry (the hop Railway's proxy appends), trimmed, ":port" and [brackets] stripped,
 * valid per node:net isIP; else null. X-Real-IP is no longer read. Informational and alerting only: nothing authorizes on it.
 *
 * A client can write anything at the FRONT of X-Forwarded-For; the proxy appends the address it saw, so the last entry is
 * the one the client didn't choose (P8 M13; Railway's appending is checked live, §7.3). An invalid last entry is null:
 * never a fall back to an earlier, client-written one.
 */
export function clientIp(req: Request): string | null {
  const header = req.headers.get("x-forwarded-for");
  if (header === null) return null;
  const entries = header.split(",");
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const raw = entries[i].trim();
    if (raw !== "") return normalizeIp(raw);
  }
  return null;
}

/** "[v6]:port" / "[v6]" → v6; "v4:port" → v4; then a literal per isIP, or null. */
function normalizeIp(raw: string): string | null {
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(raw);
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(raw);
  const candidate = bracketed ? bracketed[1] : v4WithPort ? v4WithPort[1] : raw;
  const kind = isIP(candidate);
  if (kind === 4) return candidate;
  if (kind === 6) return candidate.toLowerCase();
  return null;
}

/**
 * P8 (§3.19, C20): the principal's web access rows with created_at in [fromIso, toIso), newest first, at most `limit`;
 * the ip and user_agent columns only. Surface "slack" rows are never read (K9). Throws on a read error.
 * P9 (AM-P9-13): a refused step-up's row (route ending in STEP_UP_REFUSED_SUFFIX) is never read either: a session the
 * gate turned away must not make its network or browser "seen", nor fill the window the new-network check reads.
 */
export async function listWebAccessSince(principalId: string, fromIso: string, toIso: string, limit: number):
  Promise<{ ip: string | null; userAgent: string | null }[]> {
  if (typeof principalId !== "string" || principalId.length === 0) throw new TypeError("listWebAccessSince: principalId is required");
  if (!Number.isFinite(Date.parse(fromIso)) || !Number.isFinite(Date.parse(toIso))) throw new TypeError("listWebAccessSince: expected ISO instants");
  const n = Math.max(1, Math.min(Math.trunc(limit), 5_000));
  const { data, error } = await getSupabaseAdmin()
    .from("exec_access_log")
    .select("ip,user_agent")
    .eq("principal_id", principalId)
    .eq("surface", "web")
    .not("route", "like", `%${STEP_UP_REFUSED_SUFFIX}`)
    .gte("created_at", fromIso)
    .lt("created_at", toIso)
    .order("created_at", { ascending: false })
    .limit(n);
  if (error) throw new Error(`exec_access_log read failed: ${error.message}`);
  const rows = Array.isArray(data) ? (data as { ip?: unknown; user_agent?: unknown }[]) : [];
  return rows.map((r) => ({
    ip: typeof r.ip === "string" ? r.ip : null,
    userAgent: typeof r.user_agent === "string" ? r.user_agent : null
  }));
}

/**
 * The payload of an access token, or null when it can't be read or, with
 * `expectedSub`, belongs to someone else. Unverified: see the callers.
 */
function accessTokenClaims(token: string, expectedSub?: string): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    // Not JSON: there is no claim to read. null is the documented answer and
    // every caller treats it as "doesn't say", so nothing is hidden here.
    return null;
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
  const record = claims as Record<string, unknown>;
  if (expectedSub !== undefined && record.sub !== expectedSub) return null;
  return record;
}

/**
 * The `session_id` claim of a Supabase access token, or null. Never throws.
 *
 * Reads the payload WITHOUT verifying the signature, so call it only on a
 * token whose identity GoTrue already confirmed. With `expectedSub`, a token
 * whose `sub` isn't that user yields null.
 */
export function sessionIdFromAccessToken(token: string, expectedSub?: string): string | null {
  const sessionId = accessTokenClaims(token, expectedSub)?.session_id;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}
