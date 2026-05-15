import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";

export const dynamic = "force-dynamic";

// POST /api/tasks/:id/reject-draft — deletes a draft task. Mirrors the
// same permissions as approve-draft: leaders, or dept heads whose dept
// matches the draft's department_id. No tombstone — if you need history
// later, swap delete() for an update setting a `rejected_at` column.
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const supabase = getSupabaseAdmin();
  const { data: draft, error: fetchErr } = await supabase
    .from("tasks")
    .select("id, department_id, is_draft")
    .eq("id", params.id)
    .maybeSingle();
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!draft) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!draft.is_draft) return NextResponse.json({ error: "not a draft" }, { status: 409 });

  const isLeader = me.role === "leader" || me.isAdmin === true;
  const isHeadOfDept =
    me.role === "department_head" &&
    draft.department_id != null &&
    (me.departmentIds ?? []).includes(draft.department_id);
  if (!isLeader && !isHeadOfDept) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { error: deleteErr } = await supabase
    .from("tasks")
    .delete()
    .eq("id", params.id);
  if (deleteErr) return NextResponse.json({ error: deleteErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
