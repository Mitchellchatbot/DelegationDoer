import Link from "next/link";
import { users, departments, tasks, skillProfiles, headsOf, workersOf } from "@/lib/mock-data";
import { Avatar } from "@/components/Avatar";
import { CapacityBar } from "@/components/CapacityBar";
import { userCapacity } from "@/lib/capacity";
import { ROLE_LABELS } from "@/lib/auth";
import { Crown, Users as UsersIcon } from "lucide-react";
import type { User } from "@/lib/types";

export default function TeamPage() {
  const ceo = users.find((u) => u.role === "ceo");

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <header
        className="relative overflow-hidden rounded-2xl border border-white/60 shadow-soft p-5"
        style={{ background: "linear-gradient(120deg, #DBEAFE 0%, #C7D2FE 50%, #DDD6FE 100%)" }}
      >
        <div className="relative flex items-center gap-3">
          <span className="text-3xl">👥</span>
          <div>
            <h1 className="text-xl font-semibold">Team</h1>
            <p className="text-sm text-ink/60 mt-0.5">Org reports up to the CEO. Click anyone to see their profile.</p>
          </div>
        </div>
        <div
          aria-hidden
          className="absolute -top-10 right-12 w-32 h-32 rounded-full"
          style={{ background: "radial-gradient(circle, rgba(99,102,241,0.18), transparent 70%)" }}
        />
      </header>

      {ceo && (
        <Link
          href={`/team/${ceo.id}`}
          className="group relative overflow-hidden rounded-2xl border border-purple-200/60 shadow-soft hover:shadow-lift transition-all hover:-translate-y-0.5 p-4 flex items-center gap-3"
          style={{ background: "linear-gradient(120deg, #FAE8FF 0%, #E9D5FF 100%)" }}
        >
          <div className="w-11 h-11 rounded-xl bg-white/70 border border-white/80 grid place-items-center text-purple-600 shadow-sm">
            <Crown className="w-5 h-5" />
          </div>
          <Avatar name={ceo.name} imageUrl={ceo.avatarUrl} size={36} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold truncate">{ceo.name}</div>
            <div className="text-xs text-ink/60">CEO · everyone reports up here</div>
          </div>
          <span className="text-[10px] uppercase tracking-wide text-purple-700 bg-white/70 px-2 py-0.5 rounded-full border border-purple-200/60">
            Org leader
          </span>
        </Link>
      )}

      {departments.map((d) => {
        const heads = headsOf(d.id);
        const workers = workersOf(d.id);
        return (
          <section key={d.id} className="space-y-3">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-medium">{d.name}</h2>
              <div className="text-xs text-muted">{d.description}</div>
              <div className="ml-auto text-xs text-muted">{heads.length + workers.length} member{heads.length + workers.length === 1 ? "" : "s"}</div>
            </div>

            {heads.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted mb-1.5 inline-flex items-center gap-1">
                  <Crown className="w-3 h-3" /> Department head{heads.length > 1 ? "s" : ""}
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {heads.map((u) => <PersonCard key={u.id} user={u} accent />)}
                </div>
              </div>
            )}

            {workers.length > 0 ? (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted mb-1.5 inline-flex items-center gap-1">
                  <UsersIcon className="w-3 h-3" /> Workers
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {workers.map((u) => <PersonCard key={u.id} user={u} />)}
                </div>
              </div>
            ) : heads.length === 0 ? (
              <div className="card p-4 text-sm text-muted">No members yet.</div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function PersonCard({ user, accent }: { user: User; accent?: boolean }) {
  const cap = userCapacity(user, tasks);
  const skills = skillProfiles.filter((s) => s.userId === user.id);
  const headBg = "bg-gradient-to-br from-violet-50 to-white border-violet-200/60";
  const workerBg = "bg-gradient-to-br from-blue-50 to-white border-blue-200/40";
  return (
    <Link
      href={`/team/${user.id}`}
      className={
        "group relative overflow-hidden rounded-2xl border shadow-soft hover:shadow-lift transition-all hover:-translate-y-0.5 p-4 block " +
        (accent ? headBg : workerBg)
      }
    >
      <div className="flex items-center gap-3">
        <Avatar name={user.name} imageUrl={user.avatarUrl} size={40} className="ring-2 ring-white shadow-sm" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate flex items-center gap-1.5">
            {user.name}
            {user.role === "department_head" && <Crown className="w-3.5 h-3.5 text-violet-600 shrink-0" />}
          </div>
          <div className="text-xs text-ink/60">{ROLE_LABELS[user.role]} · {user.dailyCapacity}h/day</div>
        </div>
      </div>
      <div className="mt-3"><CapacityBar pct={cap.pct} overSoft={cap.overSoft} overBuffer={cap.overBuffer} /></div>
      {skills.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {skills.slice(0, 4).map((s) => (
            <span
              key={s.id}
              className="text-[10px] px-2 py-0.5 rounded-full bg-white/70 border border-border/60 text-ink/70"
            >
              {s.skillName} · L{s.experienceLevel}
            </span>
          ))}
        </div>
      )}
      <div
        aria-hidden
        className="absolute -bottom-8 -right-8 w-24 h-24 rounded-full pointer-events-none opacity-0 group-hover:opacity-60 transition-opacity"
        style={{
          background: accent
            ? "radial-gradient(circle, rgba(139,92,246,0.18), transparent 70%)"
            : "radial-gradient(circle, rgba(99,102,241,0.18), transparent 70%)"
        }}
      />
    </Link>
  );
}
