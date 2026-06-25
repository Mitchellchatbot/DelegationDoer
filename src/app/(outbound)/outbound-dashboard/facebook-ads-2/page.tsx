import { BarChart3 } from "lucide-react";
import { getFunnelSummary } from "@/lib/google-sheet-fb2";
import { getAggregatedInsightsForSecondaryToken } from "@/lib/facebook-ads";
import { PageHero } from "@/components/PageHero";
import { SheetFunnelContent } from "@/components/SheetFunnelContent";
import { FacebookAdsContent } from "@/components/FacebookAdsContent";
import { CorrelationStrip } from "@/components/CorrelationStrip";

// Facebook Ads 2 — twin-source dashboard. Pulls metrics from BOTH:
//   1. The ops team's Google Sheet (Lead → VOB → Approved → Pitchable
//      → Admit funnel, the real post-click conversion story)
//   2. The Meta Marketing API on FACEBOOK_ADS_ACCESS_TOKEN_2 (raw ad
//      delivery — impressions / reach / clicks / CPM / CTR / spend)
//
// Top strip correlates the two: Meta-reported spend vs sheet-reported
// spend, plus the full cross-source funnel (impressions → clicks →
// leads → vobs → approved → pitchable → admits).
//
// Both fetches run in parallel — neither blocks the other, and a
// failure on one side doesn't tank the page (the surviving source
// still renders).

export const revalidate = 60;
export const dynamic = "force-dynamic";

export default async function OutboundFacebookAds2Page() {
  const [sheetRes, fbRes] = await Promise.all([
    getFunnelSummary(),
    getAggregatedInsightsForSecondaryToken("last_30d")
  ]);
  const sheet = sheetRes.ok ? sheetRes.data : null;
  const fb = fbRes.ok ? fbRes.data : null;

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <PageHero
        density="compact"
        eyebrow="Channel · Paid · Funnel"
        headline={["Facebook ", { accent: "Ads 2" }]}
        subtitle="Twin-source view — Meta Marketing API for delivery (impressions/clicks/spend) and the ops sheet for post-lead funnel (VOB → Approved → Pitchable → Admit)."
        icon={<BarChart3 />}
        iconTone="rose"
      />

      <CorrelationStrip sheet={sheet} fb={fb} />

      <SectionHeader
        eyebrow="Source · Ops sheet"
        title="Admissions funnel"
        sub="Lead → VOB → Approved → Pitchable → Admit, sourced from the live Google Sheet."
      />
      <SheetFunnelContent result={sheetRes} />

      <SectionHeader
        eyebrow="Source · Meta Marketing API"
        title="Ad delivery"
        sub="Spend, impressions, reach, clicks, CTR, CPM and frequency for every active ad account this token can see — last 30 days."
      />
      <FacebookAdsContent result={fbRes} />
    </div>
  );
}

function SectionHeader({ eyebrow, title, sub }: { eyebrow: string; title: string; sub: string }) {
  return (
    <div className="pt-2">
      <div className="text-[11px] uppercase tracking-[0.18em] font-semibold text-accent">
        {eyebrow}
      </div>
      <h2 className="text-[22px] font-semibold text-ink mt-1 leading-tight">{title}</h2>
      <p className="text-[13.5px] text-ink/60 mt-1 max-w-2xl">{sub}</p>
    </div>
  );
}
