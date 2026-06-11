"use client";

import { useMemo } from "react";
import {
  AlertCircle, AlertTriangle, Send, MessageSquare, ThumbsUp, MessageCircle,
  CornerDownLeft, Users, Activity, CalendarCheck, Eye, MailPlus, UserCheck,
  Reply, XCircle, RotateCw
} from "lucide-react";
import { StatCard } from "@/components/StatCard";
import {
  FUNNEL_STAGES, STAGE_LABEL, STAGE_HINT,
  type FunnelStage, type FunnelEntry, type LeadsByStatus,
  type OutboundDailyPoint, type LinkedInOutboundMetrics,
  type LinkedInOutboundResult
} from "@/lib/linkedin-outbound-metrics-types";
import { cn } from "@/lib/utils";

// LinkedIn outbound dashboard body. Wired in
// /outbound-dashboard/linkedin-leads. Receives a server-fetched
// LinkedInOutboundResult so the surface stays SSR-friendly and
// survives upstream Netlify outages with a soft empty state.

export function LinkedInOutboundContent({ result }: { result: LinkedInOutboundResult }) {
  if (!result.ok) return <ErrorPanel error={result.error} />;
  return <Dashboard data={result.data} />;
}

function Dashboard({ data }: { data: LinkedInOutboundMetrics }) {
  const callout = useMemo(() => deriveCallout(data), [data]);
  const replyRate = data.engagement.dms_sent > 0
    ? data.engagement.replied / data.engagement.dms_sent
    : 0;

  return (
    <div className="space-y-4">
      <HeroRow data={data} replyRate={replyRate} />
      {callout && <Callout {...callout} />}
      {data.daily.length > 0 && <DailyActivityChart daily={data.daily} periodDays={data.periodDays} />}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2">
          <FunnelWidget funnel={data.funnel} />
        </div>
        <EngagementCard data={data} />
      </div>
      <PipelineSnapshot leadsByStatus={data.leads_by_status} active={data.leads.active_in_pipeline} />
      <TerminalStates data={data} />
      {data.generatedAt && <GeneratedFooter generatedAt={data.generatedAt} periodDays={data.periodDays} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero row — Total Leads · Active in Pipeline · DMs Sent · Reply Rate.
// ---------------------------------------------------------------------------
function HeroRow({
  data, replyRate
}: { data: LinkedInOutboundMetrics; replyRate: number }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <StatCard
        label="Total Leads"
        value={data.leads.total_leads}
        valueLabel={fmtNumber(data.leads.total_leads)}
        icon={<Users />}
        tone="sky"
        subtitle="lifetime sourced"
      />
      <StatCard
        label="Active in Pipeline"
        value={data.leads.active_in_pipeline}
        valueLabel={fmtNumber(data.leads.active_in_pipeline)}
        icon={<Activity />}
        tone="indigo"
        subtitle={`${pctOfTotal(data.leads.active_in_pipeline, data.leads.total_leads)} of total`}
      />
      <StatCard
        label="DMs Sent"
        value={data.engagement.dms_sent}
        valueLabel={fmtNumber(data.engagement.dms_sent)}
        icon={<Send />}
        tone="violet"
        subtitle={data.periodDays ? `last ${data.periodDays}d` : "lifetime outbound"}
      />
      <StatCard
        label="Reply Rate"
        value={replyRate * 100}
        valueLabel={fmtPercent(replyRate)}
        icon={<Reply />}
        tone={replyTone(replyRate)}
        subtitle={`${data.engagement.replied} of ${data.engagement.dms_sent} DMs`}
        info="Share of DMs that earned a reply. Engagement signal — not the same as the per-lead 'replied' status (a lead can reply once even if we DM'd them three times)."
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Daily activity sparkline. Renders the upstream's outbound.daily
// array as three stacked bar lanes (messages / likes / comments)
// across the period. Hand-rolled SVG so we don't add a chart lib.
// ---------------------------------------------------------------------------
function DailyActivityChart({
  daily, periodDays
}: { daily: OutboundDailyPoint[]; periodDays: number | null }) {
  const max = Math.max(1, ...daily.map((d) => Math.max(d.messages, d.likes, d.comments)));
  const W = 100;            // viewBox width in arbitrary units
  const H = 28;             // viewBox height per lane
  const GAP = 2;            // gap between lanes (in viewBox units)
  const colWidth = W / daily.length;
  const lanes: Array<{ key: keyof OutboundDailyPoint; label: string; stroke: string; fill: string }> = [
    { key: "messages", label: "Messages", stroke: "stroke-violet-500", fill: "fill-violet-500"  },
    { key: "likes",    label: "Likes",    stroke: "stroke-rose-500",   fill: "fill-rose-500"    },
    { key: "comments", label: "Comments", stroke: "stroke-amber-500",  fill: "fill-amber-500"   }
  ];
  const total = daily.reduce(
    (acc, d) => ({ messages: acc.messages + d.messages, likes: acc.likes + d.likes, comments: acc.comments + d.comments }),
    { messages: 0, likes: 0, comments: 0 }
  );

  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <div className="text-[13px] font-semibold text-ink">
          Daily activity{periodDays ? ` · last ${periodDays} days` : ""}
        </div>
        <div className="flex items-center gap-3 text-[10.5px] text-ink/65">
          {lanes.map((l) => (
            <span key={l.key} className="inline-flex items-center gap-1">
              <span className={cn("inline-block w-2.5 h-2.5 rounded-sm", l.fill.replace("fill-", "bg-"))} />
              {l.label}
              <span className="text-ink/45 tabular-nums">· {fmtNumber(total[l.key as "messages" | "likes" | "comments"])}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="text-[11px] text-ink/55 mb-3">
        Each column is a day. Per-lane scaling is shared so spikes line up across messages / likes / comments.
      </div>
      <div className="space-y-1.5">
        {lanes.map((lane) => (
          <div key={lane.key}>
            <svg
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              className="w-full h-7"
              role="img"
              aria-label={`${lane.label} per day`}
            >
              {daily.map((d, i) => {
                const v = d[lane.key as "messages" | "likes" | "comments"] as number;
                const h = max === 0 ? 0 : (v / max) * (H - GAP);
                if (h <= 0) return null;
                return (
                  <rect
                    key={`${lane.key}-${d.date}`}
                    x={i * colWidth + colWidth * 0.1}
                    y={H - h}
                    width={Math.max(0.5, colWidth * 0.8)}
                    height={h}
                    className={lane.fill}
                    rx={0.5}
                  >
                    <title>{`${d.date} — ${lane.label}: ${v}`}</title>
                  </rect>
                );
              })}
              {/* baseline */}
              <line x1="0" y1={H} x2={W} y2={H} className="stroke-slate-200" strokeWidth="0.3" />
            </svg>
          </div>
        ))}
      </div>
      {daily.length > 1 && (
        <div className="flex justify-between text-[10px] text-ink/45 mt-2">
          <span>{daily[0].date}</span>
          <span>{daily[daily.length - 1].date}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Funnel — uses upstream's pre-computed funnel array. `count` is
// cumulative lifetime; `conversion` is a percent (0-100, not 0-1).
// Width is scaled to the largest bucket since real-world LinkedIn
// data isn't strictly funnel-shaped.
// ---------------------------------------------------------------------------
function FunnelWidget({ funnel }: { funnel: FunnelEntry[] }) {
  const max = Math.max(1, ...funnel.map((s) => s.count));
  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5 h-full">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[13px] font-semibold text-ink">Funnel (lifetime)</div>
        <div className="text-[10.5px] text-ink/55">conversion vs prior stage on right</div>
      </div>
      <div className="text-[11px] text-ink/55 mb-4">
        Counts are cumulative — every lead that ever reached this stage. Width is scaled to the largest bucket.
      </div>
      <div className="space-y-2.5">
        {funnel.map((entry) => {
          const widthPct = (entry.count / max) * 100;
          const palette = STAGE_PALETTE[entry.stage];
          const Icon = palette.icon;
          return (
            <div key={entry.stage} className="flex items-center gap-3">
              <div className={cn("w-7 h-7 rounded-lg grid place-items-center shrink-0", palette.iconBg, palette.iconFg)}>
                <Icon className="w-[14px] h-[14px]" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="text-[12px] font-medium text-ink" title={STAGE_HINT[entry.stage]}>
                    {entry.label}
                  </span>
                  <span className="text-[11px] text-ink/55 tabular-nums">{fmtNumber(entry.count)}</span>
                </div>
                <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className={cn("h-full transition-[width]", palette.barFill)}
                    style={{ width: `${Math.max(entry.count > 0 ? 2 : 0, widthPct)}%` }}
                  />
                </div>
              </div>
              <div className="w-16 text-right text-[11px] tabular-nums shrink-0">
                {entry.conversion == null
                  ? <span className="text-ink/35">—</span>
                  : <span className={conversionTone(entry.conversion)}>{fmtPercentRaw(entry.conversion)}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Engagement side panel — sits next to the funnel.
// ---------------------------------------------------------------------------
function EngagementCard({ data }: { data: LinkedInOutboundMetrics }) {
  const e = data.engagement;
  const total = e.dms_sent + e.likes + e.comments + e.replied;
  const items: Array<{ key: keyof typeof e; label: string; icon: typeof Send; tone: keyof typeof ENGAGEMENT_PALETTE }> = [
    { key: "dms_sent", label: "DMs sent",  icon: Send,           tone: "violet"  },
    { key: "likes",    label: "Likes",     icon: ThumbsUp,       tone: "rose"    },
    { key: "comments", label: "Comments",  icon: MessageCircle,  tone: "amber"   },
    { key: "replied",  label: "Replies",   icon: CornerDownLeft, tone: "emerald" }
  ];
  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5 h-full">
      <div className="text-[13px] font-semibold text-ink mb-1">Engagement activity</div>
      <div className="text-[11px] text-ink/55 mb-4">
        {data.periodDays ? `Last ${data.periodDays} days. ` : ""}Outbound actions from the automation runner.
      </div>
      <div className="space-y-3">
        {items.map(({ key, label, icon: Icon, tone }) => {
          const palette = ENGAGEMENT_PALETTE[tone];
          const value = e[key];
          const share = total > 0 ? value / total : 0;
          return (
            <div key={key}>
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="inline-flex items-center gap-2 text-[12px] text-ink/75">
                  <span className={cn("w-6 h-6 rounded-md grid place-items-center", palette.iconBg, palette.iconFg)}>
                    <Icon className="w-[13px] h-[13px]" />
                  </span>
                  {label}
                </span>
                <span className="text-[12px] font-semibold tabular-nums text-ink">
                  {fmtNumber(value)}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <div
                  className={cn("h-full transition-[width]", palette.barFill)}
                  style={{ width: `${Math.max(value > 0 ? 2 : 0, Math.round(share * 100))}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline snapshot — where the *currently active* leads sit right
// now, per leads_by_status. Different from the funnel widget above
// because that's cumulative-lifetime; this is "where are people
// today". Rendered as a horizontal stacked bar.
// ---------------------------------------------------------------------------
function PipelineSnapshot({
  leadsByStatus, active
}: { leadsByStatus: LeadsByStatus; active: number }) {
  const total = FUNNEL_STAGES.reduce((sum, s) => sum + leadsByStatus[s], 0);
  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <div className="text-[13px] font-semibold text-ink">Pipeline snapshot</div>
        <div className="text-[10.5px] text-ink/55 tabular-nums">{fmtNumber(active)} active</div>
      </div>
      <div className="text-[11px] text-ink/55 mb-3">
        Where each currently-active lead sits right now. Sums to the active-pipeline count.
      </div>
      <div className="h-3 rounded-full bg-slate-100 overflow-hidden flex mb-3">
        {FUNNEL_STAGES.map((stage) => {
          const v = leadsByStatus[stage];
          if (v <= 0 || total <= 0) return null;
          const widthPct = (v / total) * 100;
          return (
            <div
              key={stage}
              className={cn("h-full", STAGE_PALETTE[stage].barFill)}
              style={{ width: `${widthPct}%` }}
              title={`${STAGE_LABEL[stage]}: ${v}`}
            />
          );
        })}
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {FUNNEL_STAGES.map((stage) => {
          const v = leadsByStatus[stage];
          return (
            <div
              key={stage}
              className="rounded-lg border border-slate-200/60 bg-white p-2"
            >
              <div className="flex items-center gap-1.5 text-[10.5px] text-ink/60">
                <span className={cn("inline-block w-2 h-2 rounded-sm", STAGE_PALETTE[stage].barFill)} />
                {STAGE_LABEL[stage]}
              </div>
              <div className="text-[15px] font-semibold tabular-nums text-ink mt-1">{fmtNumber(v)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Terminal status tiles.
// ---------------------------------------------------------------------------
function TerminalStates({ data }: { data: LinkedInOutboundMetrics }) {
  const items: Array<{ key: keyof LeadsByStatus; tone: "rose" | "indigo"; icon: typeof XCircle }> = [
    { key: "dead",        tone: "rose",   icon: XCircle  },
    { key: "re_enrolled", tone: "indigo", icon: RotateCw }
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {items.map(({ key, tone, icon: Icon }) => {
        const value = data.leads_by_status[key];
        const palette = TERMINAL_PALETTE[tone];
        return (
          <div key={key} className={cn(
            "rounded-2xl border p-4 shadow-soft flex items-center gap-3",
            palette.bg, palette.border
          )}>
            <div className={cn("w-9 h-9 rounded-xl grid place-items-center shrink-0", palette.iconBg, palette.iconFg)}>
              <Icon className="w-[18px] h-[18px]" />
            </div>
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-ink/65">{STAGE_LABEL[key]}</div>
              <div className={cn("text-[22px] leading-none font-semibold tabular-nums mt-1.5", palette.numberFg)}>
                {fmtNumber(value)}
              </div>
              <div className="text-[10.5px] text-ink/50 mt-1.5">{STAGE_HINT[key]}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GeneratedFooter({
  generatedAt, periodDays
}: { generatedAt: string; periodDays: number | null }) {
  // Render the ISO string verbatim — toLocaleString() would diverge
  // between SSR and the first client render and trip a hydration
  // warning. Operators see ISO across the rest of DD anyway.
  return (
    <div className="text-[10.5px] text-ink/50 text-right">
      Data {generatedAt}{periodDays ? ` · ${periodDays}-day window` : ""}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Callouts — derive the most useful actionable signal.
// ---------------------------------------------------------------------------
function deriveCallout(data: LinkedInOutboundMetrics): {
  tone: "rose" | "amber" | "sky"; title: string; body: string
} | null {
  const e = data.engagement;
  const s = data.leads_by_status;
  const replyRate = e.dms_sent > 0 ? e.replied / e.dms_sent : 0;

  if (s.booked === 0 && s.replied > 0) {
    return {
      tone: "amber",
      title: `${s.replied} replies, 0 bookings`,
      body: "Leads are responding but not getting to a meeting. Tighten the calendar handoff in the reply-stage cadence."
    };
  }
  if (s.invited === 0 && s.messaged > 0) {
    return {
      tone: "sky",
      title: `0 invited but ${fmtNumber(s.messaged)} messaged`,
      body: "Messaged volume far exceeds invited — likely a legacy campaign or an automation that skips the connection-request stage. Worth confirming whether 'invited' is being tracked at all."
    };
  }
  if (e.dms_sent > 20 && replyRate < 0.05) {
    return {
      tone: "rose",
      title: `Reply rate is ${fmtPercent(replyRate)}`,
      body: `Only ${e.replied} of ${e.dms_sent} DMs got a reply. Below 5% usually means the opener needs a rewrite or the audience targeting is off.`
    };
  }
  if (data.leads.active_in_pipeline === 0 && data.leads.total_leads > 0) {
    return {
      tone: "rose",
      title: "Nobody in active pipeline",
      body: "Every sourced lead has exited the funnel. Refill discovery before the engagement pipeline drains."
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
    lower.includes("missing linkedin_outbound_kpis_url")
      ? "Set LINKEDIN_OUTBOUND_KPIS_URL in the server env (Vercel → Project → Settings → Environment Variables for production, .env.local then restart `npm run dev` for local), then refresh."
    : lower.includes("redirect") || lower.includes("login") || lower.includes("non-json") || lower.includes("text/html")
      ? "Netlify is gating the endpoint behind login. Either whitelist the linkedinoutbound_api_*/kpis path in scaledai.netlify.app's middleware (so the URL-embedded token IS the credential), or surface a separate auth header (Bearer or x-api-key) the server can attach to the request."
    : lower.includes("network error") || lower.includes("fetch failed")
      ? "Couldn't reach the LinkedIn outbound service. Confirm scaledai.netlify.app is up and the URL value matches the deployed path."
    : lower.includes("unexpected response shape")
      ? "Endpoint replied with JSON but no recognizable totals / leads_by_status keys. Re-check the response schema against linkedin-outbound-metrics-types.ts."
      : "Check the upstream service status and that the env var matches the deployed KPIs URL.";
  return (
    <div className="rounded-2xl border border-rose-200/70 bg-rose-50/60 p-5 shadow-soft">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl grid place-items-center bg-rose-100 text-rose-600 shrink-0">
          <AlertCircle className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-rose-900">
            Couldn't load LinkedIn outbound metrics
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
// Palettes.
// ---------------------------------------------------------------------------
const STAGE_PALETTE: Record<FunnelStage, {
  icon: typeof Eye;
  iconBg: string;
  iconFg: string;
  barFill: string;
}> = {
  discovered: { icon: Eye,           iconBg: "bg-slate-100",   iconFg: "text-slate-600",   barFill: "bg-slate-400"   },
  invited:    { icon: MailPlus,      iconBg: "bg-sky-50",      iconFg: "text-sky-600",     barFill: "bg-sky-500"     },
  accepted:   { icon: UserCheck,     iconBg: "bg-indigo-50",   iconFg: "text-indigo-600",  barFill: "bg-indigo-500"  },
  messaged:   { icon: MessageSquare, iconBg: "bg-violet-50",   iconFg: "text-violet-600",  barFill: "bg-violet-500"  },
  replied:    { icon: Reply,         iconBg: "bg-fuchsia-50",  iconFg: "text-fuchsia-600", barFill: "bg-fuchsia-500" },
  booked:     { icon: CalendarCheck, iconBg: "bg-emerald-50",  iconFg: "text-emerald-600", barFill: "bg-emerald-500" }
};

const ENGAGEMENT_PALETTE: Record<"violet" | "rose" | "amber" | "emerald", {
  iconBg: string; iconFg: string; barFill: string;
}> = {
  violet:  { iconBg: "bg-violet-50",  iconFg: "text-violet-600",  barFill: "bg-violet-500"  },
  rose:    { iconBg: "bg-rose-50",    iconFg: "text-rose-600",    barFill: "bg-rose-500"    },
  amber:   { iconBg: "bg-amber-50",   iconFg: "text-amber-600",   barFill: "bg-amber-500"   },
  emerald: { iconBg: "bg-emerald-50", iconFg: "text-emerald-600", barFill: "bg-emerald-500" }
};

const TERMINAL_PALETTE: Record<"rose" | "indigo", {
  bg: string; border: string; iconBg: string; iconFg: string; numberFg: string;
}> = {
  rose:   { bg: "bg-rose-50/40",   border: "border-rose-200/60",   iconBg: "bg-rose-100",   iconFg: "text-rose-600",   numberFg: "text-rose-700"   },
  indigo: { bg: "bg-indigo-50/40", border: "border-indigo-200/60", iconBg: "bg-indigo-100", iconFg: "text-indigo-600", numberFg: "text-indigo-700" }
};

function replyTone(rate: number): "emerald" | "amber" | "rose" {
  if (rate >= 0.15) return "emerald";
  if (rate >= 0.05) return "amber";
  return "rose";
}

// Tone for upstream's `conversion` value (0-100 percent, not 0-1 rate).
function conversionTone(pct: number): string {
  if (pct >= 50)  return "text-emerald-600";
  if (pct >= 20)  return "text-amber-600";
  return "text-rose-600";
}

function pctOfTotal(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return "—";
  return fmtPercent(part / whole);
}

function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

function fmtPercent(rate: number): string {
  if (!Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(rate >= 0.995 ? 0 : 1)}%`;
}

// Format an already-percentage value (0-100). Used for upstream's
// `conversion` field which is already in percent units.
function fmtPercentRaw(pct: number): string {
  if (!Number.isFinite(pct)) return "—";
  return `${pct.toFixed(pct >= 99.5 ? 0 : 1)}%`;
}
