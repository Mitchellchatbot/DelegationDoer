import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";

export const dynamic = "force-dynamic";

// Owner-only: what department each contractor belongs to. Keyed by contractor
// name (matches deel_payments.contractor).
export const DEPARTMENTS = ["Unassigned", "SEO", "Website", "Facebook", "Software", "Sales", "Admin"] as const;

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
  const { data, error } = await getSupabaseAdmin().from("contractor_departments").select("contractor, department");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ departments: data ?? [] });
}

// POST { contractor, department } — upsert one contractor's department.
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.res;
  const body = await req.json().catch(() => null);
  const contractor = typeof body?.contractor === "string" ? body.contractor.trim() : "";
  const department = typeof body?.department === "string" ? body.department.trim() : "";
  if (!contractor || !(DEPARTMENTS as readonly string[]).includes(department)) {
    return NextResponse.json({ error: "contractor and valid department required" }, { status: 400 });
  }
  const { error } = await getSupabaseAdmin()
    .from("contractor_departments")
    .upsert({ contractor, department, updated_at: new Date().toISOString() }, { onConflict: "contractor" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
