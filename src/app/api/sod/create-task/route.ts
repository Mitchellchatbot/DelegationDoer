import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// POST /api/sod/create-task
//   body: { title: string }
//
// Lightweight task creator wired specifically for the SOD "Add as task"
// affordance. Differs from /api/tasks in two ways:
//   1. Bypasses the clock-in gate — SOD happens before a shift starts,
//      and not every team uses the clock system, so blocking task
//      creation here would defeat the purpose of the flow.
//   2. Creates the task already set to "in_progress" (since the user is
//      naming today's work, not parking something for later), assigned
//      to the caller, and tagged with their primary department. No due
//      date — the user can set one later from /tasks.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "no user" }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as { title?: unknown };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();
    const departmentId = me.departmentIds?.[0] ?? null;

    const row = {
      id,
      title,
      description: null,
      status: "in_progress" as const,
      priority: "medium" as const,
      estimated_hours: 2,
      actual_hours: 0,
      tags: [] as string[],
      department_id: departmentId,
      assignee_id: userId,
      creator_id: userId,
      project_id: null,
      due_date: null,
      inactive_flag: false,
      last_activity_at: now,
      created_at: now,
      blocks_task_ids: [] as string[],
      client_name: null,
      website: null,
      client_email: null,
      client_folder_url: null,
      staging_server: null,
      markup_link: null,
      hosting_access: null,
      missive_thread_url: null,
      custom: {} as Record<string, unknown>
    };

    const { data, error } = await supabase.from("tasks").insert(row).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Activity log — same pattern as /api/tasks, so the timeline
    // reflects SOD-created tasks alongside hand-created ones.
    await supabase.from("activity_logs").insert({
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      task_id: id,
      user_id: userId,
      action: "created",
      detail: "Created via SOD flow"
    });

    return NextResponse.json({ ok: true, id, task: data });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}
