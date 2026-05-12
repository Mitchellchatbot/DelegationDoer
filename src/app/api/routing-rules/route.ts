import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";

export const dynamic = "force-dynamic";

// Leader-only writes. Reads are open to any authed user so the new-task
// popdown can also surface "this would be auto-routed to X" hints.
async function requireCeo() {
  const id = await requireCurrentUserId();
  const u = await getUserById(id);
  if (!u || u.role !== "leader") return null;
  return u;
}

interface RuleRow {
  id: string;
  label: string;
  keywords: string[] | null;
  assignee_user_id: string | null;
  department_id: string | null;
  priority: number;
  created_at: string;
}

function rowToJson(r: RuleRow) {
  return {
    id: r.id,
    label: r.label,
    keywords: r.keywords ?? [],
    assigneeUserId: r.assignee_user_id,
    departmentId: r.department_id,
    priority: Number(r.priority ?? 0),
    createdAt: r.created_at
  };
}

// GET /api/routing-rules — list, ordered by priority desc, then created.
export async function GET() {
  await requireCurrentUserId();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("routing_rules")
    .select("*")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) {
    // Schema not migrated yet — degrade gracefully so the rest of the
    // app doesn't 500 on every settings page load.
    if (/relation .* does not exist/i.test(error.message)) {
      return NextResponse.json({ rules: [] });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({
    rules: ((data ?? []) as RuleRow[]).map(rowToJson)
  });
}

// POST /api/routing-rules — create. Body: { label, keywords[],
// assigneeUserId?, departmentId?, priority? }. Either assignee or
// department must be set.
export async function POST(req: NextRequest) {
  if (!(await requireCeo())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = await req.json();
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const keywords = Array.isArray(body.keywords)
    ? body.keywords
        .map((k: unknown) => (typeof k === "string" ? k.trim().toLowerCase() : ""))
        .filter((k: string) => k.length > 0)
    : [];
  const assigneeUserId = typeof body.assigneeUserId === "string" && body.assigneeUserId
    ? body.assigneeUserId
    : null;
  const departmentId = typeof body.departmentId === "string" && body.departmentId
    ? body.departmentId
    : null;
  const priority = Number.isFinite(Number(body.priority)) ? Math.round(Number(body.priority)) : 0;

  if (!label) return NextResponse.json({ error: "label required" }, { status: 400 });
  if (keywords.length === 0) return NextResponse.json({ error: "at least one keyword required" }, { status: 400 });
  if (!assigneeUserId && !departmentId) {
    return NextResponse.json({ error: "assignee or department required" }, { status: 400 });
  }

  const id = `rr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("routing_rules")
    .insert({
      id,
      label,
      keywords,
      assignee_user_id: assigneeUserId,
      department_id: departmentId,
      priority
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rule: rowToJson(data as RuleRow) });
}
