import { NextMonthBudget } from "@/components/NextMonthBudget";
import type { FbProjection } from "@/lib/finance-projections";
import type { ParsedPnl } from "@/lib/pnl-parse";
import type { ExplVendor } from "@/components/ExpenseExplorer";

// Next-month forecast: Facebook run-rate (your 50%) + SEO retainers, an expense
// trend, the editable budget, and the full client list by service.

function money(n: number): string {
  const s = n < 0 ? "-" : "";
  return `${s}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

export interface ProjMrrRow { company: string; mrr: number; status: string; segment: "seo" | "facebook" }

export function ProjectionsView({ fb, fbUnavailable, seoClients, seoTotal, projectedRevenue, parsed, estimates, budgetVendors, bookMonths, mrr, trend }: {
  fb: FbProjection | null;
  fbUnavailable: boolean;
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
  return (
    <div className="space-y-5">
      <div className="grid lg:grid-cols-2 gap-5">
        <FacebookProjection fb={fb} unavailable={fbUnavailable} />
        <SeoProjection clients={seoClients} total={seoTotal} />
      </div>
      {trend.length > 1 && <ExpenseTrend rows={trend} />}
      <NextMonthBudget parsed={parsed} estimates={estimates} defaultRevenue={projectedRevenue} vendors={budgetVendors} months={bookMonths} />
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
