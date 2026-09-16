import Link from "next/link";
import { cn } from "@/lib/utils";
import { META_DAYS, type MetaDay, type MetaRow, type OutboundMetaResponse, type OutboundMetaResult } from "@/lib/outbound-meta-types";

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
function pct(n: number | null | undefined, digits = 1): string {
  return n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(digits)}%`;
}
const div = (a: number, b: number) => (b > 0 ? a / b : null);

export function OutboundMetaDashboard({
  result,
  days,
  engagementDaily
}: {
  result: OutboundMetaResult | null;
  days: number;
  // Up to 30 days ending yesterday, for the engagement row's 7d / 30d figures,
  // which the Meta ads dashboard shows regardless of the picked range.
  engagementDaily: MetaDay[] | null;
}) {
  return (
    <div className="space-y-4">
      <RangeBar days={days} data={result?.ok ? result.data : null} />
      {!result ? null : !result.ok ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-900">
          Couldn&apos;t read our ad account from the Meta ads dashboard — {result.error}
        </div>
      ) : (
        <Dashboard data={result.data} engagementDaily={engagementDaily ?? result.data.daily} />
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

// A day Meta actually delivered on. Our series are zero-filled calendar days,
// while awfmp's meta_account_daily only has a row for a day Meta returned
// delivery, so this stands in for "has a row" there: it decides the anchor
// day and what the per-day averages divide by.
const delivered = (d: MetaDay) => d.impressions > 0 || d.spend > 0;

// YYYY-MM-DD minus n calendar days. A malformed date comes back as-is (the
// validator only checks it's a string), so a bad row empties a span instead
// of throwing mid-render.
function minusDays(ymd: string, n: number): string {
  const t = Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t - n * 86_400_000).toISOString().slice(0, 10) : ymd;
}

// The n calendar days ending on `end` (inclusive), as far as the series reaches.
function spanOf(series: MetaDay[], end: string, n: number): MetaDay[] {
  const after = minusDays(end, n);
  return series.filter((d) => d.date > after && d.date <= end);
}

// A window's figures the way the Meta ads dashboard aggregates them
// (awfmp lib/metrics.ts): ratios from summed spend / clicks / impressions,
// frequency as the average of the days that had one (it doesn't sum across
// days), leads per day. Averages divide by the days with delivery, as awfmp's
// divide by its rows, so a paused stretch doesn't dilute them. null = nothing
// delivered in the span, shown as "—" rather than a row of zeros.
type Agg = { spend: number; leads: number; clicks: number; impressions: number; frequency: number; cpl: number; ctr: number; cpc: number; cpm: number; avgLeads: number };
function agg(days: MetaDay[]): Agg | null {
  const live = days.filter(delivered);
  if (!live.length) return null;
  const spend = days.reduce((a, d) => a + d.spend, 0);
  const leads = days.reduce((a, d) => a + d.leads, 0);
  const clicks = days.reduce((a, d) => a + d.clicks, 0);
  const impressions = days.reduce((a, d) => a + d.impressions, 0);
  const fr = live.filter((d) => (d.frequency ?? 0) > 0);
  return {
    spend, leads, clicks, impressions,
    frequency: fr.length ? fr.reduce((a, d) => a + (d.frequency ?? 0), 0) / fr.length : 0,
    cpl: leads ? spend / leads : 0,
    ctr: impressions ? (clicks / impressions) * 100 : 0,
    cpc: clicks ? spend / clicks : 0,
    cpm: impressions ? (spend / impressions) * 1000 : 0,
    avgLeads: leads / live.length
  };
}

// awfmp classify(): yesterday against the 7-day baseline.
type Status = "green" | "yellow" | "red";
function classify(yesterday: Agg, last7: Agg): { status: Status; line: string } {
  const leadsRatio = last7.avgLeads ? yesterday.leads / last7.avgLeads : 1;
  const cplRatio = last7.cpl ? yesterday.cpl / last7.cpl : 1;
  if (leadsRatio < 0.5 || cplRatio > 2) return { status: "red", line: "Leads down or CPL up sharply vs the 7-day baseline" };
  if (leadsRatio < 0.7 || cplRatio > 1.3) return { status: "yellow", line: "Running a bit off the 7-day baseline" };
  return { status: "green", line: "Yesterday is in line with the 7-day baseline" };
}
type Banner = { box: string; text: string; badge: string; emoji: string; label: string };
const STATUS: Record<Status, Banner> = {
  green: { box: "bg-emerald-50/70 ring-emerald-200", text: "text-emerald-700", badge: "bg-emerald-100", emoji: "✅", label: "Holding steady" },
  yellow: { box: "bg-amber-50/80 ring-amber-200", text: "text-amber-700", badge: "bg-amber-100", emoji: "👀", label: "Off baseline · keep an eye on it" },
  red: { box: "bg-rose-50/70 ring-rose-200", text: "text-rose-700", badge: "bg-rose-100", emoji: "🚨", label: "Worth a closer look" }
};
// Nothing ran in the picked window: there's no day to judge, so no green
// "holding steady" (nothing is holding) and no red alarm, just the fact.
const NO_DELIVERY: Banner = { box: "bg-slate-50 ring-slate-200", text: "text-slate-600", badge: "bg-slate-100 text-slate-400", emoji: "—", label: "No delivery in this window" };

// Meta's action_type ids as Ads Manager names them; anything else shows raw.
const LEAD_EVENT = new Map<string, string>([
  ["lead", "Lead"],
  ["offsite_conversion.fb_pixel_lead", "Pixel Lead"],
  ["onsite_conversion.lead_grouped", "On-Facebook lead form"],
  ["offsite_conversion.fb_pixel_custom", "custom pixel event"]
]);
// undefined = an older deploy that doesn't say which event it counted.
function leadsNote(type: string | null | undefined): string {
  if (type === undefined) return "Leads are Meta-reported.";
  if (type === null) return "Meta reported no lead events in this window.";
  const name = LEAD_EVENT.get(type) ?? type;
  return `Leads are Meta's ${/event$/i.test(name) ? `${name}s` : `${name} events`}.`;
}

