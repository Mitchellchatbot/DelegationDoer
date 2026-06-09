import { Linkedin } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { EmptyChannelPanel } from "@/components/EmptyChannelPanel";

// LinkedIn Leads channel — placeholder for now. Will sit on top of a
// Sales Navigator export or a Phantombuster pipeline; the unified view
// here is connections sent / accepted / replied / booked.

export default function OutboundLinkedInLeadsPage() {
  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Channel · Social"
        headline={["LinkedIn ", { accent: "Leads" }]}
        subtitle="Connection requests, acceptance rate, reply rate, and meetings booked from outbound DMs."
        icon={<Linkedin />}
        iconTone="sky"
      />
      <EmptyChannelPanel
        title="LinkedIn pipeline pending"
        body="Wire up a Sales Navigator export or Phantombuster webhook, then this surface renders the connect → accept → reply → booked funnel for every outbound seat."
        next="Pick an ingest path (CSV upload, Phantombuster webhook, or direct Sales Nav API) and let me know which to scaffold."
      />
    </div>
  );
}
