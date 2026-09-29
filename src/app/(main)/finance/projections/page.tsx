import { Inter } from "next/font/google";
import { notFound, redirect } from "next/navigation";
import { LineChart } from "lucide-react";
import { getCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isOwner } from "@/lib/access";
import { FinanceTabs } from "@/components/FinanceTabs";
import { getFinanceOverview } from "@/lib/finance-overview";
import { getFacebookRevenue } from "@/lib/facebook-revenue";
import { projectFacebook, type FbProjection } from "@/lib/finance-projections";
import { NextMonthBudget } from "@/components/NextMonthBudget";
import type { ParsedPnl } from "@/lib/pnl-parse";
import type { ExplVendor } from "@/components/ExpenseExplorer";
import type { DeelRow } from "@/components/DeelContractors";
import type { PnlMonth } from "@/lib/finance-learnings";

export const dynamic = "force-dynamic";
const inter = Inter({ subsets: ["latin"], display: "swap" });

function money(n: number): string {
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

type MrrRow = { company: string; mrr: number; status: string; segment: string | null };

export default async function FinanceProjectionsPage() {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/login");
  const user = await getUserById(userId);
  if (!isOwner(user)) notFound();

  const supabase = getSupabaseAdmin();
  const [overview, fbResult, mrrRes, estRes, docRes, expRes, deelRes, pnlRes] = await Promise.all([
    getFinanceOverview(),
    getFacebookRevenue().catch(() => ({ ok: false as const, error: "unavailable" })),
    supabase.from("mrr_entries").select("company, mrr, status, segment").order("mrr", { ascending: false }),
    supabase.from("expense_estimates").select("account, amount"),
    supabase.from("finance_documents").select("parsed").order("uploaded_at", { ascending: false }).limit(5),
    supabase.from("expense_line_items").select("account, vendor, month, amount"),
    supabase.from("deel_payments").select("period, contractor, amount, is_fee"),
    supabase.from("pnl_monthly").select("period, label, income, expenses, net").order("period", { ascending: true })
  ]);

  const parsed = ((docRes.data ?? []) as { parsed: ParsedPnl | null }[]).find((d) => d.parsed)?.parsed ?? null;
  const estimates: Record<string, number> = {};
  for (const e of (estRes.data ?? []) as { account: string; amount: number }[]) estimates[e.account] = Number(e.amount);

  const mrr = ((mrrRes.data ?? []) as MrrRow[]).map((r) => ({ company: String(r.company ?? ""), mrr: Number(r.mrr) || 0, status: r.status, segment: (r.segment ?? "seo") as "seo" | "facebook" }));
  const seoClients = mrr.filter((r) => r.segment === "seo" && r.status !== "churned" && r.mrr > 0).sort((a, b) => b.mrr - a.mrr);
  const seoTotal = seoClients.reduce((s, r) => s + r.mrr, 0);

  const fb: FbProjection | null = fbResult.ok ? projectFacebook(fbResult.data) : null;
  const fbYour = fb?.yourTotal ?? 0;
  const projectedRevenue = fbYour + seoTotal;

  // Budget inputs (mirror the Overview page): contractor payments break down by
  // person from Deel; other accounts use the QuickBooks vendor export.
  const deelRows = ((deelRes.data ?? []) as DeelRow[]).map((r) => ({ period: r.period, contractor: r.contractor, amount: Number(r.amount), is_fee: !!r.is_fee }));
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const period3 = (p: string) => M[Number(p.slice(5, 7)) - 1] ?? p;
  const budgetVendors: ExplVendor[] = [
    ...((expRes.data ?? []) as ExplVendor[]).filter((v) => v.account !== "Contractor Payments"),
    ...deelRows.filter((r) => !r.is_fee).map((r) => ({ account: "Contractor Payments", vendor: r.contractor, month: period3(r.period), amount: r.amount }))
  ];
  const pnlMonths = (pnlRes.data ?? []) as PnlMonth[];
  const bookMonths = pnlMonths.map((m) => ({ period: m.period, label: m.label }));

  // Expense trend — last 6 months of total expenses.
  const trend = overview.months.map((label, i) => ({ label, value: overview.expenses[i] ?? 0 })).slice(-6);

  return (
    <div className={inter.className + " space-y-6 max-w-5xl mx-auto text-slate-900"}>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-slate-900 text-white grid place-items-center shrink-0">
          <LineChart className="w-4 h-4" />
        </div>
        <h1 className="text-2xl font-bold text-slate-900 leading-tight">Projections</h1>
        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">Private</span>
      </div>

      <FinanceTabs active="projections" />

      {/* Projected revenue: Facebook (from ad spend) + SEO (retainers). */}
      <div className="grid lg:grid-cols-2 gap-5">
        <FacebookProjection fb={fb} unavailable={!fbResult.ok} />
        <SeoProjection clients={seoClients} total={seoTotal} />
      </div>

      {/* Expense trend — where costs are heading. */}
      {trend.length > 1 && <ExpenseTrend rows={trend} />}

      {/* Editable budget: projected revenue in, expenses per line, profit out. */}
      <NextMonthBudget parsed={parsed} estimates={estimates} defaultRevenue={projectedRevenue} vendors={budgetVendors} months={bookMonths} />

      {/* Full client list, by service. */}
      <ClientList rows={mrr} />
    </div>
  );
}

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="text-[16px] font-semibold text-slate-900">{title}</div>
      {sub && <div className="text-[13px] text-slate-500 mt-0.5 mb-4">{sub}</div>}
      {!sub && <div className="mb-4" />}
      {children}
    </div>
  );
}

