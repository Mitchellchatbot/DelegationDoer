import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { approveDraftTask, rejectDraftTask } from "@/lib/draft-approval";

export const dynamic = "force-dynamic";

interface BulkBody {
  action: "approve" | "deny";
  taskIds: string[];
  denyReason?: string;
}

// POST /api/routing-review/bulk — fan-out approve/deny across a batch
// of drafts. Iterates sequentially (rather than Promise.all) so a
// failure on row 5 doesn't tank rows 1-4; the response lists per-id
// status so the UI can flag the few that failed.
export async function POST(req: NextRequest) {
  const userId = await requireCurrentUserId();
  const body = (await req.json().catch(() => ({}))) as Partial<BulkBody>;
  const action = body.action;
  const taskIds = Array.isArray(body.taskIds) ? body.taskIds.filter((x): x is string => typeof x === "string") : [];
  if (action !== "approve" && action !== "deny") {
    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }
  if (taskIds.length === 0) {
    return NextResponse.json({ results: [] });
  }

  const results: Array<{ taskId: string; ok: boolean; error?: string }> = [];
  for (const id of taskIds) {
    try {
      const r =
        action === "approve"
          ? await approveDraftTask(id, userId)
          : await rejectDraftTask(id, userId, { reason: body.denyReason });
      results.push({ taskId: id, ok: r.ok, error: r.ok ? undefined : r.error });
    } catch (err) {
      results.push({
        taskId: id,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return NextResponse.json({ results });
}
