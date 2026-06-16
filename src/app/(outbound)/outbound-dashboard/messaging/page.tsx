import { MessageSquare } from "lucide-react";
import { getBlooioSummary } from "@/lib/blooio";
import { PageHero } from "@/components/PageHero";
import { OutboundMessagingContent } from "@/components/OutboundMessagingContent";

// Outbound messaging — iMessage + SMS volume / replies / engagement via
// the Blooio API. Bearer token in BLOOIO_API_TOKEN. 30-day window by
// default; widen by passing `days` to getBlooioSummary.

export const revalidate = 60;
export const dynamic = "force-dynamic";

export default async function OutboundMessagingPage() {
  const result = await getBlooioSummary({ days: 30 });
  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Channel · Messaging"
        headline={["Outbound ", { accent: "messaging" }]}
        subtitle="iMessage + SMS volume, replies, and conversation activity from Blooio. Cost-per-X tiles arrive once we lock in a cost basis."
        icon={<MessageSquare />}
        iconTone="violet"
      />
      <OutboundMessagingContent result={result} />
    </div>
  );
}
