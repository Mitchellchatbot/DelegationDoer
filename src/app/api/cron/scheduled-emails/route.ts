import { NextResponse } from "next/server";
import { runScheduledEmails } from "@/lib/scheduled-emails-runner";
import { cronAuthError } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Sends every scheduled email that's now due. Runs every minute via Vercel
// cron. The work lives in scheduled-emails-runner so the in-process scheduler
// (cron-bootstrap) can run the same dispatcher on Railway, where vercel.json
// crons never fire. Each row is claimed before its network call, so a
// duplicate tick can't double-dispatch.
export async function GET(req: Request) {
  const denied = cronAuthError(req);
  if (denied) return denied;

  try {
    const r = await runScheduledEmails();
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
