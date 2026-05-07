import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

const ALLOWED_KINDS = ["meeting", "document", "suggestion"] as const;

// POST /api/clients/[id]/resources
// Body: { kind, title, url?, body? }
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const body = await req.json();
    const kind = ALLOWED_KINDS.includes(body.kind) ? body.kind : null;
    const title = (body.title ?? "").trim();
    if (!kind) return NextResponse.json({ error: "kind must be meeting/document/suggestion" }, { status: 400 });
    if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });

    const id = `cr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const { data, error } = await getSupabaseAdmin()
      .from("client_resources")
      .insert({
        id,
        client_id: params.id,
        kind,
        title,
        url: typeof body.url === "string" && body.url.trim() ? body.url.trim() : null,
        body: typeof body.body === "string" && body.body.trim() ? body.body.trim() : null,
        created_by: userId
      })
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ resource: data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// DELETE /api/clients/[id]/resources?resourceId=...
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireCurrentUserId();
    const url = new URL(req.url);
    const resourceId = url.searchParams.get("resourceId");
    if (!resourceId) return NextResponse.json({ error: "resourceId required" }, { status: 400 });
    const { error } = await getSupabaseAdmin()
      .from("client_resources")
      .delete()
      .eq("id", resourceId)
      .eq("client_id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
