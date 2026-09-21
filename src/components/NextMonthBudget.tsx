"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ParsedPnl } from "@/lib/pnl-parse";
import { MARGIN_FLOOR } from "@/lib/finance-defense";

export interface BudgetVendor { account: string; vendor: string; month: string; amount: number }
export interface BudgetMonth { period: string; label: string }

// A forward forecast for next month: an editable revenue estimate + every
// expense line with an editable estimate (pre-filled from last month's actual).
// It shows projected net, margin, and whether it holds the 30% survival floor
// (margin before founder pay). The finance brain reads these estimates too.

// Reserved estimate key for the projected-revenue number (kept out of the
// expense lines / one-offs).
const REV_KEY = "__forecast_revenue__";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function nextMonthLabel(last: string): string {
  const i = MON.findIndex((m) => last.toLowerCase().startsWith(m.toLowerCase()));
  const ym = last.match(/(\d{2})(?!.*\d)/);
  let y = ym ? Number(ym[1]) : 26;
  if (i < 0) return "Next month";
  let n = i + 1;
  if (n > 11) { n = 0; y += 1; }
  return `${MON[n]} '${String(y).padStart(2, "0")}`;
}

function money(n: number): string {
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

function Stat({ label, value, tone, sub, subTone }: { label: string; value: string; tone?: "rose" | "emerald"; sub?: string; subTone?: "emerald" | "amber" }) {
  const color = tone === "rose" ? "text-rose-600" : tone === "emerald" ? "text-emerald-600" : "text-slate-900";
  const subColor = subTone === "emerald" ? "text-emerald-600" : subTone === "amber" ? "text-amber-600" : "text-slate-400";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={"text-[16px] font-bold tabular-nums leading-tight mt-0.5 " + color}>{value}</div>
      {sub && <div className={"text-[10px] font-medium tabular-nums mt-0.5 " + subColor}>{sub}</div>}
    </div>
  );
}

interface Line { account: string; category: string; lastMonth: number }

function buildLines(parsed: ParsedPnl): { lines: Line[]; lastMonthLabel: string; thisMonthTotal: number } {
  const periods = parsed.periods;
  const hasTotal = periods[periods.length - 1]?.toLowerCase() === "total";
  const monthIdx = periods.map((_, i) => i).filter((i) => !(hasTotal && i === periods.length - 1));
  const li = monthIdx[monthIdx.length - 1];
  const lastMonthLabel = periods[li] ?? "";
  const rows = parsed.rows;
  const startI = rows.findIndex((r) => r.account.toUpperCase() === "EXPENSES");
  const endI = rows.findIndex((r) => r.account.toLowerCase() === "total expenses");
  const lines: Line[] = [];
  if (startI >= 0 && endI > startI) {
    let cat = "";
    for (let i = startI + 1; i < endI; i++) {
      const r = rows[i];
      if (r.level === 1) {
        cat = r.account;
        // A category with no child line items is itself a line.
        const hasChildren = i + 1 < endI && rows[i + 1].level > 1;
        if (!hasChildren) lines.push({ account: r.account, category: r.account, lastMonth: Math.round(r.values[li] ?? 0) });
        continue;
      }
      if (r.account.toLowerCase() === `total ${cat.toLowerCase()}`) continue;
      lines.push({ account: r.account, category: cat, lastMonth: Math.round(r.values[li] ?? 0) });
    }
  }
  const seen = new Set<string>();
  // Every line from the month before — even the $0 ones (they sort to the bottom).
  const dedup = lines.filter((l) => (seen.has(l.account) ? false : (seen.add(l.account), true)));
  dedup.sort((a, b) => b.lastMonth - a.lastMonth);
  const thisMonthTotal = dedup.reduce((s, l) => s + l.lastMonth, 0);
  return { lines: dedup, lastMonthLabel, thisMonthTotal };
}

