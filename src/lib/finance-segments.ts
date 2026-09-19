import { latestMonthIndex, expenseLeafLines, type ParsedPnl } from "@/lib/pnl-parse";

// Split ONE P&L into Facebook vs SEO & website, month by month, reconciling to
// the P&L (the source of truth) with the owner salary pulled out.
//
//   Facebook revenue  — from the Finance app (real spend × ~20% fee + setup),
//                       entered per month (facebook_monthly.revenue).
//   Facebook expenses — a FIXED list Mitchell assigns: P&L leaf lines tagged
//                       Facebook (expense_segments) + software vendors tagged
//                       Facebook (software_subscriptions.segment). Commission
//                       counts as the P&L booked it (cash basis).
//   Facebook profit   — revenue − expenses.
//   SEO               — the P&L remainder.
//   Owner salary      — excluded (added back), so profit is before owner pay.
//
// Facebook profit + SEO profit == P&L net + owner salary, every month.

export type Segment = "seo" | "facebook";
export const SOFTWARE_LINE = "Software/Subscriptions";
const isSalaryLine = (account: string) => account.toLowerCase().includes("mitchell price");

export interface LinePart { label: string; amount: number }
export interface SideNumbers {
  revenue: number;
  expenses: number;
  profit: number;
  expenseLines: LinePart[]; // biggest first
}
export interface MonthRow {
  label: string;
  pnlNet: number;
  salary: number;
  fbRevenue: number;
  fbExpenses: number;
  fbCommission: number;          // commission as the P&L booked it (cash/books)
  fbAccrualCommission: number;   // commission EARNED this month (accrual)
  fbProfitBeforeCommission: number;
  fbProfit: number;              // books: after the booked commission (reconciles to P&L)
  fbProfitTrue: number;          // true month: after the accrual commission (the gauge)
  seoRevenue: number;
  seoExpenses: number;
  seoProfit: number;
  hasFbRevenue: boolean;
}
export interface BusinessBreakdown {
  hasData: boolean;
  month: string | null;
  income: number;
  totalExpenses: number;
  pnlNet: number;
  salary: number;
  beforeOwnerPay: number;   // pnlNet + salary
  fbCommission: number;             // latest month, books
  fbAccrualCommission: number;      // latest month, accrual
  fbProfitBeforeCommission: number; // latest month
  fbProfitTrue: number;             // latest month, true-month gauge
  fbTaggedOperating: number;        // FB operating expenses from P&L tags (ex-commission)
  fbFinanceAppOperating: number;    // FB operating expenses per the Finance app
  fbVariance: number;               // tagged − finance app (0 = reconciled)
  fb: SideNumbers;
  seo: SideNumbers;
  months: MonthRow[];
  notes: string[];
}

const MONTH_IDX: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseMonthYear(label: string): { m: number; y: number } | null {
  const m = MONTH_IDX[label.slice(0, 3).toLowerCase()];
  if (m == null) return null;
  const ym = label.match(/(\d{2,4})/);
  let y = ym ? Number(ym[1]) : new Date().getFullYear();
  if (y < 100) y += 2000;
  return { m, y };
}
const periodKey = (my: { m: number; y: number }) => `${my.y}-${String(my.m + 1).padStart(2, "0")}`;
const short = (label: string) => label.slice(0, 3).toLowerCase();
const round = (n: number | null | undefined) => Math.round(n ?? 0);
const EMPTY_SIDE: SideNumbers = { revenue: 0, expenses: 0, profit: 0, expenseLines: [] };

export interface SoftwareItem { vendor: string; month: string; amount: number; segment: Segment }

