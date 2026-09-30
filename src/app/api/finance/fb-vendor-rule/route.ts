import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";

export const dynamic = "force-dynamic";

// Owner-only: vendors that are always Facebook. POST {vendor, facebook:boolean}
// toggles the rule on/off (delete when false).
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
  const { data, error } = await getSupabaseAdmin().from("fb_vendor_rules").select("vendor");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ vendors: (data ?? []).map((r: { vendor: string }) => r.vendor) });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const body = await req.json().catch(() => null);
  const vendor = typeof body?.vendor === "string" ? body.vendor.trim() : "";
  if (!vendor) return NextResponse.json({ error: "vendor required" }, { status: 400 });
  const facebook = body?.facebook !== false; // default true
  const supabase = getSupabaseAdmin();
  if (facebook) {
    const { error } = await supabase.from("fb_vendor_rules").upsert({ vendor, updated_at: new Date().toISOString() }, { onConflict: "vendor" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await supabase.from("fb_vendor_rules").delete().eq("vendor", vendor);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
