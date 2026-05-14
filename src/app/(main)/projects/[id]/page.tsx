import { notFound } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getAllUsersLight } from "@/lib/server-data";
import { ProjectStages, type StageDTO } from "@/components/ProjectStages";
import { BackPill } from "@/components/BackPill";

export const dynamic = "force-dynamic";

async function loadProject(id: string) {
  const supabase = getSupabaseAdmin();
  const { data: real } = await supabase
    .from("projects")
    .select("id, name, description, department_id")
    .eq("id", id)
    .maybeSingle();
  if (!real) return null;
  const { data: dept } = real.department_id
    ? await supabase.from("departments").select("id, name").eq("id", real.department_id).maybeSingle()
    : { data: null };
  return {
    project: {
      id: real.id as string,
      name: real.name as string,
      description: (real.description as string | null) ?? "",
      departmentId: (real.department_id as string | null) ?? null
    },
    department: dept ? { id: dept.id as string, name: dept.name as string } : null
  };
}

async function loadStages(projectId: string): Promise<StageDTO[]> {
  const supabase = getSupabaseAdmin();
  const { data: stages } = await supabase
    .from("project_stages")
    .select("id, project_id, position, name, kind, status, is_it, is_not, image_urls, notes")
    .eq("project_id", projectId)
    .order("position");
  if (!stages || stages.length === 0) return [];
  const ids = stages.map((s) => s.id as string);
  const { data: tasksRows } = await supabase
    .from("tasks")
    .select(
      "id, title, description, status, priority, assignee_id, stage_id, stage_position, parallel_group, estimated_hours, actual_hours, due_date"
    )
    .in("stage_id", ids);
  const tasksByStage = new Map<string, StageDTO["tasks"]>();
  for (const id of ids) tasksByStage.set(id, []);
  for (const t of tasksRows ?? []) {
    const arr = tasksByStage.get(t.stage_id as string) ?? [];
    arr.push({
      id: t.id as string,
      title: t.title as string,
      description: (t.description as string | null) ?? null,
      status: t.status as string,
      priority: t.priority as string,
      assigneeId: (t.assignee_id as string | null) ?? null,
      stagePosition: (t.stage_position as number | null) ?? null,
      parallelGroup: (t.parallel_group as number | null) ?? null,
      estimatedHours: Number(t.estimated_hours ?? 0),
      actualHours: Number(t.actual_hours ?? 0),
      dueDate: (t.due_date as string | null) ?? null
    });
    tasksByStage.set(t.stage_id as string, arr);
  }
  return stages.map((s) => ({
    id: s.id as string,
    projectId: s.project_id as string,
    position: s.position as number,
    name: s.name as string,
    kind: s.kind as string,
    status: s.status as StageDTO["status"],
    isIt: (s.is_it as string[]) ?? [],
    isNot: (s.is_not as string[]) ?? [],
    imageUrls: (s.image_urls as string[]) ?? [],
    notes: (s.notes as string) ?? "",
    tasks: (tasksByStage.get(s.id as string) ?? []).sort((a, b) => {
      const ag = a.parallelGroup ?? Number.MAX_SAFE_INTEGER;
      const bg = b.parallelGroup ?? Number.MAX_SAFE_INTEGER;
      if (ag !== bg) return ag - bg;
      return (a.stagePosition ?? 0) - (b.stagePosition ?? 0);
    })
  }));
}

export default async function ProjectDetailPage({ params }: { params: { id: string } }) {
  const resolved = await loadProject(params.id);
  if (!resolved) return notFound();
  const { project, department } = resolved;

  const stages = await loadStages(project.id);

  // Pull just the avatar/name pairs we need for the embedded task list.
  const livePeople = await getAllUsersLight();
  const assigneesById: Record<string, { id: string; name: string; avatarUrl?: string | null }> = {};
  for (const u of livePeople) {
    assigneesById[u.id] = { id: u.id, name: u.name, avatarUrl: u.avatarUrl ?? null };
  }

  return (
    <div className="space-y-5 max-w-6xl">
      <BackPill href="/projects" label="All projects" />

      <div>
        <div className="text-xs text-muted">{department?.name ?? "—"}</div>
        <h1 className="text-xl font-medium">{project.name}</h1>
        <p className="text-sm text-muted mt-1">{project.description}</p>
      </div>

      {stages.length > 0 ? (
        <ProjectStages
          projectId={project.id}
          initialStages={stages}
          assigneesById={assigneesById}
        />
      ) : (
        <div className="card p-6 text-sm text-muted">
          This project has no stages yet.
        </div>
      )}
    </div>
  );
}
