import { NextRequest, NextResponse } from "next/server";
import { pollEmailIntake, DEFAULT_THREADS_PER_RUN } from "@/lib/email-intake-runner";
import { cronAuthError } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/cron/email-intake — scheduled poll handler.
// Auth: `Authorization: Bearer <CRON_SECRET>` only; 503 when CRON_SECRET is
// unset (fail closed) — see src/lib/cron-auth.ts.
//
// Real-time intake also runs via email-intake-bootstrap (webhook +
// socket → classify within seconds). This poll is the safety net for
// missed events and backlog drain.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const denied = cronAuthError(req);
  if (denied) return denied;

  const silent = url.searchParams.get("silent") === "true";
  const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);
  const threadsPerRun =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, DEFAULT_THREADS_PER_RUN * 4)
      : DEFAULT_THREADS_PER_RUN;

  try {
    const result = await pollEmailIntake({ threadsPerRun, silent });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
