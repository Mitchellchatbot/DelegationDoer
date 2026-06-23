import { Users as UsersIcon } from "lucide-react";
import { PageHero } from "@/components/PageHero";
import {
  listLeads, getLeadStatusCounts, getNextScheduledMessage,
  type LeadStatus, type OutboundLead, type ScheduledMessage
} from "@/lib/outbound-leads";
import { StatusFilterBar, NoLeadsHint } from "@/components/OutboundLeadsTable";
import { OutboundFunnelStrip } from "@/components/OutboundFunnelStrip";
import { extractWebsiteUrl } from "@/lib/website-builder-integration";
import { listForms, type OutboundTypeformForm } from "@/lib/outbound-typeform-forms";
import { OutboundLeadsByForm } from "@/components/OutboundLeadsByForm";
import { OutboundTypeformFormsDrawer } from "@/components/OutboundTypeformFormsDrawer";

// /outbound-dashboard/leads — every lead in the funnel, grouped by the
// Typeform that sent them. Each form is a collapsible block; unknown
// form_ids surface in a single catch-all block at the bottom so no lead
// is hidden.

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

interface GroupRow {
  lead: OutboundLead;
  nextMessage: ScheduledMessage | null;
}
interface Group {
  formId: string | null;
  label: string;
  description: string | null;
  rows: GroupRow[];
}

function buildGroups(
  rows: GroupRow[],
  forms: OutboundTypeformForm[]
): { groups: Group[]; unknownFormIds: string[] } {
  // Form catalog → quick lookup so we can build header labels in O(1).
  const catalog = new Map(forms.map((f) => [f.id, f]));

  // Bucket rows by form_id (or null for legacy leads).
  const buckets = new Map<string, GroupRow[]>();
  const unknownIds = new Set<string>();
  for (const r of rows) {
    const id = r.lead.typeformFormId ?? "__null__";
    if (r.lead.typeformFormId && !catalog.has(r.lead.typeformFormId)) {
      unknownIds.add(r.lead.typeformFormId);
    }
    const arr = buckets.get(id) ?? [];
    arr.push(r);
    buckets.set(id, arr);
  }

  // 1) Registered forms first, in catalog order — empty buckets included
  //    so a new form shows up with a "0 leads" header the moment it's
  //    registered (helpful when waiting for the first submission).
  const groups: Group[] = [];
  for (const f of forms) {
    groups.push({
      formId: f.id,
      label: f.label,
      description: f.description,
      rows: buckets.get(f.id) ?? []
    });
  }

  // 2) Unknown forms — every form_id that fired a webhook but isn't in
  //    the catalog. Grouped per-id so the operator can spot which
  //    unfamiliar source is producing leads.
  for (const id of unknownIds) {
    groups.push({
      formId: id,
      label: "Unregistered form",
      description: id,
      rows: buckets.get(id) ?? []
    });
  }

  // 3) Legacy leads with no form_id at all. Survives the migration era —
  //    will quietly empty out once every old row is back-filled.
  const legacyBucket = buckets.get("__null__") ?? [];
  if (legacyBucket.length > 0) {
    groups.push({
      formId: null,
      label: "Legacy leads (no form ID)",
      description: "Submitted before per-form tracking was wired up",
      rows: legacyBucket
    });
  }

  // Drop empty registered forms ONLY if we have *some* leads to render —
  // otherwise we'd show a blank page. Keep empties when the funnel has
  // zero leads so the operator can still see "the catalog exists, no
  // submissions yet."
  const hasAnyRows = rows.length > 0;
  const filtered = hasAnyRows ? groups.filter((g) => g.rows.length > 0) : groups;

  return { groups: filtered, unknownFormIds: [...unknownIds] };
}

export default async function OutboundLeadsPage({
  searchParams
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const sp = await searchParams;
  const statusFilter = parseStatus(sp.status);

  const [counts, leadsPage, forms] = await Promise.all([
    getLeadStatusCounts(),
    listLeads({ status: statusFilter, limit: 100 }),
    listForms()
  ]);

  const nextMessages = await Promise.all(
    leadsPage.rows.map((l) => getNextScheduledMessage(l.id))
  );

  const tableRows: GroupRow[] = leadsPage.rows.map((lead, i) => ({
    // Fallback for pre-integration leads — surface a URL from
    // typeform_answers so the Demo column doesn't look empty while the
    // backfill is pending.
    lead: {
      ...lead,
      companyWebsiteUrl:
        lead.companyWebsiteUrl ?? extractWebsiteUrl(lead.typeformAnswers)
    },
    nextMessage: nextMessages[i]
  }));

  const { groups, unknownFormIds } = buildGroups(tableRows, forms);

  const showEmptyHint =
    leadsPage.rows.length === 0 && !statusFilter && leadsPage.total === 0;

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Funnel · Leads"
        headline={["Outbound ", { accent: "leads" }]}
        subtitle="Everyone in the funnel right now — grouped by Typeform source. Click a row to see the full timeline, scheduled SMS queue, and rep actions."
        icon={<UsersIcon />}
        iconTone="fuchsia"
      />
      <OutboundFunnelStrip counts={counts} />
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <StatusFilterBar counts={counts} active={statusFilter} />
        <OutboundTypeformFormsDrawer
          initialForms={forms}
          unknownFormIds={unknownFormIds}
        />
      </div>
      {showEmptyHint && <NoLeadsHint />}
      <OutboundLeadsByForm
        groups={groups}
        statusFilter={statusFilter}
        forms={forms}
      />
    </div>
  );
}
