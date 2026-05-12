import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import type { CustomFieldType, CustomFieldOption } from "@/lib/types";

export const dynamic = "force-dynamic";

const TYPES: CustomFieldType[] = [
  "text", "number", "url", "date", "checkbox", "select", "multiselect"
];

// Only Leader + dept_head can manage org-wide field defs. Workers can read
// them (so the form can render) but not mutate.
async function requireManager() {
  const id = await requireCurrentUserId();
  const u = await getUserById(id);
  if (!u || (u.role !== "leader" && u.role !== "department_head")) {
    return null;
  }
  return u;
}

function rowToField(row: any) {
  return {
    id: row.id,
    name: row.name,
    type: row.type as CustomFieldType,
    options: (row.options as CustomFieldOption[] | null) ?? null,
    position: Number(row.position ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// GET — every field def, ordered for display. Public to authenticated
// users; rendering the new-task form needs them.
export async function GET() {
  await requireCurrentUserId();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("task_custom_fields")
    .select("*")
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ fields: (data ?? []).map(rowToField) });
}

// POST — create a new field. Body: { name, type, options? }.
export async function POST(req: NextRequest) {
  const manager = await requireManager();
  if (!manager) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json();
  const name = (body.name ?? "").trim();
  const type = body.type;
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (!TYPES.includes(type)) {
    return NextResponse.json({ error: "invalid type" }, { status: 400 });
  }

  let options: CustomFieldOption[] | null = null;
  if (type === "select" || type === "multiselect") {
    if (!Array.isArray(body.options) || body.options.length === 0) {
      return NextResponse.json(
        { error: "options[] required for select/multiselect" },
        { status: 400 }
      );
    }
    options = body.options
      .map((o: any) => {
        if (typeof o === "string") return { value: o, label: o };
        if (o && typeof o === "object" && typeof o.value === "string") {
          return {
            value: o.value,
            label: typeof o.label === "string" ? o.label : o.value,
            color: typeof o.color === "string" ? o.color : undefined
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  const supabase = getSupabaseAdmin();
  // Stick the new field at the bottom by default.
  const { data: maxRow } = await supabase
    .from("task_custom_fields")
    .select("position")
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const position = (Number(maxRow?.position ?? -1) + 1) | 0;

  const id = `cf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const { data, error } = await supabase
    .from("task_custom_fields")
    .insert({ id, name, type, options, position })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ field: rowToField(data) });
}
