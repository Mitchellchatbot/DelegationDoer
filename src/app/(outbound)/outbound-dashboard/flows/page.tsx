import { GitBranch } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { getFlowsOverview } from "@/lib/outbound-leads";
import { OutboundFlowsView } from "@/components/OutboundFlowsView";

// /outbound-dashboard/flows — flow-centric view of the texting program.
// Each flow (booking sequence / recovery drip / engagement drip) lays
// out its steps left-to-right with the template copy, timing, and the
// list of leads currently queued at each step.
//
// Auth + cohort gate live in the (outbound) layout.

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function OutboundFlowsPage() {
  const buckets = await getFlowsOverview();
  return (
    <div className="space-y-4 max-w-[1400px] mx-auto">
      <PageHero
        eyebrow="Funnel · Texting"
        headline={["Outbound ", { accent: "flows" }]}
        subtitle="Every step in every texting sequence, with live counts and the lead names currently queued. Click a queued lead to jump to their detail page."
        icon={<GitBranch />}
        iconTone="indigo"
      />
      <OutboundFlowsView buckets={buckets} />
    </div>
  );
}
