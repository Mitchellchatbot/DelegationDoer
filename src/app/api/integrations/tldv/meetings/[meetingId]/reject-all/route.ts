import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isLeader } from "@/lib/auth";
import { rejectDraftTask, canActOnDraft } from "@/lib/draft-approval";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/integrations/tldv/meetings/:meetingId/reject-all
//   Discards every pending tl;dv draft for the meeting that the actor
//   is allowed to reject. Same scoping rules as approve-all.
export async function POST(
  _req: NextRequest,
  { params }: { params: { meetingId: string } }
) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Honor the is_admin "stealth admin" flag — match canActOnDraft and
  // the rest of the codebase's permission convention.
  if (!isLeader(me) && me.role === "worker") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const supabase = getSupabaseAdmin();
  const { data: logRow, error: logErr } = await supabase
    .from("tldv_intake_log")
    .select("task_ids")
    .eq("meeting_id", params.meetingId)
    .maybeSingle();
  if (logErr) return NextResponse.json({ error: logErr.message }, { status: 500 });
  if (!logRow) return NextResponse.json({ error: "meeting not found" }, { status: 404 });
  const taskIds = ((logRow as { task_ids: string[] | null }).task_ids ?? []);
  if (taskIds.length === 0) {
    return NextResponse.json({ ok: true, rejected: [], skipped: [], failed: [] });
  }

  const { data: drafts } = await supabase
    .from("tasks")
    .select("id, department_id, is_draft")
    .in("id", taskIds);
  const draftRows = (drafts ?? []) as Array<{
    id: string;
    department_id: string | null;
    is_draft: boolean;
  }>;

  const rejected: string[] = [];
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
    const result = await rejectDraftTask(d.id, userId);
    if (result.ok) {
      rejected.push(d.id);
    } else {
      failed.push({ id: d.id, reason: result.error ?? `status ${result.status}` });
    }
  }

  return NextResponse.json({ ok: true, rejected, skipped, failed });
}
