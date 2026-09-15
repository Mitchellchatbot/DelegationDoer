import type {
  FacebookRevenueData,
  FacebookRevenuePayer,
  FacebookRevenuePnl,
  FacebookRevenueResult
} from "@/lib/facebook-revenue-types";

// Facebook-side revenue, as the Finance app computes it (management fees +
// setup fees on the Meta ad spend we manage). Its own card on purpose: it is
// never added to the MRR total above, and there is no add-to-sheet control —
// the Finance app is the source of truth for these figures.

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

// Same Intl currency formatting as the Finance app, so a figure reads
// identically on both screens — negatives included ("-$5", not "$-5").
function usd(n: number, digits = 0): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

// Dates arrive as plain YYYY-MM-DD / YYYY-MM strings on the ad accounts'
// calendar. Split them rather than going through Date, so the server's
// timezone can't shift a day.
function monthName(period: string): string {
  return MONTHS[Number(period.slice(5, 7)) - 1] ?? period;
}
function dayLabel(day: string): string {
  return `${Number(day.slice(8, 10))} ${monthName(day).slice(0, 3)}`;
}

const DELTA_TONE: Record<"up" | "down" | "flat", string> = {
  up: "text-emerald-600",
  down: "text-amber-600",
  flat: "text-muted"
};

function Title({ provisional }: { provisional?: boolean }) {
  return (
    <div className="text-[13px] font-semibold text-ink flex items-center gap-2 flex-wrap">
      Facebook revenue
      <span className="text-[10px] font-medium uppercase tracking-wide text-indigo-600 bg-indigo-100 rounded px-1.5 py-0.5">from Finance app</span>
      {provisional && (
        <span className="text-[9px] uppercase tracking-wide text-amber-600 bg-amber-100 rounded px-1 py-0.5">provisional</span>
      )}
    </div>
  );
}

export function FacebookRevenueLoading() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
      <Title />
      <div className="text-[11px] text-muted mt-1">Loading from the Finance app…</div>
    </div>
  );
}

export function FacebookRevenue({ result }: { result: FacebookRevenueResult }) {
  if (!result.ok) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
        <Title />
        <div className="text-[12px] text-muted mt-1">Facebook revenue unavailable — {result.error}</div>
      </div>
    );
  }
  return <RevenueCard data={result.data} />;
}

