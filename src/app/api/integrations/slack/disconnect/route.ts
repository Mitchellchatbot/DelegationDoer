import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// POST /api/integrations/slack/disconnect — clears the user's stored
// Slack credentials so we stop mirroring their status. We don't
// revoke server-side on Slack — the user can do that in their Slack
// account settings if they want it fully gone.
export async function POST() {
  const userId = await requireCurrentUserId();
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("users")
    .update({
      slack_user_id: null,
      slack_user_token: null,
      slack_team_id: null,
      slack_connected_at: null
    })
    .eq("id", userId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
