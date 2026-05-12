import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isLeader } from "@/lib/access";
import { lookupUserByEmail, openDm, postMessage } from "@/lib/slack";

export const dynamic = "force-dynamic";

// POST /api/users/[id]/magic-link — leader-only. Generates a fresh
// magic-link sign-in URL for an existing user (by id), best-effort
// Slack-DMs it to them with a "Sign in" button, and returns the link
// in the response so the leader can also copy / share manually.
//
// Targets the production app for the redirect so links work the same
// regardless of where they were generated (override via
// NEXT_PUBLIC_APP_URL).
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const actorId = await requireCurrentUserId();
    const actor = await getUserById(actorId);
    if (!isLeader(actor)) {
      return NextResponse.json({ error: "Leader only" }, { status: 403 });
    }

    const target = await getUserById(params.id);
    if (!target) {
      return NextResponse.json({ error: "user not found" }, { status: 404 });
    }
    if (!target.email) {
      return NextResponse.json(
        { error: "user has no email on file" },
        { status: 400 }
      );
    }

    const baseUrl = (
      process.env.NEXT_PUBLIC_APP_URL ||
      "https://delegationdoer-production.up.railway.app"
    ).replace(/\/$/, "");

    const supabase = getSupabaseAdmin();
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: "magiclink",
      email: target.email,
      options: { redirectTo: `${baseUrl}/api/auth/callback` }
    });
    if (linkErr) {
      return NextResponse.json(
        { error: `generateLink: ${linkErr.message}` },
        { status: 500 }
      );
    }
    const magicLink = linkData?.properties?.action_link ?? null;
    if (!magicLink) {
      return NextResponse.json(
        { error: "Supabase returned no link" },
        { status: 500 }
      );
    }

    // Best-effort Slack DM. Failures are reported but don't fail the
    // request — the leader always gets the link in the JSON response.
    let slackDm: "sent" | "skipped" | "failed" = "skipped";
    let slackError: string | null = null;
    if (process.env.SLACK_BOT_TOKEN) {
      try {
        const slackId = await lookupUserByEmail(target.email);
        const channel = await openDm(slackId);
        await postMessage(
          channel,
          `${target.name}, here's a fresh sign-in link for DelegationDoer: ${magicLink}`,
          [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text:
                  `👋 *${target.name}* — ${actor?.name ?? "the leader"} just sent ` +
                  `you a fresh sign-in link for *DelegationDoer*. ` +
                  `One-time use; expires in about an hour.`
              }
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Sign in" },
                  url: magicLink,
                  style: "primary"
                }
              ]
            }
          ]
        );
        slackDm = "sent";
      } catch (err) {
        slackDm = "failed";
        slackError = err instanceof Error ? err.message : String(err);
      }
    }

    return NextResponse.json({
      ok: true,
      userId: target.id,
      email: target.email,
      magicLink,
      slackDm,
      slackError
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
