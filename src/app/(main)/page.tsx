import Link from "next/link";
import { redirect } from "next/navigation";
import { tasks, users, departments, currentUser, activity, userById } from "@/lib/mock-data";
import { TaskCard } from "@/components/TaskCard";
import { CapacityBar } from "@/components/CapacityBar";
import { Avatar } from "@/components/Avatar";
import { userCapacity } from "@/lib/capacity";
import { relativeTime } from "@/lib/utils";
import { ListTodo, AlertTriangle, Activity as ActivityIcon, Timer } from "lucide-react";

export default function DashboardPage() {
  // CEOs land on the Console instead of the personal Dashboard.
  if (currentUser.role === "ceo") redirect("/ceo");

  const myTasks = tasks.filter((t) => t.assigneeId === currentUser.id && t.status !== "done");
  const urgent = tasks.filter((t) => t.status === "urgent" || t.priority === "critical");
  const stalled = tasks.filter((t) => t.inactiveFlag);
  const dueThisWeek = tasks.filter((t) => t.dueDate && new Date(t.dueDate).getTime() < Date.now() + 7 * 86400000 && t.status !== "done").length;

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-xl font-medium">Good afternoon, {currentUser.name.split(" ")[0]}.</h1>
        <p className="text-sm text-muted mt-1">Here's what actually matters today.</p>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <StatCard label="My focus today" value={myTasks.length} icon={<ListTodo className="w-4 h-4" />} />
        <StatCard label="Urgent / critical" value={urgent.length} icon={<AlertTriangle className="w-4 h-4" />} tone="urgent" />
        <StatCard label="Stalled (48h+)" value={stalled.length} icon={<Timer className="w-4 h-4" />} tone="stalled" />
        <StatCard label="Due this week" value={dueThisWeek} icon={<ActivityIcon className="w-4 h-4" />} />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <section className="col-span-2 card p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-medium">My focus tasks</div>
            <Link href="/my-tasks" className="text-xs text-muted hover:text-ink">Open focus mode →</Link>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {myTasks.slice(0, 4).map((t) => <TaskCard key={t.id} task={t} />)}
            {myTasks.length === 0 && <div className="text-sm text-muted">Nothing assigned to you.</div>}
          </div>
        </section>

        <section className="card p-4">
          <div className="text-sm font-medium mb-3">Team capacity</div>
          <div className="space-y-3">
            {users.slice(0, 5).map((u) => {
              const cap = userCapacity(u, tasks);
              return (
                <div key={u.id}>
                  <div className="flex items-center gap-2 mb-1">
                    <Avatar name={u.name} size={20} />
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

      <section className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium">Recent activity</div>
          <Link href="/board" className="text-xs text-muted hover:text-ink">Open board →</Link>
        </div>
        <ul className="divide-y divide-border">
          {activity.slice().reverse().slice(0, 8).map((a) => {
            const u = userById(a.userId);
            const t = tasks.find((x) => x.id === a.taskId);
            return (
              <li key={a.id} className="py-2 flex items-center gap-3 text-sm">
                {u && <Avatar name={u.name} size={20} />}
                <div className="text-ink">{u?.name}</div>
                <div className="text-muted">{a.action.replace("_", " ")}</div>
                <Link href={`/tasks/${t?.id}`} className="text-accent hover:underline truncate">
                  {t?.title}
                </Link>
                <div className="ml-auto text-muted text-xs">{relativeTime(a.createdAt)}</div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function StatCard({ label, value, icon, tone }: { label: string; value: number; icon: React.ReactNode; tone?: "urgent" | "stalled" }) {
  const tint =
    tone === "urgent" ? "text-urgent border-urgent/30 bg-urgent/10"
    : tone === "stalled" ? "text-stalled border-stalled/30 bg-stalled/10"
    : "text-accent border-accent/30 bg-accent/10";
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2">
        <div className={`w-7 h-7 rounded-lg grid place-items-center border ${tint}`}>{icon}</div>
        <div className="text-xs text-muted">{label}</div>
      </div>
      <div className="text-2xl font-medium mt-2">{value}</div>
    </div>
  );
}