const TONE = { good: "text-emerald-600", bad: "text-rose-600", warn: "text-amber-600", flat: "text-muted" } as const;

function Dashboard({ data, engagementDaily }: { data: OutboundMetaResponse; engagementDaily: MetaDay[] }) {
  const { totals: t, pipeline, daily } = data;
  const n = data.range.days;
  const windowLabel = `Last ${RANGE_LABEL[n] ?? `${n} days`}`;
  const spendSeries = daily.map((d) => d.spend);
  const leadSeries = daily.map((d) => d.leads);

  // Engagement: the last full day Meta delivered on, with the 7 and 30 days
  // ending on it beside it. awfmp's getDailySnapshot anchors the same way, so
  // paused ads show their last real day, never a blank "yesterday" of zeros.
  // Prefer the 30-day read; the picked window stands in when it has no
  // delivery (a 90-day window reaches further back) or wasn't read.
  const eng = [engagementDaily, daily].find((s) => s.some(delivered)) ?? (engagementDaily.length ? engagementDaily : daily);
  const anchorDay = [...eng].reverse().find(delivered) ?? null;
  const anchor = anchorDay?.date ?? null;
  const end = anchor ?? eng[eng.length - 1]?.date ?? data.range.to;
  const yesterday = anchorDay ? agg([anchorDay]) : null;
  const last7 = agg(spanOf(eng, end, 7));
  // 30d only when the read reaches back all 30 days; a shorter fallback series
  // would otherwise pass off a partial span as a month.
  const has30 = eng.length > 0 && eng[0].date <= minusDays(end, 29);
  const last30 = has30 ? agg(spanOf(eng, end, 30)) : null;
  const when = anchor ? ` · ${anchor.slice(5)}` : ""; // MM-DD, as awfmp labels "CTR · 09-15"
  const dayNote = { text: anchor ? "last full day" : "no delivery", tone: "flat" as const };
  // The banner judges the picked window: with nothing delivered in it there's
  // nothing to classify, whatever an older anchor day looked like.
  const windowDelivered = daily.some(delivered);
  const status = windowDelivered && yesterday && last7 ? classify(yesterday, last7) : null;
  const st = status ? STATUS[status.status] : NO_DELIVERY;
  const fatigue = !last7 ? dayNote : last7.frequency > 2.5 ? { text: "fatigue risk", tone: "bad" as const } : last7.frequency > 2 ? { text: "watch", tone: "warn" as const } : { text: "healthy", tone: "good" as const };
  const sub = (f: (a: Agg) => string) => `7d ${last7 ? f(last7) : "—"}${has30 ? ` · 30d ${last30 ? f(last30) : "—"}` : ""}`;
  const leadsVs7 = yesterday && last7?.avgLeads ? ((yesterday.leads - last7.avgLeads) / last7.avgLeads) * 100 : null;

  return (
    <div className="space-y-4">
      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h2 className="text-lg font-semibold tracking-tight text-ink">
            Funnel <span className="font-semibold text-muted">· Facebook · {windowLabel}</span>
          </h2>
          <div className="text-[11px] text-muted">{data.range.from} → {data.range.to}</div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <FunnelCell tint="indigo" label="Spend (Meta)" cur={t.spend} prior={data.priorTotals.spend} format={(v) => usd(v)} days={n} series={spendSeries} />
          <FunnelCell tint="emerald" label="Leads · Meta" cur={t.leads} prior={data.priorTotals.leads} format={int} days={n} series={leadSeries} />
          <FunnelCell tint="teal" label="Prospects · ad form" cur={pipeline.prospects} prior={pipeline.priorProspects} format={int} days={n} />
          <FunnelCell tint="violet" label="Calls booked" cur={pipeline.booked} prior={pipeline.priorBooked} format={int} days={n} footer={`booked / lead ${pct(div(pipeline.booked * 100, t.leads))}`} />
        </div>

        <div className="pt-1 text-[11px] font-medium uppercase tracking-wider text-muted">Efficiency · {windowLabel}</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          <CostCell tint="emerald" label="CPL (Cost / Lead)" value={t.cpl} days={n} />
          <CostCell tint="teal" label="Cost / prospect" value={div(t.spend, pipeline.prospects)} days={n} />
          <CostCell tint="violet" label="Cost / booking" value={div(t.spend, pipeline.booked)} days={n} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-ink">
          Meta engagement <span className="font-semibold text-muted">· live</span>
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <MetricCard label={`CTR${when}`} value={yesterday ? pct(yesterday.ctr) : "—"} sub={sub((a) => pct(a.ctr))} note={dayNote} />
          <MetricCard label="Frequency" value={yesterday ? yesterday.frequency.toFixed(2) : "—"} sub={sub((a) => a.frequency.toFixed(2))} note={fatigue} />
          <MetricCard label={`CPC${when}`} value={yesterday ? usd(yesterday.cpc, 2) : "—"} sub={sub((a) => usd(a.cpc, 2))} note={dayNote} />
          <MetricCard label={`CPM${when}`} value={yesterday ? usd(yesterday.cpm, 2) : "—"} sub={sub((a) => usd(a.cpm, 2))} note={dayNote} />
          <MetricCard
            label="Meta-reported leads"
            value={yesterday ? int(yesterday.leads) : "—"}
            sub={`${sub((a) => a.avgLeads.toFixed(1))} · cross-check`}
            note={leadsVs7 == null ? (anchor ? null : dayNote) : { text: `${leadsVs7 >= 0 ? "+" : ""}${leadsVs7.toFixed(0)}% vs 7d`, tone: "flat" }}
          />
        </div>
      </section>

      <div className={cn("flex items-center justify-between gap-4 flex-wrap rounded-2xl px-5 py-4 ring-1", st.box)}>
        <div className="flex items-center gap-3.5">
          <span className={cn("grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[14px] text-lg", st.badge)} aria-hidden>{st.emoji}</span>
          <div>
            <div className={cn("text-[15px] font-bold", st.text)}>{st.label}</div>
            <div className="mt-0.5 text-[13px] text-muted">
              {status ? status.line : `Meta reported no impressions for ${data.range.from} → ${data.range.to}`}
            </div>
          </div>
        </div>
        {anchor && <div className="text-xs tabular-nums text-muted">{status ? "as of" : "last delivery"} {anchor}</div>}
      </div>

      <DailyChart data={data} />

      <RowsTable title="Campaigns" rows={data.campaigns} unattributedSpend={data.unattributedSpend} empty="No campaign spent in this window." />
      <RowsTable
        title="Ad sets"
        rows={data.adsets}
        sub={(r) => (r as MetaRow & { campaignName: string }).campaignName}
        empty="No ad set spent in this window."
      />
      <AdsTable ads={data.ads} />

      <p className="px-1 text-[11px] leading-relaxed text-muted">
        Read live from Meta by the Meta ads dashboard: {data.range.from} → {data.range.to} (full days, ending yesterday), compared
        with {data.prior.from} → {data.prior.to}. {leadsNote(data.leadActionType)} Prospects are Outbound leads that came in through
        the ad form in that window; calls booked is how many of them are at a booked stage now. Engagement is the latest full day
        Meta delivered on, with the 7 and 30 days ending on it (averaged over the days with delivery), whatever range is picked.
      </p>
    </div>
  );
}

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

