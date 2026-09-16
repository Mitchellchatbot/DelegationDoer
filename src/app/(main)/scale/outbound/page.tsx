import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { ExternalLink, Megaphone } from "lucide-react";
import { getCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";
import { META_OUTBOUND_APP } from "@/components/multitask/multitask-apps";
import { OutboundTab, type OutboundView } from "@/components/OutboundTab";
import { ScaleTabs } from "@/components/ScaleTabs";
import { getOutboundBoard } from "@/lib/outbound-board";
import { getOutboundMeta, metaDays } from "@/lib/outbound-meta";
import { getScaleSources } from "@/lib/scale-sources";

export const dynamic = "force-dynamic";

// The Scale Room's Outbound tab: our pipeline and our Meta ad account from the
// Meta ads dashboard — rendered here (Pipeline, Ads) from its
// /api/outbound/board, plus that dashboard's own page framed (Live board) for
// working the leads. Same owner-only 404 gate as /scale; the framed page
// enforces its own agency-admin gate, and its Ads view its finance-staff one.
const VIEWS: OutboundView[] = ["meta", "pipeline", "ads", "live"];

export default async function ScaleOutboundPage({
  searchParams
}: {
  searchParams?: { view?: string | string[]; days?: string | string[] };
}) {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/login");
  const user = await getUserById(userId);
  if (!isOwner(user)) notFound();

  // ?view= and ?days= keep a Meta ads date-range change on the Meta ads view.
  const days = metaDays(searchParams?.days);
  const rawView = Array.isArray(searchParams?.view) ? searchParams?.view[0] : searchParams?.view;
  const view = VIEWS.find((v) => v === rawView) ?? null;

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

      {/* Streams in on its own: the board read covers every prospect plus
          Finance's ledger, and the header shouldn't wait on it. */}
      {/* Keyed by range, so switching 7d/14d/30d/90d shows the loading line
          instead of the old range's numbers while Meta is read. */}
      <Suspense key={days} fallback={<div className="text-[12.5px] text-muted px-1">Loading from the Meta ads dashboard…</div>}>
        <OutboundTabSection days={days} view={view} />
      </Suspense>
    </div>
  );
}

// Honours the Scale Room's Outbound source switch the way /scale does: off
// means not fetched at all. The Live board is still offered — it reads nothing
// on DD's side.
async function OutboundTabSection({ days, view }: { days: ReturnType<typeof metaDays>; view: OutboundView | null }) {
  const sources = await getScaleSources();
  // All reads in parallel; each fails on its own into its own view. The
  // engagement row always shows 7d and 30d figures (as the Meta ads dashboard
  // does), so a shorter range also reads the last 30 days for it.
  const [result, meta, meta30] = sources.outbound
    ? await Promise.all([getOutboundBoard(), getOutboundMeta(days), days < 30 ? getOutboundMeta(30) : null])
    : [null, null, null];
  const engagementDaily = meta30?.ok ? meta30.data.daily : meta?.ok ? meta.data.daily : null;
  return (
    <OutboundTab
      result={result}
      sourceOff={!sources.outbound}
      meta={meta}
      metaDays={days}
      engagementDaily={engagementDaily}
      initialView={view}
    />
  );
}
