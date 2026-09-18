"use client";

import { useState } from "react";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import type { FinanceKpi } from "@/lib/finance-overview";

// The KPI row with a "This month / Est. month-end" toggle. The estimate projects
// the current (still-filling) month to month-end by daily run-rate, so the
// trend compares full-month vs full-month instead of a partial vs a complete
// prior month. Defaults to the estimate when the month is only partway through.

function money(n: number): string {
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

function sparkPath(series: number[], W = 76, H = 30): string {
  if (series.length < 2) return "";
  const min = Math.min(...series), max = Math.max(...series);
  const range = max - min || 1;
  const pad = 3;
  return series.map((v, i) => {
    const x = (i / (series.length - 1)) * W;
    const y = H - pad - ((v - min) / range) * (H - pad * 2);
    return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}

function KpiCard({ k, series }: { k: FinanceKpi; series: number[] }) {
  const up = (k.deltaPct ?? 0) >= 0;
  const good = k.deltaPct == null ? true : up === k.goodWhenUp;
  const stroke = k.deltaPct == null ? "#cbd5e1" : good ? "#16a34a" : "#ef4444";
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-slate-500 truncate">{k.label}</span>
        {k.deltaPct != null && (
          <span className={"inline-flex items-center gap-0.5 text-[12px] font-medium rounded-full px-2 py-0.5 " + (good ? "text-emerald-700 bg-emerald-50" : "text-rose-600 bg-rose-50")}>
            {up ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
            {Math.abs(k.deltaPct)}{k.isPct ? " pts" : "%"}
          </span>
        )}
      </div>
      <div className="mt-3 flex items-end justify-between gap-2">
        <div className="text-[28px] font-bold tabular-nums leading-none text-slate-900">{k.isPct ? `${k.value}%` : money(k.value)}</div>
        {series.length >= 2 && (
          <svg viewBox="0 0 76 30" className="w-[76px] h-[30px] shrink-0" fill="none" aria-hidden="true">
            <path d={sparkPath(series)} stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
          </svg>
        )}
      </div>
    </div>
  );
}

export function FinanceKpiCards({ actual, estimated, series, partial, estLabel = "Est. month-end" }: {
  actual: FinanceKpi[];
  estimated: FinanceKpi[];
  series: Record<string, number[]>;
  partial: boolean;
  estLabel?: string;
}) {
  const [mode, setMode] = useState<"actual" | "est">(partial ? "est" : "actual");
  const kpis = mode === "est" && partial ? estimated : actual;
  const sub = mode === "est" && partial ? estLabel.replace(/^Est\. /, "estimated ") : "actual, latest month";

  return (
    <div>
      {partial && (
        <div className="flex items-center gap-1 mb-3 rounded-lg bg-slate-100 p-0.5 w-fit">
          {(["est", "actual"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)}
              className={"text-[12px] font-medium rounded-md px-3 py-1.5 transition-colors " + (mode === m ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800")}>
              {m === "est" ? estLabel : "Latest actual"}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map((k) => (
          <div key={k.label}>
            <KpiCard k={k} series={series[k.label] ?? []} />
            <div className="text-[12px] text-slate-400 mt-1.5 px-1">{sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
