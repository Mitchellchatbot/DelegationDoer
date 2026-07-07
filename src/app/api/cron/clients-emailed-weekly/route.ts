import { NextResponse } from "next/server";
import { runClientsEmailedWeekly } from "@/lib/clients-emailed-weekly-runner";

// Friday 7pm America/New_York — DMs Sam & Mitchell the week's "clients emailed"
// summary. Vercel cron fires this; the work lives in the runner so the
// in-process scheduler (cron-bootstrap) runs the same push on Railway, where
// vercel.json crons never fire. The runner's NY-Friday + 7pm guards + same-day
// dedupe keep it idempotent. Pass ?force=1 to bypass the guards for testing.

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    return NextResponse.json(await runClientsEmailedWeekly({ force }));
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
