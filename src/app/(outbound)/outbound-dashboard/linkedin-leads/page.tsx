import { Linkedin } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { LinkedInOutboundContent } from "@/components/LinkedInOutboundContent";
import { getLinkedInOutboundMetrics } from "@/lib/linkedin-outbound-metrics";

// LinkedIn outbound channel — reads engagement totals and the lead-
// status funnel from the standalone LinkedIn automation service on
// scaledai.netlify.app. Server-rendered so the tokenized KPIs URL
// never leaves the Node process.
//
// React render layer caches 2 min alongside the fetch layer's own
// cache; revisiting the tab inside that window is a no-op upstream.
export const revalidate = 120;

export default async function OutboundLinkedInLeadsPage() {
  const result = await getLinkedInOutboundMetrics();
  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Channel · Social"
        headline={["LinkedIn ", { accent: "Leads" }]}
        subtitle="Connection requests, acceptance, replies, and meetings booked from the LinkedIn automation runner."
        icon={<Linkedin />}
        iconTone="sky"
      />
      <LinkedInOutboundContent result={result} />
    </div>
  );
}
