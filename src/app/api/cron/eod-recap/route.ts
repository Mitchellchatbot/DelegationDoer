import { NextResponse } from "next/server";
import { runEodRecap } from "@/lib/eod-recap-runner";

// 7pm America/New_York (0:00 UTC) recap — Vercel cron fires this once a day.
// The work lives in eod-recap-runner so the in-process scheduler
// (cron-bootstrap) can run the same recap on Railway, where vercel.json crons
// never fire. The runner's NY-hour guard + same-day dedupe keep it idempotent.

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await runEodRecap());
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
