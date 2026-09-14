import type { ParsedPnl } from "@/lib/pnl-parse";

// Renders the parsed P&L as an at-a-glance dashboard. Server component (pure
// render, no interactivity). Falls back to nothing if there's no parsed data.

function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

export function FinanceDashboard({ parsed }: { parsed: ParsedPnl | null | undefined }) {
  if (!parsed || !parsed.periods.length) return null;

  const periods = parsed.periods;
  const hasTotalCol = periods[periods.length - 1].toLowerCase() === "total";
  const months = hasTotalCol ? periods.slice(0, -1) : periods;
  const totalIdx = periods.length - 1;
  const latestIdx = months.length - 1;
  const prevIdx = latestIdx - 1;

  const rev = parsed.summary.income[latestIdx] ?? null;
  const exp = parsed.summary.expenses[latestIdx] ?? null;
  const net = parsed.summary.net[latestIdx] ?? null;
  const margin = rev && net !== null ? (net / rev) * 100 : null;

  const revPrev = prevIdx >= 0 ? parsed.summary.income[prevIdx] : null;
  const revDelta = rev !== null && revPrev ? ((rev - revPrev) / revPrev) * 100 : null;

  const expTotal = hasTotalCol ? parsed.summary.expenses[totalIdx] : exp;
  const breakdown = parsed.expenseBreakdown.slice(0, 8);
  const maxCat = breakdown.length ? breakdown[0].total : 0;

  const latestLabel = months[latestIdx] ?? "latest";

  const cards = [
    { label: `Revenue · ${latestLabel}`, value: money(rev), tone: "ink" as const,
      sub: revDelta !== null ? `${revDelta >= 0 ? "+" : ""}${revDelta.toFixed(0)}% vs prev mo` : undefined },
    { label: "Expenses", value: money(exp), tone: "rose" as const },
    { label: "Net income", value: money(net), tone: "emerald" as const,
      sub: margin !== null ? `${margin.toFixed(0)}% margin` : undefined },
    { label: hasTotalCol ? "Net · period total" : "Margin", value: hasTotalCol ? money(parsed.summary.net[totalIdx]) : (margin !== null ? `${margin.toFixed(0)}%` : "—"), tone: "ink" as const }
  ];

  return (
    <div className="space-y-4">
      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
            <div className="text-[11px] font-medium text-muted">{c.label}</div>
            <div className={
              "mt-1 text-2xl font-bold tabular-nums " +
              (c.tone === "emerald" ? "text-emerald-600" : c.tone === "rose" ? "text-rose-600" : "text-ink")
            }>
              {c.value}
            </div>
            {c.sub && <div className="mt-0.5 text-[11px] text-muted">{c.sub}</div>}
          </div>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        {/* By month */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
          <div className="text-[13px] font-semibold text-ink mb-3">By month</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] tabular-nums">
              <thead>
                <tr className="text-muted text-left">
                  <th className="font-medium pb-1.5 pr-3"></th>
                  {months.map((m) => <th key={m} className="font-medium pb-1.5 px-2 text-right">{m}</th>)}
                </tr>
              </thead>
              <tbody>
                {[
                  { label: "Revenue", vals: parsed.summary.income, cls: "text-ink" },
                  { label: "Expenses", vals: parsed.summary.expenses, cls: "text-rose-600" },
                  { label: "Net", vals: parsed.summary.net, cls: "text-emerald-600 font-semibold" }
                ].map((row) => (
                  <tr key={row.label} className="border-t border-slate-100">
                    <td className="py-1.5 pr-3 text-muted">{row.label}</td>
                    {months.map((_, i) => (
                      <td key={i} className={"py-1.5 px-2 text-right " + row.cls}>{money(row.vals[i])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Where the money goes */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
          <div className="text-[13px] font-semibold text-ink mb-3">
            Where the money goes {hasTotalCol && <span className="text-muted font-normal">· period total</span>}
          </div>
          <div className="space-y-2">
            {breakdown.map((b) => {
              const pct = expTotal ? (b.total / expTotal) * 100 : 0;
              const w = maxCat ? (b.total / maxCat) * 100 : 0;
              return (
                <div key={b.account}>
                  <div className="flex items-baseline justify-between text-[12px]">
                    <span className="text-ink truncate pr-2">{b.account}</span>
                    <span className="text-muted tabular-nums shrink-0">{money(b.total)} · {pct.toFixed(0)}%</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full rounded-full bg-accent/70" style={{ width: `${Math.max(w, 2)}%` }} />
                  </div>
                </div>
              );
            })}
            {breakdown.length === 0 && <div className="text-[12px] text-muted">No expense breakdown found.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
