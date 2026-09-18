"use client";

import { useMemo, useState } from "react";
import type { ParsedPnl } from "@/lib/pnl-parse";

// A forward budget: every expense line with an editable "next month" estimate.
// Each line pre-fills with last month's actual; Mitchell overrides what he
// expects and it saves. The total is his projected next-month spend, and the
// finance brain reads these estimates for "what's my burn next month".

function money(n: number): string {
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
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
  const dedup = lines.filter((l) => (seen.has(l.account) ? false : (seen.add(l.account), true))).filter((l) => l.lastMonth !== 0);
  dedup.sort((a, b) => b.lastMonth - a.lastMonth);
  const thisMonthTotal = dedup.reduce((s, l) => s + l.lastMonth, 0);
  return { lines: dedup, lastMonthLabel, thisMonthTotal };
}

export function NextMonthBudget({ parsed, estimates }: { parsed: ParsedPnl | null | undefined; estimates: Record<string, number> }) {
  const built = useMemo(() => (parsed ? buildLines(parsed) : null), [parsed]);
  const [est, setEst] = useState<Record<string, number>>(estimates);
  const [saving, setSaving] = useState<string | null>(null);

  const [oneOffName, setOneOffName] = useState("");
  const [oneOffAmt, setOneOffAmt] = useState("");

  if (!built || built.lines.length === 0) return null;
  const { lines, lastMonthLabel, thisMonthTotal } = built;
  const estOf = (l: Line) => (l.account in est ? est[l.account] : l.lastMonth);
  // One-off / added lines = estimates that aren't one of the recurring P&L lines.
  const pnlAccounts = new Set(lines.map((l) => l.account));
  const oneOffs = Object.keys(est).filter((a) => !pnlAccounts.has(a) && est[a] > 0).map((a) => ({ account: a, amount: est[a] }));
  const totalNext = lines.reduce((s, l) => s + estOf(l), 0) + oneOffs.reduce((s, o) => s + o.amount, 0);
  const delta = totalNext - thisMonthTotal;

  async function save(account: string, raw: string) {
    const amount = Math.max(0, Math.round(Number(raw) || 0));
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
      <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
        <div>
          <div className="text-[16px] font-semibold text-slate-900">Next month budget</div>
          <div className="text-[12px] text-slate-500 mt-0.5">Each line starts at last month ({lastMonthLabel}). Type what you expect — it saves and the brain uses it.</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] text-slate-400">Est. next month</div>
          <div className="text-[26px] font-bold tabular-nums text-slate-900 leading-none mt-0.5">{money(totalNext)}</div>
          <div className={"text-[12px] font-medium mt-1 " + (delta > 0 ? "text-rose-500" : delta < 0 ? "text-emerald-600" : "text-slate-400")}>
            {delta > 0 ? "+" : ""}{money(delta)} vs this month
          </div>
        </div>
      </div>

      <div className="divide-y divide-slate-100">
        {lines.map((l) => (
          <div key={l.account} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-slate-900 truncate">{l.account}</div>
              <div className="text-[11px] text-slate-400 truncate">{l.category !== l.account ? l.category : "expense"} · was {money(l.lastMonth)}</div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <span className="text-[13px] text-slate-400">$</span>
              <input
                type="text"
                inputMode="decimal"
                defaultValue={String(estOf(l))}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => save(l.account, e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                className="w-24 text-[13px] text-right tabular-nums rounded-lg border border-slate-200 px-2 py-1 focus:outline-none focus:border-slate-400"
              />
              {saving === l.account && <span className="text-[10px] text-slate-400 w-8">saving</span>}
              {saving !== l.account && <span className="w-8" />}
            </div>
          </div>
        ))}
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
    </div>
  );
}
