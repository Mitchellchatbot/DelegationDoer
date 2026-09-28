import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { canViewFinance } from "@/lib/access";

export const dynamic = "force-dynamic";

// Finance-access only: which software vendors are Facebook (splits the Software line).
// Applies to every month's row for that vendor.
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

// POST { vendor, segment: "seo" | "facebook" }
export async function POST(req: NextRequest) {
  const gate = await requireFinanceAccess();
  if (!gate.ok) return gate.res;
  const body = await req.json().catch(() => null);
  const vendor = typeof body?.vendor === "string" ? body.vendor.trim() : "";
  const segment = body?.segment === "facebook" ? "facebook" : body?.segment === "seo" ? "seo" : "";
  if (!vendor) return NextResponse.json({ error: "vendor required" }, { status: 400 });
  if (!segment) return NextResponse.json({ error: "segment must be seo or facebook" }, { status: 400 });
  const { error } = await getSupabaseAdmin().from("software_subscriptions").update({ segment }).eq("vendor", vendor);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
