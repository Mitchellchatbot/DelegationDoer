import Link from "next/link";
import { notFound } from "next/navigation";
import { users, tickets, skillProfiles, departments, managerOf } from "@/lib/mock-data";
import { Avatar } from "@/components/Avatar";
import { CapacityBar } from "@/components/CapacityBar";
import { TicketCard } from "@/components/TicketCard";
import { userCapacity } from "@/lib/capacity";
import { ROLE_LABELS } from "@/lib/auth";
import { ArrowLeft, Crown } from "lucide-react";

export default function ProfilePage({ params }: { params: { id: string } }) {
  const user = users.find((u) => u.id === params.id);
  if (!user) return notFound();
  const userDepts = user.departmentIds.map((id) => departments.find((d) => d.id === id)).filter(Boolean) as { id: string; name: string }[];
  const cap = userCapacity(user, tickets);
  const myTickets = tickets.filter((t) => t.assigneeId === user.id);
  const skills = skillProfiles.filter((s) => s.userId === user.id);
  const taskTypeHistory = Array.from(new Set(skills.flatMap((s) => s.taskTypes)));
  const manager = managerOf(user);
  const directReports = user.role === "ceo"
    ? users.filter((u) => u.role === "department_head")
    : user.role === "department_head"
      ? users.filter((u) => u.role === "worker" && u.departmentIds.some((d) => user.departmentIds.includes(d)))
      : [];

  return (
    <div className="space-y-5 max-w-5xl">
      <Link href="/team" className="text-xs text-muted hover:text-ink inline-flex items-center gap-1">
        <ArrowLeft className="w-3 h-3" /> Team
      </Link>

      <div className="card p-5 flex items-start gap-4">
        <Avatar name={user.name} size={56} />
        <div className="flex-1">
          <div className="text-lg font-medium flex items-center gap-2">
            {user.name}
            {user.role === "ceo" && <Crown className="w-4 h-4 text-warn" />}
            {user.role === "department_head" && <Crown className="w-4 h-4 text-accent" />}
          </div>
          <div className="text-sm text-muted">
            {user.email} · {ROLE_LABELS[user.role]}
            {userDepts.length > 0 && <> · {userDepts.map((d) => d.name).join(" · ")}</>}
          </div>
          <div className="mt-2 text-xs text-muted">
            {manager ? <>Reports to <Link href={`/team/${manager.id}`} className="text-accent hover:underline">{manager.name}</Link></> : "Top of the org"}
            {directReports.length > 0 && <> · {directReports.length} direct report{directReports.length === 1 ? "" : "s"}</>}
          </div>
          <div className="mt-3 max-w-sm"><CapacityBar pct={cap.pct} overSoft={cap.overSoft} overBuffer={cap.overBuffer} /></div>
        </div>
        <button className="btn">Edit profile</button>
      </div>

      {directReports.length > 0 && (
        <section className="card p-4">
          <div className="text-sm font-medium mb-3">Direct reports</div>
          <div className="flex flex-wrap gap-2">
            {directReports.map((r) => (
              <Link key={r.id} href={`/team/${r.id}`} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-surface2 border border-border hover:border-accent/40 text-xs">
                <Avatar name={r.name} size={18} /> {r.name}
                <span className="text-muted">· {ROLE_LABELS[r.role]}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="grid grid-cols-3 gap-4">
        <section className="card p-4">
          <div className="text-sm font-medium mb-3">Skills</div>
          <ul className="space-y-2">
            {skills.map((s) => (
              <li key={s.id} className="flex items-center justify-between text-sm">
                <span>{s.skillName}</span>
                <span className="text-muted text-xs">Level {s.experienceLevel}/5</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card p-4">
          <div className="text-sm font-medium mb-3">Throughput</div>
          <ul className="space-y-1.5 text-sm">
            {Object.entries(user.throughput || {}).map(([k, v]) => (
              <li key={k} className="flex items-center justify-between">
                <span className="text-muted">{k.replace(/_/g, " ")}</span>
                <span>{v}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card p-4">
          <div className="text-sm font-medium mb-3">Task types handled</div>
          <div className="flex flex-wrap gap-1.5">
            {taskTypeHistory.map((t) => <span key={t} className="badge badge-tag">{t}</span>)}
          </div>
        </section>
      </div>

      <section>
        <div className="text-sm font-medium mb-3">Assigned tickets</div>
        <div className="grid grid-cols-3 gap-3">
          {myTickets.map((t) => <TicketCard key={t.id} ticket={t} />)}
        </div>
      </section>
    </div>
  );
}
