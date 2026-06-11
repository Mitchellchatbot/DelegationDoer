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
  type FunnelStage, type LeadsByStatus, type LinkedInOutboundMetrics,
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
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2">
          <FunnelWidget data={data} />
        </div>
        <EngagementCard data={data} />
      </div>
      <TerminalStates data={data} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero row — Total Leads · Active in Pipeline · DMs Sent · Reply Rate.
// Same 4-up grid as the FB / Website Builder pages so the channels
// feel like siblings.
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
        subtitle="lifetime outbound"
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
// Funnel — stepped horizontal bars for the six core stages. Width is
// scaled to the *largest* bucket rather than monotonically shrinking,
// because real-world LinkedIn data isn't strictly funnel-shaped
// (legacy "messaged" rows often outnumber "invited"/"accepted" once a
// campaign migrates ingest paths). Each row also surfaces the
// step-over-step retention so the user can see where leads drop off.
// ---------------------------------------------------------------------------
function FunnelWidget({ data }: { data: LinkedInOutboundMetrics }) {
  const buckets = data.leads_by_status;
  const max = Math.max(1, ...FUNNEL_STAGES.map((s) => buckets[s]));
  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5 h-full">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[13px] font-semibold text-ink">Funnel by status</div>
        <div className="text-[10.5px] text-ink/55">step-over-step retention shown on right</div>
      </div>
      <div className="text-[11px] text-ink/55 mb-4">
        Width scaled to the largest bucket. Cohort overlaps aren't strict so steps may grow before they shrink.
      </div>
      <div className="space-y-2.5">
        {FUNNEL_STAGES.map((stage, i) => {
          const value = buckets[stage];
          const widthPct = (value / max) * 100;
          const prev = i > 0 ? buckets[FUNNEL_STAGES[i - 1]] : null;
          const retention = prev != null && prev > 0 ? value / prev : null;
          const palette = STAGE_PALETTE[stage];
          const Icon = palette.icon;
          return (
            <div key={stage} className="flex items-center gap-3">
              <div className={cn("w-7 h-7 rounded-lg grid place-items-center shrink-0", palette.iconBg, palette.iconFg)}>
                <Icon className="w-[14px] h-[14px]" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="text-[12px] font-medium text-ink" title={STAGE_HINT[stage]}>
                    {STAGE_LABEL[stage]}
                  </span>
                  <span className="text-[11px] text-ink/55 tabular-nums">{fmtNumber(value)}</span>
                </div>
                <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className={cn("h-full transition-[width]", palette.barFill)}
                    style={{ width: `${Math.max(value > 0 ? 2 : 0, widthPct)}%` }}
                  />
                </div>
              </div>
              <div className="w-14 text-right text-[11px] text-ink/55 tabular-nums shrink-0">
                {retention == null
                  ? <span className="text-ink/35">—</span>
                  : <span className={retentionTone(retention)}>{fmtPercent(retention)}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Engagement side panel — sits next to the funnel. Splits the four
// engagement signals into compact rows with their relative share of
// the total engagement volume.
// ---------------------------------------------------------------------------
function EngagementCard({ data }: { data: LinkedInOutboundMetrics }) {
  const e = data.engagement;
  const total = e.dms_sent + e.likes + e.comments + e.replied;
  const items: Array<{ key: keyof typeof e; label: string; icon: typeof Send; tone: keyof typeof ENGAGEMENT_PALETTE }> = [
    { key: "dms_sent", label: "DMs sent",  icon: Send,          tone: "violet" },
    { key: "likes",    label: "Likes",     icon: ThumbsUp,      tone: "rose"   },
    { key: "comments", label: "Comments",  icon: MessageCircle, tone: "amber"  },
    { key: "replied",  label: "Replies",   icon: CornerDownLeft, tone: "emerald" }
  ];
  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-5 h-full">
      <div className="text-[13px] font-semibold text-ink mb-1">Engagement activity</div>
      <div className="text-[11px] text-ink/55 mb-4">
        Lifetime — outbound actions across the LinkedIn automation runner.
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
// Terminal status tiles — `dead` and `re_enrolled` pull from the
// funnel rather than continuing it, so they get their own row.
// ---------------------------------------------------------------------------
function TerminalStates({ data }: { data: LinkedInOutboundMetrics }) {
  const items: Array<{ key: keyof LeadsByStatus; tone: "rose" | "indigo"; icon: typeof XCircle }> = [
    { key: "dead",        tone: "rose",   icon: XCircle },
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
// Palettes — keeps stage/engagement colors in one place.
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

function retentionTone(rate: number): string {
  if (rate >= 1)    return "text-emerald-600";
  if (rate >= 0.5)  return "text-emerald-600";
  if (rate >= 0.2)  return "text-amber-600";
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
