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

const STATUSES = new Set(["active", "inactive", "onboarding", "invited", "owner-draw"]);
const SCALES = new Set(["monthly", "annual"]);

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "bad body" }, { status: 400 });
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.name === "string") patch.name = body.name.trim();
  if ("role" in body) patch.role = body.role ?? null;
  if (typeof body.status === "string" && STATUSES.has(body.status)) patch.status = body.status;
  if (typeof body.scale === "string" && SCALES.has(body.scale)) patch.scale = body.scale;
  if (body.rate !== undefined) patch.rate = Number(body.rate) || 0;
  if ("note" in body) patch.note = body.note ?? null;
  const { data, error } = await getSupabaseAdmin()
    .from("payroll_entries")
    .update(patch)
    .eq("id", params.id)
    .select("id, name, role, status, scale, rate, note, rank, updated_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ entry: data });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const { error } = await getSupabaseAdmin().from("payroll_entries").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
