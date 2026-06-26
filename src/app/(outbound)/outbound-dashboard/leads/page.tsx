import { GitBranch, LayoutGrid, Shuffle, Users as UsersIcon } from "lucide-react";
import Link from "next/link";
import { PageHero } from "@/components/PageHero";
import {
  getFlowsOverview, loadTemplateMap, getLeadStatusCounts, listLeads,
  getLeadsByFlow, getNextScheduledMessage,
  type LeadStatus, type OutboundLead, type ScheduledMessage
} from "@/lib/outbound-leads";
import { listForms, type OutboundTypeformForm } from "@/lib/outbound-typeform-forms";
import { OutboundFlowsView } from "@/components/OutboundFlowsView";
import { OutboundFunnelStrip } from "@/components/OutboundFunnelStrip";
import { OutboundLeadsBoard } from "@/components/OutboundLeadsBoard";
import { OutboundSequenceBoard } from "@/components/OutboundSequenceBoard";
import { OutboundLeadsByForm } from "@/components/OutboundLeadsByForm";
import { OutboundTypeformFormsDrawer } from "@/components/OutboundTypeformFormsDrawer";
import { OutboundSourceSelect } from "@/components/OutboundSourceSelect";
import { StatusFilterBar, NoLeadsHint } from "@/components/OutboundLeadsTable";
import { AddLeadButton } from "@/components/AddLeadButton";
import { extractWebsiteUrl } from "@/lib/website-builder-integration";
import { cn } from "@/lib/utils";

// /outbound-dashboard/leads — the single Outbound pipeline tab. Three views,
// toggled via ?view= (formerly split across the Leads + Flows tabs):
//   - "board" (default): the lead-centric view. A Notion-style stage kanban
//     (drag a lead between columns to update its stage) with the full
//     source-grouped lead list directly below it — scroll down for the list,
//     status filter, next-touch + demo-site columns.
//   - "flow": Notion-style kanban of the SMS nurture sequences. One column per
//     sequence (Booking / Recovery / Engagement); drag a lead between drips.
//   - "sequences": the flow-centric texting view — every step in every SMS
//     sequence with live counts and the leads queued at each.
//
// The old /outbound-dashboard/flows route now redirects here. The former
// separate "list" view is now folded into "board"; ?view=list falls through
// to the board. Auth + cohort gate live in the (outbound) layout.

export const dynamic = "force-dynamic";
export const revalidate = 0;

type View = "board" | "flow" | "sequences";

function parseView(raw: string | string[] | undefined): View {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === "flow") return "flow";
  if (v === "sequences") return "sequences";
  // "list" (the old separate tab) and anything else land on the board, which
  // now renders the kanban + the full lead list together.
  return "board";
}

const VALID_STATUSES: LeadStatus[] = [
  "warm_lead", "booked", "showed", "no_show", "contract", "success", "lost"
];

function parseStatus(raw: string | string[] | undefined): LeadStatus | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return null;
  return (VALID_STATUSES as string[]).includes(v) ? (v as LeadStatus) : null;
}

// Source filter = a typeform form id, or null for "all sources". Unknown ids
// just produce an empty flow roll-up, so we pass the raw value straight through.
function parseSource(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || v === "all") return null;
  return v;
}

