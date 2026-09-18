import type {
  FacebookRevenueData,
  FacebookRevenuePayer,
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

// Mitchell keeps 50% of the Facebook side — there's a partner on it — so this
// card shows HIS profit, not the gross fee. The rest is the gross for reference.
const OWNER_SHARE = 0.5;
function dayOfMonth(d: string | null): number | null {
  if (!d || d.length < 10) return null;
  const n = Number(d.slice(8, 10));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function RevenueCard({ data }: { data: FacebookRevenueData }) {
  const { current, delta, asOf } = data;
  const month = monthName(data.period);

  // His profit so far = 50% of the gross Facebook revenue (fees + setup).
  const profit = current.revenue * OWNER_SHARE;

  // Estimated month-end profit: project the recurring management fees to the
  // full month by the daily run-rate (fees so far ÷ days elapsed × days in
  // month), keep one-off/setup as actual, then take the 50% share. Only while
  // the month is still filling in. e.g. $1k/day, day 17 → $17k so far, project
  // to ~$30k, 20% fee = $6k, your half = $3k.
  const daysIn = dayOfMonth(data.monthEnd);
  const elapsed = dayOfMonth(asOf) ?? dayOfMonth(data.asOf);
  const canEstimate = data.provisional && daysIn && elapsed && elapsed < daysIn && current.managementFees > 0;
  const projFees = canEstimate ? current.managementFees * (daysIn! / elapsed!) : current.managementFees;
  const estMonthEndProfit = (projFees + current.oneOffRevenue) * OWNER_SHARE;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
      <div className="flex items-start justify-between gap-2 mb-3 flex-wrap">
        <div className="min-w-0">
          <Title provisional={data.provisional} />
          <div className="text-[11px] text-muted mt-0.5 max-w-prose">
            Your profit on the Facebook side (management + setup fees on managed Meta spend), after the 50% partner split. Separate from MRR.
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-muted">{month} profit · your 50%{data.provisional ? " so far" : ""}</div>
          <div className="text-2xl font-bold tabular-nums text-emerald-600 leading-none">{usd(profit)}</div>
          <div className="text-[10px] text-muted mt-0.5">of {usd(current.revenue)} gross · 50% partner split</div>
          {canEstimate && (
            <div className="text-[11px] mt-1">
              <span className="text-muted">Est. month-end: </span>
              <span className="font-semibold tabular-nums text-ink">{usd(estMonthEndProfit)}</span>
              <span className="text-[10px] text-muted"> (your 50%)</span>
            </div>
          )}
          {delta && <div className={`text-[11px] tabular-nums mt-0.5 ${DELTA_TONE[delta.tone]}`}>{delta.label} (gross)</div>}
          <div className="text-[10px] text-muted mt-0.5">
            gross fees {usd(current.managementFees)}{current.oneOffRevenue ? ` · setup ${usd(current.oneOffRevenue)}` : ""}
          </div>
        </div>
      </div>

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
        <div className="text-[10px] uppercase tracking-wide text-muted mb-1">Your Facebook profit (50%) — last {data.months.length} months</div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
          {data.months.map((m) => (
            <div key={m.period} className="tabular-nums">
              <span className="text-muted">{monthName(m.period).slice(0, 3)}</span>{" "}
              <span className={m.period === data.period ? "font-semibold text-ink" : "text-ink"}>{usd(m.revenue * OWNER_SHARE)}</span>
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
