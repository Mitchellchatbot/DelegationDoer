"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useTeam } from "@/lib/team-context";
import { createPortal } from "react-dom";
import { useSearchParams, useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { PriorityBadge, StalledBadge, Tag } from "@/components/Badges";
import { Avatar } from "@/components/Avatar";
import { PersonAvatar } from "@/components/PersonAvatar";
import { Countdown } from "@/components/Countdown";
import { NewTaskForm } from "@/components/NewTaskForm";
import { canAssignTaskTo, canCreateTaskInDepartment } from "@/lib/access";
import { useCurrentUser } from "@/lib/user-context";
import { cn, formatDate } from "@/lib/utils";
import { useHorizontalDragAutoScroll } from "@/lib/useHorizontalDragAutoScroll";
import type { Task, TaskStatus, User } from "@/lib/types";
import {
  Clock, Globe2, Building2, Users as UsersIcon, FolderKanban,
  Layers, Briefcase, Layout, CheckCircle2, CheckSquare, Square, Trash2, Archive, Plus, X
} from "lucide-react";
import { toast } from "sonner";
import { ClockGate } from "@/components/ClockGate";

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

type GroupBy = "status" | "client" | "person";

// Which slice of tasks the board shows. Active = the live board (archived
// excluded, the default). Archived = only tasks swept off the board. All =
// both, so you can see everything in one place. Drives which /api/tasks feed
// we fetch; board counts follow the fetched slice automatically.
type Scope = "active" | "archived" | "all";

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

// Status-filter values the board accepts, derived from the columns it can
// actually render rather than from the TaskStatus union. That is load-bearing:
// 'rejected' is the soft-delete state for denied drafts and has NO column, so
// allowing it would narrow the board to zero columns. Keying off STATUS_COLS
// guarantees filterStatus always names a column that exists.
const STATUS_FILTER_IDS = new Set(STATUS_COLS.map((c) => c.id));

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
  const { containerRef, onDragStart, onDragEnd: stopAutoScroll } =
    useHorizontalDragAutoScroll();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [, setLoading] = useState(true);
  // Bumped after an inline create so the tasks fetch below re-runs. The
  // board owns its own /api/tasks state, so neither router.refresh() nor
  // team.refresh() would bring the new card in.
  const [refreshKey, setRefreshKey] = useState(0);
  // Which person the "Add task" dialog is open for. One dialog for the
  // whole board rather than one per column — person mode routinely renders
  // 10+ columns and each NewTaskForm ranks the entire roster on mount.
  const [addFor, setAddFor] = useState<User | null>(null);
  // The "+" that opened the dialog. Radix restores focus to its own
  // Dialog.Trigger on close, but the board opens this from a plain button in
  // the column header instead, so that ref is null and focus would be dropped
  // on <body> — see the onCloseAutoFocus handler on Dialog.Content.
  const addTriggerRef = useRef<HTMLButtonElement | null>(null);
  function openAddFor(u: User, trigger: HTMLButtonElement) {
    addTriggerRef.current = trigger;
    setAddFor(u);
  }

  // View / filter state. `selectedDepts` is the set of department ids
  // currently visible; an empty set is the "All departments" view.
  // `?dept=DEPT_ID` in the URL pre-filters to that single dept (kept
  // for the Leader Console's "View tasks" deep link).
  //
  // Default behavior for workers on first load: pre-filter to their
  // primary department so a website teammate lands on the Website
  // board, an SEO teammate on SEO, etc. Leaders + admins still see
  // "All departments" by default. The `?dept=all` escape hatch
  // forces the empty-set view if someone explicitly wants everyone.
  const initialDept = searchParams.get("dept");
  const isLeaderOrAdmin = currentUser.role === "leader" || currentUser.isAdmin === true;
  const primaryUserDept = currentUser.departmentIds?.[0] ?? null;
  const [selectedDepts, setSelectedDepts] = useState<Set<string>>(() => {
    if (initialDept === "all") return new Set();
    if (initialDept) return new Set([initialDept]);
    if (!isLeaderOrAdmin && primaryUserDept) return new Set([primaryUserDept]);
    return new Set();
  });
  const [filterUser, setFilterUser] = useState("all");
  const [filterClient, setFilterClient] = useState("all");
  const [filterWebsite, setFilterWebsite] = useState("all");
  // Status filter. "all" = any status (the default). `?status=<id>` deep-links a
  // single status — used by the Leader Console's "N pending" pill, which pairs it
  // with ?groupBy=status so the board renders exactly one column. Unknown values
  // (a typo, 'rejected', a stale link) fall back to "all" rather than emptying
  // the board. Typed as plain string to match the sibling filters.
  const initialStatus = ((): string => {
    const s = searchParams.get("status");
    return s && STATUS_FILTER_IDS.has(s) ? s : "all";
  })();
  const [filterStatus, setFilterStatus] = useState(initialStatus);
  const [sort, setSort] = useState("priority");

  // Column-axis state. Default to "person" — the Leader asked to see the
  // board organized by who's doing what, not by status, on first load.
  // The chip row above scopes which people show up as columns.
  // `?groupBy=client|person|status` overrides the default so the
  // /clients page can deep-link straight into the by-client board.
  const initialGroupBy = ((): GroupBy => {
    const g = searchParams.get("groupBy");
    return g === "client" || g === "status" || g === "person" ? g : "person";
  })();
  const [groupBy, setGroupBy] = useState<GroupBy>(initialGroupBy);
  // Auto-open when a `?status=` deep link narrowed the board, so the user can see
  // WHY they're looking at one column — and clear it in one click. Only opens when
  // the param resolved to a real status.
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(initialStatus !== "all");

  // Active / Archived / All slice. `?scope=archived|all` deep-links the view;
  // defaults to the live (active) board.
  const initialScope = ((): Scope => {
    const s = searchParams.get("scope");
    return s === "archived" || s === "all" ? s : "active";
  })();
  const [scope, setScope] = useState<Scope>(initialScope);

  // Bulk-select (admins only). When `selecting` is on, clicking a card
  // toggles its selection instead of navigating, and a bulk action bar
  // offers a one-shot delete of everything selected.
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  function toggleSelect(id: string) {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function exitSelecting() {
    setSelecting(false);
    setSelectedIds(new Set());
  }

  async function bulkDelete() {
    if (bulkBusy || selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    if (!window.confirm(
      `Delete ${ids.length} task${ids.length === 1 ? "" : "s"}? They'll be hidden from all views and recoverable from Recently deleted.`
    )) return;
    setBulkBusy(true);
    // Optimistically drop the selected cards.
    const prior = tasks;
    setTasks((cur) => cur.filter((t) => !selectedIds.has(t.id)));
    try {
      const res = await fetch("/api/tasks/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds: ids })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      toast.success(`Deleted ${data.deleted ?? ids.length} task${(data.deleted ?? ids.length) === 1 ? "" : "s"}.`);
      exitSelecting();
    } catch (err) {
      setTasks(prior); // revert
      toast.error(`Bulk delete failed: ${err instanceof Error ? err.message : "network error"}`);
    } finally {
      setBulkBusy(false);
    }
  }

  // Restore filter state on back-navigation from a task detail. Saved
  // to sessionStorage on every change; rehydrated on mount when there
  // are no explicit URL overrides. Means: click a card → /tasks/[id]
  // → browser Back → land on the same board view you left.
  const STORAGE_KEY = "board:state:v1";
  useEffect(() => {
    // Only restore if the URL didn't explicitly set state.
    if (initialDept || searchParams.get("groupBy") || searchParams.get("status")) return;
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as {
        deptIds?: string[];
        groupBy?: GroupBy;
        filterUser?: string;
        filterClient?: string;
        filterWebsite?: string;
        filterStatus?: string;
        sort?: string;
      };
      if (Array.isArray(s.deptIds)) setSelectedDepts(new Set(s.deptIds));
      if (s.groupBy === "client" || s.groupBy === "status" || s.groupBy === "person") setGroupBy(s.groupBy);
      if (typeof s.filterUser === "string") setFilterUser(s.filterUser);
      if (typeof s.filterClient === "string") setFilterClient(s.filterClient);
      if (typeof s.filterWebsite === "string") setFilterWebsite(s.filterWebsite);
      // Payloads written before this filter shipped have no filterStatus —
      // undefined fails both checks, so it degrades to the "all" default. The
      // membership test also stops a stale value narrowing the board to zero
      // columns (same validated shape as the groupBy restore above).
      if (s.filterStatus === "all" || (typeof s.filterStatus === "string" && STATUS_FILTER_IDS.has(s.filterStatus))) {
        setFilterStatus(s.filterStatus);
        // A restored status filter narrows the board to a single column. The
        // panel must come with it, or the user lands on one column with no
        // visible cause and no way to find the control that did it.
        if (s.filterStatus !== "all") setMoreFiltersOpen(true);
      }
      if (typeof s.sort === "string") setSort(s.sort);
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Persist state on every change.
  useEffect(() => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        deptIds: Array.from(selectedDepts),
        groupBy, filterUser, filterClient, filterWebsite, filterStatus, sort
      }));
    } catch { /* ignore quota etc */ }
  }, [selectedDepts, groupBy, filterUser, filterClient, filterWebsite, filterStatus, sort]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Map the scope to the matching /api/tasks feed (same privacy filter
    // applies to all three server-side).
    const qs = scope === "archived" ? "?archived=true" : scope === "all" ? "?all=true" : "";
    fetch(`/api/tasks${qs}`, { cache: "no-store" })
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
  }, [scope, refreshKey]);

  function toggleDept(deptId: string) {
    setSelectedDepts((cur) => {
      const next = new Set(cur);
      if (next.has(deptId)) next.delete(deptId);
      else next.add(deptId);
      return next;
    });
  }
  function selectAllDepts() {
    setSelectedDepts(new Set());
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
    (selectedDepts.size === 0 || (t.departmentId !== null && selectedDepts.has(t.departmentId))) &&
    (filterUser === "all" || t.assigneeId === filterUser) &&
    (filterStatus === "all" || t.status === filterStatus) &&
    (filterClient === "all" || (filterClient === "__internal" ? !t.clientName : t.clientName === filterClient)) &&
    (filterWebsite === "all" || (filterWebsite === "__internal" ? !t.website : t.website === filterWebsite))
  ), [tasks, selectedDepts, filterUser, filterStatus, filterClient, filterWebsite]);

  // How many of the collapsible filters are actually doing something. Shown on
  // the "More filters" button so a filter left on — by a deep link, or restored
  // from a previous visit — can never silently narrow the board.
  const activeFilterCount = useMemo(
    () => [filterUser, filterStatus, filterClient, filterWebsite].filter((v) => v !== "all").length,
    [filterUser, filterStatus, filterClient, filterWebsite]
  );

  // Build columns from the current groupBy + visible tasks.
  const columns: Column[] = useMemo(() => {
    // With a status filter on, the other four columns render empty and the board
    // reads as broken. Narrow to the one column the filter allows, so
    // ?status=pending&groupBy=status is literally "the Pending list". filterStatus
    // is validated against STATUS_COLS everywhere it can be set (URL, Select,
    // sessionStorage restore), so this never returns []. Drag-and-drop degrades
    // cleanly: with one column every drop has dest === before.status, which
    // onDragEnd short-circuits before any mutation or PATCH.
    if (groupBy === "status") {
      return filterStatus === "all" ? STATUS_COLS : STATUS_COLS.filter((c) => c.id === filterStatus);
    }

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

    // person mode — only show people in the departments the chip row
    // narrowed to. Empty set means "all departments" so everyone shows.
    // Past behavior was to render every user even when filtering tasks
    // to a single dept, which left a wall of empty columns for people
    // unrelated to the slice the user picked.
    let people = users;
    if (selectedDepts.size > 0) {
      people = people.filter((u) =>
        u.departmentIds.some((d) => selectedDepts.has(d))
      );
    }
    const cols: Column[] = people.map((u) => ({
      id: u.id,
      label: u.name,
      tone: "border-indigo-300/40",
      user: u
    }));
    cols.push({ id: "__unassigned", label: "Unassigned", tone: "border-slate-300/40" });
    // Dedicated bucket for finished work — pulls done tasks out of each
    // person's column so the live worklist is just open items. Drag into
    // here to mark done; drag out onto a person to reopen + reassign.
    cols.push({ id: "__completed", label: "Completed", tone: "border-emerald-300/50" });
    return cols;
  }, [groupBy, visible, users, selectedDepts, filterStatus]);

  // Group visible tasks by the column they belong to.
  const grouped: Record<string, Task[]> = useMemo(() => {
    const map: Record<string, Task[]> = {};
    columns.forEach((c) => { map[c.id] = []; });

    visible.forEach((t) => {
      let key: string | null = null;
      if (groupBy === "status") key = t.status;
      else if (groupBy === "client") key = t.clientName ?? "__internal";
      else if (groupBy === "person") {
        // Done tasks go to the shared Completed bucket regardless of
        // assignee — keeps each person's column focused on open work.
        key = t.status === "done" ? "__completed" : (t.assigneeId ?? "__unassigned");
      }
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
      // Drag into Completed → mark task done (keep assignee).
      if (dest === "__completed") {
        if (before.status === "done") return;
        setTasks((cur) => cur.map((t) => t.id === id ? { ...t, status: "done" as TaskStatus, lastActivityAt: new Date().toISOString() } : t));
        try {
          const res = await fetch(`/api/tasks/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "done" })
          });
          if (!res.ok) {
            const d = await res.json().catch(() => null);
            throw new Error(d?.error ?? `failed (${res.status})`);
          }
          toast.success(`Marked done · ${before.title}`);
        } catch (err) {
          toast.error(`Couldn't mark done: ${err instanceof Error ? err.message : "network error"}`);
          setTasks((cur) => cur.map((t) => t.id === id ? { ...t, status: before.status } : t));
        }
        return;
      }
      // Drag out of Completed onto a person → reopen + reassign in one go.
      const reopening = before.status === "done";
      const nextAssignee = dest === "__unassigned" ? null : dest;
      if (!reopening && before.assigneeId === nextAssignee) return;
      const nextStatus: TaskStatus = reopening ? "in_progress" : before.status;
      setTasks((cur) => cur.map((t) => t.id === id ? {
        ...t,
        assigneeId: nextAssignee,
        status: nextStatus,
        lastActivityAt: new Date().toISOString()
      } : t));
      try {
        const body: Record<string, unknown> = { assigneeId: nextAssignee };
        if (reopening) body.status = nextStatus;
        const res = await fetch(`/api/tasks/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const d = await res.json().catch(() => null);
          throw new Error(d?.error ?? `failed (${res.status})`);
        }
        const target = nextAssignee ? userById(nextAssignee) : null;
        if (reopening) {
          toast.success(target ? `Reopened & assigned to ${target.name}` : "Reopened (unassigned)");
        } else {
          toast.success(target ? `Reassigned to ${target.name}` : "Unassigned");
        }
      } catch (err) {
        toast.error(`Move failed: ${err instanceof Error ? err.message : "network error"}`);
        setTasks((cur) => cur.map((t) => t.id === id ? {
          ...t,
          assigneeId: before.assigneeId,
          status: before.status
        } : t));
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

  const allDeptsSelected = selectedDepts.size === 0;

  // Which department a task created from this person's column should land in.
  // Prefer one the chip row is currently showing: `visible` filters tasks by
  // selectedDepts, so seeding a department that's filtered out means the card
  // never appears on the board that just created it (and POST /api/tasks
  // announces it in that other department's Slack channel). Only bites people
  // who belong to several departments — for everyone else both passes agree.
  // Falls back to any department the caller may create in; undefined when the
  // target has none (leaders), where NewTaskForm's own default takes over.
  function deptHintFor(u: User): string | undefined {
    return (
      u.departmentIds.find(
        (d) => (selectedDepts.size === 0 || selectedDepts.has(d)) && canCreateTaskInDepartment(currentUser, d)
      ) ?? u.departmentIds.find((d) => canCreateTaskInDepartment(currentUser, d))
    );
  }

  return (
    <ClockGate fallbackSubtitle="The board unlocks once you've clocked in. Tap below to start your shift.">
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-lg font-medium">Board <span className="text-muted text-sm">· {visible.length}</span></h1>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Scope axis — which slice of tasks is shown. "Update board counts
              to exclude archived" falls out for free: Active fetches the
              archived-excluded feed, so the header count + column counts only
              cover live work. */}
          <div className="inline-flex items-center rounded-xl border border-border bg-surface p-0.5">
            <ViewBtn active={scope === "active"}   onClick={() => setScope("active")}   icon={<Layout className="w-3.5 h-3.5" />}  label="Active" />
            <ViewBtn active={scope === "archived"} onClick={() => setScope("archived")} icon={<Archive className="w-3.5 h-3.5" />} label="Archived" />
            <ViewBtn active={scope === "all"}      onClick={() => setScope("all")}      icon={<Layers className="w-3.5 h-3.5" />}  label="All" />
          </div>

          {/* Group-by axis (kept) */}
          <div className="inline-flex items-center rounded-xl border border-border bg-surface p-0.5">
            <ViewBtn active={groupBy === "status"} onClick={() => setGroupBy("status")} icon={<Layout className="w-3.5 h-3.5" />}    label="By status" />
            <ViewBtn active={groupBy === "client"} onClick={() => setGroupBy("client")} icon={<Briefcase className="w-3.5 h-3.5" />} label="By client" />
            <ViewBtn active={groupBy === "person"} onClick={() => setGroupBy("person")} icon={<UsersIcon className="w-3.5 h-3.5" />} label="By person" />
          </div>

          {/* Dedicated Archived view — the managed list with Unarchive +
              "Run sweep now". Distinct from the Archived scope tab above, which
              just shows archived tasks in the board layout. */}
          <Link
            href="/tasks/archived"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border border-border bg-white text-muted hover:text-ink hover:border-accent/40 transition-colors"
          >
            <Archive className="w-3.5 h-3.5" />
            Archived view
          </Link>

          {/* Admin-only: bulk-select toggle + recovery link. */}
          {isLeaderOrAdmin && (
            <>
              <button
                type="button"
                onClick={() => (selecting ? exitSelecting() : setSelecting(true))}
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors",
                  selecting
                    ? "bg-rose-600 text-white border-rose-600"
                    : "bg-white border-border text-muted hover:text-ink hover:border-accent/40"
                )}
              >
                <CheckSquare className="w-3.5 h-3.5" />
                {selecting ? "Cancel select" : "Select"}
              </button>
              <Link
                href="/tasks/deleted"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border border-border bg-white text-muted hover:text-ink hover:border-accent/40 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Recently deleted
              </Link>
            </>
          )}
        </div>
      </div>

      {/* Department picker — multi-select chip row. "All" is sticky on
          the left and clears the per-dept selection in one click. */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={selectAllDepts}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
            allDeptsSelected
              ? "bg-accent text-white border-accent shadow-sm"
              : "bg-white border-border text-muted hover:text-ink hover:border-accent/40"
          )}
        >
          <UsersIcon className="w-3.5 h-3.5" />
          All departments
        </button>
        <span className="text-[10px] uppercase tracking-wide text-ink/40 px-1">
          or pick a few
        </span>
        {departments.map((d) => {
          const on = selectedDepts.has(d.id);
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => toggleDept(d.id)}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
                on
                  ? "bg-blue-600 text-white border-blue-600 shadow-sm"
                  : "bg-white border-border text-muted hover:text-ink hover:border-accent/40"
              )}
            >
              <FolderKanban className="w-3.5 h-3.5" />
              {d.name}
            </button>
          );
        })}
      </div>

      {/* Compact filter bar: sort sits inline; everything else lives
          behind "More filters" so the board doesn't open with five
          selects fighting for attention. Department scoping is now
          driven by the chip row above. */}
      <div className="card p-3 flex items-center gap-2 flex-wrap">
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
          className={cn(
            "ml-auto inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors",
            activeFilterCount > 0
              ? "border-accent/40 bg-accent/10 text-accent"
              : "border-border text-muted hover:text-ink hover:bg-surface2"
          )}
        >
          {moreFiltersOpen ? "Hide filters" : "More filters"}
          {activeFilterCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-accent text-white text-[10px] font-medium">
              {activeFilterCount}
            </span>
          )}
        </button>
      </div>

      {moreFiltersOpen && (
        <div className="card p-3 flex items-center gap-2 flex-wrap">
          <Select label="Assignee" value={filterUser} onChange={setFilterUser} options={[
            ["all", "Anyone"], ...users.map((u) => [u.id, u.name] as [string, string])
          ]} />
          <Select label="Status" value={filterStatus} onChange={setFilterStatus} options={[
            ["all", "Any status"],
            ...STATUS_COLS.map((c) => [c.id, c.label] as [string, string])
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

      <DragDropContext
        onDragStart={onDragStart}
        onDragEnd={(r) => { stopAutoScroll(); void onDragEnd(r); }}
      >
        {/* Horizontal scroll once column count exceeds what fits. Person
            mode regularly has 10+ columns; status mode always has 5. */}
        <div ref={containerRef} className="overflow-x-auto pb-2">
          <div className="flex gap-3 min-w-max">
            {columns.map((col, colIdx) => (
              <div
                key={col.id}
                className={cn("rounded-2xl bg-surface/40 border anim-fade-in shrink-0 w-72", col.tone)}
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
                  <div className="flex items-center gap-1 shrink-0">
                    <div className="text-xs text-muted tabular-nums">{grouped[col.id]?.length ?? 0}</div>
                    {/* Per-person quick-add. `col.user` is set only in person
                        mode, so this never appears on status/client columns
                        nor on the Unassigned / Completed buckets (a task has
                        to have an assignee). canAssignTaskTo is the same
                        predicate POST /api/tasks applies to the assignee, so
                        the button never offers a person you'd be refused.
                        It does NOT cover that route's separate clock-in gate,
                        which exempts only leaders/admins while ClockGate also
                        exempts clock_enabled=false users — so those users can
                        still be refused on submit, exactly as they are from
                        the Topbar's "New task". */}
                    {col.user && !selecting && scope !== "archived" &&
                     canAssignTaskTo(currentUser, col.user) && (
                      <AddTaskButton user={col.user} onOpen={openAddFor} />
                    )}
                  </div>
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
                                  if (selecting) { toggleSelect(t.id); return; }
                                  router.push(`/tasks/${t.id}`);
                                }}
                                style={{
                                  ...p.draggableProps.style,
                                  // While dragging, the clone gets NO entrance
                                  // animation or animationDelay — dnd owns its
                                  // transform/position entirely (see className
                                  // note below).
                                  ...(s.isDragging
                                    ? { zIndex: 9999, cursor: "grabbing" }
                                    : { animationDelay: `${i * 30}ms`, cursor: "pointer" })
                                }}
                                className={cn(
                                  // Never put a transform-animating class
                                  // (anim-fade-in-up etc.) on the draggable: a
                                  // fill:both keyframe pins `transform` above
                                  // inline styles and clobbers the per-frame
                                  // transform dnd writes to track the cursor,
                                  // freezing the clone and stopping siblings
                                  // from shifting. Opacity-only entrance, and
                                  // only when not dragging so the portaled
                                  // clone has none at all.
                                  "card p-3 transition-shadow hover:shadow-lift",
                                  !s.isDragging && "anim-fade-in",
                                  t.inactiveFlag && "border-stalled/50",
                                  // Done tasks get a soft green tint + emerald
                                  // border so they read as "finished" at a
                                  // glance instead of blending with open work.
                                  t.status === "done" && "bg-emerald-50/70 border-emerald-200/70",
                                  // Archived tasks (visible in the Archived/All
                                  // scopes) get an amber tint that wins over the
                                  // done tint so "off the board" reads clearly.
                                  t.archivedAt && "bg-amber-50/50 border-amber-300/70",
                                  s.isDragging && "ring-1 ring-accent/40 shadow-lift",
                                  selecting && selectedIds.has(t.id) && "ring-2 ring-rose-500 border-rose-300"
                                )}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="flex items-start gap-2 min-w-0">
                                    {selecting && (
                                      selectedIds.has(t.id)
                                        ? <CheckSquare className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                                        : <Square className="w-4 h-4 text-muted shrink-0 mt-0.5" />
                                    )}
                                    <div className="text-sm leading-snug">{t.title}</div>
                                  </div>
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
                                <div className="mt-1.5 flex flex-wrap gap-1 items-center">
                                  {t.tags.slice(0, 2).map((x) => <Tag key={x}>{x}</Tag>)}
                                  {t.inactiveFlag && <StalledBadge />}
                                  {/* Archived indicator + archive date — shown
                                      in the Archived/All scopes. */}
                                  {t.archivedAt && (
                                    <span
                                      title={`Archived ${formatDate(t.archivedAt)}`}
                                      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200/70"
                                    >
                                      <Archive className="w-2.5 h-2.5" />
                                      Archived · {formatDate(t.archivedAt)}
                                    </span>
                                  )}
                                </div>
                                <div className="mt-2 flex items-center justify-between text-xs text-muted">
                                  <div className="flex items-center gap-1.5">
                                    {t.assigneeId
                                      ? <PersonAvatar userId={t.assigneeId} name={userById(t.assigneeId)?.name ?? ""} size={18} />
                                      : <span>—</span>}
                                  </div>
                                  {t.status === "done" ? (
                                    // Done tasks stop the countdown — a
                                    // ticking "overdue 3d" on something
                                    // already shipped reads as unfinished
                                    // work. Static green "Done" pill instead.
                                    <span className="inline-flex items-center gap-1 text-emerald-700/85">
                                      <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                                      Done
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /><Countdown iso={t.dueDate} /></span>
                                  )}
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

      {/* Inline "add task for this person" — a single dialog for the whole
          board, driven by whichever column's "+" was clicked. */}
      <AddTaskForPersonDialog
        user={addFor}
        deptHint={addFor ? deptHintFor(addFor) : undefined}
        triggerRef={addTriggerRef}
        onClose={() => setAddFor(null)}
        onCreated={(taskId) => {
          setAddFor(null);
          setRefreshKey((k) => k + 1);
          // NewTaskForm already raises its own success toast; this one
          // exists for the "Open" action, same as the Topbar dialog.
          toast.message("Task created", {
            action: { label: "Open", onClick: () => router.push(`/tasks/${taskId}`) }
          });
        }}
      />

      {/* Bulk action bar — floats above the board while selecting. */}
      {selecting && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 lg:translate-x-[calc(-50%+132px)] z-50 flex items-center gap-3 px-4 py-2.5 rounded-2xl bg-ink text-white shadow-lift">
          <span className="text-sm tabular-nums">
            {selectedIds.size} selected
          </span>
          <button
            type="button"
            onClick={bulkDelete}
            disabled={bulkBusy || selectedIds.size === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-rose-600 hover:bg-rose-700 transition-colors disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {bulkBusy ? "Deleting…" : "Delete selected"}
          </button>
          <button
            type="button"
            onClick={exitSelecting}
            className="text-xs text-white/70 hover:text-white transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
    </ClockGate>
  );
}

// Per-person quick-add trigger. A component rather than inline JSX so the
// `col.user` narrowing survives into the click handler — TypeScript drops
// narrowing on property accesses inside closures.
function AddTaskButton({ user, onOpen }: {
  user: User;
  onOpen: (u: User, trigger: HTMLButtonElement) => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => onOpen(user, e.currentTarget)}
      title={`Add a task for ${user.name}`}
      aria-label={`Add a task for ${user.name}`}
      className="w-6 h-6 rounded-lg grid place-items-center text-muted hover:text-accent hover:bg-white transition-colors"
    >
      <Plus className="w-3.5 h-3.5" />
    </button>
  );
}

// Hosts NewTaskForm pinned to one person. Mounted once by the board and
// driven by `user`: null = closed. Dialog.Portal is what lets the card
// escape both the board's overflow-x-auto scroller and the sticky Topbar's
// stacking context; the lg:pl-[264px] offset centers it over the content
// panel rather than under the sidebar (same trick as the Topbar dialog).
function AddTaskForPersonDialog({ user, deptHint, triggerRef, onClose, onCreated }: {
  user: User | null;
  deptHint?: string;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onCreated: (taskId: string) => void;
}) {
  return (
    <Dialog.Root open={user !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40 anim-fade-in" />
        {/* No aria-describedby={undefined} here: Radix spreads content props
            AFTER its own computed a11y attributes, so passing it explicitly
            would override the id of the Dialog.Description below and drop the
            one sentence explaining that the assignee is already pinned. That
            escape hatch is only for dialogs that render no Description. */}
        <Dialog.Content
          // Radix's built-in close handler preventDefaults and then focuses
          // its own Dialog.Trigger — which doesn't exist here, since the board
          // opens this from a plain button in the column header. FocusScope
          // sees defaultPrevented and skips its fallback, so focus would land
          // on <body> and the next Tab would restart at the top of the page.
          // Run first (composeEventHandlers skips Radix's once we prevent) and
          // put focus back on the "+" that opened us.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            triggerRef.current?.focus();
          }}
          className="fixed inset-0 z-50 outline-none pointer-events-none flex items-start justify-center pt-20 px-4 lg:pl-[264px]"
        >
          <div className="pointer-events-auto w-full max-w-[900px] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-3xl border border-white/60 bg-gradient-to-br from-blue-50/90 via-white/95 to-indigo-50/85 backdrop-blur-md shadow-[0_24px_72px_-24px_rgba(60,60,120,0.45)] anim-fade-in-up">
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/60 sticky top-0 bg-white/70 backdrop-blur-sm z-10">
              <div className="flex items-center gap-2.5 min-w-0">
                {user && <PersonAvatar userId={user.id} name={user.name} imageUrl={user.avatarUrl} size={32} />}
                <div className="min-w-0">
                  <Dialog.Title className="text-base font-semibold truncate">
                    New task for {user?.name}
                  </Dialog.Title>
                  <Dialog.Description className="text-xs text-muted mt-0.5">
                    Already assigned to them — fill it in and it lands in their column.
                  </Dialog.Description>
                </div>
              </div>
              <Dialog.Close asChild>
                <button
                  className="w-8 h-8 rounded-full grid place-items-center text-muted hover:text-ink hover:bg-white/70 transition-colors shrink-0"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </Dialog.Close>
            </div>
            <div className="p-6">
              {user && (
                // NewTaskForm seeds its state from initialValues in useState
                // initializers only, so it has to remount when the person
                // changes — hence the key.
                <NewTaskForm
                  key={user.id}
                  initialValues={{
                    assigneeId: user.id,
                    ...(deptHint ? { departmentId: deptHint } : {})
                  }}
                  lockAssignee
                  onCreated={onCreated}
                  onCancel={onClose}
                  hideCancel
                />
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
