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
    <div className="text-[16px] font-semibold text-slate-900 flex items-center gap-2 flex-wrap">
      Facebook revenue
      <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">Finance app</span>
      {provisional && (
        <span className="text-[10px] font-medium uppercase tracking-wide text-amber-600 bg-amber-50 rounded-full px-2 py-0.5">provisional</span>
      )}
    </div>
  );
}

export function FacebookRevenueLoading() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <Title />
      <div className="text-[12px] text-slate-500 mt-1">Loading from the Finance app…</div>
    </div>
  );
}

export function FacebookRevenue({ result }: { result: FacebookRevenueResult }) {
  if (!result.ok) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <Title />
        <div className="text-[12px] text-slate-500 mt-1">Facebook revenue unavailable — {result.error}</div>
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
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
        <div className="min-w-0">
          <Title provisional={data.provisional} />
          <div className="text-[12px] text-slate-500 mt-1 max-w-prose">
            Your profit after the 50% partner split — management + setup fees on managed Meta spend. Separate from MRR.
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] text-slate-400">{month} · your 50%{data.provisional ? " so far" : ""}</div>
          <div className="text-[28px] font-bold tabular-nums text-emerald-600 leading-none mt-0.5">{usd(profit)}</div>
          <div className="text-[11px] text-slate-400 mt-1">of {usd(current.revenue)} gross</div>
          {canEstimate && (
            <div className="text-[12px] mt-1.5">
              <span className="text-slate-400">Est. month-end </span>
              <span className="font-semibold tabular-nums text-slate-900">{usd(estMonthEndProfit)}</span>
            </div>
          )}
        </div>
      </div>

      {data.payers.length === 0 ? (
        <div className="text-[12px] text-slate-500">No clients billing this month yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[480px]">
            <thead>
              <tr className="text-slate-400 text-left text-[10px] uppercase tracking-wider border-b border-slate-100">
                <th className="font-medium pb-2 pr-2">Client</th>
                <th className="font-medium pb-2 pr-2 text-right w-[56px]">Rate</th>
                <th className="font-medium pb-2 pr-2 text-right w-[120px]">Managed spend</th>
                <th className="font-medium pb-2 text-right w-[120px]">Your fee (50%)</th>
              </tr>
            </thead>
            <tbody>
              {data.payers.map((p, i) => {
                const earns = p.revenue > 0;
                return (
                  <tr key={`${i}-${p.name}`} className={"border-b border-slate-50 last:border-0 align-top " + (earns ? "" : "opacity-45")}>
                    <td className="py-2 pr-2">
                      <div className="text-slate-900 font-medium">{p.name}</div>
                      <PayerMarkers payer={p} asOf={asOf} />
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums text-slate-400">
                      {p.closingRate === null ? "—" : `${(p.closingRate * 100).toFixed(0)}%`}
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums text-slate-500">{usd(p.managedSpend)}</td>
                    <td className="py-2 text-right tabular-nums font-semibold text-slate-900">{usd(p.revenue * OWNER_SHARE)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-5 pt-4 border-t border-slate-100">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-3">Your Facebook profit (50%) — last {data.months.length} months</div>
        <ProfitBars months={data.months} current={data.period} />
      </div>

      {asOf && asOf < data.monthEnd && (
        <div className="mt-3 text-[11px] text-slate-400">
          Spend runs through {dayLabel(asOf)} — {month} is still filling in.
        </div>
      )}
    </div>
  );
}

// Compact bar chart of the last few months of profit (his 50%). The current
// month is emphasized; empty months still take a slot so the trend reads true.
function ProfitBars({ months, current }: { months: FacebookRevenueData["months"]; current: string }) {
  const vals = months.map((m) => Math.max(0, m.revenue * OWNER_SHARE));
  const max = Math.max(1, ...vals);
  return (
    <div className="flex items-end gap-3 h-28">
      {months.map((m, i) => {
        const v = vals[i];
        const isCur = m.period === current;
        return (
          <div key={m.period} className="flex-1 flex flex-col items-center justify-end gap-1.5 h-full min-w-0">
            <div className="text-[11px] font-semibold tabular-nums text-slate-700">{usd(v)}</div>
            <div className="w-full flex-1 min-h-0 flex items-end">
              <div className={"w-full rounded-t " + (isCur ? "bg-emerald-500" : "bg-slate-200")} style={{ height: `${Math.max(2, (v / max) * 100)}%` }} title={usd(v)} />
            </div>
            <div className="text-[11px] text-slate-400">{monthName(m.period).slice(0, 3)}</div>
          </div>
        );
      })}
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
