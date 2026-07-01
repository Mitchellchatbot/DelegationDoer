import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// GET /api/sod/my-tasks
// Returns the caller's open tasks (pending / urgent / in_progress /
// waiting_on_client). Used by the SOD form's "Pick existing" dropdown.
export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, status, priority, due_date")
      .eq("assignee_id", userId)
      // is_draft=true means the task is a routing draft awaiting dept-head
      // approval — exclude those so "Pick existing" only shows live tasks.
      .eq("is_draft", false)
      // Archived/soft-deleted tasks keep their open status, so without these
      // filters they leak into the list AND consume slots in the row cap
      // below, pushing live tasks out (mirrors getAllTasks in server-data.ts).
      .is("deleted_at", null)
      .is("archived_at", null)
      .in("status", ["pending", "in_progress", "urgent", "waiting_on_client"])
      .order("status", { ascending: true })
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(500);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({
      tasks: (data ?? []).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status
      }))
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}
