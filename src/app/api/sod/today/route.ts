import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { sodSignalFor } from "@/lib/shift";
import { pickMotivationalLine } from "@/lib/sod-motivational";

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
//   - they are NOT exempt from the daily ritual (users.daily_prompts_enabled).
//
// The exemption (same per-user flag the /home bookend + EOD nudge honour)
// suppresses the *mandatory* welcome/priority modal so opted-out users —
// leaders who don't run the ritual — get the app directly. simulate=1
// still forces the flow so they can file voluntarily / test if they want.
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

    // Per-user opt-out (users.daily_prompts_enabled, default true). When
    // off, the mandatory modal is suppressed — but an explicit simulate=1
    // still opens the flow so exempt users aren't locked out of filing.
    const promptsEnabled = me.dailyPromptsEnabled !== false;
    const eligible = !alreadySubmitted && (simulate || (withinShift && promptsEnabled));
    const reason = !promptsEnabled ? "daily prompts disabled (SOD exempt)" : signal.reason;

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
