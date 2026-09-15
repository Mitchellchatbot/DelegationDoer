// Client-safe types for the Facebook revenue card on /finance.
// The fetcher lives in facebook-revenue.ts, which is `server-only` (it
// holds the shared secret). Splitting the shapes out lets the card import
// them without dragging the server-only directive along.
//
// Mirrors RevenueApiResponse in the Finance app (scaledai-finance,
// src/lib/revenue-api.ts). Every figure is computed there — nothing on
// this side recomputes revenue.

export interface FacebookRevenueMonth {
  period: string;          // YYYY-MM
  revenue: number;         // management fees + one-offs
  managedSpend: number;    // Meta spend we manage on the billed basis — includes 0% clients
  feeBearingSpend: number; // the part of managedSpend on a rate above 0% (what fees are charged on)
  managementFees: number;
  oneOffRevenue: number;   // one-off billable items: setup fees, less any credits
}

export interface FacebookRevenuePayer {
  name: string;
  revenue: number;
  feeBillable: number;
  oneOffTotal: number;
  managedSpend: number;
  closingRate: number | null; // a FRACTION — 0.2 is 20%; null = no rate
  lastDay: string | null;     // YYYY-MM-DD of the last spend row this month
  gapDays: number;            // days missing inside the reported span
  unpricedSpend: number;      // spend on days with no rate
}

export interface FacebookRevenueDelta {
  label: string; // the Finance app's own Revenue-card label, e.g. "-32% vs Aug 1–14"
  tone: "up" | "down" | "flat";
}

// The Facebook side's own P&L totals for the same month as `current` — the
// Finance app's Expenses / Net profit / Software / Top client cards. NOT the
// QuickBooks P&L uploaded on /finance: a different figure, always labelled
// "Facebook side". Mirrors RevenueApiPnl.
export interface FacebookRevenuePnl {
  expensesTotal: number;
  expenseLines: number;                // how many ledger lines make up expensesTotal
  noExpensesRecorded: boolean;         // nothing entered for the month — show "—", never $0
  netProfit: number;
  netMarginPct: number | null;         // a PERCENT — 18.7 is 18.7% (unlike closingRate); null = no revenue
  softwareCosts: number;
  softwarePctOfRevenue: number | null; // a PERCENT
  concentrationPct: number | null;     // a PERCENT — the top payer's share of revenue
}

export interface FacebookRevenueData {
  period: string;
  provisional: boolean;
  monthEnd: string;
  asOf: string | null;
  current: FacebookRevenueMonth;
  payers: FacebookRevenuePayer[];  // largest revenue first
  months: FacebookRevenueMonth[];  // oldest first; last === current
  delta: FacebookRevenueDelta | null;
  generatedAt: string;
  // Optional: the Finance app deploys separately, and one without the block
  // (or with a malformed one) still yields a valid revenue card.
  pnl?: FacebookRevenuePnl;
}

export type FacebookRevenueResult =
  | { ok: true; data: FacebookRevenueData }
  | { ok: false; error: string };
