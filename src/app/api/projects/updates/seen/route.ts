import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isLeader } from "@/lib/access";

export const dynamic = "force-dynamic";

// PUT /api/projects/updates/seen — mark the current moment as the
// user's "I've reviewed project activity through this timestamp"
// marker. Drops the unseen-badge count to zero until something new
// happens.
export async function PUT() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!isLeader(me)) {
    return NextResponse.json({ error: "leader only" }, { status: 403 });
  }
  const { error } = await getSupabaseAdmin()
    .from("users")
    .update({ projects_updates_seen_at: new Date().toISOString() })
    .eq("id", userId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
