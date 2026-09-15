"use client";

import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";

// Editable payroll / contractor table (owner-only), seeded from the People
// report. This is the Contractor Payments + payroll line, broken down by
// person. Total = monthly-equivalent of every ACTIVE person.

export interface PayrollEntry {
  id: string;
  name: string;
  role: string | null;
  status: "active" | "inactive" | "onboarding" | "invited" | "owner-draw";
  scale: "monthly" | "annual";
  rate: number;
  note: string | null;
  rank: number | null;
}

const STATUS_OPTS: PayrollEntry["status"][] = ["active", "owner-draw", "onboarding", "invited", "inactive"];
const STATUS_STYLE: Record<PayrollEntry["status"], string> = {
  active: "bg-emerald-100 text-emerald-700",
  "owner-draw": "bg-violet-100 text-violet-700",
  onboarding: "bg-amber-100 text-amber-700",
  invited: "bg-indigo-100 text-indigo-700",
  inactive: "bg-slate-200 text-slate-500"
};

const monthlyOf = (r: PayrollEntry) => (r.scale === "annual" ? Number(r.rate) / 12 : Number(r.rate));
function money(n: number): string { return `$${Math.round(n).toLocaleString("en-US")}`; }

export function PayrollManual({ initial }: { initial: PayrollEntry[] }) {
  const [rows, setRows] = useState<PayrollEntry[]>(initial);
  const [adding, setAdding] = useState(false);
  // Rows added in this session — pinned to the top so a new $0 hire is visible
  // to fill in, instead of sinking to the bottom of the pay-sorted list.
  const [newIds, setNewIds] = useState<string[]>([]);

  const totals = useMemo(() => {
    let activeMo = 0, activeCount = 0, otherCount = 0, drawMo = 0;
    for (const r of rows) {
      if (r.status === "active") { activeMo += monthlyOf(r); activeCount++; }
      else if (r.status === "owner-draw") { drawMo += monthlyOf(r); }
      else otherCount++;
    }
    return { activeMo, activeCount, otherCount, drawMo };
  }, [rows]);

  async function patch(id: string, field: Partial<PayrollEntry>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...field } : r)));
    await fetch(`/api/finance/payroll/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(field)
    });
  }
  async function remove(id: string) {
    setRows((rs) => rs.filter((r) => r.id !== id));
    await fetch(`/api/finance/payroll/${id}`, { method: "DELETE" });
  }
  async function add() {
    setAdding(true);
    try {
      const res = await fetch("/api/finance/payroll", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New hire", role: "", status: "active", scale: "monthly", rate: 0 })
      });
      const j = await res.json();
      if (j.entry) { setRows((rs) => [j.entry, ...rs]); setNewIds((ids) => [j.entry.id, ...ids]); }
    } finally { setAdding(false); }
  }

  const sorted = [...rows].sort((a, b) => {
    // Session-added rows first (newest first) so they're visible to edit.
    const an = newIds.indexOf(a.id), bn = newIds.indexOf(b.id);
    if (an !== -1 || bn !== -1) {
      if (an === -1) return 1;
      if (bn === -1) return -1;
      return an - bn;
    }
    const act = (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1);
    if (act) return act;
    return monthlyOf(b) - monthlyOf(a);
  });

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div>
          <div className="text-[13px] font-semibold text-ink flex items-center gap-2">
            Payroll &amp; contractors <span className="text-[10px] font-medium uppercase tracking-wide text-indigo-600 bg-indigo-50 rounded px-1.5 py-0.5">manual</span>
          </div>
          <div className="text-[11px] text-muted mt-0.5">The Contractor Payments + payroll line, by person. Click any field to edit.</div>
        </div>
        <div className="flex items-baseline gap-3">
          <div className="text-right">
            <div className="text-2xl font-bold tabular-nums text-ink leading-none">{money(totals.activeMo)}<span className="text-[12px] font-medium text-muted">/mo</span></div>
            <div className="text-[10px] text-muted mt-0.5">
              {totals.activeCount} active · {money(totals.activeMo * 12)}/yr{totals.otherCount ? ` · ${totals.otherCount} inactive/pending` : ""}
              {totals.drawMo > 0 && <> · <span className="text-violet-600">+{money(totals.drawMo)}/mo owner draw</span></>}
            </div>
          </div>
          <button type="button" onClick={add} disabled={adding} className="flex items-center gap-1 text-[12px] font-medium text-white bg-ink rounded-lg px-2.5 py-1.5 hover:opacity-90 disabled:opacity-50">
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12px] min-w-[640px]">
          <thead>
            <tr className="text-muted text-left text-[10px] uppercase tracking-wide border-b border-slate-200">
              <th className="font-medium pb-1.5 pr-2">Name</th>
              <th className="font-medium pb-1.5 px-2">Role</th>
              <th className="font-medium pb-1.5 px-2 w-[100px]">Status</th>
              <th className="font-medium pb-1.5 px-2 text-right w-[90px]">Rate</th>
              <th className="font-medium pb-1.5 px-2 w-[80px]">Scale</th>
              <th className="font-medium pb-1.5 px-2 text-right w-[80px]">$/mo</th>
              <th className="font-medium pb-1.5 pl-2 w-[36px]"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const dim = r.status !== "active" && r.status !== "owner-draw";
              return (
                <tr key={r.id} className={"border-b border-slate-100 group " + (dim ? "opacity-55" : "")}>
                  <td className="py-1 pr-2">
                    <input defaultValue={r.name} onBlur={(e) => e.target.value.trim() !== r.name && patch(r.id, { name: e.target.value.trim() })}
                      className="w-full bg-transparent rounded px-1 py-0.5 text-ink font-medium hover:bg-slate-50 focus:bg-slate-100 focus:outline-none" />
                  </td>
                  <td className="py-1 px-2">
                    <input defaultValue={r.role ?? ""} placeholder="—" onBlur={(e) => (e.target.value.trim() || null) !== (r.role ?? null) && patch(r.id, { role: e.target.value.trim() || null })}
                      className="w-full bg-transparent rounded px-1 py-0.5 text-slate-600 hover:bg-slate-50 focus:bg-slate-100 focus:outline-none" />
                  </td>
                  <td className="py-1 px-2">
                    <select value={r.status} onChange={(e) => patch(r.id, { status: e.target.value as PayrollEntry["status"] })}
                      className={"rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide border-0 cursor-pointer focus:outline-none " + STATUS_STYLE[r.status]}>
                      {STATUS_OPTS.map((s) => <option key={s} value={s} className="bg-white text-ink normal-case">{s}</option>)}
                    </select>
                  </td>
                  <td className="py-1 px-2 text-right">
                    <div className="flex items-center justify-end">
                      <span className="text-muted">$</span>
                      <input type="number" defaultValue={r.rate} onBlur={(e) => Number(e.target.value) !== Number(r.rate) && patch(r.id, { rate: Number(e.target.value) || 0 })}
                        className="w-[64px] bg-transparent rounded px-0.5 py-0.5 text-right tabular-nums text-ink hover:bg-slate-50 focus:bg-slate-100 focus:outline-none" />
                    </div>
                  </td>
                  <td className="py-1 px-2">
                    <select value={r.scale} onChange={(e) => patch(r.id, { scale: e.target.value as PayrollEntry["scale"] })}
                      className="text-[11px] rounded border border-slate-200 bg-white px-1 py-0.5 text-slate-600 cursor-pointer focus:outline-none">
                      <option value="monthly">/mo</option>
                      <option value="annual">/yr</option>
                    </select>
                  </td>
                  <td className="py-1 px-2 text-right tabular-nums font-medium text-ink">{money(monthlyOf(r))}</td>
                  <td className="py-1 pl-2 text-right">
                    <button type="button" onClick={() => remove(r.id)} title="Remove" className="text-slate-300 hover:text-rose-600 opacity-0 group-hover:opacity-100 transition-opacity">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-[11px] text-muted">Total counts monthly-equivalent of ACTIVE people (annual ÷ 12). &quot;Owner draw&quot; (your own pay) is tracked but excluded — it&apos;s a distribution of profit, not a business cost. Set someone inactive to drop them without deleting.</div>
    </div>
  );
}
