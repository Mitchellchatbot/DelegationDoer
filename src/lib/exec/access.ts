import "server-only";

import { NextResponse } from "next/server";
import { isOwner } from "@/lib/access";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getSupabaseServer } from "@/lib/supabase-server";
import { loadPrincipalForUser } from "@/lib/exec/principal";
import type { ExecPrincipal, ExecSurface } from "@/lib/exec/types";

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
// The chain is session → users row → v1 owner guard → enabled exec principal.
// Anyone who isn't the owner gets the same 404 a missing route would, so other
// signed-in staff can't confirm the feature exists. Every failure denies.
// Nothing here falls back to "allow".

export function isExecEnabled(): boolean {
  return process.env.EXEC_ENABLED === "true";
}

export type ExecAccessResult = { ok: true; principal: ExecPrincipal } | { ok: false; response: NextResponse };

export interface AccessLogEntry {
  principalId: string | null;
  authUserId: string | null;
  sessionId: string | null;
  ip: string | null;
  userAgent: string | null;
  route: string;
  surface: ExecSurface;
}

// Column caps for exec_access_log. Header values come from the client, so
// none of them may grow a row without bound.
const MAX_USER_AGENT = 400;
const MAX_IP = 64;
const MAX_ID = 128;
const MAX_ROUTE = 200;

function deny(status: 401 | 404 | 503, error: string): ExecAccessResult {
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
 */
export async function requireExecPrincipal(req: Request, route: string): Promise<ExecAccessResult> {
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

  // 5. The enabled principal for that user.
  let principal: ExecPrincipal | null;
  try {
    principal = await loadPrincipalForUser(userRow.id);
  } catch (err) {
    console.error(`[exec-access] ${route}: principal lookup failed: ${errMessage(err)}`);
    return authUnavailable();
  }
  if (!principal) return notFound();

  // 6–7. Record the access. Both steps are best-effort and never deny: the
  // caller is already verified, and losing a log row must not lock the owner out.
  const sessionId = await readSessionId(supabase, authUserId, route);
  await logAccess({
    principalId: principal.id,
    authUserId,
    sessionId,
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent"),
    route,
    surface: "web"
  });

  return { ok: true, principal };
}

// The session id is for the access log only (which device/session made the
// call), never for identity, which step 2 already settled. It is read from
// the session's access token because GoTrue's user object doesn't carry it.
async function readSessionId(
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
    // Bound to the verified user: a token for anyone else must not put its
    // session id on the owner's access log.
    const sessionId = sessionIdFromAccessToken(token, authUserId);
    if (!sessionId) console.warn(`[exec-access] ${route}: access token carried no usable session_id`);
    return sessionId;
  } catch (err) {
    console.warn(`[exec-access] ${route}: no session id for the access log: ${errMessage(err)}`);
    return null;
  }
}

/** Insert one exec_access_log row. Never throws; a failed write is logged and the request goes on. */
export async function logAccess(entry: AccessLogEntry): Promise<void> {
  try {
    const { error } = await getSupabaseAdmin()
      .from("exec_access_log")
      .insert({
        principal_id: entry.principalId,
        auth_user_id: clip(entry.authUserId, MAX_ID),
        session_id: clip(entry.sessionId, MAX_ID),
        ip: clip(entry.ip, MAX_IP),
        user_agent: clip(entry.userAgent, MAX_USER_AGENT),
        route: clip(entry.route, MAX_ROUTE) ?? "",
        surface: entry.surface
      });
    if (error) console.error(`[exec-access] access log write failed (${entry.route}): ${error.message}`);
  } catch (err) {
    console.error(`[exec-access] access log write failed (${entry.route}): ${errMessage(err)}`);
  }
}

/**
 * Client IP for the access log: the first X-Forwarded-For entry, else
 * X-Real-IP, else null. Informational only. A client can put its own value at
 * the front of X-Forwarded-For, so nothing may authorize on this.
 */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const real = req.headers.get("x-real-ip")?.trim();
  return real || null;
}

/**
 * The `session_id` claim of a Supabase access token, or null. Never throws.
 *
 * Reads the payload WITHOUT verifying the signature, so call it only on a
 * token whose identity GoTrue already confirmed. With `expectedSub`, a token
 * whose `sub` isn't that user yields null.
 */
export function sessionIdFromAccessToken(token: string, expectedSub?: string): string | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    // Not JSON: there is no claim to read. null is the documented answer and
    // readSessionId logs it, so nothing is hidden here.
    return null;
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
  const { sub, session_id: sessionId } = claims as Record<string, unknown>;
  if (expectedSub !== undefined && sub !== expectedSub) return null;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}
