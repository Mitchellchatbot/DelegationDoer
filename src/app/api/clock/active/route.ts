import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

// GET /api/clock/active — every user with an open shift, plus how long
// they've been on. Powers the "Who's on shift" surfaces (Leader console,
// dashboard tile, etc.).
export async function GET() {
  await requireCurrentUserId();
  const supabase = getSupabaseAdmin();

  const { data: open, error } = await supabase
    .from("time_entries")
    .select("id, user_id, started_at")
    .is("ended_at", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const userIds = Array.from(new Set((open ?? []).map((r) => r.user_id)));
  let users: Record<string, { name: string; avatarUrl: string | null; role: string }> = {};
  if (userIds.length > 0) {
    const { data: us } = await supabase
      .from("users")
      .select("id, name, avatar_url, role")
      .in("id", userIds);
    users = Object.fromEntries(
      (us ?? []).map((u) => [u.id, { name: u.name, avatarUrl: u.avatar_url ?? null, role: u.role }])
    );
  }

  const now = Date.now();
  const onShift = (open ?? []).map((r) => {
    const startedAt = r.started_at as string;
    const u = users[r.user_id] ?? null;
    return {
      userId: r.user_id,
      name: u?.name ?? "Unknown",
      avatarUrl: u?.avatarUrl ?? null,
      role: u?.role ?? null,
      startedAt,
      elapsedMs: now - new Date(startedAt).getTime()
    };
  }).sort((a, b) => b.elapsedMs - a.elapsedMs);

  return NextResponse.json({ onShift });
}
