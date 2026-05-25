import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canActOnDraft } from "@/lib/draft-approval";

export const dynamic = "force-dynamic";

interface EditBody {
  title?: string;
  description?: string;
  assigneeId?: string | null;
  departmentId?: string | null;
  dueDate?: string | null;
  priority?: "low" | "medium" | "high" | "critical";
}

const ALLOWED_PRIORITIES = new Set(["low", "medium", "high", "critical"]);

// PATCH /api/routing-review/:taskId — edit a draft in-place WITHOUT
// flipping is_draft. Reviewer can rework the AI's proposal as many
// times as they want before approving. Permission gate matches the
// approve / deny endpoints (canActOnDraft).
export async function PATCH(
  req: NextRequest,
  { params }: { params: { taskId: string } }
) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as EditBody;

  const supabase = getSupabaseAdmin();
  const { data: draftRaw, error: fetchErr } = await supabase
    .from("tasks")
    .select(
      "id, title, description, priority, assignee_id, department_id, due_date, is_draft"
    )
    .eq("id", params.taskId)
    .maybeSingle();
  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }
  if (!draftRaw) return NextResponse.json({ error: "not found" }, { status: 404 });
  const draft = draftRaw as unknown as {
    id: string;
    title: string;
    description: string | null;
    priority: string;
    assignee_id: string | null;
    department_id: string | null;
    due_date: string | null;
    is_draft: boolean;
  };
  if (!draft.is_draft) {
    return NextResponse.json({ error: "not a draft" }, { status: 409 });
  }
  if (!canActOnDraft(me, draft.department_id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const update: Record<string, unknown> = {
    last_activity_at: new Date().toISOString()
  };
  const diffs: string[] = [];

  if (typeof body.title === "string" && body.title.trim() && body.title.trim() !== draft.title) {
    update.title = body.title.trim();
    diffs.push("title");
  }
  if (typeof body.description === "string" && body.description !== draft.description) {
    update.description = body.description;
    diffs.push("description");
  }
  if ("assigneeId" in body && body.assigneeId !== draft.assignee_id) {
    update.assignee_id = body.assigneeId ?? null;
    diffs.push("assignee");
  }
  if ("departmentId" in body && body.departmentId !== draft.department_id) {
    update.department_id = body.departmentId ?? null;
    diffs.push("department");
  }
  if ("dueDate" in body && body.dueDate !== draft.due_date) {
    update.due_date = body.dueDate ?? null;
    diffs.push("due date");
  }
  if (
    typeof body.priority === "string" &&
    ALLOWED_PRIORITIES.has(body.priority) &&
    body.priority !== draft.priority
  ) {
    update.priority = body.priority;
    diffs.push("priority");
  }

  if (diffs.length === 0) {
    // No-op — return the existing row so the client can refresh.
    return NextResponse.json({ ok: true, task: draft, changed: [] });
  }

  // If the user moved the draft into a different dept, re-check that
  // the actor can still see/act on the NEW dept; otherwise they'd be
  // editing themselves out of permission.
  if (
    "department_id" in update &&
    !canActOnDraft(me, update.department_id as string | null)
  ) {
    return NextResponse.json(
      { error: "cannot move draft to a department you don't head" },
      { status: 403 }
    );
  }

  const { data: updatedRaw, error: updateErr } = await supabase
    .from("tasks")
    .update(update)
    .eq("id", params.taskId)
    .select(
      "id, title, description, priority, assignee_id, department_id, due_date"
    )
    .single();
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  await supabase.from("activity_logs").insert({
    id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    task_id: params.taskId,
    user_id: me.id,
    action: "edited",
    detail: `Reviewer updated ${diffs.join(", ")}`
  });

  return NextResponse.json({ ok: true, task: updatedRaw, changed: diffs });
}
