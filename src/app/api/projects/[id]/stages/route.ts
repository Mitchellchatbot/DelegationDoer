import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

// GET /api/projects/[id]/stages — list stages for a project with their
// tasks expanded. Used by the project detail page.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    await requireCurrentUserId();
    const supabase = getSupabaseAdmin();

    const { data: stages, error: sErr } = await supabase
      .from("project_stages")
      .select(
        "id, project_id, position, name, kind, status, is_it, is_not, image_urls, notes, created_at, updated_at"
      )
      .eq("project_id", params.id)
      .order("position");
    if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 });

    const stageIds = (stages ?? []).map((s) => s.id as string);
    let tasksByStage = new Map<string, unknown[]>();
    if (stageIds.length > 0) {
      const { data: tasks } = await supabase
        .from("tasks")
        .select(
          "id, title, description, status, priority, assignee_id, stage_id, stage_position, parallel_group, estimated_hours, actual_hours, due_date, last_activity_at"
        )
        .in("stage_id", stageIds);
      tasksByStage = new Map(stageIds.map((id) => [id, [] as unknown[]]));
      for (const t of tasks ?? []) {
        const arr = tasksByStage.get(t.stage_id as string) ?? [];
        arr.push({
          id: t.id,
          title: t.title,
          description: t.description,
          status: t.status,
          priority: t.priority,
          assigneeId: t.assignee_id,
          stagePosition: t.stage_position,
          parallelGroup: t.parallel_group,
          estimatedHours: Number(t.estimated_hours ?? 0),
          actualHours: Number(t.actual_hours ?? 0),
          dueDate: t.due_date,
          lastActivityAt: t.last_activity_at
        });
        tasksByStage.set(t.stage_id as string, arr);
      }
    }

    const out = (stages ?? []).map((s) => ({
      id: s.id,
      projectId: s.project_id,
      position: s.position,
      name: s.name,
      kind: s.kind,
      status: s.status,
      isIt: (s.is_it as string[]) ?? [],
      isNot: (s.is_not as string[]) ?? [],
      imageUrls: (s.image_urls as string[]) ?? [],
      notes: s.notes ?? "",
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      tasks: (tasksByStage.get(s.id as string) ?? []).sort((a: any, b: any) => {
        const ag = a.parallelGroup ?? Number.MAX_SAFE_INTEGER;
        const bg = b.parallelGroup ?? Number.MAX_SAFE_INTEGER;
        if (ag !== bg) return ag - bg;
        return (a.stagePosition ?? 0) - (b.stagePosition ?? 0);
      })
    }));

    return NextResponse.json({ stages: out });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
