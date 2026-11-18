import { getSupabaseAdmin, isMissingTableError } from "@/lib/supabase-admin";
import { metaProgress, metaClientName, type MetaProgress, type OnboardingState } from "@/lib/meta-onboarding";
import type { Priority } from "@/lib/types";

// Server-side reads for Meta onboarding (/meta-onboarding). Each one is
// anchored to one Facebook task, exactly like FB onboarding: the task carries
// the assignee, due date and conversation; meta_onboarding carries the
// checklist. Who may see and work it is FB onboarding's rule
// (canSeeFbOnboarding, and the same task gate in the API route).

export interface MetaOnboardingSummary {
  taskId: string;
  client: string;
  taskTitle: string;
  taskStatus: string;
  assigneeId: string | null;
  dueDate: string | null;
  priority: Priority;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  progress: MetaProgress;
}

// `ready` is false until the hand-applied migration has created the table.
// Any OTHER error is thrown, so a transient failure can't pass for "not set
// up yet".
export async function listMetaOnboardings(): Promise<{ ready: boolean; items: MetaOnboardingSummary[] }> {
  const supabase = getSupabaseAdmin();
  const { data: rows, error } = await supabase
    .from("meta_onboarding")
    .select("task_id, state, started_at, updated_at, completed_at")
    .order("started_at", { ascending: true });
  if (error) {
    if (isMissingTableError(error)) return { ready: false, items: [] };
    throw new Error(`meta_onboarding: ${error.message}`);
  }
  const list = rows ?? [];
  if (list.length === 0) return { ready: true, items: [] };

  const { data: tasks, error: taskErr } = await supabase
    .from("tasks")
    .select("id, title, status, assignee_id, due_date, priority, client_name, deleted_at")
    .in("id", list.map((r) => r.task_id as string));
  if (taskErr) throw new Error(`tasks: ${taskErr.message}`);
  const byId = new Map((tasks ?? []).filter((t) => !t.deleted_at).map((t) => [t.id as string, t]));

  const items = list.flatMap((r) => {
    const t = byId.get(r.task_id as string);
    if (!t) return [];
    const state = (r.state as OnboardingState) ?? {};
    return [{
      taskId: r.task_id as string,
      client: metaClientName(state) || ((t.client_name as string | null) ?? (t.title as string)),
      taskTitle: t.title as string,
      taskStatus: t.status as string,
      assigneeId: (t.assignee_id as string | null) ?? null,
      dueDate: (t.due_date as string | null) ?? null,
      priority: (t.priority as Priority | null) ?? "medium",
      startedAt: r.started_at as string,
      updatedAt: r.updated_at as string,
      completedAt: (r.completed_at as string | null) ?? null,
      progress: metaProgress(state)
    }];
  });
  return { ready: true, items };
}

// null = not started on this task. `ready` false = the table doesn't exist yet.
export async function getMetaOnboarding(
  taskId: string
): Promise<{ ready: boolean; onboarding: { state: OnboardingState; completedAt: string | null } | null }> {
  const { data, error } = await getSupabaseAdmin()
    .from("meta_onboarding")
    .select("state, completed_at")
    .eq("task_id", taskId)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) return { ready: false, onboarding: null };
    throw new Error(`meta_onboarding: ${error.message}`);
  }
  if (!data) return { ready: true, onboarding: null };
  return {
    ready: true,
    onboarding: { state: (data.state as OnboardingState) ?? {}, completedAt: (data.completed_at as string | null) ?? null }
  };
}
