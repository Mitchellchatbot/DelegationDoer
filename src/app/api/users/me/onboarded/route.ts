import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// PUT /api/users/me/onboarded — mark the current user as having
// completed (or dismissed) the welcome flow. Idempotent: hitting it
// again after the timestamp is set is a no-op.
export async function PUT() {
  try {
    const userId = await requireCurrentUserId();
    const { error } = await getSupabaseAdmin()
      .from("users")
      .update({ onboarded_at: new Date().toISOString() })
      .eq("id", userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
