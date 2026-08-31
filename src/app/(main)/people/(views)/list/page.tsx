import { PersonAvatar } from "@/components/PersonAvatar";
import { CapacityBar } from "@/components/CapacityBar";
import { userCapacity } from "@/lib/capacity";
import { ROLE_LABELS } from "@/lib/auth";
import { Crown, Users as UsersIcon, ListChecks, CheckCircle2, Flame } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { TeamCarousel } from "@/components/TeamCarousel";
import { ProfileDialog } from "@/components/ProfileDialog";
import { getAllUsers, getAllTasks, getDepartments } from "@/lib/server-data";
import type { User, Task } from "@/lib/types";
import { isTeamTask } from "@/lib/task-team";

export const dynamic = "force-dynamic";

function statsFor(userId: string, tasks: Task[]) {
  const open = tasks.filter((t) => t.assigneeId === userId && t.status !== "done");
  const done = tasks.filter((t) => t.assigneeId === userId && t.status === "done");
  const urgent = open.filter((t) => t.priority === "critical" || t.status === "urgent").length;
  const top = [...open].sort((a, b) => {
    const aDue = a.dueDate ? +new Date(a.dueDate) : Infinity;
    const bDue = b.dueDate ? +new Date(b.dueDate) : Infinity;
    return aDue - bDue;
  })[0];
  return { openCount: open.length, doneCount: done.length, urgent, top };
}

