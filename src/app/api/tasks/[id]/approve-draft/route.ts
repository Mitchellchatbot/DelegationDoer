import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { notifyAssignment } from "@/lib/slack";

export const dynamic = "force-dynamic";

// POST /api/tasks/:id/approve-draft
//
// Promotes a draft task to a live "pending" task and DMs the assignee on
// Slack (mirroring the auto-intake flow that previously fired at create
// time). Authorized for:
//   - leaders
//   - department heads whose dept(s) include the draft's department_id
//
// Optional body: { assigneeId, priority, title, description } — lets the
// approver tweak the AI's proposal before flipping it live. Anything not
// in the body is left unchanged.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const supabase = getSupabaseAdmin();
  const { data: draft, error: fetchErr } = await supabase
    .from("tasks")
    .select("id, title, description, priority, assignee_id, department_id, estimated_hours, due_date, is_draft, client_name")
    .eq("id", params.id)
    .maybeSingle();
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!draft) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!draft.is_draft) return NextResponse.json({ error: "not a draft" }, { status: 409 });

  // Permission check. Leaders pass; dept heads pass only for drafts in a
  // department they head.
  const isLeader = me.role === "leader";
  const isHeadOfDept =
    me.role === "department_head" &&
    draft.department_id != null &&
    (me.departmentIds ?? []).includes(draft.department_id);
  if (!isLeader && !isHeadOfDept) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const allowedPriorities = ["low", "medium", "high", "critical"] as const;

  const patch: Record<string, unknown> = {
    is_draft: false,
    status: "pending",
    last_activity_at: new Date().toISOString()
  };
  if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim();
  if (typeof body.description === "string") patch.description = body.description;
  if (typeof body.assigneeId === "string") patch.assignee_id = body.assigneeId;
  if (allowedPriorities.includes(body.priority)) patch.priority = body.priority;

  const { data: updated, error: updateErr } = await supabase
    .from("tasks")
    .update(patch)
    .eq("id", params.id)
    .select("id, title, description, priority, assignee_id, estimated_hours, due_date, client_name")
    .single();
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  // Activity log entry so the task history reflects "approved by X".
  await supabase.from("activity_logs").insert({
    id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    task_id: params.id,
    user_id: me.id,
    action: "created",
    detail: `Approved AI-drafted task`
  });

  // Notify the (now-real) assignee, mirroring the email-intake behavior
  // that would have fired had the task not been a draft.
  if (updated.assignee_id) {
    const { data: assignee } = await supabase
      .from("users")
      .select("email")
      .eq("id", updated.assignee_id)
      .maybeSingle();
    if (assignee?.email) {
      try {
        await notifyAssignment({
          assigneeEmail: assignee.email,
          assignerName: me.name,
          taskId: updated.id,
          title: updated.title,
          description: updated.description ?? "",
          priority: updated.priority,
          estimateHours: Number(updated.estimated_hours ?? 0),
          dueDate: updated.due_date,
          clientName: updated.client_name ?? null
        });
      } catch {
        /* swallow — task is live, the DM is a notification */
      }
    }
  }

  return NextResponse.json({ ok: true, task: updated });
}
