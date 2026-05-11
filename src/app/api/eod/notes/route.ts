import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// PUT /api/eod/notes — upsert the caller's note for a given date.
// Body: { date: "YYYY-MM-DD" (optional, defaults to today), note: string }.
// Only the caller can write their own note — no userId in the body.
export async function PUT(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json();
    const note = typeof body.note === "string" ? body.note : "";
    const dateStr =
      typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? body.date
        : new Date().toISOString().slice(0, 10);

    const supabase = getSupabaseAdmin();
    const id = `eod_${userId}_${dateStr}`;
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("eod_notes")
      .upsert(
        {
          id,
          user_id: userId,
          note_date: dateStr,
          note,
          updated_at: now
        },
        { onConflict: "user_id,note_date" }
      );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, date: dateStr });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
