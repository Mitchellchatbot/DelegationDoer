import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { CURRENT_USER_ID } from "@/lib/mock-data";

// Returns the current user's open tickets and which ones still need to be
// acknowledged (no row in assignment_acknowledgements yet).

// Opt out of Next.js route-handler caching — this endpoint is read every
// 15s from the widget and must reflect Supabase's current state, not a
// stale snapshot.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const SELECT_COLS = "id, title, priority, status, due_date, estimated_hours, inactive_flag, created_at, description, tags, client_name, website";

export async function GET() {
  try {
    const supabase = getSupabaseAdmin();

    // Three parallel queries:
    //   - My open tickets (assigned to me).
    //   - Every open incident-tagged ticket (broadcast to everyone — when
    //     something is on fire, the whole org should see it on their widget,
    //     not just the routed owner).
    //   - My ack rows.
    const [
      { data: mine, error: me },
      { data: incidents, error: ie },
      { data: acks,  error: ae }
    ] = await Promise.all([
      supabase.from("tickets").select(SELECT_COLS)
        .eq("assignee_id", CURRENT_USER_ID).neq("status", "done")
        .order("created_at", { ascending: false }),
      supabase.from("tickets").select(SELECT_COLS)
        .contains("tags", ["incident"]).neq("status", "done")
        .order("created_at", { ascending: false }),
      supabase.from("assignment_acknowledgements").select("ticket_id")
        .eq("user_id", CURRENT_USER_ID)
    ]);

    if (me) return NextResponse.json({ error: me.message }, { status: 500 });
    if (ie) return NextResponse.json({ error: ie.message }, { status: 500 });
    if (ae) return NextResponse.json({ error: ae.message }, { status: 500 });

    // Merge + dedupe by id (an incident ticket assigned to me would otherwise
    // appear twice).
    const seen = new Set<string>();
    const merged = [...(mine ?? []), ...(incidents ?? [])].filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    const acked = new Set((acks ?? []).map((a) => a.ticket_id));
    const out = merged.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      priority: t.priority,
      status: t.status,
      dueDate: t.due_date,
      estimatedHours: Number(t.estimated_hours),
      inactiveFlag: t.inactive_flag,
      clientName: t.client_name,
      website: t.website,
      isIncident: Array.isArray(t.tags) && t.tags.includes("incident"),
      needsAck: !acked.has(t.id)
    }));

    return NextResponse.json({ tickets: out });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