function RevenueCard({ data }: { data: FacebookRevenueData }) {
  const { current, delta, asOf } = data;
  const month = monthName(data.period);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
      <div className="flex items-start justify-between gap-2 mb-3 flex-wrap">
        <div className="min-w-0">
          <Title provisional={data.provisional} />
          <div className="text-[11px] text-muted mt-0.5 max-w-prose">
            Management + setup fees on managed Meta ad spend, computed by the Finance app. Separate from MRR — not included in any other total on this page.
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-muted">{month}{data.provisional ? " so far" : ""}</div>
          <div className="text-2xl font-bold tabular-nums text-ink leading-none">{usd(current.revenue)}</div>
          {delta && <div className={`text-[11px] tabular-nums mt-0.5 ${DELTA_TONE[delta.tone]}`}>{delta.label}</div>}
          {/* The Finance app's Revenue-card subtitle, same rule. */}
          <div className="text-[10px] text-muted mt-0.5">
            {current.oneOffRevenue
              ? `fees ${usd(current.managementFees)} · setup ${usd(current.oneOffRevenue)}`
              : `from ${usd(current.managedSpend)} of managed ad spend`}
          </div>
          {current.oneOffRevenue !== 0 && (
            <div className="text-[10px] text-muted">from {usd(current.managedSpend)} of managed ad spend</div>
          )}
        </div>
      </div>

      {data.pnl && <PnlRow pnl={data.pnl} provisional={data.provisional} month={month} />}

      {data.payers.length === 0 ? (
        <div className="text-[12px] text-muted">No clients billing this month yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] min-w-[480px]">
            <thead>
              <tr className="text-muted text-left text-[10px] uppercase tracking-wide border-b border-slate-200">
                <th className="font-medium pb-1.5 pr-2">Client</th>
                <th className="font-medium pb-1.5 pr-2 text-right w-[60px]">Rate</th>
                <th className="font-medium pb-1.5 pr-2 text-right w-[120px]">Managed spend</th>
                <th className="font-medium pb-1.5 text-right w-[120px]">FB fees + setup</th>
              </tr>
            </thead>
            <tbody>
              {data.payers.map((p, i) => (
                <tr key={`${i}-${p.name}`} className="border-b border-slate-100 last:border-0 align-top">
                  <td className="py-1 pr-2">
                    <div className="text-ink">{p.name}</div>
                    <PayerMarkers payer={p} asOf={asOf} />
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums text-muted">
                    {p.closingRate === null ? "—" : `${(p.closingRate * 100).toFixed(0)}%`}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums text-muted">{usd(p.managedSpend, 2)}</td>
                  <td className="py-1 text-right tabular-nums text-ink">{usd(p.revenue, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 pt-2 border-t border-slate-100">
        <div className="text-[10px] uppercase tracking-wide text-muted mb-1">Facebook revenue — last {data.months.length} months</div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
          {data.months.map((m) => (
            <div key={m.period} className="tabular-nums">
              <span className="text-muted">{monthName(m.period).slice(0, 3)}</span>{" "}
              <span className={m.period === data.period ? "font-semibold text-ink" : "text-ink"}>{usd(m.revenue)}</span>
            </div>
          ))}
        </div>
      </div>

      {asOf && asOf < data.monthEnd && (
        <div className="mt-2 text-[11px] text-muted">
          Spend runs through {dayLabel(asOf)} — {month} is still filling in.
        </div>
      )}
    </div>
  );
}

// The Finance app's Expenses / Net profit cards for the same month, compact.
// "Facebook side" on purpose: the P&L further down this page is the uploaded
// QuickBooks one, a different margin. Finance's own rules, not ours — an empty
// ledger is "—", never $0 of expenses, and with nothing entered there is no
// real net or margin yet. Its percents arrive as PERCENT (18.7 = 18.7%),
// unlike closingRate above.
function PnlRow({ pnl, provisional, month }: { pnl: FacebookRevenuePnl; provisional: boolean; month: string }) {
  const empty = pnl.noExpensesRecorded;
  return (
    <div className="mb-3 pb-2 border-b border-slate-100">
      <div className="text-[10px] uppercase tracking-wide text-muted mb-1">
        Facebook side — costs &amp; margin{provisional ? " · costs still arriving" : ""}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] tabular-nums">
        <div>
          <span className="text-muted">Expenses</span>{" "}
          <span className="text-ink">{empty ? "—" : usd(pnl.expensesTotal)}</span>
        </div>
        <div>
          <span className="text-muted">Net profit</span>{" "}
          <span className={empty ? "text-muted" : pnl.netProfit < 0 ? "text-rose-600" : "text-ink"}>
            {empty ? "—" : usd(pnl.netProfit)}
          </span>
        </div>
        <div>
          <span className="text-muted">Margin</span>{" "}
          <span className="text-ink">{empty || pnl.netMarginPct === null ? "—" : `${pnl.netMarginPct.toFixed(1)}%`}</span>
        </div>
      </div>
      {empty && (
        <div className="text-[11px] text-amber-600 mt-1">
          No expenses entered in the Finance app for {month} yet — not a real net.
        </div>
      )}
    </div>
  );
}

// Cautions on a payer's row, from fields the Finance app sends: a number that
// stopped moving, days missing, or spend it could not price is short — not final.
function PayerMarkers({ payer, asOf }: { payer: FacebookRevenuePayer; asOf: string | null }) {
  const notes: string[] = [];
  if (payer.lastDay === null) notes.push("no spend reported");
  else if (asOf && payer.lastDay < asOf) notes.push(`data stops ${dayLabel(payer.lastDay)}`);
  if (payer.gapDays > 0) notes.push(`${payer.gapDays}d missing`);
  if (payer.unpricedSpend > 0) notes.push(`unpriced ${usd(payer.unpricedSpend)}`);
  if (notes.length === 0) return null;
  return <div className="text-[10px] text-amber-600">{notes.join(" · ")}</div>;
}
