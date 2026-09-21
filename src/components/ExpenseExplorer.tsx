"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, TrendingUp, TrendingDown } from "lucide-react";

// One place to answer "what drove this expense up?" — every expense account, its
// month-by-month total across all uploaded months, expandable to the biggest
// jump + (where we have it, Jun–Aug) the vendor-level difference-makers.
//
// Monthly totals come from the account-level P&L (all months); vendor detail
// comes from the QuickBooks transaction export (recent months only).

export interface ExplLine { period: string; account: string; section: string; amount: number }
export interface ExplMonth { period: string; label: string }
export interface ExplVendor { account: string; vendor: string; month: string; amount: number }

function money(n: number): string {
  if (!n) return "—";
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}
function signed(n: number): string {
  return `${n < 0 ? "-" : "+"}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

// Tiny inline trend line for a row of monthly values.
function Spark({ vals }: { vals: number[] }) {
  if (vals.length < 2) return null;
  const W = 84, H = 22, p = 2;
  const max = Math.max(...vals, 1), min = Math.min(...vals, 0);
  const span = max - min || 1;
  const x = (i: number) => p + (i / (vals.length - 1)) * (W - p * 2);
  const y = (v: number) => H - p - ((v - min) / span) * (H - p * 2);
  const d = vals.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-[84px] h-[22px] shrink-0" preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke={up ? "#f43f5e" : "#10b981"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ExpenseExplorer({ lines, months, vendors }: { lines: ExplLine[]; months: ExplMonth[]; vendors: ExplVendor[] }) {
  const [cardOpen, setCardOpen] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const model = useMemo(() => {
    const periods = months.map((m) => m.period);
    const labelOf = new Map(months.map((m) => [m.period, m.label]));
    // 3-letter month → period, so vendor rows ("Jul") map onto the P&L periods.
    const shortToPeriod = new Map(months.map((m) => [m.label.slice(0, 3).toLowerCase(), m.period]));

    // Account-level monthly totals (all months).
    const byAccount = new Map<string, Record<string, number>>();
    for (const l of lines) {
      if (l.section !== "Expenses") continue;
      const row = byAccount.get(l.account) ?? {};
      row[l.period] = (row[l.period] ?? 0) + Number(l.amount);
      byAccount.set(l.account, row);
    }

    // Vendor detail per account, keyed by period (only the months we have it).
    const vByAccount = new Map<string, Map<string, Record<string, number>>>();
    const vendorPeriodSet = new Set<string>();
    for (const v of vendors) {
      const period = shortToPeriod.get(v.month.slice(0, 3).toLowerCase());
      if (!period) continue;
      vendorPeriodSet.add(period);
      const vmap = vByAccount.get(v.account) ?? new Map<string, Record<string, number>>();
      const rec = vmap.get(v.vendor) ?? {};
      rec[period] = (rec[period] ?? 0) + Number(v.amount);
      vmap.set(v.vendor, rec);
      vByAccount.set(v.account, vmap);
    }
    const vendorPeriods = periods.filter((p) => vendorPeriodSet.has(p));

    const latest = periods[periods.length - 1];
    const prev = periods[periods.length - 2];

    const accounts = [...byAccount.entries()].map(([account, vals]) => {
      const series = periods.map((p) => vals[p] ?? 0);
      const total = series.reduce((s, v) => s + v, 0);
      const delta = (vals[latest] ?? 0) - (vals[prev] ?? 0);
      // Biggest month-over-month jump (the difference-maker month).
      let jump = { from: "", to: "", amount: 0 };
      for (let i = 1; i < periods.length; i++) {
        const dchg = (vals[periods[i]] ?? 0) - (vals[periods[i - 1]] ?? 0);
        if (Math.abs(dchg) > Math.abs(jump.amount)) jump = { from: periods[i - 1], to: periods[i], amount: dchg };
      }
      // Vendor difference-makers over the last two vendor months.
      const vmap = vByAccount.get(account);
      let risers: { vendor: string; delta: number }[] = [];
      let vendorRows: { vendor: string; vals: Record<string, number>; total: number }[] = [];
      if (vmap && vendorPeriods.length) {
        const vp = vendorPeriods[vendorPeriods.length - 1], vpPrev = vendorPeriods[vendorPeriods.length - 2];
        vendorRows = [...vmap.entries()].map(([vendor, vv]) => ({ vendor, vals: vv, total: vendorPeriods.reduce((s, p) => s + (vv[p] ?? 0), 0) }))
          .sort((a, b) => (b.vals[vp] ?? 0) - (a.vals[vp] ?? 0));
        if (vpPrev) {
          risers = [...vmap.entries()].map(([vendor, vv]) => ({ vendor, delta: (vv[vp] ?? 0) - (vv[vpPrev] ?? 0) }))
            .filter((r) => r.delta > 20).sort((a, b) => b.delta - a.delta).slice(0, 3);
        }
      }
      return { account, vals, series, total, latest: vals[latest] ?? 0, delta, jump, vendorRows, risers };
    }).sort((a, b) => b.latest - a.latest);

    const grandLatest = accounts.reduce((s, a) => s + a.latest, 0);
    const grandTotal = accounts.reduce((s, a) => s + a.total, 0);
    return { periods, labelOf, vendorPeriods, accounts, latest, prev, grandLatest, grandTotal };
  }, [lines, months, vendors]);

  if (!months.length || !lines.length) return null;
  const latestLabel = model.labelOf.get(model.latest) ?? "";
  const prevLabel = model.labelOf.get(model.prev) ?? "";

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <button type="button" onClick={() => setCardOpen((o) => !o)} className="w-full flex items-center justify-between gap-2 text-left">
        <div className="flex items-center gap-2 min-w-0">
          <ChevronDown className={"w-4 h-4 text-slate-400 shrink-0 transition-transform " + (cardOpen ? "" : "-rotate-90")} />
          <div>
            <div className="text-[15px] font-semibold text-slate-900">Expenses · every month</div>
            <div className="text-[11px] text-slate-500 mt-0.5">Each expense over time — tap any line to see what changed and which vendors drove it.</div>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] text-slate-400">{latestLabel}</div>
          <div className="text-[15px] font-bold tabular-nums text-slate-900 leading-none">{money(model.grandLatest)}</div>
        </div>
      </button>

      {cardOpen && (
        <div className="mt-3 space-y-1">
          {model.accounts.map((a) => {
            const isOpen = !!open[a.account];
            const up = a.delta > 0;
            return (
              <div key={a.account} className="border-b border-slate-100 last:border-0 pb-1">
                <button type="button" onClick={() => setOpen((o) => ({ ...o, [a.account]: !o[a.account] }))}
                  className="w-full text-left py-1.5 rounded-lg hover:bg-slate-50 transition-colors">
                  <div className="flex items-center gap-2 px-1">
                    <ChevronRight className={"w-3.5 h-3.5 text-slate-400 shrink-0 transition-transform " + (isOpen ? "rotate-90" : "")} />
                    <span className="text-[13px] font-medium text-slate-800 flex-1 min-w-0 truncate">{a.account}</span>
                    <Spark vals={a.series} />
                    <span className="w-[80px] text-right shrink-0 text-[13px] font-semibold tabular-nums text-slate-900">{money(a.latest)}</span>
                    <span className={"w-[92px] text-right shrink-0 text-[11px] tabular-nums flex items-center justify-end gap-0.5 " + (Math.abs(a.delta) < 20 ? "text-slate-300" : up ? "text-rose-500" : "text-emerald-600")}>
                      {Math.abs(a.delta) >= 20 && (up ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />)}
                      {Math.abs(a.delta) < 20 ? "flat" : signed(a.delta)}
                    </span>
                  </div>
                </button>

                {isOpen && (
                  <div className="ml-[26px] mr-1 mt-1 mb-2">
                    {/* Plain-English read */}
                    <div className="text-[12px] text-slate-600 bg-slate-50 rounded-lg p-2.5">
                      {latestLabel} <span className="font-semibold text-slate-900">{money(a.latest)}</span>
                      {Math.abs(a.delta) >= 20 && <> · {up ? "up" : "down"} <span className={"font-semibold " + (up ? "text-rose-600" : "text-emerald-600")}>{signed(a.delta)}</span> from {prevLabel}</>}
                      {a.jump.amount !== 0 && (a.jump.to !== model.latest || Math.abs(a.jump.amount) > Math.abs(a.delta)) && (
                        <> · biggest move was {signed(a.jump.amount)} ({(model.labelOf.get(a.jump.from) ?? "").replace(" '", "'")}→{(model.labelOf.get(a.jump.to) ?? "").replace(" '", "'")})</>
                      )}
                      {a.risers.length > 0 && (
                        <> · driven by {a.risers.map((r) => `${r.vendor} (${signed(r.delta)})`).join(", ")}</>
                      )}
                    </div>

                    {/* Month-by-month totals */}
                    <div className="mt-2 overflow-x-auto">
                      <div className="flex gap-1 min-w-max">
                        {model.periods.map((p, i) => {
                          const v = a.vals[p] ?? 0;
                          const isJump = p === a.jump.to && Math.abs(a.jump.amount) >= 20;
                          return (
                            <div key={p} className={"rounded-lg px-2 py-1.5 text-center " + (isJump ? "bg-rose-50" : "bg-slate-50")}>
                              <div className="text-[9px] uppercase tracking-wide text-slate-400">{(model.labelOf.get(p) ?? "").replace(" '", "'")}</div>
                              <div className={"text-[11px] font-semibold tabular-nums " + (isJump ? "text-rose-600" : "text-slate-700")}>{money(v)}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Vendor detail, where we have it */}
                    {a.vendorRows.length > 0 && (
                      <div className="mt-2.5">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Vendors ({model.vendorPeriods.map((p) => (model.labelOf.get(p) ?? "").slice(0, 3)).join(" · ")})</div>
                        <div className="space-y-0.5">
                          {a.vendorRows.slice(0, 20).map((v) => (
                            <div key={v.vendor} className="flex items-center gap-2 text-[12px]">
                              <span className="flex-1 min-w-0 truncate text-slate-600">{v.vendor}</span>
                              {model.vendorPeriods.map((p) => <span key={p} className="w-[64px] text-right shrink-0 tabular-nums text-slate-500">{money(v.vals[p] ?? 0)}</span>)}
                            </div>
                          ))}
                          {a.vendorRows.length > 20 && <div className="text-[11px] text-slate-400 pt-0.5">+{a.vendorRows.length - 20} more vendors</div>}
                        </div>
                      </div>
                    )}
                    {a.vendorRows.length === 0 && (
                      <div className="mt-2 text-[11px] text-slate-400">Vendor-level detail for this account isn&apos;t in the transaction export yet — totals are from the P&amp;L.</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <div className="pt-1.5 text-[11px] text-slate-400">Monthly totals from your uploaded P&amp;Ls (all months). Vendor detail from the QuickBooks export ({model.vendorPeriods.map((p) => (model.labelOf.get(p) ?? "").replace(" '", "'")).join(", ") || "recent months"}).</div>
        </div>
      )}
    </div>
  );
}
