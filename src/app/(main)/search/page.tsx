import Link from "next/link";
import { redirect } from "next/navigation";
import { Search as SearchIcon, ListTodo, Users, FolderKanban } from "lucide-react";
import { requireCurrentUserId } from "@/lib/session";
import {
  getUserById, getAllTasks, getAllUsersLight, getDepartments
} from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isLeader } from "@/lib/auth";
import { PersonAvatar } from "@/components/PersonAvatar";

export const dynamic = "force-dynamic";

interface SearchParams { q?: string }

// Global search results. Topbar's search bar navigates here on Enter.
// Plain substring match across tasks (title + description), people
// (name + email), and projects (name + description). Server-rendered
// so it works without an extra API round-trip. Workers see only what
// they can see elsewhere — leader/head visibility scoping is
// inherited from the existing data fetchers.
export default async function SearchPage({
  searchParams
}: {
  searchParams: SearchParams;
}) {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  const q = (searchParams?.q ?? "").trim();
  if (!q) {
    return (
      <div className="card p-8 text-center max-w-md mx-auto mt-12">
        <SearchIcon className="w-6 h-6 mx-auto text-muted" />
        <div className="text-sm text-ink mt-2">Type something in the search bar above.</div>
      </div>
    );
  }

  const lower = q.toLowerCase();
  const supabase = getSupabaseAdmin();

  const [tasks, users, depts, projectsRes] = await Promise.all([
    getAllTasks(),
    getAllUsersLight(),
    getDepartments(),
    supabase
      .from("projects")
      .select("id,name,description,department_id")
  ]);

  const taskMatches = tasks
    .filter((t) => {
      const hay = `${t.title} ${t.description ?? ""}`.toLowerCase();
      return hay.includes(lower);
    })
    .slice(0, 25);

  const userMatches = users
    .filter((u) =>
      u.name.toLowerCase().includes(lower) ||
      (u.email ?? "").toLowerCase().includes(lower)
    )
    .slice(0, 25);

  const projectMatches = (projectsRes.data ?? [])
    .filter((p) => {
      const hay = `${p.name} ${p.description ?? ""}`.toLowerCase();
      return hay.includes(lower);
    })
    .slice(0, 25);

  const userById = new Map(users.map((u) => [u.id, u]));
  const deptById = new Map(depts.map((d) => [d.id, d]));
  const totalMatches = taskMatches.length + userMatches.length + projectMatches.length;
  const canSeeLeaderRoutes = isLeader(me);

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      <header className="rounded-2xl border border-slate-200 bg-white shadow-soft p-5">
        <div className="flex items-center gap-2 text-xs text-ink/55">
          <SearchIcon className="w-3.5 h-3.5" />
          Results for
        </div>
        <div className="text-xl font-semibold text-ink mt-1">&ldquo;{q}&rdquo;</div>
        <div className="text-xs text-ink/55 mt-1">
          {totalMatches === 0
            ? "No matches across tasks, people, or projects."
            : `${totalMatches} match${totalMatches === 1 ? "" : "es"} across tasks, people, and projects.`}
        </div>
      </header>

      {taskMatches.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
            <ListTodo className="w-4 h-4 text-indigo-500" />
            <div className="text-sm font-semibold">Tasks</div>
            <div className="text-xs text-ink/55">{taskMatches.length}</div>
          </div>
          <ul className="divide-y divide-slate-100">
            {taskMatches.map((t) => {
              const assignee = t.assigneeId ? userById.get(t.assigneeId) : null;
              return (
                <li key={t.id}>
                  <Link
                    href={`/tasks/${t.id}`}
                    className="block px-4 py-3 hover:bg-slate-50 transition-colors"
                  >
                    <div className="text-sm font-medium text-ink truncate">{t.title}</div>
                    <div className="text-[11px] text-ink/55 mt-0.5 flex items-center gap-2">
                      <span className="px-1.5 py-0.5 rounded bg-slate-100">{t.status}</span>
                      <span className="px-1.5 py-0.5 rounded bg-slate-100">{t.priority}</span>
                      {assignee && <span>· {assignee.name}</span>}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {userMatches.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
            <Users className="w-4 h-4 text-emerald-500" />
            <div className="text-sm font-semibold">People</div>
            <div className="text-xs text-ink/55">{userMatches.length}</div>
          </div>
          <ul className="divide-y divide-slate-100">
            {userMatches.map((u) => (
              <li key={u.id}>
                <Link
                  href={canSeeLeaderRoutes ? `/leader?focus=${u.id}` : `/team/${u.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors"
                >
                  <PersonAvatar
                    userId={u.id}
                    name={u.name}
                    imageUrl={u.avatarUrl}
                    size={32}
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink truncate">{u.name}</div>
                    <div className="text-[11px] text-ink/55 truncate">{u.email}</div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {projectMatches.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white shadow-soft overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
            <FolderKanban className="w-4 h-4 text-indigo-500" />
            <div className="text-sm font-semibold">Projects</div>
            <div className="text-xs text-ink/55">{projectMatches.length}</div>
          </div>
          <ul className="divide-y divide-slate-100">
            {projectMatches.map((p) => {
              const dept = p.department_id ? deptById.get(p.department_id) : null;
              return (
                <li key={p.id}>
                  <Link
                    href={`/projects/${p.id}`}
                    className="block px-4 py-3 hover:bg-slate-50 transition-colors"
                  >
                    <div className="text-sm font-medium text-ink truncate">{p.name}</div>
                    <div className="text-[11px] text-ink/55 mt-0.5 truncate">
                      {dept ? dept.name : "—"}
                      {p.description ? ` · ${p.description}` : ""}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
