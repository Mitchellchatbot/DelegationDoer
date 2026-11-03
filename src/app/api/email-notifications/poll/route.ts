import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { pollEmailNotifications } from "@/lib/email-notifications-poller";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/email-notifications/poll — the home card's "Poll now" button.
//
// It used to fetch /api/cron/email-notifications straight from the browser.
// That only worked because the cron gate failed open when CRON_SECRET was
// unset; with the gate now fail-closed (src/lib/cron-auth.ts) the button gets
// its own session-gated route that runs the same poller.
//
// Any signed-in user can press it, so:
//   - a per-process throttle stops it becoming a load generator against the
//     clone (the in-process safety-net loop keeps its own cadence regardless);
//   - the "busy" flag expires, so one hung upstream call can't wedge the
//     button until the next restart;
//   - the response carries counts only — the poller's per-account errors
//     name every scanned mailbox and the clone's error strings.

const MIN_INTERVAL_MS = 60_000;
const BUSY_TIMEOUT_MS = 5 * 60_000;
let lastRunAt = 0;
let runningSince: number | null = null;

export async function POST() {
  try {
    await requireCurrentUserId();
  } catch {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const now = Date.now();
  const busy = runningSince !== null && now - runningSince < BUSY_TIMEOUT_MS;
  if (busy || now - lastRunAt < MIN_INTERVAL_MS) {
    return NextResponse.json({ ok: true, skipped: "throttled" });
  }

  runningSince = now;
  lastRunAt = now;
  try {
    const result = await pollEmailNotifications();
    if (result.errors.length > 0) {
      console.warn("[email-notif-poll] manual poll errors", result.errors);
    }
    return NextResponse.json({
      ok: true,
      accountsScanned: result.accountsScanned,
      rowsWritten: result.rowsWritten,
      errorCount: result.errors.length
    });
  } catch (err) {
    console.error("[email-notif-poll] manual poll failed", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "poll failed" }, { status: 500 });
  } finally {
    runningSince = null;
  }
}
