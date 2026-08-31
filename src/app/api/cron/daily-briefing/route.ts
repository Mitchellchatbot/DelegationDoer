import { NextRequest, NextResponse } from "next/server";
import { runDailyBriefing } from "@/lib/daily-briefing-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/cron/daily-briefing
//   The dual-path cron entry (mirrors /api/cron/eod-recap). On Vercel the
//   vercel.json schedule hits this; on Railway the in-process loop in
//   cron-bootstrap.ts calls runDailyBriefing() directly. Both funnel through
//   the same idempotent runner, so double-firing is safe.
//
//   Query params for manual testing:
//     ?dryRun=1  render + return the briefing without storing or DMing
//     ?force=1   bypass the 9am-NY-hour guard and same-day dedupe
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const dryRun = searchParams.get("dryRun") === "1" || searchParams.get("dryRun") === "true";
  const force = searchParams.get("force") === "1" || searchParams.get("force") === "true";
  const out = await runDailyBriefing({ dryRun, force });
  return NextResponse.json(out);
}
