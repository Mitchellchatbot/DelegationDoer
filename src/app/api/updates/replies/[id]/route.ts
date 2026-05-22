import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// DELETE /api/updates/replies/[id]
//   Removes a reply. Author can delete their own; leaders + admins can
//   delete anyone's (moderation lever for accidental rude posts).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const callerId = await requireCurrentUserId();
    const { id } = await params;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const supabase = getSupabaseAdmin();
    const { data: row, error: fetchErr } = await supabase
      .from("update_replies")
      .select("id, user_id")
      .eq("id", id)
      .maybeSingle();
    if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

    if (row.user_id !== callerId) {
      const me = await getUserById(callerId);
      const canModerate = !!me && (me.role === "leader" || me.isAdmin === true);
      if (!canModerate) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const { error } = await supabase.from("update_replies").delete().eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
