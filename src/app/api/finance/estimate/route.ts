import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";

export const dynamic = "force-dynamic";

// Owner-only: next-month expense estimates (the forward budget). Keyed by the
// expense-line account name.
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

export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const { data, error } = await getSupabaseAdmin().from("expense_estimates").select("account, amount");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ estimates: data ?? [] });
}

// POST { account, amount } — upsert one line's estimate.
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const body = await req.json().catch(() => null);
  const account = typeof body?.account === "string" ? body.account.trim() : "";
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });
  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount < 0) return NextResponse.json({ error: "valid amount required" }, { status: 400 });
  const { error } = await getSupabaseAdmin()
    .from("expense_estimates")
    .upsert({ account, amount, updated_at: new Date().toISOString() }, { onConflict: "account" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// DELETE { account } — remove a one-off / custom estimate line.
export async function DELETE(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const body = await req.json().catch(() => null);
  const account = typeof body?.account === "string" ? body.account.trim() : "";
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });
  const { error } = await getSupabaseAdmin().from("expense_estimates").delete().eq("account", account);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
