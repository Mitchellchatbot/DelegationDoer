import Link from "next/link";
import { projects, departments, milestones, tasks } from "@/lib/mock-data";
import { formatDate } from "@/lib/utils";
import { FolderKanban } from "lucide-react";

// Cycle a small palette across project cards so a wall of projects stays
// visually distinguishable. Restricted to the blue→purple family.
const PALETTE = [
  { ring: "ring-blue-300/40",   from: "from-blue-50",    iconBg: "bg-blue-500" },
  { ring: "ring-indigo-300/40", from: "from-indigo-50",  iconBg: "bg-indigo-500" },
  { ring: "ring-indigo-300/40", from: "from-indigo-50",  iconBg: "bg-indigo-500" },
  { ring: "ring-blue-300/40", from: "from-blue-50",  iconBg: "bg-blue-500" }
];

export default function ProjectsListPage() {
  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <header
        className="relative overflow-hidden rounded-2xl border border-white/60 shadow-soft p-5"
        style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #C7D2FE 50%, #C7D2FE 100%)" }}
      >
        <div className="relative flex items-center gap-3">
          <span className="text-3xl">📁</span>
          <div>
            <h1 className="text-xl font-semibold">Projects</h1>
            <p className="text-sm text-ink/60 mt-0.5">All active engagements across the org.</p>
          </div>
        </div>
        <div
          aria-hidden
          className="absolute -top-10 right-12 w-32 h-32 rounded-full"
          style={{ background: "radial-gradient(circle, rgba(99,102,241,0.18), transparent 70%)" }}
        />
      </header>

      <div className="grid grid-cols-2 gap-3">
        {projects.map((p, i) => {
          const dept = departments.find((d) => d.id === p.departmentId);
          const mils = milestones.filter((m) => m.projectId === p.id);
          const next = mils.find((m) => m.status !== "done");
          const open = tasks.filter((t) => t.projectId === p.id && t.status !== "done").length;
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
                {dept && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/70 border border-border/60 text-ink/70">
                    {dept.name}
                  </span>
                )}
              </div>
              <div className="text-xs text-ink/60 line-clamp-2">{p.description}</div>
              <div className="mt-3 flex items-center justify-between text-xs">
                <div className="text-ink/60">
                  <span className="font-semibold tabular-nums text-ink">{open}</span> open task{open === 1 ? "" : "s"}
                </div>
                {next && (
                  <div className="text-ink/60">
                    Next: <span className="text-ink font-medium">{next.name}</span>
                    <span className="text-ink/50"> · {formatDate(next.dueDate)}</span>
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
    </div>
  );
}
