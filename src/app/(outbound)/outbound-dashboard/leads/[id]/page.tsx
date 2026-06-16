import { notFound } from "next/navigation";
import { getLeadDetail } from "@/lib/outbound-leads";
import { OutboundLeadDetail } from "@/components/OutboundLeadDetail";

// /outbound-dashboard/leads/[id] — full lead detail. The page is server-
// rendered; the four action buttons inside OutboundLeadDetail are a
// client component that POSTs to /api/outbound/leads/[id]/mark-* and
// triggers a router.refresh() to repaint with the new state.

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function OutboundLeadDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getLeadDetail(id);
  if (!detail) notFound();
  return (
    <div className="max-w-7xl mx-auto">
      <OutboundLeadDetail
        lead={detail.lead}
        events={detail.events}
        messages={detail.messages}
      />
    </div>
  );
}
