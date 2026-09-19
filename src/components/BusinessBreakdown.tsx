import type { BusinessBreakdown, SideNumbers } from "@/lib/finance-segments";

// Facebook vs SEO & website, split from one P&L. Latest month side by side (with
// expenses broken out) + a month-by-month trend. The two profits sum to the P&L
// net plus the owner salary (which is pulled out).

function money(n: number): string {
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

function Side({ title, accent, data, totalRevenue, commission }: { title: string; accent: "blue" | "emerald"; data: SideNumbers; totalRevenue: number; commission?: { profitBefore: number; accrualCommission: number; trueProfit: number; booksCommission: number } }) {
  const tone = accent === "blue"
    ? { dot: "bg-blue-500", ring: "border-blue-100", head: "text-blue-700" }
    : { dot: "bg-emerald-500", ring: "border-emerald-100", head: "text-emerald-700" };
  const pct = totalRevenue ? Math.round((data.revenue / totalRevenue) * 100) : 0;
  const TOP = 7;
  const shown = data.expenseLines.slice(0, TOP);
  const restCount = data.expenseLines.length - shown.length;
  const restSum = data.expenseLines.slice(TOP).reduce((s, l) => s + l.amount, 0);

  return (
    <div className={"flex-1 min-w-0 rounded-xl border bg-white p-5 " + tone.ring}>
      <div className="flex items-center gap-2 mb-3">
        <span className={"w-2 h-2 rounded-full " + tone.dot} />
        <span className={"text-[13px] font-semibold " + tone.head}>{title}</span>
      </div>

      {commission ? (
        <>
          <div className="text-[11px] text-slate-400">Profit before commission</div>
          <div className="text-[26px] font-bold tabular-nums leading-none mt-0.5 text-slate-900">{money(commission.profitBefore)}</div>
          <div className="text-[12px] text-slate-500 mt-1.5">− commission {money(commission.accrualCommission)}</div>
          <div className="text-[11px] text-slate-400 mt-1.5">Profit</div>
          <div className={"text-[26px] font-bold tabular-nums leading-none mt-0.5 " + (commission.trueProfit < 0 ? "text-rose-500" : "text-slate-900")}>{money(commission.trueProfit)}</div>
          <div className="text-[11px] text-slate-400 mt-2 pt-2 border-t border-slate-50">
            Books (ties to P&amp;L): <span className="font-semibold text-slate-600 tabular-nums">{money(data.profit)}</span> · commission booked {money(commission.booksCommission)}
          </div>
        </>
      ) : (
        <>
          <div className="text-[11px] text-slate-400">Profit</div>
          <div className={"text-[28px] font-bold tabular-nums leading-none mt-0.5 " + (data.profit < 0 ? "text-rose-500" : "text-slate-900")}>{money(data.profit)}</div>
        </>
      )}

      <div className="mt-4 flex items-baseline justify-between gap-2 border-t border-slate-100 pt-3">
        <span className="text-[12px] font-medium text-slate-600">Revenue · {pct}%</span>
        <span className="text-[14px] font-semibold tabular-nums text-slate-900">{money(data.revenue)}</span>
      </div>

      <div className="mt-3 flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-slate-600">{commission ? "Operating expenses" : "Expenses"}</span>
        <span className="text-[14px] font-semibold tabular-nums text-slate-900">{money(commission ? data.revenue - commission.profitBefore : data.expenses)}</span>
      </div>
      <div className="mt-1 space-y-0.5">
        {shown.map((l, i) => (
          <div key={i} className="flex items-baseline justify-between gap-2 text-[11px] text-slate-400">
            <span className="truncate">{l.label}</span>
            <span className="tabular-nums shrink-0">{money(l.amount)}</span>
          </div>
        ))}
        {restCount > 0 && (
          <div className="flex items-baseline justify-between gap-2 text-[11px] text-slate-400">
            <span className="truncate">+{restCount} more</span>
            <span className="tabular-nums shrink-0">{money(restSum)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function BusinessBreakdownView({ data }: { data: BusinessBreakdown }) {
  if (!data.hasData) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-[16px] font-semibold text-slate-900">Business breakdown</div>
        <div className="text-[12px] text-slate-500 mt-1">{data.notes[0] ?? "No P&L yet."}</div>
      </div>
    );
  }
  const totalRev = data.fb.revenue + data.seo.revenue;
  const check = data.fb.profit + data.seo.profit; // = P&L net + salary
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
        <div>
          <div className="text-[16px] font-semibold text-slate-900">Business breakdown</div>
          <div className="text-[12px] text-slate-500 mt-0.5">
            Facebook vs SEO &amp; website{data.month ? `, latest month ${data.month}` : ""}. Profit before your salary ({money(data.salary)}), split from your one P&amp;L.
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] text-slate-400">Profit before owner pay</div>
          <div className="text-[20px] font-bold tabular-nums text-slate-900 leading-none mt-0.5">{money(data.beforeOwnerPay)}</div>
          <div className="text-[10px] text-slate-400 mt-0.5">P&amp;L net {money(data.pnlNet)} + salary {money(data.salary)}</div>
          <div className="text-[10px] text-emerald-600 mt-0.5">✓ sides sum to {money(check)}</div>
        </div>
      </div>

      <div className="flex gap-4 flex-col sm:flex-row">
        <Side title="Facebook" accent="blue" data={data.fb} totalRevenue={totalRev} commission={{ profitBefore: data.fbProfitBeforeCommission, accrualCommission: data.fbAccrualCommission, trueProfit: data.fbProfitTrue, booksCommission: data.fbCommission }} />
        <Side title="SEO & website" accent="emerald" data={data.seo} totalRevenue={totalRev} />
      </div>

      {data.months.length > 0 && (
        <div className="mt-5 pt-4 border-t border-slate-100">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Month by month</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px] min-w-[440px]">
              <thead>
                <tr className="text-slate-400 text-[10px] uppercase tracking-wider border-b border-slate-100">
                  <th className="font-medium pb-2 pr-2 text-left">Month</th>
                  <th className="font-medium pb-2 pr-2 text-right text-blue-600">FB revenue</th>
                  <th className="font-medium pb-2 pr-2 text-right text-blue-600">FB profit</th>
                  <th className="font-medium pb-2 pr-2 text-right text-emerald-600">SEO profit</th>
                  <th className="font-medium pb-2 text-right">P&amp;L net</th>
                </tr>
              </thead>
              <tbody>
                {data.months.map((m) => (
                  <tr key={m.label} className="border-b border-slate-50 last:border-0">
                    <td className="py-2 pr-2 text-left text-slate-900 font-medium whitespace-nowrap">
                      {m.label}
                      {!m.hasFbRevenue && <span className="ml-1 text-[10px] text-slate-400" title="No Facebook data entered yet — shown as all SEO">·all SEO</span>}
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums text-slate-700">{m.hasFbRevenue ? money(m.fbRevenue) : "—"}</td>
                    <td className={"py-2 pr-2 text-right tabular-nums font-medium " + (m.fbProfitTrue < 0 ? "text-rose-500" : "text-slate-900")}>{m.hasFbRevenue ? money(m.fbProfitTrue) : "—"}</td>
                    <td className={"py-2 pr-2 text-right tabular-nums " + (m.seoProfit < 0 ? "text-rose-500" : "text-slate-700")}>{money(m.seoProfit)}</td>
                    <td className="py-2 text-right tabular-nums font-semibold text-slate-900">{money(m.pnlNet)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.notes.length > 0 && (
        <ul className="mt-4 space-y-1">
          {data.notes.map((n, i) => (
            <li key={i} className="text-[11px] text-slate-400 leading-snug">· {n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
