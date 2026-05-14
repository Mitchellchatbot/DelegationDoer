import { redirect } from "next/navigation";
import { Network, Users as UsersIcon, Building2, ListChecks } from "lucide-react";
import { OrgChart } from "@/components/OrgChart";
import { PersonAvatar } from "@/components/PersonAvatar";
import { requireCurrentUserId } from "@/lib/session";
import {
  getUserById, getAllUsers, getAllTasks, getDepartments
} from "@/lib/server-data";
import type { Role } from "@/lib/types";

export const dynamic = "force-dynamic";

// Default landing page for everyone — top-to-bottom view of who does
// what + what's on each plate. The chart is the same `<OrgChart>` used
// inside Leader Console / Team Overview; this route adds a marketing-style
// hero with live stats and a peek of the team's faces.
export default async function OrgChartPage() {
  const userId = await requireCurrentUserId();
  const me = await getUserById(userId);
  if (!me) redirect("/login");

  // Read live data from the DB. The mock-data import this page used to
  // pull from didn't carry tasks created via email-intake / the manual
  // run-once button, so the chart was reporting "no open tasks" for
  // people who actually had a stack of them.
  const [users, tasks, departments] = await Promise.all([
    getAllUsers(),
    getAllTasks(),
    getDepartments()
  ]);

  // Every leader sits at the top of the chart — co-leads / right-hand
  // setups render side-by-side rather than picking one as "the" leader.
  const leaders = users.filter((u) => u.role === "leader");
  const openTasks = tasks.filter((t) => t.status !== "done").length;

  // Avatar peek — show up to 6, ordered: Leader first, then heads, then
  // workers — same order they appear in the chart so the hero "previews"
  // the diagram below.
  const ROLE_RANK: Record<Role, number> = {
    leader: 0, department_head: 1, worker: 2
  };
  const peekAvatars = [...users]
    .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.name.localeCompare(b.name))
    .slice(0, 6);
  const overflow = Math.max(0, users.length - peekAvatars.length);

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <header className="relative overflow-hidden rounded-3xl border border-slate-200/70 bg-white p-8 shadow-soft">
        {/* Soft accent blob — same family as the rest of the app's heroes
            but tuned a touch larger so the page feels like a "lobby". */}
        <div
          aria-hidden
          className="absolute -top-20 -right-10 w-80 h-80 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(30,99,255,0.18), transparent 70%)" }}
        />
        <div
          aria-hidden
          className="absolute -bottom-24 left-10 w-72 h-72 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(99,102,241,0.14), transparent 70%)" }}
        />

        <div className="relative flex items-start justify-between gap-6 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-10 h-10 rounded-2xl bg-accent/10 text-accent grid place-items-center ring-1 ring-accent/20 shrink-0">
                <Network className="w-5 h-5" />
              </div>
              <div className="text-[12px] uppercase tracking-[0.2em] font-semibold text-accent">
                Organization
              </div>
            </div>

            <h1 className="text-[44px] leading-[1.05] font-bold tracking-tight text-ink">
              Who&rsquo;s <span className="text-accent">where</span>,
              {" "}doing <span className="text-accent">what</span>.
            </h1>
            <p className="mt-3 text-[16px] text-ink/65 max-w-xl leading-relaxed">
              The whole team — top to bottom — and what&rsquo;s on each plate
              right now. Click any face to dive into a profile.
            </p>

            <div className="mt-5 flex items-center gap-4 flex-wrap text-sm">
              <HeroStat icon={<UsersIcon className="w-4 h-4" />} value={users.length} label="people" />
              <Dot />
              <HeroStat icon={<Building2 className="w-4 h-4" />} value={departments.length} label="departments" />
              <Dot />
              <HeroStat icon={<ListChecks className="w-4 h-4" />} value={openTasks} label="open tasks" />
            </div>
          </div>

          {/* Overlapping avatar stack — peeks at the team. White rings
              between avatars give the classic "stack" feel. Hidden on
              narrow viewports so the headline doesn't crowd. */}
          <div className="hidden md:flex items-center -space-x-3 shrink-0">
            {peekAvatars.map((u) => (
              <div
                key={u.id}
                className="rounded-full ring-4 ring-white shadow-sm transition-transform hover:-translate-y-0.5 hover:z-10"
              >
                <PersonAvatar
                  userId={u.id}
                  name={u.name}
                  imageUrl={u.avatarUrl}
                  size={48}
                />
              </div>
            ))}
            {overflow > 0 && (
              <div className="w-12 h-12 rounded-full ring-4 ring-white bg-slate-100 text-ink/70 grid place-items-center text-[12px] font-semibold tabular-nums">
                +{overflow}
              </div>
            )}
          </div>
        </div>
      </header>

      <OrgChart
        ceo={leaders}
        users={users}
        departments={departments}
        tasks={tasks}
      />
    </div>
  );
}

function HeroStat({
  icon, value, label
}: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-ink/75">
      <span className="text-accent">{icon}</span>
      <span className="font-semibold text-ink tabular-nums">{value}</span>
      <span className="text-ink/55">{label}</span>
    </span>
  );
}

function Dot() {
  return <span aria-hidden className="w-1 h-1 rounded-full bg-ink/25" />;
}
