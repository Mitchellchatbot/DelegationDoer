import type { ReactNode } from "react";
import Link from "next/link";
import { FilePen, Hash, Inbox, LayoutDashboard, Lightbulb, Mail, type LucideIcon } from "lucide-react";
import type { AttentionItem, AttentionSource, PriorityBand } from "@/lib/exec/attention-types";
import { DDTEXT_AI_KINDS } from "@/lib/exec/ddtext-types";
import { ageLabel, formatInZone } from "@/lib/exec/format";
import { cn } from "@/lib/utils";
import { BasisLabel } from "./BasisLabel";
import { CategoryBadge } from "./CategoryBadge";
import { FactList } from "./FactList";
import { BAND_META, PriorityBandBadge } from "./PriorityBandBadge";
import { SourceLinks } from "./SourceLinks";

// One Needs Attention item. Facts and the suggestion are kept visibly apart:
// facts carry basis labels and sources, and the recommended next step always
// sits under its own "Suggested" label, so it can't be read as something that
// happened. Every string is React text.
//
// It stays a server component with client-safe imports (P5a C24), so the
// client FeedList renders it too: the row's actions arrive through the
// `actions` slot (FeedList fills it only in a top-level window), the band's
// reasons can open in place (`reasonsDisclosure`), and P4's `draftReplyHref`
// stays the one Draft reply link. A DD text item whose substance is a model's
// reading (DDTEXT_AI_KINDS) carries a visible AI-assessed label beside its
// title, in the text and not only in a tooltip (a-correct-11).

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

const AI_KINDS: ReadonlySet<string> = new Set<string>(DDTEXT_AI_KINDS);

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

/** The band's score and every reason behind it, as a native disclosure (no JS needed to open it). */
function ReasonsDisclosure({ item }: { item: AttentionItem }) {
  const band = item.priority.band;
  const label = BAND_META[band]?.label ?? String(band);
  const score = item.priority.score;
  const reasons = item.priority.reasons ?? [];
  return (
    <details data-reasons className="text-[11.5px] text-slate-600">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-medium text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        {`Why ${label.toLowerCase()}`}
      </summary>
      <ul className="mt-1 space-y-0.5 border-l-2 border-slate-100 pl-2.5">
        {typeof score === "number" && Number.isFinite(score) && <li>{`Priority score ${score} of 100`}</li>}
        {reasons.map((reason, i) => (
          <li key={i} className="break-words">
            {reason}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function AttentionRow({
  item,
  now,
  tz,
  draftReplyHref = null,
  actions = null,
  reasonsDisclosure = false
}: {
  item: AttentionItem;
  now: Date | string;
  tz: string;
  /** P4 (Y9): a "Draft reply" link for an email item while drafts are on (AttentionFeed builds it). */
  draftReplyHref?: string | null;
  /** P5a (C24): the row's controls, after the sources. FeedList passes them only in a top-level window. */
  actions?: ReactNode;
  /** P5a (C24): show the band's score and reasons as an expandable list under the row. */
  reasonsDisclosure?: boolean;
}) {
  const aiAssessed = AI_KINDS.has(item.kind);
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
        {aiAssessed ? (
          <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
            <h3 className="min-w-0 break-words text-[14px] font-semibold leading-snug text-ink">{item.title}</h3>
            <BasisLabel basis="ai" />
          </div>
        ) : (
          <h3 className="break-words text-[14px] font-semibold leading-snug text-ink">{item.title}</h3>
        )}
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
        {reasonsDisclosure && <ReasonsDisclosure item={item} />}
        {actions}
      </div>
    </article>
  );
}
