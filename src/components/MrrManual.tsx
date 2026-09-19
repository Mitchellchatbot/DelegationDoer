"use client";

import { useMemo, useState } from "react";
import { Plus, X, Check, ChevronDown } from "lucide-react";

// Manually-maintained MRR list (owner's source of truth), seeded from the MRR
// Mastersheet. Everything is editable inline; a client can be marked "no longer
// subscribed" (churned) which drops it from the MRR total but keeps the record.

export interface MrrEntry {
  id: string;
  company: string;
  mrr: number;
  status: "active" | "pending" | "paused" | "churned";
  subscription_day: string | null;
  satisfaction: string | null;
  note: string | null;
  rank: number | null;
}

const STATUS_OPTS: MrrEntry["status"][] = ["active", "pending", "paused", "churned"];
const STATUS_STYLE: Record<MrrEntry["status"], string> = {
  active: "bg-emerald-100 text-emerald-700",
  pending: "bg-amber-100 text-amber-700",
  paused: "bg-slate-200 text-slate-600",
  churned: "bg-rose-100 text-rose-600"
};

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export function MrrManual({ initial }: { initial: MrrEntry[] }) {
  const [rows, setRows] = useState<MrrEntry[]>(initial);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [open, setOpen] = useState(false);
  const [newCompany, setNewCompany] = useState("");
  const [newMrr, setNewMrr] = useState("");

  const totals = useMemo(() => {
    let active = 0, pending = 0, churned = 0, live = 0;
    for (const r of rows) {
      if (r.status === "active" || r.status === "paused") { active += r.mrr; live += 1; }
      else if (r.status === "pending") pending += r.mrr;
      else if (r.status === "churned") churned += 1;
    }
    return { active, pending, churned, live };
  }, [rows]);

  async function patch(id: string, field: Partial<MrrEntry>) {
    setSaving((s) => ({ ...s, [id]: true }));
    // optimistic
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...field } : r)));
    try {
      await fetch(`/api/finance/mrr/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(field)
      });
    } finally {
      setSaving((s) => ({ ...s, [id]: false }));
    }
  }

  async function remove(id: string) {
    setRows((rs) => rs.filter((r) => r.id !== id));
    await fetch(`/api/finance/mrr/${id}`, { method: "DELETE" });
  }

  async function addClient() {
    const company = newCompany.trim();
    if (!company || adding) return;
    setAdding(true);
    try {
      const res = await fetch("/api/finance/mrr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company, mrr: Number(newMrr) || 0, status: "active" })
      });
      const j = await res.json();
      if (j.entry) {
        setRows((rs) => [j.entry, ...rs]);
        setNewCompany(""); setNewMrr(""); setShowAdd(false);
      } else {
        alert(j.error ? `Couldn't add: ${j.error}` : "Couldn't add the client — try again.");
      }
    } catch {
      alert("Couldn't add the client — network error.");
    } finally {
      setAdding(false);
    }
  }

  const sorted = [...rows].sort((a, b) => {
    const churn = (a.status === "churned" ? 1 : 0) - (b.status === "churned" ? 1 : 0);
    if (churn) return churn; // churned to the bottom
    // Brand-new / unfilled rows ($0) float to the top so a just-added client is
    // right there to fill in — not buried at the bottom by the mrr sort.
    const zero = (a.mrr === 0 ? 1 : 0) - (b.mrr === 0 ? 1 : 0);
    if (zero) return -zero;
    return b.mrr - a.mrr;
  });

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-start gap-1.5 text-left min-w-0">
          <ChevronDown className={"w-4 h-4 text-slate-400 mt-0.5 shrink-0 transition-transform " + (open ? "rotate-180" : "-rotate-90")} />
          <div>
            <div className="text-[13px] font-semibold text-ink flex items-center gap-2">
              MRR <span className="text-[10px] font-medium uppercase tracking-wide text-indigo-600 bg-indigo-50 rounded px-1.5 py-0.5">manual</span>
            </div>
            <div className="text-[11px] text-muted mt-0.5">Your source of truth · tap to {open ? "collapse" : "expand"}</div>
          </div>
        </button>
        <div className="flex items-baseline gap-3">
          <div className="text-right">
            <div className="text-2xl font-bold tabular-nums text-ink leading-none">{money(totals.active)}</div>
            <div className="text-[10px] text-muted mt-0.5">
              {totals.live} active
              {totals.pending > 0 && <> · <span className="text-amber-600">{money(totals.pending)} pending</span></>}
              {totals.churned > 0 && <> · {totals.churned} churned</>}
            </div>
          </div>
          <button
            type="button"
            onClick={() => { setOpen(true); setShowAdd((v) => !v); }}
            className="flex items-center gap-1 text-[12px] font-medium text-white bg-ink rounded-lg px-2.5 py-1.5 hover:opacity-90"
          >
            <Plus className="w-3.5 h-3.5" /> Add client
          </button>
        </div>
      </div>

      {open && (<>
      <div className="mt-3" />
      {showAdd && (
        <div className="flex items-center gap-2 mb-3 p-2.5 rounded-xl border border-slate-200 bg-slate-50 flex-wrap">
          <input
            autoFocus
            value={newCompany}
            onChange={(e) => setNewCompany(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addClient(); if (e.key === "Escape") setShowAdd(false); }}
            placeholder="Client / company name"
            className="flex-1 min-w-[180px] text-[13px] rounded-lg border border-slate-200 px-2.5 py-1.5 bg-white focus:outline-none focus:border-indigo-300"
          />
          <input
            value={newMrr}
            onChange={(e) => setNewMrr(e.target.value.replace(/[^0-9.]/g, ""))}
            onKeyDown={(e) => { if (e.key === "Enter") addClient(); if (e.key === "Escape") setShowAdd(false); }}
            placeholder="MRR $/mo"
            inputMode="decimal"
            className="w-28 text-[13px] rounded-lg border border-slate-200 px-2.5 py-1.5 bg-white focus:outline-none focus:border-indigo-300"
          />
          <button type="button" onClick={addClient} disabled={adding || !newCompany.trim()}
            className="text-[12px] font-medium text-white bg-ink rounded-lg px-3 py-1.5 hover:opacity-90 disabled:opacity-50">
            {adding ? "Adding…" : "Add"}
          </button>
          <button type="button" onClick={() => { setShowAdd(false); setNewCompany(""); setNewMrr(""); }} className="text-[12px] text-muted hover:text-ink">Cancel</button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-[12px] min-w-[560px]">
          <thead>
            <tr className="text-muted text-left text-[10px] uppercase tracking-wide border-b border-slate-200">
              <th className="font-medium pb-1.5 pr-2">Company</th>
              <th className="font-medium pb-1.5 px-2 text-right w-[90px]">MRR/mo</th>
              <th className="font-medium pb-1.5 px-2 w-[110px]">Status</th>
              <th className="font-medium pb-1.5 px-2">Note</th>
              <th className="font-medium pb-1.5 pl-2 w-[70px] text-right">Off</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const dim = r.status === "churned";
              return (
                <tr key={r.id} className={"border-b border-slate-100 group " + (dim ? "opacity-50" : "")}>
                  <td className="py-1 pr-2">
                    <input
                      defaultValue={r.company}
                      onBlur={(e) => e.target.value.trim() !== r.company && patch(r.id, { company: e.target.value.trim() })}
                      className="w-full bg-transparent rounded px-1 py-0.5 text-ink font-medium hover:bg-slate-50 focus:bg-slate-100 focus:outline-none"
                    />
                  </td>
                  <td className="py-1 px-2 text-right">
                    <div className="flex items-center justify-end">
                      <span className="text-muted">$</span>
                      <input
                        type="number"
                        defaultValue={r.mrr}
                        onBlur={(e) => Number(e.target.value) !== r.mrr && patch(r.id, { mrr: Number(e.target.value) || 0 })}
                        className="w-[64px] bg-transparent rounded px-0.5 py-0.5 text-right tabular-nums text-ink hover:bg-slate-50 focus:bg-slate-100 focus:outline-none"
                      />
                    </div>
                  </td>
                  <td className="py-1 px-2">
                    <select
                      value={r.status}
                      onChange={(e) => patch(r.id, { status: e.target.value as MrrEntry["status"] })}
                      className={"rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide border-0 cursor-pointer focus:outline-none " + STATUS_STYLE[r.status]}
                    >
                      {STATUS_OPTS.map((s) => (
                        <option key={s} value={s} className="bg-white text-ink normal-case">{s}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1 px-2">
                    <input
                      defaultValue={r.note ?? ""}
                      placeholder="—"
                      onBlur={(e) => (e.target.value.trim() || null) !== (r.note ?? null) && patch(r.id, { note: e.target.value.trim() || null })}
                      className="w-full bg-transparent rounded px-1 py-0.5 text-slate-500 hover:bg-slate-50 focus:bg-slate-100 focus:outline-none"
                    />
                  </td>
                  <td className="py-1 pl-2">
                    <div className="flex items-center justify-end gap-1">
                      {r.status !== "churned" ? (
                        <button
                          type="button"
                          onClick={() => patch(r.id, { status: "churned" })}
                          title="Mark no longer subscribed"
                          className="text-[10px] font-medium text-rose-600 hover:bg-rose-50 rounded px-1.5 py-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          Churn
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => patch(r.id, { status: "active" })}
                          title="Reactivate"
                          className="text-emerald-600 hover:bg-emerald-50 rounded p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => remove(r.id)}
                        title="Delete row"
                        className="text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-[11px] text-muted">
        MRR total counts Active + Paused. Pending and Churned are excluded. &quot;Churn&quot; drops a client from MRR but keeps the record; the × deletes it.
      </div>
      </>)}
    </div>
  );
}
