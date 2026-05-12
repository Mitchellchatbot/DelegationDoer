import Link from "next/link";
import { projects as mockProjects, departments as mockDepts, milestones, tasks as mockTasks } from "@/lib/mock-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { formatDate } from "@/lib/utils";
import { CheckCircle2, FolderKanban, Lock, PlayCircle } from "lucide-react";
import { NewProjectButton } from "@/components/NewProjectButton";

export const dynamic = "force-dynamic";

// Cycle a small palette across project cards so a wall of projects stays
// visually distinguishable. Restricted to the blue→purple family.
const PALETTE = [
  { ring: "ring-blue-300/40",   from: "from-blue-50",    iconBg: "bg-blue-500" },
  { ring: "ring-indigo-300/40", from: "from-indigo-50",  iconBg: "bg-indigo-500" }
];

// Unified shape for both Supabase-backed and mock-seeded projects so
// the render block stays the same.
interface ProjectRow {
  id: string;
  name: string;
  description: string;
  departmentId: string | null;
  departmentName: string | null;
  // Stage-flow specifics (only set for Supabase projects).
  stageCount: number;
  stagesDone: number;
  activeStageName: string | null;
  openTaskCount: number;
  source: "live" | "mock";
}

async function loadAllProjects(): Promise<ProjectRow[]> {
  const supabase = getSupabaseAdmin();
  const [
    { data: rawProjects },
    { data: rawStages },
    { data: rawTasks },
    { data: rawDepts }
  ] = await Promise.all([
    supabase.from("projects").select("id, name, description, department_id"),
    supabase.from("project_stages").select("id, project_id, name, position, status"),
    supabase.from("tasks").select("project_id, status").not("project_id", "is", null),
    supabase.from("departments").select("id, name")
  ]);

  const deptName = new Map<string, string>();
  for (const d of rawDepts ?? []) deptName.set(d.id as string, d.name as string);

  // Group stages by project for stage-count + active-stage labelling.
  const stagesByProject = new Map<string, { name: string; position: number; status: string }[]>();
  for (const s of rawStages ?? []) {
    const arr = stagesByProject.get(s.project_id as string) ?? [];
    arr.push({
      name: s.name as string,
      position: s.position as number,
      status: s.status as string
    });
    stagesByProject.set(s.project_id as string, arr);
  }

  const openByProject = new Map<string, number>();
  for (const t of rawTasks ?? []) {
    if (t.status === "done") continue;
    const pid = t.project_id as string;
    openByProject.set(pid, (openByProject.get(pid) ?? 0) + 1);
  }

  const live: ProjectRow[] = (rawProjects ?? []).map((p) => {
    const stages = (stagesByProject.get(p.id as string) ?? []).sort((a, b) => a.position - b.position);
    const active = stages.find((s) => s.status === "active");
    const done = stages.filter((s) => s.status === "done").length;
    return {
      id: p.id as string,
      name: p.name as string,
      description: (p.description as string | null) ?? "",
      departmentId: (p.department_id as string | null) ?? null,
      departmentName: p.department_id ? deptName.get(p.department_id as string) ?? null : null,
      stageCount: stages.length,
      stagesDone: done,
      activeStageName: active ? active.name : null,
      openTaskCount: openByProject.get(p.id as string) ?? 0,
      source: "live"
    };
  });

  // Mock fallback: only show mock-data demos that aren't already in
  // Supabase (we'd rather show the live version if both exist).
  const liveIds = new Set(live.map((p) => p.id));
  const mock: ProjectRow[] = mockProjects
    .filter((p) => !liveIds.has(p.id))
    .map((p) => {
      const dept = mockDepts.find((d) => d.id === p.departmentId);
      const open = mockTasks.filter((t) => t.projectId === p.id && t.status !== "done").length;
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        departmentId: p.departmentId,
        departmentName: dept?.name ?? null,
        stageCount: 0,
        stagesDone: 0,
        activeStageName: null,
        openTaskCount: open,
        source: "mock"
      };
    });

  // Live first (most recently relevant), mock after.
  return [...live, ...mock];
}

