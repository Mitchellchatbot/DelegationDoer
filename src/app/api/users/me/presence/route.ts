import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { syncUserStatusToSlack } from "@/lib/slack-status-sync";

export const dynamic = "force-dynamic";

const STATES = ["focus", "eating", "away", "available"] as const;
type State = (typeof STATES)[number];

// PATCH /api/users/me/presence — set the current user's presence state.
// Body: { state: 'focus' | 'eating' | 'away' | 'available' | null }.
// Driven by the desktop widget; surfaced as a colored dot on avatars
// throughout the app.
export async function PATCH(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json();
    const raw = body.state;
    const state: State | null =
      raw === null ? null : STATES.includes(raw) ? (raw as State) : null;
    if (raw !== null && !state) {
      return NextResponse.json({ error: "invalid state" }, { status: 400 });
    }
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("users")
      .update({
        presence: state,
        presence_updated_at: new Date().toISOString()
      })
      .eq("id", userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    // Mirror to Slack best-effort. Fire-and-forget — never blocks the
    // PATCH response and never fails it.
    void syncUserStatusToSlack(userId);
    return NextResponse.json({ ok: true, state });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// GET — convenience read for the widget so it can hydrate the current dot
// on launch without a full /api/users/me round-trip.
export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from("users")
      .select("presence, presence_updated_at")
      .eq("id", userId)
      .maybeSingle();
    return NextResponse.json({
      state: data?.presence ?? null,
      updatedAt: data?.presence_updated_at ?? null
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
