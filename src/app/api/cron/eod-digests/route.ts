import { NextRequest, NextResponse } from "next/server";
import { cronAuthError } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/cron/eod-digests
//   DISABLED no-op. Client update drafts are no longer auto-generated on a
//   cadence cron — they're created on demand when an approver opens the
//   composer from /approvals and presses Generate. The route stays mounted
//   so any existing scheduler gets a clean 200 instead of a 404.
//
// Auth: same convention as the other crons — Authorization: Bearer
// <CRON_SECRET> or ?secret=. When CRON_SECRET is unset the route answers
// 503 (fail closed) — see src/lib/cron-auth.ts.

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const denied = cronAuthError(req);
  if (denied) return denied;

  // Auto-drafting on a cron is DISABLED. Client update drafts are created
  // on demand only — an approver opens the composer from the /approvals
  // "Who needs an email" card (which surfaces clients with unreported EOD
  // work) and presses Generate. This route stays mounted so any existing
  // scheduler hitting it gets a clean 200 no-op instead of a 404, but it
  // no longer creates drafts. (buildDigestForClient + isReportDay remain in
  // @/lib/eod-digest for potential manual/admin use.)
  return NextResponse.json({
    ok: true,
    disabled: true,
    note: "EOD auto-digest cron is disabled; drafts are created on demand via the composer."
  });
}
