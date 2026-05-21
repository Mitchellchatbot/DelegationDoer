import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// DELETE /api/clients/[id] — remove a client. Leader/admin only.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    const { data: me } = await supabase
      .from("users")
      .select("role, is_admin")
      .eq("id", userId)
      .maybeSingle();
    if (!(me?.role === "leader" || me?.is_admin === true)) {
      return NextResponse.json({ error: "leader only" }, { status: 403 });
    }

    const { error } = await supabase.from("clients").delete().eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
