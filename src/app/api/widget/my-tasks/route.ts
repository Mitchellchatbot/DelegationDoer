import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById, getLeaderIds } from "@/lib/server-data";

// Returns the current user's open tasks and which ones still need to be
// acknowledged (no row in assignment_acknowledgements yet).

// Opt out of Next.js route-handler caching — this endpoint is read every
// 15s from the widget and must reflect Supabase's current state, not a
// stale snapshot.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const SELECT_COLS = "id, title, priority, status, due_date, estimated_hours, actual_hours, actual_hours_override, inactive_flag, created_at, description, tags, client_name, website, creator_id, assignee_id";

export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    // Three parallel queries:
    //   - My open tasks (assigned to me).
    //   - Every open incident-tagged task (broadcast to everyone — when
    //     something is on fire, the whole org should see it on their widget,
    //     not just the routed owner).
    //   - My ack rows.
    const [
      { data: mine, error: me },
      { data: incidents, error: ie },
      { data: acks,  error: ae }
    ] = await Promise.all([
      supabase.from("tasks").select(SELECT_COLS)
        .eq("assignee_id", userId).neq("status", "done")
        .order("created_at", { ascending: false }),
      supabase.from("tasks").select(SELECT_COLS)
        .contains("tags", ["incident"]).neq("status", "done")
        .order("created_at", { ascending: false }),
      supabase.from("assignment_acknowledgements").select("task_id")
        .eq("user_id", userId)
    ]);

    if (me) return NextResponse.json({ error: me.message }, { status: 500 });
    if (ie) return NextResponse.json({ error: ie.message }, { status: 500 });
    if (ae) return NextResponse.json({ error: ae.message }, { status: 500 });

    // Merge + dedupe by id (an incident task assigned to me would otherwise
    // appear twice).
    const seen = new Set<string>();
    let merged = [...(mine ?? []), ...(incidents ?? [])].filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    // Leader-privacy filter — non-leaders never see incident tasks
    // (or anything else) touched by a leader, unless they themselves
    // are the assignee. Leaders always see their full slice.
    const viewer = await getUserById(userId);
    if (viewer?.role !== "leader") {
      const leaderIds = await getLeaderIds();
      merged = merged.filter((t) => {
        if (t.assignee_id === userId) return true;
        if (t.creator_id === userId) return true;
        if (t.assignee_id && leaderIds.has(t.assignee_id)) return false;
        if (t.creator_id && leaderIds.has(t.creator_id)) return false;
        return true;
      });
    }

    const acked = new Set((acks ?? []).map((a) => a.task_id));
    const out = merged.map((t) => {
      // Same override-wins rule as src/lib/server-data.ts.
      const actualHours =
        t.actual_hours_override !== null && t.actual_hours_override !== undefined
          ? Number(t.actual_hours_override)
          : Number(t.actual_hours ?? 0);
      return {
        id: t.id,
        title: t.title,
        description: t.description,
        priority: t.priority,
        status: t.status,
        dueDate: t.due_date,
        estimatedHours: Number(t.estimated_hours),
        actualHours,
        actualHoursOverride:
          t.actual_hours_override !== null && t.actual_hours_override !== undefined
            ? Number(t.actual_hours_override)
            : null,
        inactiveFlag: t.inactive_flag,
        clientName: t.client_name,
        website: t.website,
        isIncident: Array.isArray(t.tags) && t.tags.includes("incident"),
        needsAck: !acked.has(t.id)
      };
    });

    return NextResponse.json({ tasks: out });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
