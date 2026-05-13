import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getAllTasks, getUserById } from "@/lib/server-data";
import { notifyAssignment } from "@/lib/slack";
import { syncTaskToCalendar } from "@/lib/task-calendar-sync";

export const dynamic = "force-dynamic";

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t || null;
}

// GET /api/tasks — every task in the system, in the camelCase shape the UI
// expects. Used by the board (and anywhere that needs a fresh org-wide
// snapshot). No filtering server-side; clients filter as they like.
export async function GET() {
  try {
    const tasks = await getAllTasks();
    return NextResponse.json({ tasks });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST /api/tasks — create a new task. Returns the inserted row.
// The new task has no row in assignment_acknowledgements, so the widget
// will fire its alert + sound on the next 15-second poll.

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json();

    const title = (body.title ?? "").trim();
    if (!title) {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }

    const allowedPriorities = ["low", "medium", "high", "critical"] as const;
    const priority = allowedPriorities.includes(body.priority) ? body.priority : "medium";

    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();

    const row = {
      id,
      title,
      description: (body.description ?? "").trim() || null,
      status: "pending" as const,
      priority,
      estimated_hours: Number(body.estimatedHours) > 0 ? Number(body.estimatedHours) : 2,
      actual_hours: 0,
      tags: Array.isArray(body.tags) ? body.tags.filter((t: unknown) => typeof t === "string") : [],
      department_id: typeof body.departmentId === "string" && body.departmentId.length > 0 ? body.departmentId : null,
      assignee_id: typeof body.assigneeId === "string" && body.assigneeId.length > 0 ? body.assigneeId : null,
      creator_id: userId,
      project_id: typeof body.projectId === "string" && body.projectId.length > 0 ? body.projectId : null,
      due_date: typeof body.dueDate === "string" ? body.dueDate : null,
      inactive_flag: false,
      last_activity_at: now,
      created_at: now,
      blocks_task_ids: [],
      client_name: typeof body.clientName === "string" && body.clientName.trim() ? body.clientName.trim() : null,
      website: typeof body.website === "string" && body.website.trim() ? body.website.trim() : null,
      // Notion-style project fields. All optional. Empty/whitespace
      // strings → null so the UI's "empty state" rendering works.
      client_email: trimOrNull(body.clientEmail),
      client_folder_url: trimOrNull(body.clientFolderUrl),
      staging_server: trimOrNull(body.stagingServer),
      markup_link: trimOrNull(body.markupLink),
      hosting_access: trimOrNull(body.hostingAccess),
      missive_thread_url: trimOrNull(body.missiveThreadUrl),
      // Custom-field values keyed by field id. Validated structurally on
      // write (must be a plain object) but not type-checked against field
      // defs — that's enforced at edit time on the client.
      custom: body.custom && typeof body.custom === "object" && !Array.isArray(body.custom)
        ? body.custom
        : {}
    };

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("tasks")
      .insert(row)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Log the creation as activity. Resolve the assignee's name so the
    // log reads "Assigned to Shaheer Khosa" instead of the raw user id.
    let assigneeName: string | null = null;
    if (row.assignee_id) {
      const { data: u } = await supabase
        .from("users")
        .select("name")
        .eq("id", row.assignee_id)
        .maybeSingle();
      assigneeName = (u?.name as string) ?? null;
    }
    await supabase.from("activity_logs").insert({
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      task_id: id,
      user_id: userId,
      action: "created",
      detail: row.assignee_id
        ? `Assigned to ${assigneeName ?? row.assignee_id}`
        : "Created (unassigned)"
    });

    // Awaited Slack DM (was fire-and-forget but Railway was occasionally
    // tearing down the request before the outbound fetch flushed).
    // ~300ms latency cost is fine; the assignee actually getting their DM
    // matters more.
    let slack: { delivery: "sent" | "skipped" | "failed"; error?: string } = { delivery: "skipped" };
    if (row.assignee_id) {
      const [assignee, assigner] = await Promise.all([
        getUserById(row.assignee_id),
        getUserById(userId)
      ]);
      if (assignee?.email && assigner?.name) {
        try {
          const r = await notifyAssignment({
            assigneeEmail: assignee.email,
            assignerName: assigner.name,
            taskId: id,
            title: row.title,
            description: row.description,
            priority: row.priority,
            estimateHours: Number(row.estimated_hours),
            dueDate: row.due_date,
            clientName: row.client_name
          });
          slack = r.ok ? { delivery: "sent" } : { delivery: "failed", error: r.error };
        } catch (err) {
          slack = { delivery: "failed", error: err instanceof Error ? err.message : String(err) };
        }
      }
    }

    // Mirror to the assignee's Google Calendar if they're connected.
    // Fire-and-forget — never blocks the task creation response.
    void syncTaskToCalendar(id);

    return NextResponse.json({ task: data, slack });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