export function computeBreakdown(input: {
  parsed: ParsedPnl | null | undefined;
  expenseSegments: Record<string, Segment>;
  softwareItems: SoftwareItem[];
  fbRevenueByPeriod: Record<string, number>;
  fbCommissionByPeriod?: Record<string, number>;
  fbExpensesByPeriod?: Record<string, number>; // Finance-app FB operating expenses, for the variance check
}): BusinessBreakdown {
  const { parsed, expenseSegments = {}, softwareItems = [], fbRevenueByPeriod = {}, fbCommissionByPeriod = {}, fbExpensesByPeriod = {} } = input;
  const notes: string[] = [];

  if (!parsed || !parsed.periods.length) {
    return { hasData: false, month: null, income: 0, totalExpenses: 0, pnlNet: 0, salary: 0, beforeOwnerPay: 0, fbCommission: 0, fbAccrualCommission: 0, fbProfitBeforeCommission: 0, fbProfitTrue: 0, fbTaggedOperating: 0, fbFinanceAppOperating: 0, fbVariance: 0, fb: EMPTY_SIDE, seo: EMPTY_SIDE, months: [], notes: ["Upload a P&L to see the breakdown."] };
  }

  const periods = parsed.periods;
  const hasTotal = periods[periods.length - 1]?.toLowerCase() === "total";
  const monthIdxs = periods.map((_, i) => i).filter((i) => !(hasTotal && i === periods.length - 1));
  const li = latestMonthIndex(parsed);

  function forMonth(mo: number) {
    const label = periods[mo] ?? "";
    const my = label ? parseMonthYear(label) : null;
    const income = round(parsed!.summary.income[mo]);
    const totalExpenses = round(parsed!.summary.expenses[mo]);
    const pnlNet = round(parsed!.summary.net[mo] ?? income - totalExpenses);

    const leaves = expenseLeafLines(parsed!, mo);
    const salary = round(leaves.find((l) => isSalaryLine(l.account))?.amount ?? 0);

    // Facebook software = assigned software vendors for this month.
    const fbSoftware = round(
      softwareItems.filter((s) => s.segment === "facebook" && short(s.month) === short(label)).reduce((sum, s) => sum + Number(s.amount), 0)
    );
    const softwareLump = round(leaves.find((l) => l.account === SOFTWARE_LINE)?.amount ?? 0);

    // Facebook P&L lines (assigned), excluding the software lump (handled above)
    // and the owner-salary line (excluded entirely).
    const fbPnlLines: LinePart[] = [];
    for (const l of leaves) {
      if (l.amount === 0) continue;
      if (l.account === SOFTWARE_LINE || isSalaryLine(l.account)) continue;
      if (expenseSegments[l.account] === "facebook") fbPnlLines.push({ label: l.account, amount: round(l.amount) });
    }
    const period = my ? periodKey(my) : "";
    const hasFbRevenue = period in fbRevenueByPeriod;
    // No Facebook revenue entered for a month → we can't split it, so show the
    // whole month as SEO and leave Facebook blank (avoids a misleading negative).
    const fbActive = hasFbRevenue;

    // Commission = the assigned Facebook line(s) that are the partner commission.
    const fbCommissionTagged = fbPnlLines.filter((l) => l.label.toLowerCase().includes("commission")).reduce((s, l) => s + l.amount, 0);
    const fbCommission = fbActive ? fbCommissionTagged : 0;
    // Tagged operating (ex-commission) = tagged FB P&L lines minus commission + tagged software.
    const fbTaggedOperating = fbActive ? fbPnlLines.reduce((s, l) => s + l.amount, 0) - fbCommissionTagged + fbSoftware : 0;
    // TRUE operating = the Finance-app figure (the source of truth). It anchors
    // Facebook profit so it never shows more than reality; the gap to what's
    // tagged is a "variance" expense line. Falls back to tagged when not entered.
    const fbFinanceAppOperating = !fbActive ? 0 : period in fbExpensesByPeriod ? round(fbExpensesByPeriod[period]) : fbTaggedOperating;
    const fbOperating = fbFinanceAppOperating;
    const fbVariance = fbOperating - fbTaggedOperating; // untagged remainder, noted in expenses

    const fbRevenue = fbActive ? round(fbRevenueByPeriod[period]) : 0;
    const fbExpenses = fbOperating + fbCommission; // total incl booked commission
    const fbProfitBeforeCommission = fbRevenue - fbOperating; // the true figure
    const fbProfit = fbProfitBeforeCommission - fbCommission; // books (ties to P&L)
    // Accrual commission = the real commission EARNED this month (entered), used
    // for the "true month" gauge; falls back to the booked commission.
    const fbAccrualCommission = period in fbCommissionByPeriod ? round(fbCommissionByPeriod[period]) : fbCommission;
    const fbProfitTrue = fbProfitBeforeCommission - fbAccrualCommission;

    const beforeOwnerPay = pnlNet + salary;
    const seoProfit = beforeOwnerPay - fbProfit;      // remainder → ties out (books)
    const seoRevenue = income - fbRevenue;
    const seoExpenses = seoRevenue - seoProfit;

    // Facebook operating expense breakdown: tagged lines + software + the untagged
    // variance, so it sums to operating and profit never shows more than true.
    const fbLines: LinePart[] = fbActive ? fbPnlLines.filter((l) => !l.label.toLowerCase().includes("commission")).map((l) => ({ ...l })) : [];
    if (fbActive && fbSoftware) fbLines.push({ label: "Software (tagged)", amount: fbSoftware });
    if (fbActive && fbVariance) fbLines.push({ label: "Untagged Facebook costs (variance)", amount: fbVariance });
    fbLines.sort((a, b) => b.amount - a.amount);

    // SEO expense breakdown = the other P&L leaf lines (salary removed, software
    // net of the Facebook share). When Facebook isn't active, SEO carries all of it.
    const seoLines: LinePart[] = [];
    for (const l of leaves) {
      if (l.amount === 0 || isSalaryLine(l.account)) continue;
      if (l.account === SOFTWARE_LINE) { const seoSw = fbActive ? softwareLump - fbSoftware : softwareLump; if (seoSw) seoLines.push({ label: "Software/Subscriptions", amount: round(seoSw) }); continue; }
      if (fbActive && expenseSegments[l.account] === "facebook") continue;
      seoLines.push({ label: l.account, amount: round(l.amount) });
    }
    seoLines.sort((a, b) => b.amount - a.amount);
    const seoListed = seoLines.reduce((s, l) => s + l.amount, 0);
    if (Math.abs(seoExpenses - seoListed) >= 1) seoLines.push({ label: "Other / rounding", amount: seoExpenses - seoListed });

    const row: MonthRow = { label, pnlNet, salary, fbRevenue, fbExpenses, fbCommission, fbAccrualCommission, fbProfitBeforeCommission, fbProfit, fbProfitTrue, seoRevenue, seoExpenses, seoProfit, hasFbRevenue };
    return { row, income, totalExpenses, fbLines, seoLines, fbTaggedOperating, fbFinanceAppOperating, fbVariance };
  }

  const months = monthIdxs.map((mo) => forMonth(mo).row);
  const latest = forMonth(li);
  const r = latest.row;

  if (!r.hasFbRevenue) notes.push(`No Facebook revenue entered for ${r.label} yet — enter it below (from the Finance app) so the split is right.`);
  notes.push("Facebook revenue = Finance app; Facebook expenses = the P&L lines + software you tag Facebook; commission counts as the P&L booked it. Both sides sum to your P&L net + your salary.");

  return {
    hasData: true,
    month: r.label,
    income: latest.income,
    totalExpenses: latest.totalExpenses,
    pnlNet: r.pnlNet,
    salary: r.salary,
    beforeOwnerPay: r.pnlNet + r.salary,
    fbCommission: r.fbCommission,
    fbAccrualCommission: r.fbAccrualCommission,
    fbProfitBeforeCommission: r.fbProfitBeforeCommission,
    fbProfitTrue: r.fbProfitTrue,
    fbTaggedOperating: latest.fbTaggedOperating,
    fbFinanceAppOperating: latest.fbFinanceAppOperating,
    fbVariance: latest.fbVariance,
    fb: { revenue: r.fbRevenue, expenses: r.fbExpenses, profit: r.fbProfit, expenseLines: latest.fbLines },
    seo: { revenue: r.seoRevenue, expenses: r.seoExpenses, profit: r.seoProfit, expenseLines: latest.seoLines },
    months,
    notes
  };
}
