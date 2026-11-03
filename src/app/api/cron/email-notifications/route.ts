import { NextRequest, NextResponse } from "next/server";
import { pollEmailNotifications } from "@/lib/email-notifications-poller";
import { cronAuthError } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/cron/email-notifications — scheduled poller.
//
// Replaces the missiveclone-webhook fan-out path: instead of relying on
// missiveclone to push us new-message events (which kept silently
// failing in prod), this scans every opted-in account's INBOX via the
// missive REST API and writes notification rows for anything new.
//
// Auth: `Authorization: Bearer <CRON_SECRET>` only; 503 when CRON_SECRET is
// unset (fail closed) — see src/lib/cron-auth.ts.
//
// Cadence: every minute. Each pass is bounded by THREADS_PER_ACCOUNT
// in the poller so a busy workspace can't blow the 60s maxDuration.

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const denied = cronAuthError(req);
  if (denied) return denied;

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
