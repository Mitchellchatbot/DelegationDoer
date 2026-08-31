import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { stripTeamTag } from "@/lib/task-team";

export const dynamic = "force-dynamic";

// POST /api/sod/create-task
//   body: {
//     title: string,                  // required
//     // Optional "advanced details" — the SOD flow's quick-add path
//     // sends title only; the expandable section adds these. All fall
//     // back to the lightweight defaults below when absent.
//     priority?: "low" | "medium" | "high" | "critical",
//     estimatedHours?: number,
//     tags?: string[],
//     departmentId?: string,          // overrides the user's primary dept
//     dueDate?: string,               // ISO datetime
//     clientName?: string,
//     website?: string
//   }
//
// Lightweight task creator wired specifically for the SOD "Add as task"
// affordance. Differs from /api/tasks in two ways:
//   1. Bypasses the clock-in gate — SOD happens before a shift starts,
//      and not every team uses the clock system, so blocking task
//      creation here would defeat the purpose of the flow.
//   2. Creates the task already set to "in_progress" (since the user is
//      naming today's work, not parking something for later) and
//      assigned to the caller. Department defaults to the user's primary
//      one and there's no due date unless the advanced fields set them.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "no user" }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as {
      title?: unknown;
      priority?: unknown;
      estimatedHours?: unknown;
      tags?: unknown;
      departmentId?: unknown;
      dueDate?: unknown;
      clientName?: unknown;
      website?: unknown;
    };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });

    // Optional advanced fields. Sanitized the same way /api/tasks does,
    // each falling back to the SOD quick-add default when not supplied.
    const allowedPriorities = ["low", "medium", "high", "critical"] as const;
    const priority = allowedPriorities.includes(body.priority as (typeof allowedPriorities)[number])
      ? (body.priority as (typeof allowedPriorities)[number])
      : "medium";
    const estimatedHours = Number(body.estimatedHours) > 0 ? Number(body.estimatedHours) : 2;
    // stripTeamTag, not a bare string filter: the team marker is server-owned
    // (see lib/task-team.ts). This route always self-assigns, so it can never
    // legitimately mint a team task — without the strip, a hand-crafted POST
    // could plant the tag and then release the task into another
    // department's pool via DELETE /api/tasks/[id]/claim.
    const tags = stripTeamTag(body.tags);
    // Caller-chosen department wins; otherwise the user's primary dept.
    const departmentId =
      typeof body.departmentId === "string" && body.departmentId.length > 0
        ? body.departmentId
        : (me.departmentIds?.[0] ?? null);
    const dueDate = typeof body.dueDate === "string" && body.dueDate ? body.dueDate : null;
    const clientName =
      typeof body.clientName === "string" && body.clientName.trim() ? body.clientName.trim() : null;
    const website =
      typeof body.website === "string" && body.website.trim() ? body.website.trim() : null;

    const supabase = getSupabaseAdmin();
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();

    const row = {
      id,
      title,
      description: null,
      status: "in_progress" as const,
      priority,
      estimated_hours: estimatedHours,
      actual_hours: 0,
      tags,
      department_id: departmentId,
      assignee_id: userId,
      creator_id: userId,
      project_id: null,
      due_date: dueDate,
      inactive_flag: false,
      last_activity_at: now,
      created_at: now,
      blocks_task_ids: [] as string[],
      client_name: clientName,
      website,
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
