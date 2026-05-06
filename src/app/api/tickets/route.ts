import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { CURRENT_USER_ID, userById } from "@/lib/mock-data";
import { notifyAssignment } from "@/lib/slack";

// POST /api/tickets — create a new ticket. Returns the inserted row.
// The new ticket has no row in assignment_acknowledgements, so the widget
// will fire its alert + sound on the next 15-second poll.

export async function POST(req: NextRequest) {
  try {
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
      creator_id: CURRENT_USER_ID,
      project_id: typeof body.projectId === "string" && body.projectId.length > 0 ? body.projectId : null,
      due_date: typeof body.dueDate === "string" ? body.dueDate : null,
      inactive_flag: false,
      last_activity_at: now,
      created_at: now,
      blocks_ticket_ids: [],
      client_name: typeof body.clientName === "string" && body.clientName.trim() ? body.clientName.trim() : null,
      website: typeof body.website === "string" && body.website.trim() ? body.website.trim() : null
    };

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("tickets")
      .insert(row)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Log the creation as activity.
    await supabase.from("activity_logs").insert({
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      ticket_id: id,
      user_id: CURRENT_USER_ID,
      action: "created",
      detail: row.assignee_id ? `Assigned to ${row.assignee_id}` : "Created (unassigned)"
    });

    // Awaited Slack DM (was fire-and-forget but Railway was occasionally
    // tearing down the request before the outbound fetch flushed).
    // ~300ms latency cost is fine; the assignee actually getting their DM
    // matters more.
    let slack: { delivery: "sent" | "skipped" | "failed"; error?: string } = { delivery: "skipped" };
    if (row.assignee_id) {
      const assignee = userById(row.assignee_id);
      const assigner = userById(CURRENT_USER_ID);
      if (assignee?.email && assigner?.name) {
        try {
          const r = await notifyAssignment({
            assigneeEmail: assignee.email,
            assignerName: assigner.name,
            ticketId: id,
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

    return NextResponse.json({ ticket: data, slack });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
