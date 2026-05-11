"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Crown, X } from "lucide-react";
import { Countdown } from "./Countdown";
import { usePresence } from "@/lib/presence-context";
import { cn, initials } from "@/lib/utils";
import { ROLE_LABELS } from "@/lib/auth";
import { userCapacity } from "@/lib/capacity";
import type { Department, Task, User } from "@/lib/types";

// Org chart visualization. Visual language follows TeamCarousel: each
// person is a photo-card (avatar fills the tile, gradient name strip at
// the bottom), curved SVG strokes between tiers replace the plain gray
// connectors, and a big "ORG CHART" watermark sits behind everything.
//
// Filtering is the caller's job — pass in the slice of users/depts/tasks
// you want visualized. CEO console passes everything; dept-head Team
// Overview passes only their dept's members + tasks.

interface Props {
  users: User[];
  departments: Department[];
  tasks: Task[];
  ceo?: User | null;            // optional root node (omit for dept-head view)
  tasksPerPerson?: number;      // top-N tasks shown under each person; default 2
  emptyLabel?: string;          // shown when a person has no open tasks
}

const PRIORITY_RANK: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3
};

const ROLE_TONE: Record<User["role"], string> = {
  ceo: "from-amber-200 via-amber-100 to-amber-50 text-amber-700",
  department_head: "from-indigo-200 via-indigo-100 to-indigo-50 text-indigo-700",
  worker: "from-blue-200 via-blue-100 to-blue-50 text-blue-700"
};

const PRESENCE_DOT: Record<string, string> = {
  available: "bg-emerald-500",
  focus: "bg-violet-500",
  eating: "bg-amber-500",
  away: "bg-slate-400"
};

