import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { cookies } from "next/headers";
import { publicOrigin } from "@/lib/public-origin";

export const dynamic = "force-dynamic";

// GET /api/integrations/slack/callback — Slack redirects here after
// the user authorizes our app. We verify state, exchange the code for
// a user (xoxp-) token, and persist it on the user's row so subsequent
// presence/emoji changes can call users.profile.set on their behalf.
export async function GET(req: NextRequest) {
  const userId = await requireCurrentUserId();
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const cookieStore = cookies();
  const expectedState = cookieStore.get("slack_oauth_state")?.value;
  cookieStore.set("slack_oauth_state", "", { path: "/", maxAge: 0 });

  if (error) {
    return errorRedirect(req, `Slack returned: ${error}`);
  }
  if (!code) return errorRedirect(req, "missing code");
  if (!state || state !== expectedState) {
    return errorRedirect(req, "state mismatch — try again");
  }

  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return errorRedirect(req, "Slack client id/secret missing on server");
  }

  const baseUrl = publicOrigin();
  const redirectUri = `${baseUrl}/api/integrations/slack/callback`;

  const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri
    })
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.ok) {
    return errorRedirect(req, `oauth exchange failed: ${tokenData.error ?? "unknown"}`);
  }

  // oauth.v2.access returns `authed_user: { id, scope, access_token }`
  // when only user scopes were requested.
  const slackUserId = tokenData.authed_user?.id as string | undefined;
  const slackUserToken = tokenData.authed_user?.access_token as string | undefined;
  const slackTeamId = tokenData.team?.id as string | undefined;
  if (!slackUserId || !slackUserToken) {
    return errorRedirect(req, "Slack didn't return a user token");
  }

  const supabase = getSupabaseAdmin();
  const { error: upErr } = await supabase
    .from("users")
    .update({
      slack_user_id: slackUserId,
      slack_user_token: slackUserToken,
      slack_team_id: slackTeamId ?? null,
      slack_connected_at: new Date().toISOString()
    })
    .eq("id", userId);
  if (upErr) {
    return errorRedirect(req, `couldn't save token: ${upErr.message}`);
  }

  const back = new URL("/settings?slack=connected", baseUrl);
  return NextResponse.redirect(back.toString(), { status: 302 });
}

function errorRedirect(_req: NextRequest, message: string) {
  // publicOrigin(), not NEXT_PUBLIC_APP_URL: an error on operations.scaledai.org
  // used to bounce the user to /settings on the Railway host, where they have a
  // different session — so the failure looked like a logout.
  const url = new URL("/settings", publicOrigin());
  url.searchParams.set("slack_error", message);
  return NextResponse.redirect(url.toString(), { status: 302 });
}
