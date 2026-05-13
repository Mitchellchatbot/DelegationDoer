import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { setSlackUserStatus, getSlackUserProfile, PRESENCE_TO_SLACK } from "@/lib/slack";

export const dynamic = "force-dynamic";

// POST /api/integrations/slack/test — fire one users.profile.set
// using the user's stored token, computing the status from their
// current presence + emoji. Unlike the fire-and-forget mirror, this
// returns the success/failure to the UI so we can surface a real
// error toast instead of swallowing it.
export async function POST() {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const { data: user } = await supabase
      .from("users")
      .select("slack_user_token, presence, status_emoji")
      .eq("id", userId)
      .maybeSingle();
    if (!user?.slack_user_token) {
      return NextResponse.json(
        { error: "Slack not connected. Click Connect Slack first." },
        { status: 400 }
      );
    }

    const presence = (user.presence ?? "available") as keyof typeof PRESENCE_TO_SLACK;
    const fromPresence = PRESENCE_TO_SLACK[presence] ?? PRESENCE_TO_SLACK.available;
    const overrideEmoji = (user.status_emoji ?? "").trim();
    const statusText = fromPresence.text;
    const statusEmoji = overrideEmoji || fromPresence.emoji;

    await setSlackUserStatus({
      userToken: user.slack_user_token,
      statusText,
      statusEmoji
    });

    // Read it back so we can show what Slack actually has now —
    // catches the case where the set call returns ok=true but Slack
    // silently rejects the change (token scope issue etc.).
    let slackNow: {
      status_text: string;
      status_emoji: string;
      status_expiration: number;
    } | null = null;
    try {
      slackNow = await getSlackUserProfile(user.slack_user_token);
    } catch (err) {
      console.warn("[slack-test] readback failed:", err);
    }

    return NextResponse.json({
      ok: true,
      pushed: { statusText, statusEmoji, presence },
      slackNow
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
