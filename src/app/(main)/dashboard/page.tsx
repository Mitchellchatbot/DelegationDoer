import Link from "next/link";
import { redirect } from "next/navigation";
import { tasks, users, departments, activity, userById } from "@/lib/mock-data";
import { TaskCard } from "@/components/TaskCard";
import { CapacityBar } from "@/components/CapacityBar";
import { Avatar } from "@/components/Avatar";
import { PersonAvatar } from "@/components/PersonAvatar";
import { StatCard } from "@/components/StatCard";
import { DashboardHero } from "@/components/DashboardHero";
import { PageStagger } from "@/components/PageStagger";
import { userCapacity } from "@/lib/capacity";
import { relativeTime } from "@/lib/utils";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import {
  ListTodo, AlertTriangle, Activity as ActivityIcon, Timer,
  Sparkles, MessageSquare, ArrowUpRight, Inbox
} from "lucide-react";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  // CEOs land on the Console instead of the personal Dashboard.
  if (me.role === "leader") redirect("/leader");

  const myTasks = tasks.filter((t) => t.assigneeId === me.id && t.status !== "done");
  const urgent = tasks.filter((t) => (t.status === "urgent" || t.priority === "critical") && t.status !== "done");
  const stalled = tasks.filter((t) => t.inactiveFlag && t.status !== "done");
  const dueThisWeek = tasks.filter(
    (t) => t.dueDate && new Date(t.dueDate).getTime() < Date.now() + 7 * 86400000 && t.status !== "done"
  ).length;

  const firstName = me.name.split(" ")[0];
  const subtitle =
    myTasks.length === 0
      ? "Inbox zero! Use this time to plan ahead 🎯"
      : myTasks.length === 1
        ? "One thing on your plate today. You got this."
        : `${myTasks.length} things on your plate. Let's chip away.`;

  return (
    <PageStagger className="space-y-6 max-w-7xl mx-auto">
      <DashboardHero firstName={firstName} subtitle={subtitle} />

      <div className="grid grid-cols-4 gap-3">
        <StatCard
          label="My focus today"
          value={myTasks.length}
          icon={<ListTodo className="w-4 h-4" />}
          tone="blue"
          delay={0.05}
        />
        <StatCard
          label="Urgent / critical"
          value={urgent.length}
          icon={<AlertTriangle className="w-4 h-4" />}
          tone="purple"
          delay={0.12}
        />
        <StatCard
          label="Stalled (48h+)"
          value={stalled.length}
          icon={<Timer className="w-4 h-4" />}
          tone="indigo"
          delay={0.19}
        />
        <StatCard
          label="Due this week"
          value={dueThisWeek}
          icon={<ActivityIcon className="w-4 h-4" />}
          tone="violet"
          delay={0.26}
        />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <section className="col-span-2 card p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-accent" />
              <div className="text-sm font-semibold">My focus tasks</div>
            </div>
            <Link
              href="/my-tasks"
              className="text-xs text-muted hover:text-accent inline-flex items-center gap-0.5 transition-colors"
            >
              Open focus mode <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
          {myTasks.length === 0 ? (
            <EmptyState
              icon={<Inbox className="w-8 h-8" />}
              title="All clear"
              body="Nothing assigned to you right now. Take a breath, or queue up something new."
            />
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {myTasks.slice(0, 4).map((t) => <TaskCard key={t.id} task={t} />)}
            </div>
          )}
        </section>

        <section className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="text-sm font-semibold">Team capacity</div>
            <Link
              href="/team"
              className="text-xs text-muted hover:text-accent inline-flex items-center gap-0.5 transition-colors"
            >
              All <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="space-y-3">
            {users.slice(0, 5).map((u) => {
              const cap = userCapacity(u, tasks);
              return (
                <div key={u.id}>
                  <div className="flex items-center gap-2 mb-1">
                    <PersonAvatar userId={u.id} name={u.name} imageUrl={u.avatarUrl} size={20} />
                    <div className="text-sm">{u.name}</div>
                    <div className="text-[11px] text-muted ml-auto">
                      {u.departmentIds.map((id) => departments.find((d) => d.id === id)?.name).filter(Boolean).join(" · ") || "—"}
                    </div>
                  </div>
                  <CapacityBar pct={cap.pct} overSoft={cap.overSoft} overBuffer={cap.overBuffer} />
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <section className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-accent" />
            <div className="text-sm font-semibold">Recent activity</div>
          </div>
          <Link
            href="/board"
            className="text-xs text-muted hover:text-accent inline-flex items-center gap-0.5 transition-colors"
          >
            Open board <ArrowUpRight className="w-3 h-3" />
          </Link>
        </div>
        {activity.length === 0 ? (
          <EmptyState icon={<MessageSquare className="w-8 h-8" />} title="Quiet" body="No team activity yet. Once tasks start moving, you'll see them flow through here." />
        ) : (
          <ul className="divide-y divide-border">
            {activity.slice().reverse().slice(0, 8).map((a) => {
              const u = userById(a.userId);
              const t = tasks.find((x) => x.id === a.taskId);
              return (
                <li key={a.id} className="py-2.5 flex items-center gap-3 text-sm group">
                  {u && <PersonAvatar userId={u.id} name={u.name} imageUrl={u.avatarUrl} size={22} />}
                  <div className="text-ink font-medium">{u?.name}</div>
                  <ActionPill action={a.action} />
                  <Link
                    href={`/tasks/${t?.id}`}
                    className="text-muted group-hover:text-accent truncate transition-colors"
                  >
                    {t?.title}
                  </Link>
                  <div className="ml-auto text-muted text-xs tabular-nums">{relativeTime(a.createdAt)}</div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </PageStagger>
  );
}

function ActionPill({ action }: { action: string }) {
  const tone =
    action === "created" ? "bg-blue-100 text-blue-700 border-blue-200"
    : action === "status_change" ? "bg-indigo-100 text-indigo-700 border-indigo-200"
    : action === "comment" ? "bg-indigo-100 text-indigo-700 border-indigo-200"
    : action === "extended" ? "bg-blue-100 text-blue-700 border-blue-200"
    : "bg-slate-100 text-slate-600 border-slate-200";
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-md border ${tone}`}>
      {action.replace("_", " ")}
    </span>
  );
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center text-center py-8 text-muted">
      <div className="w-14 h-14 rounded-2xl bg-accent/10 text-accent grid place-items-center mb-3">
        {icon}
      </div>
      <div className="text-sm font-medium text-ink">{title}</div>
      <div className="text-xs mt-1 max-w-xs">{body}</div>
    </div>
  );
}
