import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Diagnostic endpoint to figure out where Slack DMs are failing on a deploy.
// Takes ?email=...  Walks through every step (token check, auth.test,
// lookupByEmail, conversations.open, chat.postMessage) and reports.
// Delete this route once Slack notifications are working.

const SLACK_API = "https://slack.com/api";

async function call(method: string, body: Record<string, unknown> | null, token: string) {
  const init: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8"
    }
  };
  if (body) init.body = JSON.stringify(body);
  const res = await fetch(`${SLACK_API}/${method}`, init);
  return await res.json();
}

export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email") ?? "";
  const token = process.env.SLACK_BOT_TOKEN;

  const out: any = {
    env: {
      hasBotToken: !!token,
      botTokenLength: token?.length ?? 0,
      botTokenPrefix: token?.slice(0, 5) ?? null,
      hasUserToken: !!process.env.SLACK_USER_TOKEN,
      hasSigningSecret: !!process.env.SLACK_SIGNING_SECRET,
      appUrl: process.env.NEXT_PUBLIC_APP_URL ?? null
    }
  };

  if (!token) {
    out.error = "SLACK_BOT_TOKEN missing on this deploy";
    return NextResponse.json(out, { status: 500 });
  }

  // Step 1: who is the bot?
  out.authTest = await call("auth.test", null, token);

  if (!email) {
    out.note = "Pass ?email=... to also test lookupByEmail / open / postMessage";
    return NextResponse.json(out);
  }

  // Step 2: find the user
  const lookup = await fetch(
    `${SLACK_API}/users.lookupByEmail?email=${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).then((r) => r.json());
  out.lookup = lookup;

  if (!lookup.ok) return NextResponse.json(out);

  // Step 3: open DM
  const open = await call("conversations.open", { users: lookup.user.id }, token);
  out.open = open;

  if (!open.ok) return NextResponse.json(out);

  // Step 4: send message
  const post = await call(
    "chat.postMessage",
    {
      channel: open.channel.id,
      text: `🔧 Diagnostic ping from /api/debug/slack — env: ${process.env.NEXT_PUBLIC_APP_URL ?? "no NEXT_PUBLIC_APP_URL"}`
    },
    token
  );
  out.post = post;

  return NextResponse.json(out);
}
