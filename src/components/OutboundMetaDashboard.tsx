import Link from "next/link";
import { cn } from "@/lib/utils";
import { META_DAYS, type MetaRow, type OutboundMetaResponse, type OutboundMetaResult } from "@/lib/outbound-meta-types";

// Our own Meta ad account, laid out the way the Meta ads dashboard lays out a
// client's (Villa's) Dashboard: the funnel row with week-over-week change and
// in-window sparklines, the cost row, the delivery cards (CTR, frequency, CPC,
// CPM, reach), then the day-by-day chart and the campaign / ad set / ad tables
// from its Creatives and Ad sets pages. Every figure is read live from Meta by
// that app (GET /api/outbound/meta); the only arithmetic here is cost per
// prospect / booking, which pairs its spend with the pipeline's counts.
//
// Server-renderable (no hooks): the range pills are links, so a range change is
// a normal navigation the page re-fetches for.

const RANGE_LABEL: Record<number, string> = { 7: "7 days", 14: "14 days", 30: "30 days", 90: "90 days" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function day(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}` : ymd;
}
function usd(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
function int(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : Math.round(n).toLocaleString("en-US");
}
function pct(n: number | null | undefined, digits = 2): string {
  return n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(digits)}%`;
}
const div = (a: number, b: number) => (b > 0 ? a / b : null);

export function OutboundMetaDashboard({ result, days }: { result: OutboundMetaResult | null; days: number }) {
  return (
    <div className="space-y-4">
      <RangeBar days={days} data={result?.ok ? result.data : null} />
      {!result ? null : !result.ok ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-900">
          Couldn&apos;t read our ad account from the Meta ads dashboard — {result.error}
        </div>
      ) : (
        <Dashboard data={result.data} />
      )}
    </div>
  );
}

function RangeBar({ days, data }: { days: number; data: OutboundMetaResponse | null }) {
  return (
    <div className="flex items-end justify-between gap-3 flex-wrap">
      <div>
        <div className="text-[15px] font-bold text-ink">{data ? data.accountLabel : "Our ad account"} · Meta</div>
        <div className="text-[12px] text-muted">
          {data
            ? `Last ${RANGE_LABEL[data.range.days] ?? `${data.range.days} days`} (${day(data.range.from)} – ${day(data.range.to)}) vs the prior ${RANGE_LABEL[data.range.days] ?? `${data.range.days} days`} · in-window sparklines`
            : `Last ${RANGE_LABEL[days] ?? `${days} days`} vs the prior period`}
        </div>
      </div>
      <nav aria-label="Date range" className="inline-flex items-center gap-0.5 rounded-full border border-slate-200 bg-white p-0.5 shadow-soft">
        {META_DAYS.map((d) => (
          <Link
            key={d}
            href={`/scale/outbound?view=meta&days=${d}`}
            scroll={false}
            aria-current={d === days ? "page" : undefined}
            className={cn(
              "rounded-full px-3 py-1 text-[12px] font-semibold transition-colors",
              d === days ? "bg-indigo-600 text-white" : "text-muted hover:text-ink"
            )}
          >
            {d}d
          </Link>
        ))}
      </nav>
    </div>
  );
}

type Tint = "indigo" | "emerald" | "teal" | "violet" | "amber" | "rose" | "sky";
const TINT: Record<Tint, string> = {
  indigo: "border-indigo-100 bg-indigo-50/60",
  emerald: "border-emerald-100 bg-emerald-50/60",
  teal: "border-teal-100 bg-teal-50/60",
  violet: "border-violet-100 bg-violet-50/60",
  amber: "border-amber-100 bg-amber-50/60",
  rose: "border-rose-100 bg-rose-50/60",
  sky: "border-sky-100 bg-sky-50/60"
};
const SPARK: Record<Tint, string> = {
  indigo: "#6366f1", emerald: "#3fae74", teal: "#0ea5a4", violet: "#8b5cf6", amber: "#f59e0b", rose: "#ec4899", sky: "#38bdf8"
};

