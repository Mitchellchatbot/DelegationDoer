"use client";

import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ParsedPnl } from "@/lib/pnl-parse";

// Full drill-down of every expense line. Each top-level category expands to
// its individual sub-items / vendors so Mitchell can see exactly where every
// dollar goes and decide what to cut. Client component (expand/collapse).

function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

interface Leaf {
  account: string;
  total: number;
}
interface Cat {
  account: string;
  total: number;
  children: Leaf[];
}

function buildTree(parsed: ParsedPnl): { cats: Cat[]; totalExpenses: number } {
  const periods = parsed.periods;
  const hasTotalCol = periods[periods.length - 1]?.toLowerCase() === "total";
  const idx = hasTotalCol ? periods.length - 1 : periods.length - 1; // last col either way
  const rows = parsed.rows;

  const startI = rows.findIndex((r) => r.account.toUpperCase() === "EXPENSES");
  const endI = rows.findIndex((r) => r.account.toLowerCase() === "total expenses");
  const cats: Cat[] = [];
  if (startI >= 0 && endI > startI) {
    for (let i = startI + 1; i < endI; i++) {
      const r = rows[i];
      if (r.level !== 1) continue;
      // Gather children (deeper levels) until the next level-1 row.
      const children: Leaf[] = [];
      let totalChild: number | null = null;
      let j = i + 1;
      for (; j < endI && rows[j].level > 1; j++) {
        const c = rows[j];
        const lower = c.account.toLowerCase();
        if (lower === `total ${r.account.toLowerCase()}`) {
          totalChild = c.values[idx] ?? null;
          continue; // don't list the "Total X" row as a child
        }
        const v = c.values[idx] ?? 0;
        children.push({ account: c.account, total: v });
      }
      // The category's own row is often 0 with the real figure in its
      // "Total X" child; fall back to that (then to summing children).
      let total = r.values[idx] ?? 0;
      if (!total && totalChild != null) total = totalChild;
      if (!total && children.length) total = children.reduce((s, c) => s + c.total, 0);
      if (total || children.length) cats.push({ account: r.account, total, children });
    }
  }
  cats.sort((a, b) => b.total - a.total);
  const totalExpenses = parsed.summary.expenses[idx] ?? cats.reduce((s, c) => s + c.total, 0);
  return { cats, totalExpenses };
}

export function ExpenseBreakdown({ parsed }: { parsed: ParsedPnl | null | undefined }) {
  const tree = useMemo(() => (parsed ? buildTree(parsed) : null), [parsed]);
  // Expand the biggest categories by default so the detail is visible on load.
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    if (!parsed) return {};
    const t = buildTree(parsed);
    const init: Record<string, boolean> = {};
    t.cats.slice(0, 3).forEach((c) => {
      if (c.children.length) init[c.account] = true;
    });
    return init;
  });

  if (!tree || !tree.cats.length) return null;
  const { cats, totalExpenses } = tree;
  const maxCat = cats[0]?.total || 1;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-[13px] font-semibold text-ink">Every expense · line by line</div>
        <div className="text-[11px] text-muted tabular-nums">
          {money(totalExpenses)} total · click to expand
        </div>
      </div>

      <div className="space-y-1">
        {cats.map((cat) => {
          const isOpen = !!open[cat.account];
          const pct = totalExpenses ? (cat.total / totalExpenses) * 100 : 0;
          const w = maxCat ? (cat.total / maxCat) * 100 : 0;
          const hasChildren = cat.children.length > 0;
          const sortedChildren = [...cat.children].sort((a, b) => b.total - a.total);
          return (
            <div key={cat.account} className="border-b border-slate-100 last:border-0 pb-1">
              <button
                type="button"
                onClick={() => hasChildren && setOpen((o) => ({ ...o, [cat.account]: !o[cat.account] }))}
                className={
                  "w-full text-left py-1.5 rounded-lg transition-colors " +
                  (hasChildren ? "hover:bg-slate-50 cursor-pointer" : "cursor-default")
                }
              >
                <div className="flex items-baseline justify-between gap-2 px-1">
                  <span className="flex items-center gap-1 min-w-0">
                    {hasChildren ? (
                      <ChevronRight
                        className={"w-3.5 h-3.5 text-muted shrink-0 transition-transform " + (isOpen ? "rotate-90" : "")}
                      />
                    ) : (
                      <span className="w-3.5 shrink-0" />
                    )}
                    <span className="text-[13px] font-medium text-ink truncate">{cat.account}</span>
                    {hasChildren && (
                      <span className="text-[10px] text-muted shrink-0">({cat.children.length})</span>
                    )}
                  </span>
                  <span className="text-[12px] text-muted tabular-nums shrink-0">
                    {money(cat.total)} · {pct.toFixed(0)}%
                  </span>
                </div>
                <div className="mt-1 ml-[18px] h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div className="h-full rounded-full bg-accent/70" style={{ width: `${Math.max(w, 2)}%` }} />
                </div>
              </button>

              {isOpen && hasChildren && (
                <div className="ml-[26px] mt-1 mb-2 space-y-0.5 border-l border-slate-100 pl-3">
                  {sortedChildren.map((leaf) => {
                    const lpct = cat.total ? (leaf.total / cat.total) * 100 : 0;
                    return (
                      <div
                        key={leaf.account}
                        className="flex items-baseline justify-between gap-2 py-0.5 text-[12px]"
                      >
                        <span className="text-slate-600 truncate">{leaf.account}</span>
                        <span className="tabular-nums shrink-0 text-slate-500">
                          {money(leaf.total)}
                          <span className="text-slate-400"> · {lpct.toFixed(0)}%</span>
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
    </div>
  );
}
