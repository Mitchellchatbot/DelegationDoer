"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

// Facebook per month, from the Finance app: revenue (real spend × your fee +
// setup) and the operating expense for that month. Your 50% profit is figured
// AFTER these plus any contractors you tag Facebook — the partner's commission
// is the other 50%, computed automatically, so it's no longer entered here.

export interface FbMonthInput { period: string; label: string }

export function FacebookMonthly({ months, initial, expensesInitial }: { months: FbMonthInput[]; initial: Record<string, number>; expensesInitial: Record<string, number> }) {
  const [rev, setRev] = useState<Record<string, number>>(initial);
  const [exp, setExp] = useState<Record<string, number>>(expensesInitial);
  const [saving, setSaving] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const store: Record<"revenue" | "expenses", (u: (p: Record<string, number>) => Record<string, number>) => void> = { revenue: setRev, expenses: setExp };
  async function save(period: string, field: "revenue" | "expenses", raw: string) {
    const value = Math.max(0, Math.round(Number(raw) || 0));
    store[field]((p) => ({ ...p, [period]: value }));
    setSaving(period + field);
    try {
      await fetch("/api/finance/facebook-revenue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ period, [field]: value }) });
    } catch { /* best effort */ } finally { setSaving(null); }
  }
  const val: Record<"revenue" | "expenses", Record<string, number>> = { revenue: rev, expenses: exp };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-start gap-1.5 text-left w-full">
        <ChevronDown className={"w-4 h-4 text-slate-400 mt-1 shrink-0 transition-transform " + (open ? "rotate-180" : "-rotate-90")} />
        <div>
          <div className="text-[16px] font-semibold text-slate-900">Facebook revenue &amp; operating expense (from Finance app)</div>
          <div className="text-[12px] text-slate-500 mt-0.5">Revenue &amp; operating expense per month — your 50% profit is figured after these + tagged contractors · tap to {open ? "collapse" : "expand"}</div>
        </div>
      </button>
      {open && (<div className="mt-4">
      <div className="divide-y divide-slate-100">
        <div className="flex items-center gap-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          <div className="flex-1">Month</div>
          <div className="w-28 text-right">Revenue</div>
          <div className="w-28 text-right">Operating exp</div>
        </div>
        {months.map((m) => (
          <div key={m.period} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-slate-900">{m.label}</div>
              <div className="text-[11px] text-slate-400">{m.period}</div>
            </div>
            {(["revenue", "expenses"] as const).map((field) => (
              <div key={field} className="w-28 flex items-center justify-end gap-1 shrink-0">
                <span className="text-[13px] text-slate-400">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  defaultValue={String(val[field][m.period] ?? "")}
                  placeholder="0"
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={(e) => save(m.period, field, e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  className="w-24 text-[13px] text-right tabular-nums rounded-lg border border-slate-200 px-2 py-1 focus:outline-none focus:border-slate-400"
                />
              </div>
            ))}
          </div>
        ))}
      </div>
      {saving && <div className="mt-2 text-[10px] text-slate-400">saving…</div>}
      </div>)}
    </div>
  );
}
