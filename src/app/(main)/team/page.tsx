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
      <div>
        <h1 className="text-lg font-medium">Team</h1>
        <p className="text-sm text-muted mt-1">Org reports up to the CEO. Click anyone to see their profile.</p>
      </div>

      {ceo && (
        <section className="card p-4 flex items-center gap-3 border-warn/30 bg-warn/5">
          <div className="w-9 h-9 rounded-lg bg-warn/15 border border-warn/30 grid place-items-center text-warn">
            <Crown className="w-4 h-4" />
          </div>
          <Link href={`/team/${ceo.id}`} className="flex items-center gap-2 hover:underline">
            <Avatar name={ceo.name} size={28} />
            <div>
              <div className="text-sm font-medium">{ceo.name}</div>
              <div className="text-xs text-muted">CEO · everyone reports up here</div>
            </div>
          </Link>
        </section>
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
  return (
    <Link
      href={`/team/${user.id}`}
      className={"card card-hover p-4 block " + (accent ? "border-accent/30" : "")}
    >
      <div className="flex items-center gap-3">
        <Avatar name={user.name} imageUrl={user.avatarUrl} size={36} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate flex items-center gap-1.5">
            {user.name}
            {user.role === "department_head" && <Crown className="w-3 h-3 text-warn shrink-0" />}
          </div>
          <div className="text-xs text-muted">{ROLE_LABELS[user.role]} · {user.dailyCapacity}h/day</div>
        </div>
      </div>
      <div className="mt-3"><CapacityBar pct={cap.pct} overSoft={cap.overSoft} overBuffer={cap.overBuffer} /></div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {skills.slice(0, 4).map((s) => (
          <span key={s.id} className="badge badge-tag">{s.skillName} · L{s.experienceLevel}</span>
        ))}
      </div>
    </Link>
  );
}
