"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

// Contractor payments by person × month, from Deel payment statements. Fed by
// the deel_payments table (re-parsed from the receipts). Collapsed by default.

export interface DeelRow { period: string; contractor: string; amount: number; is_fee: boolean }

function money(n: number): string {
  if (!n) return "—";
  return `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}
const MLBL: Record<string, string> = { "01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr", "05": "May", "06": "Jun", "07": "Jul", "08": "Aug", "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec" };
const label = (p: string) => `${MLBL[p.slice(5, 7)] ?? p.slice(5, 7)} '${p.slice(2, 4)}`;

export function DeelContractors({ rows }: { rows: DeelRow[] }) {
  const [open, setOpen] = useState(false);

  const m = useMemo(() => {
    const months = [...new Set(rows.map((r) => r.period))].sort();
    const people = new Map<string, Record<string, number>>();
    const fees: Record<string, number> = {};
    for (const r of rows) {
      if (r.is_fee) { fees[r.period] = (fees[r.period] ?? 0) + Number(r.amount); continue; }
      const row = people.get(r.contractor) ?? {};
      row[r.period] = (row[r.period] ?? 0) + Number(r.amount);
      people.set(r.contractor, row);
    }
    const list = [...people.entries()].map(([name, vals]) => ({ name, vals, total: months.reduce((s, p) => s + (vals[p] ?? 0), 0) }));
    list.sort((a, b) => b.total - a.total);
    const colTotals: Record<string, number> = {};
    for (const p of months) colTotals[p] = list.reduce((s, r) => s + (r.vals[p] ?? 0), 0);
    const grand = list.reduce((s, r) => s + r.total, 0);
    const feeGrand = months.reduce((s, p) => s + (fees[p] ?? 0), 0);
    return { months, list, colTotals, grand, fees, feeGrand };
  }, [rows]);

  if (rows.length === 0) return null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-start gap-1.5 text-left min-w-0">
          <ChevronDown className={"w-4 h-4 text-slate-400 mt-1 shrink-0 transition-transform " + (open ? "rotate-180" : "-rotate-90")} />
          <div>
            <div className="text-[16px] font-semibold text-slate-900 flex items-center gap-2 flex-wrap">
              Contractor payments <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">Deel + bank</span>
            </div>
            <div className="text-[12px] text-slate-500 mt-0.5">Per person × month, from Deel statements + Novo bank ({m.months.length ? `${label(m.months[0])} → ${label(m.months[m.months.length - 1])}` : ""}) · tap to {open ? "collapse" : "expand"}</div>
          </div>
        </button>
        <div className="text-right shrink-0">
          <div className="text-[11px] text-slate-400">Total paid</div>
          <div className="text-[20px] font-bold tabular-nums text-slate-900 leading-none mt-0.5">{money(m.grand)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">+ {money(m.feeGrand)} Deel fees</div>
        </div>
      </div>

      {open && (
        <div className="mt-4 overflow-x-auto">
          <table className="text-[12px] min-w-[560px] w-full">
            <thead>
              <tr className="text-slate-400 text-[10px] uppercase tracking-wider border-b border-slate-200">
                <th className="font-medium pb-1.5 pr-2 text-left sticky left-0 bg-white">Contractor</th>
                {m.months.map((p) => <th key={p} className="font-medium pb-1.5 px-1.5 text-right whitespace-nowrap">{label(p)}</th>)}
                <th className="font-medium pb-1.5 pl-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {m.list.map((r) => (
                <tr key={r.name} className="border-b border-slate-50 last:border-0">
                  <td className="py-1 pr-2 text-slate-700 truncate max-w-[220px] sticky left-0 bg-white">{r.name}</td>
                  {m.months.map((p) => <td key={p} className="py-1 px-1.5 text-right tabular-nums text-slate-500">{money(r.vals[p] ?? 0)}</td>)}
                  <td className="py-1 pl-2 text-right tabular-nums font-medium text-slate-900">{money(r.total)}</td>
                </tr>
              ))}
              <tr className="border-t border-slate-200 font-semibold text-slate-800">
                <td className="py-1 pr-2 sticky left-0 bg-white">Total contractors</td>
                {m.months.map((p) => <td key={p} className="py-1 px-1.5 text-right tabular-nums">{money(m.colTotals[p] ?? 0)}</td>)}
                <td className="py-1 pl-2 text-right tabular-nums">{money(m.grand)}</td>
              </tr>
              <tr className="text-slate-400">
                <td className="py-1 pr-2 sticky left-0 bg-white">Deel fees</td>
                {m.months.map((p) => <td key={p} className="py-1 px-1.5 text-right tabular-nums">{money(m.fees[p] ?? 0)}</td>)}
                <td className="py-1 pl-2 text-right tabular-nums">{money(m.feeGrand)}</td>
              </tr>
            </tbody>
          </table>
          <div className="mt-2 text-[11px] text-slate-400">Deel statements (reconciled to receipts) + bank-paid contractors (Sam via Novo). This is the itemized detail behind the P&amp;L &ldquo;Contractor Payments&rdquo; line — it now ties out to the P&amp;L (Feb–Aug); Jan &amp; May show Deel timing over the booked amount.</div>
        </div>
      )}
    </div>
  );
}
