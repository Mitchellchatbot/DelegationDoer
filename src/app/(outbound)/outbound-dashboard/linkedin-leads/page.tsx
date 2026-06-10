import { Linkedin } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { LinkedInLeadsContent } from "@/components/LinkedInLeadsContent";
import { getLinkedInLeadsMetrics } from "@/lib/linkedin-leads-metrics";

// LinkedIn Leads channel — reads aggregated counts from the standalone
// LinkedIn-leads Supabase project (project_metrics view). Server-rendered
// so the service_role key never leaves the Node process.
//
// React render layer caches for 5 minutes alongside the fetch layer's
// own cache; revisiting the tab inside that window is a no-op upstream.
export const revalidate = 300;

export default async function OutboundLinkedInLeadsPage() {
  const result = await getLinkedInLeadsMetrics();
  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Channel · Social"
        headline={["LinkedIn ", { accent: "Leads" }]}
        subtitle="Outreach volume, success rate, and category mix from the LinkedIn-leads pipeline."
        icon={<Linkedin />}
        iconTone="sky"
      />
      <LinkedInLeadsContent result={result} />
    </div>
  );
}
