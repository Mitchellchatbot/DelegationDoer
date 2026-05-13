import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { setSlackUserStatus, getSlackUserProfile } from "@/lib/slack";

export const dynamic = "force-dynamic";

// POST /api/integrations/slack/clear — wipes the Slack status
// regardless of what the widget says. Useful when the mirror gets
// stuck and you just want a known-empty starting point.
export async function POST() {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const { data: user } = await supabase
      .from("users")
      .select("slack_user_token")
      .eq("id", userId)
      .maybeSingle();
    if (!user?.slack_user_token) {
      return NextResponse.json(
        { error: "Slack not connected" },
        { status: 400 }
      );
    }

    await setSlackUserStatus({
      userToken: user.slack_user_token,
      statusText: "",
      statusEmoji: "",
      expirationEpoch: 0
    });

    let slackNow: {
      status_text: string;
      status_emoji: string;
      status_expiration: number;
    } | null = null;
    try {
      slackNow = await getSlackUserProfile(user.slack_user_token);
    } catch { /* readback optional */ }

    return NextResponse.json({ ok: true, slackNow });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
