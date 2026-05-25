import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";

export const dynamic = "force-dynamic";

// DELETE /api/routing-review/needs-review/:decisionId — dismiss an
// unrouted-thread entry from the fallback queue. Leader-only because
// these rows are workspace-wide (no dept scoping is possible since the
// classifier couldn't pick a dept). The audit value of dismissed rows
// is low and the surface is rarely-used, so a hard delete is fine here.
export async function DELETE(
  _req: Request,
  { params }: { params: { decisionId: string } }
) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const isLeader = me.role === "leader" || me.isAdmin === true;
  if (!isLeader) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const supabase = getSupabaseAdmin();
  // Only delete rows that are actually in the fallback queue — refuse
  // to nuke decisions that already produced a task.
  const { error } = await supabase
    .from("routing_decisions")
    .delete()
    .eq("id", params.decisionId)
    .is("task_id", null)
    .eq("needs_review", true);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
