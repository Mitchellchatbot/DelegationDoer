import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

// GET /api/integrations/google/callback — Google redirects here
// after the user authorizes. We verify state, exchange the code for
// access + refresh tokens, decode the id_token to grab the user's
// Google id + email, and persist everything on their row.
export async function GET(req: NextRequest) {
  const userId = await requireCurrentUserId();
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const cookieStore = cookies();
  const expectedState = cookieStore.get("google_oauth_state")?.value;
  cookieStore.set("google_oauth_state", "", { path: "/", maxAge: 0 });

  if (error) return errorRedirect(req, `google returned: ${error}`);
  if (!code) return errorRedirect(req, "missing code");
  if (!state || state !== expectedState) {
    return errorRedirect(req, "state mismatch — try again");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return errorRedirect(req, "GOOGLE_CLIENT_ID / SECRET missing on server");
  }

  const baseUrl = (
    process.env.NEXT_PUBLIC_APP_URL ||
    "https://delegationdoer-production.up.railway.app"
  ).replace(/\/$/, "");
  const redirectUri = `${baseUrl}/api/integrations/google/callback`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    })
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) {
    return errorRedirect(
      req,
      `token exchange failed: ${tokenData.error_description || tokenData.error || tokenRes.status}`
    );
  }

  const accessToken = tokenData.access_token as string | undefined;
  const refreshToken = tokenData.refresh_token as string | undefined;
  const expiresIn = Number(tokenData.expires_in ?? 3600);
  const idToken = tokenData.id_token as string | undefined;
  if (!accessToken || !refreshToken) {
    return errorRedirect(
      req,
      "Google didn't return a refresh_token — try again from a clean Google session"
    );
  }

  // id_token is a JWT — middle segment is base64url-encoded JSON.
  // We just need `sub` (Google user id) and `email` for display;
  // no signature verification needed because the token came back
  // from Google's own /token endpoint over HTTPS.
  let googleUserId: string | null = null;
  let googleEmail: string | null = null;
  if (idToken) {
    try {
      const mid = idToken.split(".")[1];
      const payload = JSON.parse(
        Buffer.from(mid.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
      );
      googleUserId = payload.sub ?? null;
      googleEmail = payload.email ?? null;
    } catch {
      // non-fatal — we still have working tokens, just no display label
    }
  }

  const expiry = new Date(Date.now() + expiresIn * 1000).toISOString();

  const supabase = getSupabaseAdmin();
  const { error: upErr } = await supabase
    .from("users")
    .update({
      google_user_id: googleUserId,
      google_email: googleEmail,
      google_access_token: accessToken,
      google_refresh_token: refreshToken,
      google_token_expiry: expiry,
      google_connected_at: new Date().toISOString()
    })
    .eq("id", userId);
  if (upErr) {
    return errorRedirect(req, `couldn't save tokens: ${upErr.message}`);
  }

  const back = new URL("/settings?google=connected", baseUrl);
  return NextResponse.redirect(back.toString(), { status: 302 });
}

function errorRedirect(req: NextRequest, message: string) {
  const baseUrl = (
    process.env.NEXT_PUBLIC_APP_URL ||
    new URL(req.url).origin
  ).replace(/\/$/, "");
  const url = new URL("/settings", baseUrl);
  url.searchParams.set("google_error", message);
  return NextResponse.redirect(url.toString(), { status: 302 });
}
