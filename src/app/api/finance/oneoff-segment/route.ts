import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";

export const dynamic = "force-dynamic";

// Owner-only: which one-time Stripe payments belong to the Facebook side (vs
// SEO/website, the default). Keyed by the Stripe charge id.
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

// POST { payment_id, segment: "seo" | "facebook" } — upsert one one-off's segment.
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const body = await req.json().catch(() => null);
  const payment_id = typeof body?.payment_id === "string" ? body.payment_id.trim() : "";
  const segment = body?.segment === "facebook" ? "facebook" : body?.segment === "seo" ? "seo" : "";
  if (!payment_id) return NextResponse.json({ error: "payment_id required" }, { status: 400 });
  if (!segment) return NextResponse.json({ error: "segment must be seo or facebook" }, { status: 400 });
  const { error } = await getSupabaseAdmin()
    .from("stripe_oneoff_segments")
    .upsert({ payment_id, segment, updated_at: new Date().toISOString() }, { onConflict: "payment_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
