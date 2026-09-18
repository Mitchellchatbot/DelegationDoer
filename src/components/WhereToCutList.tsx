"use client";

import { useState } from "react";
import { TrendingUp, Check } from "lucide-react";
import type { RisingRow } from "@/lib/finance-overview";

// The rising-cost list with a learning loop: mark each cost Keep or Cut and the
// finance brain remembers (writes to memory), drops it from this list, and the
// finance chat knows what you're trimming.

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function Row({ row }: { row: RisingRow }) {
  const [open, setOpen] = useState<null | "keep" | "cut">(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<null | "keep" | "cut">(null);

  async function decide(action: "keep" | "cut") {
    setSaving(true);
    try {
      const res = await fetch("/api/brain/finance/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, name: row.name, note: note.trim() })
      });
      if (res.ok) { setDone(action); setOpen(null); }
    } catch { /* best effort */ } finally { setSaving(false); }
  }

  if (done) {
    return (
      <div className="flex items-center gap-1.5 py-2.5 text-[12px] text-emerald-600">
        <Check className="w-3.5 h-3.5" /> {done === "cut" ? `Marked ${row.name} as cutting` : `Keeping ${row.name}`} — the brain will remember.
      </div>
    );
  }

  return (
    <div className="py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-slate-900 truncate">{row.name}</div>
          <div className="text-[11.5px] text-slate-400">{row.kind === "software" ? "software" : "expense"} · {money(row.from)} → {money(row.to)}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-rose-600"><TrendingUp className="w-3.5 h-3.5" /> +{row.deltaPct}%</span>
          <button type="button" onClick={() => setOpen(open === "cut" ? null : "cut")} className="text-[12px] font-medium text-slate-700 border border-slate-200 rounded-lg px-2.5 py-1 hover:bg-slate-50">Cut</button>
          <button type="button" onClick={() => setOpen(open === "keep" ? null : "keep")} className="text-[12px] font-medium text-slate-500 rounded-lg px-2 py-1 hover:bg-slate-50">Keep</button>
        </div>
      </div>
      {open && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !saving) decide(open); }}
            placeholder={open === "cut" ? "Optional: how you're cutting it (cancel, downgrade, renegotiate)…" : "Optional: why it's worth keeping…"}
            className="flex-1 min-w-[220px] text-[12px] rounded-lg border border-slate-200 px-2.5 py-1.5 focus:outline-none focus:border-slate-400"
          />
          <button type="button" onClick={() => decide(open)} disabled={saving}
            className="text-[12px] font-medium text-white bg-slate-900 rounded-lg px-3 py-1.5 hover:bg-slate-800 disabled:opacity-50">
            {saving ? "Saving…" : open === "cut" ? "Mark as cutting" : "Keep it"}
          </button>
          <button type="button" onClick={() => { setOpen(null); setNote(""); }} className="text-[12px] text-slate-400 hover:text-slate-700">Cancel</button>
        </div>
      )}
    </div>
  );
}

export function WhereToCutList({ rows }: { rows: RisingRow[] }) {
  if (rows.length === 0) {
    return <div className="text-[13px] text-slate-500">No costs rose month-over-month. Nothing jumping out to cut right now.</div>;
  }
  return (
    <div className="divide-y divide-slate-100">
      {rows.map((r, i) => <Row key={`${r.name}-${i}`} row={r} />)}
    </div>
  );
}
