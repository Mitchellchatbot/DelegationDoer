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
// The poller scans every opted-in account, so a per-process throttle keeps a
// held-down button (or any signed-in user) from turning it into a load
// generator. The in-process safety-net loop keeps running regardless.

const MIN_INTERVAL_MS = 30_000;
let lastRunAt = 0;
let running = false;

export async function POST() {
  try {
    await requireCurrentUserId();
  } catch {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const now = Date.now();
  if (running || now - lastRunAt < MIN_INTERVAL_MS) {
    return NextResponse.json({ ok: true, skipped: "throttled" });
  }

  running = true;
  lastRunAt = now;
  try {
    const result = await pollEmailNotifications();
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[email-notif-poll] manual poll failed", message);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    running = false;
  }
}
