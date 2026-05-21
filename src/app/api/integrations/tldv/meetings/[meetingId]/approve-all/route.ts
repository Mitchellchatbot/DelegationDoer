import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isLeader } from "@/lib/auth";
import {
  approveDraftTask,
  canActOnDraft,
  type ApprovePatch
} from "@/lib/draft-approval";

export const dynamic = "force-dynamic";
// Approving N tasks fires N Slack DMs + N DB updates. The single-task
// path runs in well under a second; 25 max (orchestrator cap) fits the
// 60s lambda window comfortably.
export const maxDuration = 60;

// POST /api/integrations/tldv/meetings/:meetingId/approve-all
//   body (optional): { overrides: Record<taskId, { assigneeId?, priority?, title?, description? }> }
//
// Promotes every pending tl;dv draft for this meeting that the actor is
// allowed to approve. Drafts outside the actor's scope are returned in
// the `skipped` array so the UI can render an honest summary.
export async function POST(
  req: NextRequest,
  { params }: { params: { meetingId: string } }
) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Stealth admins (is_admin=true) are leaders for permission purposes
  // even if their role label is "worker" — gate on that, not just role.
  if (!isLeader(me) && me.role === "worker") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    overrides?: Record<string, ApprovePatch>;
  };
  const overrides = body.overrides ?? {};

  const supabase = getSupabaseAdmin();

  // 1) Find the meeting's spawned tasks from the intake log.
  const { data: logRow, error: logErr } = await supabase
    .from("tldv_intake_log")
    .select("task_ids")
    .eq("meeting_id", params.meetingId)
    .maybeSingle();
  if (logErr) return NextResponse.json({ error: logErr.message }, { status: 500 });
  if (!logRow) return NextResponse.json({ error: "meeting not found" }, { status: 404 });
  const taskIds = ((logRow as { task_ids: string[] | null }).task_ids ?? []);
  if (taskIds.length === 0) {
    return NextResponse.json({ ok: true, approved: [], skipped: [], failed: [] });
  }

  // 2) Look up current draft rows so we know each draft's department
  //    before calling the helper (per-task permission check) and so we
  //    skip rows that are no longer drafts (already approved/rejected).
  const { data: drafts } = await supabase
    .from("tasks")
    .select("id, department_id, is_draft")
    .in("id", taskIds);
  const draftRows = (drafts ?? []) as Array<{
    id: string;
    department_id: string | null;
    is_draft: boolean;
  }>;

  const approved: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const failed: Array<{ id: string; reason: string }> = [];

  for (const d of draftRows) {
    if (!d.is_draft) {
      skipped.push({ id: d.id, reason: "already-resolved" });
      continue;
    }
    if (!canActOnDraft(me, d.department_id)) {
      skipped.push({ id: d.id, reason: "out-of-scope" });
      continue;
    }
    const result = await approveDraftTask(d.id, userId, overrides[d.id]);
    if (result.ok) {
      approved.push(d.id);
    } else {
      failed.push({ id: d.id, reason: result.error ?? `status ${result.status}` });
    }
  }

  return NextResponse.json({ ok: true, approved, skipped, failed });
}
