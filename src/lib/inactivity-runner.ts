// Shared runner for the inactivity sweep so the /api/cron/inactivity route
// AND the in-process scheduler (cron-bootstrap) drive the exact same logic —
// the same split task-archive-runner / email-intake-runner use.
//
// Idempotent: the `inactive_flag = false` filter means already-flagged rows
// are never touched again, so a duplicate run (overlapping interval, restart,
// or a Vercel cron firing alongside the in-process loop) flips nothing twice.
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export interface InactivitySweepResult {
  flagged: number;
}

// Flags any open task with no activity in 48h.
export async function runInactivitySweep(): Promise<InactivitySweepResult> {
  const supabase = getSupabaseAdmin();
  const cutoff = new Date(Date.now() - 48 * 36e5).toISOString();

  // Only the rows we'll actually flip — open tasks, not yet flagged,
  // last activity older than the cutoff.
  const { data, error } = await supabase
    .from("tasks")
    .update({ inactive_flag: true })
    .neq("status", "done")
    .eq("inactive_flag", false)
    .lt("last_activity_at", cutoff)
    .select("id");

  if (error) throw new Error(error.message);
  return { flagged: data?.length ?? 0 };
}
