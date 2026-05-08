"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { PersonAvatar } from "@/components/PersonAvatar";
import { useCurrentUser } from "@/lib/user-context";
import {
  Activity, Clock, Target, TrendingUp, ShieldAlert, Zap, Award, BarChart3
} from "lucide-react";
import { PageHero } from "@/components/PageHero";

interface UserBucket {
  userId: string;
  name: string;
  avatarUrl: string | null;
  handoffCount: number;
  totalHeldMinutes: number;
  avgHeldMinutes: number;
}

interface EstActualBucket {
  userId: string;
  name: string;
  avatarUrl: string | null;
  completed: number;
  estimateHours: number;
  actualHours: number;
  ratio: number;
}

interface StageBucket {
  stage: string;
  count: number;
  avgMinutes: number;
}

interface SlowTask {
  taskId: string;
  title: string;
  totalMinutes: number;
  handoffCount: number;
  status: string;
}

interface CompletionUser {
  userId: string;
  name: string;
  avatarUrl: string | null;
  weekCount: number;
  totalCount: number;
}

interface RecentCompletion {
  taskId: string;
  title: string;
  completedAt: string;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeAvatarUrl: string | null;
  estimateHours: number;
}

interface Payload {
  perUser: UserBucket[];
  estVsActual: EstActualBucket[];
  perStage: StageBucket[];
  slowestTasks: SlowTask[];
  completionsByUser: CompletionUser[];
  recentCompletions: RecentCompletion[];
  totalCompletedThisWeek: number;
  totalCompletedAllTime: number;
}

