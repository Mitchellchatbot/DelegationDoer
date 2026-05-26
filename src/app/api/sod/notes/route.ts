import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { sodSignalFor } from "@/lib/shift";

export const dynamic = "force-dynamic";

interface Body {
  date?: string;
  topPriority?: string | null;
  tasksPlanned?: string | null;
  blockers?: string | null;
}

// PUT /api/sod/notes
//   body: { date?, topPriority?, tasksPlanned?, blockers? }
//
// Autosave from the SOD typeform — each field advance fires this so
// the user's partial answers persist across reloads. Mirrors
// /api/eod/notes exactly. Only the fields actually present in the body
// are overwritten; others are left alone.
export async function PUT(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "no user" }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as Body;
    const signal = sodSignalFor(me);
    const shiftDate =
      typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? body.date
        : "shiftDate" in signal
        ? signal.shiftDate
        : new Date().toISOString().slice(0, 10);

    const TEXT = (v: unknown): string | null => {
      if (typeof v !== "string") return null;
      const t = v.replace(/\r\n/g, "\n");
      return t.length > 0 ? t : null;
    };

    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();
    const id = `sod_${userId}_${shiftDate}`;

    const upsertRow: Record<string, unknown> = {
      id,
      user_id: userId,
      note_date: shiftDate,
      updated_at: now
    };
    if ("topPriority" in body) upsertRow.top_priority = TEXT(body.topPriority);
    if ("tasksPlanned" in body) upsertRow.tasks_planned = TEXT(body.tasksPlanned);
    if ("blockers" in body) upsertRow.blockers = TEXT(body.blockers);

    const { error } = await supabase
      .from("sod_notes")
      .upsert(upsertRow, { onConflict: "user_id,note_date" });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, date: shiftDate });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}
