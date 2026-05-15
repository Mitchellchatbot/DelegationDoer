import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { closeOpenSegment, openSegment } from "@/lib/time-tracking";
import { dayKeyInTz, hoursForDay } from "@/lib/work-hours";

export const dynamic = "force-dynamic";

// GET /api/clock — returns the current user's open segment (if any) plus
// totals for today. The open segment may have a `taskId` attached — that's
// how the widget knows which task is being timed right now.
export async function GET() {
  const userId = await requireCurrentUserId();
  const supabase = getSupabaseAdmin();

  const [{ data: open }, { data: me }] = await Promise.all([
    supabase
      .from("time_entries")
      .select("id, started_at, task_id")
      .eq("user_id", userId)
      .is("ended_at", null)
      .maybeSingle(),
    supabase
      .from("users")
      .select("daily_capacity, work_timezone, weekly_schedule")
      .eq("id", userId)
      .maybeSingle()
  ]);
  // Schedule-aware "today" budget: 0 on off days, short on short days.
  // Falls back to the flat daily_capacity column on weekdays when no
  // per-day schedule has been set.
  const flatDaily = Number(me?.daily_capacity ?? 8);
  const dayKey = dayKeyInTz(new Date(), (me?.work_timezone as string | null) ?? null);
  const dailyCapacity = hoursForDay({
    dayKey,
    dailyCapacity: flatDaily,
    weeklySchedule:
      (me?.weekly_schedule as Record<string, { start: string; end: string } | null> | null) ?? {}
  });

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const { data: closed } = await supabase
    .from("time_entries")
    .select("started_at, ended_at, task_id")
    .eq("user_id", userId)
    .gte("started_at", startOfDay.toISOString())
    .not("ended_at", "is", null);

  let todayMs = 0;
  const hoursByTask = new Map<string, number>();
  for (const r of closed ?? []) {
    if (!r.started_at || !r.ended_at) continue;
    const dur = new Date(r.ended_at).getTime() - new Date(r.started_at).getTime();
    if (dur <= 0) continue;
    todayMs += dur;
    if (r.task_id) {
      hoursByTask.set(r.task_id, (hoursByTask.get(r.task_id) ?? 0) + dur / 3_600_000);
    }
  }
  if (open?.started_at) {
    const liveMs = Date.now() - new Date(open.started_at).getTime();
    todayMs += liveMs;
    if (open.task_id) {
      hoursByTask.set(
        open.task_id,
        (hoursByTask.get(open.task_id) ?? 0) + liveMs / 3_600_000
      );
    }
  }

  const todayHours = todayMs / 3_600_000;
  const workdayRemainingMs = Math.max(0, dailyCapacity * 3_600_000 - todayMs);
  return NextResponse.json({
    open: open
      ? {
          id: open.id,
          startedAt: open.started_at,
          taskId: (open.task_id as string | null) ?? null
        }
      : null,
    todayMs,
    todayHours: +todayHours.toFixed(2),
    dailyCapacityHours: dailyCapacity,
    workdayRemainingMs,
    workdayRemainingHours: +(workdayRemainingMs / 3_600_000).toFixed(2),
    hoursByTask: Object.fromEntries(hoursByTask)
  });
}

// POST /api/clock — body: { action: "in" | "out", note?: string }.
// "in" creates a new open generic segment if none exists. "out" closes
// whatever's open (task segment or generic) and refreshes the task's
// actuals if appropriate. Both idempotent.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json();
    const action = body.action === "out" ? "out" : "in";
    const note = typeof body.note === "string" ? body.note.trim() || null : null;
    const supabase = getSupabaseAdmin();

    if (action === "in") {
      const { data: existing } = await supabase
        .from("time_entries")
        .select("id, started_at, task_id")
        .eq("user_id", userId)
        .is("ended_at", null)
        .maybeSingle();
      if (existing) {
        return NextResponse.json({
          ok: true,
          open: {
            id: existing.id,
            startedAt: existing.started_at,
            taskId: (existing.task_id as string | null) ?? null
          },
          newlyStarted: false
        });
      }
      const seg = await openSegment(userId, null, note);
      await supabase
        .from("users")
        .update({ presence: "available", presence_updated_at: new Date().toISOString() })
        .eq("id", userId);
      return NextResponse.json({
        ok: true,
        open: { id: seg.id, startedAt: seg.startedAt, taskId: null },
        newlyStarted: true
      });
    }

    // action === "out"
    const closed = await closeOpenSegment(userId);
    if (!closed) {
      return NextResponse.json({ ok: true, open: null, newlyEnded: false });
    }
    if (note) {
      await supabase.from("time_entries").update({ note }).eq("id", closed.id);
    }
    await supabase
      .from("users")
      .update({ presence: "away", presence_updated_at: new Date().toISOString() })
      .eq("id", userId);
    const elapsedMs =
      new Date(closed.endedAt).getTime() - new Date(closed.startedAt).getTime();
    return NextResponse.json({
      ok: true,
      open: null,
      newlyEnded: true,
      elapsedMs,
      closedTaskId: closed.taskId
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
