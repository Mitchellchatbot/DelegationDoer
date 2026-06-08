import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isLeader } from "@/lib/auth";
import { backfillClientMeetingFromLog } from "@/lib/tldv-intake";

export const dynamic = "force-dynamic";
// Re-classifies one transcript + one client_meetings write — well under
// the 60s lambda window the other tl;dv routes use.
export const maxDuration = 60;

// POST /api/integrations/tldv/meetings/:meetingId/backfill
//   body (optional): { clientId?: string }
//
// Backfills a MISSING client_meetings record for a meeting that already
// ran through intake (its draft tasks exist) but never got a brief stored
// on a client — the "approval tasks created but Meetings & briefs is empty"
// failure class. Reuses the meeting's existing spawned task_ids from
// tldv_intake_log, so it does NOT create duplicate tasks (unlike re-running
// /run-once). Pass an explicit clientId when the transcript doesn't name
// the client clearly enough for auto-match to find it.
//
// Idempotent: the client_meetings upsert is keyed on (client_id, meeting_id),
// so re-running is a safe no-op refresh.
//
// Role-scoping mirrors approve-all / the meetings list: leaders + stealth
// admins only (a worker has nothing to backfill).
export async function POST(
  req: NextRequest,
  { params }: { params: { meetingId: string } }
) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isLeader(me) && me.role === "worker") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { clientId?: string };
  const clientId =
    typeof body.clientId === "string" && body.clientId.trim()
      ? body.clientId.trim()
      : null;

  const outcome = await backfillClientMeetingFromLog(params.meetingId, { clientId });
  if (!outcome.ok) {
    // 404 when there's no intake log to backfill from; 422 when there IS a
    // log but we couldn't match a client / write the row — the caller can
    // retry with an explicit clientId.
    const status = outcome.reason?.startsWith("no tldv_intake_log") ? 404 : 422;
    return NextResponse.json(outcome, { status });
  }
  return NextResponse.json(outcome);
}
