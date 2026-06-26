import { BarChart3 } from "lucide-react";
import { getAggregatedInsights } from "@/lib/facebook-ads";
import { PageHero } from "@/components/PageHero";
import { FacebookAdsContent } from "@/components/FacebookAdsContent";

// Standalone (purple-shell) Facebook Ads page. Same body as the in-app
// version at /outbound/facebook-ads — just rendered inside the outbound
// dashboard layout. Auth + cohort gate is in the parent layout.

export const revalidate = 300;
export const dynamic = "force-dynamic";

export default async function OutboundFacebookAdsPage() {
  const result = await getAggregatedInsights("last_30d");
  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <PageHero
        density="compact"
        eyebrow="Channel · Paid"
        headline={["Mike's Facebook ", { accent: "Campaign" }]}
        subtitle="Live performance from the Meta Marketing API — last 30 days."
        icon={<BarChart3 />}
        iconTone="indigo"
      />
      <FacebookAdsContent result={result} />
    </div>
  );
}