function FacebookProjection({ fb, unavailable }: { fb: FbProjection | null; unavailable: boolean }) {
  if (unavailable || !fb) {
    return <Card title="Facebook — projected" sub="From live ad spend"><div className="text-[13px] text-slate-500">Facebook dashboard unavailable right now.</div></Card>;
  }
  const note = fb.provisional ? `run-rate through day ${fb.elapsed} of ${fb.daysInMonth}` : "full month";
  return (
    <Card title="Facebook — projected" sub={`Ad spend × days × fee, your 50% · ${note}`}>
      <div className="flex items-end justify-between mb-3">
        <div>
          <div className="text-[11px] text-slate-400">Your projected revenue (50%)</div>
          <div className="text-[26px] font-bold tabular-nums text-emerald-600 leading-none mt-0.5">{money(fb.yourTotal)}</div>
        </div>
        <div className="text-[12px] text-slate-400 text-right">of {money(fb.grossFee)} gross fee</div>
      </div>
      <div className="divide-y divide-slate-100">
        {fb.clients.slice(0, 8).map((c) => (
          <div key={c.name} className="flex items-center justify-between gap-2 py-1.5 text-[13px]">
            <span className="text-slate-700 truncate">{c.name} <span className="text-slate-400">{Math.round(c.rate * 100)}%</span></span>
            <span className="tabular-nums text-slate-500 shrink-0">{money(c.projectedSpend)} → <span className="font-semibold text-slate-900">{money(c.yourShare)}</span></span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function SeoProjection({ clients, total }: { clients: { company: string; mrr: number }[]; total: number }) {
  return (
    <Card title="SEO — projected" sub="Active retainers next month">
      <div className="mb-3">
        <div className="text-[11px] text-slate-400">Projected SEO revenue</div>
        <div className="text-[26px] font-bold tabular-nums text-slate-900 leading-none mt-0.5">{money(total)}</div>
      </div>
      <div className="divide-y divide-slate-100 max-h-64 overflow-y-auto">
        {clients.slice(0, 12).map((c) => (
          <div key={c.company} className="flex items-center justify-between gap-2 py-1.5 text-[13px]">
            <span className="text-slate-700 truncate">{c.company}</span>
            <span className="tabular-nums font-semibold text-slate-900 shrink-0">{money(c.mrr)}</span>
          </div>
        ))}
        {clients.length > 12 && <div className="text-[11px] text-slate-400 pt-1.5">+{clients.length - 12} more</div>}
      </div>
    </Card>
  );
}

function ExpenseTrend({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Card title="Expense trend" sub={`Total expenses, last ${rows.length} months`}>
      <div className="flex items-end gap-3 h-28">
        {rows.map((r) => (
          <div key={r.label} className="flex-1 flex flex-col items-center justify-end gap-1.5 h-full min-w-0">
            <div className="text-[11px] font-semibold tabular-nums text-slate-700">{money(r.value)}</div>
            <div className="w-full flex-1 min-h-0 flex items-end">
              <div className="w-full rounded-t bg-slate-300" style={{ height: `${Math.max(2, (r.value / max) * 100)}%` }} />
            </div>
            <div className="text-[11px] text-slate-400 truncate w-full text-center">{r.label}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ClientList({ rows }: { rows: { company: string; mrr: number; status: string; segment: "seo" | "facebook" }[] }) {
  const active = rows.filter((r) => r.status !== "churned").sort((a, b) => b.mrr - a.mrr);
  return (
    <Card title="Clients" sub={`${active.length} active · by service and what they pay`}>
      <div className="divide-y divide-slate-100">
        {active.map((r) => (
          <div key={r.company} className="flex items-center justify-between gap-3 py-2 text-[13px]">
            <div className="min-w-0 flex items-center gap-2">
              <span className={"text-[10px] font-medium uppercase tracking-wide rounded px-1.5 py-0.5 shrink-0 " + (r.segment === "facebook" ? "text-sky-700 bg-sky-50" : "text-violet-700 bg-violet-50")}>{r.segment === "facebook" ? "FB" : "SEO"}</span>
              <span className="text-slate-800 truncate">{r.company}</span>
              {r.status === "paused" && <span className="text-[10px] text-amber-600">paused</span>}
            </div>
            <span className="tabular-nums font-semibold text-slate-900 shrink-0">{money(r.mrr)}<span className="text-[11px] font-normal text-slate-400">/mo</span></span>
          </div>
        ))}
      </div>
    </Card>
  );
}
