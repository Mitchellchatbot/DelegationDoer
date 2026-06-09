"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Task } from "@/lib/types";
import { Avatar } from "@/components/Avatar";
import { PersonAvatar } from "@/components/PersonAvatar";
import { CapacityBar } from "@/components/CapacityBar";
import { OrgChart } from "@/components/OrgChart";
import { OnShiftList } from "@/components/OnShiftList";
import { PerformanceReview } from "@/components/PerformanceReview";
import { DayReportsTab } from "@/components/DayReportsTab";
import { PageHero } from "@/components/PageHero";
import { ProfileDialog } from "@/components/ProfileDialog";
import { SendKudosDialog } from "@/components/SendKudosDialog";
import { MagicLinkButton } from "@/components/MagicLinkButton";
import { DepartmentSlackSection } from "@/components/DepartmentSlackSection";
import { InvitePersonDialog } from "@/components/InvitePersonDialog";
import { userCapacity } from "@/lib/capacity";
import { ROLE_LABELS } from "@/lib/auth";
import { useCurrentUser } from "@/lib/user-context";
import type { Role, User, Department } from "@/lib/types";
import Link from "next/link";
import { toast } from "sonner";
import {
  Crown, Users as UsersIcon, Building2, ListChecks, Plus, X, ShieldAlert,
  CheckCircle2, AlertTriangle, Timer, ArrowRight, Sparkles, ChevronRight, Clock,
  UserPlus
} from "lucide-react";

const TABS = ["People", "Departments", "Org chart", "Performance", "All tasks", "Day reports"] as const;
type Tab = typeof TABS[number];

