import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { cookies } from "next/headers";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

// GET /api/integrations/slack/start — kicks off Slack OAuth so the
// signed-in user can grant their own users.profile:write scope. We
// stash a CSRF/state token in an httpOnly cookie and bounce them to
// Slack's authorize endpoint. Slack will redirect back to /callback.
export async function GET(_req: NextRequest) {
  await requireCurrentUserId();

  const clientId = process.env.SLACK_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "SLACK_CLIENT_ID not set" },
      { status: 500 }
    );
  }
  const baseUrl = (
    process.env.NEXT_PUBLIC_APP_URL ||
    "https://delegationdoer-production.up.railway.app"
  ).replace(/\/$/, "");
  const redirectUri = `${baseUrl}/api/integrations/slack/callback`;

  const state = randomBytes(24).toString("hex");
  cookies().set("slack_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60
  });

  // user_scope (not scope) gives us a xoxp- user token. We don't ask
  // for any bot scopes here — the bot is already installed for DMs.
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("user_scope", "users.profile:write,users.profile:read");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);

  return NextResponse.redirect(url.toString(), { status: 302 });
}
