import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";

export const dynamic = "force-dynamic";

// GET /api/integrations/tldv/meetings/summary
//   { pendingMeetingCount: number }
//
// Cheap "how many tl;dv meetings need approval?" — drives the Approvals
// sub-tab badge. Same role-scoping as the full list endpoint. Mirrors
// the /api/seo-reports/summary shape so the badge poll in UpdatesTabs
// follows the established convention.
export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ pendingMeetingCount: 0 });
    if (me.role === "worker") {
      return NextResponse.json({ pendingMeetingCount: 0 });
    }

    const supabase = getSupabaseAdmin();
    const { data: logRows } = await supabase
      .from("tldv_intake_log")
      .select("meeting_id, task_ids")
      .order("processed_at", { ascending: false })
      .limit(100);
    const logs = (logRows ?? []) as Array<{
      meeting_id: string;
      task_ids: string[] | null;
    }>;
    const allTaskIds = logs.flatMap((l) => l.task_ids ?? []);
    if (allTaskIds.length === 0) {
      return NextResponse.json({ pendingMeetingCount: 0 });
    }

    let tq = supabase
      .from("tasks")
      .select("id, department_id")
      .in("id", allTaskIds)
      .eq("is_draft", true);
    if (me.role === "department_head") {
      const deptIds = me.departmentIds ?? [];
      if (deptIds.length === 0) {
        return NextResponse.json({ pendingMeetingCount: 0 });
      }
      tq = tq.in("department_id", deptIds);
    }
    const { data: taskRows } = await tq;
    const pendingTaskIds = new Set(
      ((taskRows ?? []) as Array<{ id: string }>).map((t) => t.id)
    );

    // A meeting "counts" if any of its task_ids is still a pending draft
    // visible to this user.
    let pendingMeetingCount = 0;
    for (const log of logs) {
      const hasPending = (log.task_ids ?? []).some((id) => pendingTaskIds.has(id));
      if (hasPending) pendingMeetingCount += 1;
    }

    return NextResponse.json({ pendingMeetingCount });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
