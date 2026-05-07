import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

// POST /api/clients — create a new client folder.
// Body: { name, website?, priority? ('low'|'medium'|'high'), notes? }
export async function POST(req: NextRequest) {
  try {
    await requireCurrentUserId();
    const body = await req.json();
    const name = (body.name ?? "").trim();
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

    const id = `cl_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 32)}_${Math.random().toString(36).slice(2, 6)}`;
    const priority = ["low", "medium", "high"].includes(body.priority) ? body.priority : "medium";

    const { data, error } = await getSupabaseAdmin()
      .from("clients")
      .insert({
        id,
        name,
        website: typeof body.website === "string" && body.website.trim() ? body.website.trim() : null,
        priority,
        notes: typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null
      })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ client: data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
