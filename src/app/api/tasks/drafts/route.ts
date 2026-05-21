import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";

export const dynamic = "force-dynamic";

// GET /api/tasks/drafts — AI-generated draft tasks scoped to the caller.
//   - Leaders see every draft in the workspace.
//   - Department heads see drafts whose department_id matches a dept
//     they head.
//   - Workers get an empty list (nothing to approve).
//
// Excludes drafts spawned by the tl;dv intake pipeline — those live on
// /updates/approvals where they're grouped by meeting (so the dept head
// can act on a meeting's outputs as a batch instead of being bombarded
// with one row per action item).
export async function GET() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (me.role === "worker") {
    return NextResponse.json({ drafts: [], proposedAssignees: {} });
  }

  const supabase = getSupabaseAdmin();

  // Build the exclude-list of task ids that belong to tl;dv meetings.
  // Cheap (intake-log is small + index'd) and keeps the filter expressible
  // in the supabase-js fluent API without resorting to raw SQL.
  const { data: tldvLogs } = await supabase
    .from("tldv_intake_log")
    .select("task_ids");
  const tldvTaskIds = new Set<string>();
  for (const row of (tldvLogs ?? []) as Array<{ task_ids: string[] | null }>) {
    for (const id of row.task_ids ?? []) tldvTaskIds.add(id);
  }

  let q = supabase
    .from("tasks")
    .select(
      "id,title,description,priority,assignee_id,department_id," +
        "estimated_hours,due_date,client_email,missive_thread_url,tags,created_at"
    )
    .eq("is_draft", true)
    .order("created_at", { ascending: false });

  if (me.role === "department_head") {
    const deptIds = me.departmentIds ?? [];
    if (deptIds.length === 0) {
      return NextResponse.json({ drafts: [], proposedAssignees: {} });
    }
    q = q.in("department_id", deptIds);
  }

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Drop any TLDV-meeting drafts so they don't double-render on the
  // /leader/team draft surface.
  const allDrafts = (data ?? []) as Array<{ id: string; assignee_id: string | null }> & typeof data;
  const drafts = allDrafts.filter((d) => !tldvTaskIds.has(d.id));

  // Build a small lookup so the UI can show the proposed assignee's name
  // + avatar without a second round-trip.
  const assigneeIds = Array.from(
    new Set(drafts.map((d) => d.assignee_id).filter((x): x is string => !!x))
  );
  const proposedAssignees: Record<string, { id: string; name: string; avatarUrl: string | null }> = {};
  if (assigneeIds.length > 0) {
    const { data: people } = await supabase
      .from("users")
      .select("id,name,avatar_url")
      .in("id", assigneeIds);
    for (const p of people ?? []) {
      proposedAssignees[p.id] = {
        id: p.id,
        name: p.name,
        avatarUrl: p.avatar_url
      };
    }
  }

  return NextResponse.json({ drafts, proposedAssignees });
}
