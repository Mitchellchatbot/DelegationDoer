// Shared draft-approval logic. Used by:
//   - POST /api/tasks/:id/approve-draft       (single)
//   - POST /api/tasks/:id/reject-draft        (single)
//   - POST /api/integrations/tldv/meetings/:id/approve-all (bulk, per meeting)
//   - POST /api/integrations/tldv/meetings/:id/reject-all  (bulk, per meeting)
//
// Promoting a draft fires a Slack DM to the assignee — matching the
// auto-intake flow that would have run had the task not been a draft.
// Rejection deletes the row (no tombstone yet; swap to `rejected_at` if
// audit becomes a need).
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getUserById } from "@/lib/server-data";
import { notifyAssignment } from "@/lib/slack";
import type { User } from "@/lib/types";

export interface ApprovePatch {
  title?: string;
  description?: string;
  assigneeId?: string;
  priority?: "low" | "medium" | "high" | "critical";
}

export interface DraftActionResult {
  ok: boolean;
  status: number;
  taskId: string;
  error?: string;
  task?: Record<string, unknown>;
}

const ALLOWED_PRIORITIES = ["low", "medium", "high", "critical"] as const;

// Can `actor` act on a draft whose department_id is `deptId`?
// Mirrors the rule used by the legacy per-task routes: leaders pass;
// dept heads pass only when the draft's department is one they head.
export function canActOnDraft(actor: User, deptId: string | null | undefined): boolean {
  const isLeaderRole = actor.role === "leader" || actor.isAdmin === true;
  if (isLeaderRole) return true;
  const isHeadOfDept =
    actor.role === "department_head" &&
    deptId != null &&
    (actor.departmentIds ?? []).includes(deptId);
  return isHeadOfDept;
}

export async function approveDraftTask(
  taskId: string,
  actorId: string,
  patch?: ApprovePatch
): Promise<DraftActionResult> {
  const me = await getUserById(actorId);
  if (!me) return { ok: false, status: 401, taskId, error: "unauthorized" };

  const supabase = getSupabaseAdmin();
  const { data: draftRaw, error: fetchErr } = await supabase
    .from("tasks")
    .select(
      "id, title, description, priority, assignee_id, department_id, " +
        "estimated_hours, due_date, is_draft, client_name"
    )
    .eq("id", taskId)
    .maybeSingle();
  if (fetchErr) return { ok: false, status: 500, taskId, error: fetchErr.message };
  if (!draftRaw) return { ok: false, status: 404, taskId, error: "not found" };
  const draft = draftRaw as unknown as {
    id: string;
    department_id: string | null;
    is_draft: boolean;
  };
  if (!draft.is_draft) return { ok: false, status: 409, taskId, error: "not a draft" };

  if (!canActOnDraft(me, draft.department_id)) {
    return { ok: false, status: 403, taskId, error: "forbidden" };
  }

  const update: Record<string, unknown> = {
    is_draft: false,
    status: "pending",
    last_activity_at: new Date().toISOString()
  };
  if (patch?.title && typeof patch.title === "string" && patch.title.trim()) {
    update.title = patch.title.trim();
  }
  if (typeof patch?.description === "string") update.description = patch.description;
  if (typeof patch?.assigneeId === "string" && patch.assigneeId) {
    update.assignee_id = patch.assigneeId;
  }
  if (patch?.priority && (ALLOWED_PRIORITIES as readonly string[]).includes(patch.priority)) {
    update.priority = patch.priority;
  }

  const { data: updatedRaw, error: updateErr } = await supabase
    .from("tasks")
    .update(update)
    .eq("id", taskId)
    .select(
      "id, title, description, priority, assignee_id, estimated_hours, " +
        "due_date, client_name"
    )
    .single();
  if (updateErr) return { ok: false, status: 500, taskId, error: updateErr.message };
  const updated = updatedRaw as unknown as {
    id: string;
    title: string;
    description: string | null;
    priority: string;
    assignee_id: string | null;
    estimated_hours: number | null;
    due_date: string | null;
    client_name: string | null;
  };

  await supabase.from("activity_logs").insert({
    id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    task_id: taskId,
    user_id: me.id,
    action: "created",
    detail: `Approved AI-drafted task`
  });

  // Slack the (now-real) assignee. Best-effort — a missing DM doesn't
  // un-promote the task.
  if (updated.assignee_id) {
    const { data: assignee } = await supabase
      .from("users")
      .select("email")
      .eq("id", updated.assignee_id)
      .maybeSingle();
    const a = assignee as { email: string | null } | null;
    if (a?.email) {
      try {
        await notifyAssignment({
          assigneeEmail: a.email,
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
        /* swallow */
      }
    }
  }

  return { ok: true, status: 200, taskId, task: updated as unknown as Record<string, unknown> };
}

export async function rejectDraftTask(
  taskId: string,
  actorId: string
): Promise<DraftActionResult> {
  const me = await getUserById(actorId);
  if (!me) return { ok: false, status: 401, taskId, error: "unauthorized" };

  const supabase = getSupabaseAdmin();
  const { data: draftRaw, error: fetchErr } = await supabase
    .from("tasks")
    .select("id, department_id, is_draft")
    .eq("id", taskId)
    .maybeSingle();
  if (fetchErr) return { ok: false, status: 500, taskId, error: fetchErr.message };
  if (!draftRaw) return { ok: false, status: 404, taskId, error: "not found" };
  const draft = draftRaw as unknown as {
    id: string;
    department_id: string | null;
    is_draft: boolean;
  };
  if (!draft.is_draft) return { ok: false, status: 409, taskId, error: "not a draft" };

  if (!canActOnDraft(me, draft.department_id)) {
    return { ok: false, status: 403, taskId, error: "forbidden" };
  }

  const { error: deleteErr } = await supabase.from("tasks").delete().eq("id", taskId);
  if (deleteErr) return { ok: false, status: 500, taskId, error: deleteErr.message };
  return { ok: true, status: 200, taskId };
}
