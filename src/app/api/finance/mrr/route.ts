import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";

export const dynamic = "force-dynamic";

// Owner-only guard. Financials are visible to Mitchell alone.
async function requireOwner(): Promise<{ ok: true } | { ok: false; res: NextResponse }> {
  try {
    const userId = await requireCurrentUserId();
    const user = await getUserById(userId);
    if (!isOwner(user)) return { ok: false, res: NextResponse.json({ error: "not found" }, { status: 404 }) };
    return { ok: true };
  } catch {
    return { ok: false, res: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
}

const STATUSES = new Set(["active", "pending", "paused", "churned"]);

// GET /api/finance/mrr — list manual MRR entries (owner only).
export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const { data, error } = await getSupabaseAdmin()
    .from("mrr_entries")
    .select("id, company, mrr, status, subscription_day, satisfaction, note, rank, updated_at")
    .order("rank", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ entries: data ?? [] });
}

// POST /api/finance/mrr — add a manual MRR entry (owner only).
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const body = await req.json().catch(() => null);
  const company = typeof body?.company === "string" ? body.company.trim() : "";
  if (!company) return NextResponse.json({ error: "company required" }, { status: 400 });
  const status = STATUSES.has(body?.status) ? body.status : "active";
  const id = `mrr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  const supabase = getSupabaseAdmin();
  // Place new rows at the top (lowest rank - 1).
  const { data: top } = await supabase.from("mrr_entries").select("rank").order("rank", { ascending: true }).limit(1);
  const rank = (top?.[0]?.rank ?? 1) - 1;

  const { data, error } = await supabase
    .from("mrr_entries")
    .insert({
      id,
      company,
      mrr: Number(body?.mrr) || 0,
      status,
      subscription_day: typeof body?.subscription_day === "string" ? body.subscription_day : null,
      satisfaction: typeof body?.satisfaction === "string" ? body.satisfaction : null,
      note: typeof body?.note === "string" ? body.note : null,
      rank
    })
    .select("id, company, mrr, status, subscription_day, satisfaction, note, rank, updated_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ entry: data });
}
