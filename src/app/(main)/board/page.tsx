"use client";

import { departments, users, distinctClients, distinctWebsites } from "@/lib/mock-data";
import { useEffect, useMemo, useState } from "react";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { PriorityBadge, StalledBadge, Tag } from "@/components/Badges";
import { Avatar } from "@/components/Avatar";
import { Countdown } from "@/components/Countdown";
import { userById } from "@/lib/mock-data";
import { useCurrentUser } from "@/lib/user-context";
import { cn } from "@/lib/utils";
import type { Task, TaskStatus } from "@/lib/types";
import { Clock, Globe2, Building2, Users as UsersIcon, FolderKanban, User as UserIcon } from "lucide-react";
import { toast } from "sonner";

type BoardView = "all" | "byDept" | "mine";

const COLS: { id: TaskStatus; label: string; tone: string }[] = [
  { id: "pending", label: "Pending", tone: "border-border" },
  { id: "urgent", label: "Urgent", tone: "border-urgent/40" },
  { id: "in_progress", label: "In Progress", tone: "border-accent/30" },
  { id: "waiting_on_client", label: "Waiting on Client", tone: "border-warn/30" },
  { id: "done", label: "Done", tone: "border-ok/30" }
];

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const SORTS: Record<string, (a: Task, b: Task) => number> = {
  recent:       (a, b) => +new Date(b.lastActivityAt) - +new Date(a.lastActivityAt),
  priority:     (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
  due:          (a, b) => (a.dueDate ? +new Date(a.dueDate) : Infinity) - (b.dueDate ? +new Date(b.dueDate) : Infinity),
  longestOpen:  (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt),
  stalledFirst: (a, b) => Number(b.inactiveFlag) - Number(a.inactiveFlag) || +new Date(a.lastActivityAt) - +new Date(b.lastActivityAt)
};

export default function BoardPage() {
  const currentUser = useCurrentUser();
  // Source of truth is Supabase; mock-data is no longer used here. Empty
  // state on first paint, then a single fetch hydrates the board. After
  // that, drag-drop mutates state optimistically and persists via PATCH.
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<BoardView>("all");
  const [filterDept, setFilterDept] = useState("all");
  const [filterUser, setFilterUser] = useState("all");
  const [filterClient, setFilterClient] = useState("all");
  const [filterWebsite, setFilterWebsite] = useState("all");
  const [sort, setSort] = useState("priority");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tasks", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setTasks(data.tasks ?? []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        toast.error(`Couldn't load tasks: ${err instanceof Error ? err.message : "network error"}`);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // View buttons are shortcuts — they just preset the filters. Users can
  // still tweak after; the view chip stays highlighted as long as the
  // filters haven't been changed away from its preset.
  function selectView(next: BoardView) {
    setView(next);
    if (next === "all") {
      setFilterDept("all");
      setFilterUser("all");
    } else if (next === "byDept") {
      // Default to the actor's first home dept; CEO with no home dept gets
      // the first dept in the list as a starting point.
      setFilterDept(currentUser.departmentIds[0] ?? departments[0]?.id ?? "all");
      setFilterUser("all");
    } else if (next === "mine") {
      setFilterDept("all");
      setFilterUser(currentUser.id);
    }
  }

  const clientOptions = useMemo(() => distinctClients(), []);
  const websiteOptions = useMemo(() => distinctWebsites(), []);

  const visible = useMemo(() => tasks.filter((t) =>
    (filterDept === "all" || t.departmentId === filterDept) &&
    (filterUser === "all" || t.assigneeId === filterUser) &&
    (filterClient === "all" || (filterClient === "__internal" ? !t.clientName : t.clientName === filterClient)) &&
    (filterWebsite === "all" || (filterWebsite === "__internal" ? !t.website : t.website === filterWebsite))
  ), [tasks, filterDept, filterUser, filterClient, filterWebsite]);

  const grouped = useMemo(() => {
    const map: Record<TaskStatus, Task[]> = {
      pending: [], in_progress: [], urgent: [], waiting_on_client: [], done: []
    };
    visible.forEach((t) => map[t.status].push(t));
    const sorter = SORTS[sort] ?? SORTS.priority;
    Object.keys(map).forEach((k) => map[k as TaskStatus].sort(sorter));
    return map;
  }, [visible, sort]);

  async function onDragEnd(result: DropResult) {
    if (!result.destination) return;
    const dest = result.destination.droppableId as TaskStatus;
    const id = result.draggableId;
    const before = tasks.find((t) => t.id === id);
    if (!before || before.status === dest) return;

    // Optimistic
    setTasks((cur) => cur.map((t) => t.id === id ? { ...t, status: dest, lastActivityAt: new Date().toISOString() } : t));
    // Persist
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: dest })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);

      if (dest === "done") {
        // Server returns { slack: { creatorDm, channelPost } } on completion.
        const slack = data.slack as { creatorDm?: { ok: boolean; error?: string }; channelPost?: { ok: boolean; error?: string } } | null;
        const dm = slack?.creatorDm;
        const ch = slack?.channelPost;
        if (dm?.ok || ch?.ok) {
          toast.success(`✅ Marked done · ${before.title}`);
        } else if (dm && dm.error !== "skipped") {
          toast.warning(`Marked done, but Slack failed: ${dm.error}`);
        } else {
          toast.success(`Marked done · ${before.title}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network error";
      toast.error(`Status change failed: ${msg}`);
      // Revert on failure
      setTasks((cur) => cur.map((t) => t.id === id ? { ...t, status: before.status } : t));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-lg font-medium">Board <span className="text-muted text-sm">· {visible.length}</span></h1>
        <div className="inline-flex items-center rounded-xl border border-border bg-surface p-0.5">
          <ViewBtn active={view === "all"} onClick={() => selectView("all")} icon={<UsersIcon className="w-3.5 h-3.5" />} label="All team" />
          <ViewBtn active={view === "byDept"} onClick={() => selectView("byDept")} icon={<FolderKanban className="w-3.5 h-3.5" />} label="By department" />
          <ViewBtn active={view === "mine"} onClick={() => selectView("mine")} icon={<UserIcon className="w-3.5 h-3.5" />} label="My tasks" />
        </div>
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

function ViewBtn({ active, onClick, icon, label }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors",
        active
          ? "bg-accent text-white"
          : "text-muted hover:text-ink hover:bg-surface2"
      )}
    >
      {icon}
      {label}
    </button>
  );
}
