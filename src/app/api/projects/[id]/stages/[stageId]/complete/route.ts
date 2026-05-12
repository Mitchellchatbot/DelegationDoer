import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { advanceStage } from "@/lib/project-flow";

export const dynamic = "force-dynamic";

// POST /api/projects/[id]/stages/[stageId]/complete — manually mark
// the stage as done. Idempotent. Leader + department head only.
// On success the flow engine activates the next stage and dispatches
// its first batch.
export async function POST(
  _req: Request,
  { params }: { params: { id: string; stageId: string } }
) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (me.role !== "leader" && me.role !== "department_head") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const supabase = getSupabaseAdmin();
    // Mark every still-open task in this stage as done. Avoids the
    // weird state where a Leader closes the stage but some tasks are
    // still pending — they get archived as done so the activity log
    // is complete.
    await supabase
      .from("tasks")
      .update({
        status: "done",
        last_activity_at: new Date().toISOString()
      })
      .eq("stage_id", params.stageId)
      .neq("status", "done");

    await supabase
      .from("project_stages")
      .update({ status: "done", updated_at: new Date().toISOString() })
      .eq("id", params.stageId);

    // Activate + dispatch the next stage.
    const supa2 = getSupabaseAdmin();
    const { data: stage } = await supa2
      .from("project_stages")
      .select("project_id, position")
      .eq("id", params.stageId)
      .maybeSingle();
    if (stage) {
      const { data: next } = await supa2
        .from("project_stages")
        .select("id")
        .eq("project_id", stage.project_id)
        .gt("position", stage.position)
        .order("position")
        .limit(1)
        .maybeSingle();
      if (next) {
        await supa2
          .from("project_stages")
          .update({ status: "active", updated_at: new Date().toISOString() })
          .eq("id", next.id);
        try { await advanceStage(next.id as string); }
        catch (err) { console.error("[stages/complete] advance failed:", err); }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
