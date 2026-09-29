"use client";

// The finance page's layout.
//
// What changed and why: the page was ~15 panels stacked in one column with no
// period control, so answering "how did June go" meant scrolling past every
// editor on the page. This gives it a single sticky command bar (month + which
// side of the business), puts the read and the numbers first, and moves the
// editing panels behind a Manage menu so they are one click from anywhere
// instead of a scroll away.
//
// Every existing editor is passed in as a slot from the server page and
// rendered untouched inside the side sheet — none of them were rewritten, so
// their own save/delete behaviour is exactly as it was. The models are the
// existing ones too: computeDefense and computeLearnings are pure, so they are
// called here per selected month rather than reimplemented.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Database, Filter, SlidersHorizontal,
  Receipt, Split, Shield, Lock, Telescope, Flag, Info, TriangleAlert, TrendingUp,
  ArrowUpRight, ArrowDownRight, ArrowUp, ArrowDown, X, Compass, UserMinus, Check, CornerDownRight
} from "lucide-react";
import { computeDefense, type Defense } from "@/lib/finance-defense";
import { computeLearnings, type Learnings, type PnlMonth } from "@/lib/finance-learnings";
import {
  buildMatrices, roomModel, roomFindings, segmentOf, expensesAt, founderPayAt,
  type Matrices, type RoomDeel, type RoomLine, type RoomMonth, type Segment, type Finding
} from "@/lib/finance-room";
import { cn } from "@/lib/utils";

const FLOOR = 30; // matches MARGIN_FLOOR in finance-defense.ts

/* ── formatting ─────────────────────────────────────────────────────────── */
const money = (n: number) =>
  `${n < 0 ? "−$" : "$"}${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
const compact = (n: number) => {
  const a = Math.abs(n);
  const sign = n < 0 ? "−$" : "$";
  if (a >= 1000000) return `${sign}${(a / 1000000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (a >= 1000) return `${sign}${(a / 1000).toFixed(a >= 10000 ? 1 : 2).replace(/\.?0+$/, "")}K`;
  return `${sign}${Math.round(a)}`;
};
const pct = (n: number) =>
  `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(n !== 0 && Math.abs(n) < 10 ? 1 : 0)}%`;

/* ── a sparkline: recessive line, current point in a status hue ─────────── */
function Spark({ values, at, good }: { values: (number | null)[]; at: number; good: boolean }) {
  const known = values.map((v) => (v === null || v === undefined ? 0 : v));
  const min = Math.min(...known);
  const max = Math.max(...known);
  const span = max - min || 1;
  const w = 104, h = 26, pad = 4;
  const x = (i: number) => pad + (i * (w - pad * 2)) / Math.max(1, known.length - 1);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - pad * 2);
  const points = known.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden className="block max-w-full">
      <polyline points={points} fill="none" stroke="#CBD5E1" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(at)} cy={y(known[at])} r={4} fill={good ? "#16A34A" : "#DC2626"} stroke="#fff" strokeWidth={2} />
    </svg>
  );
}

export interface FinanceRoomProps {
  pnl: RoomMonth[];
  lines: RoomLine[];
  deel: RoomDeel[];
  tags: Record<string, "seo" | "facebook">;
  fbRevenue: Record<string, number>;
  fbExpenses: Record<string, number>;
  fbCommission: Record<string, number>;
  clients: { company: string; mrr: number }[];
  softwareItems: { vendor: string; month: string; amount: number; segment?: string }[];
  /** the existing editor panels, rendered untouched inside the side sheet */
  panels: { key: string; label: string; hint: string; node: ReactNode }[];
  /** the Ask-AI card, kept exactly as it was */
  chat: ReactNode;
}

