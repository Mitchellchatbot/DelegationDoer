import { notFound } from "next/navigation";
import { getLeadDetail } from "@/lib/outbound-leads";
import { OutboundLeadDetail } from "@/components/OutboundLeadDetail";
import { extractWebsiteUrl } from "@/lib/website-builder-integration";

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
  // Pre-integration leads have `typeform_answers` populated but
  // `company_website_url` is still null. Surface the URL the rep would
  // see in the form by falling back to extractWebsiteUrl so the Demo
  // Site card is usable on day-one without a DB backfill.
  const lead = {
    ...detail.lead,
    companyWebsiteUrl:
      detail.lead.companyWebsiteUrl ??
      extractWebsiteUrl(detail.lead.typeformAnswers)
  };
  return (
    <div className="max-w-7xl mx-auto">
      <OutboundLeadDetail
        lead={lead}
        events={detail.events}
        messages={detail.messages}
      />
    </div>
  );
}
