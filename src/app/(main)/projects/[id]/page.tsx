import Link from "next/link";
import { notFound } from "next/navigation";
import { projects as mockProjects, milestones, raciEntries, users as mockUsers, tasks as mockTasks, departments as mockDepts } from "@/lib/mock-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getAllUsersLight } from "@/lib/server-data";
import { TaskCard } from "@/components/TaskCard";
import { RACITable } from "@/components/RACITable";
import { ProjectStages, type StageDTO } from "@/components/ProjectStages";
import { formatDate } from "@/lib/utils";
import { CheckCircle2, Circle, Clock } from "lucide-react";
import { BackPill } from "@/components/BackPill";
import type { MilestoneStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

// Resolve a project from Supabase first; fall back to the mock-data
// set so the seeded demo projects keep working until they're migrated
// over.
async function loadProject(id: string) {
  const supabase = getSupabaseAdmin();
  const { data: real } = await supabase
    .from("projects")
    .select("id, name, description, department_id")
    .eq("id", id)
    .maybeSingle();
  if (real) {
    const { data: dept } = real.department_id
      ? await supabase.from("departments").select("id, name").eq("id", real.department_id).maybeSingle()
      : { data: null };
    return {
      kind: "supabase" as const,
      project: {
        id: real.id as string,
        name: real.name as string,
        description: (real.description as string | null) ?? "",
        departmentId: (real.department_id as string | null) ?? null
      },
      department: dept ? { id: dept.id as string, name: dept.name as string } : null
    };
  }
  const mock = mockProjects.find((p) => p.id === id);
  if (mock) {
    const dept = mockDepts.find((d) => d.id === mock.departmentId);
    return {
      kind: "mock" as const,
      project: mock,
      department: dept ? { id: dept.id, name: dept.name } : null
    };
  }
  return null;
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
  const { project, department, kind } = resolved;

  const stages = kind === "supabase" ? await loadStages(project.id) : [];

  // Pull just the avatar/name pairs we need for the embedded task list.
  const livePeople = await getAllUsersLight();
  const assigneesById: Record<string, { id: string; name: string; avatarUrl?: string | null }> = {};
  for (const u of livePeople) {
    assigneesById[u.id] = { id: u.id, name: u.name, avatarUrl: u.avatarUrl ?? null };
  }

  // Legacy bits — show milestones / RACI only on mock projects that
  // don't have the new stage flow.
  const showLegacy = kind === "mock";
  const mils = showLegacy ? milestones.filter((m) => m.projectId === project.id) : [];
  const raci = showLegacy ? raciEntries.filter((r) => r.projectId === project.id) : [];
  const legacyTasks = showLegacy ? mockTasks.filter((t) => t.projectId === project.id) : [];

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
      ) : showLegacy ? (
        <>
          <section className="card p-4">
            <div className="text-sm font-medium mb-3">Milestones</div>
            <ol className="relative border-l border-border pl-5 space-y-4">
              {mils.map((m) => (
                <li key={m.id} className="relative">
                  <span className="absolute -left-[26px] top-0.5">
                    <MilestoneIcon status={m.status} />
                  </span>
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-medium">{m.name}</div>
                    <span className="text-xs text-muted">· due {formatDate(m.dueDate)}</span>
                    <span className={"badge ml-2 " + (m.status === "done" ? "text-ok border-ok/30 bg-ok/10" : m.status === "delayed" ? "badge-critical" : "badge-medium")}>
                      {m.status.replace("_", " ")}
                    </span>
                  </div>
                  <ul className="text-xs text-muted mt-1 list-disc ml-4">
                    {m.deliverables.map((d) => <li key={d}>{d}</li>)}
                  </ul>
                </li>
              ))}
            </ol>
          </section>

          <section className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-medium">RACI matrix</div>
            </div>
            <RACITable raci={raci} users={mockUsers} />
          </section>

          <section>
            <div className="text-sm font-medium mb-3">Tasks <span className="text-muted">· {legacyTasks.length}</span></div>
            <div className="grid grid-cols-3 gap-3">
              {legacyTasks.map((t) => <TaskCard key={t.id} task={t} />)}
            </div>
          </section>
        </>
      ) : (
        <div className="card p-6 text-sm text-muted">
          This project has no stages yet. (Was it created before the stages feature?)
        </div>
      )}
    </div>
  );
}

function MilestoneIcon({ status }: { status: MilestoneStatus }) {
  if (status === "done") return <CheckCircle2 className="w-4 h-4 text-ok" />;
  if (status === "in_progress") return <Clock className="w-4 h-4 text-accent" />;
  return <Circle className="w-4 h-4 text-muted" />;
}
