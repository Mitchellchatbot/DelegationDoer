"use client";

import { useMemo, useState } from "react";
import { TrendingUp, TrendingDown } from "lucide-react";

// Vendor-level breakdown of the Software/Subscriptions expense lump (which the
// P&L shows as one line). Seeded from the QuickBooks software transaction
// report. Sorted by the latest month so the biggest tools to cut are on top.

export interface SoftwareRow {
  vendor: string;
  month: string;
  amount: number;
}

function money(n: number): string {
  if (!n) return "$0";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

// Order months newest-first for display. Known short names first, then anything
// else alphabetically as a fallback.
const MONTH_ORDER = ["Aug", "July", "June", "Jun", "May", "Apr", "Mar", "Feb", "Jan", "Dec", "Nov", "Oct", "Sep"];
function orderMonths(ms: string[]): string[] {
  return [...ms].sort((a, b) => {
    const ia = MONTH_ORDER.indexOf(a), ib = MONTH_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
}

export function SoftwareBreakdown({ rows }: { rows: SoftwareRow[] }) {
  const [showAll, setShowAll] = useState(false);

  const { vendors, months, totals } = useMemo(() => {
    const monthSet = new Set<string>();
    const byVendor = new Map<string, Record<string, number>>();
    for (const r of rows) {
      monthSet.add(r.month);
      const v = byVendor.get(r.vendor) ?? {};
      v[r.month] = (v[r.month] ?? 0) + Number(r.amount);
      byVendor.set(r.vendor, v);
    }
    const months = orderMonths([...monthSet]);
    const latest = months[0];
    const vendors = [...byVendor.entries()]
      .map(([vendor, m]) => ({ vendor, m, latest: m[latest] ?? 0 }))
      .sort((a, b) => b.latest - a.latest);
    const totals: Record<string, number> = {};
    for (const m of months) totals[m] = vendors.reduce((s, v) => s + (v.m[m] ?? 0), 0);
    return { vendors, months, totals };
  }, [rows]);

  if (!rows.length) return null;
  const latest = months[0];
  const prev = months[1];
  const shown = showAll ? vendors : vendors.slice(0, 12);

  const trend = (m: Record<string, number>) => {
    if (!prev) return null;
    const a = m[latest] ?? 0, b = m[prev] ?? 0;
    if (Math.abs(a - b) < 25) return null;
    if (b === 0) return a > 25 ? "up" : null;
    if (a / b >= 1.25) return "up";
    if (a / b <= 0.75) return "down";
    return null;
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
      <div className="flex items-baseline justify-between gap-2 mb-3 flex-wrap">
        <div>
          <div className="text-[13px] font-semibold text-ink">Software subscriptions · by vendor</div>
          <div className="text-[11px] text-muted mt-0.5">
            The Software/Subscriptions line, itemized. <span className="text-rose-500">▲ rising</span> = cut candidate.
          </div>
        </div>
        <div className="text-[11px] text-muted tabular-nums">{vendors.length} tools · {money(totals[latest])}/{latest}</div>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[360px]">
          <div className="flex items-center gap-2 pb-1.5 mb-1 border-b border-slate-200 text-[10px] font-medium text-muted uppercase tracking-wide">
            <span className="flex-1">Vendor</span>
            {months.map((m, i) => (
              <span key={m} className={"w-[68px] text-right shrink-0 " + (i === 0 ? "text-ink" : "")}>{m}</span>
            ))}
            <span className="w-3.5 shrink-0" />
          </div>
          <div className="space-y-0.5">
            {shown.map((v) => {
              const t = trend(v.m);
              return (
                <div key={v.vendor} className="flex items-center gap-2 py-0.5 text-[12px] border-b border-slate-50 last:border-0">
                  <span className="flex-1 text-ink truncate">{v.vendor}</span>
                  {months.map((m, i) => (
                    <span key={m} className={"w-[68px] text-right shrink-0 tabular-nums " + (i === 0 ? "text-ink font-medium" : "text-slate-500")}>
                      {money(v.m[m] ?? 0)}
                    </span>
                  ))}
                  <span className="w-3.5 shrink-0 flex justify-center">
                    {t === "up" && <TrendingUp className="w-3.5 h-3.5 text-rose-500" />}
                    {t === "down" && <TrendingDown className="w-3.5 h-3.5 text-emerald-500" />}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-2 pt-1.5 mt-1 border-t border-slate-200 text-[12px] font-semibold">
            <span className="flex-1 text-ink">Total</span>
            {months.map((m, i) => (
              <span key={m} className={"w-[68px] text-right shrink-0 tabular-nums " + (i === 0 ? "text-ink" : "text-slate-500")}>
                {money(totals[m])}
              </span>
            ))}
            <span className="w-3.5 shrink-0" />
          </div>
        </div>
      </div>

      {vendors.length > 12 && (
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          className="mt-2 text-[11px] font-medium text-accent hover:underline"
        >
          {showAll ? "Show top 12" : `Show all ${vendors.length} tools`}
        </button>
      )}
    </div>
  );
}
