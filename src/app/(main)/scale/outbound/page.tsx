import { notFound, redirect } from "next/navigation";
import { ExternalLink, Megaphone } from "lucide-react";
import { getCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { isOwner } from "@/lib/access";
import { META_OUTBOUND_APP } from "@/components/multitask/multitask-apps";
import { MetaOutboundFrame } from "@/components/MetaOutboundFrame";
import { ScaleTabs } from "@/components/ScaleTabs";

export const dynamic = "force-dynamic";

// The Scale Room's Outbound tab: our pipeline and our Meta ad account, live
// from the Meta ads dashboard (see MetaOutboundFrame). Same owner-only 404
// gate as /scale. The framed page enforces its own agency-admin gate, and its
// Ads view its finance-staff one, whoever opens it.
export default async function ScaleOutboundPage() {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/login");
  const user = await getUserById(userId);
  if (!isOwner(user)) notFound();

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
              Live from the Meta ads dashboard. Texts, Board and Table are the pipeline; Ads is our ad account
              month by month, with spend, campaigns, cost per lead and cost per booked.
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

      <MetaOutboundFrame />
    </div>
  );
}
