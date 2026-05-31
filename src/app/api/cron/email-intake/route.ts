import { NextRequest, NextResponse } from "next/server";
import { pollEmailIntake, DEFAULT_THREADS_PER_RUN } from "@/lib/email-intake-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/cron/email-intake — scheduled poll handler.
// Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>` (also
// supports our existing `?secret=` query-string convention so the route
// is debuggable from a browser).
//
// Real-time intake also runs via email-intake-bootstrap (webhook +
// socket → classify within seconds). This poll is the safety net for
// missed events and backlog drain.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    const querySecret = url.searchParams.get("secret");
    const ok = auth === `Bearer ${secret}` || querySecret === secret;
    if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

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
