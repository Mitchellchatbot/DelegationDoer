"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { computeFbEstimate } from "@/lib/fb-estimate";

// September Facebook profit estimate — an editable mini-P&L (owner-only).
// REVENUE: ad spend per provider (spend × custom fee %) + onboarding (Stripe
// tagged + manual). COSTS: Facebook salaries (roster) + tagged Facebook
// expenses + your own line items. Net → your 50% after the partner split.
// Editable inputs persist to fb_estimate; salaries, tagged expenses and Stripe
// onboarding pull in live.

const SPEND = (n: string) => `prov::${n}::spend`;
const FEE = (n: string) => `prov::${n}::fee`;
const EXP = "exp::";

function money(n: number): string {
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}
const clean = (raw: string) => Math.max(0, Math.round(Number(String(raw).replace(/[^0-9.]/g, "")) || 0));

export interface EstProvider { name: string; defaultSpend: number; defaultFeePct: number }

export function FacebookEstimate({ monthLabel, providers, onboardingStripe, salaries, taggedExpenses, taggedItems = [], initial }: {
  monthLabel: string;
  providers: EstProvider[];        // seeded from the Facebook dashboard
  onboardingStripe: number;        // Stripe one-offs tagged Onboarding (read-only)
  salaries: number;                // roster people tagged Facebook (read-only)
  taggedExpenses: number;          // "Assign Facebook expenses" total (read-only)
  taggedItems?: { label: string; amount: number }[]; // itemized breakdown of taggedExpenses
  initial: Record<string, number>;
}) {
  const [est, setEst] = useState<Record<string, number>>(initial);
  const [newProv, setNewProv] = useState("");
  const [newExp, setNewExp] = useState("");
  const [newExpAmt, setNewExpAmt] = useState("");

  async function save(key: string, value: number) {
    setEst((e) => ({ ...e, [key]: value }));
    try { await fetch("/api/finance/fb-estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value }) }); } catch { /* best effort */ }
  }
  async function removeKey(...keys: string[]) {
    setEst((e) => { const n = { ...e }; for (const k of keys) delete n[k]; return n; });
    for (const key of keys) { try { await fetch("/api/finance/fb-estimate", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) }); } catch { /* best effort */ } }
  }

  // One shared calc (same one the Projections tab uses, so the numbers match).
  const { providerRows: rows, mgmtFee, onboardingManual, onboarding, revenue, expLines, costs, net, yourProfit } = computeFbEstimate({ providers, est, onboardingStripe, salaries, taggedItems });
  const seededNames = providers.map((p) => p.name);
  const customNames = rows.filter((r) => r.custom).map((r) => r.name);

  const Num = ({ k, value, w = "w-24" }: { k: string; value: number; w?: string }) => (
    <input type="text" inputMode="decimal" defaultValue={value.toLocaleString("en-US")}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => save(k, clean(e.currentTarget.value))}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      className={w + " text-[13px] text-right tabular-nums rounded-lg border border-slate-200 px-2 py-1 focus:outline-none focus:border-slate-400"} />
  );

  function addProvider() {
    const name = newProv.trim();
    if (!name || seededNames.includes(name) || customNames.includes(name)) return;
    save(SPEND(name), 0); save(FEE(name), 20);
    setNewProv("");
  }
  function addExpense() {
    const label = newExp.trim(); const amount = clean(newExpAmt);
    if (!label || amount <= 0) return;
    save(EXP + label, amount); setNewExp(""); setNewExpAmt("");
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[16px] font-semibold text-slate-900">{monthLabel} Facebook profit estimate</div>
          <div className="text-[12px] text-slate-500 mt-0.5">Editable P&amp;L — ad spend per provider &amp; costs. Your 50% after the partner split.</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] text-slate-400">Your estimated profit (50%)</div>
          <div className={"text-[26px] font-bold tabular-nums leading-none mt-0.5 " + (yourProfit < 0 ? "text-rose-500" : "text-emerald-600")}>{money(yourProfit)}</div>
          <div className="text-[11px] text-slate-400 mt-1">of {money(net)} net</div>
        </div>
      </div>

      {/* REVENUE — ad spend per provider */}
      <div className="mt-5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Revenue · ad spend by provider</div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-slate-400 text-left text-[10px] uppercase tracking-wider border-b border-slate-100">
            <th className="font-medium pb-1.5">Provider</th>
            <th className="font-medium pb-1.5 px-2 text-right">Ad spend</th>
            <th className="font-medium pb-1.5 px-2 text-right w-[70px]">Fee %</th>
            <th className="font-medium pb-1.5 pl-2 text-right">Fee</th>
            <th className="w-6" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-b border-slate-50">
              <td className="py-1.5 text-slate-700 truncate max-w-[150px]">{r.name}</td>
              <td className="py-1.5 px-2 text-right"><span className="text-slate-400 text-[11px]">$</span> <Num k={SPEND(r.name)} value={r.spend} w="w-24" /></td>
              <td className="py-1.5 px-2 text-right"><Num k={FEE(r.name)} value={r.feePct} w="w-12" /></td>
              <td className="py-1.5 pl-2 text-right tabular-nums font-semibold text-slate-900">{money(r.fee)}</td>
              <td className="py-1.5 text-right">{r.custom && <button type="button" onClick={() => removeKey(SPEND(r.name), FEE(r.name))} className="text-slate-300 hover:text-rose-500"><X className="w-3.5 h-3.5" /></button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-2 mt-2">
        <input value={newProv} onChange={(e) => setNewProv(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addProvider(); }}
          placeholder="Add a provider / ad account" className="flex-1 min-w-[160px] text-[12px] rounded-lg border border-slate-200 px-2.5 py-1.5 focus:outline-none focus:border-slate-400" />
        <button type="button" onClick={addProvider} disabled={!newProv.trim()} className="text-[12px] font-medium text-white bg-slate-900 rounded-lg px-3 py-1.5 hover:bg-slate-800 disabled:opacity-50">Add</button>
      </div>
      <div className="flex items-center justify-between py-1.5 mt-1 text-[13px] font-medium text-slate-700">
        <span>Management fee</span><span className="tabular-nums">{money(mgmtFee)}</span>
      </div>

      {/* Onboarding */}
      <div className="flex items-center justify-between py-1.5 text-[13px] border-t border-slate-100">
        <div><span className="text-slate-700">Onboarding — Stripe tagged</span><div className="text-[11px] text-slate-400">Tag one-offs &lsquo;Onboarding&rsquo; below</div></div>
        <span className="tabular-nums font-medium text-slate-900">{money(onboardingStripe)}</span>
      </div>
      <div className="flex items-center justify-between py-1.5 text-[13px]">
        <span className="text-slate-700">Onboarding — manual</span>
        <span><span className="text-slate-400 text-[11px]">$</span> <Num k="onboarding_manual" value={onboardingManual} /></span>
      </div>
      <div className="flex items-center justify-between py-2 text-[13px] font-semibold text-slate-900 border-t border-slate-200">
        <span>Facebook revenue</span><span className="tabular-nums">{money(revenue)}</span>
      </div>

      {/* COSTS — line items */}
      <div className="mt-5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Costs</div>
      <div className="flex items-center justify-between py-1.5 text-[13px] border-b border-slate-50">
        <div><span className="text-slate-700">Facebook salaries</span><div className="text-[11px] text-slate-400">Roster people tagged Facebook</div></div>
        <span className="tabular-nums font-medium text-slate-900">{money(salaries)}</span>
      </div>
      {/* Editable expense lines — seeded from last month's tagged FB expenses,
          each an estimate you set for this month, plus vendors you add. */}
      {expLines.map((l) => (
        <div key={l.key} className="flex items-center justify-between py-1.5 text-[13px] border-b border-slate-50">
          <span className="inline-flex items-center gap-2 min-w-0">
            <span className="text-slate-700 truncate">{l.label}</span>
            {l.seeded
              ? <span className="text-[10px] text-slate-400 shrink-0">was {money(l.lastMonth)}</span>
              : <span className="text-[10px] font-medium uppercase tracking-wide text-amber-600 bg-amber-50 rounded px-1.5 py-0.5 shrink-0">estimate</span>}
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="text-slate-400 text-[11px]">$</span> <Num k={l.key} value={l.amount} w="w-24" />
            {l.seeded
              ? <span className="w-3.5" />
              : <button type="button" onClick={() => removeKey(l.key)} title="Remove" className="text-slate-300 hover:text-rose-500"><X className="w-3.5 h-3.5" /></button>}
          </span>
        </div>
      ))}
      <div className="flex items-center gap-2 mt-2">
        <input value={newExp} onChange={(e) => setNewExp(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addExpense(); }}
          placeholder="Add a vendor / cost (e.g. Ads with Finnesse)" className="flex-1 min-w-[160px] text-[12px] rounded-lg border border-slate-200 px-2.5 py-1.5 focus:outline-none focus:border-slate-400" />
        <span className="inline-flex items-center gap-1"><span className="text-[13px] text-slate-400">$</span>
          <input value={newExpAmt} onChange={(e) => setNewExpAmt(e.target.value.replace(/[^0-9.]/g, ""))} onKeyDown={(e) => { if (e.key === "Enter") addExpense(); }}
            placeholder="amount" inputMode="decimal" className="w-24 text-[12px] text-right tabular-nums rounded-lg border border-slate-200 px-2 py-1.5 focus:outline-none focus:border-slate-400" /></span>
        <button type="button" onClick={addExpense} disabled={!newExp.trim() || !(Number(newExpAmt) > 0)} className="text-[12px] font-medium text-white bg-slate-900 rounded-lg px-3 py-1.5 hover:bg-slate-800 disabled:opacity-50">Add</button>
      </div>
      <div className="flex items-center justify-between py-2 text-[13px] font-semibold text-slate-900 border-t border-slate-200 mt-1">
        <span>Facebook costs</span><span className="tabular-nums">{money(costs)}</span>
      </div>

      {/* Bottom line */}
      <div className="flex items-center justify-between py-3 mt-2 border-t-2 border-slate-200 text-[15px] font-bold text-slate-900">
        <span>Net · {money(revenue)} − {money(costs)}</span><span className="tabular-nums">{money(net)}</span>
      </div>
      <div className="flex items-center justify-between text-[13px] font-semibold">
        <span className="text-slate-500">Your profit (50%)</span>
        <span className={"tabular-nums " + (yourProfit < 0 ? "text-rose-500" : "text-emerald-600")}>{money(yourProfit)}</span>
      </div>
    </div>
  );
}
