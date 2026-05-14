import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

// POST /api/widget/notifications/[id]/seen — mark a single
// notification as seen so it stops alerting on the widget. Owner-only
// (you can only dismiss your own notifications, never someone else's).
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    const userId = await requireCurrentUserId();
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("task_notifications")
      .update({ seen_at: new Date().toISOString() })
      .eq("id", params.id)
      .eq("user_id", userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
