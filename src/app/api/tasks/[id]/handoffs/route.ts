import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { loadTaskForViewer } from "@/lib/task-access";

export const dynamic = "force-dynamic";

// GET /api/tasks/[id]/handoffs — handoff history for a task, oldest → newest.
// Used by the task detail page's "Handoff timeline" section. Read-only;
// handoffs are written by the PATCH /api/tasks/[id] route when the
// assignee field changes.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const access = await loadTaskForViewer(params.id);
  if (!access.ok) return access.response;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("task_handoffs")
    .select("id, task_id, from_user_id, to_user_id, stage, reason, held_minutes, created_at")
    .eq("task_id", params.id)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ handoffs: data ?? [] });
}