function CostCell({ tint, label, value, days }: { tint: Tint; label: string; value: number | null; days: number }) {
  return (
    <div className={cn("rounded-2xl border p-4 shadow-soft", TINT[tint])}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-2 text-[24px] font-bold leading-none tabular-nums text-ink">{usd(value)}</div>
      <div className="mt-2 text-[11px] font-medium text-muted">{days}-day average</div>
    </div>
  );
}

function MetricCard({
  label, value, sub, delta, note
}: {
  label: string; value: string; sub?: string; delta?: { text: string; tone: "good" | "bad" | "flat" } | null; note?: { text: string; tone: "good" | "warn" | "bad" | "flat" } | null;
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
  // Axis labels are the real maxima, so a window where nothing ran reads $0 / 0
  // rather than a made-up $1 / 1; only the scale guards against dividing by 0.
  const maxSpend = Math.max(...days.map((d) => d.spend), 0);
  const maxLeads = Math.max(...days.map((d) => d.leads), 0);
  const bw = (W - pad.l - pad.r) / days.length;
  const y = (v: number, max: number) => pad.t + (H - pad.t - pad.b) * (1 - (max > 0 ? v / max : 0));
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
          <text x={pad.l - 6} y={pad.t + 8} textAnchor="end" className="fill-slate-400 text-[10px]">{usd(maxSpend, maxSpend > 0 && maxSpend < 10 ? 2 : 0)}</text>
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

function RowsTable({
  title, rows, sub, empty, unattributedSpend
}: {
  title: string; rows: MetaRow[]; sub?: (r: MetaRow) => string; empty: string;
  // Totals spend no row covers (archived / deleted ads). Shown past a dollar so
  // the rows visibly add up to Spend; below that it's rounding noise.
  unattributedSpend?: number;
}) {
  const rest = unattributedSpend != null && unattributedSpend > 1 ? unattributedSpend : null;
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
            {rows.length === 0 && rest == null ? (
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
            {rest != null && (
              <tr className="border-t border-slate-100 bg-slate-50/50 align-top text-muted">
                <td className="px-3 py-2 italic">Not attributed to a campaign · archived or deleted ads</td>
                <td className="px-3 py-2 text-right tabular-nums">{usd(rest, 2)}</td>
                {[0, 1, 2, 3, 4, 5].map((k) => (
                  <td key={k} className="px-3 py-2 text-right">—</td>
                ))}
              </tr>
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

