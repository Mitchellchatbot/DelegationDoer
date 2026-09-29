// Latest-month headline + month-by-month trend for one business line (Facebook
// or SEO & website), read straight off the P&L split (computeBreakdown.months).

export interface SegMonth { label: string; revenue: number; expenses: number; profit: number }

function money(n: number): string {
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

export function SegmentTrend({ title, accent, months, profitLabel, note }: {
  title: string;
  accent: "blue" | "emerald";
  months: SegMonth[];
  profitLabel: string;
  note?: string;
}) {
  const shown = months.filter((m) => m.revenue || m.expenses || m.profit);
  const latest = shown[shown.length - 1];
  const tone = accent === "blue"
    ? { dot: "bg-blue-500", head: "text-blue-700", bar: "bg-blue-400" }
    : { dot: "bg-emerald-500", head: "text-emerald-700", bar: "bg-emerald-400" };
  const maxProfit = Math.max(1, ...shown.map((m) => Math.abs(m.profit)));

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <span className={"w-2 h-2 rounded-full " + tone.dot} />
        <span className={"text-[15px] font-semibold " + tone.head}>{title}</span>
        {note && <span className="text-[11px] text-slate-400">· {note}</span>}
      </div>

      {latest ? (<>
        {/* Latest month headline */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-[11px] text-slate-400">Revenue · {latest.label}</div>
            <div className="text-[22px] font-bold tabular-nums text-slate-900 leading-none mt-0.5">{money(latest.revenue)}</div>
          </div>
          <div>
            <div className="text-[11px] text-slate-400">Costs</div>
            <div className="text-[22px] font-bold tabular-nums text-slate-900 leading-none mt-0.5">{money(latest.expenses)}</div>
          </div>
          <div>
            <div className="text-[11px] text-slate-400">{profitLabel}</div>
            <div className={"text-[22px] font-bold tabular-nums leading-none mt-0.5 " + (latest.profit < 0 ? "text-rose-500" : "text-emerald-600")}>{money(latest.profit)}</div>
          </div>
        </div>

        {/* Month-by-month trend */}
        <div className="mt-5 pt-4 border-t border-slate-100">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Month by month</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] min-w-[380px]">
              <thead>
                <tr className="text-slate-400 text-left text-[10px] uppercase tracking-wider border-b border-slate-100">
                  <th className="font-medium pb-1.5 pr-2">Month</th>
                  <th className="font-medium pb-1.5 px-2 text-right">Revenue</th>
                  <th className="font-medium pb-1.5 px-2 text-right">Costs</th>
                  <th className="font-medium pb-1.5 pl-2 text-right">{profitLabel}</th>
                  <th className="font-medium pb-1.5 pl-3 w-24"></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((m) => (
                  <tr key={m.label} className="border-b border-slate-50 last:border-0">
                    <td className="py-1.5 pr-2 text-slate-600">{m.label}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-slate-500">{money(m.revenue)}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-slate-500">{money(m.expenses)}</td>
                    <td className={"py-1.5 pl-2 text-right tabular-nums font-semibold " + (m.profit < 0 ? "text-rose-500" : "text-slate-900")}>{money(m.profit)}</td>
                    <td className="py-1.5 pl-3">
                      <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                        <div className={"h-full rounded-full " + (m.profit < 0 ? "bg-rose-300" : tone.bar)} style={{ width: `${Math.max(3, (Math.abs(m.profit) / maxProfit) * 100)}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </>) : (
        <div className="text-[13px] text-slate-500">No data yet.</div>
      )}
    </div>
  );
}
