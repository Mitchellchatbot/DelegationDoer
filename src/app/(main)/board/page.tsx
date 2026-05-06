"use client";

import { tickets as initialTickets, departments, users, distinctClients, distinctWebsites } from "@/lib/mock-data";
import { useMemo, useState } from "react";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { PriorityBadge, StalledBadge, Tag } from "@/components/Badges";
import { Avatar } from "@/components/Avatar";
import { Countdown } from "@/components/Countdown";
import { userById } from "@/lib/mock-data";
import { cn } from "@/lib/utils";
import type { Ticket, TicketStatus } from "@/lib/types";
import { Clock, Globe2, Building2 } from "lucide-react";

const COLS: { id: TicketStatus; label: string; tone: string }[] = [
  { id: "pending", label: "Pending", tone: "border-border" },
  { id: "urgent", label: "Urgent", tone: "border-urgent/40" },
  { id: "in_progress", label: "In Progress", tone: "border-accent/30" },
  { id: "waiting_on_client", label: "Waiting on Client", tone: "border-warn/30" },
  { id: "done", label: "Done", tone: "border-ok/30" }
];

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const SORTS: Record<string, (a: Ticket, b: Ticket) => number> = {
  recent:       (a, b) => +new Date(b.lastActivityAt) - +new Date(a.lastActivityAt),
  priority:     (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
  due:          (a, b) => (a.dueDate ? +new Date(a.dueDate) : Infinity) - (b.dueDate ? +new Date(b.dueDate) : Infinity),
  longestOpen:  (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt),
  stalledFirst: (a, b) => Number(b.inactiveFlag) - Number(a.inactiveFlag) || +new Date(a.lastActivityAt) - +new Date(b.lastActivityAt)
};

export default function BoardPage() {
  const [tickets, setTickets] = useState<Ticket[]>(initialTickets);
  const [filterDept, setFilterDept] = useState("all");
  const [filterUser, setFilterUser] = useState("all");
  const [filterClient, setFilterClient] = useState("all");
  const [filterWebsite, setFilterWebsite] = useState("all");
  const [sort, setSort] = useState("priority");

  const clientOptions = useMemo(() => distinctClients(), []);
  const websiteOptions = useMemo(() => distinctWebsites(), []);

  const visible = useMemo(() => tickets.filter((t) =>
    (filterDept === "all" || t.departmentId === filterDept) &&
    (filterUser === "all" || t.assigneeId === filterUser) &&
    (filterClient === "all" || (filterClient === "__internal" ? !t.clientName : t.clientName === filterClient)) &&
    (filterWebsite === "all" || (filterWebsite === "__internal" ? !t.website : t.website === filterWebsite))
  ), [tickets, filterDept, filterUser, filterClient, filterWebsite]);

  const grouped = useMemo(() => {
    const map: Record<TicketStatus, Ticket[]> = {
      pending: [], in_progress: [], urgent: [], waiting_on_client: [], done: []
    };
    visible.forEach((t) => map[t.status].push(t));
    const sorter = SORTS[sort] ?? SORTS.priority;
    Object.keys(map).forEach((k) => map[k as TicketStatus].sort(sorter));
    return map;
  }, [visible, sort]);

  async function onDragEnd(result: DropResult) {
    if (!result.destination) return;
    const dest = result.destination.droppableId as TicketStatus;
    const id = result.draggableId;
    const before = tickets.find((t) => t.id === id);
    if (!before || before.status === dest) return;

    // Optimistic
    setTickets((cur) => cur.map((t) => t.id === id ? { ...t, status: dest, lastActivityAt: new Date().toISOString() } : t));
    // Persist
    try {
      await fetch(`/api/tickets/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: dest })
      });
    } catch {
      // Revert on failure
      setTickets((cur) => cur.map((t) => t.id === id ? { ...t, status: before.status } : t));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Board <span className="text-muted text-sm">· {visible.length}</span></h1>
      </div>

      <div className="card p-3 flex items-center gap-2 flex-wrap">
        <Select label="Dept" value={filterDept} onChange={setFilterDept} options={[
          ["all", "All departments"], ...departments.map((d) => [d.id, d.name] as [string, string])
        ]} />
        <Select label="Assignee" value={filterUser} onChange={setFilterUser} options={[
          ["all", "Anyone"], ...users.map((u) => [u.id, u.name] as [string, string])
        ]} />
        <Select label="Client" value={filterClient} onChange={setFilterClient} options={[
          ["all", "All clients"], ["__internal", "Internal (none)"],
          ...clientOptions.map((c) => [c, c] as [string, string])
        ]} />
        <Select label="Website" value={filterWebsite} onChange={setFilterWebsite} options={[
          ["all", "All websites"], ["__internal", "(none)"],
          ...websiteOptions.map((w) => [w, w] as [string, string])
        ]} />
        <div className="ml-auto">
          <Select label="Sort" value={sort} onChange={setSort} options={[
            ["priority", "Priority"],
            ["recent", "Recent activity"],
            ["due", "Due soonest"],
            ["longestOpen", "Longest open"],
            ["stalledFirst", "Stalled first"]
          ]} />
        </div>
      </div>

      <DragDropContext onDragEnd={onDragEnd}>
        <div className="grid grid-cols-5 gap-3">
          {COLS.map((col, colIdx) => (
            <div
              key={col.id}
              className={cn("rounded-2xl bg-surface/40 border anim-fade-in-up", col.tone)}
              style={{ animationDelay: `${colIdx * 40}ms` }}
            >
              <div className="px-3 py-2 flex items-center justify-between">
                <div className="text-sm font-medium">{col.label}</div>
                <div className="text-xs text-muted">{grouped[col.id].length}</div>
              </div>
              <Droppable droppableId={col.id}>
                {(prov, snap) => (
                  <div ref={prov.innerRef} {...prov.droppableProps}
                    className={cn("p-2 space-y-2 min-h-[60vh] transition-colors", snap.isDraggingOver && "bg-surface2/50")}>
                    {grouped[col.id].map((t, i) => (
                      <Draggable draggableId={t.id} index={i} key={t.id}>
                        {(p, s) => (
                          <div ref={p.innerRef} {...p.draggableProps} {...p.dragHandleProps}
                            style={{ ...p.draggableProps.style, animationDelay: `${i * 30}ms` }}
                            className={cn(
                              "card p-3 anim-fade-in-up transition-shadow hover:shadow-lift",
                              t.inactiveFlag && "border-stalled/50",
                              s.isDragging && "ring-1 ring-accent/40 shadow-lift"
                            )}>
                            <div className="flex items-start justify-between gap-2">
                              <div className="text-sm leading-snug">{t.title}</div>
                              <PriorityBadge priority={t.priority} />
                            </div>
                            {(t.clientName || t.website) && (
                              <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-muted">
                                {t.clientName && (
                                  <span className="inline-flex items-center gap-0.5"><Building2 className="w-3 h-3" />{t.clientName}</span>
                                )}
                                {t.website && (
                                  <span className="inline-flex items-center gap-0.5"><Globe2 className="w-3 h-3" />{t.website}</span>
                                )}
                              </div>
                            )}
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {t.tags.slice(0, 2).map((x) => <Tag key={x}>{x}</Tag>)}
                              {t.inactiveFlag && <StalledBadge />}
                            </div>
                            <div className="mt-2 flex items-center justify-between text-xs text-muted">
                              <div className="flex items-center gap-1.5">
                                {t.assigneeId
                                  ? <Avatar name={userById(t.assigneeId)!.name} size={18} />
                                  : <span>—</span>}
                              </div>
                              <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /><Countdown iso={t.dueDate} /></span>
                            </div>
                          </div>
                        )}
                      </Draggable>
                    ))}
                    {prov.placeholder}
                  </div>
                )}
              </Droppable>
            </div>
          ))}
        </div>
      </DragDropContext>
    </div>
  );
}

function Select({ label, value, onChange, options }: {
  label: string; value: string; onChange: (s: string) => void; options: [string, string][];
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      {label}
      <select className="input py-1.5 w-auto" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}
