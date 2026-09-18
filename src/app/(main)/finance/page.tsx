import { Suspense } from "react";
import { Inter } from "next/font/google";
import { notFound, redirect } from "next/navigation";
import { Lock } from "lucide-react";
import { getCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isOwner } from "@/lib/access";
import { FinancePanel, type FinanceDoc } from "@/components/FinancePanel";
import { FinanceDashboard } from "@/components/FinanceDashboard";
import { ExpenseBreakdown } from "@/components/ExpenseBreakdown";
import { ExpenseVendors, type ExpenseRow } from "@/components/ExpenseVendors";
import { PayrollManual, type PayrollEntry } from "@/components/PayrollManual";
import { StripeMissing } from "@/components/StripeMissing";
import { MrrManual, type MrrEntry } from "@/components/MrrManual";
import { FacebookRevenue, FacebookRevenueLoading } from "@/components/FacebookRevenue";
import { FinanceOverviewView } from "@/components/FinanceOverviewView";
import { getFinanceOverview, type FinanceOverview } from "@/lib/finance-overview";
import { ScaleChat } from "@/components/ScaleChat";
import { getStripeRevenue } from "@/lib/stripe";
import { getFacebookRevenue } from "@/lib/facebook-revenue";
import type { ParsedPnl } from "@/lib/pnl-parse";

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
  const [docRes, overview, revenue, mrrRes, expRes, payRes] = await Promise.all([
    supabase.from("finance_documents").select("id, label, filename, content_type, size_bytes, uploaded_at, parsed").order("uploaded_at", { ascending: false }),
    getFinanceOverview(),
    getStripeRevenue().catch(() => null),
    supabase.from("mrr_entries").select("id, company, mrr, status, subscription_day, satisfaction, note, rank").order("rank", { ascending: true }),
    supabase.from("expense_line_items").select("account, vendor, month, amount"),
    supabase.from("payroll_entries").select("id, name, role, status, scale, rate, note, rank").order("rank", { ascending: true })
  ]);

  const rows = (docRes.data ?? []) as (FinanceDoc & { parsed: ParsedPnl | null })[];
  const latestParsed = rows.find((r) => r.parsed)?.parsed ?? null;
  const mrrRows = mrrRes.data ?? [];

  return (
    <div className={inter.className + " space-y-6 max-w-5xl mx-auto text-slate-900"}>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-slate-900 text-white grid place-items-center shrink-0">
          <Lock className="w-4 h-4" />
        </div>
        <h1 className="text-2xl font-bold text-slate-900 leading-tight">Finance</h1>
        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">Private</span>
      </div>

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
          <MrrManual initial={mrrRows as MrrEntry[]} />
          <StripeMissing rev={revenue} sheetNames={mrrRows.map((r) => r.company as string)} />
          <Suspense fallback={<FacebookRevenueLoading />}>
            <FacebookRevenueSection />
          </Suspense>
          <FinanceDashboard parsed={latestParsed} />
          <ExpenseBreakdown parsed={latestParsed} />
          <PayrollManual initial={(payRes.data ?? []) as PayrollEntry[]} />
          <ExpenseVendors rows={(expRes.data ?? []) as ExpenseRow[]} />
          <FinancePanel initialDocuments={rows.map(({ parsed, ...d }) => d)} />
        </div>
      </div>
    </div>
  );
}

async function FacebookRevenueSection() {
  return <FacebookRevenue result={await getFacebookRevenue()} />;
}
