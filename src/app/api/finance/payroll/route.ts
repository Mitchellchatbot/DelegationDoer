import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canViewFinance } from "@/lib/access";

export const dynamic = "force-dynamic";

async function requireFinanceAccess(): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  try {
    const userId = await requireCurrentUserId();
    const user = await getUserById(userId);
    if (!canViewFinance(user)) return { ok: false, res: NextResponse.json({ error: "not found" }, { status: 404 }) };
    return { ok: true };
  } catch {
    return { ok: false, res: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
}

const STATUSES = new Set(["active", "inactive", "onboarding", "invited", "owner-draw"]);
const SCALES = new Set(["monthly", "annual"]);

// GET /api/finance/payroll — list payroll entries (finance access only).
export async function GET() {
  const gate = await requireFinanceAccess();
  if (!gate.ok) return gate.res;
  const { data, error } = await getSupabaseAdmin()
    .from("payroll_entries")
    .select("id, name, role, status, scale, rate, note, rank, updated_at")
    .order("rank", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ entries: data ?? [] });
}

// POST /api/finance/payroll — add a person (finance access only).
export async function POST(req: NextRequest) {
  const gate = await requireFinanceAccess();
  if (!gate.ok) return gate.res;
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const id = `pay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const supabase = getSupabaseAdmin();
  const { data: top } = await supabase.from("payroll_entries").select("rank").order("rank", { ascending: true }).limit(1);
  const rank = (top?.[0]?.rank ?? 1) - 1;
  const { data, error } = await supabase
    .from("payroll_entries")
    .insert({
      id,
      name,
      role: typeof body?.role === "string" ? body.role : null,
      status: STATUSES.has(body?.status) ? body.status : "active",
      scale: SCALES.has(body?.scale) ? body.scale : "monthly",
      rate: Number(body?.rate) || 0,
      note: typeof body?.note === "string" ? body.note : null,
      rank
    })
    .select("id, name, role, status, scale, rate, note, rank, updated_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ entry: data });
}
