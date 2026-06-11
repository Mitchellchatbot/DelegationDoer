"use client";

import { useMemo, useState } from "react";
import {
  AlertCircle, Send, CheckCircle2, AlertTriangle, CalendarRange,
  UserPlus, Sparkles, Megaphone, Users
} from "lucide-react";
import { StatCard } from "@/components/StatCard";
import {
  PERIODS, PERIOD_LABEL, CATEGORY_LABEL,
  metricValue,
  type Category, type Period, type ProjectMetricsRow, type MetricsResult
} from "@/lib/website-builder-metrics-types";
import { cn } from "@/lib/utils";

// Website Builder outbound dashboard body. Wired in the (outbound)
// shell page at /outbound-dashboard/website-builder. Receives a
// server-fetched MetricsResult so the dashboard renders synchronously
// and survives upstream Supabase outages with a soft empty state.

export function WebsiteBuilderContent({ result }: { result: MetricsResult }) {
  if (!result.ok) return <ErrorPanel error={result.error} />;
  return <Dashboard data={result.data} />;
}

function Dashboard({ data }: { data: ProjectMetricsRow }) {
  const [period, setPeriod] = useState<Period>("this_month");

  // Health hints derived once per render. The list is ordered by
  // severity — first hit wins the visible callout.
  const callout = useMemo(() => deriveCallout(data), [data]);

  return (
    <div className="space-y-4">
      <HeroRow data={data} />
      {callout && <Callout {...callout} />}
      <PeriodSelector period={period} onChange={setPeriod} />
      <CategoryBreakdown data={data} period={period} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <PeriodStack data={data} />
        <SuccessGauges data={data} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero row — four big KPI cards at the top, matching the FB Ads page's
// 4-up grid so the two channels feel like siblings.
// ---------------------------------------------------------------------------
function HeroRow({ data }: { data: ProjectMetricsRow }) {
  const failuresAllInLeads =
    data.failed_all > 0 && data.failed_all === data.failed_leads;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <StatCard
        label="Total Built"
        value={data.total_all}
        valueLabel={fmtNumber(data.total_all)}
        icon={<Send />}
        tone="amber"
        subtitle="lifetime"
      />
      <StatCard
        label="Success Rate"
        value={data.success_rate_all * 100}
        valueLabel={fmtPercent(data.success_rate_all)}
        icon={<CheckCircle2 />}
        tone={successTone(data.success_rate_all)}
        subtitle="across all categories"
        info="Share of attempts that succeeded across leads, custom, and general categories combined."
      />
      <StatCard
        label="Failures"
        value={data.failed_all}
        valueLabel={fmtNumber(data.failed_all)}
        icon={<AlertTriangle />}
        tone="rose"
        subtitle={failuresAllInLeads ? "all in Leads" : "across all categories"}
      />
      <StatCard
        label="Built This Week"
        value={data.this_week_all}
        valueLabel={fmtNumber(data.this_week_all)}
        icon={<CalendarRange />}
        tone="indigo"
        subtitle={data.today_all > 0 ? `${data.today_all} today` : "nothing today"}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Period selector pills. Drives the CategoryBreakdown row below.
// ---------------------------------------------------------------------------
function PeriodSelector({
  period, onChange
}: { period: Period; onChange: (p: Period) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-medium text-ink/55 mr-1">Window:</span>
      {PERIODS.map((p) => {
        const active = p === period;
        return (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            className={cn(
              "px-3 py-1 rounded-full text-[12px] font-medium transition-colors border",
              active
                ? "bg-amber-500 text-white border-amber-500 shadow-sm"
                : "bg-white text-ink/70 border-slate-200 hover:bg-slate-50 hover:text-ink"
            )}
          >
            {PERIOD_LABEL[p]}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-category breakdown for the selected window. Three cards (Leads /
// Custom / General) each showing the absolute count + share-of-total bar.
// "All" intentionally omitted — it's the sum and would dwarf the bars.
// ---------------------------------------------------------------------------
function CategoryBreakdown({ data, period }: { data: ProjectMetricsRow; period: Period }) {
  const subCats: Category[] = ["leads", "custom", "general"];
  const total = metricValue(data, period, "all");
  const periodLabel = PERIOD_LABEL[period].toLowerCase();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {subCats.map((c) => {
        const v = metricValue(data, period, c);
        const share = total > 0 ? v / total : 0;
        return (
          <CategoryCard
            key={c}
            category={c}
            value={v}
            share={share}
            periodLabel={periodLabel}
          />
        );
      })}
    </div>
  );
}

function CategoryCard({
  category, value, share, periodLabel
}: {
  category: Category;
  value: number;
  share: number;
  periodLabel: string;
}) {
  const palette = CATEGORY_PALETTE[category];
  const Icon = palette.icon;
  return (
    <div className="relative overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-soft p-4">
      <div className={cn("absolute inset-x-0 top-0 h-[3px]", palette.topBar)} aria-hidden />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-ink/65">{CATEGORY_LABEL[category]}</div>
          <div className={cn("text-[28px] leading-none font-semibold tracking-tight mt-2 tabular-nums", palette.numberFg)}>
            {fmtNumber(value)}
          </div>
          <div className="text-[10.5px] text-ink/50 mt-1">{periodLabel}</div>
        </div>
        <div className={cn("w-8 h-8 rounded-lg grid place-items-center shrink-0", palette.iconBg, palette.iconFg)}>
          <Icon className="w-[15px] h-[15px]" />
        </div>
      </div>
      <div className="mt-3">
        <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
          <div
            className={cn("h-full transition-[width]", palette.barFill)}
            style={{ width: `${Math.max(2, Math.round(share * 100))}%` }}
          />
        </div>
        <div className="text-[10.5px] text-ink/50 mt-1.5">
          {fmtPercent(share)} of all {periodLabel}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stacked horizontal bars — one row per period, segments colored by
// category. Tells the "what's the mix and how is volume trending"
// story in a single glance.
// ---------------------------------------------------------------------------
function PeriodStack({ data }: { data: ProjectMetricsRow }) {
  const rows: { period: Period; label: string; values: Record<Category, number>; total: number }[] = PERIODS.map((p) => {
    const leads = metricValue(data, p, "leads");
    const custom = metricValue(data, p, "custom");
    const general = metricValue(data, p, "general");
    return {
      period: p,
      label: PERIOD_LABEL[p],
      values: { all: leads + custom + general, leads, custom, general },
      total: leads + custom + general
    };
  });
  // Scale every bar against the largest period so visual length is
  // comparable across rows.
  const maxTotal = Math.max(1, ...rows.map((r) => r.total));

  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[13px] font-semibold text-ink">Volume by window</div>
        <Legend />
      </div>
      <div className="text-[11px] text-ink/55 mb-4">
        Each row is a period; segments are categories. Length is scaled to the largest period.
      </div>
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.period}>
            <div className="flex items-center justify-between text-[11px] mb-1">
              <span className="text-ink/65 font-medium">{r.label}</span>
              <span className="text-ink/50 tabular-nums">{fmtNumber(r.total)}</span>
            </div>
            <div className="h-3 rounded-full bg-slate-100 overflow-hidden flex">
              {(["leads", "custom", "general"] as const).map((c) => {
                const widthPct = r.total === 0 ? 0 : (r.values[c] / maxTotal) * 100;
                if (widthPct <= 0) return null;
                return (
                  <div
                    key={c}
                    className={cn("h-full", CATEGORY_PALETTE[c].barFill)}
                    style={{ width: `${widthPct}%` }}
                    title={`${CATEGORY_LABEL[c]}: ${fmtNumber(r.values[c])}`}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-2.5 text-[10.5px] text-ink/65">
      {(["leads", "custom", "general"] as const).map((c) => (
        <span key={c} className="inline-flex items-center gap-1">
          <span className={cn("inline-block w-2.5 h-2.5 rounded-sm", CATEGORY_PALETTE[c].barFill)} />
          {CATEGORY_LABEL[c]}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Success-rate radial gauges, one per category. Makes the 77% leads vs
// 100% custom/general gap pop.
// ---------------------------------------------------------------------------
function SuccessGauges({ data }: { data: ProjectMetricsRow }) {
  const items: Array<{ cat: Category; rate: number }> = [
    { cat: "all", rate: data.success_rate_all },
    { cat: "leads", rate: data.success_rate_leads },
    { cat: "custom", rate: data.success_rate_custom },
    { cat: "general", rate: data.success_rate_general }
  ];
  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <div className="text-[13px] font-semibold text-ink mb-1">Success rate by category</div>
      <div className="text-[11px] text-ink/55 mb-4">
        Share of attempts that succeeded. Lifetime — periods aren't broken out upstream.
      </div>
      <div className="grid grid-cols-4 gap-2">
        {items.map((it) => (
          <Gauge key={it.cat} category={it.cat} rate={it.rate} />
        ))}
      </div>
    </div>
  );
}

function Gauge({ category, rate }: { category: Category; rate: number }) {
  // Hand-rolled SVG ring so we don't pull in a chart lib. 36-radius
  // circle ⇒ circumference = 2πr ≈ 226. dashoffset = (1-rate) * C
  // sweeps the arc clockwise from 12 o'clock.
  const R = 36;
  const C = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(1, rate));
  const dash = C * pct;
  const palette = CATEGORY_PALETTE[category];
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative w-[88px] h-[88px]">
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
          <circle cx="50" cy="50" r={R} className="stroke-slate-100" strokeWidth="10" fill="none" />
          <circle
            cx="50" cy="50" r={R}
            className={palette.gaugeStroke}
            strokeWidth="10"
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${dash} ${C - dash}`}
          />
        </svg>
        <div className="absolute inset-0 grid place-items-center">
          <span className={cn("text-[15px] font-semibold tabular-nums", palette.numberFg)}>
            {fmtPercent(rate)}
          </span>
        </div>
      </div>
      <span className="text-[10.5px] text-ink/65 font-medium">{CATEGORY_LABEL[category]}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auto-derived callout — picks the most useful actionable signal from
// the numbers. Null means "nothing notable, hide the strip."
// ---------------------------------------------------------------------------
function deriveCallout(data: ProjectMetricsRow): { tone: "rose" | "amber" | "sky"; title: string; body: string } | null {
  if (data.failed_all > 0 && data.failed_all === data.failed_leads) {
    return {
      tone: "rose",
      title: `Every failure (${data.failed_all}) is in the Leads category`,
      body: "Other categories are clean. Audit the leads ingest path — the failure mode is concentrated."
    };
  }
  if (data.success_rate_leads > 0 && data.success_rate_leads < 0.8 && data.success_rate_all >= 0.85) {
    return {
      tone: "amber",
      title: `Leads success rate is ${fmtPercent(data.success_rate_leads)}`,
      body: `Custom and general are running at ${fmtPercent(data.success_rate_custom)} / ${fmtPercent(data.success_rate_general)}. Something specific to the leads pipeline is dragging the overall rate down.`
    };
  }
  if (data.today_all === 0 && data.this_week_all > 0) {
    return {
      tone: "amber",
      title: "Nothing built today",
      body: `${fmtNumber(data.this_week_all)} were built earlier this week. Pipeline may be paused — check the scheduler.`
    };
  }
  if (data.today_all === 0 && data.this_week_all === 0 && data.this_month_all > 0) {
    return {
      tone: "rose",
      title: "Nothing built this week",
      body: "The pipeline has been quiet for a full week. Investigate the runner / scheduler."
    };
  }
  return null;
}

function Callout({ tone, title, body }: { tone: "rose" | "amber" | "sky"; title: string; body: string }) {
  const palette =
    tone === "rose"
      ? { bg: "bg-rose-50/60", border: "border-rose-200/70", iconBg: "bg-rose-100", iconFg: "text-rose-600", titleFg: "text-rose-900", bodyFg: "text-rose-900/75" }
    : tone === "amber"
      ? { bg: "bg-amber-50/60", border: "border-amber-200/70", iconBg: "bg-amber-100", iconFg: "text-amber-700", titleFg: "text-amber-900", bodyFg: "text-amber-900/75" }
      : { bg: "bg-sky-50/60", border: "border-sky-200/70", iconBg: "bg-sky-100", iconFg: "text-sky-700", titleFg: "text-sky-900", bodyFg: "text-sky-900/75" };
  return (
    <div className={cn("rounded-2xl border p-4 shadow-soft flex items-start gap-3", palette.bg, palette.border)}>
      <div className={cn("w-8 h-8 rounded-lg grid place-items-center shrink-0", palette.iconBg, palette.iconFg)}>
        <AlertTriangle className="w-4 h-4" />
      </div>
      <div className="min-w-0">
        <div className={cn("text-[13px] font-semibold", palette.titleFg)}>{title}</div>
        <div className={cn("text-[12px] mt-0.5", palette.bodyFg)}>{body}</div>
      </div>
    </div>
  );
}

function ErrorPanel({ error }: { error: string }) {
  const lower = error.toLowerCase();
  const hint =
    lower.includes("missing website_builder_metrics_supabase")
      ? "Set WEBSITE_BUILDER_METRICS_SUPABASE_URL and WEBSITE_BUILDER_METRICS_SUPABASE_KEY in the server env (Vercel → Project → Settings → Environment Variables for production, .env.local then restart `npm run dev` for local), then refresh."
    : lower.includes("network error") || lower.includes("fetch failed")
      ? "Couldn't reach the Website Builder Supabase project. Check the URL value and that the project isn't paused."
    : lower.includes("jwt") || lower.includes("invalid api key") || lower.includes("invalid token")
      ? "The service_role key was rejected. Re-copy it from Supabase → Project → Settings → API and update the env var."
    : lower.includes("no rows")
      ? "The Supabase view came back empty. Check that the project_metrics view exists and that the source tables have data."
      : "Check the Supabase project's status, the project_metrics view schema, and that the env vars match the dashboard credentials.";
  return (
    <div className="rounded-2xl border border-rose-200/70 bg-rose-50/60 p-5 shadow-soft">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl grid place-items-center bg-rose-100 text-rose-600 shrink-0">
          <AlertCircle className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-rose-900">
            Couldn't load Website Builder metrics
          </div>
          <div className="text-[13px] text-rose-900/75 mt-1 break-words">
            <span className="font-mono text-[12px] bg-rose-100/80 px-1.5 py-0.5 rounded">{error}</span>
          </div>
          <div className="text-[13px] text-rose-900/85 mt-3 leading-relaxed">{hint}</div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Palette helpers — keeps category color decisions in one place so the
// hero row, breakdown cards, stacked bars, and gauges agree.
// ---------------------------------------------------------------------------
const CATEGORY_PALETTE: Record<Category, {
  icon: typeof Users;
  topBar: string;
  iconBg: string;
  iconFg: string;
  numberFg: string;
  barFill: string;
  gaugeStroke: string;
}> = {
  all: {
    icon: Users,
    topBar: "bg-slate-500",
    iconBg: "bg-slate-100",
    iconFg: "text-slate-700",
    numberFg: "text-slate-800",
    barFill: "bg-slate-500",
    gaugeStroke: "stroke-slate-500"
  },
  leads: {
    icon: UserPlus,
    topBar: "bg-sky-500",
    iconBg: "bg-sky-50",
    iconFg: "text-sky-600",
    numberFg: "text-sky-700",
    barFill: "bg-sky-500",
    gaugeStroke: "stroke-sky-500"
  },
  custom: {
    icon: Sparkles,
    topBar: "bg-violet-500",
    iconBg: "bg-violet-50",
    iconFg: "text-violet-600",
    numberFg: "text-violet-700",
    barFill: "bg-violet-500",
    gaugeStroke: "stroke-violet-500"
  },
  general: {
    icon: Megaphone,
    topBar: "bg-teal-500",
    iconBg: "bg-teal-50",
    iconFg: "text-teal-600",
    numberFg: "text-teal-700",
    barFill: "bg-teal-500",
    gaugeStroke: "stroke-teal-500"
  }
};

function successTone(rate: number): "emerald" | "amber" | "rose" {
  if (rate >= 0.9) return "emerald";
  if (rate >= 0.75) return "amber";
  return "rose";
}

function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

function fmtPercent(rate: number): string {
  if (!Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(rate >= 0.995 ? 0 : 1)}%`;
}
