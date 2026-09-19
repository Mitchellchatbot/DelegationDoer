"use client";

import { useMemo, useState } from "react";
import { ChevronRight, ChevronDown, TrendingUp, TrendingDown } from "lucide-react";
import type { ParsedPnl } from "@/lib/pnl-parse";

// Full drill-down of every expense line. Each top-level category expands to
// its individual sub-items / vendors, and can be viewed either as a period
// total or month-by-month so Mitchell can see what's creeping up and decide
// what to cut. Client component (expand/collapse + view toggle).

function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "$0";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

interface Leaf {
  account: string;
  values: (number | null)[]; // aligned to `periods`
  total: number;
}
interface Cat extends Leaf {
  children: Leaf[];
}

// A rising cost is the thing to cut first. Compare the last month with the
// first; flag a meaningful move in either direction.
function trend(monthVals: (number | null)[]): "up" | "down" | null {
  const nums = monthVals.map((v) => v ?? 0);
  if (nums.length < 2) return null;
  const first = nums[0];
  const last = nums[nums.length - 1];
  const delta = last - first;
  if (Math.abs(delta) < 150) return null; // ignore noise
  if (first <= 0) return last > 150 ? "up" : null;
  const ratio = last / first;
  if (ratio >= 1.2) return "up";
  if (ratio <= 0.8) return "down";
  return null;
}

function buildTree(parsed: ParsedPnl): {
  cats: Cat[];
  months: string[];
  monthIdx: number[];
  totalIdx: number;
  totalExpenses: number;
} {
  const periods = parsed.periods;
  const hasTotalCol = periods[periods.length - 1]?.toLowerCase() === "total";
  const totalIdx = periods.length - 1;
  const monthIdx = periods.map((_, i) => i).filter((i) => !(hasTotalCol && i === totalIdx));
  const months = monthIdx.map((i) => periods[i]);
  const rows = parsed.rows;

  const catTotal = (r: { values: (number | null)[] }, tc: number | null, kids: Leaf[]) => {
    let t = r.values[totalIdx] ?? 0;
    if (!t && tc != null) t = tc;
    if (!t && kids.length) t = kids.reduce((s, c) => s + c.total, 0);
    return t;
  };

  const startI = rows.findIndex((r) => r.account.toUpperCase() === "EXPENSES");
  const endI = rows.findIndex((r) => r.account.toLowerCase() === "total expenses");
  const cats: Cat[] = [];
  if (startI >= 0 && endI > startI) {
    for (let i = startI + 1; i < endI; i++) {
      const r = rows[i];
      if (r.level !== 1) continue;
      const children: Leaf[] = [];
      let totalChildVals: (number | null)[] | null = null;
      let totalChild: number | null = null;
      let j = i + 1;
      for (; j < endI && rows[j].level > 1; j++) {
        const c = rows[j];
        const lower = c.account.toLowerCase();
        if (lower === `total ${r.account.toLowerCase()}`) {
          totalChild = c.values[totalIdx] ?? null;
          totalChildVals = c.values;
          continue;
        }
        children.push({ account: c.account, values: c.values, total: c.values[totalIdx] ?? 0 });
      }
      const total = catTotal(r, totalChild, children);
      // The category's per-month values: use its own row if populated, else the
      // "Total X" child row, else sum the children per month.
      const ownHasMonths = monthIdx.some((mi) => (r.values[mi] ?? 0) !== 0);
      let values: (number | null)[];
      if (ownHasMonths) values = r.values;
      else if (totalChildVals) values = totalChildVals;
      else
        values = periods.map((_, pi) =>
          children.reduce((s, c) => s + (c.values[pi] ?? 0), 0)
        );
      if (total || children.length) cats.push({ account: r.account, values, total, children });
    }
  }
  cats.sort((a, b) => b.total - a.total);
  const totalExpenses = parsed.summary.expenses[totalIdx] ?? cats.reduce((s, c) => s + c.total, 0);
  return { cats, months, monthIdx, totalIdx, totalExpenses };
}

