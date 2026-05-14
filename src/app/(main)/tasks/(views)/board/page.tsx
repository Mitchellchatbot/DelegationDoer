"use client";

import { useEffect, useMemo, useState } from "react";
import { useTeam } from "@/lib/team-context";
import { createPortal } from "react-dom";
import { useSearchParams, useRouter } from "next/navigation";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { PriorityBadge, StalledBadge, Tag } from "@/components/Badges";
import { Avatar } from "@/components/Avatar";
import { PersonAvatar } from "@/components/PersonAvatar";
import { Countdown } from "@/components/Countdown";
import { useCurrentUser } from "@/lib/user-context";
import { cn } from "@/lib/utils";
import type { Task, TaskStatus, User } from "@/lib/types";
import {
  Clock, Globe2, Building2, Users as UsersIcon, FolderKanban, User as UserIcon,
  Layers, Briefcase, Layout
} from "lucide-react";
import { toast } from "sonner";

// Two independent axes:
//
//   `view`     — which subset of tasks is visible.
//                "all"     → every task
//                "byDept"  → tasks owned by a single department (filterDept)
//                "mine"    → tasks assigned to the current user
//
//   `groupBy`  — what each column represents.
//                "status"  → 5 columns, one per task_status enum
//                "client"  → one column per distinct clientName + Internal
//                "person"  → one column per user (filtered by personDept if set)
//
// Drag behavior depends on groupBy: dragging changes the field that the
// columns represent (status, client_name, or assignee_id).

type BoardView = "all" | "byDept" | "mine";
type GroupBy = "status" | "client" | "person";

interface Column {
  id: string;        // droppable id; "__internal" / "__unassigned" for null buckets
  label: string;
  tone: string;
  user?: User;       // populated only in person mode (for the avatar in the header)
}

