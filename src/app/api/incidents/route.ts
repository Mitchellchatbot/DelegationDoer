import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { CURRENT_USER_ID } from "@/lib/session";

export const dynamic = "force-dynamic";

// POST /api/incidents — create an incident_log row AND a high-priority,
// urgent-status ticket assigned to whoever the routing table points at for
// that issue type. The widget will alert that person on its next poll.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const description = (body.description ?? "").trim();
    if (!description) return NextResponse.json({ error: "description required" }, { status: 400 });

    const issueType: string = (body.issueType ?? "other").toString();
    const affectedUrl: string | null = (body.affectedUrl ?? "").trim() || null;

    const supabase = getSupabaseAdmin();

    // Look up routing for this issue type, fall back to "other".
    const [{ data: routeRow }, { data: fallbackRow }] = await Promise.all([
      supabase.from("incident_routing").select("user_id").eq("issue_type", issueType).maybeSingle(),
      supabase.from("incident_routing").select("user_id").eq("issue_type", "other").maybeSingle()
    ]);
    const assignedToId: string | null = routeRow?.user_id ?? fallbackRow?.user_id ?? null;

    // First department the assignee is in, used to tag the ticket.
    let departmentId: string | null = null;
    if (assignedToId) {
      const { data: dm } = await supabase
        .from("department_members")
        .select("department_id")
        .eq("user_id", assignedToId)
        .limit(1)
        .maybeSingle();
      departmentId = dm?.department_id ?? null;
    }

    const now = new Date().toISOString();
    const incidentId = `i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const ticketId   = `t_inc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

    const { data: incident, error: ie } = await supabase
      .from("incident_logs")
      .insert({
        id: incidentId,
        issue_type: issueType,
        affected_url: affectedUrl,
        description,
        assigned_to_id: assignedToId
      })
      .select()
      .single();
    if (ie) return NextResponse.json({ error: ie.message }, { status: 500 });

    const { data: ticket, error: te } = await supabase
      .from("tickets")
      .insert({
        id: ticketId,
        title: `[Incident] ${issueType} — ${affectedUrl ?? "no url"}`,
        description,
        status: "urgent",
        priority: "critical",
        estimated_hours: 2,
        actual_hours: 0,
        tags: ["urgent", "incident"],
        department_id: departmentId,
        assignee_id: assignedToId,
        creator_id: CURRENT_USER_ID,
        project_id: null,
        due_date: now,
        inactive_flag: false,
        last_activity_at: now,
        blocks_ticket_ids: []
      })
      .select()
      .single();
    if (te) return NextResponse.json({ error: te.message }, { status: 500 });

    // Activity row so the ticket detail page shows it was incident-created.
    await supabase.from("activity_logs").insert({
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      ticket_id: ticketId,
      user_id: CURRENT_USER_ID,
      action: "created",
      detail: `Incident: ${issueType}${affectedUrl ? " — " + affectedUrl : ""}`
    });

    return NextResponse.json({ incident, ticket });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
