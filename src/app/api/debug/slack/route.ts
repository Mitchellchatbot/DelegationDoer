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

  // Step 4: send simple text message (this works — sanity check)
  const post = await call(
    "chat.postMessage",
    {
      channel: open.channel.id,
      text: `🔧 Diagnostic ping from /api/debug/slack — env: ${process.env.NEXT_PUBLIC_APP_URL ?? "no NEXT_PUBLIC_APP_URL"}`
    },
    token
  );
  out.post = post;

  // Step 5: directly post the same Block Kit payload notifyAssignment would
  // build. Surfaces any block validation errors raw, since the helper
  // currently swallows them.
  const taskUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/tasks/t_debug_dummy`;
  const fields = [
    { type: "mrkdwn", text: `*Priority*\nmedium` },
    { type: "mrkdwn", text: `*Estimate*\n2h` },
    { type: "mrkdwn", text: `*Due*\nno deadline` }
  ];
  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "👋 New task assigned", emoji: true }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<@${lookup.user.id}> — *Debug Tester* assigned you a task.`
      }
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*<${taskUrl}|Debug: Block Kit payload test>*` }
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: "If this lands, your Block Kit payload is valid." }
    },
    { type: "section", fields },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open in DelegationDoer", emoji: true },
          url: taskUrl,
          style: "primary"
        }
      ]
    }
  ];

  const blockPost = await call(
    "chat.postMessage",
    {
      channel: open.channel.id,
      text: "Block Kit debug",
      blocks,
      unfurl_links: false,
      unfurl_media: false
    },
    token
  );
  out.blockKitPost = blockPost;

  return NextResponse.json(out);
}