const STATUS_COLS: Column[] = [
  { id: "pending",            label: "Pending",            tone: "border-border" },
  { id: "urgent",             label: "Urgent",             tone: "border-urgent/40" },
  { id: "in_progress",        label: "In Progress",        tone: "border-accent/30" },
  { id: "waiting_on_client",  label: "Waiting on Client",  tone: "border-warn/30" },
  { id: "done",               label: "Done",               tone: "border-ok/30" }
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
  const { users, departments, userById } = useTeam();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [, setLoading] = useState(true);

  // View / filter state — `?dept=DEPT_ID` in the URL pre-filters the board
  // to that department on first paint. Used by the "View tasks" deep links
  // on the Leader Console's Departments tab.
  const initialDept = searchParams.get("dept") ?? "all";
  const [view, setView] = useState<BoardView>(initialDept !== "all" ? "byDept" : "all");
  const [filterDept, setFilterDept] = useState(initialDept);
  const [filterUser, setFilterUser] = useState("all");
  const [filterClient, setFilterClient] = useState("all");
  const [filterWebsite, setFilterWebsite] = useState("all");
  const [sort, setSort] = useState("priority");

  // Column-axis state. Default to "person" — the Leader asked to see the
  // board organized by who's doing what, not by status, on first load.
  const [groupBy, setGroupBy] = useState<GroupBy>("person");
  // Only used when groupBy === "person": which department's people to show
  // as columns. "all" = everyone the actor can see.
  const [personDept, setPersonDept] = useState("all");
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);

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

  function selectView(next: BoardView) {
    setView(next);
    if (next === "all") {
      setFilterDept("all");
      setFilterUser("all");
    } else if (next === "byDept") {
      setFilterDept(currentUser.departmentIds[0] ?? departments[0]?.id ?? "all");
      setFilterUser("all");
    } else if (next === "mine") {
      setFilterDept("all");
      setFilterUser(currentUser.id);
    }
  }

  const clientOptions = useMemo(
    () => Array.from(new Set(tasks.map((t) => t.clientName).filter(Boolean) as string[])).sort(),
    [tasks]
  );
  const websiteOptions = useMemo(
    () => Array.from(new Set(tasks.map((t) => t.website).filter(Boolean) as string[])).sort(),
    [tasks]
  );

  const visible = useMemo(() => tasks.filter((t) =>
    (filterDept === "all" || t.departmentId === filterDept) &&
    (filterUser === "all" || t.assigneeId === filterUser) &&
    (filterClient === "all" || (filterClient === "__internal" ? !t.clientName : t.clientName === filterClient)) &&
    (filterWebsite === "all" || (filterWebsite === "__internal" ? !t.website : t.website === filterWebsite))
  ), [tasks, filterDept, filterUser, filterClient, filterWebsite]);

  // Build columns from the current groupBy + visible tasks.
  const columns: Column[] = useMemo(() => {
    if (groupBy === "status") return STATUS_COLS;

    if (groupBy === "client") {
      const seen = new Set<string>();
      visible.forEach((t) => { if (t.clientName) seen.add(t.clientName); });
      const cols: Column[] = Array.from(seen).sort().map((name) => ({
        id: name,
        label: name,
        tone: "border-indigo-300/40"
      }));
      cols.push({ id: "__internal", label: "Internal", tone: "border-slate-300/40" });
      return cols;
    }

    // person mode
    let people = users;
    if (personDept !== "all") {
      people = people.filter((u) => u.departmentIds.includes(personDept));
    }
    const cols: Column[] = people.map((u) => ({
      id: u.id,
      label: u.name,
      tone: "border-indigo-300/40",
      user: u
    }));
    cols.push({ id: "__unassigned", label: "Unassigned", tone: "border-slate-300/40" });
    return cols;
  }, [groupBy, visible, personDept]);

  // Group visible tasks by the column they belong to.
  const grouped: Record<string, Task[]> = useMemo(() => {
    const map: Record<string, Task[]> = {};
    columns.forEach((c) => { map[c.id] = []; });

    visible.forEach((t) => {
      let key: string | null = null;
      if (groupBy === "status") key = t.status;
      else if (groupBy === "client") key = t.clientName ?? "__internal";
      else if (groupBy === "person") key = t.assigneeId ?? "__unassigned";
      if (key && map[key] !== undefined) map[key].push(t);
    });

    const sorter = SORTS[sort] ?? SORTS.priority;
    Object.values(map).forEach((arr) => arr.sort(sorter));
    return map;
  }, [columns, visible, groupBy, sort]);

  async function onDragEnd(result: DropResult) {
    if (!result.destination) return;
    const dest = result.destination.droppableId;
    const id = result.draggableId;
    const before = tasks.find((t) => t.id === id);
    if (!before) return;

    if (groupBy === "status") {
      if (before.status === dest) return;
      const nextStatus = dest as TaskStatus;
      setTasks((cur) => cur.map((t) => t.id === id ? { ...t, status: nextStatus, lastActivityAt: new Date().toISOString() } : t));
      try {
        const res = await fetch(`/api/tasks/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: nextStatus })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
        if (nextStatus === "done") {
          const slack = data.slack as { creatorDm?: { ok: boolean; error?: string }; channelPost?: { ok: boolean; error?: string } } | null;
          const dm = slack?.creatorDm;
          const ch = slack?.channelPost;
          if (dm?.ok || ch?.ok) toast.success(`✅ Marked done · ${before.title}`);
          else if (dm && dm.error !== "skipped") toast.warning(`Marked done, but Slack failed: ${dm.error}`);
          else toast.success(`Marked done · ${before.title}`);

          // Surface skill XP gains in a follow-up toast so the user sees
          // which tags their task fed into. Hits the same pattern as the
          // task-detail "Move status" path.
          const gains = data.skillGains as { tag: string; gain: number; total: number }[] | undefined;
          if (gains && gains.length > 0) {
            const list = gains.map((g) => `+${g.gain} #${g.tag}`).join(" · ");
            toast.success(`✨ Skill XP: ${list}`, { duration: 4500 });
          }
        }
      } catch (err) {
        toast.error(`Status change failed: ${err instanceof Error ? err.message : "network error"}`);
        setTasks((cur) => cur.map((t) => t.id === id ? { ...t, status: before.status } : t));
      }
      return;
    }

    if (groupBy === "person") {
      const nextAssignee = dest === "__unassigned" ? null : dest;
      if (before.assigneeId === nextAssignee) return;
      setTasks((cur) => cur.map((t) => t.id === id ? { ...t, assigneeId: nextAssignee, lastActivityAt: new Date().toISOString() } : t));
      try {
        const res = await fetch(`/api/tasks/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assigneeId: nextAssignee })
        });
        if (!res.ok) {
          const d = await res.json().catch(() => null);
          throw new Error(d?.error ?? `failed (${res.status})`);
        }
        const target = nextAssignee ? userById(nextAssignee) : null;
        toast.success(target ? `Reassigned to ${target.name}` : "Unassigned");
      } catch (err) {
        toast.error(`Reassign failed: ${err instanceof Error ? err.message : "network error"}`);
        setTasks((cur) => cur.map((t) => t.id === id ? { ...t, assigneeId: before.assigneeId } : t));
      }
      return;
    }

    if (groupBy === "client") {
      const nextClient = dest === "__internal" ? null : dest;
      if (before.clientName === nextClient) return;
      setTasks((cur) => cur.map((t) => t.id === id ? { ...t, clientName: nextClient, lastActivityAt: new Date().toISOString() } : t));
      try {
        const res = await fetch(`/api/tasks/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientName: nextClient })
        });
        if (!res.ok) {
          const d = await res.json().catch(() => null);
          throw new Error(d?.error ?? `failed (${res.status})`);
        }
        toast.success(nextClient ? `Moved to ${nextClient}` : "Marked internal");
      } catch (err) {
        toast.error(`Move failed: ${err instanceof Error ? err.message : "network error"}`);
        setTasks((cur) => cur.map((t) => t.id === id ? { ...t, clientName: before.clientName } : t));
      }
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-lg font-medium">Board <span className="text-muted text-sm">· {visible.length}</span></h1>

        <div className="flex items-center gap-2 flex-wrap">
          {/* View axis */}
          <div className="inline-flex items-center rounded-xl border border-border bg-surface p-0.5">
            <ViewBtn active={view === "all"}    onClick={() => selectView("all")}    icon={<UsersIcon className="w-3.5 h-3.5" />} label="All team" />
            <ViewBtn active={view === "byDept"} onClick={() => selectView("byDept")} icon={<FolderKanban className="w-3.5 h-3.5" />} label="By department" />
            <ViewBtn active={view === "mine"}   onClick={() => selectView("mine")}   icon={<UserIcon className="w-3.5 h-3.5" />} label="My tasks" />
          </div>

          {/* Group-by axis */}
          <div className="inline-flex items-center rounded-xl border border-border bg-surface p-0.5">
            <ViewBtn active={groupBy === "status"} onClick={() => setGroupBy("status")} icon={<Layout className="w-3.5 h-3.5" />}    label="By status" />
            <ViewBtn active={groupBy === "client"} onClick={() => setGroupBy("client")} icon={<Briefcase className="w-3.5 h-3.5" />} label="By client" />
            <ViewBtn active={groupBy === "person"} onClick={() => setGroupBy("person")} icon={<UsersIcon className="w-3.5 h-3.5" />} label="By person" />
          </div>
        </div>
      </div>

      {/* Compact filter bar: only the two most-used controls (department
          scope when grouped by person, sort) sit inline. The rest live
          behind a "More filters" toggle so the board doesn't open with
          five selects fighting for attention. */}
      <div className="card p-3 flex items-center gap-2 flex-wrap">
        {groupBy === "person" && (
          <Select label="Team" value={personDept} onChange={setPersonDept} options={[
            ["all", "Everyone"], ...departments.map((d) => [d.id, d.name] as [string, string])
          ]} />
        )}
        <Select label="Sort" value={sort} onChange={setSort} options={[
          ["priority", "Priority"],
          ["recent", "Recent activity"],
          ["due", "Due soonest"],
          ["longestOpen", "Longest open"],
          ["stalledFirst", "Stalled first"]
        ]} />
        <button
          type="button"
          onClick={() => setMoreFiltersOpen((v) => !v)}
          className="ml-auto inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-border text-muted hover:text-ink hover:bg-surface2 transition-colors"
        >
          {moreFiltersOpen ? "Hide filters" : "More filters"}
        </button>
      </div>

      {moreFiltersOpen && (
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
        </div>
      )}

      <DragDropContext onDragEnd={onDragEnd}>
        {/* Horizontal scroll once column count exceeds what fits. Person
            mode regularly has 10+ columns; status mode always has 5. */}
        <div className="overflow-x-auto pb-2">
          <div className="flex gap-3 min-w-max">
            {columns.map((col, colIdx) => (
              <div
                key={col.id}
                className={cn("rounded-2xl bg-surface/40 border anim-fade-in-up shrink-0 w-72", col.tone)}
                style={{ animationDelay: `${colIdx * 30}ms` }}
              >
                <div className="px-3 py-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {col.user && <PersonAvatar userId={col.user.id} name={col.user.name} imageUrl={col.user.avatarUrl} size={20} />}
                    {groupBy === "client" && col.id !== "__internal" && (
                      <Briefcase className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                    )}
                    <div className="text-sm font-medium truncate">{col.label}</div>
                  </div>
                  <div className="text-xs text-muted shrink-0 tabular-nums">{grouped[col.id]?.length ?? 0}</div>
                </div>
                <Droppable droppableId={col.id}>
                  {(prov, snap) => (
                    <div
                      ref={prov.innerRef}
                      {...prov.droppableProps}
                      // Cap column height so tasks scroll vertically WITHIN
                      // the column. Without the cap, a busy column pushes the
                      // board's horizontal scrollbar off-screen and you have
                      // to scroll all the way down before you can scroll
                      // sideways. 70vh keeps the bottom of the board near
                      // the viewport's lower edge regardless of column size.
                      className={cn(
                        "p-2 space-y-2 min-h-[300px] max-h-[70vh] overflow-y-auto transition-colors",
                        snap.isDraggingOver && "bg-surface2/50"
                      )}
                    >
                      {(grouped[col.id] ?? []).map((t, i) => (
                        <Draggable draggableId={t.id} index={i} key={t.id}>
                          {(p, s) => {
                            const card = (
                              <div
                                ref={p.innerRef}
                                {...p.draggableProps}
                                {...p.dragHandleProps}
                                // dnd suppresses onClick automatically when
                                // a real drag occurred, so plain onClick is
                                // safe — it only fires on actual clicks.
                                onClick={() => {
                                  if (s.isDragging) return;
                                  router.push(`/tasks/${t.id}`);
                                }}
                                style={{
                                  ...p.draggableProps.style,
                                  animationDelay: `${i * 30}ms`,
                                  ...(s.isDragging ? { zIndex: 9999 } : null),
                                  cursor: s.isDragging ? "grabbing" : "pointer"
                                }}
                                className={cn(
                                  "card p-3 anim-fade-in-up transition-shadow hover:shadow-lift",
                                  t.inactiveFlag && "border-stalled/50",
                                  s.isDragging && "ring-1 ring-accent/40 shadow-lift"
                                )}
                              >
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
                                      ? <PersonAvatar userId={t.assigneeId} name={userById(t.assigneeId)?.name ?? ""} size={18} />
                                      : <span>—</span>}
                                  </div>
                                  <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /><Countdown iso={t.dueDate} /></span>
                                </div>
                              </div>
                            );
                            // Portal the dragged card to <body> so it can
                            // never be trapped behind a column's stacking
                            // context. Only when actively dragging.
                            return s.isDragging && typeof window !== "undefined"
                              ? createPortal(card, document.body)
                              : card;
                          }}
                        </Draggable>
                      ))}
                      {prov.placeholder}
                      {(grouped[col.id]?.length ?? 0) === 0 && (
                        <div className="text-[11px] text-muted italic text-center py-4">No tasks</div>
                      )}
                    </div>
                  )}
                </Droppable>
              </div>
            ))}
            {columns.length === 0 && (
              <div className="card p-10 text-center text-sm text-muted w-full">
                <Layers className="w-6 h-6 text-muted mx-auto mb-2" />
                No columns to show — try a different filter.
              </div>
            )}
          </div>
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