// Bottleneck analytics. Lives at /analytics for everyone — the page itself
// handles role gating (CEO sees full picture, dept_head sees a banner
// pointing to the same data, worker is bounced).
export default function AnalyticsPage() {
  const me = useCurrentUser();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Skip while the tab's hidden so we don't burn requests on a
      // background page; the visibility listener below picks it back up
      // the moment it returns to foreground.
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/analytics/bottlenecks", { cache: "no-store" });
        const d = await res.json();
        if (cancelled) return;
        if (d.error) setError(d.error);
        else {
          setData(d);
          setError(null);
          setUpdatedAt(Date.now());
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "network error");
        }
      }
    }

    load();
    const interval = setInterval(load, 10_000);
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", load);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", load);
    };
  }, []);

  if (me.role === "worker") {
    return (
      <div className="card p-6 max-w-lg mx-auto mt-12 text-center">
        <ShieldAlert className="w-8 h-8 text-warn mx-auto mb-2" />
        <div className="text-base font-medium">Leadership view</div>
        <div className="text-sm text-muted mt-1">
          Bottleneck analytics are scoped to dept heads and the CEO.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Bottlenecks"
        headline={["Where time ", { accent: "gets stuck" }]}
        subtitle="Hold time per person, estimate accuracy, slow stages, and the tasks that bled the clock."
        icon={<BarChart3 />}
        iconTone="sky"
        trailing={
          updatedAt && (
            <div className="inline-flex items-center gap-1.5 text-[11px] text-ink/60 bg-emerald-50 border border-emerald-200/70 rounded-full px-2.5 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 anim-pulse-dot" />
              <LiveLabel updatedAt={updatedAt} />
            </div>
          )
        }
      />

      {error && (
        <div className="card p-4 text-sm text-urgent border-urgent/40 bg-urgent/5">
          Couldn't load analytics: {error}
        </div>
      )}

      {!data && !error && (
        <div className="card p-8 text-center text-sm text-muted">Crunching the numbers…</div>
      )}

      {data && (
        <>
          {/* Top row: completions. Independent of handoffs, so a freshly-
              done task shows up here immediately — that's the "did my work
              register?" reassurance. */}
          <div className="grid grid-cols-3 gap-4">
            <SnapshotStat
              icon={<Award className="w-4 h-4" />}
              label="Completed this week"
              value={data.totalCompletedThisWeek}
              tone="blue"
            />
            <SnapshotStat
              icon={<Zap className="w-4 h-4" />}
              label="All-time completed"
              value={data.totalCompletedAllTime}
              tone="violet"
            />
            <SnapshotStat
              icon={<Clock className="w-4 h-4" />}
              label="Total handoff time"
              value={formatMinutes(data.perUser.reduce((s, u) => s + u.totalHeldMinutes, 0))}
              tone="purple"
              isString
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Panel
              title="Completions per person · last 7 days"
              subtitle="Who's shipping. Updates the moment a task flips to done."
              icon={<Award className="w-4 h-4 text-emerald-600" />}
              tone="blue"
            >
              {data.completionsByUser.length === 0 ? (
                <Empty hint="No completed tasks yet." />
              ) : (
                <HorizontalBars
                  items={data.completionsByUser
                    .filter((u) => u.weekCount > 0 || u.totalCount > 0)
                    .map((u) => ({
                      key: u.userId,
                      label: u.name,
                      avatarUrl: u.avatarUrl,
                      value: u.weekCount,
                      valueLabel: `${u.weekCount} this week`,
                      sub: `${u.totalCount} all-time`,
                      color: "from-emerald-500 to-teal-500"
                    }))}
                />
              )}
            </Panel>

            <Panel
              title="Recently completed"
              subtitle="The last few tasks to hit done."
              icon={<Award className="w-4 h-4 text-emerald-600" />}
              tone="violet"
            >
              {data.recentCompletions.length === 0 ? (
                <Empty hint="Nothing completed yet — finish a task and it'll land here." />
              ) : (
                <ul className="space-y-2">
                  {data.recentCompletions.map((t) => (
                    <li key={t.taskId}>
                      <Link
                        href={`/tasks/${t.taskId}`}
                        className="flex items-center gap-3 rounded-xl border border-white/60 bg-white/55 backdrop-blur-sm hover:bg-white/75 px-3 py-2 transition-colors"
                      >
                        <Avatar
                          name={t.assigneeName ?? "Unassigned"}
                          imageUrl={t.assigneeAvatarUrl ?? undefined}
                          size={26}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{t.title}</div>
                          <div className="text-[10px] text-muted">
                            {t.assigneeName ?? "—"} · {relativeTime(t.completedAt)}
                          </div>
                        </div>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200/70">
                          ✓ done
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Panel
              title="Average hold time per person"
              subtitle="How long a task sits with each person before they hand it off"
              icon={<Clock className="w-4 h-4 text-blue-600" />}
              tone="blue"
            >
              {data.perUser.length === 0 ? (
                <Empty hint="No handoffs recorded yet — once tasks move between people, this will populate." />
              ) : (
                <HorizontalBars
                  items={data.perUser.map((u) => ({
                    key: u.userId,
                    label: u.name,
                    avatarUrl: u.avatarUrl,
                    value: u.avgHeldMinutes,
                    valueLabel: formatMinutes(u.avgHeldMinutes),
                    sub: `${u.handoffCount} handoff${u.handoffCount === 1 ? "" : "s"}`,
                    color: "from-blue-500 to-indigo-500"
                  }))}
                />
              )}
            </Panel>

            <Panel
              title="Estimate vs actual"
              subtitle="Completed tasks only · ratio above 1.0 means consistently over the estimate"
              icon={<Target className="w-4 h-4 text-indigo-600" />}
              tone="violet"
            >
              {data.estVsActual.filter((u) => u.actualHours > 0).length === 0 ? (
                <Empty hint="Nobody's logged actual hours yet — once your team starts tracking time on completed tasks, accuracy ratios surface here." />
              ) : (
                <ul className="space-y-3">
                  {data.estVsActual.filter((u) => u.actualHours > 0).map((u) => {
                    const ratio = u.ratio || 1;
                    const overBudget = ratio > 1.05;
                    return (
                      <li key={u.userId} className="flex items-center gap-3">
                        <PersonAvatar userId={u.userId} name={u.name} imageUrl={u.avatarUrl ?? undefined} size={26} />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{u.name}</div>
                          <div className="mt-1 relative h-2 w-full rounded-full bg-slate-200/60 overflow-hidden">
                            <div
                              className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-emerald-400 to-emerald-500"
                              style={{ width: `${Math.min(100, (u.estimateHours / Math.max(u.actualHours, u.estimateHours)) * 100)}%` }}
                            />
                            <div
                              className={`absolute inset-y-0 left-0 rounded-full opacity-70 ${
                                overBudget
                                  ? "bg-gradient-to-r from-rose-400 to-rose-500"
                                  : "bg-gradient-to-r from-blue-400 to-indigo-500"
                              }`}
                              style={{
                                width: `${Math.min(100, (u.actualHours / Math.max(u.actualHours, u.estimateHours)) * 100)}%`,
                                mixBlendMode: "multiply"
                              }}
                            />
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className={`text-xs font-semibold tabular-nums ${overBudget ? "text-rose-600" : "text-emerald-700"}`}>
                            {ratio.toFixed(2)}×
                          </div>
                          <div className="text-[10px] text-muted tabular-nums">
                            {Math.round(u.actualHours)}h / {Math.round(u.estimateHours)}h
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>

            <Panel
              title="Slowest stages"
              subtitle="Free-text stages from handoffs. Where work always seems to wait."
              icon={<TrendingUp className="w-4 h-4 text-indigo-600" />}
              tone="violet"
            >
              {data.perStage.length === 0 ? (
                <Empty hint="Nobody's tagged a stage in their handoffs yet." />
              ) : (
                <HorizontalBars
                  items={data.perStage.map((s) => ({
                    key: s.stage,
                    label: s.stage,
                    value: s.avgMinutes,
                    valueLabel: formatMinutes(s.avgMinutes),
                    sub: `${s.count} occurrence${s.count === 1 ? "" : "s"}`,
                    color: "from-indigo-500 to-blue-500"
                  }))}
                />
              )}
            </Panel>

            <Panel
              title="Slowest tasks"
              subtitle="Total cumulative hold time across everyone who's touched it"
              icon={<Activity className="w-4 h-4 text-rose-600" />}
              tone="purple"
            >
              {data.slowestTasks.length === 0 ? (
                <Empty hint="No tracked hold time yet." />
              ) : (
                <ul className="space-y-2">
                  {data.slowestTasks.map((t, i) => (
                    <li key={t.taskId}>
                      <Link
                        href={`/tasks/${t.taskId}`}
                        className="flex items-center gap-3 rounded-xl border border-white/60 bg-white/55 backdrop-blur-sm hover:bg-white/75 px-3 py-2 transition-colors"
                      >
                        <span className="w-6 h-6 rounded-full bg-gradient-to-br from-rose-500 to-orange-500 text-white text-[11px] grid place-items-center font-semibold tabular-nums">
                          {i + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{t.title}</div>
                          <div className="text-[10px] text-muted">
                            {t.handoffCount} handoff{t.handoffCount === 1 ? "" : "s"} · {t.status}
                          </div>
                        </div>
                        <div className="text-xs font-semibold tabular-nums text-rose-600">
                          {formatMinutes(t.totalMinutes)}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

        </>
      )}
    </div>
  );
}

/* ====================== shared building blocks ====================== */

function Panel({
  title, subtitle, icon, tone, children
}: {
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  tone: "blue" | "violet" | "purple";
  children: React.ReactNode;
}) {
  const chip = {
    blue:   "bg-blue-50    text-blue-600    ring-blue-200/60",
    violet: "bg-fuchsia-50 text-fuchsia-600 ring-fuchsia-200/60",
    purple: "bg-rose-50    text-rose-600    ring-rose-200/60"
  }[tone];
  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <header className="flex items-start gap-3 mb-4">
        <div className={`w-10 h-10 rounded-xl ring-1 grid place-items-center shrink-0 ${chip}`}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-semibold text-ink">{title}</div>
          {subtitle && <div className="text-[12px] text-ink/55 mt-0.5">{subtitle}</div>}
        </div>
      </header>
      {children}
    </section>
  );
}

interface BarItem {
  key: string;
  label: string;
  avatarUrl?: string | null;
  value: number;
  valueLabel: string;
  sub?: string;
  color: string;
}

function HorizontalBars({ items }: { items: BarItem[] }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="space-y-2.5">
      {items.map((it) => (
        <li key={it.key} className="flex items-center gap-3">
          {it.avatarUrl !== undefined && (
            <PersonAvatar userId={it.key} name={it.label} imageUrl={it.avatarUrl ?? undefined} size={26} />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-medium truncate">{it.label}</div>
              <div className="text-[11px] tabular-nums font-semibold text-ink shrink-0">
                {it.valueLabel}
              </div>
            </div>
            <div className="mt-1 relative h-2 w-full rounded-full bg-slate-200/60 overflow-hidden">
              <div
                className={`absolute inset-y-0 left-0 rounded-full bg-gradient-to-r ${it.color} transition-[width] duration-700`}
                style={{ width: `${Math.max(2, (it.value / max) * 100)}%` }}
              />
            </div>
            {it.sub && (
              <div className="text-[10px] text-muted mt-0.5">{it.sub}</div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Empty({ hint }: { hint: string }) {
  return <div className="text-xs text-muted italic py-4 text-center">{hint}</div>;
}

function SnapshotStat({
  icon, label, value, tone, isString
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  tone: "blue" | "violet" | "purple";
  isString?: boolean;
}) {
  // White card with thin slate border + tone-tinted icon chip. The three
  // top-of-page tiles each get their own hue (emerald / sky / indigo) so
  // the page reads as colorful rather than a wall of monochrome blue.
  const chip = {
    blue:   "bg-emerald-50 text-emerald-600 ring-emerald-200/60",
    violet: "bg-sky-50    text-sky-600    ring-sky-200/60",
    purple: "bg-indigo-50  text-indigo-600  ring-indigo-200/60"
  }[tone];
  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <div className="flex items-center gap-2.5">
        <div className={`w-10 h-10 rounded-xl ring-1 grid place-items-center ${chip}`}>
          {icon}
        </div>
        <div className="text-[12px] font-semibold text-ink/65 uppercase tracking-wide">{label}</div>
      </div>
      <div className="mt-3 text-[34px] font-bold tabular-nums text-ink tracking-tight leading-none">
        {isString ? value : (value as number).toLocaleString()}
      </div>
    </div>
  );
}

function LiveLabel({ updatedAt }: { updatedAt: number }) {
  // Re-render every 5s so "updated Ns ago" stays current between fetches.
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  const ms = Date.now() - updatedAt;
  const label = ms < 5000 ? "live" : ms < 60_000 ? `${Math.round(ms / 1000)}s ago` : `${Math.round(ms / 60_000)}m ago`;
  return <span className="font-medium text-emerald-700">{label}</span>;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function formatMinutes(m: number): string {
  if (m < 60) return `${Math.round(m)}m`;
  const h = Math.floor(m / 60);
  const rem = Math.round(m % 60);
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d}d ${remH}h` : `${d}d`;
}
