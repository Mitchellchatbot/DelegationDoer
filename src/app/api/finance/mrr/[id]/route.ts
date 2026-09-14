import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";

export const dynamic = "force-dynamic";

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

// PATCH /api/finance/mrr/[id] — edit a field (company, mrr, status, note...).
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "bad body" }, { status: 400 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.company === "string") patch.company = body.company.trim();
  if (body.mrr !== undefined) patch.mrr = Number(body.mrr) || 0;
  if (typeof body.status === "string" && STATUSES.has(body.status)) patch.status = body.status;
  if ("subscription_day" in body) patch.subscription_day = body.subscription_day ?? null;
  if ("satisfaction" in body) patch.satisfaction = body.satisfaction ?? null;
  if ("note" in body) patch.note = body.note ?? null;
  if (body.rank !== undefined) patch.rank = Number(body.rank);

  const { data, error } = await getSupabaseAdmin()
    .from("mrr_entries")
    .update(patch)
    .eq("id", params.id)
    .select("id, company, mrr, status, subscription_day, satisfaction, note, rank, updated_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ entry: data });
}

// DELETE /api/finance/mrr/[id] — remove an entry entirely.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const { error } = await getSupabaseAdmin().from("mrr_entries").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
