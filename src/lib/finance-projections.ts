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
  grossFee: number;   // total gross fee across clients
  yourTotal: number;  // total your 50%
  period: string;
}

export function projectFacebook(data: FacebookRevenueData): FbProjection {
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

  return {
    provisional: data.provisional,
    daysInMonth,
    elapsed,
    clients,
    grossFee: clients.reduce((s, c) => s + c.projectedFee, 0),
    yourTotal: clients.reduce((s, c) => s + c.yourShare, 0),
    period: data.period
  };
}
