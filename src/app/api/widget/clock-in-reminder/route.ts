import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { requiresClockIn } from "@/lib/access";
import { hasOpenSegment } from "@/lib/time-tracking";
import { sodSignalFor } from "@/lib/shift";

export const dynamic = "force-dynamic";

// GET /api/widget/clock-in-reminder
//   Returns { due: boolean, shiftDate?: string, reason?: string }.
//
//   Fires "due: true" when the worker:
//     - has clock_enabled = true (i.e. requiresClockIn per src/lib/access.ts;
//       salaried/leader accounts skip)
//     - is currently inside their configured shift window (weeklySchedule +
//       workTimezone, resolved via sodSignalFor which SOD already uses)
//     - has no open time_entries segment right now (either never clocked in
//       today, or clocked out and forgot to resume)
//
//   The widget polls this every 15s alongside eod-reminder + sod/today; when
//   `due` flips true and hasn't been fired yet this shift, the widget sends
//   an OS-level notification with a deep link back to /home.

export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) {
      return NextResponse.json({ due: false, reason: "no user" });
    }

    // Skip anyone whose profile isn't in the "must clock in" cohort —
    // leaders, stealth admins, and clock-disabled accounts (the Clock
    // switch in Leader Console → People tab flips this).
    if (!requiresClockIn(me)) {
      return NextResponse.json({ due: false, reason: "not required to clock in" });
    }

    // Reuse the SOD signal to decide whether we're inside the worker's
    // shift window. sodSignalFor returns "withinShift" only when
    // schedule + timezone say the current wall-clock is between start
    // and end for today. Off-days / pre-shift / post-shift → false → no
    // reminder.
    const signal = sodSignalFor(me);
    const withinShift = "withinShift" in signal ? signal.withinShift : false;
    if (!withinShift) {
      return NextResponse.json({
        due: false,
        reason: "reason" in signal ? signal.reason : "outside shift"
      });
    }

    // Currently clocked in? Then nothing to remind about.
    if (await hasOpenSegment(userId)) {
      return NextResponse.json({
        due: false,
        reason: "already clocked in",
        shiftDate: "shiftDate" in signal ? signal.shiftDate : undefined
      });
    }

    return NextResponse.json({
      due: true,
      shiftDate: "shiftDate" in signal ? signal.shiftDate : undefined
    });
  } catch (err) {
    return NextResponse.json(
      { due: false, error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
