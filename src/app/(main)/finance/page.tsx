import { Inter } from "next/font/google";
import { notFound, redirect } from "next/navigation";
import { Lock } from "lucide-react";
import { getCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isOwner } from "@/lib/access";
import { FinancePanel, type FinanceDoc } from "@/components/FinancePanel";
import { ExpenseBreakdown } from "@/components/ExpenseBreakdown";
import { ExpenseVendors, type ExpenseRow } from "@/components/ExpenseVendors";
import { PayrollManual, type PayrollEntry } from "@/components/PayrollManual";
import { StripeMissing } from "@/components/StripeMissing";
import { MrrManual, type MrrEntry } from "@/components/MrrManual";
import { FacebookRevenue } from "@/components/FacebookRevenue";
import { FinanceOverviewView } from "@/components/FinanceOverviewView";
import { NextMonthBudget } from "@/components/NextMonthBudget";
import { getFinanceOverview, type FinanceOverview } from "@/lib/finance-overview";
import { ScaleChat } from "@/components/ScaleChat";
import { getStripeRevenue } from "@/lib/stripe";
import { getFacebookRevenue } from "@/lib/facebook-revenue";
import { latestMonthIndex, expenseLeafLines, type ParsedPnl, type ExpenseLeaf } from "@/lib/pnl-parse";
import { computeBreakdown, type Segment, type SoftwareItem } from "@/lib/finance-segments";
import { BusinessBreakdownView } from "@/components/BusinessBreakdown";
import { ExpenseLabels, type SoftwareRow } from "@/components/ExpenseLabels";
import { FacebookMonthly, type FbMonthInput } from "@/components/FacebookMonthly";
import { computeLearnings, type PnlMonth } from "@/lib/finance-learnings";
import { LearningsRisks } from "@/components/LearningsRisks";
import { BooksByMonth, type BookLine, type BookMonth } from "@/components/BooksByMonth";
import { DeelContractors, type DeelRow } from "@/components/DeelContractors";
import { computeDefense } from "@/lib/finance-defense";
import { SurvivalDefense } from "@/components/SurvivalDefense";

// Map a P&L period label ("Aug '26") to a 'YYYY-MM' key.
const MONTH_NUM: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function periodOf(label: string): string | null {
  const m = MONTH_NUM[label.slice(0, 3).toLowerCase()];
  if (!m) return null;
  const ym = label.match(/(\d{2,4})/);
  let y = ym ? Number(ym[1]) : new Date().getFullYear();
  if (y < 100) y += 2000;
  return `${y}-${String(m).padStart(2, "0")}`;
}

export const dynamic = "force-dynamic";

const inter = Inter({ subsets: ["latin"], display: "swap" });

const FINANCE_STARTERS = [
  "What should I cut to save the most?",
  "What's rising month over month?",
  "Where's my margin going?",
  "What's my biggest expense and is it worth it?",
  "Can I afford to hire right now?"
];

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

// The finance brain "speaks first": a grounded money snapshot built from the
// overview (no model call), so the chat leads with the picture and the cut.
function buildFinanceOpening(o: FinanceOverview): string | undefined {
  if (!o.hasPnl) return undefined;
  const net = o.net[o.net.length - 1] ?? 0;
  const rev = o.revenue[o.revenue.length - 1] ?? 0;
  const margin = rev ? Math.round((net / rev) * 100) : 0;
  const lines = [`**Your money picture (${o.latestMonth}).** Net ${money(net)} on ${money(rev)} revenue — ${margin}% margin.`];
  if (o.topCosts[0]) lines.push(`**Biggest cost:** ${o.topCosts[0].name} at ${money(o.topCosts[0].amount)}/mo.`);
  if (o.rising[0]) lines.push(`**Rising fastest:** ${o.rising[0].name} (+${o.rising[0].deltaPct}%). Start cuts here.`);
  lines.push("Ask me what to cut, or tap a question below.");
  return lines.join("\n\n");
}

