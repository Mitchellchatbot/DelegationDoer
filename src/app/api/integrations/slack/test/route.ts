import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getSlackUserProfile, PRESENCE_TO_SLACK } from "@/lib/slack";
import { syncUserStatusToSlack } from "@/lib/slack-status-sync";

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

    // Go through the same path the widget uses so the debug row on
    // the user gets the same write — confirms the entire pipeline
    // works, not just a one-off call.
    await syncUserStatusToSlack(userId);

    // Re-read the user to surface the sync result the same way the
    // Settings card displays it. If the call errored, the toast can
    // show the real Slack response (missing_scope, invalid_auth, etc.)
    // instead of a generic 200.
    const { data: after } = await supabase
      .from("users")
      .select("slack_last_sync_ok, slack_last_sync_msg")
      .eq("id", userId)
      .maybeSingle();
    const syncOk = (after?.slack_last_sync_ok as boolean | null) ?? null;
    const syncMsg = (after?.slack_last_sync_msg as string | null) ?? null;

    // Read it back from Slack so we can show what Slack actually has
    // now — catches the case where the set returned ok=true but
    // Slack silently rejected the change (token scope etc.).
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
      syncOk,
      syncMsg,
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
