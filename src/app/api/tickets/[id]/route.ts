import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { CURRENT_USER_ID } from "@/lib/mock-data";

const ALLOWED_FIELDS = ["title", "description", "priority", "status", "estimated_hours", "due_date", "tags", "client_name", "website"] as const;
const STATUSES = ["pending", "in_progress", "urgent", "waiting_on_client", "done"] as const;
const PRIORITIES = ["low", "medium", "high", "critical"] as const;

export const dynamic = "force-dynamic";

// PATCH /api/tickets/[id] — partial update.
// Body shape (all optional): { title, description, priority, status, estimatedHours, dueDate, tags }.
// Logs an activity row when status changes.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await req.json();
    const supabase = getSupabaseAdmin();

    // Fetch current row so we know whether status actually changed.
    const { data: before, error: beErr } = await supabase
      .from("tickets")
      .select("status")
      .eq("id", params.id)
      .maybeSingle();
    if (beErr) return NextResponse.json({ error: beErr.message }, { status: 500 });
    if (!before) return NextResponse.json({ error: "ticket not found" }, { status: 404 });

    const update: Record<string, unknown> = { last_activity_at: new Date().toISOString() };
    if (typeof body.title === "string" && body.title.trim()) update.title = body.title.trim();
    if (typeof body.description === "string") update.description = body.description.trim() || null;
    if (PRIORITIES.includes(body.priority)) update.priority = body.priority;
    if (STATUSES.includes(body.status)) update.status = body.status;
    if (typeof body.estimatedHours === "number" && body.estimatedHours > 0) update.estimated_hours = body.estimatedHours;
    if (body.dueDate === null || typeof body.dueDate === "string") update.due_date = body.dueDate || null;
    if (Array.isArray(body.tags)) update.tags = body.tags.filter((t: unknown) => typeof t === "string");
    if (body.clientName === null) update.client_name = null;
    else if (typeof body.clientName === "string") update.client_name = body.clientName.trim() || null;
    if (body.website === null) update.website = null;
    else if (typeof body.website === "string") update.website = body.website.trim() || null;

    const { data, error } = await supabase
      .from("tickets")
      .update(update)
      .eq("id", params.id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const comment = (typeof body.comment === "string" ? body.comment : "").trim() || null;
    const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl : null;
    const statusChanged = update.status && update.status !== before.status;

    if (statusChanged) {
      const transition = `${before.status} → ${update.status}`;
      await supabase.from("activity_logs").insert({
        id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        ticket_id: params.id,
        user_id: CURRENT_USER_ID,
        action: "status_change",
        detail: comment ? `${transition}\n${comment}` : transition,
        image_url: imageUrl
      });
    } else if (comment || imageUrl) {
      // No status change but the user attached a note/image — log as comment.
      await supabase.from("activity_logs").insert({
        id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        ticket_id: params.id,
        user_id: CURRENT_USER_ID,
        action: "comment",
        detail: comment,
        image_url: imageUrl
      });
    }

    return NextResponse.json({ ticket: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
