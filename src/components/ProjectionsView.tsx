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

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

// The period arrives as 'YYYY-MM' on the ad accounts' calendar. Split it rather
// than going through Date, so the viewer's timezone can't shift the month.
function monthName(period: string): string {
  return MONTHS[Number(period.slice(5, 7)) - 1] ?? period;
}

export interface ProjMrrRow { company: string; mrr: number; status: string; segment: "seo" | "facebook" }

export function ProjectionsView({ fb, fbError, seoClients, seoTotal, projectedRevenue, parsed, estimates, budgetVendors, bookMonths, mrr, trend }: {
  fb: FbProjection | null;
  /** Why the Finance app feed is missing, verbatim, or null when it loaded.
   *  A boolean here used to strand the reason on the Facebook card alone,
   *  leaving this tab saying only "unavailable". */
  fbError: string | null;
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
  // Name the month from the same payload the figures come from, so the heading
  // and the numbers can never disagree — and claim no month at all when the
  // Finance app is unreachable, rather than asserting one we can't confirm.
  const heading = fb ? `${monthName(fb.period)} projection` : "Current month projection";
  // A missing Facebook feed is NOT $0. projectedRevenue already excludes it, so
  // say so plainly instead of quietly understating the month — the revenue line
  // below is editable, and the owner needs to know it is short a whole segment.
  const fbDown = fbError !== null || !fb;
  const revenueNote = fbDown
    ? `Projected revenue = SEO retainers ${money(seoTotal)} only — the Facebook run-rate is unavailable, so it is not included.`
    : `Projected revenue = Facebook (your 50%) ${money(fb.yourTotal)} + SEO retainers ${money(seoTotal)}`;
  return (
    <div className="space-y-5">
      {/* Header — this whole tab is the current-month projection. */}
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 px-1">{heading}</div>
        <div className="text-[13px] text-slate-500 px-1 mt-0.5">Projected revenue (Facebook run-rate + SEO retainers) minus your costs — edit or add expenses to see projected profit.</div>
      </div>

      {/* The projection itself: revenue in, editable + add-able costs, profit out. */}
      <NextMonthBudget parsed={parsed} estimates={estimates} defaultRevenue={projectedRevenue} vendors={budgetVendors} months={bookMonths} defaultOpen revenueNote={revenueNote} />

      {/* Where the projected revenue comes from — the fee breakdown by client. */}
      <div className="grid lg:grid-cols-2 gap-5">
        <FacebookProjection fb={fb} error={fbError} />
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

function FacebookProjection({ fb, error }: { fb: FbProjection | null; error: string | null }) {
  if (error !== null || !fb) {
    // Say which app and why. "unavailable right now" reads as a blip you should
    // wait out; the reason is what tells the owner whether to wait, re-check
    // the config, or go look at the Finance app. It also named the wrong
    // service — these figures come from the Finance app, not the ads dashboard.
    return (
      <Card title="Facebook profit projection" sub="From live ad spend">
        <div className="text-[13px] text-slate-500">Finance app unavailable — this month&rsquo;s Facebook fees are not included in the projection above.</div>
        {error && <div className="text-[12px] text-amber-600 mt-1.5 break-words">{error}</div>}
      </Card>
    );
  }
  const note = fb.provisional ? `run-rate through day ${fb.elapsed} of ${fb.daysInMonth}` : "full month";
  return (
    <Card title="Facebook profit projection" sub={`Your 50% after Facebook salaries & costs · ${note}`}>
      <div className="mb-3 pb-3 border-b border-slate-100">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-[11px] text-slate-400">Your projected profit (50%)</div>
            <div className={"text-[26px] font-bold tabular-nums leading-none mt-0.5 " + (fb.yourProfit < 0 ? "text-rose-500" : "text-emerald-600")}>{money(fb.yourProfit)}</div>
          </div>
          <div className="text-[11px] text-slate-400 text-right leading-relaxed">
            fee {money(fb.grossFee)}<br />
            − salaries {money(fb.salaries)}<br />
            {fb.opex > 0 && <>− costs {money(fb.opex)}<br /></>}
            = net {money(fb.net)}
          </div>
        </div>
      </div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">Fee breakdown by client</div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-slate-400 text-left text-[10px] uppercase tracking-wider">
            <th className="font-medium pb-1.5">Client</th>
            <th className="font-medium pb-1.5 px-2 text-right">Rate</th>
            <th className="font-medium pb-1.5 px-2 text-right">Proj. spend</th>
            <th className="font-medium pb-1.5 pl-2 text-right">Your fee</th>
          </tr>
        </thead>
        <tbody>
          {fb.clients.slice(0, 10).map((c) => (
            <tr key={c.name} className="border-t border-slate-50">
              <td className="py-1.5 text-slate-700 truncate max-w-[140px]">{c.name}</td>
              <td className="py-1.5 px-2 text-right tabular-nums text-slate-400">{Math.round(c.rate * 100)}%</td>
              <td className="py-1.5 px-2 text-right tabular-nums text-slate-500">{money(c.projectedSpend)}</td>
              <td className="py-1.5 pl-2 text-right tabular-nums font-semibold text-slate-900">{money(c.yourShare)}</td>
            </tr>
          ))}
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
