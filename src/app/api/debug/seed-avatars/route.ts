import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// One-shot dev seeder. Walks every user and assigns a stable pravatar.cc
// photo seeded by their user id, so the same person keeps the same face
// across re-runs. Skips anyone whose avatar_url is already set unless
// `?force=1` is passed (use that to overwrite e.g. logo placeholders).
export async function GET(req: Request) {
  const supabase = getSupabaseAdmin();
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";

  const { data: users, error } = await supabase
    .from("users")
    .select("id, name, avatar_url");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const updates: Array<{ id: string; name: string; old: string | null; next: string }> = [];

  for (const u of users ?? []) {
    // Pravatar gives a stable photo for a given seed string. Using the
    // user id keeps each person's face the same across re-seeds.
    const next = `https://i.pravatar.cc/400?u=${encodeURIComponent(u.id)}`;
    if (!force && u.avatar_url) continue;
    const { error: upErr } = await supabase
      .from("users")
      .update({ avatar_url: next })
      .eq("id", u.id);
    if (upErr) continue;
    updates.push({ id: u.id, name: u.name, old: u.avatar_url, next });
  }

  return NextResponse.json({
    ok: true,
    total: (users ?? []).length,
    updated: updates.length,
    updates
  });
}
