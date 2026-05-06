import Link from "next/link";
import { projects, departments, milestones, tasks } from "@/lib/mock-data";
import { formatDate } from "@/lib/utils";
import { FolderKanban } from "lucide-react";

export default function ProjectsListPage() {
  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <h1 className="text-lg font-medium">Projects</h1>

      <div className="grid grid-cols-2 gap-3">
        {projects.map((p) => {
          const dept = departments.find((d) => d.id === p.departmentId);
          const mils = milestones.filter((m) => m.projectId === p.id);
          const next = mils.find((m) => m.status !== "done");
          const open = tasks.filter((t) => t.projectId === p.id && t.status !== "done").length;
          return (
            <Link key={p.id} href={`/projects/${p.id}`} className="card card-hover p-4 block">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-7 h-7 rounded-lg bg-surface2 grid place-items-center border border-border"><FolderKanban className="w-4 h-4 text-muted" /></div>
                <div className="text-sm font-medium">{p.name}</div>
                <span className="badge badge-tag ml-auto">{dept?.name}</span>
              </div>
              <div className="text-xs text-muted line-clamp-2">{p.description}</div>
              <div className="mt-3 flex items-center justify-between text-xs text-muted">
                <div>{open} open task{open === 1 ? "" : "s"}</div>
                {next && <div>Next: <span className="text-ink">{next.name}</span> · {formatDate(next.dueDate)}</div>}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
