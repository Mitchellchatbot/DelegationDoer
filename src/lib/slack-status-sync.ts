import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { setSlackUserStatus, PRESENCE_TO_SLACK, toSlackEmojiShortcode } from "@/lib/slack";

// Mirror a user's DelegationDoer presence + emoji to their connected
// Slack account. Best-effort — failures are swallowed and logged so a
// dead Slack token never breaks the underlying presence write.
//
// Precedence: an explicit status emoji wins over the presence-derived
// emoji. So if the user picked 🚀 as their emoji and presence is
// "focus", Slack shows 🚀 / "In focus".
//
// Every attempt writes its result (ok/error message + timestamp) back
// to the user's row so the Settings page can show what's actually
// happening — invaluable when the fire-and-forget path is silently
// failing.
export async function syncUserStatusToSlack(userId: string): Promise<void> {
  type UserRow = {
    slack_user_token: string | null;
    presence: string | null;
    status_emoji: string | null;
  };
  const supabase = getSupabaseAdmin();
  let user: UserRow | null = null;
  try {
    const { data } = await supabase
      .from("users")
      .select("slack_user_token, presence, status_emoji")
      .eq("id", userId)
      .maybeSingle();
    user = (data as UserRow | null) ?? null;
  } catch (err) {
    console.warn("[slack-status-sync] read user failed:", err);
    return;
  }
  if (!user?.slack_user_token) {
    // Not connected — nothing to do, no debug write either.
    return;
  }

  const presence = (user.presence ?? "available") as keyof typeof PRESENCE_TO_SLACK;
  const fromPresence = PRESENCE_TO_SLACK[presence] ?? PRESENCE_TO_SLACK.available;
  const overrideEmoji = (user.status_emoji ?? "").trim();
  // Precedence:
  //   - If you're on a defined preset (focus/eating/away), the
  //     preset's emoji + text win. That way changing your presence
  //     in the widget actually changes the Slack emoji instead of
  //     getting overridden by a sticky custom emoji from earlier.
  //   - If you're "available" (no preset), your custom emoji shows
  //     with no status text.
  // Slack expects :colon: shortcodes — the widget stores raw glyphs,
  // so translate at the boundary.
  let statusText: string;
  let statusEmoji: string;
  if (presence === "available") {
    statusText = "";
    statusEmoji = overrideEmoji ? toSlackEmojiShortcode(overrideEmoji) : "";
  } else {
    statusText = fromPresence.text;
    statusEmoji = fromPresence.emoji;
  }

  let okFlag = false;
  let msg = `pushed ${presence}: ${statusEmoji || "(no emoji)"} ${statusText || "(no text)"}`;
  try {
    await setSlackUserStatus({
      userToken: user.slack_user_token,
      statusText,
      statusEmoji
    });
    okFlag = true;
  } catch (err) {
    okFlag = false;
    msg = err instanceof Error ? err.message : String(err);
    console.warn("[slack-status-sync]", msg);
  }

  // Best-effort debug-write — never throw out of here.
  try {
    await supabase
      .from("users")
      .update({
        slack_last_sync_at: new Date().toISOString(),
        slack_last_sync_ok: okFlag,
        slack_last_sync_msg: msg.slice(0, 500)
      })
      .eq("id", userId);
  } catch (err) {
    console.warn("[slack-status-sync] write debug row failed:", err);
  }
}
