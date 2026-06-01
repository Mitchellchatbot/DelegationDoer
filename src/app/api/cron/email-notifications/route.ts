import { NextRequest, NextResponse } from "next/server";
import { pollEmailNotifications } from "@/lib/email-notifications-poller";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/cron/email-notifications — scheduled poller.
//
// Replaces the missiveclone-webhook fan-out path: instead of relying on
// missiveclone to push us new-message events (which kept silently
// failing in prod), this scans every opted-in account's INBOX via the
// missive REST API and writes notification rows for anything new.
//
// Auth: same Vercel-cron convention as the other crons —
// `Authorization: Bearer <CRON_SECRET>` or `?secret=`.
//
// Cadence: every minute. Each pass is bounded by THREADS_PER_ACCOUNT
// in the poller so a busy workspace can't blow the 60s maxDuration.

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    const querySecret = url.searchParams.get("secret");
    const ok = auth === `Bearer ${secret}` || querySecret === secret;
    if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const result = await pollEmailNotifications();
    if (result.rowsWritten > 0 || result.errors.length > 0) {
      console.log("[email-notif-poll]", result);
    }
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[email-notif-poll] fatal", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
