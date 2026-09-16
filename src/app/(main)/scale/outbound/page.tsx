import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { ExternalLink, Megaphone } from "lucide-react";
import { getCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";
import { META_OUTBOUND_APP } from "@/components/multitask/multitask-apps";
import {
  OutboundMonthlySpendView,
  OutboundPipelineView,
  OutboundTab,
  type OutboundView
} from "@/components/OutboundTab";
import { OutboundMetaDashboard } from "@/components/OutboundMetaDashboard";
import { ScaleTabs } from "@/components/ScaleTabs";
import { getOutboundBoard } from "@/lib/outbound-board";
import { getOutboundMeta, metaDays } from "@/lib/outbound-meta";
import type { MetaDays } from "@/lib/outbound-meta-types";
import { cache } from "@/lib/safe-cache";
import { getScaleSources } from "@/lib/scale-sources";

export const dynamic = "force-dynamic";

// The Scale Room's Outbound tab: our pipeline and our Meta ad account from the
// Meta ads dashboard — rendered here (Pipeline, Ads) from its
// /api/outbound/board, plus that dashboard's own page framed (Live board) for
// working the leads. Same owner-only 404 gate as /scale; the framed page
// enforces its own agency-admin gate, and its Ads view its finance-staff one.
const VIEWS: OutboundView[] = ["meta", "pipeline", "ads", "live"];

// One board read per request: the Pipeline and Monthly spend slots both come
// from it, and stream in the same response.
const readBoard = cache(() => getOutboundBoard());

export default async function ScaleOutboundPage({
  searchParams
}: {
  searchParams?: { view?: string | string[]; days?: string | string[] };
}) {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/login");
  const user = await getUserById(userId);
  if (!isOwner(user)) notFound();

  // ?view= and ?days= keep a Meta ads date-range change on the Meta ads view
  // (and the tab writes ?view= as you switch, so a reload stays put).
  const days = metaDays(searchParams?.days);
  const rawView = Array.isArray(searchParams?.view) ? searchParams?.view[0] : searchParams?.view;
  const view = VIEWS.find((v) => v === rawView) ?? null;

  // Honours the Scale Room's Outbound source switch the way /scale does: off —
  // or unreadable, which getScaleSources reports as off with a reason — means
  // nothing is read from the Meta ads dashboard, so no data slot is even built.
  // The Live board is still offered; it reads nothing on DD's side. A single
  // settings row, so it's awaited here rather than holding up a slot.
  const sources = await getScaleSources();
  const on = sources.outbound;

  // Each view streams in on its own, so the switcher and the Live board are
  // usable at once and a slow Meta read never holds up the pipeline (or the
  // other way round). The views are server-rendered here and handed to the
  // client tab as slots; it only picks which one shows.
  const metaSlot = on ? (
    // Keyed by range, so switching 7d/14d/30d/90d shows the loading line
    // instead of the old range's numbers while Meta is read.
    <Suspense key={days} fallback={<Loading>Loading our ad account from the Meta ads dashboard…</Loading>}>
      <MetaSection days={days} />
    </Suspense>
  ) : null;
  const pipelineSlot = on ? (
    <Suspense fallback={<Loading>Loading the pipeline from the Meta ads dashboard…</Loading>}>
      <PipelineSection />
    </Suspense>
  ) : null;
  const monthlySlot = on ? (
    <Suspense fallback={<Loading>Loading monthly spend from the Meta ads dashboard…</Loading>}>
      <MonthlySection />
    </Suspense>
  ) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-2xl bg-indigo-100 text-indigo-700 grid place-items-center shrink-0">
            <Megaphone className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700">Scale Room</div>
            <h1 className="text-2xl font-bold text-ink leading-tight">Outbound</h1>
            <p className="text-sm text-muted mt-0.5 max-w-prose">
              From the Meta ads dashboard. Meta ads is our ad account laid out like a client&apos;s Dashboard; Pipeline is
              every prospect by stage with the reps&apos; queues; Monthly spend is Finance&apos;s ledger by month; Live board is
              the dashboard itself, for texting and moving leads.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ScaleTabs active="outbound" />
          <a
            href={META_OUTBOUND_APP.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[12.5px] font-semibold text-muted shadow-soft hover:text-ink transition-colors"
          >
            Open in new tab
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>

      <OutboundTab
        initialView={view}
        sourceOff={!on}
        sourceReadError={sources.readError}
        metaSlot={metaSlot}
        pipelineSlot={pipelineSlot}
        monthlySlot={monthlySlot}
      />
    </div>
  );
}

function Loading({ children }: { children: React.ReactNode }) {
  return <div className="text-[12.5px] text-muted px-1">{children}</div>;
}

// Both reads in parallel. The engagement row always shows 7d and 30d figures
// (as the Meta ads dashboard does), so a shorter range also reads the last 30
// days for it.
async function MetaSection({ days }: { days: MetaDays }) {
  const [meta, meta30] = await Promise.all([getOutboundMeta(days), days < 30 ? getOutboundMeta(30) : null]);
  const engagementDaily = meta30?.ok ? meta30.data.daily : meta.ok ? meta.data.daily : null;
  return <OutboundMetaDashboard result={meta} days={days} engagementDaily={engagementDaily} />;
}

// Each board slot is handed only the part of the board its view reads. Both
// cross into client components in the same response, so passing the whole
// board to each would send every prospect and every ledger month twice.
async function PipelineSection() {
  const r = await readBoard();
  return (
    <OutboundPipelineView
      result={
        r.ok
          ? { ok: true, data: { pipeline: r.data.pipeline, stages: r.data.stages, queues: r.data.queues, prospects: r.data.prospects } }
          : r
      }
    />
  );
}

async function MonthlySection() {
  const r = await readBoard();
  return <OutboundMonthlySpendView result={r.ok ? { ok: true, data: { ads: r.data.ads } } : r} />;
}
