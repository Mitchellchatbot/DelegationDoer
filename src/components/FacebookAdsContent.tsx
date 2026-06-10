import {
  DollarSign, Eye, Users, MousePointerClick, Repeat, BarChart3,
  Sparkles, Target, AlertCircle
} from "lucide-react";
import {
  fmtCurrency, fmtNumber, fmtPercent,
  type FbAggregatedInsights, type FbResult
} from "@/lib/facebook-ads";
import { StatCard } from "@/components/StatCard";

// Shared Facebook Ads dashboard body — used by both the in-app
// /outbound/facebook-ads page and the standalone purple-shell
// /outbound-dashboard/facebook-ads page. Takes the already-fetched
// FbResult so both surfaces stay server-rendered and identically
// cached.

export function FacebookAdsContent({ result }: { result: FbResult<FbAggregatedInsights> }) {
  if (!result.ok) return <ErrorPanel error={result.error} />;
  // Per-account breakdown panel removed — the aggregated KPI grid is
  // sufficient for the dashboard; the per-account splits were noisy and
  // the secondary token's PKR account zeros made the row read as broken.
  return <KpiGrid data={result.data} />;
}

function KpiGrid({ data }: { data: FbAggregatedInsights }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Total Spend"
          value={data.spend}
          valueLabel={fmtCurrency(data.spend, data.currency)}
          icon={<DollarSign />}
          tone="emerald"
          subtitle="last 30d"
          info={`Sum of spend across ${data.accountCount} ad account${data.accountCount === 1 ? "" : "s"} in ${data.currency}.`}
        />
        <StatCard
          label="Impressions"
          value={data.impressions}
          valueLabel={fmtNumber(data.impressions)}
          icon={<Eye />}
          tone="blue"
          subtitle="times ads were shown"
        />
        <StatCard
          label="Reach"
          value={data.reach}
          valueLabel={fmtNumber(data.reach)}
          icon={<Users />}
          tone="sky"
          subtitle="unique people"
        />
        <StatCard
          label="Link Clicks"
          value={data.clicks}
          valueLabel={fmtNumber(data.clicks)}
          icon={<MousePointerClick />}
          tone="indigo"
          subtitle={`${fmtPercent(data.ctr)} CTR`}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Frequency"
          value={data.frequency}
          valueLabel={data.frequency.toFixed(2)}
          icon={<Repeat />}
          tone="amber"
          subtitle="avg views / person"
          info="How often the average reached person saw an ad. Above ~3 usually signals fatigue."
        />
        <StatCard
          label="CPM"
          value={data.cpm}
          valueLabel={fmtCurrency(data.cpm, data.currency)}
          icon={<BarChart3 />}
          tone="violet"
          subtitle="per 1,000 impressions"
        />
        <StatCard
          label="CPC"
          value={data.cpc}
          valueLabel={fmtCurrency(data.cpc, data.currency)}
          icon={<Target />}
          tone="fuchsia"
          subtitle="per link click"
        />
        <StatCard
          label="Submit Application"
          value={data.leads}
          valueLabel={fmtNumber(data.leads)}
          icon={<Sparkles />}
          tone="rose"
          subtitle="form submissions"
          info="Counts every Meta action with action_type matching /lead/ — primarily lead-form submissions (the 'Submit Application' CTA), plus any on-platform or offsite-conversion leads."
        />
      </div>
    </div>
  );
}

function ErrorPanel({ error }: { error: string }) {
  const lower = error.toLowerCase();
  const hint =
    lower.includes("missing facebook_ads_access_token")
      ? "Set FACEBOOK_ADS_ACCESS_TOKEN in the server env (Railway → Service → Variables for production, .env.local then restart `npm run dev` for local), then refresh."
    : lower.includes("expired") || lower.includes("session has expired")
      ? "The token has expired. Re-issue a long-lived user token via the Meta Graph API Explorer (ads_read scope) and bump FACEBOOK_ADS_ACCESS_TOKEN."
    : lower.includes("permission") || lower.includes("(#10)") || lower.includes("(#200)")
      ? "The token lacks the required permissions. It needs ads_read (and ads_management if you want lead counts to populate). Re-issue with both scopes in the Graph API Explorer."
    : lower.includes("unsupported get request") || lower.includes("(#100)")
      ? "Meta rejected the insights query for that account — usually means the account is closed, the user behind the token doesn't have an Advertiser+ role on it, or the date range has no data. Verify Business Manager → Users → Assigned Assets."
    : lower.includes("too many calls") || lower.includes("(#80004)") || lower.includes("rate")
      ? "Meta rate-limited the call. Wait a few minutes and refresh — the per-account insights call cache is 5min."
    : lower.includes("no accessible") || lower.includes("no active") || lower.includes("no matching")
      ? "Token is valid but no matching ad accounts came back. Check the NAME_FILTER in lib/facebook-ads.ts and Business Manager → Users → Assigned Assets."
    : "Check the token's scopes (ads_read at minimum), the user's ad-account role in Business Manager, and the Meta API status page.";
  return (
    <div className="rounded-2xl border border-rose-200/70 bg-rose-50/60 p-5 shadow-soft">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl grid place-items-center bg-rose-100 text-rose-600 shrink-0">
          <AlertCircle className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-rose-900">
            Couldn't load Facebook Ads insights
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
