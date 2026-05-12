"use client";

import * as Popover from "@radix-ui/react-popover";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Crown } from "lucide-react";
import { Countdown } from "./Countdown";
import { usePresence } from "@/lib/presence-context";
import { cn, initials } from "@/lib/utils";
import { ROLE_LABELS } from "@/lib/auth";
import { userCapacity } from "@/lib/capacity";
import type { Department, Task, User } from "@/lib/types";

// Org chart visualization. Each person is a small circular avatar with
// their name underneath; full details (capacity, stats, open tasks)
// live in a popover that opens on hover or click. Curved SVG strokes
// connect Leader → dept header → head → workers, anchored to the
// avatar centers.
//
// Filtering is the caller's job — pass in the slice of users/depts/tasks
// you want visualized. Leader console passes everything; dept-head Team
// Overview passes only their dept's members + tasks.

interface Props {
  users: User[];
  departments: Department[];
  tasks: Task[];
  ceo?: User | null;       // optional root node (omit for dept-head view)
}

const PRIORITY_RANK: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3
};

const ROLE_RING: Record<User["role"], string> = {
  leader: "ring-amber-300",
  department_head: "ring-indigo-300",
  worker: "ring-blue-200"
};

const PRESENCE_DOT: Record<string, string> = {
  available: "bg-emerald-500",
  focus: "bg-violet-500",
  eating: "bg-amber-500",
  away: "bg-slate-400"
};

function openTasksFor(userId: string, all: Task[]): Task[] {
  return all
    .filter((t) => t.assigneeId === userId && t.status !== "done")
    .sort((a, b) => {
      const aDue = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const bDue = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      if (aDue !== bDue) return aDue - bDue;
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    });
}