export default function LeaderConsolePage() {
  const currentUser = useCurrentUser();
  const [tab, setTab] = useState<Tab>("People");
  const [people, setPeople] = useState<User[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/users", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/departments", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/tasks", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
    ])
      .then(([uRes, dRes, tRes]) => {
        if (cancelled) return;
        if (Array.isArray(uRes?.users)) {
          const live: User[] = uRes.users.map((u: any) => ({
            id: u.id,
            name: u.name,
            email: u.email,
            role: u.role,
            departmentIds: u.departmentIds ?? [],
            skills: [],
            dailyCapacity: u.dailyCapacity ?? 8,
            throughput: {},
            avatarUrl: u.avatarUrl ?? undefined,
            managerId: u.managerId ?? null
          }));
          setPeople(live);
        }
        if (Array.isArray(dRes?.departments)) {
          setDepts(
            dRes.departments.map((d: any) => ({
              id: d.id,
              name: d.name,
              description: d.description ?? "",
              taskTypes: d.taskTypes ?? []
            }))
          );
        }
        if (Array.isArray(tRes?.tasks)) setTasks(tRes.tasks as Task[]);
      })
      .catch(() => { /* leave empty — surfaces as zero state */ });
    return () => { cancelled = true; };
  }, []);

  // Gate the page itself.
  if (currentUser.role !== "leader" && !currentUser.isAdmin) {
    return (
      <div className="card p-6 max-w-lg mx-auto mt-12 text-center">
        <ShieldAlert className="w-8 h-8 text-warn mx-auto mb-2" />
        <div className="text-base font-medium">Leader only</div>
        <div className="text-sm text-muted mt-1">This page is restricted to the Leader role.</div>
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Leader Console"
        headline={["Company-wide ", { accent: "control" }]}
        subtitle="People, departments, the org chart, every task in flight — all in one place."
        icon={<Crown />}
        iconTone="amber"
      />

      <RoutingReviewBanner />

      <div className="flex items-center gap-1 border-b border-slate-200/70">
        {TABS.map((t) => {
          const active = tab === t;
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={
                "relative px-5 py-3 text-[16px] font-semibold transition-colors " +
                (active ? "text-accent" : "text-muted hover:text-ink")
              }
            >
              {t}
              {/* Shared layoutId makes framer-motion FLIP-animate this
                  underline between tabs instead of hard-swapping it. */}
              {active && (
                <motion.span
                  layoutId="leader-tab-underline"
                  className="absolute left-3 right-3 -bottom-px h-0.5 bg-accent rounded-full"
                  transition={{ type: "spring", stiffness: 480, damping: 36 }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* AnimatePresence lets the outgoing tab fade out before the new one
          slides in. mode="wait" keeps the layout stable (no overlap). */}
      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
        >
          {tab === "People" && <PeopleTab people={people} setPeople={setPeople} departments={depts} />}
          {tab === "Departments" && <DepartmentsTab departments={depts} setDepartments={setDepts} people={people} tasks={tasks} />}
          {tab === "Org chart" && <OrgChartTab people={people} departments={depts} tasks={tasks} />}
          {tab === "Performance" && <PerformanceReview canCrown={currentUser.role === "leader" || !!currentUser.isAdmin} />}
          {tab === "All tasks" && <AllTasksTab people={people} departments={depts} tasks={tasks} />}
          {tab === "Day reports" && <DayReportsTab departments={depts} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/* ---------------- People ---------------- */

function PeopleTab({
  people, setPeople, departments
}: { people: User[]; setPeople: (u: User[]) => void; departments: Department[] }) {
  const currentUser = useCurrentUser();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // The rest of the Leader page reads from mock tasks for legacy capacity
  // math (visualisations don't depend on real-time accuracy), but the
  // inline drilldown DOES need the real tasks — otherwise we render
  // "nothing assigned" for someone with 22 urgent tasks in Supabase.
  // Fetch once when the tab mounts. The /api/tasks route already
  // returns the org-wide snapshot.
  const [liveTasks, setLiveTasks] = useState<Task[] | null>(null);
  // Per-user clock-enabled flag. Lives next to the User shape but
  // isn't part of types.User, so we track it separately. Pulled from
  // /api/users which already returns clockEnabled per row.
  const [clockEnabled, setClockEnabled] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let cancelled = false;
    fetch("/api/tasks", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.tasks) setLiveTasks(data.tasks as Task[]);
      })
      .catch(() => { /* leave null → falls back to mock */ });
    fetch("/api/users", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !Array.isArray(data?.users)) return;
        const ce: Record<string, boolean> = {};
        for (const u of data.users) ce[u.id] = u.clockEnabled !== false;
        setClockEnabled(ce);
      })
      .catch(() => { /* leave empty → renders as default-on */ });
    return () => { cancelled = true; };
  }, []);

  // Optimistic local update + PATCH /api/users/<id>. On failure we
  // surface a toast and revert by re-fetching, so the UI doesn't lie
  // about state we couldn't actually persist.
  async function persistUser(
    id: string,
    patch: { role?: Role; departmentIds?: string[]; clockEnabled?: boolean; managerId?: string | null },
    prev: User[]
  ) {
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      toast.error(`Couldn't save — ${err instanceof Error ? err.message : "unknown error"}`);
      setPeople(prev);
    }
  }

  function setRole(id: string, role: Role) {
    const prev = people;
    setPeople(prev.map((u) => u.id === id ? { ...u, role } : u));
    void persistUser(id, { role }, prev);
  }
  async function toggleClock(id: string) {
    const prev = clockEnabled;
    const next = !(prev[id] ?? true);
    setClockEnabled({ ...prev, [id]: next });
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clockEnabled: next })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d?.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      toast.error(`Couldn't save — ${err instanceof Error ? err.message : "unknown error"}`);
      setClockEnabled(prev);
    }
  }

  function setManager(id: string, managerId: string | null) {
    const prev = people;
    setPeople(prev.map((u) => u.id === id ? { ...u, managerId } : u));
    void persistUser(id, { managerId }, prev);
  }

  // Build the set of ids the user shouldn't be allowed to pick as a
  // manager — themselves + every descendant in the current managerId
  // forest — to keep the picker from creating a cycle. Recomputed once
  // per render via useMemo so the rows can each call it cheaply.
  const descendantsByUser = useMemo(() => {
    const children = new Map<string, string[]>();
    for (const u of people) {
      if (!u.managerId) continue;
      const arr = children.get(u.managerId) ?? [];
      arr.push(u.id);
      children.set(u.managerId, arr);
    }
    const cache = new Map<string, Set<string>>();
    function descend(id: string, seen: Set<string>): Set<string> {
      const hit = cache.get(id);
      if (hit) return hit;
      const out = new Set<string>();
      const stack = [...(children.get(id) ?? [])];
      while (stack.length > 0) {
        const c = stack.pop()!;
        if (seen.has(c) || out.has(c)) continue;
        out.add(c);
        for (const g of children.get(c) ?? []) stack.push(g);
      }
      cache.set(id, out);
      return out;
    }
    const result = new Map<string, Set<string>>();
    for (const u of people) result.set(u.id, descend(u.id, new Set([u.id])));
    return result;
  }, [people]);

  function toggleDept(id: string, deptId: string) {
    const prev = people;
    let nextDepartmentIds: string[] = [];
    setPeople(prev.map((u) => {
      if (u.id !== id) return u;
      const has = u.departmentIds.includes(deptId);
      nextDepartmentIds = has
        ? u.departmentIds.filter((d) => d !== deptId)
        : [...u.departmentIds, deptId];
      return { ...u, departmentIds: nextDepartmentIds };
    }));
    void persistUser(id, { departmentIds: nextDepartmentIds }, prev);
  }

  return (
    <div className="space-y-3">
      <InviteLinkCard />
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted">
          Click any role pill to change it. Toggle department chips to set membership / leadership.
        </div>
        <InvitePersonDialog
          trigger={
            <button
              type="button"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95"
              style={{ background: "linear-gradient(135deg, #0a4099 0%, #063270 100%)" }}
              title="Send a magic-link invite. Multiple department heads are supported."
            >
              <UserPlus className="w-3.5 h-3.5" />
              Invite someone
            </button>
          }
        />
      </div>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface2/60">
            <tr className="text-left text-xs text-muted">
              <th className="w-8 px-2 py-2.5 font-normal" />
              <th className="px-4 py-2.5 font-normal">Person</th>
              <th className="px-4 py-2.5 font-normal">Role</th>
              <th className="px-4 py-2.5 font-normal">Departments</th>
              <th className="px-4 py-2.5 font-normal">Reports to</th>
              <th className="px-4 py-2.5 font-normal text-center" title="Whether this person needs to clock in/out via the widget">Clock</th>
              <th className="px-4 py-2.5 font-normal text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {people.map((u) => {
              const isExpanded = expandedId === u.id;
              return (
                <Fragment key={u.id}>
                <tr className="border-t border-border/60 hover:bg-slate-50/60 transition-colors">
                  <td className="w-8 px-2 py-3 align-middle">
                    <button
                      type="button"
                      onClick={() => setExpandedId((cur) => (cur === u.id ? null : u.id))}
                      aria-expanded={expandedId === u.id}
                      title={expandedId === u.id ? "Hide tasks" : "Show tasks"}
                      className="w-6 h-6 inline-grid place-items-center rounded-md text-muted hover:text-accent hover:bg-accent/10 transition-colors"
                    >
                      <ChevronRight
                        className={
                          "w-3.5 h-3.5 transition-transform " +
                          (expandedId === u.id ? "rotate-90" : "rotate-0")
                        }
                      />
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <ProfileDialog
                      userId={u.id}
                      trigger={
                        <button
                          type="button"
                          className="flex items-center gap-2.5 text-left hover:text-accent transition-colors"
                          title="Open profile"
                        >
                          <PersonAvatar userId={u.id} name={u.name} imageUrl={u.avatarUrl} size={26} />
                          <div>
                            <div className="font-medium">{u.name}</div>
                            <div className="text-xs text-muted">{u.email}</div>
                          </div>
                        </button>
                      }
                    />
                  </td>
                  <td className="px-4 py-3">
                    <RolePicker role={u.role} onChange={(r) => setRole(u.id, r)} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {departments.map((d) => {
                        const on = u.departmentIds.includes(d.id);
                        return (
                          <button
                            key={d.id}
                            onClick={() => toggleDept(u.id, d.id)}
                            className={"badge cursor-pointer " + (on ? "badge-medium" : "badge-tag")}
                          >
                            {d.name}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <ManagerPicker
                      user={u}
                      people={people}
                      excluded={descendantsByUser.get(u.id) ?? new Set()}
                      onChange={(mid) => setManager(u.id, mid)}
                    />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <ClockSwitch
                      enabled={clockEnabled[u.id] ?? true}
                      onToggle={() => toggleClock(u.id)}
                    />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-1.5 justify-end">
                      {/* Magic link works on the current user too (handy
                          for self-debugging); kudos hides on the self row. */}
                      <MagicLinkButton userId={u.id} userName={u.name} userEmail={u.email} />
                      {u.id !== currentUser?.id && (
                        <SendKudosDialog
                          recipientId={u.id}
                          recipientName={u.name}
                          recipientAvatarUrl={u.avatarUrl ?? null}
                          trigger={
                            <button
                              type="button"
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border border-fuchsia-200 bg-fuchsia-50/60 text-fuchsia-700 hover:bg-fuchsia-100 hover:border-fuchsia-300 transition-colors active:scale-95"
                              title={`Send a kudos to ${u.name}`}
                            >
                              <Sparkles className="w-3 h-3" />
                              Kudos
                            </button>
                          }
                        />
                      )}
                    </div>
                  </td>
                </tr>
                {isExpanded && (
                  <tr className="bg-slate-50/40">
                    <td className="w-8" />
                    <td colSpan={6} className="px-4 py-3">
                      <PersonTaskList userId={u.id} tasks={liveTasks} />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Inline "their tasks" view shown when a People row's chevron is
// expanded. Uses the live /api/tasks snapshot passed in via the
// `tasks` prop; falls back to a loading state while that's mid-fetch
// (rather than rendering "nothing assigned" which is misleading).
function PersonTaskList({ userId, tasks: liveTasks }: { userId: string; tasks: Task[] | null }) {
  if (liveTasks === null) {
    return (
      <div className="text-xs text-muted italic py-2">
        Loading tasks…
      </div>
    );
  }
  const mine = liveTasks.filter((t) => t.assigneeId === userId);
  if (mine.length === 0) {
    return (
      <div className="text-xs text-muted italic py-2">
        Nothing assigned right now.
      </div>
    );
  }

  const open = mine.filter((t) => t.status !== "done");
  const done = mine.filter((t) => t.status === "done");

  return (
    <div className="space-y-3">
      {open.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider font-semibold text-ink/55 mb-1.5">
            Open · {open.length}
          </div>
          <ul className="space-y-1">
            {open.map((t) => (
              <li key={t.id} className="flex items-center gap-2 text-[13px]">
                <span
                  className={
                    "inline-block w-1.5 h-1.5 rounded-full shrink-0 " +
                    (t.priority === "critical"
                      ? "bg-rose-500"
                      : t.priority === "high"
                      ? "bg-amber-500"
                      : t.priority === "medium"
                      ? "bg-blue-500"
                      : "bg-slate-300")
                  }
                />
                <Link
                  href={`/tasks/${t.id}`}
                  className="truncate hover:text-accent transition-colors"
                >
                  {t.title}
                </Link>
                <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted shrink-0">
                  <Clock className="w-3 h-3" />
                  {t.estimatedHours}h
                </span>
                <span className="text-[10px] uppercase tracking-wide text-ink/45 w-[88px] text-right shrink-0">
                  {t.status.replace(/_/g, " ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {done.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider font-semibold text-emerald-600/80 mb-1.5">
            Done · {done.length}
          </div>
          <ul className="space-y-1 opacity-75">
            {done.slice(0, 5).map((t) => (
              <li key={t.id} className="flex items-center gap-2 text-[13px]">
                <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" />
                <Link
                  href={`/tasks/${t.id}`}
                  className="truncate hover:text-accent transition-colors line-through decoration-emerald-500/40"
                >
                  {t.title}
                </Link>
              </li>
            ))}
            {done.length > 5 && (
              <li className="text-[11px] text-muted">+{done.length - 5} more</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// Shareable signup link. Anyone with this URL can create a worker
// account; the leader then promotes them in the table below. Cuts
// the "mint a magic link for every employee" overhead — copy once,
// paste in Slack, done.
function InviteLinkCard() {
  const [url, setUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setUrl(`${window.location.origin}/signup`);
  }, []);
  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Clipboard unavailable — select + copy manually");
    }
  }
  return (
    <section
      className="rounded-2xl border border-white/60 p-4 shadow-soft relative overflow-hidden"
      style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #EEF2FF 50%, #FCE7F3 100%)" }}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-white/80 border border-white grid place-items-center text-accent shrink-0 shadow-sm">
            <UserPlus className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold">Share signup link</div>
            <p className="text-[12px] text-ink/65 mt-0.5 max-w-prose">
              Send this link in Slack. Everyone who opens it can create
              their own account (they land as a <strong>worker</strong>);
              promote them in the table below once they&apos;ve signed up.
            </p>
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 rounded-xl bg-white/85 border border-white/70 px-3 py-2 shadow-sm">
        <code className="text-[12px] font-mono truncate flex-1 min-w-0 text-ink/85">
          {url || "loading…"}
        </code>
        <button
          type="button"
          onClick={copy}
          disabled={!url}
          className={
            "inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11px] font-semibold transition-all " +
            (copied
              ? "bg-emerald-500 text-white"
              : "bg-accent text-white hover:-translate-y-0.5")
          }
        >
          {copied ? "Copied ✓" : "Copy link"}
        </button>
      </div>
    </section>
  );
}

function ClockSwitch({
  enabled, onToggle
}: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      role="switch"
      aria-checked={enabled}
      title={enabled ? "Clocking in: required. Click to switch off." : "Clocking in: not required. Click to switch on."}
      className={
        "relative inline-flex items-center w-9 h-5 rounded-full border transition-colors " +
        (enabled
          ? "bg-emerald-500 border-emerald-600 hover:bg-emerald-600"
          : "bg-slate-200 border-slate-300 hover:bg-slate-300")
      }
    >
      <span
        className={
          "absolute top-[1px] w-[16px] h-[16px] rounded-full bg-white shadow-sm transition-transform " +
          (enabled ? "translate-x-[18px]" : "translate-x-[1px]")
        }
      />
    </button>
  );
}

function RolePicker({ role, onChange }: { role: Role; onChange: (r: Role) => void }) {
  const tone = {
    leader: "text-warn border-warn/40 bg-warn/10",
    department_head: "text-accent border-accent/30 bg-accent/10",
    worker: "text-muted border-border bg-surface2"
  }[role];
  return (
    <select
      value={role}
      onChange={(e) => onChange(e.target.value as Role)}
      className={"badge cursor-pointer " + tone}
    >
      <option value="leader">Leader</option>
      <option value="department_head">Department Head</option>
      <option value="worker">Worker</option>
    </select>
  );
}

// "Reports to" dropdown. The Leader is pinned to "—" (nobody to report
// to). Heads default to "Leader" when unset but can be re-pointed at
// another head if the org runs a co-leads / pod structure. Workers can
// pick the dept head or any other same-dept member as a team lead.
// `excluded` is the set of ids that would create a cycle (self +
// descendants) — passed in pre-computed.
function ManagerPicker({
  user, people, excluded, onChange
}: {
  user: User;
  people: User[];
  excluded: Set<string>;
  onChange: (managerId: string | null) => void;
}) {
  if (user.role === "leader") {
    return <span className="text-muted">—</span>;
  }
  // Candidate pool: anyone in a shared dept (preferring dept heads first,
  // then workers), minus the user themself and their downstream tree.
  // Falls back to all non-leader users when the person hasn't been
  // assigned a department yet — at least the picker is usable then.
  const sameDept = (other: User) =>
    other.departmentIds.some((d) => user.departmentIds.includes(d));
  const pool = people.filter((p) =>
    p.id !== user.id &&
    !excluded.has(p.id) &&
    (user.departmentIds.length === 0 || sameDept(p) || p.role === "leader")
  );
  const sorted = [...pool].sort((a, b) => {
    const rankA = a.role === "leader" ? 0 : a.role === "department_head" ? 1 : 2;
    const rankB = b.role === "leader" ? 0 : b.role === "department_head" ? 1 : 2;
    return rankA - rankB || a.name.localeCompare(b.name);
  });
  // Auto-fallback label for the empty-string option matches what the
  // OrgChart renderer does: workers without an explicit manager nest
  // under the dept head; a head without one reports to the Leader.
  const fallback = (() => {
    if (user.role === "department_head") {
      const leader = people.find((p) => p.role === "leader");
      return leader ? `Auto: ${leader.name}` : "Auto: Leader";
    }
    const dep = user.departmentIds[0];
    const head = dep ? people.find((x) => x.role === "department_head" && x.departmentIds.includes(dep)) : null;
    return head ? `Auto: ${head.name}` : "Auto: dept head";
  })();
  return (
    <select
      value={user.managerId ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className="text-xs border border-border rounded-md px-1.5 py-1 bg-white hover:border-accent/40 cursor-pointer max-w-[180px]"
    >
      <option value="">{fallback}</option>
      {sorted.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
          {p.role === "department_head" ? " · head" : p.role === "leader" ? " · leader" : ""}
        </option>
      ))}
    </select>
  );
}

/* ---------------- Departments ---------------- */

function DepartmentsTab({
  departments, setDepartments, people, tasks
}: { departments: Department[]; setDepartments: (d: Department[]) => void; people: User[]; tasks: Task[] }) {
  const [draftName, setDraftName] = useState("");
  const [draftDesc, setDraftDesc] = useState("");

  function addDept() {
    const name = draftName.trim();
    if (!name) return;
    const id = "dep_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24);
    if (departments.some((d) => d.id === id)) return;
    setDepartments([...departments, { id, name, description: draftDesc.trim() || "—", taskTypes: [] }]);
    setDraftName(""); setDraftDesc("");
  }

  const currentUser = useCurrentUser();
  return (
    <div className="space-y-4">
      {/* Mirror of the same section in Settings — keeps the EOD channel
          mapping reachable from wherever the Leader is editing the org
          structure. Leader-only edit. */}
      <DepartmentSlackSection canEdit={currentUser?.role === "leader" || !!currentUser?.isAdmin} />

      <div className="grid grid-cols-2 gap-3">
        {departments.map((d) => {
          const heads = people.filter((u) => u.role === "department_head" && u.departmentIds.includes(d.id));
          const workers = people.filter((u) => u.role === "worker" && u.departmentIds.includes(d.id));
          // Open task count for the "View tasks" deep link.
          const openTaskCount = tasks.filter((t) => t.departmentId === d.id && t.status !== "done").length;
          return (
            <div key={d.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-muted" />
                    <div className="text-sm font-medium">{d.name}</div>
                  </div>
                  <div className="text-xs text-muted mt-0.5 max-w-md">{d.description}</div>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <span className="text-[11px] text-muted">{workers.length + heads.length} member{workers.length + heads.length === 1 ? "" : "s"}</span>
                  <Link
                    href={`/tasks/board?dept=${encodeURIComponent(d.id)}`}
                    className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-gradient-to-r from-blue-100 to-indigo-100 text-indigo-700 border border-indigo-200/60 hover:shadow-sm hover:-translate-y-0.5 transition-all"
                  >
                    View {openTaskCount} task{openTaskCount === 1 ? "" : "s"}
                    <ArrowRight className="w-3 h-3" />
                  </Link>
                </div>
              </div>

              <div className="mt-3">
                <div className="text-[11px] uppercase tracking-wide text-muted mb-1.5">Heads</div>
                <div className="flex flex-wrap gap-2">
                  {heads.length === 0 && <span className="text-xs text-muted">— no head assigned —</span>}
                  {heads.map((h) => (
                    <span key={h.id} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-accent/10 border border-accent/30 text-accent text-xs">
                      <PersonAvatar userId={h.id} name={h.name} imageUrl={h.avatarUrl} size={16} /> {h.name}
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-3">
                <div className="text-[11px] uppercase tracking-wide text-muted mb-1.5">Workers</div>
                <div className="flex flex-wrap gap-2">
                  {workers.map((w) => (
                    <span key={w.id} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-surface2 border border-border text-xs">
                      <PersonAvatar userId={w.id} name={w.name} imageUrl={w.avatarUrl} size={16} /> {w.name}
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {d.taskTypes.map((t) => <span key={t} className="badge badge-tag">{t}</span>)}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card p-4">
        <div className="text-sm font-medium mb-3 inline-flex items-center gap-1.5">
          <Plus className="w-4 h-4" /> Add a department
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Name</label>
            <input className="input" placeholder="e.g. Design" value={draftName} onChange={(e) => setDraftName(e.target.value)} />
          </div>
          <div>
            <label className="label">Description</label>
            <input className="input" placeholder="What does this department own?" value={draftDesc} onChange={(e) => setDraftDesc(e.target.value)} />
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <button onClick={addDept} className="btn-primary">
            <Plus className="w-4 h-4" /> Create
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Org chart ---------------- */

function OrgChartTab({ people, departments, tasks }: { people: User[]; departments: Department[]; tasks: Task[] }) {
  // Every leader sits at the top — co-leads / right-hand setups render
  // side-by-side rather than us picking one.
  const leaders = people.filter((u) => u.role === "leader");

  // Org-wide aggregates. "Completed this week" counts tasks whose status is
  // `done` AND whose lastActivityAt — the timestamp the task changed state —
  // landed within the last 7 days. There's no separate completedAt column
  // but lastActivityAt is the canonical write on status change.
  const weekAgo = Date.now() - 7 * 86_400_000;
  const completedThisWeek = tasks.filter(
    (t) => t.status === "done" && new Date(t.lastActivityAt).getTime() >= weekAgo
  ).length;
  const openCount = tasks.filter((t) => t.status !== "done").length;
  const urgentCount = tasks.filter(
    (t) => (t.status === "urgent" || t.priority === "critical") && t.status !== "done"
  ).length;
  const stalledCount = tasks.filter((t) => t.inactiveFlag && t.status !== "done").length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <OrgStat
          label="Completed this week"
          value={completedThisWeek}
          icon={<CheckCircle2 className="w-3.5 h-3.5" />}
          tone="indigo"
        />
        <OrgStat
          label="Open across org"
          value={openCount}
          icon={<ListChecks className="w-3.5 h-3.5" />}
          tone="blue"
        />
        <OrgStat
          label="Urgent / critical"
          value={urgentCount}
          icon={<AlertTriangle className="w-3.5 h-3.5" />}
          tone="purple"
        />
        <OrgStat
          label="Stalled"
          value={stalledCount}
          icon={<Timer className="w-3.5 h-3.5" />}
          tone="violet"
        />
      </div>

      <OnShiftList />

      <OrgChart
        ceo={leaders}
        users={people}
        departments={departments}
        tasks={tasks}
      />
    </div>
  );
}

function OrgStat({
  label, value, icon, tone
}: {
  label: string; value: number; icon: React.ReactNode;
  tone: "blue" | "indigo" | "violet" | "purple";
}) {
  const TONES = {
    blue:   { bg: "from-blue-100 to-blue-50",     iconBg: "bg-blue-500",   iconText: "text-blue-700" },
    indigo: { bg: "from-indigo-100 to-indigo-50", iconBg: "bg-indigo-500", iconText: "text-indigo-700" },
    violet: { bg: "from-indigo-100 to-indigo-50", iconBg: "bg-indigo-500", iconText: "text-indigo-700" },
    purple: { bg: "from-blue-100 to-blue-50", iconBg: "bg-blue-500", iconText: "text-blue-700" }
  } as const;
  const t = TONES[tone];
  return (
    <div className={`rounded-xl border border-white/60 shadow-soft bg-gradient-to-br ${t.bg} px-3 py-2.5 flex items-center gap-2.5`}>
      <div className={`w-7 h-7 rounded-lg grid place-items-center text-white shrink-0 ${t.iconBg}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-ink/60 truncate">{label}</div>
        <div className={`text-lg font-semibold tabular-nums ${t.iconText}`}>{value}</div>
      </div>
    </div>
  );
}

/* ---------------- All tasks ---------------- */

function AllTasksTab({ people, departments, tasks }: { people: User[]; departments: Department[]; tasks: Task[] }) {
  const grouped = useMemo(() => {
    return departments.map((d) => {
      const members = people.filter((u) => u.departmentIds.includes(d.id));
      const rows = members.map((u) => {
        const my = tasks.filter((t) => t.assigneeId === u.id);
        const open = my.filter((t) => t.status !== "done");
        return {
          user: u,
          open: open.length,
          inProgress: my.filter((t) => t.status === "in_progress").length,
          urgent: my.filter((t) => t.status === "urgent" || t.priority === "critical").length,
          stalled: my.filter((t) => t.inactiveFlag).length,
          done: my.filter((t) => t.status === "done").length,
          cap: userCapacity(u, tasks)
        };
      });
      return { dept: d, rows };
    });
  }, [people, departments, tasks]);

  return (
    <div className="space-y-5">
      {grouped.map(({ dept, rows }) => (
        <section key={dept.id} className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-surface2/60 flex items-center gap-2">
            <Building2 className="w-4 h-4 text-muted" />
            <div className="text-sm font-medium">{dept.name}</div>
            <div className="text-xs text-muted ml-auto">{rows.length} member{rows.length === 1 ? "" : "s"}</div>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-surface/40">
              <tr className="text-left text-xs text-muted">
                <th className="px-4 py-2 font-normal">Person</th>
                <th className="px-4 py-2 font-normal">Open</th>
                <th className="px-4 py-2 font-normal">In progress</th>
                <th className="px-4 py-2 font-normal">Urgent</th>
                <th className="px-4 py-2 font-normal">Stalled</th>
                <th className="px-4 py-2 font-normal">Done</th>
                <th className="px-4 py-2 font-normal w-40">Capacity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ user, open, inProgress, urgent, stalled, done, cap }) => (
                <tr key={user.id} className="border-t border-border/60">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <PersonAvatar userId={user.id} name={user.name} imageUrl={user.avatarUrl} size={22} />
                      <span>{user.name}</span>
                      <span className="text-[10px] text-muted">{ROLE_LABELS[user.role]}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">{open}</td>
                  <td className="px-4 py-2.5">{inProgress}</td>
                  <td className={"px-4 py-2.5 " + (urgent > 0 ? "text-urgent" : "")}>{urgent}</td>
                  <td className={"px-4 py-2.5 " + (stalled > 0 ? "text-stalled" : "")}>{stalled}</td>
                  <td className="px-4 py-2.5 text-muted">{done}</td>
                  <td className="px-4 py-2.5"><CapacityBar pct={cap.pct} overSoft={cap.overSoft} overBuffer={cap.overBuffer} /></td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-3 text-sm text-muted">No members in this department.</td></tr>
              )}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

// Tiny "N tasks awaiting review" banner that deep-links to the dedicated
// /routing-review page. Replaces the legacy inline draft list — the
// full review surface lives there now.
function RoutingReviewBanner() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/routing-review", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        setCount(Array.isArray(j.pending) ? j.pending.length : 0);
      })
      .catch(() => { /* leave null — banner hides */ });
    return () => { cancelled = true; };
  }, []);
  if (count === null || count === 0) return null;
  return (
    <Link
      href="/routing-review"
      className="group flex items-center gap-3 rounded-2xl border border-emerald-200/60 bg-gradient-to-r from-emerald-50 via-white to-white px-4 py-3 shadow-soft hover:shadow-lift transition-all"
    >
      <div className="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-700 grid place-items-center shrink-0">
        <Sparkles className="w-4 h-4" />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-emerald-900">
          {count} task{count === 1 ? "" : "s"} awaiting your review
        </div>
        <div className="text-[11px] text-ink/55">
          AI-routed drafts ready for approve / edit / deny.
        </div>
      </div>
      <ArrowRight className="ml-auto w-4 h-4 text-emerald-600 group-hover:translate-x-0.5 transition-transform" />
    </Link>
  );
}
