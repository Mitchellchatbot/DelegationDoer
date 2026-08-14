import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { eodToday } from "@/lib/shift";

export const dynamic = "force-dynamic";

// Per-client EOD work entries — what the worker did for a client today,
// captured client-by-client in the end-of-day typeform and used as the
// source for the client-update emails (see /api/client-update/draft).
//
// POST /api/eod/client-work
//   body: { date?: 'YYYY-MM-DD', clientId?: string|null, clientName: string,
//           workedOn: string, results?: string }
//   Creates one eod_client_work row for the caller. Returns the row.
//
// GET /api/eod/client-work?date=YYYY-MM-DD
//   Lists the caller's entries for that date (defaults to today) so the
//   form can resume / show what's already logged.
//
// DELETE /api/eod/client-work?id=...
//   Removes one of the caller's own entries (used when they back out of a
//   client in the flow).

interface WorkRow {
  id: string;
  user_id: string;
  note_date: string;
  client_id: string | null;
  client_name: string;
  worked_on: string;
  results: string | null;
  reported_to_client_at: string | null;
  created_at: string;
}

function shape(r: WorkRow) {
  return {
    id: r.id,
    noteDate: r.note_date,
    clientId: r.client_id,
    clientName: r.client_name,
    workedOn: r.worked_on,
    results: r.results,
    reportedAt: r.reported_to_client_at
  };
}

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const body = await req.json().catch(() => ({}));

    const dateStr =
      typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? body.date
        : eodToday();
    const clientId = typeof body.clientId === "string" && body.clientId ? body.clientId : null;
    const clientName = typeof body.clientName === "string" ? body.clientName.trim() : "";
    const workedOn = typeof body.workedOn === "string" ? body.workedOn.trim() : "";
    const results = typeof body.results === "string" ? body.results.trim() : "";

    if (!clientName) return NextResponse.json({ error: "clientName required" }, { status: 400 });
    if (!workedOn) return NextResponse.json({ error: "workedOn required" }, { status: 400 });
    if (workedOn.length > 4000) return NextResponse.json({ error: "workedOn too long (max 4000)" }, { status: 400 });

    const id = `ecw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("eod_client_work")
      .insert({
        id,
        user_id: userId,
        note_date: dateStr,
        client_id: clientId,
        client_name: clientName.slice(0, 200),
        worked_on: workedOn,
        results: results ? results.slice(0, 4000) : null,
        created_at: now,
        updated_at: now
      })
      .select("id, user_id, note_date, client_id, client_name, worked_on, results, reported_to_client_at, created_at")
      .maybeSingle();
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, entry: data ? shape(data as WorkRow) : null });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const dateParam = req.nextUrl.searchParams.get("date");
    const dateStr =
      dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
        ? dateParam
        : eodToday();

    const { data, error } = await supabase
      .from("eod_client_work")
      .select("id, user_id, note_date, client_id, client_name, worked_on, results, reported_to_client_at, created_at")
      .eq("user_id", userId)
      .eq("note_date", dateStr)
      .order("created_at", { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ entries: ((data ?? []) as WorkRow[]).map(shape) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const id = req.nextUrl.searchParams.get("id") ?? "";
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    // Scope the delete to the caller's own rows.
    const { error } = await supabase
      .from("eod_client_work")
      .delete()
      .eq("id", id)
      .eq("user_id", userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