export function OrgChart({ users, departments, tasks, ceo }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const ceoRef = useRef<HTMLDivElement | null>(null);
  const deptHeaderRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const headRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const workerRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  const [edges, setEdges] = useState<{ d: string; key: string }[]>([]);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useEffect(() => {
    function measure() {
      const root = containerRef.current;
      if (!root) return;
      const rootRect = root.getBoundingClientRect();
      setSize({ w: rootRect.width, h: rootRect.height });

      const next: { d: string; key: string }[] = [];

      const ceoEl = ceoRef.current;
      if (ceoEl) {
        const c = ceoEl.getBoundingClientRect();
        const fromX = c.left + c.width / 2 - rootRect.left;
        const fromY = c.bottom - rootRect.top;
        for (const [deptId, el] of deptHeaderRefs.current) {
          if (!el) continue;
          const d = el.getBoundingClientRect();
          const toX = d.left + d.width / 2 - rootRect.left;
          const toY = d.top - rootRect.top;
          next.push({
            key: `ceo-${deptId}`,
            d: cubicPath(fromX, fromY, toX, toY)
          });
        }
      }

      for (const [headId, headEl] of headRefs.current) {
        if (!headEl) continue;
        const h = headEl.getBoundingClientRect();
        const fromX = h.left + h.width / 2 - rootRect.left;
        const fromY = h.bottom - rootRect.top;
        const deptIdAttr = headEl.getAttribute("data-dept") ?? "";
        for (const [key, wEl] of workerRefs.current) {
          if (!wEl || !key.startsWith(`${deptIdAttr}:`)) continue;
          const w = wEl.getBoundingClientRect();
          const toX = w.left + w.width / 2 - rootRect.left;
          const toY = w.top - rootRect.top;
          next.push({
            key: `${headId}-${key}`,
            d: cubicPath(fromX, fromY, toX, toY)
          });
        }
      }

      setEdges(next);
    }

    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [users, departments, tasks, ceo]);

  return (
    <section
      className="relative overflow-hidden rounded-3xl border border-slate-200/70 bg-white pt-7 pb-10 px-6 shadow-soft"
      aria-label="Organization chart"
    >
      <div ref={containerRef} className="relative z-10 overflow-x-auto">
        <svg
          aria-hidden
          width={size.w}
          height={size.h}
          className="absolute inset-0 pointer-events-none"
          style={{ zIndex: 0 }}
        >
          <defs>
            <linearGradient id="org-edge" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#1e63ff" stopOpacity="0.55" />
              <stop offset="100%" stopColor="#1e63ff" stopOpacity="0.18" />
            </linearGradient>
          </defs>
          {edges.map((e) => (
            <path
              key={e.key}
              d={e.d}
              fill="none"
              stroke="url(#org-edge)"
              strokeWidth={2}
              strokeLinecap="round"
            />
          ))}
        </svg>

        <div className="relative z-10 flex flex-col items-center min-w-fit gap-8">
          {ceo && (
            <div ref={ceoRef}>
              <PersonNode
                user={ceo}
                tone="leader"
                tasks={openTasksFor(ceo.id, tasks)}
                allUserTasks={tasks.filter((t) => t.assigneeId === ceo.id)}
                departments={departments}
              />
            </div>
          )}

          <div
            className="grid gap-6 items-start"
            style={{
              gridTemplateColumns: `repeat(${Math.max(departments.length, 1)}, minmax(160px, 1fr))`
            }}
          >
            {departments.map((d) => {
              const heads = users.filter(
                (u) => u.role === "department_head" && u.departmentIds.includes(d.id)
              );
              const workers = users.filter(
                (u) => u.role === "worker" && u.departmentIds.includes(d.id)
              );
              const memberIds = new Set([...heads, ...workers].map((u) => u.id));
              const completedThisWeek = tasks.filter((t) =>
                t.assigneeId &&
                memberIds.has(t.assigneeId) &&
                t.status === "done" &&
                new Date(t.lastActivityAt).getTime() > Date.now() - 7 * 86_400_000
              ).length;
              const openCount = tasks.filter((t) =>
                t.assigneeId && memberIds.has(t.assigneeId) && t.status !== "done"
              ).length;

              return (
                <div key={d.id} className="flex flex-col items-center gap-5">
                  <div
                    ref={(el) => { deptHeaderRefs.current.set(d.id, el); }}
                    className="inline-flex flex-col items-center gap-1 px-4 py-2 rounded-2xl border border-white/70 bg-white/60 backdrop-blur-xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.7),0_8px_24px_-12px_rgba(15,23,42,0.18)]"
                  >
                    <div className="text-xs uppercase tracking-wide text-ink/70 font-semibold">
                      {d.name}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200/70 text-[10px] font-medium"
                        title={`${completedThisWeek} done in the last 7 days`}
                      >
                        ✓ {completedThisWeek}
                      </span>
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 border border-blue-200/70 text-[10px] font-medium"
                        title={`${openCount} open across the dept`}
                      >
                        {openCount} open
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-col items-center gap-4 w-full">
                    {heads.length === 0 ? (
                      <div className="badge badge-tag self-center text-[10px] opacity-70">
                        No head
                      </div>
                    ) : (
                      heads.map((h) => (
                        <div
                          key={h.id}
                          ref={(el) => { headRefs.current.set(h.id, el); }}
                          data-dept={d.id}
                        >
                          <PersonNode
                            user={h}
                            tone="head"
                            tasks={openTasksFor(h.id, tasks)}
                            allUserTasks={tasks.filter((t) => t.assigneeId === h.id)}
                            departments={departments}
                          />
                        </div>
                      ))
                    )}
                  </div>

                  {workers.length > 0 && (
                    <div className="grid grid-cols-2 gap-x-3 gap-y-4 w-full place-items-center">
                      {workers.map((w) => (
                        <div
                          key={w.id}
                          ref={(el) => { workerRefs.current.set(`${d.id}:${w.id}`, el); }}
                        >
                          <PersonNode
                            user={w}
                            tone="worker"
                            tasks={openTasksFor(w.id, tasks)}
                            allUserTasks={tasks.filter((t) => t.assigneeId === w.id)}
                            departments={departments}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function cubicPath(fromX: number, fromY: number, toX: number, toY: number): string {
  const dy = Math.max(40, Math.abs(toY - fromY) * 0.55);
  return `M ${fromX} ${fromY} C ${fromX} ${fromY + dy}, ${toX} ${toY - dy}, ${toX} ${toY}`;
}

function PersonNode({
  user, tone, tasks, allUserTasks, departments
}: {
  user: User;
  tone: "leader" | "head" | "worker";
  tasks: Task[];
  allUserTasks: Task[];
  departments: Department[];
}) {
  const live = usePresence(user.id);
  const avatarUrl = user.avatarUrl ?? live?.avatarUrl ?? null;
  const presence = live?.presence ?? null;
  const emoji = live?.statusEmoji ?? null;

  const size = tone === "leader" ? 96 : tone === "head" ? 84 : 72;
  const ringClass = ROLE_RING[user.role];

  const deptNames = user.departmentIds
    .map((id) => departments.find((d) => d.id === id)?.name)
    .filter(Boolean) as string[];

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="group flex flex-col items-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-2xl p-1 -m-1 transition-transform hover:-translate-y-0.5"
          title={`${user.name} · ${tasks.length} open`}
        >
          <div className="relative" style={{ width: size, height: size }}>
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt={user.name}
                draggable={false}
                className={cn(
                  "w-full h-full object-cover rounded-full ring-4 ring-offset-2 ring-offset-white shadow-[0_8px_18px_-8px_rgba(15,23,42,0.35)] transition-shadow group-hover:shadow-[0_12px_24px_-8px_rgba(30,99,255,0.40)]",
                  ringClass
                )}
              />
            ) : (
              <div
                className={cn(
                  "w-full h-full rounded-full grid place-items-center bg-gradient-to-br from-slate-100 to-slate-50 ring-4 ring-offset-2 ring-offset-white shadow-[0_8px_18px_-8px_rgba(15,23,42,0.35)]",
                  ringClass
                )}
              >
                <span
                  className="font-bold tracking-tight text-ink/85"
                  style={{ fontSize: Math.max(18, Math.round(size * 0.34)) }}
                >
                  {initials(user.name)}
                </span>
              </div>
            )}

            {tone === "leader" && (
              <div className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-amber-400 ring-2 ring-white grid place-items-center shadow-sm">
                <Crown className="w-3 h-3 text-white" />
              </div>
            )}
            {presence && (
              <span
                className={cn(
                  "absolute bottom-0.5 right-0.5 w-3.5 h-3.5 rounded-full ring-2 ring-white",
                  PRESENCE_DOT[presence]
                )}
                title={presence}
              />
            )}
            {emoji && (
              <span
                aria-hidden
                className="absolute -bottom-1 -left-1 w-7 h-7 rounded-full bg-white border border-slate-200 grid place-items-center text-base leading-none shadow-sm"
              >
                {emoji}
              </span>
            )}
            {tasks.length > 0 && (
              <span
                className={cn(
                  "absolute -top-1 -left-1 inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full text-[10px] font-bold ring-2 ring-white",
                  tasks.length > 4
                    ? "bg-rose-500 text-white"
                    : "bg-accent text-white"
                )}
                title={`${tasks.length} open tasks`}
              >
                {tasks.length}
              </span>
            )}
          </div>
          <div className="text-center max-w-[140px]">
            <div className="text-[12px] font-semibold text-ink leading-tight truncate">
              {user.name}
            </div>
            <div className="text-[9.5px] uppercase tracking-wide text-ink/55 truncate">
              {ROLE_LABELS[user.role]}
            </div>
          </div>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="center"
          sideOffset={10}
          className="z-50 w-[320px] rounded-2xl overflow-hidden border border-white/30 outline-none anim-fade-in-up shadow-[0_24px_50px_-15px_rgba(15,23,42,0.45)]"
        >
          <NodePopoverContent
            user={user}
            tone={tone}
            openTasks={tasks}
            allUserTasks={allUserTasks}
            avatarUrl={avatarUrl}
            departmentNames={deptNames}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function NodePopoverContent({
  user, tone, openTasks, allUserTasks, avatarUrl, departmentNames
}: {
  user: User;
  tone: "leader" | "head" | "worker";
  openTasks: Task[];
  allUserTasks: Task[];
  avatarUrl: string | null;
  departmentNames: string[];
}) {
  const cap = userCapacity(user, openTasks);
  const capPct = Math.min(100, Math.round(cap.pct * 100));

  const weekAgoMs = Date.now() - 7 * 86_400_000;
  const completedThisWeek = allUserTasks.filter(
    (t) => t.status === "done" && new Date(t.lastActivityAt).getTime() >= weekAgoMs
  ).length;

  const nowMs = Date.now();
  const overdueCount = openTasks.filter(
    (t) => t.dueDate && new Date(t.dueDate).getTime() < nowMs
  ).length;

  return (
    <div
      className="relative flex flex-col text-white max-h-[420px]"
      style={{
        background:
          "linear-gradient(135deg, #1e63ff 0%, #3a78ff 45%, #1d4ed8 100%)"
      }}
    >
      <div
        aria-hidden
        className="absolute -top-20 -left-12 w-56 h-56 rounded-full pointer-events-none"
        style={{ background: "radial-gradient(circle, rgba(255,255,255,0.30), transparent 70%)" }}
      />
      <div
        aria-hidden
        className="absolute -bottom-24 -right-12 w-64 h-64 rounded-full pointer-events-none"
        style={{ background: "radial-gradient(circle, rgba(255,255,255,0.10), transparent 70%)" }}
      />

      <div className="relative px-3 pt-3 pb-2.5">
        <div className="flex items-center gap-2.5">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt={user.name}
              className="w-11 h-11 rounded-full object-cover ring-2 ring-white/80 shadow-sm"
            />
          ) : (
            <div className="w-11 h-11 rounded-full bg-white/20 backdrop-blur ring-2 ring-white/80 shadow-sm grid place-items-center">
              <span className="text-sm font-bold">{initials(user.name)}</span>
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <div className="text-[14px] font-semibold leading-tight truncate">
                {user.name}
              </div>
              {tone === "leader" && <Crown className="w-3.5 h-3.5 text-amber-200 shrink-0" />}
            </div>
            <div className="text-[10px] uppercase tracking-wide text-white/75">
              {ROLE_LABELS[user.role]}
            </div>
          </div>
        </div>

        {departmentNames.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {departmentNames.map((d) => (
              <span
                key={d}
                className="inline-flex items-center text-[9.5px] px-1.5 py-0.5 rounded-full bg-white/15 backdrop-blur-md border border-white/25 text-white/90 font-medium"
              >
                {d}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="relative mx-2.5 mb-1.5 px-2.5 py-2 rounded-xl bg-white/12 backdrop-blur-md border border-white/25 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25)]">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wide font-semibold">
          <span className="text-white/75">Capacity</span>
          <span className="tabular-nums text-white">{capPct}%</span>
        </div>
        <div className="mt-1.5 h-1.5 rounded-full bg-white/20 overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${capPct}%`,
              background: cap.overBuffer
                ? "linear-gradient(90deg, #fcd34d, #fbbf24)"
                : "linear-gradient(90deg, rgba(255,255,255,0.95), rgba(255,255,255,0.75))"
            }}
          />
        </div>
        <div className="mt-1 flex items-center justify-between text-[10px] text-white/75 tabular-nums">
          <span>
            {cap.usedHours.toFixed(1)}h used
            {cap.backlogHours > 0 && (
              <span className="ml-1 text-amber-200 font-semibold">
                +{cap.backlogHours.toFixed(1)}h backlog
              </span>
            )}
          </span>
          <span>{cap.available.toFixed(1)}h free</span>
        </div>
      </div>

      <div className="relative mx-2.5 mb-1.5 grid grid-cols-3 gap-1.5">
        <StatTile label="Open" value={openTasks.length} />
        <StatTile label="Done 7d" value={completedThisWeek} />
        <StatTile
          label="Overdue"
          value={overdueCount}
          highlight={overdueCount > 0}
        />
      </div>

      <div className="relative mx-2.5 mb-2.5 px-2 pt-1.5 pb-1 rounded-xl bg-white/10 backdrop-blur-md border border-white/20 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.20)] flex flex-col min-h-0 flex-1 overflow-hidden">
        <div className="text-[10px] uppercase tracking-wide font-semibold px-1 pb-1 flex items-center justify-between text-white/75 shrink-0">
          <span>Open tasks</span>
          <span className="tabular-nums text-white">{openTasks.length}</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-0.5">
          {openTasks.length === 0 ? (
            <div className="text-[11px] text-white/70 italic text-center py-2">
              All clear ✨
            </div>
          ) : (
            <ul className="space-y-1 pb-1">
              {openTasks.slice(0, 8).map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/tasks/${t.id}`}
                    className="flex items-center gap-2 px-2 py-1 rounded-md bg-white/15 hover:bg-white/25 border border-white/20 hover:border-white/40 transition-colors"
                    title={t.title}
                  >
                    <span className="text-[11px] flex-1 truncate text-white">{t.title}</span>
                    <span className="text-[10px] shrink-0 text-white/85">
                      <Countdown iso={t.dueDate} />
                    </span>
                  </Link>
                </li>
              ))}
              {openTasks.length > 8 && (
                <li className="text-[10px] text-white/60 text-center py-0.5">
                  +{openTasks.length - 8} more
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function StatTile({
  label, value, highlight
}: { label: string; value: number; highlight?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-xl px-2 py-1.5 text-center backdrop-blur-md border shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25)]",
        highlight
          ? "bg-amber-300/25 border-amber-200/45"
          : "bg-white/12 border-white/25"
      )}
    >
      <div className="text-[16px] font-bold leading-none tabular-nums text-white">
        {value}
      </div>
      <div className="mt-1 text-[9px] uppercase tracking-wide text-white/75 font-semibold">
        {label}
      </div>
    </div>
  );
}
