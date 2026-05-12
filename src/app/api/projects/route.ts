import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  PROJECT_TEMPLATES,
  pickTemplateForDepartment,
  type ProjectTemplate
} from "@/lib/project-templates";
import { advanceStage } from "@/lib/project-flow";

export const dynamic = "force-dynamic";

// POST /api/projects — create a project. Body:
//   { name, description?, departmentId?, templateId? }
// Auto-seeds the stage list (and per-stage draft tasks) from the
// chosen template, OR the department's default template, OR no
// template (free-form project with no stages).
// The first stage is flipped to `active` and its first batch is
// dispatched immediately.
export async function POST(req: NextRequest) {
  try {
    const userId = await requireCurrentUserId();
    const me = await getUserById(userId);
    if (!me) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    if (me.role !== "ceo" && me.role !== "department_head") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const body = await req.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const departmentId =
      typeof body.departmentId === "string" && body.departmentId.length > 0
        ? body.departmentId
        : null;

    // Template resolution: explicit > default-for-department > none.
    let template: ProjectTemplate | null = null;
    if (typeof body.templateId === "string" && PROJECT_TEMPLATES[body.templateId]) {
      template = PROJECT_TEMPLATES[body.templateId];
    } else {
      template = pickTemplateForDepartment(departmentId);
    }

    const supabase = getSupabaseAdmin();
    const projectId = `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const { error: pErr } = await supabase.from("projects").insert({
      id: projectId,
      name,
      description: description || null,
      department_id: departmentId
    });
    if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 });

    let firstStageId: string | null = null;
    if (template) {
      const now = new Date().toISOString();
      // Stages first, then tasks. Position 0 is the first stage and
      // starts in 'active'; everything else is 'locked'.
      const stageInserts = template.stages.map((s, idx) => {
        const id = `stg_${Date.now().toString(36)}_${idx}_${Math.random().toString(36).slice(2, 5)}`;
        return {
          id,
          project_id: projectId,
          position: idx,
          name: s.name,
          kind: s.kind,
          status: idx === 0 ? "active" : "locked",
          is_it: s.isIt,
          is_not: s.isNot,
          image_urls: [],
          notes: s.notes,
          created_at: now,
          updated_at: now
        };
      });
      const { data: stageRows, error: sErr } = await supabase
        .from("project_stages")
        .insert(stageInserts)
        .select("id, position");
      if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 });
      firstStageId = stageRows?.find((r) => r.position === 0)?.id as string | undefined ?? null;

      // Now per-stage tasks. Seed every task in `pending` with no
      // assignee — the flow engine will dispatch the first batch of
      // the active stage immediately, and subsequent batches as their
      // dependencies clear.
      const taskInserts: Record<string, unknown>[] = [];
      template.stages.forEach((s, idx) => {
        const stageRow = stageRows?.find((r) => r.position === idx);
        if (!stageRow) return;
        s.tasks.forEach((t, tIdx) => {
          taskInserts.push({
            id: `t_${Date.now().toString(36)}_${idx}_${tIdx}_${Math.random().toString(36).slice(2, 5)}`,
            title: t.title,
            description: t.description ?? null,
            status: "pending",
            priority: "medium",
            estimated_hours: t.estimateHours,
            actual_hours: 0,
            tags: t.tags ?? [],
            department_id: departmentId,
            assignee_id: null,
            creator_id: userId,
            project_id: projectId,
            stage_id: stageRow.id,
            stage_position: tIdx,
            parallel_group: t.parallelGroup,
            due_date: null,
            inactive_flag: false,
            last_activity_at: now,
            created_at: now,
            blocks_task_ids: [],
            custom: {}
          });
        });
      });
      if (taskInserts.length > 0) {
        const { error: tErr } = await supabase.from("tasks").insert(taskInserts);
        if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });
      }
    }

    // Fire the first stage's first batch (delegates tasks).
    if (firstStageId) {
      try {
        await advanceStage(firstStageId);
      } catch (err) {
        console.error("[projects/create] advanceStage failed:", err);
      }
    }

    return NextResponse.json({ ok: true, projectId, firstStageId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
