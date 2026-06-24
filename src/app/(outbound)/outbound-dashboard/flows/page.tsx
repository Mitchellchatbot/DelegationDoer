import { GitBranch, LayoutGrid, Shuffle } from "lucide-react";
import Link from "next/link";
import { PageHero } from "@/components/PageHero";
import {
  getFlowsOverview, loadTemplateMap, getLeadStatusCounts, listLeads, getLeadsByFlow
} from "@/lib/outbound-leads";
import { listForms } from "@/lib/outbound-typeform-forms";
import { OutboundFlowsView } from "@/components/OutboundFlowsView";
import { OutboundFunnelStrip } from "@/components/OutboundFunnelStrip";
import { OutboundLeadsBoard } from "@/components/OutboundLeadsBoard";
import { OutboundSequenceBoard } from "@/components/OutboundSequenceBoard";
import { OutboundTypeformFormsDrawer } from "@/components/OutboundTypeformFormsDrawer";
import { NoLeadsHint } from "@/components/OutboundLeadsTable";
import { cn } from "@/lib/utils";

// /outbound-dashboard/flows — three views, toggled via ?view=:
//   - "board" (default): Notion-style kanban of the sales pipeline. One column
//     per stage; drag a lead between columns to update its stage.
//   - "flow": Notion-style kanban of the SMS nurture sequences. One column per
//     sequence (Booking / Recovery / Engagement); drag a lead between drips.
//   - "sequences": the flow-centric texting view — every step in every SMS
//     sequence with live counts and the leads queued at each.
//
// Auth + cohort gate live in the (outbound) layout.

export const dynamic = "force-dynamic";
export const revalidate = 0;

type FlowsView = "board" | "flow" | "sequences";

function parseView(raw: string | string[] | undefined): FlowsView {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === "flow") return "flow";
  if (v === "sequences") return "sequences";
  return "board";
}

// Board / Flow board / Sequences switch, styled like the status chips.
function ViewToggle({ active }: { active: FlowsView }) {
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
            href={`/outbound-dashboard/flows?view=${t.key}`}
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

const SUBTITLES: Record<FlowsView, string> = {
  board: "Your sales pipeline as a board — drag a lead between stages to update it. Filter by Typeform source up top, or switch views for the texting flows.",
  flow: "Each lead's active SMS sequence. Drag between Recovery and Engagement, or pull a lead out of Booking into a drip. (Booking itself is set when a Calendly meeting is booked.)",
  sequences: "Every step in every texting sequence, with live counts and the lead names currently queued. Click a queued lead to jump to their detail page."
};

export default async function OutboundFlowsPage({
  searchParams
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const sp = await searchParams;
  const view = parseView(sp.view);

  const hero = (
    <PageHero
      eyebrow="Funnel · Flows"
      headline={["Outbound ", { accent: "flows" }]}
      subtitle={SUBTITLES[view]}
      icon={<GitBranch />}
      iconTone="indigo"
    />
  );

  // ---- Sequences view (the original flow-centric texting view) ----
  if (view === "sequences") {
    const [buckets, templates] = await Promise.all([
      getFlowsOverview(),
      loadTemplateMap()
    ]);
    return (
      <div className="space-y-4 max-w-[1400px] mx-auto">
        {hero}
        <ViewToggle active="sequences" />
        <OutboundFlowsView buckets={buckets} templates={templates} />
      </div>
    );
  }

  // ---- Flow board view (drag leads between SMS sequences) ----
  if (view === "flow") {
    const [flowGroups, forms] = await Promise.all([getLeadsByFlow(), listForms()]);
    const cards = [...flowGroups.booking, ...flowGroups.recovery, ...flowGroups.engagement];
    return (
      <div className="space-y-4 max-w-7xl mx-auto">
        {hero}
        <ViewToggle active="flow" />
        {cards.length === 0 ? <NoLeadsHint /> : <OutboundSequenceBoard cards={cards} forms={forms} />}
      </div>
    );
  }

  // ---- Board view (default — stage kanban) ----
  // The board shows the whole active pipeline at once — pull a wider page than
  // the leads table's 100. No per-lead "next touch" fetch: the board is about
  // stage, and fanning out a query per lead doesn't scale.
  const [counts, leadsPage, forms] = await Promise.all([
    getLeadStatusCounts(),
    listLeads({ status: null, limit: 500 }),
    listForms()
  ]);
  const boardLeads = leadsPage.rows;
  const catalogIds = new Set(forms.map((f) => f.id));
  const unknownFormIds = [
    ...new Set(
      boardLeads
        .map((l) => l.typeformFormId)
        .filter((x): x is string => !!x && !catalogIds.has(x))
    )
  ];
  const showEmptyHint = boardLeads.length === 0;

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      {hero}
      <OutboundFunnelStrip counts={counts} />
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <ViewToggle active="board" />
        <OutboundTypeformFormsDrawer
          initialForms={forms}
          unknownFormIds={unknownFormIds}
        />
      </div>
      {showEmptyHint && <NoLeadsHint />}
      <OutboundLeadsBoard leads={boardLeads} forms={forms} />
    </div>
  );
}
