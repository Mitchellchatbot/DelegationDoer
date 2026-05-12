"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  users as initialUsers, departments as initialDepartments,
  tasks, headsOf, workersOf
} from "@/lib/mock-data";
import type { Task } from "@/lib/types";
import { Avatar } from "@/components/Avatar";
import { PersonAvatar } from "@/components/PersonAvatar";
import { CapacityBar } from "@/components/CapacityBar";
import { OrgChart } from "@/components/OrgChart";
import { OnShiftList } from "@/components/OnShiftList";
import { PerformanceReview } from "@/components/PerformanceReview";
import { PageHero } from "@/components/PageHero";
import { ProfileDialog } from "@/components/ProfileDialog";
import { SendKudosDialog } from "@/components/SendKudosDialog";
import { DepartmentSlackSection } from "@/components/DepartmentSlackSection";
import { InvitePersonDialog } from "@/components/InvitePersonDialog";
import { userCapacity } from "@/lib/capacity";
import { ROLE_LABELS } from "@/lib/auth";
import { useCurrentUser } from "@/lib/user-context";
import type { Role, User, Department } from "@/lib/types";
import Link from "next/link";
import {
  Crown, Users as UsersIcon, Building2, ListChecks, Plus, X, ShieldAlert,
  CheckCircle2, AlertTriangle, Timer, ArrowRight, Sparkles, ChevronRight, Clock,
  UserPlus
} from "lucide-react";

const TABS = ["People", "Departments", "Org chart", "Performance", "All tasks"] as const;
type Tab = typeof TABS[number];

export default function CEOConsolePage() {
  const currentUser = useCurrentUser();
  const [tab, setTab] = useState<Tab>("People");
  const [people, setPeople] = useState<User[]>(initialUsers);
  const [depts, setDepts] = useState<Department[]>(initialDepartments);

  // Gate the page itself.
  if (currentUser.role !== "ceo") {
    return (
      <div className="card p-6 max-w-lg mx-auto mt-12 text-center">
        <ShieldAlert className="w-8 h-8 text-warn mx-auto mb-2" />
        <div className="text-base font-medium">CEO only</div>
        <div className="text-sm text-muted mt-1">This page is restricted to the CEO role.</div>
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <PageHero
        eyebrow="CEO Console"
        headline={["Company-wide ", { accent: "control" }]}
        subtitle="People, departments, the org chart, every task in flight — all in one place."
        icon={<Crown />}
        iconTone="amber"
      />

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
                  layoutId="ceo-tab-underline"
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
          {tab === "Departments" && <DepartmentsTab departments={depts} setDepartments={setDepts} people={people} />}
          {tab === "Org chart" && <OrgChartTab people={people} departments={depts} />}
          {tab === "Performance" && <PerformanceReview canCrown={currentUser.role === "ceo"} />}
          {tab === "All tasks" && <AllTasksTab people={people} departments={depts} />}
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
  // The rest of the CEO page reads from mock tasks for legacy capacity
  // math (visualisations don't depend on real-time accuracy), but the
  // inline drilldown DOES need the real tasks — otherwise we render
  // "nothing assigned" for someone with 22 urgent tasks in Supabase.
  // Fetch once when the tab mounts. The /api/tasks route already
  // returns the org-wide snapshot.
  const [liveTasks, setLiveTasks] = useState<Task[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/tasks", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data?.tasks) setLiveTasks(data.tasks as Task[]);
      })
      .catch(() => { /* leave null → falls back to mock */ });
    return () => { cancelled = true; };
  }, []);

  function setRole(id: string, role: Role) {
    setPeople(people.map((u) => u.id === id ? { ...u, role } : u));
  }
  function toggleDept(id: string, deptId: string) {
    setPeople(people.map((u) => {
      if (u.id !== id) return u;
      const has = u.departmentIds.includes(deptId);
      return { ...u, departmentIds: has ? u.departmentIds.filter((d) => d !== deptId) : [...u.departmentIds, deptId] };
    }));
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted">
          Click any role pill to change it. Toggle department chips to set membership / leadership.
        </div>
        <InvitePersonDialog
          trigger={
            <button
              type="button"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lift active:scale-95"
              style={{ background: "linear-gradient(135deg, #2563EB 0%, #1e63ff 100%)" }}
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
              <th className="px-4 py-2.5 font-normal text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {people.map((u) => {
              const reportsTo = u.role === "ceo"
                ? "—"
                : u.role === "department_head"
                  ? "CEO"
                  : (() => {
                      const dep = u.departmentIds[0];
                      const head = dep ? people.find((x) => x.role === "department_head" && x.departmentIds.includes(dep)) : null;
                      return head?.name ?? "—";
                    })();
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
                  <td className="px-4 py-3 text-muted">{reportsTo}</td>
                  <td className="px-4 py-3 text-right">
                    {/* Self-row gets no Send-kudos button (you can't kudos
                        yourself); everyone else does. */}
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
                  </td>
                </tr>
                {isExpanded && (
                  <tr className="bg-slate-50/40">
                    <td className="w-8" />
                    <td colSpan={5} className="px-4 py-3">
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

function RolePicker({ role, onChange }: { role: Role; onChange: (r: Role) => void }) {
  const tone = {
    ceo: "text-warn border-warn/40 bg-warn/10",
    department_head: "text-accent border-accent/30 bg-accent/10",
    worker: "text-muted border-border bg-surface2"
  }[role];
  return (
    <select
      value={role}
      onChange={(e) => onChange(e.target.value as Role)}
      className={"badge cursor-pointer " + tone}
    >
      <option value="ceo">CEO</option>
      <option value="department_head">Department Head</option>
      <option value="worker">Worker</option>
    </select>
  );
}

/* ---------------- Departments ---------------- */

function DepartmentsTab({
  departments, setDepartments, people
}: { departments: Department[]; setDepartments: (d: Department[]) => void; people: User[] }) {
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
          mapping reachable from wherever the CEO is editing the org
          structure. CEO-only edit. */}
      <DepartmentSlackSection canEdit={currentUser?.role === "ceo"} />

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
                    href={`/board?dept=${encodeURIComponent(d.id)}`}
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

function OrgChartTab({ people, departments }: { people: User[]; departments: Department[] }) {
  const ceo = people.find((u) => u.role === "ceo") ?? null;

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
        ceo={ceo}
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

function AllTasksTab({ people, departments }: { people: User[]; departments: Department[] }) {
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
  }, [people, departments]);

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
