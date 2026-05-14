"use client";

import { TaskCard } from "@/components/TaskCard";
import { PageHero } from "@/components/PageHero";
import { useMemo, useState } from "react";
import { ListTodo } from "lucide-react";
import type { Task } from "@/lib/types";
import { useTeam } from "@/lib/team-context";

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const SORTS: Record<string, (a: Task, b: Task) => number> = {
  recent:    (a, b) => +new Date(b.lastActivityAt) - +new Date(a.lastActivityAt),
  oldest:    (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt),
  priority:  (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
  due:       (a, b) => (a.dueDate ? +new Date(a.dueDate) : Infinity) - (b.dueDate ? +new Date(b.dueDate) : Infinity),
  longestOpen: (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt), // synonym of "oldest" but framed by intent
  stalledFirst: (a, b) => Number(b.inactiveFlag) - Number(a.inactiveFlag) || +new Date(a.lastActivityAt) - +new Date(b.lastActivityAt),
  client:    (a, b) => (a.clientName ?? "~").localeCompare(b.clientName ?? "~")
};

export default function TasksListPage() {
  const { users, departments, tasks: allTasks } = useTeam();
  const [status, setStatus] = useState<string>("all");
  const [dept, setDept] = useState<string>("all");
  const [assignee, setAssignee] = useState<string>("all");
  const [client, setClient] = useState<string>("all");
  const [website, setWebsite] = useState<string>("all");
  const [sort, setSort] = useState<string>("recent");

  const clientOptions = useMemo(
    () => Array.from(new Set(allTasks.map((t) => t.clientName).filter(Boolean) as string[])).sort(),
    [allTasks]
  );
  const websiteOptions = useMemo(
    () => Array.from(new Set(allTasks.map((t) => t.website).filter(Boolean) as string[])).sort(),
    [allTasks]
  );

  const filtered = useMemo(() => {
    let list = [...allTasks];
    if (status !== "all") list = list.filter((t) => t.status === status);
    if (dept !== "all") list = list.filter((t) => t.departmentId === dept);
    if (assignee !== "all") list = list.filter((t) => t.assigneeId === assignee);
    if (client !== "all") list = list.filter((t) => client === "__internal" ? !t.clientName : t.clientName === client);
    if (website !== "all") list = list.filter((t) => website === "__internal" ? !t.website : t.website === website);
    list.sort(SORTS[sort] ?? SORTS.recent);
    return list;
  }, [allTasks, status, dept, assignee, client, website, sort]);

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <PageHero
        eyebrow={`All tasks · ${filtered.length}`}
        headline={["Filter and ", { accent: "sort the queue" }]}
        subtitle="Slice the org's task list by status, department, assignee, client, or website."
        icon={<ListTodo />}
        iconTone="indigo"
      />

      <div className="rounded-2xl border border-white/60 shadow-soft bg-white/70 backdrop-blur-sm p-3 flex items-center gap-2 flex-wrap">
        <Select label="Status" value={status} onChange={setStatus} options={[
          ["all", "All statuses"], ["pending", "Pending"], ["in_progress", "In progress"],
          ["urgent", "Urgent"], ["waiting_on_client", "Waiting on client"], ["done", "Done"]
        ]} />
        <Select label="Department" value={dept} onChange={setDept} options={[["all", "All departments"], ...departments.map((d) => [d.id, d.name] as [string, string])]} />
        <Select label="Assignee" value={assignee} onChange={setAssignee} options={[["all", "Anyone"], ...users.map((u) => [u.id, u.name] as [string, string])]} />
        <Select label="Client" value={client} onChange={setClient} options={[
          ["all", "All clients"],
          ["__internal", "Internal (none)"],
          ...clientOptions.map((c) => [c, c] as [string, string])
        ]} />
        <Select label="Website" value={website} onChange={setWebsite} options={[
          ["all", "All websites"],
          ["__internal", "(none)"],
          ...websiteOptions.map((w) => [w, w] as [string, string])
        ]} />
        <div className="ml-auto">
          <Select label="Sort" value={sort} onChange={setSort} options={[
            ["recent", "Recent activity"],
            ["priority", "Priority"],
            ["due", "Due date soonest"],
            ["oldest", "Oldest first"],
            ["longestOpen", "Longest open"],
            ["stalledFirst", "Stalled first"],
            ["client", "Client A→Z"]
          ]} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {filtered.map((t, i) => (
          <div key={t.id} className="anim-fade-in-up" style={{ animationDelay: `${Math.min(i * 25, 400)}ms` }}>
            <TaskCard task={t} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Select({ label, value, onChange, options }: {
  label: string; value: string; onChange: (s: string) => void; options: [string, string][];
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      {label}
      <select className="input py-1.5" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}
