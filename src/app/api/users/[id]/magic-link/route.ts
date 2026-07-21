import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isLeader } from "@/lib/access";
import { lookupUserByEmail, openDm, postMessage } from "@/lib/slack";

export const dynamic = "force-dynamic";

// POST /api/users/[id]/magic-link — leader-only. Creates a single-use
// "magic_link_claim" row tied to the target user's email and returns a
// /signin/<claim_id> URL. Slack-DMs that URL with a "Sign in" button.
//
// We intentionally do NOT generate the Supabase verify URL here —
// that happens server-side only when the user clicks the button on
// /signin/<claim_id>. Otherwise Slack's safe-link scanner or Outlook
// safe-links would pre-fetch the verify URL and burn the token before
// the recipient ever clicks.
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

    const { data: claim, error: claimErr } = await supabase
      .from("magic_link_claims")
      .insert({
        email: target.email,
        target_user_id: target.id,
        created_by: actorId
      })
      .select("id")
      .single();
    if (claimErr || !claim) {
      return NextResponse.json(
        { error: `claim insert: ${claimErr?.message ?? "unknown"}` },
        { status: 500 }
      );
    }

    const magicLink = `${baseUrl}/signin/${claim.id}`;

    let slackDm: "sent" | "skipped" | "failed" = "skipped";
    let slackError: string | null = null;
    if (process.env.SLACK_BOT_TOKEN) {
      try {
        const slackId = await lookupUserByEmail(target.email);
        const channel = await openDm(slackId);
        await postMessage(
          channel,
          `${target.name}, you have a sign-in link for Scaled Operations.`,
          [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text:
                  `👋 *${target.name}* — ${actor?.name ?? "the leader"} just sent ` +
                  `you a sign-in link for *Scaled Operations*. ` +
                  `Click the button when you're ready — the link is single-use.`
              }
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Open sign-in page" },
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