// Owner-only, hidden financials section. Anyone who isn't Mitchell gets a 404.
// The API routes enforce the same gate independently.
export default async function FinancePage() {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/login");
  const user = await getUserById(userId);
  if (!isOwner(user)) notFound();

  const supabase = getSupabaseAdmin();
  const [docRes, overview, revenue, mrrRes, expRes, payRes, estRes, expSegRes, swRes, fbMonthRes, fbResult, pnlRes, pnlLinesRes, deelRes] = await Promise.all([
    supabase.from("finance_documents").select("id, label, filename, content_type, size_bytes, uploaded_at, parsed").order("uploaded_at", { ascending: false }),
    getFinanceOverview(),
    getStripeRevenue().catch(() => null),
    supabase.from("mrr_entries").select("id, company, mrr, status, subscription_day, satisfaction, note, rank").order("rank", { ascending: true }),
    supabase.from("expense_line_items").select("account, vendor, month, amount"),
    supabase.from("payroll_entries").select("id, name, role, status, scale, rate, note, rank").order("rank", { ascending: true }),
    supabase.from("expense_estimates").select("account, amount"),
    supabase.from("expense_segments").select("account, segment"),
    supabase.from("software_subscriptions").select("vendor, month, amount, segment"),
    supabase.from("facebook_monthly").select("period, revenue, commission, expenses"),
    getFacebookRevenue().catch(() => ({ ok: false as const, error: "unavailable" })),
    supabase.from("pnl_monthly").select("period, label, income, expenses, net, taxes, writeoffs, software, contractors, advertising").order("period", { ascending: true }),
    supabase.from("pnl_lines").select("period, account, section, amount"),
    supabase.from("deel_payments").select("period, contractor, amount, is_fee")
  ]);

  const rows = (docRes.data ?? []) as (FinanceDoc & { parsed: ParsedPnl | null })[];
  const latestParsed = rows.find((r) => r.parsed)?.parsed ?? null;
  const mrrRows = mrrRes.data ?? [];
  const estimates: Record<string, number> = {};
  for (const e of (estRes.data ?? []) as { account: string; amount: number }[]) estimates[e.account] = Number(e.amount);

  // Facebook assignment inputs: P&L line labels, software vendor labels, and the
  // Facebook revenue per month from the Finance app.
  const expenseSegments: Record<string, Segment> = {};
  for (const s of (expSegRes.data ?? []) as { account: string; segment: Segment }[]) expenseSegments[s.account] = s.segment;
  const softwareItems = ((swRes.data ?? []) as SoftwareItem[]).map((s) => ({ vendor: s.vendor, month: s.month, amount: Number(s.amount), segment: (s.segment ?? "seo") as Segment }));
  const fbRevenueByPeriod: Record<string, number> = {};
  const fbCommissionByPeriod: Record<string, number> = {};
  const fbExpensesByPeriod: Record<string, number> = {};
  for (const r of (fbMonthRes.data ?? []) as { period: string; revenue: number; commission: number; expenses: number }[]) {
    fbRevenueByPeriod[r.period] = Number(r.revenue);
    if (r.commission != null) fbCommissionByPeriod[r.period] = Number(r.commission);
    if (r.expenses != null) fbExpensesByPeriod[r.period] = Number(r.expenses);
  }

  const expenseLines: ExpenseLeaf[] = latestParsed ? expenseLeafLines(latestParsed, latestMonthIndex(latestParsed)) : [];
  const periods = latestParsed?.periods ?? [];
  const hasTotal = periods[periods.length - 1]?.toLowerCase() === "total";
  const monthLabels = periods.filter((_, i) => !(hasTotal && i === periods.length - 1));
  const fbMonthInputs: FbMonthInput[] = monthLabels
    .map((l) => ({ period: periodOf(l) ?? "", label: l }))
    .filter((m) => m.period);
  const latestShort = monthLabels.length ? monthLabels[monthLabels.length - 1].slice(0, 3).toLowerCase() : "";

  const breakdown = computeBreakdown({ parsed: latestParsed, expenseSegments, softwareItems, fbRevenueByPeriod, fbCommissionByPeriod, fbExpensesByPeriod });

  // Learnings & risks: 10-month P&L history + Facebook + software + client concentration.
  const pnlMonths = ((pnlRes.data ?? []) as PnlMonth[]).map((m) => ({
    period: m.period, label: m.label, income: Number(m.income), expenses: Number(m.expenses), net: Number(m.net),
    taxes: Number(m.taxes), writeoffs: Number(m.writeoffs), software: Number(m.software), contractors: Number(m.contractors), advertising: Number(m.advertising)
  }));
  const learnings = computeLearnings({
    pnl: pnlMonths,
    fbRevenueByPeriod,
    fbExpensesByPeriod,
    softwareItems,
    mrrClients: (mrrRows as { company: string; mrr: number }[]).map((r) => ({ company: String(r.company ?? ""), mrr: Number(r.mrr) || 0 }))
  });

  // Account-level books, every uploaded month (Nov '25 → Aug '26).
  const bookLines = ((pnlLinesRes.data ?? []) as BookLine[]).map((l) => ({ period: l.period, account: l.account, section: l.section, amount: Number(l.amount) }));
  const bookMonths: BookMonth[] = pnlMonths.map((m) => ({ period: m.period, label: m.label }));
  const deelRows = ((deelRes.data ?? []) as DeelRow[]).map((r) => ({ period: r.period, contractor: r.contractor, amount: Number(r.amount), is_fee: !!r.is_fee }));

  // CFO survival model: 30% margin before founder pay, cut ladder, client-loss playbook.
  const latestPnl = pnlMonths[pnlMonths.length - 1];
  const defense = computeDefense({
    month: latestPnl?.label ?? "",
    revenue: latestPnl?.income ?? 0,
    normalizedNet: latestPnl ? latestPnl.net + latestPnl.taxes + latestPnl.writeoffs : 0,
    founderPay: latestPnl ? bookLines.filter((l) => l.period === latestPnl.period && l.account.toLowerCase().includes("mitchell price")).reduce((s, l) => s + l.amount, 0) : 0,
    software: latestPnl?.software ?? 0,
    ads: latestPnl?.advertising ?? 0,
    contractors: latestPnl ? deelRows.filter((r) => r.period === latestPnl.period && !r.is_fee).map((r) => ({ name: r.contractor, monthly: r.amount })) : [],
    topClients: (mrrRows as { company: string; mrr: number }[]).map((r) => ({ company: String(r.company ?? ""), mrr: Number(r.mrr) || 0 })).filter((c) => c.mrr > 0).sort((a, b) => b.mrr - a.mrr)
  });

  return (
    <div className={inter.className + " space-y-6 max-w-5xl mx-auto text-slate-900"}>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-slate-900 text-white grid place-items-center shrink-0">
          <Lock className="w-4 h-4" />
        </div>
        <h1 className="text-2xl font-bold text-slate-900 leading-tight">Finance</h1>
        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">Private</span>
      </div>

      {/* CFO survival rule: 30% margin before founder pay, with the defense plan. */}
      <SurvivalDefense data={defense} />

      {/* The two sides of one P&L, side by side: Facebook vs SEO & website. */}
      <BusinessBreakdownView data={breakdown} />

      {/* Learnings & risks: growth, software, Facebook, concentration, projections. */}
      <LearningsRisks data={learnings} />

      {/* Dashboard: KPIs, revenue vs expenses, where the money goes, where to cut. */}
      <FinanceOverviewView data={overview} />

      {/* The cost-cutting brain — reasons over the P&L, software and payroll. */}
      <ScaleChat
        title="Ask your finances"
        subtitle="What should you cut? It reads your P&L, software, payroll and MRR."
        starters={FINANCE_STARTERS}
        opening={buildFinanceOpening(overview)}
      />

      {/* Details + management — the source-of-truth lists and uploads. */}
      <div className="pt-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 px-1 mb-2.5">Manage</div>
        <div className="space-y-5">
          {/* Source of truth + the inputs that drive the breakdown, first. */}
          <MrrManual initial={mrrRows as MrrEntry[]} />
          <StripeMissing rev={revenue} sheetNames={mrrRows.map((r) => r.company as string)} />
          <FacebookMonthly months={fbMonthInputs} initial={fbRevenueByPeriod} expensesInitial={fbExpensesByPeriod} commissionInitial={fbCommissionByPeriod} />
          <ExpenseLabels lines={expenseLines} lineInitial={expenseSegments} software={softwareItems as SoftwareRow[]} latestShort={latestShort} />
          {/* Planning + drill-downs. */}
          <NextMonthBudget parsed={latestParsed} estimates={estimates} />
          <PayrollManual initial={(payRes.data ?? []) as PayrollEntry[]} />
          <DeelContractors rows={deelRows} />
          <ExpenseBreakdown parsed={latestParsed} />
          <ExpenseVendors rows={(expRes.data ?? []) as ExpenseRow[]} />
          <BooksByMonth lines={bookLines} months={bookMonths} />
          {/* Reference + files, last. */}
          <FacebookRevenue result={fbResult} />
          <FinancePanel initialDocuments={rows.map(({ parsed, ...d }) => d)} />
        </div>
      </div>
    </div>
  );
}

