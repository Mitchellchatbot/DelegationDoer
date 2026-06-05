import { NextResponse } from "next/server";
import { runInactivitySweep } from "@/lib/inactivity-runner";

// Hourly cron — flags any open task with no activity in 48h. The work lives in
// inactivity-runner so the in-process scheduler (cron-bootstrap) can run the
// same sweep on Railway, where vercel.json crons never fire.
export async function GET() {
  try {
    const r = await runInactivitySweep();
    return NextResponse.json({ ok: true, flagged: r.flagged });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