export function ExpenseBreakdown({ parsed }: { parsed: ParsedPnl | null | undefined }) {
  const tree = useMemo(() => (parsed ? buildTree(parsed) : null), [parsed]);
  const [cardOpen, setCardOpen] = useState(false);
  const [byMonth, setByMonth] = useState(true);
  const [sortIdx, setSortIdx] = useState(-1); // -1 = Total column
  // Expand every category by default so all vendor line items are visible.
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    if (!parsed) return {};
    const t = buildTree(parsed);
    const init: Record<string, boolean> = {};
    t.cats.forEach((c) => {
      if (c.children.length) init[c.account] = true;
    });
    return init;
  });
  const setAll = (v: boolean) =>
    setOpen(() => {
      if (!tree) return {};
      const next: Record<string, boolean> = {};
      tree.cats.forEach((c) => {
        if (c.children.length) next[c.account] = v;
      });
      return next;
    });

  if (!tree || !tree.cats.length) return null;
  const { months, monthIdx, totalIdx, totalExpenses } = tree;
  // Sort by the Total column (default) or by a specific month when its header
  // is clicked. Falsy/negative -> Total.
  const sortKey = (r: Leaf) => (sortIdx >= 0 ? r.values[sortIdx] ?? 0 : r.total);
  const cats = [...tree.cats].sort((a, b) => sortKey(b) - sortKey(a));
  const maxCat = Math.max(1, ...cats.map((c) => c.total));
  const expandable = cats.filter((c) => c.children.length);
  const allOpen = expandable.length > 0 && expandable.every((c) => open[c.account]);

  const TrendIcon = ({ vals }: { vals: (number | null)[] }) => {
    const t = trend(monthIdx.map((i) => vals[i]));
    if (t === "up") return <TrendingUp className="w-3.5 h-3.5 text-rose-500 shrink-0" aria-label="rising" />;
    if (t === "down") return <TrendingDown className="w-3.5 h-3.5 text-emerald-500 shrink-0" aria-label="falling" />;
    return <span className="w-3.5 shrink-0" />;
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={() => setCardOpen((v) => !v)} className="flex items-start gap-1.5 text-left min-w-0">
          <ChevronDown className={"w-4 h-4 text-slate-400 mt-0.5 shrink-0 transition-transform " + (cardOpen ? "rotate-180" : "-rotate-90")} />
          <div>
            <div className="text-[13px] font-semibold text-ink">Every expense · line by line</div>
            <div className="text-[11px] text-muted tabular-nums mt-0.5">
              {money(totalExpenses)} total · <span className="text-rose-500">▲ rising</span> = look first · tap to {cardOpen ? "collapse" : "expand"}
            </div>
          </div>
        </button>
        {cardOpen && (<div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setAll(allOpen ? false : true)}
            className="text-[11px] font-medium text-muted hover:text-ink transition-colors"
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </button>
          {/* Total / By month toggle */}
          <div className="flex rounded-lg bg-slate-100 p-0.5 text-[11px] font-medium">
            <button
              type="button"
              onClick={() => setByMonth(false)}
              className={"px-2.5 py-1 rounded-md transition-colors " + (!byMonth ? "bg-white text-ink shadow-sm" : "text-muted")}
            >
              Total
            </button>
            <button
              type="button"
              onClick={() => setByMonth(true)}
              className={"px-2.5 py-1 rounded-md transition-colors " + (byMonth ? "bg-white text-ink shadow-sm" : "text-muted")}
            >
              By month
            </button>
          </div>
        </div>)}
      </div>

      {cardOpen && (<div className="overflow-x-auto">
        <div className="min-w-[420px]">
          {/* Column header (month mode) */}
          {byMonth && (
            <div className="flex items-center gap-2 pb-1.5 mb-1 border-b border-slate-200 text-[10px] font-medium text-muted uppercase tracking-wide">
              <span className="flex-1" />
              {months.map((m, k) => {
                const active = sortIdx === monthIdx[k];
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setSortIdx(active ? -1 : monthIdx[k])}
                    className={"w-[68px] text-right shrink-0 uppercase tracking-wide hover:text-ink transition-colors " + (active ? "text-accent font-semibold" : "")}
                    title={`Sort by ${m}`}
                  >
                    {m}{active ? " ↓" : ""}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setSortIdx(-1)}
                className={"w-[72px] text-right shrink-0 uppercase tracking-wide hover:text-ink transition-colors " + (sortIdx < 0 ? "text-ink font-semibold" : "")}
                title="Sort by total"
              >
                Total{sortIdx < 0 ? " ↓" : ""}
              </button>
              <span className="w-3.5 shrink-0" />
            </div>
          )}

          <div className="space-y-1">
            {cats.map((cat) => {
              const isOpen = !!open[cat.account];
              const pct = totalExpenses ? (cat.total / totalExpenses) * 100 : 0;
              const w = maxCat ? (cat.total / maxCat) * 100 : 0;
              const hasChildren = cat.children.length > 0;
              const sortedChildren = [...cat.children].sort((a, b) => sortKey(b) - sortKey(a));
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
                    <div className="flex items-center gap-2 px-1">
                      <span className="flex items-center gap-1 flex-1 min-w-0">
                        {hasChildren ? (
                          <ChevronRight
                            className={"w-3.5 h-3.5 text-muted shrink-0 transition-transform " + (isOpen ? "rotate-90" : "")}
                          />
                        ) : (
                          <span className="w-3.5 shrink-0" />
                        )}
                        <span className="text-[13px] font-medium text-ink truncate">{cat.account}</span>
                        {hasChildren && <span className="text-[10px] text-muted shrink-0">({cat.children.length})</span>}
                      </span>

                      {byMonth ? (
                        <>
                          {monthIdx.map((mi) => (
                            <span key={mi} className="w-[68px] text-right shrink-0 text-[12px] text-slate-500 tabular-nums">
                              {money(cat.values[mi])}
                            </span>
                          ))}
                          <span className="w-[72px] text-right shrink-0 text-[12px] font-semibold text-ink tabular-nums">
                            {money(cat.total)}
                          </span>
                          <TrendIcon vals={cat.values} />
                        </>
                      ) : (
                        <span className="text-[12px] text-muted tabular-nums shrink-0">
                          {money(cat.total)} · {pct.toFixed(0)}%
                        </span>
                      )}
                    </div>
                    {!byMonth && (
                      <div className="mt-1 ml-[18px] h-1.5 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full rounded-full bg-accent/70" style={{ width: `${Math.max(w, 2)}%` }} />
                      </div>
                    )}
                  </button>

                  {isOpen && hasChildren && (
                    <div className="ml-[26px] mt-1 mb-2 space-y-0.5 border-l border-slate-100 pl-3">
                      {sortedChildren.map((leaf) => {
                        const lpct = cat.total ? (leaf.total / cat.total) * 100 : 0;
                        return (
                          <div key={leaf.account} className="flex items-center gap-2 py-0.5 text-[12px]">
                            <span className="flex-1 text-slate-600 truncate">{leaf.account}</span>
                            {byMonth ? (
                              <>
                                {monthIdx.map((mi) => (
                                  <span key={mi} className="w-[68px] text-right shrink-0 text-slate-500 tabular-nums">
                                    {money(leaf.values[mi])}
                                  </span>
                                ))}
                                <span className="w-[72px] text-right shrink-0 text-slate-700 font-medium tabular-nums">
                                  {money(leaf.total)}
                                </span>
                                <TrendIcon vals={leaf.values} />
                              </>
                            ) : (
                              <span className="tabular-nums shrink-0 text-slate-500">
                                {money(leaf.total)}
                                <span className="text-slate-400"> · {lpct.toFixed(0)}%</span>
                              </span>
                            )}
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
      </div>)}
    </div>
  );
}
