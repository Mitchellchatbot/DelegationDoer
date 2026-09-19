import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";

export const dynamic = "force-dynamic";

// Owner-only: Facebook revenue per month (from the Finance app). Keyed by
// period 'YYYY-MM'. Drives the Facebook side of the /finance breakdown.
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

// POST { period: "YYYY-MM", revenue?, commission? } — upsert the month's
// Facebook revenue and/or the real commission earned that month.
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const body = await req.json().catch(() => null);
  const period = typeof body?.period === "string" && /^\d{4}-\d{2}$/.test(body.period.trim()) ? body.period.trim() : "";
  if (!period) return NextResponse.json({ error: "period YYYY-MM required" }, { status: 400 });

  const row: { period: string; revenue?: number; commission?: number; expenses?: number; updated_at: string } = { period, updated_at: new Date().toISOString() };
  if (body?.revenue !== undefined) {
    const revenue = Number(body.revenue);
    if (!Number.isFinite(revenue) || revenue < 0) return NextResponse.json({ error: "valid revenue required" }, { status: 400 });
    row.revenue = revenue;
  }
  if (body?.commission !== undefined) {
    const commission = Number(body.commission);
    if (!Number.isFinite(commission) || commission < 0) return NextResponse.json({ error: "valid commission required" }, { status: 400 });
    row.commission = commission;
  }
  if (body?.expenses !== undefined) {
    const expenses = Number(body.expenses);
    if (!Number.isFinite(expenses) || expenses < 0) return NextResponse.json({ error: "valid expenses required" }, { status: 400 });
    row.expenses = expenses;
  }
  if (row.revenue === undefined && row.commission === undefined && row.expenses === undefined) return NextResponse.json({ error: "revenue, expenses or commission required" }, { status: 400 });

  const { error } = await getSupabaseAdmin().from("facebook_monthly").upsert(row, { onConflict: "period" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
