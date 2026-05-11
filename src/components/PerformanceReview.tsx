"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Crown, Trophy, Sparkles, TrendingUp, Award } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { PersonAvatar } from "./PersonAvatar";

interface Row {
  userId: string;
  name: string;
  avatarUrl: string | null;
  role: string;
  completedThisMonth: number;
  completedAllTime: number;
  estimateHours: number;
  actualHours: number;
  accuracy: number | null;
  kudosReceived: number;
  avgHoldMinutes: number | null;
  shiftHoursThisMonth: number;
  compositeScore: number;
}

interface Eom {
  month: string;
  userId: string;
  name: string | null;
  avatarUrl: string | null;
  crownedAt: string;
  reason: string | null;
}

// CEO Console → Performance tab. Sortable leaderboard with the option to
// crown the current Employee of the Month. Crown's effects propagate
// app-wide (every PersonAvatar reads from the presence context which
// also carries EOM info).
export function PerformanceReview({ canCrown }: { canCrown: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [eom, setEom] = useState<Eom | null>(null);
  const [crowning, setCrowning] = useState<string | null>(null);

  async function loadAll() {
    try {
      const [perfRes, eomRes] = await Promise.all([
        fetch("/api/performance", { cache: "no-store" }),
        fetch("/api/eom", { cache: "no-store" })
      ]);
      const perf = perfRes.ok ? await perfRes.json() : { leaderboard: [] };
      const eomData = eomRes.ok ? await eomRes.json() : { eom: null };
      setRows(perf.leaderboard ?? []);
      setEom(eomData.eom ?? null);
    } catch (e) {
      toast.error(`Couldn't load performance: ${e instanceof Error ? e.message : "network error"}`);
    }
  }
  useEffect(() => { loadAll(); }, []);

  async function crown(userId: string, name: string) {
    if (crowning) return;
    setCrowning(userId);
    try {
      const res = await fetch("/api/eom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId })
      });
      if (!res.ok) throw new Error(`failed (${res.status})`);
      toast.success(`👑 ${name.split(" ")[0]} is now Employee of the Month!`);
      // Optimistic + refetch.
      setEom((prev) => prev ? { ...prev, userId, name } : null);
      await loadAll();
    } catch (e) {
      toast.error(`Couldn't crown: ${e instanceof Error ? e.message : "network error"}`);
    } finally {
      setCrowning(null);
    }
  }

  async function uncrown() {
    if (!confirm("Remove this month's Employee of the Month?")) return;
    try {
      await fetch("/api/eom", { method: "DELETE" });
      setEom(null);
      toast.success("Crown removed.");
    } catch (e) {
      toast.error(`Couldn't remove: ${e instanceof Error ? e.message : "network error"}`);
    }
  }

  return (
    <div className="space-y-4">
      {/* Hero: current EOM banner. Big animated crown when set; quiet
          empty state when not. */}
      <EomHero eom={eom} canCrown={canCrown} onUncrown={uncrown} />

      {/* Leaderboard */}
      <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
        <header className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-amber-50 ring-1 ring-amber-200/60 grid place-items-center text-amber-600">
            <Trophy className="w-4 h-4" />
          </div>
          <div className="flex-1">
            <div className="text-[15px] font-semibold text-ink">Performance leaderboard</div>
            <div className="text-[12px] text-ink/55 mt-0.5">
              This month · ranked by composite score (completions, kudos, accuracy, hold time)
            </div>
          </div>
        </header>

        {rows === null ? (
          <div className="text-xs text-muted">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted italic py-4 text-center">No team members yet.</div>
        ) : (
          <div className="overflow-x-auto -mx-2 px-2">
            <table className="text-sm w-full">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-muted">
                  <th className="text-left py-2 px-3 font-semibold">Rank</th>
                  <th className="text-left py-2 px-3 font-semibold">Person</th>
                  <th className="text-right py-2 px-3 font-semibold">Done</th>
                  <th className="text-right py-2 px-3 font-semibold">Kudos</th>
                  <th className="text-right py-2 px-3 font-semibold">Accuracy</th>
                  <th className="text-right py-2 px-3 font-semibold">Hold avg</th>
                  <th className="text-right py-2 px-3 font-semibold">On-shift</th>
                  <th className="text-right py-2 px-3 font-semibold">Score</th>
                  {canCrown && <th className="py-2 px-3" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const isEom = eom?.userId === r.userId;
                  return (
                    <tr
                      key={r.userId}
                      className={cn(
                        "border-t border-slate-100",
                        isEom && "bg-amber-50/40"
                      )}
                    >
                      <td className="py-2.5 px-3">
                        <RankBadge index={i} />
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <PersonAvatar
                            userId={r.userId}
                            name={r.name}
                            imageUrl={r.avatarUrl}
                            size={28}
                          />
                          <div className="min-w-0">
                            <div className="font-medium text-ink truncate flex items-center gap-1.5">
                              {r.name}
                              {isEom && <Crown className="w-3.5 h-3.5 text-amber-500" />}
                            </div>
                            <div className="text-[11px] text-muted truncate">{r.role.replace("_", " ")}</div>
                          </div>
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums">
                        <span className="font-semibold">{r.completedThisMonth}</span>
                        <span className="text-muted text-[11px]"> / {r.completedAllTime}</span>
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums">
                        {r.kudosReceived > 0 ? (
                          <span className="text-fuchsia-700 font-semibold">{r.kudosReceived}</span>
                        ) : <span className="text-muted">—</span>}
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums">
                        {r.accuracy != null
                          ? <AccuracyPill ratio={r.accuracy} />
                          : <span className="text-muted">—</span>}
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums text-ink/75">
                        {r.avgHoldMinutes != null ? formatMinutes(r.avgHoldMinutes) : <span className="text-muted">—</span>}
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums text-ink/75">
                        {r.shiftHoursThisMonth > 0 ? `${r.shiftHoursThisMonth}h` : <span className="text-muted">—</span>}
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums">
                        <span className="font-semibold text-accent">{r.compositeScore.toFixed(1)}</span>
                      </td>
                      {canCrown && (
                        <td className="py-2.5 px-3">
                          <button
                            type="button"
                            onClick={() => crown(r.userId, r.name)}
                            disabled={crowning !== null || isEom}
                            className={cn(
                              "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors disabled:opacity-50",
                              isEom
                                ? "bg-amber-100 text-amber-700 border border-amber-300"
                                : "bg-white border border-slate-300 text-ink hover:border-amber-400 hover:bg-amber-50"
                            )}
                          >
                            <Crown className="w-3 h-3 text-amber-500" />
                            {isEom ? "Crowned" : "Crown"}
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/* ============================ EOM HERO ============================ */

function EomHero({
  eom, canCrown, onUncrown
}: {
  eom: Eom | null;
  canCrown: boolean;
  onUncrown: () => void;
}) {
  if (!eom) {
    return (
      <section className="rounded-2xl border border-slate-200/70 bg-gradient-to-r from-amber-50 via-white to-amber-50/60 p-5 flex items-center gap-4">
        <div className="w-12 h-12 rounded-2xl bg-white ring-1 ring-amber-200/70 grid place-items-center text-amber-500 shadow-sm">
          <Crown className="w-6 h-6" />
        </div>
        <div className="flex-1">
          <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-amber-600">
            Employee of the Month
          </div>
          <div className="text-[15px] text-ink/75 mt-0.5">
            No one's crowned for this month yet — use the leaderboard below to pick someone.
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="relative overflow-hidden rounded-2xl border border-amber-300/60 p-5 bg-gradient-to-br from-amber-100 via-amber-50 to-yellow-50">
      {/* Drifting sparkles for a touch of celebration */}
      <Sparkle x={20} y={20} size={14} delay={0} />
      <Sparkle x={80} y={50} size={10} delay={0.6} />
      <Sparkle x={40} y={80} size={8} delay={1.2} />
      <Sparkle x={92} y={20} size={12} delay={1.8} />

      <div className="relative flex items-center gap-4">
        <motion.div
          initial={{ rotate: -8, scale: 0.9 }}
          animate={{ rotate: [-8, 8, -4, 0], scale: 1 }}
          transition={{ duration: 0.9, ease: [0.2, 0.8, 0.2, 1] }}
          className="w-14 h-14 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 grid place-items-center text-white shadow-lift"
        >
          <Crown className="w-7 h-7" />
        </motion.div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-amber-700">
            Employee of the Month · {prettyMonth(eom.month)}
          </div>
          <div className="text-[28px] font-bold text-ink leading-tight tracking-tight mt-1 flex items-center gap-2">
            <PersonAvatar
              userId={eom.userId}
              name={eom.name ?? "Unknown"}
              imageUrl={eom.avatarUrl}
              size={36}
              className="ring-2 ring-white shadow-sm"
            />
            {eom.name}
          </div>
          {eom.reason && (
            <div className="text-[13px] text-ink/70 mt-1 max-w-2xl">{eom.reason}</div>
          )}
        </div>
        {canCrown && (
          <button
            onClick={onUncrown}
            className="text-[11px] text-amber-700 hover:text-amber-900 hover:underline"
          >
            Remove crown
          </button>
        )}
      </div>
    </section>
  );
}

function Sparkle({ x, y, size, delay }: { x: number; y: number; size: number; delay: number }) {
  return (
    <motion.div
      aria-hidden
      initial={{ opacity: 0, scale: 0 }}
      animate={{ opacity: [0, 1, 0], scale: [0, 1, 0.5] }}
      transition={{ duration: 2, repeat: Infinity, repeatDelay: 0.8, delay, ease: "easeInOut" }}
      className="absolute pointer-events-none"
      style={{ left: `${x}%`, top: `${y}%`, width: size, height: size }}
    >
      <Sparkles className="w-full h-full text-amber-400" />
    </motion.div>
  );
}

/* ============================ ROW BITS ============================ */

function RankBadge({ index }: { index: number }) {
  const cls = index === 0
    ? "bg-gradient-to-br from-amber-400 to-orange-500 text-white"
    : index === 1
    ? "bg-gradient-to-br from-slate-300 to-slate-400 text-white"
    : index === 2
    ? "bg-gradient-to-br from-amber-700 to-amber-800 text-white"
    : "bg-slate-100 text-ink/70";
  return (
    <span className={cn(
      "inline-flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold tabular-nums",
      cls
    )}>
      {index + 1}
    </span>
  );
}

function AccuracyPill({ ratio }: { ratio: number }) {
  // 1.0 = perfect, <1 ahead of schedule, >1 over.
  const tone = ratio < 0.85 ? "ahead" : ratio <= 1.15 ? "ontime" : "over";
  const cls = {
    ahead:  "bg-emerald-50 text-emerald-700 border-emerald-200/60",
    ontime: "bg-blue-50 text-blue-700 border-blue-200/60",
    over:   "bg-rose-50 text-rose-700 border-rose-200/60"
  }[tone];
  return (
    <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded-full border text-[11px] font-semibold", cls)}>
      {ratio.toFixed(2)}×
    </span>
  );
}

function formatMinutes(m: number): string {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d}d ${remH}h` : `${d}d`;
}

function prettyMonth(key: string): string {
  // "2026-05" → "May 2026"
  const [y, m] = key.split("-");
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
