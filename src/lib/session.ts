// Session helpers. Two paths to "who is the current user":
//
//  - getCurrentUserId(): async, reads the Supabase session cookie and
//    resolves to the public.users.id. Use from auth-protected routes.
//
//  - CURRENT_USER_ID: legacy hardcode kept ONLY for the Electron widget
//    routes (/api/widget/*), which run from a BrowserWindow that doesn't
//    yet share session cookies. Removed when the widget gets its own auth
//    flow in Phase 4.

import { cache } from "react";
import { getSupabaseServer } from "@/lib/supabase-server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const CURRENT_USER_ID = "u_1";

// Wrapped in React.cache so multiple callers within the same render tree
// (e.g. layout AND a server-component page calling requireCurrentUserId in
// a route handler) share one DB roundtrip instead of paying it per call.
export const getCurrentUserId = cache(_getCurrentUserId);

// Read the {sub, email} claims out of a Supabase access-token JWT without
// a network call. Safe here because the token was already cryptographically
// validated by the middleware (see below) on this same request — we're only
// reading identity, not re-establishing trust on an unverified token.
function decodeAccessTokenClaims(
  accessToken: string
): { sub?: string; email?: string } | null {
  const payload = accessToken.split(".")[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

async function _getCurrentUserId(): Promise<string | null> {
  const supabase = getSupabaseServer();
  // Read the session from the cookie LOCALLY — no GoTrue round-trip. The
  // middleware (src/middleware.ts) already calls supabase.auth.getUser()
  // on every request, which is the security boundary: it validates the JWT
  // against the auth server and 401s/redirects anyone without a live
  // session. By the time a handler runs the cookie has just been verified
  // and refreshed, so re-calling getUser() here only added a second GoTrue
  // request per authed call across ~190 handlers — enough volume to trip
  // Supabase's auth rate limit (AuthApiError: over_request_rate_limit).
  const { data: { session } } = await supabase.auth.getSession();
  const claims = session?.access_token
    ? decodeAccessTokenClaims(session.access_token)
    : null;
  const authUserId = claims?.sub;
  if (!authUserId) return null;
  const authEmail = claims?.email ?? null;

  const admin = getSupabaseAdmin();

  // Happy path: row was linked by the on_auth_user_created trigger.
  const linked = await admin
    .from("users")
    .select("id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (linked.data?.id) return linked.data.id;

  // Fallback: trigger didn't run (auth user pre-dated the trigger, or the
  // auth-link migration hasn't been applied yet). Try to link by email.
  // This is self-healing — first authed visit fixes the link permanently.
  if (!authEmail) return null;
  const byEmail = await admin
    .from("users")
    .select("id, auth_user_id")
    .ilike("email", authEmail)
    .maybeSingle();
  if (!byEmail.data) return null;
  if (byEmail.data.auth_user_id && byEmail.data.auth_user_id !== authUserId) {
    // Email matches a row already claimed by a different auth identity.
    // Don't silently steal it — refuse to authorize.
    return null;
  }
  if (!byEmail.data.auth_user_id) {
    await admin
      .from("users")
      .update({ auth_user_id: authUserId })
      .eq("id", byEmail.data.id);
  }
  return byEmail.data.id;
}

export async function requireCurrentUserId(): Promise<string> {
  const id = await getCurrentUserId();
  if (!id) throw new Error("not authenticated");
  return id;
}