function Dashboard({ data }: { data: OutboundMetaResponse }) {
  const { totals: t, priorTotals: p, pipeline, daily } = data;
  const n = data.range.days;
  const spendSeries = daily.map((d) => d.spend);
  const leadSeries = daily.map((d) => d.leads);

  return (
    <div className="space-y-4">
      {/* Funnel row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <FunnelCell tint="indigo" label="Spend (Meta)" cur={t.spend} prior={p.spend} format={(v) => usd(v)} days={n} series={spendSeries} />
        <FunnelCell tint="emerald" label="Leads · Meta" cur={t.leads} prior={p.leads} format={int} days={n} series={leadSeries} />
        <FunnelCell tint="teal" label="Prospects · ad form" cur={pipeline.prospects} prior={pipeline.priorProspects} format={int} days={n} footer="created in window · Outbound" />
        <FunnelCell tint="violet" label="Calls booked" cur={pipeline.booked} prior={pipeline.priorBooked} format={int} days={n} footer={`of those, now booked · ${pct(div(pipeline.booked * 100, pipeline.prospects), 0)} of prospects`} />
      </div>

      {/* Cost row */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <CostCell tint="emerald" label="CPL (Cost / Lead)" value={t.cpl} prior={p.cpl} days={n} />
        <CostCell tint="teal" label="Cost / Prospect" value={div(t.spend, pipeline.prospects)} prior={div(p.spend, pipeline.priorProspects)} days={n} />
        <CostCell tint="violet" label="Cost / Booking" value={div(t.spend, pipeline.booked)} prior={div(p.spend, pipeline.priorBooked)} days={n} highlight />
      </div>

      {/* Delivery cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <MetricCard label="CTR" value={pct(t.ctr)} sub={`prior ${pct(p.ctr)}`} delta={change(t.ctr, p.ctr, false)} />
        <MetricCard
          label="Frequency"
          value={t.frequency == null ? "—" : t.frequency.toFixed(2)}
          sub={`prior ${p.frequency == null ? "—" : p.frequency.toFixed(2)}`}
          note={t.frequency == null ? null : t.frequency > 2.5 ? { text: "fatigue risk", tone: "bad" } : t.frequency > 2 ? { text: "watch", tone: "warn" } : { text: "healthy", tone: "good" }}
        />
        <MetricCard label="CPC" value={usd(t.cpc, 2)} sub={`prior ${usd(p.cpc, 2)}`} delta={change(t.cpc, p.cpc, true)} />
        <MetricCard label="CPM" value={usd(t.cpm, 2)} sub={`prior ${usd(p.cpm, 2)}`} delta={change(t.cpm, p.cpm, true)} />
        <MetricCard label="Reach" value={int(t.reach)} sub={`${int(t.impressions)} impressions · ${int(t.linkClicks)} link clicks`} />
      </div>

      <DailyChart data={data} />

      <RowsTable title="Campaigns" rows={data.campaigns} empty="No campaign spent in this window." />
      <RowsTable
        title="Ad sets"
        rows={data.adsets}
        sub={(r) => (r as MetaRow & { campaignName: string }).campaignName}
        empty="No ad set spent in this window."
      />
      <AdsTable ads={data.ads} />

      <p className="px-1 text-[11px] leading-relaxed text-muted">
        Read live from Meta by the Meta ads dashboard for {day(data.range.from)} – {day(data.range.to)} (full days, ending
        yesterday), compared with {day(data.prior.from)} – {day(data.prior.to)}. Leads are Meta-reported. Prospects are Outbound
        leads that came in through the ad form in that window, and booked is how many of them are at a booked stage now.
        Updated {new Date(data.generatedAt).toISOString().slice(11, 16)} UTC.
      </p>
    </div>
  );
}

// Week-over-week style change, coloured by whether moving that way is good.
function change(cur: number | null, prior: number | null, lowerBetter: boolean): { text: string; tone: "good" | "bad" | "flat" } | null {
  if (cur == null || prior == null || prior === 0) return null;
  const d = ((cur - prior) / prior) * 100;
  const better = lowerBetter ? cur <= prior : cur >= prior;
  return { text: `${d >= 0 ? "+" : ""}${d.toFixed(0)}% vs prior`, tone: Math.abs(d) < 0.5 ? "flat" : better ? "good" : "bad" };
}

const TONE = { good: "text-emerald-600", bad: "text-amber-600", warn: "text-amber-600", flat: "text-muted" } as const;

function FunnelCell({
  tint, label, cur, prior, format, days, series, footer
}: {
  tint: Tint; label: string; cur: number; prior: number; format: (v: number) => string; days: number; series?: number[]; footer?: string;
}) {
  const deltaPct = prior > 0 ? ((cur - prior) / prior) * 100 : null;
  return (
    <div className={cn("rounded-2xl border p-4 shadow-soft", TINT[tint])}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
        {deltaPct != null && (
          <div className={cn("text-[11px] font-bold tabular-nums", cur >= prior ? "text-emerald-600" : "text-amber-600")} title={`vs prior ${days} days`}>
            {deltaPct >= 0 ? "+" : ""}
            {deltaPct.toFixed(0)}%
          </div>
        )}
      </div>
      <div className="mt-2 text-[28px] font-bold leading-none tabular-nums text-ink">{format(cur)}</div>
      <div className="mt-1 text-[10px] font-medium text-muted">{footer ?? `${days}-day total · vs prior period`}</div>
      {series && series.length > 1 && <Sparkline data={series} color={SPARK[tint]} />}
    </div>
  );
}

function CostCell({ tint, label, value, prior, days, highlight }: { tint: Tint; label: string; value: number | null; prior: number | null; days: number; highlight?: boolean }) {
  const c = change(value, prior, true);
  return (
    <div className={cn("rounded-2xl border p-4 shadow-soft", TINT[tint], highlight && "ring-1 ring-violet-300")}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-2 text-[24px] font-bold leading-none tabular-nums text-ink">{usd(value, 2)}</div>
      <div className="mt-2 text-[11px] font-medium text-muted">
        {days}-day average{c && <span className={cn("ml-1.5", TONE[c.tone])}>· {c.text}</span>}
      </div>
    </div>
  );
}

function MetricCard({
  label, value, sub, delta, note
}: {
  label: string; value: string; sub?: string; delta?: { text: string; tone: "good" | "bad" | "flat" } | null; note?: { text: string; tone: "good" | "warn" | "bad" } | null;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1.5 text-[22px] font-bold leading-none tabular-nums text-ink">{value}</div>
      {sub && <div className="mt-1 text-[11px] text-muted">{sub}</div>}
      {delta && <div className={cn("mt-1 text-[11px] font-medium", TONE[delta.tone])}>{delta.text}</div>}
      {note && <div className={cn("mt-1 text-[11px] font-medium", TONE[note.tone])}>{note.text}</div>}
    </div>
  );
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const w = 120;
  const h = 24;
  const max = Math.max(...data, 0);
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(h - (max > 0 ? (v / max) * (h - 2) : 0) - 1).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="mt-2 h-6 w-full" aria-hidden>
      <polyline points={`0,${h} ${pts} ${w},${h}`} fill={color} fillOpacity={0.12} stroke="none" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

// Spend per day as bars, leads per day as dots on their own scale.
function DailyChart({ data }: { data: OutboundMetaResponse }) {
  const days = data.daily;
  if (!days.length) return null;
  const W = 720;
  const H = 160;
  const pad = { l: 44, r: 30, t: 10, b: 22 };
  const maxSpend = Math.max(...days.map((d) => d.spend), 1);
  const maxLeads = Math.max(...days.map((d) => d.leads), 1);
  const bw = (W - pad.l - pad.r) / days.length;
  const y = (v: number, max: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const labelEvery = Math.ceil(days.length / 10);
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft">
      <div className="mb-2 flex items-center gap-4 text-[11px] text-muted">
        <span className="text-[12.5px] font-semibold text-ink">Day by day</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-indigo-400" />Spend</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />Leads</span>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-44 w-full min-w-[520px]" role="img" aria-label="Daily spend and leads">
          <text x={pad.l - 6} y={pad.t + 8} textAnchor="end" className="fill-slate-400 text-[10px]">{usd(maxSpend)}</text>
          <text x={pad.l - 6} y={H - pad.b} textAnchor="end" className="fill-slate-400 text-[10px]">$0</text>
          <text x={W - pad.r + 6} y={pad.t + 8} className="fill-emerald-600 text-[10px]">{maxLeads}</text>
          <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="#e2e8f0" />
          {days.map((d, i) => {
            const x = pad.l + i * bw;
            const top = y(d.spend, maxSpend);
            return (
              <g key={d.date}>
                <title>{`${day(d.date)}: ${usd(d.spend, 2)} · ${d.leads} lead${d.leads === 1 ? "" : "s"} · ${int(d.impressions)} impressions`}</title>
                <rect x={x + bw * 0.15} y={top} width={Math.max(bw * 0.7, 1)} height={Math.max(H - pad.b - top, 0)} rx={2} fill="#818cf8" />
                {d.leads > 0 && <circle cx={x + bw / 2} cy={y(d.leads, maxLeads)} r={3} fill="#10b981" />}
                {i % labelEvery === 0 && (
                  <text x={x + bw / 2} y={H - 6} textAnchor="middle" className="fill-slate-400 text-[10px]">{day(d.date)}</text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string | null }) {
  if (!status) return null;
  const active = status === "ACTIVE";
  return (
    <span className={cn("rounded-full px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide", active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")}>
      {status.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}

function MetricHead() {
  return (
    <>
      <th className="px-3 py-2.5 text-right font-semibold">Spend</th>
      <th className="px-3 py-2.5 text-right font-semibold">Impr.</th>
      <th className="px-3 py-2.5 text-right font-semibold">Clicks</th>
      <th className="px-3 py-2.5 text-right font-semibold">CTR</th>
      <th className="px-3 py-2.5 text-right font-semibold">CPC</th>
      <th className="px-3 py-2.5 text-right font-semibold">Leads</th>
      <th className="px-3 py-2.5 text-right font-semibold">CPL</th>
    </>
  );
}

function MetricCells({ r }: { r: MetaRow }) {
  return (
    <>
      <td className="px-3 py-2 text-right font-semibold tabular-nums text-ink">{usd(r.spend, 2)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-muted">{int(r.impressions)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-muted">{int(r.clicks)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-muted">{pct(r.ctr)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-muted">{usd(r.cpc, 2)}</td>
      <td className="px-3 py-2 text-right font-semibold tabular-nums text-ink">{int(r.leads)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-ink">{usd(r.cpl, 2)}</td>
    </>
  );
}

function RowsTable({ title, rows, sub, empty }: { title: string; rows: MetaRow[]; sub?: (r: MetaRow) => string; empty: string }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-soft">
      <div className="border-b border-slate-100 px-4 py-2.5 text-[12.5px] font-semibold text-ink">
        {title} <span className="font-normal text-muted">· {rows.length}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="bg-slate-50 text-left text-[10.5px] uppercase tracking-wide text-muted">
              <th className="px-3 py-2.5 font-semibold">Name</th>
              <MetricHead />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-4 text-muted">{empty}</td></tr>
            ) : (
              rows.map((r, i) => (
                <tr key={i} className="border-t border-slate-100 align-top">
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold text-ink break-words">{r.name}</span>
                      <StatusPill status={r.status} />
                    </div>
                    {sub && <div className="text-[11px] text-muted">{sub(r)}</div>}
                  </td>
                  <MetricCells r={r} />
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Meta's thumbnails come from its CDN; only https is rendered.
const safeImg = (u: string | null) => (u && /^https:\/\//i.test(u) ? u : null);

function AdsTable({ ads }: { ads: OutboundMetaResponse["ads"] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-soft">
      <div className="border-b border-slate-100 px-4 py-2.5 text-[12.5px] font-semibold text-ink">
        Ads <span className="font-normal text-muted">· {ads.length}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="bg-slate-50 text-left text-[10.5px] uppercase tracking-wide text-muted">
              <th className="px-3 py-2.5 font-semibold">Ad</th>
              <MetricHead />
            </tr>
          </thead>
          <tbody>
            {ads.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-4 text-muted">No ad spent in this window.</td></tr>
            ) : (
              ads.map((a, i) => {
                const img = safeImg(a.thumbnailUrl);
                return (
                  <tr key={i} className="border-t border-slate-100 align-top">
                    <td className="px-3 py-2">
                      <div className="flex items-start gap-2.5">
                        {img ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={img} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-10 w-10 shrink-0 rounded-lg border border-slate-200 object-cover" />
                        ) : (
                          <div className="h-10 w-10 shrink-0 rounded-lg border border-slate-200 bg-slate-50" />
                        )}
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-semibold text-ink break-words">{a.name}</span>
                            <StatusPill status={a.status} />
                          </div>
                          <div className="text-[11px] text-muted break-words">{a.campaignName} › {a.adsetName}</div>
                        </div>
                      </div>
                    </td>
                    <MetricCells r={a} />
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

