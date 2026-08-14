import { MessageSquare } from "lucide-react";
import { getScopedBlooioSummary } from "@/lib/blooio-scope";
import { PageHero } from "@/components/PageHero";
import { OutboundMessagingContent } from "@/components/OutboundMessagingContent";

// Outbound messaging — iMessage + SMS volume / replies / engagement via
// the Blooio API. Bearer token in BLOOIO_API_TOKEN. 30-day window by
// default; widen by passing `days`.
//
// Deliberately getScopedBlooioSummary, NOT getBlooioSummary: the Blooio account
// is shared with the New Life CRM, and the raw summary is account-wide, so it
// reported their volume as ours and rendered their message bodies in the recent
// feed. The scoped version filters to conversations DD owns — see
// lib/blooio-scope.ts. Consequence: these figures intentionally do NOT match the
// totals in Blooio's own dashboard, which counts both tenants.

export const revalidate = 60;
export const dynamic = "force-dynamic";

export default async function OutboundMessagingPage() {
  const result = await getScopedBlooioSummary({ days: 30 });
  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <PageHero
        density="compact"
        eyebrow="Channel · Messaging"
        headline={["Outbound ", { accent: "messaging" }]}
        subtitle="iMessage + SMS volume, replies, and conversation activity for DelegationDoer's own contacts. Cost-per-X tiles arrive once we lock in a cost basis."
        icon={<MessageSquare />}
        iconTone="violet"
      />
      <OutboundMessagingContent result={result} />
    </div>
  );
}
