import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

interface UserRow { id: string; name: string; avatar_url: string | null; role: string; }
interface TaskRow {
  id: string;
  assignee_id: string | null;
  status: string;
  estimated_hours: number;
  actual_hours: number;
  last_activity_at: string;
  created_at: string;
}
interface KudosRow { to_user_id: string; }
interface HandoffRow { from_user_id: string | null; held_minutes: number | null; }
interface TimeRow { user_id: string; started_at: string; ended_at: string | null; }

// GET /api/performance — per-user leaderboard for the current month.
//
// Metrics:
//   completedThisMonth — count of tasks marked done in the month
//   completedAllTime   — lifetime count
//   estimateHours      — total estimate sum (done tasks, this month)
//   actualHours        — total actual sum (done tasks, this month)
//   accuracy           — actual / estimate (1.0 = perfect; <1 ahead; >1 over)
//   kudosReceived      — kudos received this month (still useful even when acked)
//   avgHoldMinutes     — avg hold time per handoff (across all-time)
//   shiftHoursThisMonth — sum of clocked-in time this month
//   compositeScore     — single rank-friendly number combining the above
//
// All in one endpoint so the frontend renders a single sortable table.
export async function GET() {
  await requireCurrentUserId();
  const supabase = getSupabaseAdmin();

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  const [usersRes, tasksRes, kudosRes, handoffRes, timeRes] = await Promise.all([
    supabase.from("users").select("id, name, avatar_url, role"),
    supabase
      .from("tasks")
      .select("id, assignee_id, status, estimated_hours, actual_hours, last_activity_at, created_at"),
    supabase.from("kudos").select("to_user_id, created_at").gte("created_at", monthStart),
    supabase.from("task_handoffs").select("from_user_id, held_minutes"),
    supabase.from("time_entries").select("user_id, started_at, ended_at").gte("started_at", monthStart)
  ]);
  if (usersRes.error) return NextResponse.json({ error: usersRes.error.message }, { status: 500 });
  if (tasksRes.error) return NextResponse.json({ error: tasksRes.error.message }, { status: 500 });

  const users = (usersRes.data ?? []) as UserRow[];
  const tasks = (tasksRes.data ?? []) as TaskRow[];
  // Optional sources — may not be populated if migrations are partial.
  const kudos = ((kudosRes.error ? [] : kudosRes.data) ?? []) as KudosRow[];
  const handoffs = ((handoffRes.error ? [] : handoffRes.data) ?? []) as HandoffRow[];
  const times = ((timeRes.error ? [] : timeRes.data) ?? []) as TimeRow[];

  const monthStartMs = new Date(monthStart).getTime();

  const rows = users.map((u) => {
    const myTasks = tasks.filter((t) => t.assignee_id === u.id);
    const doneThisMonth = myTasks.filter(
      (t) => t.status === "done" && new Date(t.last_activity_at).getTime() >= monthStartMs
    );
    const doneAllTime = myTasks.filter((t) => t.status === "done");
    const estHours = doneThisMonth.reduce((s, t) => s + Number(t.estimated_hours ?? 0), 0);
    const actHours = doneThisMonth.reduce((s, t) => s + Number(t.actual_hours ?? 0), 0);
    const accuracy = estHours > 0 && actHours > 0 ? +(actHours / estHours).toFixed(2) : null;

    const kudosReceived = kudos.filter((k) => k.to_user_id === u.id).length;

    const myHandoffs = handoffs.filter((h) => h.from_user_id === u.id && h.held_minutes != null);
    const totalHold = myHandoffs.reduce((s, h) => s + Number(h.held_minutes ?? 0), 0);
    const avgHoldMinutes = myHandoffs.length > 0 ? Math.round(totalHold / myHandoffs.length) : null;

    // Sum the clocked-in segments this month. Open shifts add elapsed up
    // to "now" so the leaderboard reflects in-flight work.
    const shiftMs = times
      .filter((t) => t.user_id === u.id)
      .reduce((s, t) => {
        const start = Math.max(monthStartMs, new Date(t.started_at).getTime());
        const end = t.ended_at ? new Date(t.ended_at).getTime() : Date.now();
        return s + Math.max(0, end - start);
      }, 0);
    const shiftHoursThisMonth = +(shiftMs / 3_600_000).toFixed(1);

    // Composite: rough "performance" score for ranking + crown nomination.
    //   completions * 5 + kudos * 3 + (1 - |1-accuracy|) * 4 - holdMins penalty
    // Tuned so a 5x-completer with avg accuracy beats a 1x-completer with
    // perfect accuracy. Negative rates capped at 0.
    const accuracyBonus = accuracy != null
      ? Math.max(0, (1 - Math.min(1, Math.abs(1 - accuracy))) * 4)
      : 0;
    const holdPenalty = avgHoldMinutes != null ? Math.min(3, avgHoldMinutes / 600) : 0;
    const compositeScore = +(
      doneThisMonth.length * 5 +
      kudosReceived * 3 +
      accuracyBonus -
      holdPenalty
    ).toFixed(2);

    return {
      userId: u.id,
      name: u.name,
      avatarUrl: u.avatar_url,
      role: u.role,
      completedThisMonth: doneThisMonth.length,
      completedAllTime: doneAllTime.length,
      estimateHours: +estHours.toFixed(1),
      actualHours: +actHours.toFixed(1),
      accuracy,
      kudosReceived,
      avgHoldMinutes,
      shiftHoursThisMonth,
      compositeScore
    };
  });

  rows.sort((a, b) => b.compositeScore - a.compositeScore);
  return NextResponse.json({ leaderboard: rows });
}
