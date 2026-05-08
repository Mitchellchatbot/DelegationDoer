import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

// POST /api/widget/kudos/[id]/acknowledge — flip acknowledged_at to now()
// so the widget stops surfacing this kudos. Scoped to the recipient: a
// stranger can't ack someone else's kudos.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("kudos")
      .update({ acknowledged_at: new Date().toISOString() })
      .eq("id", params.id)
      .eq("to_user_id", userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
