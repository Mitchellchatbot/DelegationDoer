import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// GET /api/widget/birthdays — returns:
//   - hasBirthday: whether the caller has filled in their birthday (so
//     the widget can prompt them once if not)
//   - celebrantsToday: every user whose month+day matches today,
//     including the caller if it's their day
//
// Year-agnostic match: we compare month + day, not the full DATE.
export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    // Pull every user with a birthday set in one shot. The team's small
    // enough that filtering month+day in app code is cheaper than
    // adding a generated-column index.
    const { data: rows, error } = await supabase
      .from("users")
      .select("id, name, avatar_url, birthday");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const today = new Date();
    const month = today.getUTCMonth() + 1;
    const day = today.getUTCDate();

    let hasBirthday = false;
    const celebrantsToday: { id: string; name: string; avatarUrl: string | null; isMe: boolean }[] = [];
    for (const r of rows ?? []) {
      if (r.id === userId && r.birthday) hasBirthday = true;
      if (!r.birthday) continue;
      const d = new Date(`${r.birthday}T12:00:00Z`);
      if (Number.isNaN(d.getTime())) continue;
      if (d.getUTCMonth() + 1 === month && d.getUTCDate() === day) {
        celebrantsToday.push({
          id: r.id as string,
          name: r.name as string,
          avatarUrl: (r.avatar_url as string | null) ?? null,
          isMe: r.id === userId
        });
      }
    }

    return NextResponse.json({ hasBirthday, celebrantsToday });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
