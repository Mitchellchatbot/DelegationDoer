// Shared runner for the inactivity sweep so the /api/cron/inactivity route
// AND the in-process scheduler (cron-bootstrap) drive the exact same logic —
// the same split task-archive-runner / email-intake-runner use.
//
// Idempotent: the `inactive_flag = false` filter means already-flagged rows
// are never touched again, so a duplicate run (overlapping interval, restart,
// or a Vercel cron firing alongside the in-process loop) flips nothing twice.
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { TEAM_TAG } from "@/lib/task-team";
import { postMessage } from "@/lib/slack";

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
    .select("id, title, assignee_id, department_id, tags");

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Array<{
    id: string;
    title: string | null;
    assignee_id: string | null;
    department_id: string | null;
    tags: string[] | null;
  }>;

  // Nudge the department when unclaimed TEAM work goes quiet. Every other
  // task that trips this sweep has an assignee who can see the stalled badge
  // on their own list; a task sitting in the pool has nobody, which is
  // exactly how it rots. The channel is the only audience it has.
  //
  // Best-effort throughout: this is a cron, and a Slack outage or an
  // unconfigured task_channel_id must never fail the sweep.
  try {
    const stalledTeamTasks = rows.filter(
      (r) => !r.assignee_id && r.department_id && (r.tags ?? []).includes(TEAM_TAG)
    );
    if (stalledTeamTasks.length > 0) {
      const byDept = new Map<string, typeof stalledTeamTasks>();
      for (const t of stalledTeamTasks) {
        const arr = byDept.get(t.department_id!) ?? [];
        arr.push(t);
        byDept.set(t.department_id!, arr);
      }
      const { data: depts } = await supabase
        .from("departments")
        .select("id, name, task_channel_id")
        .in("id", Array.from(byDept.keys()));
      const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
      for (const d of (depts ?? []) as Array<{ id: string; name: string; task_channel_id: string | null }>) {
        if (!d.task_channel_id) continue;
        const items = byDept.get(d.id) ?? [];
        const lines = items
          .map((t) => `• <${baseUrl ? `${baseUrl}/tasks/${t.id}` : `/tasks/${t.id}`}|${t.title ?? "Untitled task"}>`)
          .join("\n");
        const headline = `⏳ ${items.length} unclaimed ${d.name} ${items.length === 1 ? "task has" : "tasks have"} gone quiet for 48h`;
        await postMessage(d.task_channel_id, headline, [
          { type: "section", text: { type: "mrkdwn", text: `*${headline}*\n${lines}` } }
        ]);
      }
    }
  } catch (err) {
    console.error("[inactivity] team-pool nudge failed:", err);
  }

  return { flagged: rows.length };
}
