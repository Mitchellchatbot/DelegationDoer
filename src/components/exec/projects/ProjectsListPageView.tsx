import Link from "next/link";
import { FolderKanban, TriangleAlert } from "lucide-react";
import { formatCount, pluralize } from "@/lib/exec/format";
import type { ProjectListRow, ProjectsFilter, ProjectsListView } from "@/lib/exec/view-types";
import { cn } from "@/lib/utils";
import { BasisLabel } from "../BasisLabel";
import { EXEC_TABS, ExecTabs } from "../ExecTabs";
import { ExecHeader } from "../ExecHeader";
import { ago } from "../overview/labels";
import { SectionCard } from "../SectionCard";
import { ProjectStatusBadge, projectPagePath, stuckText } from "./labels";

// /executive/projects (P5a contract §3.13.2, A4, C16): every DD project with
// its derived health, worst first, as projectsHealth computes it for the
// Overview. Rendered from a ProjectsListView only (no reads, no clock). The
// filter is a link bar (?show=all|problems|open). A derived client and a
// stuck batch are labelled Derived; the status never changes for them.

export const PROJECT_FILTERS: readonly { key: ProjectsFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "problems", label: "Needs attention" },
  { key: "open", label: "Has open work" }
];

export function projectsFilterHref(key: ProjectsFilter): string {
  return key === "all" ? "/executive/projects" : `/executive/projects?show=${key}`;
}

function FilterBar({ active }: { active: ProjectsFilter }) {
  return (
    <nav aria-label="Filter projects" className="flex flex-wrap items-center gap-1.5">
      {PROJECT_FILTERS.map((f) => (
        <Link
          key={f.key}
          href={projectsFilterHref(f.key)}
          prefetch={false}
          aria-current={f.key === active ? "true" : undefined}
          className={cn(
            "rounded-full border px-3 py-1 text-[12px] font-semibold transition-colors",
            f.key === active ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:text-ink"
          )}
        >
          {f.label}
        </Link>
      ))}
    </nav>
  );
}

function ProjectRow({ row, now }: { row: ProjectListRow; now: string }) {
  const h = row.health;
  const { done, total } = h.stageProgress;
  const [first, ...more] = h.reasons;
  return (
    <li data-project-row={h.projectId} className="space-y-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link href={projectPagePath(h.projectId)} prefetch={false} className="min-w-0 break-words text-[13.5px] font-semibold leading-snug text-ink hover:text-indigo-700">
          {h.name}
        </Link>
        <ProjectStatusBadge status={h.status} />
        <BasisLabel basis="derived" />
        {row.stuck.length > 0 && (
          <span data-stuck-badge title={row.stuck.map(stuckText).join("\n")} className="badge inline-flex items-center gap-1 border-amber-200 bg-amber-50 text-amber-800">
            <TriangleAlert className="h-3 w-3" aria-hidden />
            Stuck batch
          </span>
        )}
      </div>
      {first && (
        <p className="break-words text-[12px] leading-relaxed text-slate-600">
          {first}
          {more.length > 0 && <span className="ml-1 text-muted">{`+${formatCount(more.length)} more`}</span>}
        </p>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] tabular-nums text-muted">
        {total > 0 && (
          // DD numbers stages from 0 (its own UI shows "Stage {position + 1}"); the
          // active stage's own number, not the count of finished stages (review ui-1).
          <span data-stage-progress>
            {row.activeStage
              ? `Stage ${formatCount(row.activeStage.position + 1)} of ${formatCount(total)} · ${row.activeStage.name}`
              : `${formatCount(done)} of ${pluralize(total, "stage")} done`}
          </span>
        )}
        <span>
          {pluralize(h.openTasks, "open task")}
          {h.undispatchedTasks > 0 && ` (${formatCount(h.undispatchedTasks)} not yet dispatched)`}
        </span>
        {h.overdueTasks > 0 && <span className="font-medium text-rose-700">{`${formatCount(h.overdueTasks)} overdue`}</span>}
        {h.stalledTasks > 0 && <span>{`${formatCount(h.stalledTasks)} idle 7+ days`}</span>}
        {h.waitingOnClient > 0 && <span>{`${formatCount(h.waitingOnClient)} waiting on the client`}</span>}
        <span>
          Last activity {h.lastActivityAt ? <time dateTime={h.lastActivityAt}>{ago(h.lastActivityAt, now)}</time> : "unknown"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-slate-600">
        <span className="inline-flex flex-wrap items-center gap-1">
          <span className="text-muted">Client:</span>
          {row.derivedClient ? (
            <>
              <span data-derived-client>{row.derivedClient.clientName}</span>
              <BasisLabel basis="derived" />
            </>
          ) : (
            <span className="text-muted">—</span>
          )}
        </span>
        {row.departmentName && (
          <span>
            <span className="text-muted">Department:</span> {row.departmentName}
            {row.departmentHeadName && <span className="text-muted">{` (head: ${row.departmentHeadName})`}</span>}
          </span>
        )}
      </div>
    </li>
  );
}

export function ProjectsListPageView({ view }: { view: ProjectsListView }) {
  const now = view.generatedAt;
  const tz = view.timezone;
  const rows = view.rows;
  const total = view.totalProjects.ok ? view.totalProjects.data : null;
  const emptyText = rows.ok && rows.data.length === 0 ? (total === 0 || view.filter === "all" ? "No projects yet." : "No project matches this filter.") : undefined;
  return (
    <div className="space-y-5">
      <ExecHeader updatedAt={now} tz={tz} trailing={<ExecTabs active="projects" tabs={EXEC_TABS} />} />
      <FilterBar active={view.filter} />
      {rows.ok ? (
        <SectionCard
          title="Projects"
          icon={FolderKanban}
          basis="derived"
          subtitle="Health from DD's records by fixed rules, worst first"
          action={total !== null && view.filter !== "all" ? `${formatCount(rows.data.length)} of ${formatCount(total)}` : pluralize(rows.data.length, "project")}
          empty={emptyText}
          padded={false}
        >
          <ul className="divide-y divide-slate-100">
            {rows.data.map((row) => (
              <ProjectRow key={row.health.projectId} row={row} now={now} />
            ))}
          </ul>
        </SectionCard>
      ) : (
        <SectionCard title="Projects" icon={FolderKanban} error />
      )}
    </div>
  );
}
