import { NextRequest, NextResponse } from "next/server";
import { getUserById } from "@/lib/server-data";
import { requireCurrentUserId } from "@/lib/session";
import { isLeader } from "@/lib/access";
import { runArchiveSweep } from "@/lib/task-archive-runner";

export const dynamic = "force-dynamic";

// POST /api/tasks/archive-sweep — run the auto-archive sweep on demand.
//
// This is the same age-based sweep the daily cron / in-process bootstrap run
// (shared runArchiveSweep), exposed as a one-click admin action so a leader can
// drain the backlog now instead of waiting for the schedule or hitting the
// CRON_SECRET-gated cron URL by hand. Tasks are selected by the 7-day rule, not
// hand-picked, so the archive stays stamped as automated (archived_by NULL =
// "auto") — identical to what the cron would have done.
//
// Admin/leader only, mirroring bulk-delete: a board-wide bulk action belongs to
// the same cohort. Per-task manual archiving stays on /api/tasks/[id]/archive
// (canManageTask-gated) for everyone else.
export async function POST(_req: NextRequest) {
  try {
    let userId: string;
    try {
      userId = await requireCurrentUserId();
    } catch {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const me = await getUserById(userId);
    if (!isLeader(me)) {
      return NextResponse.json({ error: "Only admins can run the archive sweep" }, { status: 403 });
    }

    const result = await runArchiveSweep();
    return NextResponse.json({ ok: true, archived: result.count, cutoff: result.cutoff });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
