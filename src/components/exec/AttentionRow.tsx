import Link from "next/link";
import { FilePen, Hash, Inbox, LayoutDashboard, Lightbulb, Mail, type LucideIcon } from "lucide-react";
import type { AttentionItem, AttentionSource, PriorityBand } from "@/lib/exec/attention-types";
import { ageLabel, formatInZone } from "@/lib/exec/format";
import { cn } from "@/lib/utils";
import { CategoryBadge } from "./CategoryBadge";
import { FactList } from "./FactList";
import { PriorityBandBadge } from "./PriorityBandBadge";
import { SourceLinks } from "./SourceLinks";

// One Needs Attention item, read-only (the actions arrive in P5). Facts and
// the suggestion are kept visibly apart: facts carry basis labels and sources,
// and the recommended next step always sits under its own "Suggested" label,
// so it can't be read as something that happened. Every string is React text.

const SOURCE_META: Readonly<Record<AttentionSource, { label: string; Icon: LucideIcon }>> = {
  dd: { label: "DD", Icon: LayoutDashboard },
  email: { label: "Email", Icon: Mail },
  slack: { label: "Slack", Icon: Hash }
};

// The icon tile carries the band's color, so the feed scans by urgency.
const BAND_TILE: Readonly<Record<PriorityBand, string>> = {
  critical: "bg-rose-50 text-rose-700 ring-rose-200/70",
  high: "bg-amber-50 text-amber-700 ring-amber-200/70",
  normal: "bg-slate-100 text-slate-600 ring-slate-200/70"
};

function present(text: string | null | undefined): text is string {
  return typeof text === "string" && text.trim().length > 0;
}

/**
 * How old the item is. occurredAt is when the underlying thing happened; when
 * the producer couldn't tell, the age shown is since the assistant first saw
 * it, and says so.
 */
function Age({ item, now, tz }: { item: AttentionItem; now: Date | string; tz: string }) {
  const happened = present(item.occurredAt) ? item.occurredAt : null;
  const at = happened ?? item.firstSeenAt;
  const age = ageLabel(at, now);
  const when = formatInZone(at, tz, "datetime", now);
  return (
    <time dateTime={at} title={happened ? when : `First seen ${when}`} className="shrink-0 text-[11px] tabular-nums text-muted">
      {happened ? age : `first seen ${age}`}
    </time>
  );
}

export function AttentionRow({
  item,
  now,
  tz,
  draftReplyHref = null
}: {
  item: AttentionItem;
  now: Date | string;
  tz: string;
  /** P4 (Y9): a "Draft reply" link for an email item while drafts are on (AttentionFeed builds it). */
  draftReplyHref?: string | null;
}) {
  // A source this build doesn't know is named as stored, never passed off as DD.
  const { label: sourceLabel, Icon } = SOURCE_META[item.source] ?? { label: String(item.source), Icon: Inbox };
  const band = item.priority.band;
  return (
    <article className="flex gap-3 px-4 py-3.5">
      <span
        className={cn("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg ring-1", BAND_TILE[band] ?? BAND_TILE.normal)}
        title={sourceLabel}
      >
        <Icon className="h-4 w-4" aria-hidden />
        <span className="sr-only">{`Source: ${sourceLabel}`}</span>
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <PriorityBandBadge band={band} score={item.priority.score} reasons={item.priority.reasons} />
          <CategoryBadge category={item.category} />
          <span className="ml-auto">
            <Age item={item} now={now} tz={tz} />
          </span>
        </div>
        <h3 className="break-words text-[14px] font-semibold leading-snug text-ink">{item.title}</h3>
        {present(item.whatHappened) && (
          <p className="break-words text-[12.5px] leading-relaxed text-slate-600">{item.whatHappened}</p>
        )}
        {present(item.whyItMatters) && (
          <p className="break-words text-[12.5px] leading-relaxed text-slate-600">
            <span className="font-semibold text-slate-700">Why it matters: </span>
            {item.whyItMatters}
          </p>
        )}
        {present(item.recommendedNext) && (
          <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-2">
            <div className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide text-indigo-700">
              <Lightbulb className="h-3 w-3" aria-hidden />
              Suggested next step
            </div>
            <p className="mt-0.5 break-words text-[12.5px] leading-relaxed text-indigo-950">{item.recommendedNext}</p>
          </div>
        )}
        <FactList facts={item.facts} />
        <SourceLinks refs={item.refs} />
        {draftReplyHref && (
          <Link
            href={draftReplyHref}
            prefetch={false}
            data-draft-reply
            className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-white px-2 py-0.5 text-[11.5px] font-semibold text-indigo-700 hover:border-indigo-300 hover:text-indigo-900"
          >
            <FilePen className="h-3 w-3" aria-hidden />
            Draft reply
          </Link>
        )}
      </div>
    </article>
  );
}
