import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";

export const dynamic = "force-dynamic";

// Owner-only: which P&L expense LINES belong to the Facebook side of the
// business (vs SEO/website, the default). Keyed by the expense-line account.
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

// POST { account, segment: "seo" | "facebook" } — upsert one line's segment.
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const body = await req.json().catch(() => null);
  const account = typeof body?.account === "string" ? body.account.trim() : "";
  const segment = body?.segment === "facebook" ? "facebook" : body?.segment === "seo" ? "seo" : "";
  if (!account) return NextResponse.json({ error: "account required" }, { status: 400 });
  if (!segment) return NextResponse.json({ error: "segment must be seo or facebook" }, { status: 400 });
  const { error } = await getSupabaseAdmin()
    .from("expense_segments")
    .upsert({ account, segment, updated_at: new Date().toISOString() }, { onConflict: "account" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
