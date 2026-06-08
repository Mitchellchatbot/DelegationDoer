import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getUserById } from "@/lib/server-data";
import { nowInTz, parseHHMM } from "@/lib/shift";

export const dynamic = "force-dynamic";

// GET /api/widget/eod-reminder
//   Returns { due: boolean, scheduleEnd?: "HH:MM", reason?: string }.
//
//   Fires "due: true" when the worker:
//     - is on the Website team (dep_web) OR is a leader OR is isAdmin
//     - has a weeklySchedule with an end time defined for today
//     - their shift for today has actually *ended* (in their workTimezone)
//       — overnight shifts count the evening + early hours as still-working
//     - hasn't filed any eod_client_checkins rows for today yet
//
//   The widget polls this every 15s; when due=true it surfaces a
//   persistent banner reminding them to file before clocking out.

export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) {
      return NextResponse.json({ due: false, reason: "no user" });
    }

    // Per-user opt-out (users.daily_prompts_enabled, default true). The
    // server-data User shape doesn't carry every column, so check direct
    // against the row. CEO-types who don't run the EOD-checkin ritual
    // themselves flip this off so the widget stops nagging.
    const supabaseAdmin = getSupabaseAdmin();
    const { data: flag } = await supabaseAdmin
      .from("users")
      .select("daily_prompts_enabled")
      .eq("id", userId)
      .maybeSingle();
    if (flag && flag.daily_prompts_enabled === false) {
      return NextResponse.json({ due: false, reason: "user opted out" });
    }

    const onWebsite = (me.departmentIds ?? []).includes("dep_web");
    const isLeader = me.role === "leader";
    const isAdmin = me.isAdmin === true;
    if (!onWebsite && !isLeader && !isAdmin) {
      return NextResponse.json({ due: false, reason: "not website team" });
    }

    const tz = me.workTimezone || "UTC";
    const { hh, mm, dayKey, ymd } = nowInTz(tz);

    const todaysSchedule = (me.weeklySchedule ?? {})[dayKey];
    if (!todaysSchedule) {
      return NextResponse.json({ due: false, reason: "day off" });
    }
    const start = parseHHMM(todaysSchedule.start);
    const end = parseHHMM(todaysSchedule.end);
    if (!end) {
      return NextResponse.json({ due: false, reason: "no end time" });
    }

    const nowMinutes = hh * 60 + mm;
    const startMinutes = start ? start.hh * 60 + start.mm : 0;
    const endMinutes = end.hh * 60 + end.mm;
    // Has the workday actually ended? For a normal shift that's any time
    // at/after the end. For an overnight shift (end ≤ start, e.g. 19:00 →
    // 03:00) the worker is still on through the evening AND the early
    // hours; only the daytime gap [end, start) is post-shift. Without this
    // an overnight worker got nagged the moment their shift began.
    const overnight = endMinutes <= startMinutes;
    const shiftOver = overnight
      ? nowMinutes >= endMinutes && nowMinutes < startMinutes
      : nowMinutes >= endMinutes;
    if (!shiftOver) {
      return NextResponse.json({ due: false, reason: "before end", scheduleEnd: todaysSchedule.end });
    }

    // Past end-of-workday. Have we filed any check-ins today (worker's
    // local date)? Tolerate the table not existing yet (migration
    // hasn't been applied) — treat as "no check-ins" so the reminder
    // still nags. supabaseAdmin already resolved at the top.
    try {
      const { count } = await supabaseAdmin
        .from("eod_client_checkins")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("note_date", ymd);
      if ((count ?? 0) > 0) {
        return NextResponse.json({ due: false, reason: "already filed", scheduleEnd: todaysSchedule.end });
      }
    } catch {
      /* table missing — fall through to due:true */
    }

    return NextResponse.json({
      due: true,
      scheduleEnd: todaysSchedule.end
    });
  } catch (err) {
    return NextResponse.json(
      { due: false, error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
