"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ExpenseLeaf } from "@/lib/pnl-parse";
import type { Segment } from "@/lib/finance-segments";
import { SOFTWARE_LINE } from "@/lib/finance-segments";
import { SegmentToggle, money } from "@/components/SegmentToggle";

// Assign which expenses are Facebook. Two lists: P&L expense lines (the software
// lump and the owner salary are handled separately) and software vendors (the
// itemized software lump). What's tagged Facebook feeds the Facebook side above.

export interface SoftwareRow { vendor: string; month: string; amount: number; segment: Segment }

const isSalary = (a: string) => a.toLowerCase().includes("mitchell price");

export function ExpenseLabels({ lines, lineInitial, software, latestShort }: {
  lines: ExpenseLeaf[];
  lineInitial: Record<string, Segment>;
  software: SoftwareRow[];
  latestShort: string; // e.g. "aug"
}) {
  const [open, setOpen] = useState(false);
  const [lineSeg, setLineSeg] = useState<Record<string, Segment>>(lineInitial);
  const [swSeg, setSwSeg] = useState<Record<string, Segment>>(() => {
    const m: Record<string, Segment> = {};
    for (const s of software) m[s.vendor] = s.segment;
    return m;
  });

  const pnlLines = useMemo(
    () => lines.filter((l) => l.amount !== 0 && l.account !== SOFTWARE_LINE && !isSalary(l.account)).sort((a, b) => b.amount - a.amount),
    [lines]
  );
  const swVendors = useMemo(() => {
    const by = new Map<string, number>();
    for (const s of software) if (s.month.slice(0, 3).toLowerCase() === latestShort) by.set(s.vendor, (by.get(s.vendor) ?? 0) + Number(s.amount));
    return [...by.entries()].map(([vendor, amount]) => ({ vendor, amount })).filter((v) => v.amount !== 0).sort((a, b) => b.amount - a.amount);
  }, [software, latestShort]);

  const fbLineTotal = pnlLines.filter((l) => (lineSeg[l.account] ?? "seo") === "facebook").reduce((s, l) => s + l.amount, 0);
  const fbSwTotal = swVendors.filter((v) => (swSeg[v.vendor] ?? "seo") === "facebook").reduce((s, v) => s + v.amount, 0);

  async function saveLine(account: string, segment: Segment) {
    setLineSeg((s) => ({ ...s, [account]: segment }));
    try { await fetch("/api/finance/expense-segment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account, segment }) }); } catch { /* best effort */ }
  }
  async function saveSw(vendor: string, segment: Segment) {
    setSwSeg((s) => ({ ...s, [vendor]: segment }));
    try { await fetch("/api/finance/software-segment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vendor, segment }) }); } catch { /* best effort */ }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-start gap-1.5 text-left min-w-0">
          <ChevronDown className={"w-4 h-4 text-slate-400 mt-1 shrink-0 transition-transform " + (open ? "rotate-180" : "-rotate-90")} />
          <div>
            <div className="text-[16px] font-semibold text-slate-900">Assign Facebook expenses</div>
            <div className="text-[12px] text-slate-500 mt-0.5">Tag P&amp;L lines &amp; software that are Facebook · tap to {open ? "collapse" : "expand"}</div>
          </div>
        </button>
        <div className="text-right shrink-0">
          <div className="text-[11px] text-slate-400">Tagged Facebook ({latestShort.replace(/^\w/, (c) => c.toUpperCase())})</div>
          <div className="text-[20px] font-bold tabular-nums text-blue-600 leading-none mt-0.5">{money(fbLineTotal + fbSwTotal)}</div>
        </div>
      </div>

      {open && (<div className="mt-4">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">P&amp;L expense lines</div>
      <div className="divide-y divide-slate-100">
        {pnlLines.map((l) => (
          <div key={l.account} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-slate-900 truncate">{l.account}</div>
              <div className="text-[11px] text-slate-400 truncate">{l.category !== l.account ? l.category : "expense"} · {money(l.amount)}</div>
            </div>
            <SegmentToggle value={lineSeg[l.account] ?? "seo"} onChange={(s) => saveLine(l.account, s)} />
          </div>
        ))}
      </div>

      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mt-5 mb-1.5">Software vendors (the Software/Subscriptions line)</div>
      <div className="divide-y divide-slate-100 max-h-[26rem] overflow-y-auto">
        {swVendors.map((v) => (
          <div key={v.vendor} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-slate-900 truncate">{v.vendor}</div>
              <div className="text-[11px] text-slate-400">{money(v.amount)}</div>
            </div>
            <SegmentToggle value={swSeg[v.vendor] ?? "seo"} onChange={(s) => saveSw(v.vendor, s)} />
          </div>
        ))}
      </div>
      </div>)}
    </div>
  );
}