// Applied to every backdrop-filter element inside the flip card. The flip
// container's `transform-style: preserve-3d` defers backdrop-filter
// rendering on its children until a repaint — `translateZ(0)` plus
// `will-change` forces each glass panel onto its own GPU layer so the
// blur composes from first paint (otherwise it only "kicks in" on hover).
const GPU_LAYER: React.CSSProperties = {
  transform: "translateZ(0)",
  willChange: "transform"
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

export function OrgChart({
  users, departments, tasks, ceo, tasksPerPerson = 2, emptyLabel = "No open tasks"
}: Props) {
  // Refs to anchor SVG curves between tiers. Each connector pairs a
  // "from" node (CEO or dept-head card) with a "to" node (dept column
  // header or worker tile). We measure once on mount + on resize.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const ceoRef = useRef<HTMLDivElement | null>(null);
  const deptHeaderRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const headRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const workerRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  // Connector geometry, recomputed whenever the layout changes.
  const [edges, setEdges] = useState<{ d: string; key: string }[]>([]);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useEffect(() => {
    function measure() {
      const root = containerRef.current;
      if (!root) return;
      const rootRect = root.getBoundingClientRect();
      setSize({ w: rootRect.width, h: rootRect.height });

      const next: { d: string; key: string }[] = [];

      // CEO → each dept's header tile.
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

      // Dept-head → each worker in that dept.
      for (const [headId, headEl] of headRefs.current) {
        if (!headEl) continue;
        const h = headEl.getBoundingClientRect();
        const fromX = h.left + h.width / 2 - rootRect.left;
        const fromY = h.bottom - rootRect.top;
        // Workers are keyed by `${deptId}:${userId}`; we use the head's
        // dept id (encoded the same way) to find them.
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
      <div
        ref={containerRef}
        className="relative z-10 overflow-x-auto"
      >
        {/* SVG layer — sits behind the cards but above the watermark. */}
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

        <div className="relative z-10 flex flex-col items-center min-w-fit gap-10">
          {ceo && (
            <div ref={ceoRef}>
              <PersonCard
                user={ceo}
                tone="ceo"
                tasks={openTasksFor(ceo.id, tasks)}
                allUserTasks={tasks.filter((t) => t.assigneeId === ceo.id)}
                tasksPerPerson={tasksPerPerson}
                emptyLabel={emptyLabel}
                departments={departments}
              />
            </div>
          )}

          <div
            className="grid gap-8 items-start"
            style={{
              gridTemplateColumns: `repeat(${Math.max(departments.length, 1)}, minmax(220px, 1fr))`
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

              return (
                <div key={d.id} className="flex flex-col items-center gap-6">
                  {/* Dept header — frosted-glass pill keeps the column
                      anchored visually before any cards render. The
                      connector from CEO targets THIS element so the
                      curve looks like it's feeding the whole column. */}
                  <div
                    ref={(el) => { deptHeaderRefs.current.set(d.id, el); }}
                    className="inline-flex flex-col items-center gap-1 px-4 py-2 rounded-full border border-white/70 bg-white/55 backdrop-blur-xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.7),0_8px_24px_-12px_rgba(15,23,42,0.18)]"
                  >
                    <div className="text-xs uppercase tracking-wide text-ink/70 font-semibold">
                      {d.name}
                    </div>
                    <div
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200/70 text-[10px] font-medium"
                      title={`${completedThisWeek} done in the last 7 days`}
                    >
                      ✓ {completedThisWeek} this week
                    </div>
                  </div>

                  <div className="flex flex-col items-center gap-3 w-full">
                    {heads.length === 0 ? (
                      <div className="badge badge-tag self-center">No head</div>
                    ) : (
                      heads.map((h) => (
                        <div
                          key={h.id}
                          ref={(el) => { headRefs.current.set(h.id, el); }}
                          data-dept={d.id}
                        >
                          <PersonCard
                            user={h}
                            tone="head"
                            tasks={openTasksFor(h.id, tasks)}
                            allUserTasks={tasks.filter((t) => t.assigneeId === h.id)}
                            tasksPerPerson={tasksPerPerson}
                            emptyLabel={emptyLabel}
                            departments={departments}
                          />
                        </div>
                      ))
                    )}
                  </div>

                  {workers.length > 0 && (
                    <div className="flex flex-col gap-3 w-full">
                      {workers.map((w) => (
                        <div
                          key={w.id}
                          ref={(el) => { workerRefs.current.set(`${d.id}:${w.id}`, el); }}
                        >
                          <PersonCard
                            user={w}
                            tone="worker"
                            tasks={openTasksFor(w.id, tasks)}
                            allUserTasks={tasks.filter((t) => t.assigneeId === w.id)}
                            tasksPerPerson={tasksPerPerson}
                            emptyLabel={emptyLabel}
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
  // Smooth vertical-flow Bezier: control points pulled vertically so the
  // curve drops straight out of the source then sweeps into the target.
  const dy = Math.max(40, Math.abs(toY - fromY) * 0.55);
  return `M ${fromX} ${fromY} C ${fromX} ${fromY + dy}, ${toX} ${toY - dy}, ${toX} ${toY}`;
}

function PersonCard({
  user, tone, tasks, allUserTasks, tasksPerPerson, emptyLabel, departments
}: {
  user: User;
  tone: "ceo" | "head" | "worker";
  tasks: Task[];
  // Every task ever assigned to this user (any status). The back face
  // uses this to compute "done this week" without reaching back into
  // the parent.
  allUserTasks: Task[];
  tasksPerPerson: number;
  emptyLabel: string;
  departments: Department[];
}) {
  // Live avatar — settings uploads land in the DB and PresenceProvider
  // hydrates them, so prefer that over the prop snapshot.
  const live = usePresence(user.id);
  const avatarUrl = user.avatarUrl ?? live?.avatarUrl ?? null;
  const presence = live?.presence ?? null;
  const emoji = live?.statusEmoji ?? null;

  const visible = tasks.slice(0, tasksPerPerson);
  const overflow = tasks.length - visible.length;

  const [flipped, setFlipped] = useState(false);

  // Card frame — wider for the CEO so the root reads as the apex; same
  // height across roles so the row baselines stay aligned.
  const cardWidthClass = tone === "ceo" ? "w-[280px]" : "w-[240px]";
  const cardHeightClass = tone === "ceo" ? "h-[340px]" : "h-[300px]";

  // Department names this person belongs to — shown on the back face so
  // the flip carries enough context to skip a profile click.
  const userDeptNames = user.departmentIds
    .map((id) => departments.find((d) => d.id === id)?.name)
    .filter(Boolean) as string[];

  return (
    <div
      className={cn("relative", cardWidthClass, cardHeightClass)}
      style={{ perspective: 1200 }}
    >
      <div
        className="relative w-full h-full transition-transform"
        style={{
          transformStyle: "preserve-3d",
          transitionDuration: "650ms",
          transitionTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)",
          transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)",
          // Force the flip container onto its own composited layer so
          // backdrop-filter on the glass panels inside renders from
          // first paint (Chrome/Safari otherwise defer the blur until
          // the next repaint, which is what makes hover "fix" it).
          willChange: "transform"
        }}
      >
        {/* ===== FRONT — photo + glass info panel ===== */}
        <div
          className={cn(
            "absolute inset-0 rounded-2xl overflow-hidden transition-transform duration-200",
            !flipped && "hover:-translate-y-0.5"
          )}
          style={{
            backfaceVisibility: "hidden",
            WebkitBackfaceVisibility: "hidden",
            boxShadow: "0 8px 20px -12px rgba(15,23,42,0.18), 0 2px 6px -2px rgba(15,23,42,0.06)"
          }}
        >
          {/* Full-bleed background — photo or role-tinted fallback. */}
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt={user.name}
              draggable={false}
              className="absolute inset-0 w-full h-full object-cover"
            />
          ) : (
            <div
              className={cn(
                "absolute inset-0 flex items-center justify-center bg-gradient-to-br",
                ROLE_TONE[user.role]
              )}
            >
              <div className="w-24 h-24 rounded-full bg-white/85 ring-2 ring-white shadow grid place-items-center -translate-y-6">
                <span className="text-3xl font-bold tracking-tight text-ink/85">
                  {initials(user.name)}
                </span>
              </div>
            </div>
          )}

          {/* Whole-card click target — flips to the back. Sits behind the
              corner badges + glass panel so those keep their own
              interactions. */}
          <button
            type="button"
            onClick={() => setFlipped(true)}
            aria-label={`Show details for ${user.name}`}
            className="absolute inset-0 z-0 cursor-pointer"
          />

          {/* Top corner badges — glass pills floating on the photo.
              translateZ(0) promotes each pill to its own GPU layer so
              backdrop-blur composes from first paint inside the flip's
              preserve-3d context. */}
          {presence && (
            <div
              className="absolute top-2.5 left-2.5 z-20 inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-white/55 backdrop-blur-md border border-white/70 shadow-sm pointer-events-none"
              style={GPU_LAYER}
            >
              <span className={cn("w-2 h-2 rounded-full", PRESENCE_DOT[presence])} />
              <span className="text-[9.5px] font-semibold text-ink/80 capitalize">
                {presence}
              </span>
            </div>
          )}
          {emoji && (
            <div
              className="absolute top-2.5 right-2.5 z-20 w-7 h-7 grid place-items-center rounded-full bg-white/55 backdrop-blur-md border border-white/70 shadow-sm text-base leading-none pointer-events-none"
              style={GPU_LAYER}
            >
              {emoji}
            </div>
          )}

          {/* Glass info panel — frosted, sits at the bottom of the card. */}
          <div
            className="absolute inset-x-2 bottom-2 z-10 rounded-xl border border-white/70 bg-white/45 backdrop-blur-xl p-2.5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.7),0_8px_24px_-12px_rgba(15,23,42,0.18)] pointer-events-none"
            style={GPU_LAYER}
          >
            <div className="flex items-center gap-1.5">
              <div className="text-[13px] font-semibold leading-tight truncate text-ink">
                {user.name}
              </div>
              {tone === "ceo" && <Crown className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
              <span className="ml-auto text-[10px] font-medium text-ink/65 tabular-nums shrink-0">
                {tasks.length} open
              </span>
            </div>
            <div className="text-[10px] uppercase tracking-wide text-ink/55 truncate">
              {ROLE_LABELS[user.role]}
            </div>

            {visible.length === 0 ? (
              <div className="mt-2 text-[11px] text-ink/55 italic text-center py-0.5">
                {emptyLabel}
              </div>
            ) : (
              <ul className="mt-2 space-y-1 pointer-events-auto">
                {visible.map((t) => (
                  <li key={t.id}>
                    <Link
                      href={`/tasks/${t.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="flex items-center gap-2 px-2 py-1 rounded-md bg-white/65 hover:bg-white border border-white/60 hover:border-accent/40 transition-colors"
                      title={t.title}
                    >
                      <span className="text-[11px] flex-1 truncate text-ink">{t.title}</span>
                      <span className="text-[10px] shrink-0">
                        <Countdown iso={t.dueDate} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}

            {overflow > 0 && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setFlipped(true); }}
                className="pointer-events-auto mt-1.5 block w-full text-center text-[10px] text-ink/60 hover:text-accent transition-colors"
              >
                +{overflow} more
              </button>
            )}
          </div>
        </div>

        {/* ===== BACK — capacity + stats + task list, glassy blue ===== */}
        <div
          className="absolute inset-0 rounded-2xl overflow-hidden"
          style={{
            backfaceVisibility: "hidden",
            WebkitBackfaceVisibility: "hidden",
            transform: "rotateY(180deg)",
            boxShadow: "0 12px 28px -14px rgba(30,99,255,0.40), 0 4px 12px -6px rgba(15,23,42,0.10)"
          }}
        >
          <BackFace
            user={user}
            tone={tone}
            openTasks={tasks}
            allUserTasks={allUserTasks}
            avatarUrl={avatarUrl}
            departmentNames={userDeptNames}
            onClose={() => setFlipped(false)}
          />
        </div>
      </div>
    </div>
  );
}

function BackFace({
  user, tone, openTasks, allUserTasks, avatarUrl, departmentNames, onClose
}: {
  user: User;
  tone: "ceo" | "head" | "worker";
  openTasks: Task[];
  allUserTasks: Task[];
  avatarUrl: string | null;
  departmentNames: string[];
  onClose: () => void;
}) {
  // Capacity from the same helper the dashboard + new-task ranker use.
  const cap = userCapacity(user, openTasks);
  const capPct = Math.min(100, Math.round(cap.pct * 100));

  // "Done this week" = tasks done whose lastActivityAt landed in the
  // last 7 days. lastActivityAt is the canonical write on status change,
  // so it doubles as completedAt.
  const weekAgoMs = Date.now() - 7 * 86_400_000;
  const completedThisWeek = allUserTasks.filter(
    (t) => t.status === "done" && new Date(t.lastActivityAt).getTime() >= weekAgoMs
  ).length;

  // Overdue = open task with a due date in the past.
  const nowMs = Date.now();
  const overdueCount = openTasks.filter(
    (t) => t.dueDate && new Date(t.dueDate).getTime() < nowMs
  ).length;

  return (
    <div
      className="relative flex flex-col h-full text-white"
      style={{
        background:
          "linear-gradient(135deg, #1e63ff 0%, #3a78ff 45%, #1d4ed8 100%)"
      }}
    >
      {/* Soft radial highlights — give the blue some depth so the
          frosted panels have something to refract through visually. */}
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
      {/* Inner top-edge highlight — the classic "glass" sheen. */}
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-px pointer-events-none"
        style={{ background: "linear-gradient(to right, rgba(255,255,255,0.0), rgba(255,255,255,0.55), rgba(255,255,255,0.0))" }}
      />

      {/* Header — avatar + name + role + dept chips. Close button sits
          top-right as a glass disc. */}
      <div className="relative px-3 pt-3 pb-2.5">
        <button
          type="button"
          onClick={onClose}
          aria-label="Flip back"
          className="absolute top-2 right-2 w-7 h-7 rounded-full bg-white/15 backdrop-blur-md border border-white/30 grid place-items-center text-white/85 hover:text-white hover:bg-white/25 transition-colors shadow-sm"
          style={GPU_LAYER}
        >
          <X className="w-3.5 h-3.5" />
        </button>

        <div className="flex items-center gap-2.5">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt={user.name}
              className="w-11 h-11 rounded-full object-cover ring-2 ring-white/80 shadow-sm"
            />
          ) : (
            <div className="w-11 h-11 rounded-full bg-white/20 backdrop-blur ring-2 ring-white/80 shadow-sm grid place-items-center" style={GPU_LAYER}>
              <span className="text-sm font-bold">{initials(user.name)}</span>
            </div>
          )}
          <div className="min-w-0 flex-1 pr-7">
            <div className="flex items-center gap-1.5">
              <div className="text-[14px] font-semibold leading-tight truncate">
                {user.name}
              </div>
              {tone === "ceo" && <Crown className="w-3.5 h-3.5 text-amber-200 shrink-0" />}
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
                style={GPU_LAYER}
              >
                {d}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Capacity glass tile. */}
      <div
        className="relative mx-2.5 mb-1.5 px-2.5 py-2 rounded-xl bg-white/12 backdrop-blur-md border border-white/25 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.25)]"
        style={GPU_LAYER}
      >
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
          <span>{cap.available.toFixed(1)}h free · {user.dailyCapacity}h/day</span>
        </div>
      </div>

      {/* Stat tiles — open / done 7d / overdue. */}
      <div className="relative mx-2.5 mb-1.5 grid grid-cols-3 gap-1.5">
        <StatTile label="Open" value={openTasks.length} />
        <StatTile label="Done 7d" value={completedThisWeek} />
        <StatTile
          label="Overdue"
          value={overdueCount}
          highlight={overdueCount > 0}
        />
      </div>

      {/* Open tasks — compact, scrollable. */}
      <div
        className="relative flex-1 min-h-0 mx-2.5 mb-2.5 px-2 pt-1.5 pb-1 rounded-xl bg-white/10 backdrop-blur-md border border-white/20 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.20)] overflow-hidden flex flex-col"
        style={GPU_LAYER}
      >
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
            <ul className="space-y-1">
              {openTasks.map((t) => (
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
      style={GPU_LAYER}
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
