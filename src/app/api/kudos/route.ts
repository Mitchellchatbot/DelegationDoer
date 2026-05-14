import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { findSlackUser, openDm, postMessage } from "@/lib/slack";

export const dynamic = "force-dynamic";

// POST /api/kudos — send a kudos.
// Body: { toUserId: string, message: string, emoji?: string }
//
// Self-kudos are rejected (you can't 👏 yourself). The recipient sees
// it on their desktop widget on the next poll AND gets a Slack DM
// (best-effort) with the message + emoji. Slack lookup tries email
// first, then fuzzy-matches the user's name against the workspace
// roster so a missing email doesn't cost them the DM.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json();
    const toUserId = typeof body.toUserId === "string" ? body.toUserId : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const emoji = typeof body.emoji === "string" && body.emoji.length <= 8
      ? body.emoji
      : "👏";

    if (!toUserId) return NextResponse.json({ error: "toUserId required" }, { status: 400 });
    if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });
    if (message.length > 280) return NextResponse.json({ error: "message too long (max 280)" }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const id = `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const { data, error } = await supabase
      .from("kudos")
      .insert({
        id,
        from_user_id: userId,
        to_user_id: toUserId,
        message,
        emoji
      })
      .select("id, message, emoji, created_at, from_user_id, to_user_id")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Slack DM — best-effort. We resolve both sender + recipient so
    // the message reads "{sender} sent you a kudos" with proper names.
    let slackDm: "sent" | "skipped" | "failed" = "skipped";
    let slackError: string | null = null;
    if (process.env.SLACK_BOT_TOKEN) {
      try {
        const [{ data: toUser }, { data: fromUser }] = await Promise.all([
          supabase
            .from("users")
            .select("name, email")
            .eq("id", toUserId)
            .maybeSingle(),
          supabase
            .from("users")
            .select("name")
            .eq("id", userId)
            .maybeSingle()
        ]);
        if (toUser) {
          const slackId = await findSlackUser({
            email: toUser.email as string | null,
            name: toUser.name as string | null
          });
          if (slackId) {
            const channel = await openDm(slackId);
            const senderName = (fromUser?.name as string | null) ?? "Someone";
            await postMessage(
              channel,
              `${emoji} ${senderName} sent you a kudos: ${message}`,
              [
                {
                  type: "header",
                  text: {
                    type: "plain_text",
                    text: `${emoji}  You got a kudos`,
                    emoji: true
                  }
                },
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `*${senderName}* says:\n>${message.replace(/\n/g, "\n>")}`
                  }
                },
                {
                  type: "context",
                  elements: [
                    {
                      type: "mrkdwn",
                      text: "Sent via DelegationDoer"
                    }
                  ]
                }
              ]
            );
            slackDm = "sent";
          } else {
            slackDm = "skipped";
            slackError = "couldn't find recipient on Slack";
          }
        }
      } catch (err) {
        slackDm = "failed";
        slackError = err instanceof Error ? err.message : String(err);
        console.warn("[kudos] slack DM failed:", slackError);
      }
    }

    return NextResponse.json({ kudos: data, slackDm, slackError });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
