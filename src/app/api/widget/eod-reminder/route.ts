import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getUserById } from "@/lib/server-data";

export const dynamic = "force-dynamic";

// GET /api/widget/eod-reminder
//   Returns { due: boolean, scheduleEnd?: "HH:MM", reason?: string }.
//
//   Fires "due: true" when the worker:
//     - is on the Website team (dep_web) OR is a leader OR is isAdmin
//     - has a weeklySchedule with an end time defined for today
//     - the current time (in their workTimezone) is past that end time
//     - hasn't filed any eod_client_checkins rows for today yet
//
//   The widget polls this every 15s; when due=true it surfaces a
//   persistent banner reminding them to file before clocking out.

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function nowInTz(tz: string): { hh: number; mm: number; dayKey: typeof DAY_KEYS[number]; ymd: string } {
  // Intl.DateTimeFormat is the only reliable way to get a wall-clock
  // value in an arbitrary IANA zone from a Node server (which runs UTC
  // or whatever Railway gives us). Parsing the parts back is cheap.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  const weekday = (parts.weekday ?? "Mon").toLowerCase().slice(0, 3) as typeof DAY_KEYS[number];
  const hh = parseInt(parts.hour ?? "0", 10);
  const mm = parseInt(parts.minute ?? "0", 10);
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  return { hh, mm, dayKey: weekday, ymd };
}

function parseHHMM(value: string | undefined | null): { hh: number; mm: number } | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return { hh, mm };
}

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
    const end = parseHHMM(todaysSchedule.end);
    if (!end) {
      return NextResponse.json({ due: false, reason: "no end time" });
    }

    const nowMinutes = hh * 60 + mm;
    const endMinutes = end.hh * 60 + end.mm;
    if (nowMinutes < endMinutes) {
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
