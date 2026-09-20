"use client";

import { useMemo, useState } from "react";
import { ChevronRight, ChevronDown, TrendingUp, TrendingDown } from "lucide-react";

// Every expense account, itemized down to the individual vendor/payment per
// month — pulled from QuickBooks. Answers "why aren't these broken into line
// items": each account expands to its actual vendors.

export interface ExpenseRow { account: string; vendor: string; month: string; amount: number; }

const MONTHS = ["Jun", "Jul", "Aug"];
function money(n: number): string {
  if (!n) return "$0";
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

export function ExpenseVendors({ rows }: { rows: ExpenseRow[] }) {
  const [cardOpen, setCardOpen] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const { accounts, grandTotal } = useMemo(() => {
    type Acc = { total: number; monthly: Record<string, number>; vendors: Map<string, Record<string, number>> };
    const byAcct = new Map<string, Acc>();
    for (const r of rows) {
      const a: Acc = byAcct.get(r.account) ?? { total: 0, monthly: {}, vendors: new Map() };
      a.total += Number(r.amount);
      a.monthly[r.month] = (a.monthly[r.month] ?? 0) + Number(r.amount);
      const v = a.vendors.get(r.vendor) ?? ({} as Record<string, number>);
      v[r.month] = (v[r.month] ?? 0) + Number(r.amount);
      a.vendors.set(r.vendor, v);
      byAcct.set(r.account, a);
    }
    const accounts = [...byAcct.entries()]
      .map(([account, a]) => ({
        account, total: a.total, monthly: a.monthly,
        vendors: [...a.vendors.entries()].map(([vendor, m]) => ({ vendor, monthly: m, total: MONTHS.reduce((s, mm) => s + (m[mm] ?? 0), 0) })).sort((x, y) => y.total - x.total)
      }))
      .sort((x, y) => y.total - x.total);
    const grandTotal = accounts.reduce((s, a) => s + a.total, 0);
    return { accounts, grandTotal };
  }, [rows]);

  if (!rows.length) return null;

  const trend = (m: Record<string, number>) => {
    const a = m["Aug"] ?? 0, b = m["Jul"] ?? 0;
    if (Math.abs(a - b) < 50) return null;
    if (b === 0) return a > 50 ? "up" : null;
    if (a / b >= 1.25) return "up";
    if (a / b <= 0.75) return "down";
    return null;
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
      <button type="button" onClick={() => setCardOpen((o) => !o)}
        className="w-full flex items-baseline justify-between gap-2 text-left flex-wrap">
        <div className="flex items-baseline gap-2 min-w-0">
          <ChevronDown className={"w-4 h-4 text-muted shrink-0 self-center transition-transform " + (cardOpen ? "" : "-rotate-90")} />
          <div>
            <div className="text-[13px] font-semibold text-ink">Every expense · by vendor <span className="text-[10px] font-medium uppercase tracking-wide text-emerald-700 bg-emerald-50 rounded px-1.5 py-0.5">QuickBooks</span></div>
            <div className="text-[11px] text-muted mt-0.5">Every account, itemized to the actual vendor/payment. <span className="text-rose-500">▲ rising</span>.</div>
          </div>
        </div>
        <div className="text-[11px] text-muted tabular-nums shrink-0">{money(grandTotal)} · Jun–Aug</div>
      </button>

      {cardOpen && (
      <div className="overflow-x-auto mt-3">
        <div className="min-w-[420px]">
          <div className="flex items-center gap-2 pb-1.5 mb-1 border-b border-slate-200 text-[10px] font-medium text-muted uppercase tracking-wide">
            <span className="flex-1" />
            {MONTHS.map((m) => <span key={m} className="w-[64px] text-right shrink-0">{m}</span>)}
            <span className="w-[72px] text-right shrink-0 text-ink">Total</span>
            <span className="w-3.5 shrink-0" />
          </div>
          <div className="space-y-1">
            {accounts.map((a) => {
              const isOpen = !!open[a.account];
              return (
                <div key={a.account} className="border-b border-slate-100 last:border-0 pb-1">
                  <button type="button" onClick={() => setOpen((o) => ({ ...o, [a.account]: !o[a.account] }))}
                    className="w-full text-left py-1 rounded-lg hover:bg-slate-50 transition-colors">
                    <div className="flex items-center gap-2 px-1">
                      <span className="flex items-center gap-1 flex-1 min-w-0">
                        <ChevronRight className={"w-3.5 h-3.5 text-muted shrink-0 transition-transform " + (isOpen ? "rotate-90" : "")} />
                        <span className="text-[13px] font-medium text-ink truncate">{a.account}</span>
                        <span className="text-[10px] text-muted shrink-0">({a.vendors.length})</span>
                      </span>
                      {MONTHS.map((m) => <span key={m} className="w-[64px] text-right shrink-0 text-[12px] text-slate-500 tabular-nums">{money(a.monthly[m] ?? 0)}</span>)}
                      <span className="w-[72px] text-right shrink-0 text-[12px] font-semibold text-ink tabular-nums">{money(a.total)}</span>
                      <span className="w-3.5 shrink-0 flex justify-center">
                        {trend(a.monthly) === "up" && <TrendingUp className="w-3.5 h-3.5 text-rose-500" />}
                        {trend(a.monthly) === "down" && <TrendingDown className="w-3.5 h-3.5 text-emerald-500" />}
                      </span>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="ml-[26px] mt-0.5 mb-1.5 space-y-0.5 border-l border-slate-100 pl-3">
                      {a.vendors.map((v) => (
                        <div key={v.vendor} className="flex items-center gap-2 py-0.5 text-[12px]">
                          <span className="flex-1 text-slate-600 truncate">{v.vendor}</span>
                          {MONTHS.map((m) => <span key={m} className="w-[64px] text-right shrink-0 text-slate-500 tabular-nums">{money(v.monthly[m] ?? 0)}</span>)}
                          <span className="w-[72px] text-right shrink-0 text-slate-700 font-medium tabular-nums">{money(v.total)}</span>
                          <span className="w-3.5 shrink-0" />
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
      )}
    </div>
  );
}
