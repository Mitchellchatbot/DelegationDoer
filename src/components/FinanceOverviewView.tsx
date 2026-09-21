import type { FinanceOverview } from "@/lib/finance-overview";
import { FinanceKpiCards } from "@/components/FinanceKpiCards";

// The reference-style finance dashboard: KPI cards, a revenue-vs-expenses chart,
// where the money goes, and the fastest-rising costs (the cut candidates). Pure
// presentation over getFinanceOverview(); no emoji, muted palette, Inter (from
// the page wrapper).


// The month series behind each KPI, for its sparkline.
function kpiSeries(d: FinanceOverview, label: string): number[] {
  if (label === "Revenue") return d.revenue;
  if (label === "Expenses") return d.expenses;
  if (label === "Net") return d.net;
  if (label === "Margin") return d.revenue.map((r, i) => (r ? Math.round((d.net[i] / r) * 100) : 0));
  return [];
}

// Revenue vs expenses line chart (SVG). Few months = few points, that's fine.
function Chart({ months, revenue, expenses }: { months: string[]; revenue: number[]; expenses: number[] }) {
  const W = 620, H = 200, padX = 8, padY = 16;
  const n = months.length;
  const max = Math.max(1, ...revenue, ...expenses);
  const x = (i: number) => padX + (n <= 1 ? 0 : (i / (n - 1)) * (W - padX * 2));
  const y = (v: number) => H - padY - (v / max) * (H - padY * 2);
  const line = (arr: number[]) => arr.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = `${line(revenue)} L ${x(n - 1).toFixed(1)} ${H - padY} L ${x(0).toFixed(1)} ${H - padY} Z`;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="none" role="img" aria-label="Revenue versus expenses by month">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={padX} x2={W - padX} y1={padY + f * (H - padY * 2)} y2={padY + f * (H - padY * 2)} stroke="#eef1f4" strokeWidth="1" strokeDasharray="4 4" />
        ))}
        <path d={area} fill="#2563eb" opacity="0.06" />
        <path d={line(revenue)} fill="none" stroke="#2563eb" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d={line(expenses)} fill="none" stroke="#cbd5e1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="flex justify-between mt-2 px-1">
        {months.map((m) => <span key={m} className="text-[11px] text-slate-400">{m}</span>)}
      </div>
    </div>
  );
}

export function FinanceOverviewView({ data }: { data: FinanceOverview }) {
  if (!data.hasPnl) {
    return <div className="rounded-2xl border border-slate-200 bg-white p-6 text-[13px] text-slate-500 shadow-sm">Upload a P&amp;L below to light up the dashboard.</div>;
  }
  return (
    <div className="space-y-5">
      <FinanceKpiCards
        actual={data.kpis}
        estimated={data.estKpis}
        partial={data.partialMonth}
        estLabel={data.estLabel}
        series={{ Revenue: kpiSeries(data, "Revenue"), Expenses: kpiSeries(data, "Expenses"), Net: kpiSeries(data, "Net"), Margin: kpiSeries(data, "Margin") }}
      />

      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between mb-1">
          <div className="text-[16px] font-semibold text-slate-900">Revenue</div>
          <div className="flex items-center gap-3 text-[12px]">
            <span className="inline-flex items-center gap-1.5 text-slate-500"><span className="w-2 h-2 rounded-full" style={{ background: "#2563eb" }} />Revenue</span>
            <span className="inline-flex items-center gap-1.5 text-slate-500"><span className="w-2 h-2 rounded-full" style={{ background: "#cbd5e1" }} />Expenses</span>
          </div>
        </div>
        <div className="text-[13px] text-slate-500 mb-4">Monthly revenue vs. operating expenses · where the money goes is in “Expenses · every month”.</div>
        <Chart months={data.months} revenue={data.revenue} expenses={data.expenses} />
      </div>
    </div>
  );
}
