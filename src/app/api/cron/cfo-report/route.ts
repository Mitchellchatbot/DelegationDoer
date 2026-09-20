import { NextRequest, NextResponse } from "next/server";
import { runCfoReport } from "@/lib/cfo-report-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/cron/cfo-report
//   The morning CFO report DM (mirrors /api/cron/daily-briefing). On Vercel the
//   vercel.json schedule hits this; on Railway the in-process loop in
//   cron-bootstrap.ts calls runCfoReport() directly. Both funnel through the same
//   idempotent runner, so double-firing is safe.
//
//   Query params for manual testing:
//     ?dryRun=1  render + return the report without storing or DMing
//     ?force=1   bypass the 7am-NY-hour guard and same-day dedupe
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const dryRun = searchParams.get("dryRun") === "1" || searchParams.get("dryRun") === "true";
  const force = searchParams.get("force") === "1" || searchParams.get("force") === "true";
  const out = await runCfoReport({ dryRun, force });
  return NextResponse.json(out);
}
