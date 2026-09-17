import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import type { ScaleKpi } from "@/lib/scale-actions";

// Clean KPI stat cards in the reference-dashboard style: muted label + trend
// chip, big bold number, a sub line, and a soft decorative sparkline. Scale
// metrics only (booked calls, pipeline, Meta leads/CTR) — no finance.

const HUE: Record<ScaleKpi["hue"], { num: string; spark: string }> = {
  indigo: { num: "text-indigo-700", spark: "#6366f1" },
  violet: { num: "text-violet-700", spark: "#8b5cf6" },
  sky: { num: "text-sky-700", spark: "#0ea5e9" },
  emerald: { num: "text-emerald-700", spark: "#10b981" },
  rose: { num: "text-rose-600", spark: "#f43f5e" },
  amber: { num: "text-amber-600", spark: "#f59e0b" }
};

// A soft rising/falling sparkline path — decorative, keyed to the trend
// direction so it reads consistently with the chip (up = rising line).
function sparkPath(up: boolean): string {
  return up
    ? "M2 26 C 14 24, 22 20, 34 16 S 58 8, 72 5"
    : "M2 6 C 14 8, 22 12, 34 16 S 58 24, 72 27";
}

function Card({ kpi }: { kpi: ScaleKpi }) {
  const h = HUE[kpi.hue];
  const up = kpi.delta ? kpi.delta.dir === "up" : true;
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-slate-500 truncate">{kpi.label}</span>
        {kpi.delta && (
          <span className={"inline-flex items-center gap-0.5 text-[11px] font-semibold rounded-full px-1.5 py-0.5 shrink-0 " + (kpi.delta.good ? "text-emerald-700 bg-emerald-50" : "text-rose-600 bg-rose-50")}>
            {kpi.delta.dir === "up" ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
            {kpi.delta.text}
          </span>
        )}
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className={"text-[26px] font-bold tabular-nums leading-none " + h.num}>{kpi.value}</div>
        <svg viewBox="0 0 74 32" className="w-16 h-7 shrink-0" fill="none" aria-hidden="true">
          <path d={sparkPath(up)} stroke={h.spark} strokeWidth="2" strokeLinecap="round" opacity="0.8" />
        </svg>
      </div>
      <div className="mt-1.5 text-[11px] text-slate-400">{kpi.sub}</div>
    </div>
  );
}

export function ScaleKpis({ kpis, stale }: { kpis: ScaleKpi[]; stale: boolean }) {
  return (
    <div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpis.map((k) => <Card key={k.label} kpi={k} />)}
      </div>
      {stale && <div className="text-[10px] text-slate-400 mt-1.5 px-1">Showing last good read — the ads dashboard is catching up.</div>}
    </div>
  );
}

export function ScaleKpisLoading() {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="h-3 w-20 bg-slate-100 rounded animate-pulse" />
          <div className="h-6 w-16 bg-slate-100 rounded animate-pulse mt-3" />
          <div className="h-2.5 w-24 bg-slate-100 rounded animate-pulse mt-3" />
        </div>
      ))}
    </div>
  );
}
