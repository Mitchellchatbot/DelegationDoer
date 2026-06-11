// Client-safe types + constants for the Website Builder dashboard. The
// fetcher lives in website-builder-metrics.ts which is marked
// `server-only` (it holds the Supabase service_role key). Splitting the
// pure types out into their own file lets the dashboard's "use client"
// content component import the constants without dragging the
// server-only directive into the client bundle.

export interface ProjectMetricsRow {
  total_all: number;
  total_leads: number;
  total_custom: number;
  total_general: number;
  failed_all: number;
  failed_leads: number;
  failed_custom: number;
  failed_general: number;
  // Supabase returns numeric(5,4) as a string by default. The fetcher
  // coerces to number before handing the row off, so consumers can
  // treat these as plain 0–1 floats.
  success_rate_all: number;
  success_rate_leads: number;
  success_rate_custom: number;
  success_rate_general: number;
  today_all: number;
  today_leads: number;
  today_custom: number;
  today_general: number;
  this_week_all: number;
  this_week_leads: number;
  this_week_custom: number;
  this_week_general: number;
  this_month_all: number;
  this_month_leads: number;
  this_month_custom: number;
  this_month_general: number;
  this_year_all: number;
  this_year_leads: number;
  this_year_custom: number;
  this_year_general: number;
}

export type MetricsResult =
  | { ok: true; data: ProjectMetricsRow }
  | { ok: false; error: string };

export const CATEGORIES = ["all", "leads", "custom", "general"] as const;
export type Category = (typeof CATEGORIES)[number];

export const PERIODS = ["today", "this_week", "this_month", "this_year", "total"] as const;
export type Period = (typeof PERIODS)[number];

export const PERIOD_LABEL: Record<Period, string> = {
  today: "Today",
  this_week: "This Week",
  this_month: "This Month",
  this_year: "This Year",
  total: "All-time"
};

export const CATEGORY_LABEL: Record<Category, string> = {
  all: "All",
  leads: "Leads",
  custom: "Custom",
  general: "General"
};

// Typed accessor — pulls "this_month_leads" / "total_all" / etc. from
// the metrics row without sprinkling string-keyed lookups across the
// UI. Keeps the type system honest about valid axis combinations.
export function metricValue(row: ProjectMetricsRow, period: Period, category: Category): number {
  const key = `${period}_${category}` as keyof ProjectMetricsRow;
  const v = row[key];
  return typeof v === "number" ? v : 0;
}
