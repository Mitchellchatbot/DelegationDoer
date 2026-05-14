import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { findSlackUser, openDmAsUser, postMessageAsUser } from "@/lib/slack";

export const dynamic = "force-dynamic";

// POST /api/kudos — send a kudos.
// Body: { toUserId: string, message: string, emoji?: string }
//
// The recipient sees the kudos on their desktop widget on the next
// poll AND gets a Slack DM that comes *from the sender's Slack
// account* (using the sender's stored user token from the Slack
// integration). So if Mitch kudoses Henry, Henry sees a real DM
// from Mitch in his Slack inbox, not a bot message.
//
// Falls back gracefully:
//   - sender hasn't connected Slack    → skip the DM (UI nudges them)
//   - recipient not found on Slack     → skip the DM
//   - any Slack API error              → log + skip, kudos still saves
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
    const { data: kudosRow, error } = await supabase
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

    // Slack DM as the sender.
    let slackDm: "sent" | "skipped" | "failed" = "skipped";
    let slackNote: string | null = null;
    try {
      const [{ data: sender }, { data: recipient }] = await Promise.all([
        supabase
          .from("users")
          .select("name, slack_user_token, slack_user_id")
          .eq("id", userId)
          .maybeSingle(),
        supabase
          .from("users")
          .select("name, email")
          .eq("id", toUserId)
          .maybeSingle()
      ]);

      if (!sender?.slack_user_token) {
        slackDm = "skipped";
        slackNote = "Connect your Slack in Settings to also DM the recipient.";
      } else if (!recipient) {
        slackDm = "skipped";
        slackNote = "recipient not found";
      } else {
        // Resolve recipient's Slack id via bot-token roster lookup
        // (uses email fast-path, then fuzzy name match).
        const recipientSlackId = await findSlackUser({
          email: recipient.email as string | null,
          name: recipient.name as string | null
        });
        if (!recipientSlackId) {
          slackDm = "skipped";
          slackNote = `couldn't find ${recipient.name ?? "recipient"} on Slack`;
        } else {
          const channel = await openDmAsUser(
            sender.slack_user_token as string,
            recipientSlackId
          );
          await postMessageAsUser({
            userToken: sender.slack_user_token as string,
            channel,
            text: `${emoji} ${message}`,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `${emoji}  *Kudos from ${sender.name ?? "me"}:*\n>${message.replace(/\n/g, "\n>")}`
                }
              },
              {
                type: "context",
                elements: [
                  { type: "mrkdwn", text: "_sent via DelegationDoer_" }
                ]
              }
            ]
          });
          slackDm = "sent";
        }
      }
    } catch (err) {
      slackDm = "failed";
      const raw = err instanceof Error ? err.message : String(err);
      // Translate the most common Slack errors into something
      // actionable so the toast tells the sender what to do.
      if (/missing_scope|not_allowed_token_type|invalid_auth/.test(raw)) {
        slackNote = "Your Slack token can't DM yet — disconnect + reconnect Slack in Settings to grant chat:write.";
      } else if (/users_not_found|user_not_found/.test(raw)) {
        slackNote = "Recipient not found on Slack.";
      } else {
        slackNote = raw;
      }
      console.warn("[kudos] slack DM failed:", raw);
    }

    return NextResponse.json({ kudos: kudosRow, slackDm, slackNote });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
