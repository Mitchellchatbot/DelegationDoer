// Time-tracking helpers shared by the clock and task-timer endpoints.
//
// The model: each row in `time_entries` is a continuous segment. A segment
// either has a `task_id` (work on that specific task) or `null` (general
// shift time — clocked in but not actively on a task). At most one segment
// per user is "open" (ended_at is null) at any moment.

import { getSupabaseAdmin } from "@/lib/supabase-admin";

const MS_PER_HOUR = 3_600_000;

function startOfTodayUtcIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// Sum the elapsed time today across every segment (any task_id) for a user,
// including a currently-open segment if there is one. Returns hours.
export async function getHoursOnShiftToday(userId: string): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("time_entries")
    .select("started_at, ended_at")
    .eq("user_id", userId)
    .gte("started_at", startOfTodayUtcIso());

  let ms = 0;
  const now = Date.now();
  for (const r of data ?? []) {
    if (!r.started_at) continue;
    const start = new Date(r.started_at).getTime();
    const end = r.ended_at ? new Date(r.ended_at).getTime() : now;
    if (end > start) ms += end - start;
  }
  return ms / MS_PER_HOUR;
}

// Bulk version — one query, returns map of userId → hours today.
export async function getHoursOnShiftTodayByUser(): Promise<Map<string, number>> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("time_entries")
    .select("user_id, started_at, ended_at")
    .gte("started_at", startOfTodayUtcIso());

  const out = new Map<string, number>();
  const now = Date.now();
  for (const r of data ?? []) {
    if (!r.user_id || !r.started_at) continue;
    const start = new Date(r.started_at).getTime();
    const end = r.ended_at ? new Date(r.ended_at).getTime() : now;
    if (end <= start) continue;
    const hours = (end - start) / MS_PER_HOUR;
    out.set(r.user_id, (out.get(r.user_id) ?? 0) + hours);
  }
  return out;
}

// Sum all closed segments for a task across history. Open segments don't
// count (they're "in flight" and added live on the client). Returns hours.
export async function recomputeTaskActualHours(taskId: string): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("time_entries")
    .select("started_at, ended_at")
    .eq("task_id", taskId)
    .not("ended_at", "is", null);

  let ms = 0;
  for (const r of data ?? []) {
    if (!r.started_at || !r.ended_at) continue;
    const start = new Date(r.started_at).getTime();
    const end = new Date(r.ended_at).getTime();
    if (end > start) ms += end - start;
  }
  const hours = +(ms / MS_PER_HOUR).toFixed(2);

  // Mirror into the denorm column so reads stay fast and the existing
  // capacity math keeps working without per-row time_entries joins. The
  // override column wins at the read layer in server-data.
  await supabase.from("tasks").update({ actual_hours: hours }).eq("id", taskId);
  return hours;
}

// Close a user's currently-open segment (if any). When the segment was on a
// task, also refresh that task's actual_hours so the denorm cache stays in
// sync. Returns the closed segment, or null if there was nothing open.
export async function closeOpenSegment(
  userId: string,
  endedAtIso: string = new Date().toISOString()
): Promise<{ id: string; taskId: string | null; startedAt: string; endedAt: string } | null> {
  const supabase = getSupabaseAdmin();
  const { data: open } = await supabase
    .from("time_entries")
    .select("id, started_at, task_id")
    .eq("user_id", userId)
    .is("ended_at", null)
    .maybeSingle();
  if (!open) return null;

  await supabase
    .from("time_entries")
    .update({ ended_at: endedAtIso })
    .eq("id", open.id);

  if (open.task_id) {
    await recomputeTaskActualHours(open.task_id);
  }

  return {
    id: open.id,
    taskId: (open.task_id as string | null) ?? null,
    startedAt: open.started_at as string,
    endedAt: endedAtIso
  };
}

// Open a new segment for a user with the given task_id (null = generic).
// Caller is responsible for closing any existing open segment first; the
// partial unique index on (user_id) where ended_at is null will otherwise
// reject the insert.
export async function openSegment(
  userId: string,
  taskId: string | null,
  note: string | null = null
): Promise<{ id: string; startedAt: string; taskId: string | null }> {
  const supabase = getSupabaseAdmin();
  const id = `te_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const { data, error } = await supabase
    .from("time_entries")
    .insert({ id, user_id: userId, task_id: taskId, note })
    .select("id, started_at, task_id")
    .single();
  if (error) throw new Error(error.message);
  return {
    id: data.id as string,
    startedAt: data.started_at as string,
    taskId: (data.task_id as string | null) ?? null
  };
}

export const TIME_TRACKING_MS_PER_HOUR = MS_PER_HOUR;
