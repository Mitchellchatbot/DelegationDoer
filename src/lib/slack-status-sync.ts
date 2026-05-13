import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { setSlackUserStatus, PRESENCE_TO_SLACK } from "@/lib/slack";

// Mirror a user's DelegationDoer presence + emoji to their connected
// Slack account. Best-effort — failures are swallowed and logged so a
// dead Slack token never breaks the underlying presence write.
//
// Precedence: an explicit status emoji wins over the presence-derived
// emoji. So if the user picked 🚀 as their emoji and presence is
// "focus", Slack shows 🚀 / "In focus".
export async function syncUserStatusToSlack(userId: string): Promise<void> {
  try {
    const supabase = getSupabaseAdmin();
    const { data: user } = await supabase
      .from("users")
      .select("slack_user_token, presence, status_emoji")
      .eq("id", userId)
      .maybeSingle();
    if (!user?.slack_user_token) return;

    const presence = (user.presence ?? "available") as keyof typeof PRESENCE_TO_SLACK;
    const fromPresence = PRESENCE_TO_SLACK[presence] ?? PRESENCE_TO_SLACK.available;
    const overrideEmoji = (user.status_emoji ?? "").trim();

    const statusText = fromPresence.text;
    // Custom emoji wins if set. We pass raw glyph (e.g. "🚀") — Slack
    // accepts both shortcodes (":rocket:") and raw glyphs.
    const statusEmoji = overrideEmoji || fromPresence.emoji;

    await setSlackUserStatus({
      userToken: user.slack_user_token,
      statusText,
      statusEmoji
    });
  } catch (err) {
    // Don't surface — this is mirror-only. Log so we can debug from
    // server output if a user reports their Slack isn't syncing.
    console.warn("[slack-status-sync]", err instanceof Error ? err.message : err);
  }
}
