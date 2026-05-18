import Link from "next/link";
import { notFound } from "next/navigation";
import { PersonAvatar } from "@/components/PersonAvatar";
import { CapacityBar } from "@/components/CapacityBar";
import { ProfileDialog } from "@/components/ProfileDialog";
import { TaskCard } from "@/components/TaskCard";
import { userCapacity } from "@/lib/capacity";
import { ROLE_LABELS } from "@/lib/auth";
import { Crown } from "lucide-react";
import { BackPill } from "@/components/BackPill";
import { getAllUsers, getAllTasks, getDepartments } from "@/lib/server-data";
import { managerOf } from "@/lib/mock-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export default async function ProfilePage({ params }: { params: { id: string } }) {
  const supabase = getSupabaseAdmin();
  const [users, tasks, departments, skillsRes] = await Promise.all([
    getAllUsers(),
    getAllTasks(),
    getDepartments(),
    // Skills + task types come from the same skill_profiles table that
    // ProfileDialog edits — the page was previously reading the legacy
    // user.skills text array, which is almost always empty in prod, so
    // the cards looked broken even when the user had skills configured.
    supabase
      .from("skill_profiles")
      .select("id, skill_name, experience_level, task_types")
      .eq("user_id", params.id)
  ]);
  const user = users.find((u) => u.id === params.id);
  if (!user) return notFound();
  const userDepts = user.departmentIds
    .map((id) => departments.find((d) => d.id === id))
    .filter(Boolean) as { id: string; name: string }[];
  const cap = userCapacity(user, tasks);
  const myTasks = tasks.filter((t) => t.assigneeId === user.id);

  const skillRows = (skillsRes.data ?? []) as Array<{
    id: string; skill_name: string; experience_level: number; task_types: string[] | null;
  }>;
  const skills = skillRows.map((s) => ({
    id: s.id,
    skillName: s.skill_name,
    experienceLevel: s.experience_level
  }));
  // Task types handled = union of the task_types arrays declared on
  // every skill_profile row, fallback to tags on the user's actual
  // assigned tasks if nothing's declared on the skill side. Declared
  // wins because it's an intentional statement of "I do this kind of
  // work" — assigned tags are sometimes just inherited from the project.
  const declaredTypes = Array.from(new Set(skillRows.flatMap((s) => s.task_types ?? [])));
  const inferredTypes = Array.from(
    new Set(myTasks.flatMap((t) => t.tags))
  );
  const taskTypeHistory = declaredTypes.length > 0 ? declaredTypes : inferredTypes;

  // Throughput = a few simple metrics computed from the user's tasks.
  // No reliance on the (often unwritten) users.throughput JSON column.
  // "This month" uses lastActivityAt as a "completed at" proxy — when
  // a task moves to done its last_activity_at updates, so it's a good
  // signal for completion timing without a dedicated completed_at col.
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const doneTasks = myTasks.filter((t) => t.status === "done");
  const doneThisMonth = doneTasks.filter((t) => t.lastActivityAt >= monthStart);
  const totalEstimated = doneTasks.reduce((sum, t) => sum + (t.estimatedHours ?? 0), 0);
  const totalActual = doneTasks.reduce((sum, t) => sum + (t.actualHours ?? 0), 0);
  const accuracy = totalEstimated > 0 ? totalActual / totalEstimated : null;
  const openTasks = myTasks.length - doneTasks.length;
  const throughput: { label: string; value: string }[] = [
    { label: "Completed this month", value: String(doneThisMonth.length) },
    { label: "Completed all-time", value: String(doneTasks.length) },
    { label: "Currently open", value: String(openTasks) },
    {
      label: "Estimate accuracy",
      value: accuracy != null ? `${accuracy.toFixed(2)}×` : "—"
    }
  ];
  const manager = managerOf(user, users);
  const directReports = user.role === "leader"
    ? users.filter((u) => u.role === "department_head")
    : user.role === "department_head"
      ? users.filter((u) => u.role === "worker" && u.departmentIds.some((d) => user.departmentIds.includes(d)))
      : [];

  return (
    <div className="space-y-5 max-w-5xl">
      <BackPill href="/people/list" label="People" />

      <div className="card p-5 flex items-start gap-4">
        <PersonAvatar userId={user.id} name={user.name} imageUrl={user.avatarUrl} size={56} />
        <div className="flex-1">
          <div className="text-lg font-medium flex items-center gap-2">
            {user.name}
            {user.role === "leader" && <Crown className="w-4 h-4 text-warn" />}
            {user.role === "department_head" && <Crown className="w-4 h-4 text-accent" />}
          </div>
          <div className="text-sm text-muted">
            {user.email} · {ROLE_LABELS[user.role]}
            {userDepts.length > 0 && <> · {userDepts.map((d) => d.name).join(" · ")}</>}
          </div>
          <div className="mt-2 text-xs text-muted">
            {manager ? <>Reports to <Link href={`/team/${manager.id}`} className="text-accent hover:underline">{manager.name}</Link></> : "Top of the org"}
            {directReports.length > 0 && <> · {directReports.length} direct report{directReports.length === 1 ? "" : "s"}</>}
          </div>
          <div className="mt-3 max-w-sm"><CapacityBar pct={cap.pct} overSoft={cap.overSoft} overBuffer={cap.overBuffer} /></div>
        </div>
        <ProfileDialog
          userId={user.id}
          trigger={<button className="btn">Edit profile</button>}
        />
      </div>

      {directReports.length > 0 && (
        <section className="card p-4">
          <div className="text-sm font-medium mb-3">Direct reports</div>
          <div className="flex flex-wrap gap-2">
            {directReports.map((r) => (
              <Link key={r.id} href={`/team/${r.id}`} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-surface2 border border-border hover:border-accent/40 text-xs">
                <PersonAvatar userId={r.id} name={r.name} imageUrl={r.avatarUrl} size={18} /> {r.name}
                <span className="text-muted">· {ROLE_LABELS[r.role]}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="grid grid-cols-3 gap-4">
        <section className="card p-4">
          <div className="text-sm font-medium mb-3">Skills</div>
          <ul className="space-y-2">
            {skills.map((s) => (
              <li key={s.id} className="flex items-center justify-between text-sm">
                <span>{s.skillName}</span>
                {s.experienceLevel > 0 && (
                  <span className="text-muted text-xs">Level {s.experienceLevel}/5</span>
                )}
              </li>
            ))}
            {skills.length === 0 && (
              <li className="text-xs text-muted">No skills listed. Use Edit profile to add some.</li>
            )}
          </ul>
        </section>
        <section className="card p-4">
          <div className="text-sm font-medium mb-3">Throughput</div>
          <ul className="space-y-1.5 text-sm">
            {throughput.map((row) => (
              <li key={row.label} className="flex items-center justify-between">
                <span className="text-muted">{row.label}</span>
                <span className="tabular-nums">{row.value}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="card p-4">
          <div className="text-sm font-medium mb-3">Task types handled</div>
          <div className="flex flex-wrap gap-1.5">
            {taskTypeHistory.map((t) => <span key={t} className="badge badge-tag">{t}</span>)}
            {taskTypeHistory.length === 0 && (
              <div className="text-xs text-muted">Nothing tracked yet.</div>
            )}
          </div>
        </section>
      </div>

      <section>
        <div className="text-sm font-medium mb-3">Assigned tasks</div>
        <div className="grid grid-cols-3 gap-3">
          {myTasks.map((t) => <TaskCard key={t.id} task={t} />)}
        </div>
      </section>
    </div>
  );
}
