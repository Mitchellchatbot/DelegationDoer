import { Globe } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { WebsiteBuilderContent } from "@/components/WebsiteBuilderContent";
import { getWebsiteBuilderMetrics } from "@/lib/website-builder-metrics";

// Website Builder channel — reads aggregated counts from the standalone
// Website Builder Supabase project (project_metrics view).
// Server-rendered so the service_role key never leaves the Node
// process.
//
// React render layer caches for 5 minutes alongside the fetch layer's
// own cache; revisiting the tab inside that window is a no-op upstream.
export const revalidate = 300;

export default async function OutboundWebsiteBuilderPage() {
  const result = await getWebsiteBuilderMetrics();
  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Channel · Product"
        headline={["Website ", { accent: "Builder" }]}
        subtitle="Project volume, success rate, and category mix from the website-builder pipeline."
        icon={<Globe />}
        iconTone="amber"
      />
      <WebsiteBuilderContent result={result} />
    </div>
  );
}
