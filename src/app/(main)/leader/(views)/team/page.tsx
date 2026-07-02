"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { OrgChart } from "@/components/OrgChart";
import { useCurrentUser } from "@/lib/user-context";
import { PageHero } from "@/components/PageHero";
import { Countdown } from "@/components/Countdown";
import { Users as UsersIcon, ShieldAlert, ListChecks, CheckCircle2, AlertTriangle, Flame, Sparkles, ClipboardCheck, ArrowRight } from "lucide-react";
import type { User, Department, Task } from "@/lib/types";

// Department-head console. Pulls live users/departments/tasks (falls
// back to mock seed during initial paint), scopes everything to the
// head's home departments, and surfaces the bits a head actually wants
// to act on: a stat strip, today's deliverables, stalled work, and the
// compact org chart underneath.
export default function TeamOverviewPage() {
  const currentUser = useCurrentUser();
  const router = useRouter();

  const [users, setUsers] = useState<User[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  // Just the count for the routing-review banner. Cheap fetch; we
  // intentionally don't render the full draft list here anymore —
  // /routing-review is the dedicated surface.
  const [routingPending, setRoutingPending] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/routing-review", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        setRoutingPending(Array.isArray(j.pending) ? j.pending.length : 0);
      })
      .catch(() => { /* leave null — banner just hides */ });
    return () => { cancelled = true; };
  }, []);

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
          setUsers(uRes.users.map((u: any) => ({
            id: u.id,
            name: u.name,
            email: u.email,
            role: u.role,
            departmentIds: u.departmentIds ?? [],
            skills: [],
            dailyCapacity: u.dailyCapacity ?? 8,
            throughput: {},
            avatarUrl: u.avatarUrl ?? undefined
          })));
        }
        if (Array.isArray(dRes?.departments)) {
          setDepartments(dRes.departments.map((d: any) => ({
            id: d.id, name: d.name, description: "", taskTypes: []
          })));
        }
        if (Array.isArray(tRes?.tasks)) {
          setTasks(tRes.tasks);
        }
      })
      .catch(() => { /* keep empty arrays — surface as zero state */ });
    return () => { cancelled = true; };
  }, []);

  // Role gates. Leader is nudged to /leader (which has the full
  // version + management tabs); workers don't get team scope, so
  // they're bounced home.
  if (currentUser.role === "leader" || currentUser.isAdmin) {
    if (typeof window !== "undefined") router.replace("/leader");
    return null;
  }
  if (currentUser.role !== "department_head") {
    return (
      <div className="card p-6 max-w-lg mx-auto mt-12 text-center">
        <ShieldAlert className="w-8 h-8 text-warn mx-auto mb-2" />
        <div className="text-base font-medium">Department heads only</div>
        <div className="text-sm text-muted mt-1">
          This view shows your team's open tasks and deadlines. You're a worker —
          check <a href="/tasks/mine" className="text-accent underline">My Tasks</a> instead.
        </div>
      </div>
    );
  }

  const myDeptIds = currentUser.departmentIds;

  const scopedDepts = useMemo(
    () => departments.filter((d) => myDeptIds.includes(d.id)),
    [departments, myDeptIds]
  );
  const scopedUsers = useMemo(
    () => users.filter((u) => u.departmentIds.some((d) => myDeptIds.includes(d))),
    [users, myDeptIds]
  );
  const scopedUserIds = useMemo(
    () => new Set(scopedUsers.map((u) => u.id)),
    [scopedUsers]
  );
  const scopedTasks = useMemo(
    () => tasks.filter((t) => t.assigneeId && scopedUserIds.has(t.assigneeId)),
    [tasks, scopedUserIds]
  );

  // --- aggregates for the stat strip + side panels ---
  const now = Date.now();
  const dayMs = 86_400_000;
  const weekAgoMs = now - 7 * dayMs;
  const tomorrowMs = now + dayMs;

  const open = scopedTasks.filter((t) => t.status !== "done");
  const doneThisWeek = scopedTasks.filter(
    (t) => t.status === "done" && t.completedAt != null && new Date(t.completedAt).getTime() >= weekAgoMs
  );
  const overdue = open.filter(
    (t) => t.dueDate && new Date(t.dueDate).getTime() < now
  );
  const dueToday = open.filter((t) => {
    if (!t.dueDate) return false;
    const ms = new Date(t.dueDate).getTime();
    return ms >= now && ms < tomorrowMs;
  });
  const stalled = open.filter((t) => t.inactiveFlag);
  const inProgress = open.filter((t) => t.status === "in_progress");

  const userById = new Map(scopedUsers.map((u) => [u.id, u]));
  const deptNames = scopedDepts.map((d) => d.name).join(", ") || "your team";

  // Sort due-today + stalled by urgency for the side panels.
  const focusList = [...dueToday]
    .sort((a, b) =>
      (a.dueDate ? new Date(a.dueDate).getTime() : Infinity) -
      (b.dueDate ? new Date(b.dueDate).getTime() : Infinity)
    )
    .slice(0, 6);
  const stalledList = stalled
    .sort(
      (a, b) =>
        new Date(a.lastActivityAt).getTime() -
        new Date(b.lastActivityAt).getTime()
    )
    .slice(0, 6);
  const recentlyDone = doneThisWeek
    .sort(
      (a, b) =>
        new Date(b.completedAt ?? 0).getTime() -
        new Date(a.completedAt ?? 0).getTime()
    )
    .slice(0, 6);

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Team Overview"
        headline={[
          { accent: deptNames },
          " · what your team's doing"
        ]}
        subtitle="People, today's deliverables, and what's stalled — all scoped to your department."
        icon={<UsersIcon />}
        iconTone="emerald"
      />

      {routingPending !== null && routingPending > 0 && (
        <Link
          href="/routing-review"
          className="group flex items-center gap-3 rounded-2xl border border-emerald-200/60 bg-gradient-to-r from-emerald-50 via-white to-white px-4 py-3 shadow-soft hover:shadow-lift transition-all"
        >
          <div className="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-700 grid place-items-center shrink-0">
            <ClipboardCheck className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-emerald-900">
              {routingPending} task{routingPending === 1 ? "" : "s"} awaiting your review
            </div>
            <div className="text-[11px] text-ink/55">
              AI-routed drafts ready for approve / edit / deny.
            </div>
          </div>
          <ArrowRight className="ml-auto w-4 h-4 text-emerald-600 group-hover:translate-x-0.5 transition-transform" />
        </Link>
      )}

      {/* Stat strip — at-a-glance load on the team. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Open"
          value={open.length}
          subline={`${inProgress.length} in progress`}
          icon={<ListChecks className="w-4 h-4" />}
          tone="indigo"
        />
        <StatCard
          label="Done this week"
          value={doneThisWeek.length}
          subline="last 7 days"
          icon={<CheckCircle2 className="w-4 h-4" />}
          tone="emerald"
        />
        <StatCard
          label="Overdue"
          value={overdue.length}
          subline={overdue.length === 0 ? "all clear" : "past due date"}
          icon={<AlertTriangle className="w-4 h-4" />}
          tone={overdue.length > 0 ? "rose" : "slate"}
        />
        <StatCard
          label="Stalled"
          value={stalled.length}
          subline="48h+ no activity"
          icon={<Flame className="w-4 h-4" />}
          tone={stalled.length > 0 ? "amber" : "slate"}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <TaskPanel
          title="Due today"
          icon={<Flame className="w-4 h-4 text-rose-500" />}
          tasks={focusList}
          userById={userById}
          empty="Nothing due today — breathe."
        />
        <TaskPanel
          title="Stalled"
          icon={<AlertTriangle className="w-4 h-4 text-amber-500" />}
          tasks={stalledList}
          userById={userById}
          empty="Nothing stalled. Nice."
        />
        <TaskPanel
          title="Recently shipped"
          icon={<Sparkles className="w-4 h-4 text-emerald-500" />}
          tasks={recentlyDone}
          userById={userById}
          empty="Nothing finished this week yet."
          completed
        />
      </div>

      <OrgChart
        users={scopedUsers}
        departments={scopedDepts}
        tasks={scopedTasks}
        ceo={null}
      />
    </div>
  );
}

function StatCard({
  label, value, subline, icon, tone
}: {
  label: string;
  value: number;
  subline: string;
  icon: React.ReactNode;
  tone: "indigo" | "emerald" | "rose" | "amber" | "slate";
}) {
  const toneClasses = {
    indigo: "from-indigo-50 to-indigo-100 text-indigo-700 border-indigo-200/60",
    emerald: "from-emerald-50 to-emerald-100 text-emerald-700 border-emerald-200/60",
    rose: "from-rose-50 to-rose-100 text-rose-700 border-rose-200/60",
    amber: "from-amber-50 to-amber-100 text-amber-700 border-amber-200/60",
    slate: "from-slate-50 to-slate-100 text-slate-600 border-slate-200/60"
  }[tone];
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border bg-gradient-to-br ${toneClasses} p-4 shadow-soft`}
    >
      <div className="flex items-center justify-between text-[11px] uppercase tracking-wide font-semibold opacity-80">
        <span>{label}</span>
        {icon}
      </div>
      <div className="text-3xl font-bold tabular-nums mt-1">{value}</div>
      <div className="text-[11px] opacity-70 mt-0.5">{subline}</div>
    </div>
  );
}

function TaskPanel({
  title, icon, tasks, userById, empty, completed
}: {
  title: string;
  icon: React.ReactNode;
  tasks: Task[];
  userById: Map<string, User>;
  empty: string;
  completed?: boolean;
}) {
  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
        {icon}
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-xs text-ink/55 ml-auto tabular-nums">{tasks.length}</div>
      </div>
      {tasks.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-ink/55 italic">{empty}</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {tasks.map((t) => {
            const assignee = t.assigneeId ? userById.get(t.assigneeId) : null;
            return (
              <li key={t.id}>
                <Link
                  href={`/tasks/${t.id}`}
                  className="block px-4 py-2.5 hover:bg-slate-50 transition-colors"
                >
                  <div className="text-[13px] font-medium text-ink truncate">{t.title}</div>
                  <div className="text-[10px] text-ink/55 mt-0.5 flex items-center gap-2">
                    {assignee && <span>{assignee.name}</span>}
                    {!completed && t.dueDate && (
                      <span>· <Countdown iso={t.dueDate} /></span>
                    )}
                    {completed && (
                      <span>· {timeAgo(t.lastActivityAt)}</span>
                    )}
                    <span className="px-1.5 py-0.5 rounded bg-slate-100">{t.priority}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}
