import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// POST /api/integrations/google/disconnect — clears the user's
// Google credentials. We don't revoke server-side on Google's end
// (user can do that in their Google Account → Connections if they
// want it fully gone).
export async function POST() {
  const userId = await requireCurrentUserId();
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("users")
    .update({
      google_user_id: null,
      google_email: null,
      google_access_token: null,
      google_refresh_token: null,
      google_token_expiry: null,
      google_connected_at: null
    })
    .eq("id", userId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