interface GroupRow {
  lead: OutboundLead;
  nextMessage: ScheduledMessage | null;
}
interface Group {
  formId: string | null;
  label: string;
  description: string | null;
  // Whether this form auto-enrolls submissions in the Recovery drip.
  // Unknown / legacy buckets default true (the webhook enrolls them).
  enrollInFlow: boolean;
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
      enrollInFlow: f.enrollInFlow,
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
      enrollInFlow: true,
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
      enrollInFlow: true,
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

// Board / Flow board / Sequences switch, styled like the status chips.
function ViewToggle({ active }: { active: View }) {
  const tabs = [
    { key: "board", label: "Board", Icon: LayoutGrid },
    { key: "flow", label: "Flow board", Icon: Shuffle },
    { key: "sequences", label: "Sequences", Icon: GitBranch }
  ] as const;
  return (
    <div className="inline-flex rounded-full border border-slate-200 bg-white p-0.5">
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <Link
            key={t.key}
            href={`/outbound-dashboard/leads?view=${t.key}`}
            className={cn(
              "px-3 py-1.5 rounded-full text-[12.5px] inline-flex items-center gap-1.5 transition-colors",
              isActive ? "bg-ink text-white shadow-sm" : "text-ink/65 hover:bg-slate-50"
            )}
          >
            <t.Icon className="w-3.5 h-3.5" />
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}

const SUBTITLES: Record<View, string> = {
  board: "Your sales pipeline as a board — drag a lead between stages to update it. Scroll down for the full lead list grouped by Typeform source, or switch views for the texting flows.",
  flow: "Each lead's active SMS sequence. Drag between Recovery and Engagement, or pull a lead out of Booking into a drip. (Booking itself is set when a Calendly meeting is booked.)",
  sequences: "Every step in every texting sequence, with live counts and the lead names currently queued. Click a queued lead to jump to their detail page."
};

// The lead-centric board wears the fuchsia "Leads" identity; the two
// flow-centric views wear the indigo "Flows" identity, so the merged tab
// stays visually self-labeling as you switch.
function Hero({ view }: { view: View }) {
  const isFlow = view === "flow" || view === "sequences";
  return (
    <PageHero
      density="compact"
      eyebrow={isFlow ? "Funnel · Flows" : "Funnel · Leads"}
      headline={["Outbound ", { accent: isFlow ? "flows" : "leads" }]}
      subtitle={SUBTITLES[view]}
      icon={isFlow ? <GitBranch /> : <UsersIcon />}
      iconTone={isFlow ? "indigo" : "fuchsia"}
    />
  );
}

export default async function OutboundLeadsPage({
  searchParams
}: {
  searchParams: Promise<{ view?: string; status?: string; source?: string }>;
}) {
  const sp = await searchParams;
  const view = parseView(sp.view);

  // ---- Sequences view (the original flow-centric texting view) ----
  if (view === "sequences") {
    const sourceFilter = parseSource(sp.source);
    const [buckets, templates, forms] = await Promise.all([
      getFlowsOverview(sourceFilter),
      loadTemplateMap(),
      listForms()
    ]);
    return (
      <div className="space-y-4 max-w-[1400px] mx-auto">
        <Hero view={view} />
        <ViewToggle active="sequences" />
        <div className="flex items-center justify-end gap-2">
          <OutboundSourceSelect forms={forms} value={sourceFilter ?? "all"} />
          <AddLeadButton />
          <OutboundTypeformFormsDrawer initialForms={forms} unknownFormIds={[]} />
        </div>
        <OutboundFlowsView buckets={buckets} templates={templates} />
      </div>
    );
  }

  // ---- Flow board view (drag leads between SMS sequences) ----
  if (view === "flow") {
    const [flowGroups, forms] = await Promise.all([getLeadsByFlow(), listForms()]);
    const cards = [...flowGroups.booking, ...flowGroups.recovery, ...flowGroups.engagement];
    // Surface unregistered sources seen on the queued cards so the Manage-forms
    // badge mirrors the Board view (which derives the same from its lead pull).
    const flowCatalogIds = new Set(forms.map((f) => f.id));
    const unknownFormIds = [
      ...new Set(
        cards
          .map((c) => c.typeformFormId)
          .filter((x): x is string => !!x && !flowCatalogIds.has(x))
      )
    ];
    return (
      <div className="space-y-4 max-w-7xl mx-auto">
        <Hero view={view} />
        <ViewToggle active="flow" />
        <div className="flex items-center justify-end gap-2">
          <AddLeadButton />
          <OutboundTypeformFormsDrawer initialForms={forms} unknownFormIds={unknownFormIds} />
        </div>
        {cards.length === 0 ? <NoLeadsHint /> : <OutboundSequenceBoard cards={cards} forms={forms} />}
      </div>
    );
  }

  // ---- Board view (default — stage kanban on top, full lead list below) ----
  // The board shows the whole active pipeline at once, so it pulls a wider page
  // (up to 500) than the list section's status-filtered 100. The status filter
  // (?status=) narrows only the list below; the board always shows every stage.
  const statusFilter = parseStatus(sp.status);
  const [counts, boardPage, listPage, forms] = await Promise.all([
    getLeadStatusCounts(),
    listLeads({ status: null, limit: 500 }),         // board: whole pipeline
    listLeads({ status: statusFilter, limit: 100 }), // list: status-filtered
    listForms()
  ]);

  // Board — all stages, no per-lead "next touch" fetch (the board is about
  // stage, and fanning out a query per lead doesn't scale).
  const boardLeads = boardPage.rows;
  const catalogIds = new Set(forms.map((f) => f.id));
  const unknownFormIds = [
    ...new Set(
      boardLeads
        .map((l) => l.typeformFormId)
        .filter((x): x is string => !!x && !catalogIds.has(x))
    )
  ];

  // List — pull the next pending scheduled message per lead. Capped at 100 so
  // the fanout stays cheap.
  const nextMessages = await Promise.all(
    listPage.rows.map((l) => getNextScheduledMessage(l.id))
  );
  const tableRows: GroupRow[] = listPage.rows.map((lead, i) => ({
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
  // buildGroups also returns unknownFormIds, but we feed the drawer the board's
  // superset (500 leads) value instead.
  const { groups } = buildGroups(tableRows, forms);

  const showEmptyHint = boardLeads.length === 0;

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <Hero view="board" />
      <ViewToggle active="board" />
      <OutboundFunnelStrip counts={counts} />

      {/* Board (top) */}
      <div className="flex items-center justify-end gap-2">
        <AddLeadButton forms={forms} />
        <OutboundTypeformFormsDrawer
          initialForms={forms}
          unknownFormIds={unknownFormIds}
        />
      </div>
      {showEmptyHint && <NoLeadsHint />}
      <OutboundLeadsBoard leads={boardLeads} forms={forms} />

      {/* List (scroll down) — the status filter applies to this section only */}
      <div className="pt-4 border-t border-slate-200">
        <StatusFilterBar counts={counts} active={statusFilter} />
      </div>
      <OutboundLeadsByForm
        groups={groups}
        statusFilter={statusFilter}
        forms={forms}
      />
    </div>
  );
}
