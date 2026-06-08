import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { sodSignalFor } from "@/lib/shift";
import { pickMotivationalLine } from "@/lib/sod-motivational";
import { isLeader } from "@/lib/access";

export const dynamic = "force-dynamic";

// GET /api/sod/today
//   Query: ?simulate=1  — force eligibility (testing / Simulate button)
//
// Returns the cheap "should we pop the SOD welcome modal right now?"
// signal. The layout wrapper polls this on mount so every protected
// route can gate-render the modal without each page wiring it up.
//
// Shape:
//   { eligible, alreadySubmitted, shiftDate, shiftStart, shiftEnd,
//     departmentKey, motivationalLine, userName, reason }
//
// eligible is true when:
//   - the user is within their shift window (or simulate=1), AND
//   - they have NOT already submitted SOD for today's shift date, AND
//   - they are NOT exempt from the daily ritual.
//
// Two exemptions suppress the *mandatory* auto-pop modal (simulate=1
// still forces the flow so an exempt user can file voluntarily / test):
//   - Leaders + stealth admins — same role exemption ClockGate and the
//     /home bookend apply; managers don't run a personal SOD/EOD.
//   - Per-user opt-out (users.daily_prompts_enabled = false).
export async function GET(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) {
      return NextResponse.json({ eligible: false, reason: "no user" }, { status: 401 });
    }

    const simulate = new URL(req.url).searchParams.get("simulate") === "1";
    const signal = sodSignalFor(me);
    const withinShift = "withinShift" in signal ? signal.withinShift : false;
    const shiftDate =
      "shiftDate" in signal ? signal.shiftDate : new Date().toISOString().slice(0, 10);

    // SEO + Website get the personalised dashboard between welcome and
    // form. Everyone else jumps welcome → form.
    const deps = me.departmentIds ?? [];
    const departmentKey: "dep_seo" | "dep_web" | null =
      deps.includes("dep_seo") ? "dep_seo"
      : deps.includes("dep_web") ? "dep_web"
      : null;

    const supabase = getSupabaseAdmin();
    let alreadySubmitted = false;
    try {
      const { data } = await supabase
        .from("sod_notes")
        .select("submitted_at")
        .eq("user_id", userId)
        .eq("note_date", shiftDate)
        .maybeSingle();
      alreadySubmitted = !!(data?.submitted_at);
    } catch {
      /* table missing — treat as not submitted so modal still shows */
    }

    // Who is exempt from the mandatory SOD modal:
    //   - Leaders + stealth admins never run the daily ritual (same
    //     exemption ClockGate and the /home bookend apply — managers
    //     aren't on a personal clock / check-in).
    //   - Anyone with the per-user daily_prompts_enabled flag flipped off.
    // An explicit simulate=1 still opens the flow so an exempt user can
    // file voluntarily / test; only the *auto-pop* is suppressed.
    const leaderExempt = isLeader(me);
    const promptsOff = me.dailyPromptsEnabled === false;
    const ritualExempt = leaderExempt || promptsOff;
    const eligible = !alreadySubmitted && (simulate || (withinShift && !ritualExempt));
    const reason = leaderExempt ? "leader/admin — SOD exempt"
      : promptsOff ? "daily prompts disabled (SOD exempt)"
      : signal.reason;

    return NextResponse.json({
      eligible,
      alreadySubmitted,
      shiftDate,
      shiftStart: "shiftStart" in signal ? signal.shiftStart : null,
      shiftEnd: "shiftEnd" in signal ? signal.shiftEnd : null,
      departmentKey,
      motivationalLine: pickMotivationalLine(`${userId}:${shiftDate}`),
      userName: me.name,
      reason
    });
  } catch (err) {
    return NextResponse.json(
      { eligible: false, error: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}
