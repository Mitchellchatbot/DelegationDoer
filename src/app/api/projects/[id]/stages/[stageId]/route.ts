import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// PATCH /api/projects/[id]/stages/[stageId] — edit stage docs.
// Body (any subset):
//   { name?, isIt?: string[], isNot?: string[], notes?, imageUrls?: string[] }
// imageUrls is REPLACING the full list (not appending). Use it for both
// adding (concat client-side then PUT) and removing.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; stageId: string } }
) {
  try {
    await requireCurrentUserId();
    const body = await req.json();
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body.name === "string") update.name = body.name.trim();
    if (Array.isArray(body.isIt)) {
      update.is_it = body.isIt.filter((s: unknown) => typeof s === "string");
    }
    if (Array.isArray(body.isNot)) {
      update.is_not = body.isNot.filter((s: unknown) => typeof s === "string");
    }
    if (typeof body.notes === "string") update.notes = body.notes;
    if (Array.isArray(body.imageUrls)) {
      update.image_urls = body.imageUrls.filter((s: unknown) => typeof s === "string");
    }

    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("project_stages")
      .update(update)
      .eq("id", params.stageId)
      .eq("project_id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