export default async function TeamPage() {
  // Pull live workspace data — no more mock-data.
  const [users, departments, tasks] = await Promise.all([
    getAllUsers(),
    getDepartments(),
    getAllTasks()
  ]);
  const ceo = users.find((u) => u.role === "leader");
  const headsOf = (deptId: string) =>
    users.filter((u) => u.role === "department_head" && u.departmentIds.includes(deptId));
  const workersOf = (deptId: string) =>
    users.filter((u) => u.role === "worker" && u.departmentIds.includes(deptId));

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <PageHero
        eyebrow="The team"
        headline={["Everyone, ", { accent: "by department" }]}
        subtitle="Org reports up to the Leader. Click anyone to see their profile."
        icon={<UsersIcon />}
        iconTone="emerald"
      />

      <TeamCarousel users={users as User[]} departments={departments} />

      {ceo && (
        <ProfileDialog
          userId={ceo.id}
          trigger={
            <button
              type="button"
              className="w-full text-left group relative overflow-hidden rounded-2xl border border-blue-200/60 shadow-soft hover:shadow-lift transition-all hover:-translate-y-0.5 p-4 flex items-center gap-3"
              style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #DBEAFE 100%)" }}
            >
              <div className="w-11 h-11 rounded-xl bg-white/70 border border-white/80 grid place-items-center text-blue-600 shadow-sm">
                <Crown className="w-5 h-5" />
              </div>
              <PersonAvatar userId={ceo.id} name={ceo.name} imageUrl={ceo.avatarUrl} size={36} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold truncate">{ceo.name}</div>
                <div className="text-xs text-ink/60">Leader · everyone reports up here</div>
              </div>
              <span className="text-[10px] uppercase tracking-wide text-blue-700 bg-white/70 px-2 py-0.5 rounded-full border border-blue-200/60">
                Org leader
              </span>
            </button>
          }
        />
      )}

      {departments.map((d) => {
        const heads = headsOf(d.id);
        const workers = workersOf(d.id);
        const memberIds = new Set([...heads, ...workers].map((u) => u.id));
        // Owned by a member OR queued to the department and unclaimed —
        // otherwise a team's pool is invisible in its own header count.
        const inThisDept = (t: Task) =>
          t.assigneeId ? memberIds.has(t.assigneeId) : isTeamTask(t) && t.departmentId === d.id;
        const deptOpen = tasks.filter((t) => inThisDept(t) && t.status !== "done").length;
        const deptDone = tasks.filter((t) => inThisDept(t) && t.status === "done").length;
        return (
          <section
            key={d.id}
            className="relative overflow-hidden rounded-3xl border border-white/60 bg-gradient-to-br from-blue-50/60 via-white/60 to-indigo-50/40 backdrop-blur-sm p-5 space-y-4"
          >
            <div className="flex items-baseline gap-3 flex-wrap">
              <h2 className="text-base font-semibold">{d.name}</h2>
              <div className="text-xs text-ink/60">{d.description}</div>
              <div className="ml-auto flex items-center gap-2 text-xs">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100/80 text-blue-700 border border-blue-200/60">
                  <UsersIcon className="w-3 h-3" />
                  {memberIds.size} {memberIds.size === 1 ? "person" : "people"}
                </span>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-100/80 text-indigo-700 border border-indigo-200/60">
                  <ListChecks className="w-3 h-3" />
                  {deptOpen} open
                </span>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100/80 text-emerald-700 border border-emerald-200/60">
                  <CheckCircle2 className="w-3 h-3" />
                  {deptDone} done
                </span>
              </div>
            </div>

            {heads.length === 0 && workers.length === 0 ? (
              <div className="card p-4 text-sm text-muted">No members yet.</div>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                {heads.map((u) => <PersonCard key={u.id} user={u} tasks={tasks} accent />)}
                {workers.map((u) => <PersonCard key={u.id} user={u} tasks={tasks} />)}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function PersonCard({ user, tasks, accent }: { user: User; tasks: Task[]; accent?: boolean }) {
  const cap = userCapacity(user, tasks);
  // Live /api/skills is fetched per profile dialog; the inline chip
  // row here uses the User.skills text array we already have so the
  // card stays SSR-only.
  const skills = (user.skills ?? []).map((s, i) => ({ id: `${user.id}-${i}`, skillName: s, experienceLevel: 0 }));
  const stats = statsFor(user.id, tasks);
  // Gold wash for heads, brand-blue wash for workers.
  const headBg = "bg-gradient-to-br from-amber-100/80 via-white/65 to-amber-50/50 border-amber-200/70";
  const workerBg = "bg-gradient-to-br from-blue-100/80 via-white/65 to-blue-50/50 border-blue-200/60";
  return (
    <ProfileDialog
      userId={user.id}
      trigger={
        <button
          type="button"
          className={
            "group relative overflow-hidden rounded-2xl border backdrop-blur-md shadow-soft hover:shadow-lift transition-all hover:-translate-y-0.5 p-4 block w-full text-left " +
            (accent ? headBg : workerBg)
          }
        >
      <div className="flex items-center gap-3">
        <PersonAvatar
          userId={user.id}
          name={user.name}
          imageUrl={user.avatarUrl}
          size={44}
          className={"ring-2 shadow-sm " + (accent ? "ring-amber-200" : "ring-white")}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate flex items-center gap-1.5">
            {user.name}
            {user.role === "department_head" && (
              <Crown className="w-3.5 h-3.5 text-amber-500 shrink-0" />
            )}
          </div>
          <div className="text-xs text-ink/60">{ROLE_LABELS[user.role]} · {user.dailyCapacity}h/day</div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
        <div className="rounded-lg bg-white/70 border border-white/80 px-2 py-1.5 text-center">
          <div className="font-semibold text-ink tabular-nums">{stats.openCount}</div>
          <div className="text-ink/55">open</div>
        </div>
        <div className="rounded-lg bg-white/70 border border-white/80 px-2 py-1.5 text-center">
          <div className="font-semibold text-emerald-700 tabular-nums">{stats.doneCount}</div>
          <div className="text-ink/55">done</div>
        </div>
        <div className="rounded-lg bg-white/70 border border-white/80 px-2 py-1.5 text-center">
          <div className="font-semibold text-rose-600 tabular-nums">{stats.urgent}</div>
          <div className="text-ink/55">urgent</div>
        </div>
      </div>

      {stats.top && (
        <div className="mt-2.5 text-[11px] text-ink/70 line-clamp-1 inline-flex items-center gap-1">
          <Flame className="w-3 h-3 text-amber-500 shrink-0" />
          {stats.top.title}
        </div>
      )}

      <div className="mt-3"><CapacityBar pct={cap.pct} overSoft={cap.overSoft} overBuffer={cap.overBuffer} /></div>

      {skills.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {skills.slice(0, 3).map((s) => (
            <span
              key={s.id}
              className="text-[10px] px-2 py-0.5 rounded-full bg-white/75 border border-white/80 text-ink/70"
            >
              {s.skillName}{s.experienceLevel ? ` · L${s.experienceLevel}` : ""}
            </span>
          ))}
        </div>
      )}
      <div
        aria-hidden
        className="absolute -bottom-8 -right-8 w-24 h-24 rounded-full pointer-events-none opacity-0 group-hover:opacity-60 transition-opacity"
        style={{
          background: accent
            ? "radial-gradient(circle, rgba(245,158,11,0.22), transparent 70%)"
            : "radial-gradient(circle, rgba(6,50,112,0.18), transparent 70%)"
        }}
      />
        </button>
      }
    />
  );
}
