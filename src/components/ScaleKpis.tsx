import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import type { ScaleKpi } from "@/lib/scale-actions";

// Clean KPI stat cards in the reference-dashboard style: muted label + trend
// chip, big bold number, a sub line, and a soft decorative sparkline. Scale
// metrics only (booked calls, pipeline, Meta leads/CTR) — no finance.

// A soft rising/falling sparkline path — decorative, keyed to the trend
// direction so it reads consistently with the chip (up = rising line).
function sparkPath(up: boolean): string {
  return up
    ? "M2 26 C 14 24, 22 20, 34 16 S 58 8, 72 5"
    : "M2 6 C 14 8, 22 12, 34 16 S 58 24, 72 27";
}

function Card({ kpi }: { kpi: ScaleKpi }) {
  const up = kpi.delta ? kpi.delta.dir === "up" : true;
  // Monochrome by default; a single subtle green/red only when there's a real trend.
  const spark = kpi.delta ? (kpi.delta.good ? "#10b981" : "#f43f5e") : "#cbd5e1";
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-slate-500 truncate">{kpi.label}</span>
        {kpi.delta && (
          <span className={"inline-flex items-center gap-0.5 text-[11px] font-medium rounded-md px-1.5 py-0.5 shrink-0 " + (kpi.delta.good ? "text-emerald-600" : "text-rose-500")}>
            {kpi.delta.dir === "up" ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
            {kpi.delta.text}
          </span>
        )}
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="text-[26px] font-bold tabular-nums leading-none text-slate-900">{kpi.value}</div>
        <svg viewBox="0 0 74 32" className="w-16 h-7 shrink-0" fill="none" aria-hidden="true">
          <path d={sparkPath(up)} stroke={spark} strokeWidth="2" strokeLinecap="round" opacity="0.9" />
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
        <div key={i} className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="h-3 w-20 bg-slate-100 rounded animate-pulse" />
          <div className="h-6 w-16 bg-slate-100 rounded animate-pulse mt-3" />
          <div className="h-2.5 w-24 bg-slate-100 rounded animate-pulse mt-3" />
        </div>
      ))}
    </div>
  );
}
