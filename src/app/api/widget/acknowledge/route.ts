import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { requireCurrentUserId } from "@/lib/session";

// Records that the current user has explicitly acknowledged a task.
// Idempotent — pressing ✓ twice is a no-op via primary-key conflict.

export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const { taskId } = await req.json();
    if (!taskId || typeof taskId !== "string") {
      return NextResponse.json({ error: "taskId required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("assignment_acknowledgements")
      .upsert(
        {
          user_id: userId,
          task_id: taskId,
          acknowledged_at: new Date().toISOString()
        },
        { onConflict: "user_id,task_id" }
      );

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
