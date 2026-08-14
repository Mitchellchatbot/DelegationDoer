import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { eodToday } from "@/lib/shift";

export const dynamic = "force-dynamic";

// PUT /api/eod/notes — upsert the caller's EOD entry for a given date.
// Body shape (all optional; whatever's present gets written):
//   {
//     date:              "YYYY-MM-DD",      // defaults to today
//     note:              string,             // legacy free-form catch-all
//     workedOn:          string,
//     accomplished:      string,
//     planTomorrow:      string,
//     blockers:          string,
//     leadsMessaged:     string,             // marketing-style flow only
//     linkedinComments:  string              // marketing-style flow only
//   }
// Only the caller can write their own row — no userId in the body.

const STRING_OR_EMPTY = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

export async function PUT(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json();
    // Same clamp as POST /api/eod/submit — the client's date is a hint,
    // the ET day is the authority. Autosave is the higher-volume writer
    // of the two, so a stale tab would otherwise seed a future row here
    // before the user ever hits Submit.
    const today = eodToday();
    const requested =
      typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? body.date
        : today;
    const dateStr = requested > today ? today : requested;

    const supabase = getSupabaseAdmin();
    const id = `eod_${userId}_${dateStr}`;
    const now = new Date().toISOString();

    // Build a partial row from whichever fields were supplied. Anything
    // not present in the body is left untouched on the existing row
    // (upsert with onConflict merges on the PK; columns not in the
    // payload stay as-is on update).
    const row: Record<string, unknown> = {
      id,
      user_id: userId,
      note_date: dateStr,
      updated_at: now
    };
    if (typeof body.note === "string") row.note = body.note;
    if ("workedOn" in body) row.worked_on = STRING_OR_EMPTY(body.workedOn);
    if ("accomplished" in body) row.accomplished = STRING_OR_EMPTY(body.accomplished);
    if ("planTomorrow" in body) row.plan_tomorrow = STRING_OR_EMPTY(body.planTomorrow);
    if ("blockers" in body) row.blockers = STRING_OR_EMPTY(body.blockers);
    if ("leadsMessaged" in body) row.leads_messaged = STRING_OR_EMPTY(body.leadsMessaged);
    if ("linkedinComments" in body) row.linkedin_comments = STRING_OR_EMPTY(body.linkedinComments);

    const { error } = await supabase
      .from("eod_notes")
      .upsert(row, { onConflict: "user_id,note_date" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, date: dateStr });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
