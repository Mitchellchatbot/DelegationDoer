import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";

export const dynamic = "force-dynamic";

async function requireCeo() {
  const id = await requireCurrentUserId();
  const u = await getUserById(id);
  if (!u || !(u.role === "leader" || u.isAdmin)) return null;
  return u;
}

// PATCH /api/routing-rules/[id] — partial update of label, keywords,
// assignee, department, or priority. Leader-only.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await requireCeo())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await req.json();
  const update: Record<string, unknown> = {};
  if (typeof body.label === "string" && body.label.trim()) {
    update.label = body.label.trim();
  }
  if (Array.isArray(body.keywords)) {
    const cleaned = body.keywords
      .map((k: unknown) => (typeof k === "string" ? k.trim().toLowerCase() : ""))
      .filter((k: string) => k.length > 0);
    if (cleaned.length === 0) {
      return NextResponse.json({ error: "at least one keyword required" }, { status: 400 });
    }
    update.keywords = cleaned;
  }
  if (body.assigneeUserId === null) update.assignee_user_id = null;
  else if (typeof body.assigneeUserId === "string") update.assignee_user_id = body.assigneeUserId;
  if (body.departmentId === null) update.department_id = null;
  else if (typeof body.departmentId === "string") update.department_id = body.departmentId;
  if (Number.isFinite(Number(body.priority))) {
    update.priority = Math.round(Number(body.priority));
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "no editable fields supplied" }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("routing_rules")
    .update(update)
    .eq("id", params.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rule: data });
}

// DELETE /api/routing-rules/[id]
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await requireCeo())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("routing_rules").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
