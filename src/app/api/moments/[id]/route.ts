import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";

export const dynamic = "force-dynamic";

// DELETE /api/moments/[id] — owner or Leader can drop a moment.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const supabase = getSupabaseAdmin();
  const { data: row } = await supabase
    .from("moments")
    .select("user_id")
    .eq("id", params.id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (row.user_id !== userId && me.role !== "leader") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { error } = await supabase.from("moments").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
