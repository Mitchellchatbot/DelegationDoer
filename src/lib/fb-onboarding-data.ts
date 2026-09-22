import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { progress, PROVIDER_KEY, type OnboardingState } from "@/lib/fb-onboarding";
import type { User } from "@/lib/types";

// Server-side reads for the Facebook onboarding workspace (/fb-onboarding).
// Each onboarding is anchored to one Facebook task — the task carries the
// assignee, due date and conversation; fb_onboarding carries the checklist.

export const FB_DEPT = "dep_facebook";

// The Facebook team plus leaders / admins. Drives the sidebar row and the
// list page; the per-onboarding page also admits anyone who can see the task.
export function canSeeFbOnboarding(u: User | null | undefined): boolean {
  if (!u) return false;
  if (u.role === "leader" || u.isAdmin) return true;
  return (u.departmentIds ?? []).includes(FB_DEPT);
}

export interface OnboardingSummary {
  taskId: string;
  provider: string;
  taskTitle: string;
  taskStatus: string;
  assigneeId: string | null;
  creatorId: string | null;
  dueDate: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  progress: ReturnType<typeof progress>;
  // Team notes = the task's comments. Count plus the newest, for the card.
  noteCount: number;
  latestNote: { userId: string | null; text: string; at: string } | null;
}

export async function listOnboardings(): Promise<OnboardingSummary[]> {
  const supabase = getSupabaseAdmin();
  const { data: rows } = await supabase
    .from("fb_onboarding")
    .select("task_id, state, started_at, updated_at, completed_at")
    .order("updated_at", { ascending: false });
  const list = rows ?? [];
  if (list.length === 0) return [];

  const { data: tasks } = await supabase
    .from("tasks")
    .select("id, title, status, assignee_id, creator_id, due_date, client_name, deleted_at")
    .in("id", list.map((r) => r.task_id));
  const byId = new Map((tasks ?? []).filter((t) => !t.deleted_at).map((t) => [t.id as string, t]));

  // Newest first, so the first row seen per task is its latest note.
  const { data: comments } = await supabase
    .from("activity_logs")
    .select("task_id, user_id, detail, created_at")
    .in("task_id", list.map((r) => r.task_id))
    .eq("action", "comment")
    .order("created_at", { ascending: false });
  const notes = new Map<string, { count: number; latest: OnboardingSummary["latestNote"] }>();
  for (const c of comments ?? []) {
    const id = c.task_id as string;
    const cur = notes.get(id);
    if (cur) { cur.count++; continue; }
    notes.set(id, {
      count: 1,
      latest: { userId: (c.user_id as string | null) ?? null, text: (c.detail as string | null) ?? "", at: c.created_at as string }
    });
  }

  return list.flatMap((r) => {
    const t = byId.get(r.task_id as string);
    if (!t) return [];
    const state = (r.state as OnboardingState) ?? {};
    const provider = typeof state[PROVIDER_KEY]?.v === "string" && state[PROVIDER_KEY].v
      ? (state[PROVIDER_KEY].v as string)
      : ((t.client_name as string | null) ?? (t.title as string));
    return [{
      taskId: r.task_id as string,
      provider,
      taskTitle: t.title as string,
      taskStatus: t.status as string,
      assigneeId: (t.assignee_id as string | null) ?? null,
      creatorId: (t.creator_id as string | null) ?? null,
      dueDate: (t.due_date as string | null) ?? null,
      startedAt: r.started_at as string,
      updatedAt: r.updated_at as string,
      completedAt: (r.completed_at as string | null) ?? null,
      progress: progress(state),
      noteCount: notes.get(r.task_id as string)?.count ?? 0,
      latestNote: notes.get(r.task_id as string)?.latest ?? null
    }];
  });
}

export async function getOnboarding(taskId: string): Promise<{ state: OnboardingState; completedAt: string | null } | null> {
  const { data } = await getSupabaseAdmin()
    .from("fb_onboarding")
    .select("state, completed_at")
    .eq("task_id", taskId)
    .maybeSingle();
  if (!data) return null;
  return { state: (data.state as OnboardingState) ?? {}, completedAt: (data.completed_at as string | null) ?? null };
}
