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
}

export type FacebookRevenueResult =
  | { ok: true; data: FacebookRevenueData }
  | { ok: false; error: string };
