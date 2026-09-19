"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

// Every P&L line, by month, across all uploaded months (Nov '25 → Aug '26).
// Account-level (not per-vendor — that detail only exists Jun–Aug). Reconciles
// to the P&L totals. Read-only pivot; collapsed by default.

export interface BookLine { period: string; account: string; section: string; amount: number }
export interface BookMonth { period: string; label: string }

function money(n: number): string {
  if (!n) return "—";
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

export function BooksByMonth({ lines, months }: { lines: BookLine[]; months: BookMonth[] }) {
  const [open, setOpen] = useState(false);

  const model = useMemo(() => {
    const periods = months.map((m) => m.period);
    const bySection = (section: string) => {
      const byAccount = new Map<string, Record<string, number>>();
      for (const l of lines) {
        if (l.section !== section) continue;
        const row = byAccount.get(l.account) ?? {};
        row[l.period] = (row[l.period] ?? 0) + Number(l.amount);
        byAccount.set(l.account, row);
      }
      const rows = [...byAccount.entries()].map(([account, vals]) => ({
        account,
        vals,
        total: periods.reduce((s, p) => s + (vals[p] ?? 0), 0)
      }));
      rows.sort((a, b) => b.total - a.total);
      const totals: Record<string, number> = {};
      for (const p of periods) totals[p] = rows.reduce((s, r) => s + (r.vals[p] ?? 0), 0);
      const grand = periods.reduce((s, p) => s + totals[p], 0);
      return { rows, totals, grand };
    };
    const income = bySection("Income");
    const expenses = bySection("Expenses");
    const net: Record<string, number> = {};
    for (const p of periods) net[p] = (income.totals[p] ?? 0) - (expenses.totals[p] ?? 0);
    const netGrand = income.grand - expenses.grand;
    return { periods, income, expenses, net, netGrand };
  }, [lines, months]);

  if (months.length === 0 || lines.length === 0) return null;

  const grandExpenses = model.expenses.grand;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-start gap-1.5 text-left min-w-0">
          <ChevronDown className={"w-4 h-4 text-slate-400 mt-1 shrink-0 transition-transform " + (open ? "rotate-180" : "-rotate-90")} />
          <div>
            <div className="text-[16px] font-semibold text-slate-900">Books by month</div>
            <div className="text-[12px] text-slate-500 mt-0.5">Every P&amp;L line, {months[0]?.label} → {months[months.length - 1]?.label} · account-level · tap to {open ? "collapse" : "expand"}</div>
          </div>
        </button>
        <div className="text-right shrink-0">
          <div className="text-[11px] text-slate-400">Net · all months</div>
          <div className={"text-[20px] font-bold tabular-nums leading-none mt-0.5 " + (model.netGrand < 0 ? "text-rose-500" : "text-slate-900")}>{money(model.netGrand)}</div>
        </div>
      </div>

      {open && (
        <div className="mt-4 overflow-x-auto">
          <table className="text-[12px] min-w-[860px] w-full">
            <thead>
              <tr className="text-slate-400 text-[10px] uppercase tracking-wider border-b border-slate-200">
                <th className="font-medium pb-1.5 pr-2 text-left sticky left-0 bg-white">Account</th>
                {months.map((m) => <th key={m.period} className="font-medium pb-1.5 px-1.5 text-right whitespace-nowrap">{m.label.replace(" '", "'")}</th>)}
                <th className="font-medium pb-1.5 pl-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              <Section title="Income" data={model.income} periods={model.periods} months={months} tone="emerald" />
              <Section title="Expenses" data={model.expenses} periods={model.periods} months={months} tone="slate" />
              <tr className="border-t-2 border-slate-300 font-bold text-slate-900">
                <td className="py-1.5 pr-2 sticky left-0 bg-white">Net income</td>
                {months.map((m) => <td key={m.period} className={"py-1.5 px-1.5 text-right tabular-nums " + ((model.net[m.period] ?? 0) < 0 ? "text-rose-500" : "")}>{money(model.net[m.period] ?? 0)}</td>)}
                <td className={"py-1.5 pl-2 text-right tabular-nums " + (model.netGrand < 0 ? "text-rose-500" : "")}>{money(model.netGrand)}</td>
              </tr>
            </tbody>
          </table>
          <div className="mt-2 text-[11px] text-slate-400">Account-level from your uploaded P&amp;Ls. Reconciles to the P&amp;L totals. Per-vendor detail is only available Jun–Aug (QuickBooks transaction export).</div>
        </div>
      )}
    </div>
  );
}

function Section({ title, data, periods, months, tone }: {
  title: string;
  data: { rows: { account: string; vals: Record<string, number>; total: number }[]; totals: Record<string, number>; grand: number };
  periods: string[];
  months: BookMonth[];
  tone: "emerald" | "slate";
}) {
  const head = tone === "emerald" ? "text-emerald-700" : "text-slate-700";
  return (
    <>
      <tr className="border-b border-slate-100">
        <td colSpan={months.length + 2} className={"pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider " + head}>{title}</td>
      </tr>
      {data.rows.map((r) => (
        <tr key={r.account} className="border-b border-slate-50 last:border-0">
          <td className="py-1 pr-2 text-slate-700 truncate max-w-[220px] sticky left-0 bg-white">{r.account}</td>
          {months.map((m) => <td key={m.period} className={"py-1 px-1.5 text-right tabular-nums " + ((r.vals[m.period] ?? 0) < 0 ? "text-rose-400" : "text-slate-500")}>{money(r.vals[m.period] ?? 0)}</td>)}
          <td className="py-1 pl-2 text-right tabular-nums font-medium text-slate-900">{money(r.total)}</td>
        </tr>
      ))}
      <tr className="border-b border-slate-200 font-semibold text-slate-800">
        <td className="py-1 pr-2 sticky left-0 bg-white">Total {title}</td>
        {months.map((m) => <td key={m.period} className="py-1 px-1.5 text-right tabular-nums">{money(data.totals[m.period] ?? 0)}</td>)}
        <td className="py-1 pl-2 text-right tabular-nums">{money(data.grand)}</td>
      </tr>
    </>
  );
}
