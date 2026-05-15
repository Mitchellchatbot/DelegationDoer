import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import type { CustomFieldOption } from "@/lib/types";

export const dynamic = "force-dynamic";

async function requireManager() {
  const id = await requireCurrentUserId();
  const u = await getUserById(id);
  if (!u) return null;
  if (u.role === "leader" || u.role === "department_head" || u.isAdmin) return u;
  return null;
}

// PATCH /api/custom-fields/[id] — rename a field, swap its options, or
// reorder. Type is intentionally NOT mutable: a text→select migration
// would need to coerce existing values, which is out of scope.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const manager = await requireManager();
  if (!manager) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof body.name === "string" && body.name.trim()) update.name = body.name.trim();
  if (typeof body.position === "number") update.position = Math.round(body.position);
  if (body.options === null) update.options = null;
  else if (Array.isArray(body.options)) {
    update.options = body.options
      .map((o: unknown): CustomFieldOption | null => {
        if (typeof o === "string") return { value: o, label: o };
        if (o && typeof o === "object" && "value" in o && typeof (o as any).value === "string") {
          const r = o as any;
          return {
            value: r.value,
            label: typeof r.label === "string" ? r.label : r.value,
            color: typeof r.color === "string" ? r.color : undefined
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("task_custom_fields")
    .update(update)
    .eq("id", params.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ field: data });
}

// DELETE /api/custom-fields/[id] — drop the field def. Existing values
// stay in tasks.custom JSONB but become unreachable; the UI just won't
// render anything without a matching def. (Cheap garbage; revisit if it
// matters for storage.)
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const manager = await requireManager();
  if (!manager) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("task_custom_fields")
    .delete()
    .eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
