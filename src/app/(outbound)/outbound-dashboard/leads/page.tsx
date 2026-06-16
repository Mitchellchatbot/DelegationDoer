import { Users as UsersIcon } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import {
  listLeads, getLeadStatusCounts, getNextScheduledMessage,
  type LeadStatus
} from "@/lib/outbound-leads";
import { OutboundLeadsTable, StatusFilterBar, NoLeadsHint } from "@/components/OutboundLeadsTable";
import { OutboundFunnelStrip } from "@/components/OutboundFunnelStrip";

// /outbound-dashboard/leads — every lead in the funnel, status-filtered.
// Auth + cohort gate live in the (outbound) layout.

export const dynamic = "force-dynamic";
export const revalidate = 0;

const VALID_STATUSES: LeadStatus[] = [
  "warm_lead", "booked", "showed", "no_show", "success", "lost"
];

function parseStatus(raw: string | string[] | undefined): LeadStatus | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return null;
  return (VALID_STATUSES as string[]).includes(v) ? (v as LeadStatus) : null;
}

export default async function OutboundLeadsPage({
  searchParams
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const sp = await searchParams;
  const statusFilter = parseStatus(sp.status);

  const [counts, leadsPage] = await Promise.all([
    getLeadStatusCounts(),
    listLeads({ status: statusFilter, limit: 100 })
  ]);

  // Pull next pending scheduled message per lead — done in parallel
  // after we have the lead ids. Small N (≤100) so the fanout is cheap.
  const nextMessages = await Promise.all(
    leadsPage.rows.map((l) => getNextScheduledMessage(l.id))
  );
  const tableRows = leadsPage.rows.map((lead, i) => ({
    lead,
    nextMessage: nextMessages[i]
  }));

  const showEmptyHint = leadsPage.rows.length === 0 && !statusFilter && leadsPage.total === 0;

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Funnel · Leads"
        headline={["Outbound ", { accent: "leads" }]}
        subtitle="Everyone in the funnel right now — filterable by stage. Click a row to see the full timeline, scheduled SMS queue, and rep actions."
        icon={<UsersIcon />}
        iconTone="fuchsia"
      />
      <OutboundFunnelStrip counts={counts} />
      <StatusFilterBar counts={counts} active={statusFilter} />
      {showEmptyHint && <NoLeadsHint />}
      <OutboundLeadsTable
        rows={tableRows}
        totalCount={leadsPage.total}
        statusFilter={statusFilter}
      />
    </div>
  );
}