function nextMilestoneLabelFor(projectId: string): string | null {
  const next = milestones.find((m) => m.projectId === projectId && m.status !== "done");
  if (!next) return null;
  return `${next.name} · ${formatDate(next.dueDate)}`;
}

export default async function ProjectsListPage() {
  const all = await loadAllProjects();

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <header
        className="relative overflow-hidden rounded-2xl border border-white/60 shadow-soft p-5"
        style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #C7D2FE 50%, #C7D2FE 100%)" }}
      >
        <div className="relative flex items-center gap-3">
          <span className="text-3xl">📁</span>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold">Projects</h1>
            <p className="text-sm text-ink/60 mt-0.5">
              {all.length === 0
                ? "No projects yet. Hit New project to spin one up."
                : `${all.length} project${all.length === 1 ? "" : "s"} across the org.`}
            </p>
          </div>
          <NewProjectButton />
        </div>
        <div
          aria-hidden
          className="absolute -top-10 right-12 w-32 h-32 rounded-full"
          style={{ background: "radial-gradient(circle, rgba(99,102,241,0.18), transparent 70%)" }}
        />
      </header>

      {all.length === 0 ? (
        <div className="card p-8 text-center text-sm text-muted">
          No projects to show. Create your first one with the button above.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {all.map((p, i) => {
            const tone = PALETTE[i % PALETTE.length];
            return (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                className={`group relative overflow-hidden rounded-2xl border border-white/60 ring-1 ${tone.ring} shadow-soft hover:shadow-lift hover:-translate-y-0.5 transition-all bg-gradient-to-br ${tone.from} to-white p-4`}
              >
                <div className="flex items-center gap-2.5 mb-2">
                  <div className={`w-9 h-9 rounded-xl shadow-sm grid place-items-center text-white ${tone.iconBg}`}>
                    <FolderKanban className="w-4 h-4" />
                  </div>
                  <div className="text-sm font-semibold truncate flex-1">{p.name}</div>
                  {p.departmentName && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/70 border border-border/60 text-ink/70">
                      {p.departmentName}
                    </span>
                  )}
                </div>

                {p.description && (
                  <div className="text-xs text-ink/60 line-clamp-2">{p.description}</div>
                )}

                <div className="mt-3 flex items-center justify-between text-xs gap-2">
                  <div className="text-ink/60">
                    <span className="font-semibold tabular-nums text-ink">{p.openTaskCount}</span> open
                    {p.stageCount > 0 && (
                      <>
                        <span className="mx-1.5 text-ink/30">·</span>
                        <span className="font-semibold tabular-nums text-ink">{p.stagesDone}/{p.stageCount}</span>
                        <span className="text-ink/55"> stage{p.stageCount === 1 ? "" : "s"} done</span>
                      </>
                    )}
                  </div>
                  {p.activeStageName ? (
                    <div className="inline-flex items-center gap-1 text-ink/70 text-[11px]">
                      <PlayCircle className="w-3 h-3 text-blue-600" />
                      {p.activeStageName}
                    </div>
                  ) : p.source === "live" && p.stageCount > 0 && p.stagesDone === p.stageCount ? (
                    <div className="inline-flex items-center gap-1 text-emerald-700 text-[11px]">
                      <CheckCircle2 className="w-3 h-3" />
                      Shipped
                    </div>
                  ) : p.source === "live" ? (
                    <div className="inline-flex items-center gap-1 text-ink/45 text-[11px]">
                      <Lock className="w-3 h-3" />
                      No active stage
                    </div>
                  ) : (
                    <div className="text-ink/60 truncate">
                      {(() => {
                        const label = nextMilestoneLabelFor(p.id);
                        return label ? <>Next: <span className="text-ink font-medium">{label}</span></> : null;
                      })()}
                    </div>
                  )}
                </div>

                <div
                  aria-hidden
                  className="absolute -bottom-8 -right-8 w-28 h-28 rounded-full pointer-events-none opacity-0 group-hover:opacity-60 transition-opacity"
                  style={{ background: "radial-gradient(circle, rgba(99,102,241,0.18), transparent 70%)" }}
                />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
