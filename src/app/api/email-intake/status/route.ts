import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getIntakeHeartbeat } from "@/lib/email-intake-bootstrap";

export const dynamic = "force-dynamic";

// GET /api/email-intake/status
//   Visibility into the in-process email-intake scheduler so you can tell,
//   at a glance, whether routing is alive — instead of guessing where the
//   cron runs.
//
//   Returns:
//     - scheduler: the in-memory heartbeat for THIS server process
//       (schedulerActive, last poll time/result, realtime listener state)
//     - watermark: cross-process truth from the DB — how many accounts have
//       auto-intake on and the newest last_polled_at across them
//
//   Any authenticated user can read it. (Session-gated by middleware; the
//   explicit check mirrors the other /api/email-intake/* routes.)
export async function GET() {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

    const supabase = getSupabaseAdmin();
    const { data: settings, error } = await supabase
      .from("missive_account_settings")
      .select("account_id, last_polled_at")
      .eq("auto_intake_enabled", true);
    if (error) throw new Error(error.message);

    const enabled = settings ?? [];
    const lastPolledAt = enabled
      .map((s) => s.last_polled_at)
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .sort()
      .at(-1) ?? null;

    const scheduler = getIntakeHeartbeat();
    const now = new Date();
    const staleMs = scheduler.lastPollFinishedAt
      ? now.getTime() - new Date(scheduler.lastPollFinishedAt).getTime()
      : null;
    // Healthy = the scheduler is active and has polled within the last ~12 min
    // (two missed 5-min cycles of slack). Boot grace: a process that just
    // started but hasn't run its first poll yet is not "unhealthy".
    const healthy =
      scheduler.schedulerActive &&
      (staleMs === null ? scheduler.pollCount === 0 : staleMs < 12 * 60 * 1_000);

    return NextResponse.json({
      ok: true,
      healthy,
      now: now.toISOString(),
      scheduler,
      watermark: {
        enabledAccounts: enabled.length,
        lastPolledAt
      }
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
