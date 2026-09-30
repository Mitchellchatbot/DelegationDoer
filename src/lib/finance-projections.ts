import "server-only";

import type { FacebookRevenueData } from "@/lib/facebook-revenue-types";

// Project next-month (or full current-month) revenue from live inputs.
//   Facebook: each client's managed spend run-rate (spend so far ÷ days elapsed
//   × days in month) × their fee rate = projected fee; Mitchell keeps 50%.
//   SEO: the sum of active retainers (computed on the page from mrr_entries).

const FB_OWNER_SHARE = 0.5;

function dayOfMonth(d: string | null): number | null {
  if (!d || d.length < 10) return null;
  const n = Number(d.slice(8, 10));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface FbClientProjection {
  name: string;
  rate: number;           // fee fraction, 0.2 = 20%
  projectedSpend: number; // full-month managed spend at the current run-rate
  projectedFee: number;   // gross management fee on that spend
  yourShare: number;      // your 50%
}
export interface FbProjection {
  provisional: boolean;
  daysInMonth: number;
  elapsed: number;
  clients: FbClientProjection[];
  grossFee: number;    // total gross management fee across clients
  yourTotal: number;   // your 50% of the gross fee (the revenue side)
  salaries: number;    // Facebook-tagged salaries (monthly, from the roster)
  opex: number;        // Facebook operating expense for the month
  net: number;         // grossFee − salaries − opex (before the partner split)
  yourProfit: number;  // your 50% of net, AFTER Facebook costs — the real projection
  period: string;
}

// opts.salariesMonthly = Facebook-tagged salaries (roster), opts.opexMonthly =
// Facebook operating expense. Both are subtracted before the 50/50 split, so
// yourProfit is your true projected Facebook profit for the month.
export function projectFacebook(data: FacebookRevenueData, opts?: { salariesMonthly?: number; opexMonthly?: number }): FbProjection {
  const daysInMonth = dayOfMonth(data.monthEnd) ?? 30;
  const elapsed = dayOfMonth(data.asOf) ?? daysInMonth;
  // Only extrapolate while the month is still filling in.
  const factor = data.provisional && elapsed > 0 && elapsed < daysInMonth ? daysInMonth / elapsed : 1;

  const clients: FbClientProjection[] = data.payers
    .map((p) => {
      const rate = p.closingRate ?? (p.managedSpend ? p.feeBillable / p.managedSpend : 0);
      const projectedSpend = Math.round(p.managedSpend * factor);
      // Project the fee off the run-rate; one-offs are excluded (not recurring).
      const projectedFee = Math.round((p.feeBillable || projectedSpend * rate) * factor);
      return { name: p.name, rate, projectedSpend, projectedFee, yourShare: Math.round(projectedFee * FB_OWNER_SHARE) };
    })
    .filter((c) => c.projectedFee > 0)
    .sort((a, b) => b.yourShare - a.yourShare);

  const grossFee = clients.reduce((s, c) => s + c.projectedFee, 0);
  const salaries = Math.round(opts?.salariesMonthly ?? 0);
  const opex = Math.round(opts?.opexMonthly ?? 0);
  const net = grossFee - salaries - opex;
  return {
    provisional: data.provisional,
    daysInMonth,
    elapsed,
    clients,
    grossFee,
    yourTotal: clients.reduce((s, c) => s + c.yourShare, 0),
    salaries,
    opex,
    net,
    yourProfit: Math.round(net * FB_OWNER_SHARE),
    period: data.period
  };
}
