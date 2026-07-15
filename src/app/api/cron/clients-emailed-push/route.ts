import { NextResponse } from "next/server";
import { runClientsEmailedPush } from "@/lib/clients-emailed-push-runner";

// 7pm America/New_York, every day — DMs Sam & Mitchell the day's "clients
// emailed" summary, with the week's roll-up folded into Friday's DM. Vercel cron
// fires this; the work lives in the runner so the in-process scheduler
// (cron-bootstrap) runs the same push on Railway, where vercel.json crons never
// fire. The runner's 7pm guard + same-UTC-day dedupe keep it idempotent.
//   ?force=1  bypass the 7pm guard and the dedupe stamp (manual testing)
//   ?week=1   force the week section on, to test Friday's shape on any weekday

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const force = params.get("force") === "1";
    const includeWeek = params.get("week") === "1" ? true : undefined;
    return NextResponse.json(await runClientsEmailedPush({ force, includeWeek }));
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
