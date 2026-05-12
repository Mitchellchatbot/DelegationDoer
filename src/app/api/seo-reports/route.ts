import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { notifyAssignment } from "@/lib/slack";

export const dynamic = "force-dynamic";

const URGENCY_TO_PRIORITY: Record<string, "low" | "medium" | "high" | "critical"> = {
  low: "low",
  normal: "medium",
  high: "high",
  asap: "critical"
};

const URGENCY_TO_DUE_DAYS: Record<string, number> = {
  low: 7,
  normal: 4,
  high: 2,
  asap: 1
};

// POST /api/seo-reports — kicks off an SEO report request.
//
// Routing logic:
//   1. Find the SEO department (case-insensitive name match).
//   2. Find its department_head — that user becomes the task assignee.
//   3. Create a task tagged `seo-report-request` so the /seo-reports page
//      can list every request in flight.
//   4. Slack-DM the head with the standard assignment notification.
//   5. Slack-DM the rest of the SEO team an FYI so they know the head has
//      it and can chime in.
//
// Body: {
//   clientName: string;          required
//   website?: string;
//   reportTypes?: string[];      e.g. ["traffic", "rankings", "conversions"]
//   notes?: string;
//   urgency?: "low" | "normal" | "high" | "asap"
// }
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json();

    const clientName = (body.clientName ?? "").trim();
    if (!clientName) {
      return NextResponse.json({ error: "clientName is required" }, { status: 400 });
    }
    const website = typeof body.website === "string" ? body.website.trim() || null : null;
    const notes = typeof body.notes === "string" ? body.notes.trim() : "";
    const urgency = typeof body.urgency === "string" ? body.urgency : "normal";
    const reportTypes: string[] = Array.isArray(body.reportTypes)
      ? body.reportTypes.filter((t: unknown) => typeof t === "string")
      : [];
    const priority = URGENCY_TO_PRIORITY[urgency] ?? "medium";
    const dueOffsetDays = URGENCY_TO_DUE_DAYS[urgency] ?? 4;

    const supabase = getSupabaseAdmin();

    // 1) Find the SEO department.
    const { data: dept } = await supabase
      .from("departments")
      .select("id, name")
      .ilike("name", "%seo%")
      .order("name")
      .limit(1)
      .maybeSingle();
    if (!dept) {
      return NextResponse.json(
        { error: "no SEO department found — create one in Settings → Departments first" },
        { status: 400 }
      );
    }

    // 2) Find members + the head. Two reads (head, members) so we have a
    //    deterministic assignee even if multiple heads exist.
    const { data: memberRows } = await supabase
      .from("department_members")
      .select("user_id")
      .eq("department_id", dept.id);
    const memberIds = (memberRows ?? []).map((r) => r.user_id);
    if (memberIds.length === 0) {
      return NextResponse.json(
        { error: `the ${dept.name} department has no members yet` },
        { status: 400 }
      );
    }
    const { data: members } = await supabase
      .from("users")
      .select("id, name, email, role")
      .in("id", memberIds);
    const memberList = members ?? [];
    const head =
      memberList.find((u) => u.role === "department_head") ??
      // Fallback: if there's no head, route to whoever's there (alphabetical)
      // so the request still has an owner.
      memberList[0];
    const teammates = memberList.filter((u) => u.id !== head.id);

    // 3) Build + insert the task.
    const taskId = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date();
    const dueDate = new Date(now.getTime() + dueOffsetDays * 86_400_000).toISOString();
    const requester = await getUserById(userId);

    const reportTypeBlock = reportTypes.length
      ? `Focus areas: ${reportTypes.join(", ")}\n\n`
      : "";
    const description =
      `SEO report request for **${clientName}**` +
      (website ? ` (${website})` : "") +
      `\n\n${reportTypeBlock}${notes || "_No additional notes._"}\n\n` +
      `Requested by ${requester?.name ?? "unknown"}.`;

    const insertRow = {
      id: taskId,
      title: `SEO report: ${clientName}`,
      description,
      status: "pending" as const,
      priority,
      estimated_hours: 4,
      actual_hours: 0,
      tags: Array.from(new Set(["seo-report-request", ...reportTypes])),
      department_id: dept.id,
      assignee_id: head.id,
      creator_id: userId,
      project_id: null,
      due_date: dueDate,
      inactive_flag: false,
      last_activity_at: now.toISOString(),
      created_at: now.toISOString(),
      blocks_task_ids: [],
      client_name: clientName,
      website,
      custom: {}
    };

    const { data: task, error } = await supabase
      .from("tasks")
      .insert(insertRow)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Activity log.
    await supabase.from("activity_logs").insert({
      id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      task_id: taskId,
      user_id: userId,
      action: "created",
      detail: `SEO report request auto-routed to ${head.name}`
    });

    // 4) Assignment notification to the head.
    let headDm: { ok: boolean; error?: string } = { ok: false, error: "skipped" };
    if (head.email) {
      try {
        const r = await notifyAssignment({
          assigneeEmail: head.email,
          assignerName: requester?.name ?? "Someone",
          taskId,
          title: insertRow.title,
          description,
          priority,
          estimateHours: 4,
          dueDate,
          clientName
        });
        headDm = r;
      } catch (e) {
        headDm = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    // No automatic team-wide FYI on creation anymore. Previously this
    // route DM'd every SEO teammate; now only the head gets pinged so
    // they can triage, then use "Notify teammates" on the task detail
    // page to loop in specific people with context. Less noise, more
    // intentional.
    void teammates; // intentionally unused; preserved for symmetry

    return NextResponse.json({
      task,
      routedTo: { id: head.id, name: head.name, email: head.email },
      slack: { headDm }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}

// GET /api/seo-reports — every task tagged seo-report-request, newest first.
// Used by the /seo-reports page to render the list of requests in flight
// (and historical ones).
export async function GET() {
  await requireCurrentUserId();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("tasks")
    .select("id, title, status, priority, client_name, website, assignee_id, creator_id, due_date, created_at, last_activity_at, tags")
    .contains("tags", ["seo-report-request"])
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ requests: data ?? [] });
}
