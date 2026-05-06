"use client";

import Link from "next/link";
import { Avatar } from "./Avatar";
import { Countdown } from "./Countdown";
import type { Department, Task, User } from "@/lib/types";

// Reusable org-chart visualization: CEO (if shown) → dept heads → workers.
// Under each person, their open tasks with deadlines (top N by due date,
// rest collapsed into a "+N more" link to that person's profile).
//
// All filtering is up to the caller — pass in the slice of users/depts/
// tasks you want visualized. The CEO console passes everything; the
// dept-head Team Overview passes only their dept members + tasks.

interface Props {
  users: User[];
  departments: Department[];
  tasks: Task[];
  ceo?: User | null;            // optional root node (omit for dept head view)
  tasksPerPerson?: number;      // top-N tasks shown under each person; default 4
  emptyLabel?: string;          // shown when a person has no open tasks
}

const PRIORITY_RANK: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3
};

function openTasksFor(userId: string, all: Task[]): Task[] {
  return all
    .filter((t) => t.assigneeId === userId && t.status !== "done")
    .sort((a, b) => {
      // Soonest deadline first; tasks without a deadline drop to the bottom.
      const aDue = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const bDue = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      if (aDue !== bDue) return aDue - bDue;
      // Tie-break by priority.
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    });
}

export function OrgChart({
  users, departments, tasks, ceo, tasksPerPerson = 4, emptyLabel = "No open tasks"
}: Props) {
  return (
    <div className="card p-6 overflow-x-auto">
      <div className="flex flex-col items-center min-w-fit">
        {ceo && (
          <>
            <PersonNode
              user={ceo}
              subtitle="CEO"
              tone="warn"
              tasks={openTasksFor(ceo.id, tasks)}
              tasksPerPerson={tasksPerPerson}
              emptyLabel={emptyLabel}
            />
            <Connector />
          </>
        )}

        <div
          className="grid gap-8 items-start"
          style={{ gridTemplateColumns: `repeat(${Math.max(departments.length, 1)}, minmax(220px, 1fr))` }}
        >
          {departments.map((d) => {
            const heads = users.filter((u) => u.role === "department_head" && u.departmentIds.includes(d.id));
            const workers = users.filter((u) => u.role === "worker" && u.departmentIds.includes(d.id));
            return (
              <div key={d.id} className="flex flex-col items-center">
                <div className="text-xs uppercase tracking-wide text-muted mb-2">{d.name}</div>
                <div className="flex flex-col items-stretch gap-2 w-full">
                  {heads.length === 0
                    ? <div className="badge badge-tag self-center">No head</div>
                    : heads.map((h) => (
                        <PersonNode
                          key={h.id}
                          user={h}
                          subtitle="Head"
                          tone="accent"
                          tasks={openTasksFor(h.id, tasks)}
                          tasksPerPerson={tasksPerPerson}
                          emptyLabel={emptyLabel}
                        />
                      ))
                  }
                </div>
                {workers.length > 0 && <Connector />}
                <div className="space-y-2 w-full">
                  {workers.map((w) => (
                    <PersonNode
                      key={w.id}
                      user={w}
                      subtitle="Worker"
                      tone="muted"
                      tasks={openTasksFor(w.id, tasks)}
                      tasksPerPerson={tasksPerPerson}
                      emptyLabel={emptyLabel}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PersonNode({
  user, subtitle, tone, tasks, tasksPerPerson, emptyLabel
}: {
  user: User;
  subtitle: string;
  tone: "warn" | "accent" | "muted";
  tasks: Task[];
  tasksPerPerson: number;
  emptyLabel: string;
}) {
  // Person tile: subtle tinted header so the CEO/Head/Worker hierarchy is
  // legible at a glance, but kept light so the white task cards inside pop.
  const headerToneClass = {
    warn: "border-warn/30 bg-warn/5",
    accent: "border-accent/25 bg-accent/5",
    muted: "border-border bg-surface2/60"
  }[tone];
  const dotToneClass = {
    warn: "bg-warn",
    accent: "bg-accent",
    muted: "bg-muted/50"
  }[tone];

  const visible = tasks.slice(0, tasksPerPerson);
  const overflow = tasks.length - visible.length;

  return (
    <div className={"rounded-2xl border p-3 w-full max-w-[280px] mx-auto " + headerToneClass}>
      <Link href={`/team/${user.id}`} className="flex items-center gap-2 group">
        <Avatar name={user.name} imageUrl={user.avatarUrl} size={28} />
        <div className="leading-tight min-w-0 flex-1">
          <div className="text-sm font-medium truncate group-hover:text-accent transition-colors">{user.name}</div>
          <div className="text-[10px] text-muted flex items-center gap-1">
            <span className={"w-1.5 h-1.5 rounded-full " + dotToneClass} />
            {subtitle}
          </div>
        </div>
        <span className="text-[10px] text-muted shrink-0 tabular-nums">
          {tasks.length} open
        </span>
      </Link>

      {visible.length === 0 ? (
        <div className="mt-3 text-[11px] text-muted italic px-1">{emptyLabel}</div>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {visible.map((t) => (
            <li key={t.id}>
              <Link
                href={`/tasks/${t.id}`}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-surface border border-border shadow-soft transition-all duration-150 hover:-translate-y-0.5 hover:shadow-lift hover:border-accent/40"
                title={t.title}
              >
                <span className="text-[11px] flex-1 truncate text-ink">
                  {t.title}
                </span>
                <span className="text-[10px] shrink-0">
                  <Countdown iso={t.dueDate} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {overflow > 0 && (
        <Link
          href={`/team/${user.id}`}
          className="mt-2 block text-center text-[10px] text-muted hover:text-accent transition-colors"
        >
          +{overflow} more
        </Link>
      )}
    </div>
  );
}

function Connector() {
  return <div className="w-px h-6 bg-border my-2" />;
}
