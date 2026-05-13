import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

interface HandoffRow {
  task_id: string;
  from_user_id: string | null;
  to_user_id: string | null;
  stage: string | null;
  held_minutes: number | null;
  created_at: string;
}

interface UserRow {
  id: string;
  name: string;
  avatar_url: string | null;
  role: string;
}

interface TaskRow {
  id: string;
  title: string;
  assignee_id: string | null;
  estimated_hours: number;
  actual_hours: number;
  status: string;
  last_activity_at: string;
}

// GET /api/analytics/bottlenecks — aggregates that drive the bottleneck
// charts on the Leader Console. Computed in-handler rather than in SQL views
// so we can iterate on the shape without a migration each time. At our
// scale (low thousands of handoffs / tasks) this is fine in JS.
export async function GET() {
  const supabase = getSupabaseAdmin();

  const [handoffsRes, usersRes, tasksRes] = await Promise.all([
    supabase
      .from("task_handoffs")
      .select("task_id, from_user_id, to_user_id, stage, held_minutes, created_at"),
    supabase.from("users").select("id, name, avatar_url, role"),
    supabase
      .from("tasks")
      .select("id, title, assignee_id, estimated_hours, actual_hours, status, last_activity_at")
  ]);

  if (handoffsRes.error) return NextResponse.json({ error: handoffsRes.error.message }, { status: 500 });
  if (usersRes.error) return NextResponse.json({ error: usersRes.error.message }, { status: 500 });
  if (tasksRes.error) return NextResponse.json({ error: tasksRes.error.message }, { status: 500 });

  const handoffs = (handoffsRes.data ?? []) as HandoffRow[];
  const usersById = new Map<string, UserRow>(
    (usersRes.data ?? []).map((u) => [u.id as string, u as UserRow])
  );
  const tasks = (tasksRes.data ?? []) as TaskRow[];

  // 1. Per-user hold time: sum of held_minutes from handoffs where they
  //    were the OUTGOING (from_user_id) party — i.e. how long they held
  //    tasks before passing them on.
  const perUser = new Map<string, {
    userId: string;
    name: string;
    avatarUrl: string | null;
    handoffCount: number;
    totalHeldMinutes: number;
    avgHeldMinutes: number;
  }>();

  for (const h of handoffs) {
    if (!h.from_user_id || h.held_minutes == null) continue;
    const u = usersById.get(h.from_user_id);
    if (!u) continue;
    const prev = perUser.get(h.from_user_id) ?? {
      userId: h.from_user_id,
      name: u.name,
      avatarUrl: u.avatar_url,
      handoffCount: 0,
      totalHeldMinutes: 0,
      avgHeldMinutes: 0
    };
    prev.handoffCount += 1;
    prev.totalHeldMinutes += h.held_minutes;
    perUser.set(h.from_user_id, prev);
  }
  for (const v of perUser.values()) {
    v.avgHeldMinutes = v.handoffCount > 0
      ? Math.round(v.totalHeldMinutes / v.handoffCount)
      : 0;
  }
  const perUserArr = Array.from(perUser.values()).sort(
    (a, b) => b.avgHeldMinutes - a.avgHeldMinutes
  );

  // 2. Per-user estimate vs actual on completed tasks. Surfaces who's
  //    consistently over/under their own estimate.
  const estVsActual = new Map<string, {
    userId: string;
    name: string;
    avatarUrl: string | null;
    completed: number;
    estimateHours: number;
    actualHours: number;
    ratio: number;
  }>();
  for (const t of tasks) {
    if (t.status !== "done" || !t.assignee_id) continue;
    const u = usersById.get(t.assignee_id);
    if (!u) continue;
    const prev = estVsActual.get(t.assignee_id) ?? {
      userId: t.assignee_id,
      name: u.name,
      avatarUrl: u.avatar_url,
      completed: 0,
      estimateHours: 0,
      actualHours: 0,
      ratio: 0
    };
    prev.completed += 1;
    prev.estimateHours += Number(t.estimated_hours ?? 0);
    prev.actualHours += Number(t.actual_hours ?? 0);
    estVsActual.set(t.assignee_id, prev);
  }
  for (const v of estVsActual.values()) {
    v.ratio = v.estimateHours > 0 ? +(v.actualHours / v.estimateHours).toFixed(2) : 0;
  }
  const estVsActualArr = Array.from(estVsActual.values()).sort(
    (a, b) => b.actualHours - a.actualHours
  );

  // 3. Per-stage average hold. Reveals which kind of work always takes
  //    longer than expected.
  const perStage = new Map<string, { stage: string; count: number; totalMinutes: number; avgMinutes: number }>();
  for (const h of handoffs) {
    const stage = h.stage?.trim();
    if (!stage || h.held_minutes == null) continue;
    const prev = perStage.get(stage) ?? { stage, count: 0, totalMinutes: 0, avgMinutes: 0 };
    prev.count += 1;
    prev.totalMinutes += h.held_minutes;
    perStage.set(stage, prev);
  }
  for (const v of perStage.values()) {
    v.avgMinutes = v.count > 0 ? Math.round(v.totalMinutes / v.count) : 0;
  }
  const perStageArr = Array.from(perStage.values()).sort(
    (a, b) => b.avgMinutes - a.avgMinutes
  );

  // 4. Slowest tasks: total cumulative hold time across all handoffs. Helps
  //    the Leader drill into the few tasks that bled the most clock.
  const taskHoldTotals = new Map<string, number>();
  for (const h of handoffs) {
    if (h.held_minutes == null) continue;
    taskHoldTotals.set(h.task_id, (taskHoldTotals.get(h.task_id) ?? 0) + h.held_minutes);
  }
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const slowestTasks = Array.from(taskHoldTotals.entries())
    .map(([taskId, total]) => {
      const t = tasksById.get(taskId);
      return t
        ? {
            taskId,
            title: t.title,
            totalMinutes: total,
            handoffCount: handoffs.filter((h) => h.task_id === taskId).length,
            status: t.status
          }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.totalMinutes - a.totalMinutes)
    .slice(0, 8);

  // 5. Completions per user (last 7d + all-time). Independent of handoffs
  //    so a freshly-completed task surfaces immediately, even if it was
  //    never reassigned.
  const weekAgo = Date.now() - 7 * 86_400_000;
  const completionsByUser = new Map<string, {
    userId: string;
    name: string;
    avatarUrl: string | null;
    weekCount: number;
    totalCount: number;
  }>();
  for (const t of tasks) {
    if (t.status !== "done" || !t.assignee_id) continue;
    const u = usersById.get(t.assignee_id);
    if (!u) continue;
    const prev = completionsByUser.get(t.assignee_id) ?? {
      userId: t.assignee_id,
      name: u.name,
      avatarUrl: u.avatar_url,
      weekCount: 0,
      totalCount: 0
    };
    prev.totalCount += 1;
    if (t.last_activity_at && new Date(t.last_activity_at).getTime() >= weekAgo) {
      prev.weekCount += 1;
    }
    completionsByUser.set(t.assignee_id, prev);
  }
  const completionsByUserArr = Array.from(completionsByUser.values()).sort(
    (a, b) => b.weekCount - a.weekCount || b.totalCount - a.totalCount
  );

  // 6. Recently completed: latest 8 done tasks for the "you just shipped
  //    this!" reassurance feed.
  const recentCompletions = tasks
    .filter((t) => t.status === "done" && t.assignee_id)
    .sort((a, b) => +new Date(b.last_activity_at) - +new Date(a.last_activity_at))
    .slice(0, 8)
    .map((t) => {
      const u = t.assignee_id ? usersById.get(t.assignee_id) : null;
      return {
        taskId: t.id,
        title: t.title,
        completedAt: t.last_activity_at,
        assigneeId: t.assignee_id,
        assigneeName: u?.name ?? null,
        assigneeAvatarUrl: u?.avatar_url ?? null,
        estimateHours: Number(t.estimated_hours ?? 0)
      };
    });

  // 7. Completions per day for the last 30 days. We pre-seed every date so
  //    the chart's x-axis stays continuous even when a day has zero
  //    completions (otherwise recharts compresses the line).
  const DAY_MS = 86_400_000;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const completionsByDayMap = new Map<string, number>();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(todayStart.getTime() - i * DAY_MS);
    completionsByDayMap.set(toISODate(d), 0);
  }
  for (const t of tasks) {
    if (t.status !== "done" || !t.last_activity_at) continue;
    const key = toISODate(new Date(t.last_activity_at));
    if (completionsByDayMap.has(key)) {
      completionsByDayMap.set(key, (completionsByDayMap.get(key) ?? 0) + 1);
    }
  }
  const completionsByDay = Array.from(completionsByDayMap.entries()).map(
    ([date, count]) => ({ date, label: date.slice(5), count })
  );

  // 8. Status distribution across all currently-open tasks. Donut chart on
  //    the analytics page reads from this — "where's the team's work right
  //    now?" at a glance.
  const statusCounts = new Map<string, number>();
  for (const t of tasks) {
    if (t.status === "done") continue;
    statusCounts.set(t.status, (statusCounts.get(t.status) ?? 0) + 1);
  }
  const statusDistribution = Array.from(statusCounts.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  return NextResponse.json({
    perUser: perUserArr,
    estVsActual: estVsActualArr,
    perStage: perStageArr,
    slowestTasks,
    completionsByUser: completionsByUserArr,
    recentCompletions,
    completionsByDay,
    statusDistribution,
    totalCompletedThisWeek: completionsByUserArr.reduce((s, u) => s + u.weekCount, 0),
    totalCompletedAllTime: completionsByUserArr.reduce((s, u) => s + u.totalCount, 0)
  });
}

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
