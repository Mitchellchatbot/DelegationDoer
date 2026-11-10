import Link from "next/link";
import { FolderKanban } from "lucide-react";
import type { ProjectHealth, ProjectHealthStatus } from "@/lib/exec/analysis/projects";
import { formatCount, pluralize } from "@/lib/exec/format";
import type { OverviewProjects, OverviewSection } from "@/lib/exec/overview";
import { cn } from "@/lib/utils";
import { SectionCard } from "../SectionCard";
import { ago, projectPath } from "./labels";

// Derived project health (analysis/projects.ts) for the projects that have
// open work, worst first. A DD project stores no status of its own, so every
// status here is computed by fixed rules, and the rules that fired are listed
// under it. The section is labeled Derived for that reason.

// P9 F5: the Projects pages' tones (PROJECT_STATUS_META), so both read the same and pass AA.
export const STATUS_META: Readonly<Record<ProjectHealthStatus, { label: string; className: string }>> = {
  off_track: { label: "Off track", className: "text-rose-700 border-rose-200 bg-rose-50" },
  at_risk: { label: "At risk", className: "text-amber-800 border-amber-200 bg-amber-50" },
  on_track: { label: "On track", className: "text-emerald-700 border-emerald-200 bg-emerald-50" },
  no_data: { label: "No data", className: "text-slate-600 border-slate-200 bg-slate-100" }
};

function ProjectItem({ project, now }: { project: ProjectHealth; now: string }) {
  const meta = STATUS_META[project.status] ?? { label: String(project.status), className: STATUS_META.no_data.className };
  const { done, total } = project.stageProgress;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link
          href={projectPath(project.projectId)}
          prefetch={false}
          className="min-w-0 break-words text-[13px] font-semibold leading-snug text-ink hover:text-accent"
        >
          {project.name}
        </Link>
        <span className={cn("badge", meta.className)}>{meta.label}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] tabular-nums text-muted">
        {/* Placeholders for later stages are open tasks, but nobody has them
            yet; the count says so, so "open" isn't read as work in flight. */}
        <span>
          {pluralize(project.openTasks, "open task")}
          {project.undispatchedTasks > 0 && ` (${formatCount(project.undispatchedTasks)} not yet dispatched)`}
        </span>
        {project.overdueTasks > 0 && <span className="font-medium text-rose-700">{formatCount(project.overdueTasks)} overdue</span>}
        {project.stalledTasks > 0 && <span>{formatCount(project.stalledTasks)} idle over 7 days</span>}
        {project.waitingOnClient > 0 && <span>{formatCount(project.waitingOnClient)} waiting on the client</span>}
        {total > 0 && <span>{`${formatCount(done)} of ${pluralize(total, "stage")} done`}</span>}
        <span>
          Last activity {project.lastActivityAt ? <time dateTime={project.lastActivityAt}>{ago(project.lastActivityAt, now)}</time> : "unknown"}
        </span>
      </div>
      {project.reasons.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-[12px] leading-relaxed text-slate-600">
          {project.reasons.map((reason, i) => (
            <li key={i} className="flex gap-1.5">
              <span aria-hidden className="text-slate-300">
                •
              </span>
              <span className="min-w-0 break-words">{reason}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function ProjectsSection({ projects, now }: { projects: OverviewSection<OverviewProjects>; now: string }) {
  if (!projects.ok) return <SectionCard title="Project health" icon={FolderKanban} error />;
  const { items, total, limit } = projects.data;
  return (
    <SectionCard
      title="Project health"
      icon={FolderKanban}
      basis="derived"
      subtitle="Projects with open tasks, worst first"
      action={total > limit ? `${items.length} of ${total}` : pluralize(total, "project")}
      empty={total === 0 ? "No project has open tasks right now." : undefined}
      padded={false}
    >
      <ul className="divide-y divide-slate-100">
        {items.map((project) => (
          <ProjectItem key={project.projectId} project={project} now={now} />
        ))}
      </ul>
    </SectionCard>
  );
}
