import Link from "next/link";
import { notFound } from "next/navigation";
import { projects, milestones, raciEntries, users, tickets, departments } from "@/lib/mock-data";
import { TicketCard } from "@/components/TicketCard";
import { RACITable } from "@/components/RACITable";
import { formatDate } from "@/lib/utils";
import { CheckCircle2, Circle, Clock, ArrowLeft } from "lucide-react";
import type { MilestoneStatus } from "@/lib/types";

export default function ProjectDetailPage({ params }: { params: { id: string } }) {
  const project = projects.find((p) => p.id === params.id);
  if (!project) return notFound();

  const dept = departments.find((d) => d.id === project.departmentId);
  const mils = milestones.filter((m) => m.projectId === project.id);
  const projectTickets = tickets.filter((t) => t.projectId === project.id);
  const raci = raciEntries.filter((r) => r.projectId === project.id);

  return (
    <div className="space-y-5 max-w-6xl">
      <Link href="/projects" className="text-xs text-muted hover:text-ink inline-flex items-center gap-1">
        <ArrowLeft className="w-3 h-3" /> All projects
      </Link>

      <div>
        <div className="text-xs text-muted">{dept?.name}</div>
        <h1 className="text-xl font-medium">{project.name}</h1>
        <p className="text-sm text-muted mt-1">{project.description}</p>
      </div>

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
          <button className="btn">Export CSV</button>
        </div>
        <RACITable raci={raci} users={users} />
      </section>

      <section>
        <div className="text-sm font-medium mb-3">Tickets <span className="text-muted">· {projectTickets.length}</span></div>
        <div className="grid grid-cols-3 gap-3">
          {projectTickets.map((t) => <TicketCard key={t.id} ticket={t} />)}
        </div>
      </section>
    </div>
  );
}

function MilestoneIcon({ status }: { status: MilestoneStatus }) {
  if (status === "done") return <CheckCircle2 className="w-4 h-4 text-ok" />;
  if (status === "in_progress") return <Clock className="w-4 h-4 text-accent" />;
  return <Circle className="w-4 h-4 text-muted" />;
}