export function NextMonthBudget({ parsed, estimates, defaultRevenue = 0, vendors = [], months = [] }: { parsed: ParsedPnl | null | undefined; estimates: Record<string, number>; defaultRevenue?: number; vendors?: BudgetVendor[]; months?: BudgetMonth[] }) {
  const built = useMemo(() => (parsed ? buildLines(parsed) : null), [parsed]);
  const [est, setEst] = useState<Record<string, number>>(estimates);
  const [openLine, setOpenLine] = useState<Record<string, boolean>>({});

  // Vendor breakdown per account for the last two months we have detail for
  // (e.g. Jul → Aug), so each forecast line shows what actually made it up.
  const vendorModel = useMemo(() => {
    const shortSeq = months.map((m) => m.label.slice(0, 3));
    const present = [...new Set(vendors.map((v) => v.month.slice(0, 3)))];
    const ordered = shortSeq.filter((s) => present.includes(s));
    const cols = ordered.slice(-2); // prev + last month (e.g. Jul, Aug)
    const byAccount = new Map<string, Map<string, Record<string, number>>>();
    for (const v of vendors) {
      const mo = v.month.slice(0, 3);
      if (!cols.includes(mo)) continue;
      const vmap = byAccount.get(v.account) ?? new Map<string, Record<string, number>>();
      const rec = vmap.get(v.vendor) ?? {};
      rec[mo] = (rec[mo] ?? 0) + Number(v.amount);
      vmap.set(v.vendor, rec);
      byAccount.set(v.account, vmap);
    }
    return { cols, byAccount };
  }, [vendors, months]);
  const [saving, setSaving] = useState<string | null>(null);

  const [oneOffName, setOneOffName] = useState("");
  const [oneOffAmt, setOneOffAmt] = useState("");
  const [open, setOpen] = useState(false);

  if (!built || built.lines.length === 0) return null;
  const { lines, lastMonthLabel, thisMonthTotal } = built;
  // Vendor-level forecasting: accounts with vendor detail are estimated bottom-up
  // (edit each vendor's next-month box); the account total = last month + the sum
  // of vendor changes, so unedited stays exactly on last month's actual.
  const SEP = "::sep::";
  const lastCol = vendorModel.cols[vendorModel.cols.length - 1] ?? "";
  const vKey = (account: string, vendor: string) => `${account}${SEP}${vendor}`;
  const hasVendors = (account: string) => vendorModel.byAccount.has(account) && vendorModel.cols.length > 0;
  const vendorSep = (account: string, vendor: string, augVal: number) => { const k = vKey(account, vendor); return k in est ? est[k] : augVal; };
  const vendorDelta = (account: string) => {
    const vmap = vendorModel.byAccount.get(account);
    if (!vmap) return 0;
    let d = 0;
    for (const [vendor, vals] of vmap) { const k = vKey(account, vendor); if (k in est) d += est[k] - Math.round(vals[lastCol] ?? 0); }
    return d;
  };
  const estOf = (l: Line) => (hasVendors(l.account) ? l.lastMonth + vendorDelta(l.account) : (l.account in est ? est[l.account] : l.lastMonth));
  // One-off / added lines = estimates that aren't a recurring P&L line, a vendor
  // box, or the reserved revenue key.
  const pnlAccounts = new Set(lines.map((l) => l.account));
  const oneOffs = Object.keys(est).filter((a) => a !== REV_KEY && !a.includes(SEP) && !pnlAccounts.has(a) && est[a] > 0).map((a) => ({ account: a, amount: est[a] }));
  const totalNext = lines.reduce((s, l) => s + estOf(l), 0) + oneOffs.reduce((s, o) => s + o.amount, 0);
  const delta = totalNext - thisMonthTotal;

  // ── Forecast: revenue (editable) → net → margin → survival floor ──────────
  const forecastLabel = nextMonthLabel(lastMonthLabel);
  const revenue = REV_KEY in est ? est[REV_KEY] : Math.round(defaultRevenue);
  const founderLine = lines.find((l) => l.account.toLowerCase().includes("mitchell price"));
  const founderPay = founderLine ? estOf(founderLine) : 0;
  const net = revenue - totalNext;
  const beforeFounderProfit = net + founderPay; // survival rule = margin before founder pay
  const marginBF = revenue > 0 ? (beforeFounderProfit / revenue) * 100 : 0;
  const netMargin = revenue > 0 ? (net / revenue) * 100 : 0;
  const holdsFloor = revenue > 0 && marginBF >= MARGIN_FLOOR;
  const floorGap = Math.max(0, Math.round((MARGIN_FLOOR / 100) * revenue - beforeFounderProfit));

  async function save(account: string, raw: string) {
    // Strip commas, "$", spaces etc. so "115,000" and "$115,000" parse correctly.
    const amount = Math.max(0, Math.round(Number(String(raw).replace(/[^0-9.]/g, "")) || 0));
    setEst((e) => ({ ...e, [account]: amount }));
    setSaving(account);
    try {
      await fetch("/api/finance/estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account, amount }) });
    } catch { /* best effort */ } finally { setSaving(null); }
  }

  async function addOneOff() {
    const name = oneOffName.trim();
    const amount = Math.max(0, Math.round(Number(oneOffAmt) || 0));
    if (!name || amount <= 0 || pnlAccounts.has(name)) return;
    setEst((e) => ({ ...e, [name]: amount }));
    setOneOffName(""); setOneOffAmt("");
    try {
      await fetch("/api/finance/estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: name, amount }) });
    } catch { /* best effort */ }
  }

  async function removeOneOff(account: string) {
    setEst((e) => { const n = { ...e }; delete n[account]; return n; });
    try {
      await fetch("/api/finance/estimate", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account }) });
    } catch { /* best effort */ }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-start gap-1.5 text-left min-w-0">
          <ChevronDown className={"w-4 h-4 text-slate-400 mt-1 shrink-0 transition-transform " + (open ? "rotate-180" : "-rotate-90")} />
          <div>
            <div className="text-[16px] font-semibold text-slate-900">{forecastLabel} forecast</div>
            <div className="text-[12px] text-slate-500 mt-0.5">Estimate revenue &amp; costs (pre-filled from {lastMonthLabel}) · tap to {open ? "collapse" : "expand"}</div>
          </div>
        </button>
        <div className="text-right shrink-0">
          <div className="text-[11px] text-slate-400">Projected net · {forecastLabel}</div>
          <div className={"text-[26px] font-bold tabular-nums leading-none mt-0.5 " + (net < 0 ? "text-rose-500" : "text-slate-900")}>{money(net)}</div>
          <div className={"text-[11px] font-semibold rounded-full px-2 py-0.5 inline-block mt-1 " + (holdsFloor ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700")}>
            {marginBF.toFixed(1)}% {holdsFloor ? `✓ ${MARGIN_FLOOR}% floor` : `✗ below ${MARGIN_FLOOR}%`}
          </div>
        </div>
      </div>

      {open && (<div className="mt-4">
      {/* Forecast summary — revenue in, projected performance out. */}
      <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3.5 mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12px] font-medium text-slate-600">Projected revenue</span>
          <span className="text-[13px] text-slate-400">$</span>
          <input
            type="text"
            inputMode="decimal"
            defaultValue={revenue.toLocaleString("en-US")}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => save(REV_KEY, e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            className="w-32 text-[14px] font-semibold text-right tabular-nums rounded-lg border border-slate-200 px-2 py-1 focus:outline-none focus:border-slate-400"
          />
          {saving === REV_KEY && <span className="text-[10px] text-slate-400">saving</span>}
          {delta !== 0 && (
            <span className={"ml-auto text-[12px] font-semibold rounded-full px-2.5 py-1 " + (delta < 0 ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700")}>
              {delta < 0 ? `▼ Cutting ${money(-delta)}/mo` : `▲ ${money(delta)}/mo more`} vs {lastMonthLabel}
            </span>
          )}
        </div>
        <div className="text-[11px] text-slate-400 mt-1">Edit the cost lines below — the total, net &amp; margin update as you go.</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
          <Stat label="Revenue" value={money(revenue)} />
          <Stat label="Expenses" value={money(totalNext)} sub={delta === 0 ? `same as ${lastMonthLabel}` : `${delta < 0 ? "−" : "+"}${money(Math.abs(delta))} vs ${lastMonthLabel}`} subTone={delta < 0 ? "emerald" : delta > 0 ? "amber" : undefined} />
          <Stat label="Net" value={money(net)} tone={net < 0 ? "rose" : undefined} />
          <Stat label="Margin before founder" value={`${marginBF.toFixed(1)}%`} tone={holdsFloor ? "emerald" : "rose"} />
        </div>
        <div className={"text-[12px] mt-2.5 " + (holdsFloor ? "text-emerald-700" : "text-rose-600")}>
          {revenue <= 0
            ? `Enter a revenue estimate to gauge ${forecastLabel}.`
            : holdsFloor
              ? `Holds the ${MARGIN_FLOOR}% survival floor (${netMargin.toFixed(1)}% net margin after your ${money(founderPay)} pay).`
              : `Below the ${MARGIN_FLOOR}% floor — need ${money(floorGap)} more profit for ${forecastLabel} (cut costs or add revenue).`}
        </div>
      </div>

      <div className="divide-y divide-slate-100">
        {lines.map((l) => {
          const vmap = vendorModel.byAccount.get(l.account);
          const vendorRows = vmap
            ? [...vmap.entries()].map(([vendor, vals]) => ({ vendor, vals, last: vals[vendorModel.cols[vendorModel.cols.length - 1]] ?? 0 }))
                .sort((a, b) => b.last - a.last)
            : [];
          const isOpen = !!openLine[l.account];
          const lineDelta = estOf(l) - l.lastMonth;
          const vendorNoun = l.account === "Contractor Payments" ? "people" : "vendors";
          return (
            <div key={l.account} className="py-2">
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => vendorRows.length && setOpenLine((o) => ({ ...o, [l.account]: !o[l.account] }))}
                  className={"min-w-0 flex-1 flex items-start gap-1.5 text-left " + (vendorRows.length ? "" : "cursor-default")}>
                  {vendorRows.length > 0
                    ? <ChevronRight className={"w-3.5 h-3.5 text-slate-400 mt-0.5 shrink-0 transition-transform " + (isOpen ? "rotate-90" : "")} />
                    : <span className="w-3.5 shrink-0" />}
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-slate-900 truncate">{l.account}</div>
                    <div className="text-[11px] text-slate-400 truncate">
                      {l.category !== l.account ? l.category : "expense"} · was {money(l.lastMonth)}{vendorRows.length ? ` · ${vendorRows.length} ${vendorNoun}` : ""}
                      {lineDelta !== 0 && <span className={"font-medium " + (lineDelta < 0 ? "text-emerald-600" : "text-amber-600")}> · {lineDelta < 0 ? `saving ${money(-lineDelta)}` : `+${money(lineDelta)}`}</span>}
                    </div>
                  </div>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-[13px] text-slate-400">$</span>
                  {vendorRows.length > 0 ? (
                    <span className="w-24 text-[13px] text-right tabular-nums font-semibold text-slate-900 px-2 py-1" title="Sum of the vendor estimates below">{estOf(l).toLocaleString("en-US")}</span>
                  ) : (
                    <input
                      type="text"
                      inputMode="decimal"
                      defaultValue={estOf(l).toLocaleString("en-US")}
                      onFocus={(e) => e.currentTarget.select()}
                      onBlur={(e) => save(l.account, e.currentTarget.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                      className="w-24 text-[13px] text-right tabular-nums rounded-lg border border-slate-200 px-2 py-1 focus:outline-none focus:border-slate-400"
                    />
                  )}
                  <span className="w-8" />
                </div>
              </div>

              {isOpen && vendorRows.length > 0 && (
                <div className="ml-5 mt-1.5 mb-1 border-l border-slate-100 pl-3">
                  <div className="flex items-center gap-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                    <span className="flex-1">Vendor</span>
                    {vendorModel.cols.map((c) => <span key={c} className="w-[56px] text-right shrink-0">{c}</span>)}
                    <span className="w-[84px] text-right shrink-0 text-slate-500">{forecastLabel.replace(" '", "'")} (est)</span>
                  </div>
                  {vendorRows.map((v) => {
                    const aug = v.vals[lastCol] ?? 0;
                    return (
                      <div key={v.vendor} className="flex items-center gap-2 py-0.5 text-[12px]">
                        <span className="flex-1 min-w-0 truncate text-slate-600">{v.vendor}</span>
                        {vendorModel.cols.map((c) => <span key={c} className="w-[56px] text-right shrink-0 tabular-nums text-slate-500">{money(v.vals[c] ?? 0)}</span>)}
                        <span className="w-[84px] shrink-0 flex items-center justify-end gap-0.5">
                          <span className="text-[11px] text-slate-400">$</span>
                          <input
                            type="text"
                            inputMode="decimal"
                            defaultValue={Math.round(vendorSep(l.account, v.vendor, aug)).toLocaleString("en-US")}
                            onFocus={(e) => e.currentTarget.select()}
                            onBlur={(e) => save(vKey(l.account, v.vendor), e.currentTarget.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                            className="w-[64px] text-[12px] text-right tabular-nums rounded-md border border-slate-200 px-1.5 py-0.5 focus:outline-none focus:border-slate-400"
                          />
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* One-off / added payments — one-time costs you expect next month. */}
      <div className="mt-4 pt-4 border-t border-slate-100">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">One-off payments next month</div>
        {oneOffs.length > 0 && (
          <div className="divide-y divide-slate-100 mb-2">
            {oneOffs.map((o) => (
              <div key={o.account} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-slate-900 truncate">{o.account}</div>
                  <div className="text-[11px] text-slate-400">one-time</div>
                </div>
                <span className="text-[13px] font-semibold tabular-nums text-slate-900">${o.amount.toLocaleString("en-US")}</span>
                <button type="button" onClick={() => removeOneOff(o.account)} className="text-[11px] text-slate-400 hover:text-rose-500 w-8 text-right">remove</button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={oneOffName}
            onChange={(e) => setOneOffName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addOneOff(); }}
            placeholder="One-off (e.g. new laptop, legal, conference)"
            className="flex-1 min-w-[200px] text-[13px] rounded-lg border border-slate-200 px-2.5 py-1.5 focus:outline-none focus:border-slate-400"
          />
          <div className="flex items-center gap-1">
            <span className="text-[13px] text-slate-400">$</span>
            <input
              value={oneOffAmt}
              onChange={(e) => setOneOffAmt(e.target.value.replace(/[^0-9.]/g, ""))}
              onKeyDown={(e) => { if (e.key === "Enter") addOneOff(); }}
              placeholder="amount"
              inputMode="decimal"
              className="w-24 text-[13px] text-right tabular-nums rounded-lg border border-slate-200 px-2 py-1.5 focus:outline-none focus:border-slate-400"
            />
          </div>
          <button type="button" onClick={addOneOff} disabled={!oneOffName.trim() || !(Number(oneOffAmt) > 0)}
            className="text-[12px] font-medium text-white bg-slate-900 rounded-lg px-3 py-1.5 hover:bg-slate-800 disabled:opacity-50">Add</button>
        </div>
      </div>
      </div>)}
    </div>
  );
}
