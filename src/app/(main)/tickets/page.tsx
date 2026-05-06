"use client";

import { tickets as allTickets, departments, users, distinctClients, distinctWebsites } from "@/lib/mock-data";
import { TicketCard } from "@/components/TicketCard";
import { useMemo, useState } from "react";
import type { Ticket } from "@/lib/types";

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const SORTS: Record<string, (a: Ticket, b: Ticket) => number> = {
  recent:    (a, b) => +new Date(b.lastActivityAt) - +new Date(a.lastActivityAt),
  oldest:    (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt),
  priority:  (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
  due:       (a, b) => (a.dueDate ? +new Date(a.dueDate) : Infinity) - (b.dueDate ? +new Date(b.dueDate) : Infinity),
  longestOpen: (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt), // synonym of "oldest" but framed by intent
  stalledFirst: (a, b) => Number(b.inactiveFlag) - Number(a.inactiveFlag) || +new Date(a.lastActivityAt) - +new Date(b.lastActivityAt),
  client:    (a, b) => (a.clientName ?? "~").localeCompare(b.clientName ?? "~")
};

export default function TicketsListPage() {
  const [status, setStatus] = useState<string>("all");
  const [dept, setDept] = useState<string>("all");
  const [assignee, setAssignee] = useState<string>("all");
  const [client, setClient] = useState<string>("all");
  const [website, setWebsite] = useState<string>("all");
  const [sort, setSort] = useState<string>("recent");

  const clientOptions = useMemo(() => distinctClients(), []);
  const websiteOptions = useMemo(() => distinctWebsites(), []);

  const filtered = useMemo(() => {
    let list = [...allTickets];
    if (status !== "all") list = list.filter((t) => t.status === status);
    if (dept !== "all") list = list.filter((t) => t.departmentId === dept);
    if (assignee !== "all") list = list.filter((t) => t.assigneeId === assignee);
    if (client !== "all") list = list.filter((t) => client === "__internal" ? !t.clientName : t.clientName === client);
    if (website !== "all") list = list.filter((t) => website === "__internal" ? !t.website : t.website === website);
    list.sort(SORTS[sort] ?? SORTS.recent);
    return list;
  }, [status, dept, assignee, client, website, sort]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">All tickets <span className="text-muted text-sm">· {filtered.length}</span></h1>
      </div>

      <div className="card p-3 flex items-center gap-2 flex-wrap">
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
            <TicketCard ticket={t} />
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
