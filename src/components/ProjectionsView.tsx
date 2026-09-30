import { NextMonthBudget } from "@/components/NextMonthBudget";
import type { FbEstimateResult } from "@/lib/fb-estimate";
import type { ParsedPnl } from "@/lib/pnl-parse";
import type { ExplVendor } from "@/components/ExpenseExplorer";

// Next-month forecast: Facebook run-rate (your 50%) + SEO retainers, an expense
// trend, the editable budget, and the full client list by service.

function money(n: number): string {
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

export interface ProjMrrRow { company: string; mrr: number; status: string; segment: "seo" | "facebook" }

export function ProjectionsView({ fbEst, fbUnavailable, fbEstMonthLabel, seoClients, seoTotal, projectedRevenue, parsed, estimates, budgetVendors, bookMonths, mrr, trend }: {
  fbEst: FbEstimateResult;
  fbUnavailable: boolean;
  fbEstMonthLabel: string;
  seoClients: { company: string; mrr: number }[];
  seoTotal: number;
  projectedRevenue: number;
  parsed: ParsedPnl | null;
  estimates: Record<string, number>;
  budgetVendors: ExplVendor[];
  bookMonths: { period: string; label: string }[];
  mrr: ProjMrrRow[];
  trend: { label: string; value: number }[];
}) {
  const revenueNote = `Projected revenue = Facebook profit (your 50%) ${money(fbEst.yourProfit)} + SEO retainers ${money(seoTotal)}`;
  return (
    <div className="space-y-5">
      {/* Header — this whole tab is the current-month projection. */}
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 px-1">September projection</div>
        <div className="text-[13px] text-slate-500 px-1 mt-0.5">Projected revenue (Facebook run-rate + SEO retainers) minus your costs — edit or add expenses to see projected profit.</div>
      </div>

      {/* The projection itself: revenue in, editable + add-able costs, profit out. */}
      <NextMonthBudget parsed={parsed} estimates={estimates} defaultRevenue={projectedRevenue} vendors={budgetVendors} months={bookMonths} defaultOpen revenueNote={revenueNote} />

      {/* Where the projected revenue comes from — the fee breakdown by client. */}
      <div className="grid lg:grid-cols-2 gap-5">
        <FacebookProjection est={fbEst} unavailable={fbUnavailable} monthLabel={fbEstMonthLabel} />
        <SeoProjection clients={seoClients} total={seoTotal} />
      </div>

      {trend.length > 1 && <ExpenseTrend rows={trend} />}
      <ClientList rows={mrr} />
    </div>
  );
}

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="text-[16px] font-semibold text-slate-900">{title}</div>
      {sub ? <div className="text-[13px] text-slate-500 mt-0.5 mb-4">{sub}</div> : <div className="mb-4" />}
      {children}
    </div>
  );
}

function FacebookProjection({ est, unavailable, monthLabel }: { est: FbEstimateResult; unavailable: boolean; monthLabel: string }) {
  return (
    <Card title="Facebook profit projection" sub={`Your 50% after all Facebook costs · ${monthLabel}${unavailable ? " · dashboard offline, using your estimate" : ""}`}>
      <div className="mb-3 pb-3 border-b border-slate-100">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-[11px] text-slate-400">Your projected profit (50%)</div>
            <div className={"text-[26px] font-bold tabular-nums leading-none mt-0.5 " + (est.yourProfit < 0 ? "text-rose-500" : "text-emerald-600")}>{money(est.yourProfit)}</div>
          </div>
          <div className="text-[11px] text-slate-400 text-right leading-relaxed">
            revenue {money(est.revenue)}<br />
            − costs {money(est.costs)}<br />
            = net {money(est.net)}
          </div>
        </div>
      </div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">Ad spend fee by provider</div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-slate-400 text-left text-[10px] uppercase tracking-wider">
            <th className="font-medium pb-1.5">Provider</th>
            <th className="font-medium pb-1.5 px-2 text-right">Fee %</th>
            <th className="font-medium pb-1.5 px-2 text-right">Ad spend</th>
            <th className="font-medium pb-1.5 pl-2 text-right">Fee</th>
          </tr>
        </thead>
        <tbody>
          {est.providerRows.filter((r) => r.fee > 0).slice(0, 12).map((r) => (
            <tr key={r.name} className="border-t border-slate-50">
              <td className="py-1.5 text-slate-700 truncate max-w-[140px]">{r.name}</td>
              <td className="py-1.5 px-2 text-right tabular-nums text-slate-400">{r.feePct}%</td>
              <td className="py-1.5 px-2 text-right tabular-nums text-slate-500">{money(r.spend)}</td>
              <td className="py-1.5 pl-2 text-right tabular-nums font-semibold text-slate-900">{money(r.fee)}</td>
            </tr>
          ))}
          {est.onboarding > 0 && (
            <tr className="border-t border-slate-50">
              <td className="py-1.5 text-slate-700">Onboarding</td>
              <td className="py-1.5 px-2" /><td className="py-1.5 px-2" />
              <td className="py-1.5 pl-2 text-right tabular-nums font-semibold text-slate-900">{money(est.onboarding)}</td>
            </tr>
          )}
        </tbody>
      </table>
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

function ClientList({ rows }: { rows: ProjMrrRow[] }) {
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
