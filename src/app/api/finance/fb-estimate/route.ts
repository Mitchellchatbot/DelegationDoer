import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";

export const dynamic = "force-dynamic";

// Owner-only key/value inputs for the Facebook profit estimate (ad spend,
// operating expense, added expense lines). Keyed by a short string.
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
  const { data, error } = await getSupabaseAdmin().from("fb_estimate").select("key, value");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const estimates: Record<string, number> = {};
  for (const r of (data ?? []) as { key: string; value: number }[]) estimates[r.key] = Number(r.value);
  return NextResponse.json({ estimates });
}

// POST { key, value } — upsert one input.
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const body = await req.json().catch(() => null);
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  if (!key || key.length > 120) return NextResponse.json({ error: "key required" }, { status: 400 });
  const value = Math.max(0, Math.round(Number(body?.value) || 0));
  const { error } = await getSupabaseAdmin()
    .from("fb_estimate")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// DELETE { key } — remove one input (e.g. an added expense line).
export async function DELETE(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const body = await req.json().catch(() => null);
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });
  const { error } = await getSupabaseAdmin().from("fb_estimate").delete().eq("key", key);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