export function FinanceRoom(props: FinanceRoomProps) {
  const { pnl, lines, deel, tags, fbRevenue, fbExpenses, fbCommission, clients, softwareItems, panels, chat } = props;

  const periods = useMemo(() => pnl.map((p) => p.period), [pnl]);
  const labels = useMemo(() => pnl.map((p) => p.label), [pnl]);
  const matrices: Matrices = useMemo(() => buildMatrices(lines, deel, periods), [lines, deel, periods]);

  const [month, setMonth] = useState(Math.max(0, pnl.length - 1));
  const [segment, setSegment] = useState<Segment>("all");
  const [sort, setSort] = useState<"size" | "change">("size");
  const [showAll, setShowAll] = useState(false);
  const [reveal, setReveal] = useState(false);          // per-person pay, defaults shut
  const [monthOpen, setMonthOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [account, setAccount] = useState<string | null>(null);
  const [panel, setPanel] = useState<string | null>(null);

  const closeSheet = useCallback(() => { setAccount(null); setPanel(null); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && typeof el.matches === "function" && el.matches("input,textarea,select")) return;
      if (e.key === "Escape") { closeSheet(); setMonthOpen(false); setManageOpen(false); }
      if (e.key === "ArrowLeft") setMonth((m) => Math.max(0, m - 1));
      if (e.key === "ArrowRight") setMonth((m) => Math.min(pnl.length - 1, m + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pnl.length, closeSheet]);

  if (!pnl.length) return null;

  const model = roomModel(pnl, matrices, tags, fbRevenue, segment, month, FLOOR);
  const findings = roomFindings(matrices, tags, labels, segment, month, clients);
  const current = pnl[month];

  /* The existing models, per selected month. Same functions the server used. */
  const contractors = Object.entries(matrices.people)
    .map(([name, series]) => ({ name, monthly: series[month] ?? 0 }))
    .filter((c) => c.monthly > 0);
  const seoRevenue = current.income - (fbRevenue[current.period] ?? 0);
  const defense: Defense = computeDefense({
    month: current.label,
    revenue: current.income,
    normalizedNet: current.net + current.taxes + current.writeoffs,
    founderPay: founderPayAt(matrices, month),
    software: current.software,
    ads: current.advertising,
    contractors,
    topClients: [...clients].sort((a, b) => b.mrr - a.mrr),
    seoRevenue
  });
  const learnings: Learnings = computeLearnings({
    pnl: pnl.slice(0, month + 1) as unknown as PnlMonth[],
    fbRevenueByPeriod: fbRevenue,
    fbExpensesByPeriod: fbExpenses,
    softwareItems,
    mrrClients: clients
  });

  /* ── the one-paragraph read ─────────────────────────────────────────── */
  const verdict = (() => {
    if (!model.hasRevenue) {
      return `Facebook revenue was never entered for ${current.label}, so there is no margin to report on this side.`;
    }
    if (model.scoped) {
      const bits = [
        `<b>${model.scopeName}, ${current.label}.</b> ${compact(model.revenue)} in, ${compact(model.expenses)} out, ${compact(model.profit)} left at ${model.margin.toFixed(1)}%.`
      ];
      const commission = fbCommission[current.period];
      if (segment === "fb" && commission) {
        bits.push(`That is before the ${compact(commission)} commission, which takes it to ${compact(model.profit - commission)}.`);
      }
      if (segment === "seo") bits.push("Everything not tagged Facebook sits here, including delivery contractors and software.");
      return bits.join(" ");
    }
    const prev = month > 0 ? pnl[month - 1] : null;
    if (!prev) return `${current.label}: ${compact(current.income)} in, ${compact(current.expenses)} out.`;
    const revUp = ((current.income - prev.income) / prev.income) * 100;
    const expUp = ((current.expenses - prev.expenses) / prev.expenses) * 100;
    const first = pnl[0];
    const bits: string[] = [];
    if (revUp > 2 && model.prevMargin !== null && model.margin < model.prevMargin) {
      bits.push(`<b>Record revenue, and your thinnest margin in ${month + 1} months.</b> Revenue ${pct(revUp)} to ${compact(current.income)}, expenses ${pct(expUp)} to ${compact(current.expenses)} — so what is left barely moved.`);
    } else {
      bits.push(`<b>${current.label}:</b> ${compact(current.income)} in, ${compact(current.expenses)} out, ${compact(model.profit)} before your own pay.`);
    }
    if (first.software > 0 && first.income > 0) {
      bits.push(`Software is the engine: ${compact(current.software)}, ${pct(((current.software - first.software) / first.software) * 100)} since ${first.label}, now ${((current.software / current.income) * 100).toFixed(1)}% of every dollar you bill against ${((first.software / first.income) * 100).toFixed(1)}% then.`);
    }
    if (!model.onTrack) bits.push(`You are ${compact(model.gap)}/mo under the ${FLOOR}% floor.`);
    return bits.join(" ");
  })();

  const moves: string[] = (() => {
    const out: string[] = [];
    if (!model.hasRevenue) return [`Enter the Facebook revenue for ${current.label} so this side can be measured.`];
    if (!model.onTrack && defense.cutLadder.length) {
      const first = defense.cutLadder[0];
      out.push(`Close ${money(model.gap)}/mo. ${first.label} alone (${money(first.monthly)}) covers it.`);
    }
    const back = findings.find((f) => f.kind === "Back on the books");
    if (back) out.push(`Account for ${back.account} at ${money(back.amount)} — it was at zero last month.`);
    const drift = findings.find((f) => f.kind === "Creeping up" && f.severity === "high");
    if (drift) out.push(`${drift.headline}. Audit it line by line before it compounds again.`);
    return out.slice(0, 3);
  })();

  /* ── expenses ───────────────────────────────────────────────────────── */
  const rows = Object.entries(matrices.expenses)
    .filter(([a]) => segment === "all" || segmentOf(a, tags) === (segment as "fb" | "seo"))
    .map(([a, v]) => ({ account: a, current: v[month] ?? 0, previous: month > 0 ? v[month - 1] ?? 0 : 0, series: v }))
    .filter((r) => r.current > 0 || r.previous > 0);
  const expenseTotal = rows.reduce((t, r) => t + r.current, 0) || 1;

  const sections = [
    { id: "s-read", label: "The read" },
    { id: "s-score", label: "Scoreboard" },
    { id: "s-attention", label: "Worth a look" },
    { id: "s-expenses", label: "Where money goes" },
    { id: "s-ask", label: "Ask your finances" },
    { id: "s-sides", label: "FB vs SEO" },
    { id: "s-cut", label: "If you need to cut" },
    { id: "s-outlook", label: "Outlook & risks" }
  ];

  const scoreTiles = [
    { label: "Revenue", series: model.series.revenue, up: true, isPct: false },
    { label: "Costs", series: model.series.expenses as (number | null)[], up: false, isPct: false },
    { label: "Left", series: model.series.profit, up: true, isPct: false },
    {
      label: "Margin", up: true, isPct: true,
      series: model.series.revenue.map((r, i) =>
        r === null || !r ? null : ((model.series.profit[i] as number) / r) * 100)
    }
  ];

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_200px] gap-5 items-start text-slate-900">
      <div className="min-w-0 space-y-5">

        {/* ── command bar: one period control for the whole page ── */}
        <div
          className="sticky z-20 -mx-1 px-1 pt-1 pb-2"
          style={{ top: 68, background: "linear-gradient(#F8FAFC 72%, rgba(248,250,252,0))" }}
        >
          <div className="card px-3 py-2.5 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1 relative">
              <button
                type="button" aria-label="Previous month" disabled={month === 0}
                onClick={() => setMonth((m) => Math.max(0, m - 1))}
                className="w-9 h-9 grid place-items-center rounded-full border border-border bg-surface hover:bg-surface2 disabled:opacity-35 disabled:pointer-events-none transition-colors"
              ><ChevronLeft className="w-4 h-4 text-muted" /></button>

              <button
                type="button" aria-haspopup="true" aria-expanded={monthOpen}
                onClick={() => setMonthOpen((o) => !o)}
                className="px-3 h-9 rounded-xl border border-border bg-surface hover:bg-surface2 transition-colors flex items-center gap-2"
              >
                <span className="text-[15px] font-semibold">{current.label}</span>
                <ChevronDown className="w-3.5 h-3.5 text-muted" />
              </button>

              <button
                type="button" aria-label="Next month" disabled={month === pnl.length - 1}
                onClick={() => setMonth((m) => Math.min(pnl.length - 1, m + 1))}
                className="w-9 h-9 grid place-items-center rounded-full border border-border bg-surface hover:bg-surface2 disabled:opacity-35 disabled:pointer-events-none transition-colors"
              ><ChevronRight className="w-4 h-4 text-muted" /></button>

              {monthOpen && (
                <div className="card absolute left-0 top-full mt-1 w-[320px] p-2 z-40">
                  <div className="px-1 pb-1.5 text-[10px] uppercase tracking-widest text-muted font-semibold">
                    Pick a month &middot; bar is what was left
                  </div>
                  <div className="grid grid-cols-5 gap-1">
                    {pnl.map((p, i) => {
                      const norm = p.net + p.taxes + p.writeoffs + founderPayAt(matrices, i);
                      const peak = Math.max(
                        ...pnl.map((q, j) => q.net + q.taxes + q.writeoffs + founderPayAt(matrices, j)), 1
                      );
                      const height = Math.max(2, Math.round((Math.max(0, norm) / peak) * 16));
                      return (
                        <button
                          key={p.period} type="button"
                          onClick={() => { setMonth(i); setMonthOpen(false); }}
                          className={cn("px-1 pt-1.5 pb-1 rounded-lg text-center transition-colors",
                            i === month ? "bg-accent text-white" : "hover:bg-surface2")}
                        >
                          <span className="block text-[10.5px] font-medium leading-tight">{p.label.split(" ")[0]}</span>
                          <span className={cn("block text-[8.5px] leading-tight mb-1", i === month ? "text-blue-100" : "text-muted")}>
                            {p.label.split(" ")[1]}
                          </span>
                          <span className="block w-full h-4 relative">
                            <span className="absolute bottom-0 inset-x-0 rounded-t-[2px]" style={{ height, background: "#6E93BF" }} />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="h-6 w-px bg-border hidden sm:block" />

            <div className="flex items-center gap-0.5 rounded-full bg-surface2 p-0.5" role="radiogroup" aria-label="Business segment">
              {([["all", "Whole business"], ["seo", "SEO & web"], ["fb", "Facebook"]] as const).map(([value, label]) => (
                <button
                  key={value} type="button" role="radio" aria-checked={segment === value}
                  onClick={() => setSegment(value)}
                  className={cn("px-3 py-1 rounded-full text-[12px] font-medium transition-colors",
                    segment === value ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink")}
                >{label}</button>
              ))}
            </div>

            <div className="ml-auto flex items-center gap-2 text-[11px] text-muted">
              {model.scoped && (
                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-accent/25 bg-accent/5 text-accent font-medium">
                  <Filter className="w-3 h-3" />Filtered
                </span>
              )}
              <span className="hidden sm:inline-flex items-center gap-1">
                <Database className="w-3 h-3" />Books through {current.label}
              </span>
              <div className="relative">
                <button
                  type="button" aria-haspopup="true" aria-expanded={manageOpen}
                  onClick={() => setManageOpen((o) => !o)}
                  className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-xl border border-border bg-surface hover:bg-surface2 transition-colors text-[12px] font-medium text-ink"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5 text-muted" />Manage
                  <ChevronDown className="w-3 h-3 text-muted" />
                </button>
                {manageOpen && (
                  <div className="card absolute right-0 top-full mt-1 w-[300px] p-1.5 z-40">
                    <div className="px-2 pt-1 pb-1.5 text-[10px] uppercase tracking-widest text-muted font-semibold">
                      Enter &amp; correct numbers
                    </div>
                    {panels.map((p) => (
                      <button
                        key={p.key} type="button"
                        onClick={() => { setPanel(p.key); setAccount(null); setManageOpen(false); }}
                        className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-surface2 transition-colors flex items-center gap-2"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12.5px] font-medium truncate">{p.label}</span>
                          <span className="block text-[11px] text-muted truncate">{p.hint}</span>
                        </span>
                        <ChevronRight className="w-3 h-3 text-muted shrink-0" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── the read ── */}
        <section id="s-read" className="rounded-2xl p-6 text-white shadow-lift" style={{ background: "#0F172A" }}>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">
                The read &middot; {current.label} &middot; {model.scopeName}
              </div>
              {model.hasRevenue ? (
                <>
                  <div className="flex items-end gap-3 mt-1.5 flex-wrap">
                    <span className="text-[52px] leading-none font-semibold tracking-tight">
                      {model.margin.toFixed(1)}<span className="text-[28px] text-slate-400">%</span>
                    </span>
                    <span className={cn("pb-2 text-[12px] font-medium flex items-center gap-1.5", model.onTrack ? "text-emerald-300" : "text-rose-300")}>
                      {model.onTrack ? <Check className="w-3.5 h-3.5" /> : <TriangleAlert className="w-3.5 h-3.5" />}
                      {model.onTrack ? `above the ${FLOOR}% floor` : `${money(model.gap)}/mo below the ${FLOOR}% floor`}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {model.founderPay > 0 ? `before your own pay (${money(model.founderPay)} added back) · ` : ""}
                    {money(model.profit)} on {money(model.revenue)}
                  </div>
                </>
              ) : (
                <>
                  <div className="mt-2 text-[15px] text-slate-300">No Facebook revenue recorded for {current.label}.</div>
                  <div className="text-[11px] text-slate-400 mt-1">Costs are tagged automatically; revenue is entered by hand.</div>
                </>
              )}
            </div>
            <div className="flex gap-2 flex-wrap">
              {(model.hasRevenue
                ? ([["Revenue", model.revenue], ["Costs", model.expenses], ["Left", model.profit]] as const)
                : ([["Costs", model.expenses]] as const)
              ).map(([label, value]) => (
                <div key={label} className="rounded-xl bg-white/5 border border-white/10 px-3 py-2 min-w-[84px]">
                  <div className="text-[9.5px] uppercase tracking-wider text-slate-400">{label}</div>
                  <div className="text-[15px] font-semibold tabular-nums mt-0.5">{compact(value)}</div>
                </div>
              ))}
            </div>
          </div>

          <p
            className="text-[14.5px] leading-relaxed mt-4 text-slate-100 max-w-[74ch]"
            dangerouslySetInnerHTML={{ __html: verdict }}
          />

          {moves.length > 0 && (
            <div className="mt-4 pt-4 border-t border-white/10">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 mb-2">Do these three things</div>
              <ol className="space-y-1.5">
                {moves.map((m, i) => (
                  <li key={i} className="flex gap-2.5 text-[13px] text-slate-200">
                    <span className="w-4 shrink-0 text-slate-500 tabular-nums">{i + 1}.</span><span>{m}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>

        {/* ── scoreboard ── */}
        <section id="s-score" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {scoreTiles.map((tile) => {
            const value = tile.series[month];
            const previous = month > 0 ? tile.series[month - 1] : null;
            const known = tile.series.filter((v) => v !== null && v !== undefined);
            const delta =
              value === null || value === undefined || previous === null || previous === undefined || !previous
                ? null
                : tile.isPct ? value - previous : ((value - previous) / Math.abs(previous)) * 100;
            const good = delta === null ? true : delta >= 0 === tile.up;
            return (
              <div key={tile.label} className="card p-4">
                <div className="text-[11px] text-muted">{tile.label}</div>
                <div className="text-[24px] font-semibold tracking-tight mt-0.5">
                  {value === null || value === undefined
                    ? <span className="text-muted text-[17px]">not recorded</span>
                    : tile.isPct ? `${value.toFixed(1)}%` : compact(value)}
                </div>
                {delta === null ? (
                  <div className="text-[11.5px] text-muted mt-0.5">
                    {known.length < 2 ? `${known.length} month on file` : "no prior month"}
                  </div>
                ) : (
                  <div className="text-[11.5px] font-medium mt-0.5 flex items-center gap-1" style={{ color: good ? "#16A34A" : "#DC2626" }}>
                    {delta >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                    {tile.isPct ? `${pct(delta).replace("%", "")} pts` : pct(delta)}
                    <span className="text-muted font-normal">vs {labels[month - 1]}</span>
                  </div>
                )}
                <div className="mt-2">
                  {known.length >= 2 ? <Spark values={tile.series} at={month} good={good} /> : <div className="h-[26px]" />}
                </div>
              </div>
            );
          })}
        </section>

        {/* ── worth a look ── */}
        <section id="s-attention" className="card overflow-hidden">
          <div className="px-4 pt-4 pb-2">
            <h2 className="text-[15px] font-semibold flex items-center gap-2">
              <Flag className="w-4 h-4 text-accent" />Worth a look
            </h2>
            <p className="text-[11.5px] text-muted mt-0.5">
              {findings.length} thing{findings.length === 1 ? "" : "s"} the numbers flagged in {current.label}. Click one to open it.
            </p>
          </div>
          <div className="px-4 pb-4 grid md:grid-cols-2 gap-2.5">
            {findings.length === 0 ? (
              <div className="text-[13px] text-muted py-2">
                {month === 0
                  ? "Every detector compares against earlier months, and this is the first on file."
                  : "Nothing tripped a detector this month."}
              </div>
            ) : findings.slice(0, 4).map((f, i) => (
              <FindingCard
                key={i} finding={f}
                onOpen={() => {
                  if (f.panel) { setPanel(f.panel); setAccount(null); }
                  else if (f.account) { setAccount(f.account); setPanel(null); }
                }}
              />
            ))}
          </div>
        </section>

        {/* ── where the money goes ── */}
        <section id="s-expenses" className="card overflow-hidden">
          <div className="px-4 pt-4 pb-3 flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <h2 className="text-[16px] font-semibold flex items-center gap-2">
                <Receipt className="w-4 h-4 text-accent" />Where the money goes
              </h2>
              <p className="text-[11.5px] text-muted mt-0.5">
                {money(expenseTotal)} in {current.label}. Click any account to open it.
              </p>
            </div>
            {month > 0 && (
              <div className="flex items-center gap-0.5 rounded-full bg-surface2 p-0.5">
                {([["size", "Biggest"], ["change", "What changed"]] as const).map(([value, label]) => (
                  <button
                    key={value} type="button" onClick={() => setSort(value)}
                    className={cn("px-3 py-1 rounded-full text-[12px] font-medium transition-colors",
                      sort === value ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink")}
                  >{label}</button>
                ))}
              </div>
            )}
          </div>

          <div className="px-4">
            {sort === "change" && month > 0
              ? <ChangeList rows={rows} previousLabel={labels[month - 1]} onOpen={setAccount} />
              : <SizeList rows={rows} total={expenseTotal} onOpen={setAccount} />}
          </div>

          <div className="px-4 py-3">
            <button
              type="button" onClick={() => setShowAll((v) => !v)}
              className="text-[12px] text-muted hover:text-accent inline-flex items-center gap-1.5 transition-colors"
            >
              {showAll ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              {showAll ? "Hide the full list" : `Show all ${rows.length} accounts`}
            </button>
            {showAll && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-[12px] min-w-[560px]">
                  <thead>
                    <tr className="text-muted text-[10px] uppercase tracking-wider">
                      <th className="text-left font-semibold py-1.5">Account</th>
                      <th className="text-left font-semibold py-1.5">Side</th>
                      <th className="text-right font-semibold py-1.5">{labels[month - 1] ?? "—"}</th>
                      <th className="text-right font-semibold py-1.5">{current.label}</th>
                      <th className="text-right font-semibold py-1.5">Change</th>
                      <th className="text-right font-semibold py-1.5">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...rows].sort((a, b) => b.current - a.current).map((r) => {
                      const g = r.previous > 0 ? ((r.current - r.previous) / r.previous) * 100 : null;
                      return (
                        <tr key={r.account} className="border-t border-border hover:bg-bg">
                          <td className="py-1.5">
                            <button type="button" className="hover:text-accent hover:underline text-left" onClick={() => setAccount(r.account)}>
                              {r.account}
                            </button>
                          </td>
                          <td className="py-1.5 text-muted">{segmentOf(r.account, tags) === "fb" ? "Facebook" : "SEO & web"}</td>
                          <td className="py-1.5 text-right tabular-nums text-muted">{r.previous ? money(r.previous) : "—"}</td>
                          <td className="py-1.5 text-right tabular-nums font-semibold">{r.current ? money(r.current) : "—"}</td>
                          <td className="py-1.5 text-right tabular-nums" style={{ color: g === null ? "#64748B" : g > 8 ? "#DC2626" : g < -8 ? "#16A34A" : "#64748B" }}>
                            {g === null ? (r.current ? "new" : "stopped") : pct(g)}
                          </td>
                          <td className="py-1.5 text-right tabular-nums text-muted">{((r.current / expenseTotal) * 100).toFixed(1)}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {/* ── ask your finances: the existing card, untouched ── */}
        <div id="s-ask">{chat}</div>

        <SidesCard
          month={month} current={current} matrices={matrices} tags={tags}
          fbRevenue={fbRevenue} fbExpenses={fbExpenses} fbCommission={fbCommission}
        />

        {model.hasRevenue && <CutCard defense={defense} gap={model.gap} onTrack={model.onTrack} />}

        <OutlookCard learnings={learnings} />
      </div>

      {/* ── jump rail ── */}
      <aside className="hidden xl:block sticky top-[84px]">
        <div className="card overflow-hidden">
          <div className="px-4 pt-3.5 pb-2">
            <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-widest font-semibold text-muted">
              <Compass className="w-3 h-3" />Jump to
            </span>
          </div>
          <div className="px-2 pb-3 space-y-0.5">
            {sections.map((s) => (
              <a key={s.id} href={`#${s.id}`}
                 className="block px-2.5 py-1.5 rounded-lg text-[11.5px] text-muted hover:bg-surface2 hover:text-ink transition-colors">
                {s.label}
              </a>
            ))}
          </div>
        </div>
      </aside>

      {/* ── side sheet: an account, or one of the editor panels ── */}
      {(account || panel) && (
        <div className="fixed inset-0 z-[70]">
          <div className="absolute inset-0 bg-slate-900/40" onClick={closeSheet} />
          <div className="absolute right-0 top-0 h-full w-full max-w-[560px] bg-surface border-l border-border shadow-lift overflow-auto">
            <div className="sticky top-0 bg-surface/95 backdrop-blur border-b border-border px-5 py-3.5 flex items-start gap-3 z-10">
              <div className="min-w-0 flex-1">
                <div className="text-[10px] uppercase tracking-widest text-muted font-semibold">
                  {account ? `${segmentOf(account, tags) === "fb" ? "Facebook" : "SEO & web"} · account` : "Manage"}
                </div>
                <h2 className="text-[17px] font-semibold leading-tight">
                  {account ?? panels.find((p) => p.key === panel)?.label}
                </h2>
              </div>
              <button type="button" onClick={closeSheet} aria-label="Close"
                      className="w-8 h-8 grid place-items-center rounded-full hover:bg-surface2 transition-colors shrink-0">
                <X className="w-4 h-4 text-muted" />
              </button>
            </div>
            <div className="p-5">
              {account
                ? <AccountDetail
                    account={account} matrices={matrices} labels={labels} month={month}
                    reveal={reveal} onReveal={() => setReveal((v) => !v)} />
                : panels.find((p) => p.key === panel)?.node}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════ */

function FindingCard({ finding, onOpen }: { finding: Finding; onOpen: () => void }) {
  const tone = {
    high: { border: "border-rose-200", bg: "bg-rose-50/60", fg: "text-rose-700", chip: "bg-rose-100 text-rose-700" },
    medium: { border: "border-amber-200", bg: "bg-amber-50/60", fg: "text-amber-700", chip: "bg-amber-100 text-amber-800" },
    info: { border: "border-slate-200", bg: "bg-slate-50", fg: "text-slate-600", chip: "bg-slate-200 text-slate-700" }
  }[finding.severity];
  const Icon = finding.severity === "high" ? TriangleAlert : finding.severity === "medium" ? TrendingUp : Info;
  return (
    <button type="button" onClick={onOpen}
            className={cn("text-left rounded-xl border p-3 hover:shadow-soft transition-shadow", tone.border, tone.bg)}>
      <div className="flex items-center gap-2 mb-1">
        <Icon className={cn("w-3.5 h-3.5", tone.fg)} />
        <span className={cn("text-[9.5px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full", tone.chip)}>
          {finding.kind}
        </span>
      </div>
      <div className="text-[13.5px] font-semibold leading-snug">{finding.headline}</div>
      <div className="text-[12px] text-muted mt-0.5 leading-snug">{finding.detail}</div>
    </button>
  );
}

interface Row { account: string; current: number; previous: number; series: number[] }

// Ordered by size. One colour for every bar — these are nominal categories, so
// a darker-where-bigger ramp would double-encode bar length as hue.
function SizeList({ rows, total, onOpen }: { rows: Row[]; total: number; onOpen: (a: string) => void }) {
  const sorted = [...rows].filter((r) => r.current > 0).sort((a, b) => b.current - a.current);
  const shown = sorted.slice(0, 10);
  const rest = sorted.slice(10);
  const max = shown[0]?.current || 1;
  const restTotal = rest.reduce((t, r) => t + r.current, 0);
  return (
    <div className="space-y-0.5">
      {shown.map((r) => {
        const g = r.previous > 0 ? ((r.current - r.previous) / r.previous) * 100 : null;
        return (
          <button key={r.account} type="button" onClick={() => onOpen(r.account)}
                  className="w-full text-left rounded-lg px-2 py-2 hover:bg-bg transition-colors">
            <div className="flex items-center gap-3">
              <span className="w-[118px] sm:w-[176px] shrink-0 text-[13px] truncate">{r.account}</span>
              <span className="flex-1 min-w-0 h-4 relative">
                <span className="absolute inset-y-0 left-0 rounded-r"
                      style={{ width: `${Math.max(1.2, (r.current / max) * 100)}%`, background: "#2F5C93" }} />
              </span>
              <span className="w-[72px] shrink-0 text-right text-[13px] font-semibold tabular-nums">{money(r.current)}</span>
              <span className="w-[50px] shrink-0 text-right text-[11.5px] tabular-nums"
                    style={{ color: g === null ? "#64748B" : g > 8 ? "#DC2626" : g < -8 ? "#16A34A" : "#64748B" }}>
                {g === null ? "new" : pct(g)}
              </span>
            </div>
          </button>
        );
      })}
      {rest.length > 0 && (
        <div className="flex items-center gap-3 px-2 py-2 border-t border-border mt-1 pt-2.5 text-muted">
          <span className="w-[118px] sm:w-[176px] shrink-0 text-[13px]">{rest.length} smaller</span>
          <span className="flex-1 min-w-0 h-4 relative">
            <span className="absolute inset-y-0 left-0 rounded-r"
                  style={{ width: `${Math.max(1.2, (restTotal / max) * 100)}%`, background: "#CBD5E1" }} />
          </span>
          <span className="w-[72px] shrink-0 text-right text-[13px] tabular-nums">{money(restTotal)}</span>
          <span className="w-[50px] shrink-0" />
        </div>
      )}
      <p className="text-[11px] text-muted pt-2 flex items-start gap-1.5">
        <CornerDownRight className="w-3 h-3 mt-0.5 shrink-0" />
        <span>Last column is the change on the prior month. Red is up, green is down &mdash; for expenses, down is the win.</span>
      </p>
    </div>
  );
}

// Ordered by what moved: the two numbers, and the difference. No chart needed.
function ChangeList({ rows, previousLabel, onOpen }: { rows: Row[]; previousLabel: string; onOpen: (a: string) => void }) {
  const movers = rows
    .filter((r) => r.previous > 0 && r.current > 0)
    .map((r) => ({ ...r, delta: r.current - r.previous }))
    .filter((r) => Math.abs(r.delta) >= 100)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 10);
  if (!movers.length) return <p className="text-[12.5px] text-muted py-4">Nothing moved by more than $100 this month.</p>;
  const up = movers.filter((r) => r.delta > 0).reduce((t, r) => t + r.delta, 0);
  const down = movers.filter((r) => r.delta < 0).reduce((t, r) => t + r.delta, 0);
  return (
    <>
      <p className="text-[12px] text-muted pb-1.5">
        Against {previousLabel}: {money(up)} added, {money(Math.abs(down))} saved.
      </p>
      <div className="space-y-0.5">
        {movers.map((r) => {
          const isUp = r.delta > 0;
          return (
            <button key={r.account} type="button" onClick={() => onOpen(r.account)}
                    className="w-full text-left rounded-lg px-2 py-2 hover:bg-bg transition-colors">
              <div className="flex items-center gap-3">
                <span className="w-[118px] sm:w-[176px] shrink-0 text-[13px] truncate">{r.account}</span>
                <span className="flex-1 min-w-0 text-[12.5px] text-muted tabular-nums truncate">
                  {money(r.previous)} &rarr; <span className="text-ink font-medium">{money(r.current)}</span>
                </span>
                <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[12px] font-semibold tabular-nums"
                      style={{ color: isUp ? "#DC2626" : "#16A34A", background: isUp ? "rgba(220,38,38,.08)" : "rgba(22,163,74,.08)" }}>
                  {isUp ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
                  {money(Math.abs(r.delta))}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

function SidesCard({ month, current, matrices, tags, fbRevenue, fbExpenses, fbCommission }: {
  month: number; current: RoomMonth; matrices: Matrices; tags: Record<string, "seo" | "facebook">;
  fbRevenue: Record<string, number>; fbExpenses: Record<string, number>; fbCommission: Record<string, number>;
}) {
  const fbCost = expensesAt(matrices, month, tags, "fb");
  const seoCost = expensesAt(matrices, month, tags, "seo");
  const allCost = fbCost + seoCost || 1;
  const fbRev = fbRevenue[current.period] ?? null;
  const seoRev = current.income - (fbRev ?? 0);
  const booked = fbExpenses[current.period];
  const commission = fbCommission[current.period];

  const Side = ({ name, color, revenue, cost, note }: {
    name: string; color: string; revenue: number | null; cost: number; note: string;
  }) => (
    <div className="rounded-xl border border-border p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: color }} />
        <span className="text-[13px] font-semibold flex-1">{name}</span>
        <span className="text-[11px] text-muted">{((cost / allCost) * 100).toFixed(0)}% of costs</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        {([["In", revenue], ["Out", cost], ["Left", revenue === null ? null : revenue - cost]] as const).map(([l, v]) => (
          <div key={l}>
            <div className="text-[9.5px] uppercase tracking-wider text-muted">{l}</div>
            <div className="text-[14px] font-semibold tabular-nums mt-0.5">
              {v === null ? <span className="text-muted text-[12px]">&mdash;</span> : money(v)}
            </div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted mt-2 pt-2 border-t border-border">{note}</p>
    </div>
  );

  return (
    <section id="s-sides" className="card p-4">
      <h2 className="text-[15px] font-semibold flex items-center gap-2 mb-1">
        <Split className="w-4 h-4 text-accent" />Two businesses, one P&amp;L
      </h2>
      <p className="text-[11.5px] text-muted mb-3">
        Costs split by the tags in expense_segments. Facebook revenue is entered by hand each month.
      </p>
      <div className="grid sm:grid-cols-2 gap-3">
        <Side name="SEO & web" color="#1F5490" revenue={seoRev} cost={seoCost}
              note="Everything not tagged Facebook, including delivery contractors and software." />
        <Side name="Facebook" color="#D946EF" revenue={fbRev} cost={fbCost}
              note={fbRev === null
                ? `No revenue entered for ${current.label}, so this side cannot be measured.`
                : `${booked ? `Books show ${money(booked)} of cost against ${money(fbCost)} tagged — a ${money(Math.abs(booked - fbCost))} gap to reconcile. ` : ""}${commission ? `Commission of ${money(commission)} comes out of what is left.` : ""}`} />
      </div>
    </section>
  );
}

function CutCard({ defense, gap, onTrack }: { defense: Defense; gap: number; onTrack: boolean }) {
  let running = 0;
  return (
    <section id="s-cut" className="card p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <h2 className="text-[15px] font-semibold flex items-center gap-2">
            <Shield className="w-4 h-4 text-accent" />If you need to cut
          </h2>
          <p className="text-[11.5px] text-muted mt-0.5">
            {onTrack
              ? "You are above the floor. This is the order to cut in if that changes."
              : `You are ${money(gap)}/mo under the floor. Cutting from the top in order closes it.`}
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] uppercase tracking-wider text-muted">Available to cut</div>
          <div className="text-[17px] font-semibold tabular-nums">{money(defense.cutCapacity)}</div>
        </div>
      </div>

      <div className="space-y-0.5">
        {defense.cutLadder.slice(0, 7).map((lever, i) => {
          running += lever.monthly;
          const closes = !onTrack && running >= gap && running - lever.monthly < gap;
          return (
            <div key={`${lever.label}-${i}`}
                 className={cn("flex items-center gap-3 px-2 py-1.5 rounded-lg", closes && "bg-emerald-50 border border-emerald-200")}>
              <span className="w-4 shrink-0 text-[11px] text-muted tabular-nums">{i + 1}</span>
              <span className="flex-1 min-w-0 text-[13px] truncate">{lever.label}</span>
              {closes && <span className="text-[9.5px] font-semibold text-emerald-700 uppercase tracking-wider shrink-0">closes the gap</span>}
              <span className="text-[11px] text-muted tabular-nums shrink-0 w-[76px] text-right">{money(running)} so far</span>
              <span className="text-[13px] font-semibold tabular-nums shrink-0 w-[66px] text-right">{money(lever.monthly)}</span>
            </div>
          );
        })}
        {defense.cutLadder.length > 7 && (
          <div className="px-2 pt-1.5 text-[11px] text-muted">+ {defense.cutLadder.length - 7} smaller contractors below this</div>
        )}
      </div>

      {defense.protected.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border">
          <div className="flex items-center gap-2 mb-1.5">
            <Lock className="w-3.5 h-3.5 text-muted" />
            <span className="text-[12px] font-medium">Never cut &middot; {money(defense.protectedTotal)}/mo</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {defense.protected.map((p) => (
              <span key={p.name} className="px-2 py-0.5 rounded-full bg-surface2 border border-border text-[11px]">
                {p.name} &middot; {money(p.monthly)}
              </span>
            ))}
          </div>
          <p className="text-[11px] text-muted mt-2">
            They are on revenue share, so their cost falls by itself when revenue does. Cutting them buys nothing.
          </p>
        </div>
      )}

      {defense.scenarios.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border">
          <div className="text-[12px] font-medium mb-2 flex items-center gap-2">
            <UserMinus className="w-3.5 h-3.5 text-muted" />If you lost one of the big three
          </div>
          <div className="grid sm:grid-cols-3 gap-2">
            {defense.scenarios.map((s) => {
              const bad = s.newMarginPct < defense.floorPct;
              return (
                <div key={s.client} className={cn("rounded-xl border p-2.5", bad ? "border-rose-200 bg-rose-50/50" : "border-emerald-200 bg-emerald-50/50")}>
                  <div className="text-[12px] font-medium truncate">{s.client}</div>
                  <div className="text-[10.5px] text-muted">&minus;{money(s.lostMrr)}/mo of revenue</div>
                  <div className="text-[17px] font-semibold tabular-nums mt-1" style={{ color: bad ? "#DC2626" : "#16A34A" }}>
                    {s.newMarginPct.toFixed(1)}%
                  </div>
                  <div className="text-[10.5px] text-muted mt-0.5">
                    {s.cutNeeded > 0 ? `cut ${money(s.cutNeeded)} to recover` : "still above the floor"}
                  </div>
                  {s.covered.length > 0 && (
                    <div className="text-[10px] text-muted mt-1 pt-1 border-t border-border truncate">{s.covered.slice(0, 2).join(", ")}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function OutlookCard({ learnings }: { learnings: Learnings }) {
  if (!learnings.hasData) return null;
  const tone: Record<string, string[]> = {
    high: ["border-rose-200", "bg-rose-50/50", "#DC2626"],
    medium: ["border-amber-200", "bg-amber-50/50", "#D97706"],
    low: ["border-slate-200", "bg-slate-50", "#64748B"]
  };
  return (
    <section id="s-outlook" className="card p-4">
      <h2 className="text-[15px] font-semibold flex items-center gap-2 mb-3">
        <Telescope className="w-4 h-4 text-accent" />Outlook &amp; risks
      </h2>
      <div className="grid lg:grid-cols-2 gap-4">
        <div>
          <div className="grid grid-cols-3 gap-2 mb-2.5">
            {[
              ["Annual run rate", compact(learnings.projection.annualRunRate)],
              ["Margin now", `${learnings.marginNow.toFixed(1)}%`],
              ["Margin peak", `${learnings.marginPeak.toFixed(1)}%`]
            ].map(([l, v]) => (
              <div key={l} className="rounded-xl border border-border p-2.5">
                <div className="text-[10px] text-muted">{l}</div>
                <div className="text-[13.5px] font-semibold tabular-nums mt-0.5">{v}</div>
              </div>
            ))}
          </div>
          <div className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-1.5">If nothing changes</div>
          <div className="space-y-0.5">
            {learnings.projection.months.map((m) => (
              <div key={m.label} className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-bg">
                <span className="w-[56px] shrink-0 text-[12px] text-muted">{m.label}</span>
                <span className="flex-1 text-[12.5px] tabular-nums text-muted">{money(m.revenue)} in</span>
                <span className="text-[12.5px] font-semibold tabular-nums" style={{ color: m.net < 0 ? "#DC2626" : undefined }}>
                  {money(m.net)} left
                </span>
              </div>
            ))}
          </div>
          {learnings.projection.softwareDragPerMo > 0 && (
            <p className="text-[11px] text-muted mt-2">
              Software keeps climbing at about {money(learnings.projection.softwareDragPerMo)}/mo in this projection.
            </p>
          )}
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-1.5">What could break</div>
          <div className="space-y-1.5">
            {learnings.risks.slice(0, 4).map((r) => {
              const t = tone[r.severity] ?? tone.medium;
              return (
                <div key={r.title} className={cn("rounded-xl border p-2.5", t[0], t[1])}>
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: t[2] }} />
                    <span className="text-[12.5px] font-semibold">{r.title}</span>
                  </div>
                  <div className="text-[11.5px] text-muted mt-0.5 leading-snug">{r.detail}</div>
                  <div className="text-[11.5px] mt-1 leading-snug"><b>Do:</b> {r.mitigation}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

/** One expense account: every month on file, plus per-person detail for contractors. */
function AccountDetail({ account, matrices, labels, month, reveal, onReveal }: {
  account: string; matrices: Matrices; labels: string[]; month: number;
  reveal: boolean; onReveal: () => void;
}) {
  const series = matrices.expenses[account] ?? [];
  const current = series[month] ?? 0;
  const previous = month > 0 ? series[month - 1] ?? 0 : 0;
  const max = Math.max(...series, 1);
  const history = series.filter((x) => x > 0);
  const average = history.length ? history.reduce((t, x) => t + x, 0) / history.length : 0;
  const isContractors = account.toLowerCase().includes("contractor");
  const people = isContractors
    ? Object.entries(matrices.people)
        .map(([n, v]) => ({ name: n, amount: v[month] ?? 0 }))
        .filter((p) => p.amount > 0)
        .sort((a, b) => b.amount - a.amount)
    : [];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-2">
        {([[labels[month], current], ["Average", average], ["Biggest month", max]] as const).map(([l, v]) => (
          <div key={l} className="rounded-xl border border-border p-2.5">
            <div className="text-[10px] text-muted">{l}</div>
            <div className="text-[15px] font-semibold tabular-nums mt-0.5">{money(v)}</div>
          </div>
        ))}
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-2">Every month on file</div>
        <div className="space-y-1">
          {series.map((v, i) => (
            <div key={i} className={cn("flex items-center gap-2", i === month && "font-semibold")}>
              <span className={cn("w-[52px] shrink-0 text-[11px]", i === month ? "text-ink" : "text-muted")}>{labels[i]}</span>
              <span className="flex-1 min-w-0 h-3.5 relative">
                {v > 0
                  ? <span className="absolute inset-y-0 left-0 rounded-r" style={{ width: `${Math.max(1, (v / max) * 100)}%`, background: i === month ? "#063270" : "#6E93BF" }} />
                  : <span className="absolute inset-x-0 top-1/2 border-b border-dashed border-border" />}
              </span>
              <span className="w-[72px] shrink-0 text-right text-[11.5px] tabular-nums">{v > 0 ? money(v) : "—"}</span>
            </div>
          ))}
        </div>
      </div>

      {isContractors && people.length > 0 && (
        <div>
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="text-[10px] uppercase tracking-widest text-muted font-semibold">Per person &middot; {labels[month]}</div>
            <button type="button" onClick={onReveal}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-border bg-surface text-[11px] hover:bg-surface2 transition-colors">
              {reveal ? "Hide" : "Show"} pay
            </button>
          </div>
          <div className="space-y-0.5">
            {people.map((p) => (
              <div key={p.name} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-bg">
                <span className="flex-1 truncate text-[12.5px]">{p.name}</span>
                <span className={cn("text-[12.5px] tabular-nums", reveal ? "font-semibold" : "text-transparent bg-slate-200 rounded select-none")}>
                  {reveal ? money(p.amount) : "••••••"}
                </span>
              </div>
            ))}
            <div className="flex items-center gap-2 px-2 py-1.5 border-t border-border mt-1 pt-2">
              <span className="flex-1 text-[12px] text-muted">Deel platform fees</span>
              <span className="text-[12.5px] tabular-nums">{money(matrices.fees[month] ?? 0)}</span>
            </div>
          </div>
          <p className="text-[11px] text-muted mt-2">
            Individual pay stays hidden until you ask for it, so the page is safe to share on a call. Totals are always visible.
          </p>
        </div>
      )}

      <div className="rounded-xl bg-surface2 border border-border p-3.5">
        <div className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-1.5">Read</div>
        <p className="text-[12.5px] leading-relaxed">
          {previous === 0 && current > 0
            ? `Nothing last month, ${money(current)} this month.`
            : previous > 0
              ? `${pct(((current - previous) / previous) * 100)} on ${labels[month - 1]} (${money(previous)} to ${money(current)}).`
              : `Nothing booked in ${labels[month]}.`}
          {current > average * 1.15 && ` That is ${money(current - average)} above its own average — genuinely high, not just a noisy month.`}
          {series[0] > 0 && current > 0 && ` Against ${labels[0]} it is ${pct(((current - series[0]) / series[0]) * 100)}.`}
        </p>
      </div>
    </div>
  );
}
