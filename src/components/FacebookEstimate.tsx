"use client";

import { useState } from "react";

// September Facebook profit estimate (owner-only). Your 50% of:
//   management fee (estimated ad spend × blended fee rate)
//   + onboarding (Stripe one-offs you tag Facebook — added separately)
//   − Facebook salaries (tagged on the roster) − operating costs − added costs.
// Ad spend, operating expense and added costs are editable and saved to
// fb_estimate; onboarding and salaries are read live.

const EXP = "exp::";

function money(n: number): string {
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}
const clean = (raw: string) => Math.max(0, Math.round(Number(String(raw).replace(/[^0-9.]/g, "")) || 0));

export function FacebookEstimate({ monthLabel, runRateSpend, blendedRate, onboarding, salaries, opexDefault, initial }: {
  monthLabel: string;
  runRateSpend: number;
  blendedRate: number;   // fee fraction, e.g. 0.19
  onboarding: number;    // Stripe one-offs tagged Facebook this month (read-only)
  salaries: number;      // Facebook-tagged roster salaries (read-only)
  opexDefault: number;
  initial: Record<string, number>;
}) {
  const [est, setEst] = useState<Record<string, number>>(initial);
  const [newName, setNewName] = useState("");
  const [newAmt, setNewAmt] = useState("");

  const adSpend = "ad_spend" in est ? est.ad_spend : Math.round(runRateSpend);
  const opex = "opex" in est ? est.opex : Math.round(opexDefault);
  const added = Object.keys(est).filter((k) => k.startsWith(EXP) && est[k] > 0).map((k) => ({ key: k, label: k.slice(EXP.length), amount: est[k] }));

  const fee = Math.round(adSpend * blendedRate);
  const revenue = fee + onboarding;
  const addedSum = added.reduce((s, a) => s + a.amount, 0);
  const costs = salaries + opex + addedSum;
  const net = revenue - costs;
  const yourProfit = Math.round(net * 0.5);

  async function save(key: string, value: number) {
    setEst((e) => ({ ...e, [key]: value }));
    try {
      await fetch("/api/finance/fb-estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value }) });
    } catch { /* best effort */ }
  }
  async function removeKey(key: string) {
    setEst((e) => { const n = { ...e }; delete n[key]; return n; });
    try {
      await fetch("/api/finance/fb-estimate", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
    } catch { /* best effort */ }
  }
  function addExpense() {
    const label = newName.trim();
    const amount = clean(newAmt);
    if (!label || amount <= 0) return;
    save(EXP + label, amount);
    setNewName(""); setNewAmt("");
  }

  const NumInput = ({ k, value }: { k: string; value: number }) => (
    <span className="inline-flex items-center gap-0.5">
      <span className="text-[12px] text-slate-400">$</span>
      <input
        type="text"
        inputMode="decimal"
        defaultValue={value.toLocaleString("en-US")}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => save(k, clean(e.currentTarget.value))}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        className="w-24 text-[13px] text-right tabular-nums rounded-lg border border-slate-200 px-2 py-1 focus:outline-none focus:border-slate-400"
      />
    </span>
  );

  const Row = ({ label, sub, children }: { label: string; sub?: string; children: React.ReactNode }) => (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-slate-50 last:border-0">
      <div className="min-w-0">
        <div className="text-[13px] text-slate-700">{label}</div>
        {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[16px] font-semibold text-slate-900">{monthLabel} Facebook profit estimate</div>
          <div className="text-[12px] text-slate-500 mt-0.5">Estimate ad spend &amp; costs — your 50% after the partner split. Onboarding &amp; salaries pull in live.</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] text-slate-400">Your estimated profit (50%)</div>
          <div className={"text-[26px] font-bold tabular-nums leading-none mt-0.5 " + (yourProfit < 0 ? "text-rose-500" : "text-emerald-600")}>{money(yourProfit)}</div>
          <div className="text-[11px] text-slate-400 mt-1">of {money(net)} net</div>
        </div>
      </div>

      <div className="mt-4">
        {/* Revenue */}
        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Revenue</div>
        <Row label="Ad spend (estimate)" sub={`× ${(blendedRate * 100).toFixed(0)}% fee = ${money(fee)} management fee · run-rate ${money(runRateSpend)}`}>
          <NumInput k="ad_spend" value={adSpend} />
        </Row>
        <Row label="Onboarding (Stripe one-offs)" sub="Tag a one-off 'Onboarding' below — your 50% is added">
          <span className="text-[13px] tabular-nums font-medium text-slate-900">{money(onboarding)}</span>
        </Row>
        <div className="flex items-center justify-between py-2 text-[13px] font-semibold text-slate-900 border-t border-slate-200 mt-1">
          <span>Facebook revenue</span><span className="tabular-nums">{money(revenue)}</span>
        </div>

        {/* Costs */}
        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1 mt-4">Costs</div>
        <Row label="Facebook salaries" sub="From the roster (tagged Facebook)">
          <span className="text-[13px] tabular-nums font-medium text-slate-900">{money(salaries)}</span>
        </Row>
        <Row label="Operating expense (estimate)" sub="Defaults to your tagged Facebook expenses · edit to override">
          <NumInput k="opex" value={opex} />
        </Row>
        {added.map((a) => (
          <Row key={a.key} label={a.label} sub="added cost">
            <span className="inline-flex items-center gap-2">
              <span className="text-[13px] tabular-nums font-medium text-slate-900">{money(a.amount)}</span>
              <button type="button" onClick={() => removeKey(a.key)} className="text-[11px] text-slate-400 hover:text-rose-500">remove</button>
            </span>
          </Row>
        ))}
        <div className="flex items-center justify-between py-2 text-[13px] font-semibold text-slate-900 border-t border-slate-200 mt-1">
          <span>Facebook costs</span><span className="tabular-nums">{money(costs)}</span>
        </div>

        {/* Add a cost */}
        <div className="flex items-center gap-2 flex-wrap mt-3">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addExpense(); }}
            placeholder="Add a cost (e.g. new tool, freelancer)"
            className="flex-1 min-w-[180px] text-[13px] rounded-lg border border-slate-200 px-2.5 py-1.5 focus:outline-none focus:border-slate-400" />
          <span className="inline-flex items-center gap-1">
            <span className="text-[13px] text-slate-400">$</span>
            <input value={newAmt} onChange={(e) => setNewAmt(e.target.value.replace(/[^0-9.]/g, ""))} onKeyDown={(e) => { if (e.key === "Enter") addExpense(); }}
              placeholder="amount" inputMode="decimal"
              className="w-24 text-[13px] text-right tabular-nums rounded-lg border border-slate-200 px-2 py-1.5 focus:outline-none focus:border-slate-400" />
          </span>
          <button type="button" onClick={addExpense} disabled={!newName.trim() || !(Number(newAmt) > 0)}
            className="text-[12px] font-medium text-white bg-slate-900 rounded-lg px-3 py-1.5 hover:bg-slate-800 disabled:opacity-50">Add</button>
        </div>

        {/* Bottom line */}
        <div className="flex items-center justify-between py-3 mt-3 border-t-2 border-slate-200 text-[15px] font-bold text-slate-900">
          <span>Net {money(revenue)} − {money(costs)}</span>
          <span className="tabular-nums">{money(net)}</span>
        </div>
        <div className="flex items-center justify-between text-[13px] font-semibold">
          <span className="text-slate-500">Your profit (50%)</span>
          <span className={"tabular-nums " + (yourProfit < 0 ? "text-rose-500" : "text-emerald-600")}>{money(yourProfit)}</span>
        </div>
      </div>
    </div>
  );
}
