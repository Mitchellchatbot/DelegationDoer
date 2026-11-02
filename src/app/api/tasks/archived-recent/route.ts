import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getLeaderIds, getRecentArchivedTasks, getUserById } from "@/lib/server-data";
import { canViewTask, isLeader } from "@/lib/access";

export const dynamic = "force-dynamic";

// How many cards the board's Archived column shows.
const COLUMN_SIZE = 50;

// How far back a non-leader's read goes to fill the column. Leader privacy can
// only be applied in memory (canViewTask), and it hides everything a leader
// created or owns, so reading just COLUMN_SIZE rows would leave a worker with a
// handful of cards. Still bounded: this runs on every board load.
const NON_LEADER_SCAN = 200;

// GET /api/tasks/archived-recent?departmentIds=a,b
//
// The newest archived tasks the viewer may see, for the Archived column on the
// board. By person is the board's default view, so this runs on most board
// loads, which is why it doesn't reuse GET /api/tasks?archived=true: that reads
// the whole archive with full rows. The complete list stays on /tasks/archived.
//
// The department scope has to happen here rather than on the client: filtering
// a capped list afterwards would narrow the newest cards across ALL departments
// down to the few that happen to match.
export async function GET(req: NextRequest) {
  try {
    const viewer = await getUserById(await requireCurrentUserId());
    const departmentIds = (req.nextUrl.searchParams.get("departmentIds") ?? "")
      .split(",")
      .filter(Boolean);

    const scan = isLeader(viewer) ? COLUMN_SIZE + 1 : NON_LEADER_SCAN;
    const [rows, leaderIds] = await Promise.all([
      getRecentArchivedTasks({ limit: scan, departmentIds }),
      getLeaderIds()
    ]);
    const visible = rows.filter((t) => canViewTask(viewer, t, leaderIds));

    return NextResponse.json({
      tasks: visible.slice(0, COLUMN_SIZE),
      // A read that came back full stopped at its limit, so older rows may
      // exist past it even when the viewer could see fewer than COLUMN_SIZE.
      hasMore: visible.length > COLUMN_SIZE || rows.length === scan
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
