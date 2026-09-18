import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { ParsedPnl } from "@/lib/pnl-parse";

// Deterministic finance dashboard data — KPIs, the revenue/expenses series, the
// biggest costs, and the fastest-RISING costs (the cut candidates). No model
// call: this is the ground truth the cost-cutting brain and the chat reason over.

export interface FinanceKpi { label: string; value: number; deltaPct: number | null; goodWhenUp: boolean; isPct?: boolean }
export interface CostRow { name: string; amount: number; sharePct: number }
export interface RisingRow { name: string; from: number; to: number; deltaPct: number; kind: "category" | "software" }
export interface FinanceOverview {
  hasPnl: boolean;
  months: string[];
  revenue: number[];
  expenses: number[];
  net: number[];
  latestMonth: string | null;
  kpis: FinanceKpi[];
  topCosts: CostRow[];
  rising: RisingRow[];
}

const r0 = (n: number | null | undefined) => Math.round(n ?? 0);
const pctChange = (from: number, to: number): number | null => (from ? Math.round(((to - from) / Math.abs(from)) * 100) : null);

export async function getFinanceOverview(): Promise<FinanceOverview> {
  const supabase = getSupabaseAdmin();
  const [finRes, swRes] = await Promise.all([
    supabase.from("finance_documents").select("parsed").order("uploaded_at", { ascending: false }).limit(5),
    supabase.from("software_subscriptions").select("vendor, month, amount")
  ]);
  const parsed = ((finRes.data ?? []) as { parsed: ParsedPnl | null }[]).find((d) => d.parsed)?.parsed ?? null;

  const empty: FinanceOverview = { hasPnl: false, months: [], revenue: [], expenses: [], net: [], latestMonth: null, kpis: [], topCosts: [], rising: [] };
  if (!parsed || !parsed.periods.length) return empty;

  const periods = parsed.periods;
  const hasTotal = periods[periods.length - 1]?.toLowerCase() === "total";
  const totalIdx = periods.length - 1;
  const months = hasTotal ? periods.slice(0, -1) : periods;
  if (months.length === 0) return empty;
  const li = months.length - 1;        // latest month index
  const pi = months.length - 2;        // prior month index (may be -1)

  const revenue = months.map((_, i) => r0(parsed.summary.income[i]));
  const expenses = months.map((_, i) => r0(parsed.summary.expenses[i]));
  const net = months.map((_, i) => r0(parsed.summary.net[i]));

  const marginOf = (i: number) => (revenue[i] ? Math.round((net[i] / revenue[i]) * 100) : 0);
  const kpis: FinanceKpi[] = [
    { label: "Revenue", value: revenue[li], deltaPct: pi >= 0 ? pctChange(revenue[pi], revenue[li]) : null, goodWhenUp: true },
    { label: "Expenses", value: expenses[li], deltaPct: pi >= 0 ? pctChange(expenses[pi], expenses[li]) : null, goodWhenUp: false },
    { label: "Net", value: net[li], deltaPct: pi >= 0 ? pctChange(net[pi], net[li]) : null, goodWhenUp: true },
    { label: "Margin", value: marginOf(li), deltaPct: pi >= 0 ? marginOf(li) - marginOf(pi) : null, goodWhenUp: true, isPct: true }
  ];

  // Expense categories (level-1 rows between EXPENSES and Total Expenses).
  const startI = parsed.rows.findIndex((r) => r.account.toUpperCase() === "EXPENSES");
  const endI = parsed.rows.findIndex((r) => r.account.toLowerCase() === "total expenses");
  const cats: { name: string; monthly: number[] }[] = [];
  if (startI >= 0 && endI > startI) {
    for (let i = startI + 1; i < endI; i++) {
      const row = parsed.rows[i];
      if (row.level !== 1) continue;
      // Prefer the category's own monthly values; fall back to its "Total X" child.
      let vals = row.values;
      if (!months.some((_, mi) => (row.values[mi] ?? 0) !== 0)) {
        for (let j = i + 1; j < endI && parsed.rows[j].level > 1; j++) {
          if (parsed.rows[j].account.toLowerCase() === `total ${row.account.toLowerCase()}`) { vals = parsed.rows[j].values; break; }
        }
      }
      cats.push({ name: row.account, monthly: months.map((_, mi) => r0(vals[mi])) });
    }
  }

  const totalExpLatest = expenses[li] || cats.reduce((s, c) => s + c.monthly[li], 0) || 1;
  const topCosts: CostRow[] = [...cats]
    .map((c) => ({ name: c.name, amount: c.monthly[li], sharePct: Math.round((c.monthly[li] / totalExpLatest) * 100) }))
    .filter((c) => c.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 6);

  // Rising costs: categories with the biggest month-over-month jump, plus rising
  // software vendors (the itemized cut candidates).
  const rising: RisingRow[] = [];
  if (pi >= 0) {
    for (const c of cats) {
      const from = c.monthly[pi], to = c.monthly[li];
      if (to > from && to - from >= 100) rising.push({ name: c.name, from, to, deltaPct: pctChange(from, to) ?? 0, kind: "category" });
    }
  }
  // Software vendors month-over-month (uses the last two months present).
  const swByVendor = new Map<string, Record<string, number>>();
  const swMonths = new Set<string>();
  for (const s of (swRes.data ?? []) as { vendor: string; month: string; amount: number }[]) {
    swMonths.add(s.month);
    const v = swByVendor.get(s.vendor) ?? {};
    v[s.month] = (v[s.month] ?? 0) + Number(s.amount);
    swByVendor.set(s.vendor, v);
  }
  const swMonthList = [...swMonths];
  if (swMonthList.length >= 2) {
    const prevM = swMonthList[swMonthList.length - 2], lastM = swMonthList[swMonthList.length - 1];
    for (const [vendor, m] of swByVendor) {
      const from = r0(m[prevM]), to = r0(m[lastM]);
      if (to > from && to - from >= 50) rising.push({ name: vendor, from, to, deltaPct: pctChange(from, to) ?? 0, kind: "software" });
    }
  }
  rising.sort((a, b) => (b.to - b.from) - (a.to - a.from));

  return { hasPnl: true, months, revenue, expenses, net, latestMonth: months[li], kpis, topCosts, rising: rising.slice(0, 6) };
}
