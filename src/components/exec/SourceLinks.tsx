import Link from "next/link";
import { Globe, Hash, LayoutDashboard, Mail, Video, type LucideIcon } from "lucide-react";
import type { SourceRef, SourceSystem } from "@/lib/exec/types";
import { safeLink } from "@/lib/exec/safe-markdown";
import { pluralize } from "@/lib/exec/format";
import { cn } from "@/lib/utils";

// The records behind an item, as chips. A link comes only from ref.url, which
// refs.ts already allowlisted; it is checked again here because these refs are
// read back from the database. A ref with no usable url shows its label as
// plain text. A DD link opens in place (on whichever DD host he is signed in
// on); Outlook and Slack open in a new tab.

const SYSTEM_META: Readonly<Record<SourceSystem, { label: string; Icon: LucideIcon }>> = {
  dd: { label: "DD", Icon: LayoutDashboard },
  outlook: { label: "Outlook", Icon: Mail },
  slack: { label: "Slack", Icon: Hash },
  meeting: { label: "Meeting", Icon: Video },
  web: { label: "Web", Icon: Globe }
};

const CHIP =
  "inline-flex max-w-[18rem] items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600";

function SourceChip({ source }: { source: SourceRef }) {
  // A system this build doesn't know is named as stored, never relabeled.
  const { Icon, label } = SYSTEM_META[source.system] ?? { label: String(source.system), Icon: Globe };
  const body = (
    <>
      <Icon className="h-3 w-3 shrink-0 text-slate-400" aria-hidden />
      <span className="sr-only">{label}: </span>
      <span className="truncate">{source.label}</span>
    </>
  );
  const link = safeLink(source.url);
  if (!link) {
    return (
      <span className={cn(CHIP, "text-slate-500")} title={source.label}>
        {body}
      </span>
    );
  }
  // P9 F25: a link chip is a 40 px tap target below sm.
  const linkClass = cn(CHIP, "min-h-10 transition-colors hover:border-slate-300 hover:text-ink sm:min-h-0");
  if (link.external) {
    return (
      <a href={link.href} target="_blank" rel="noopener noreferrer" className={linkClass} title={source.label}>
        {body}
      </a>
    );
  }
  // prefetch off: a feed can hold dozens of these, and each prefetch would
  // render a DD page on the server for a click that may never come.
  return (
    <Link href={link.href} prefetch={false} className={linkClass} title={source.label}>
      {body}
    </Link>
  );
}

/**
 * Chips for `refs`, the first `max` inline and the rest behind a native
 * disclosure, so every ref stays reachable without JS. Renders nothing for an
 * empty list.
 */
export function SourceLinks({
  refs,
  max = 6,
  className
}: {
  refs: readonly SourceRef[];
  max?: number;
  className?: string;
}) {
  if (refs.length === 0) return null;
  const limit = Math.max(1, Math.floor(max));
  const shown = refs.slice(0, limit);
  const rest = refs.slice(limit);
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {shown.map((source, i) => (
        <SourceChip key={`${source.system}:${source.id}:${i}`} source={source} />
      ))}
      {rest.length > 0 && (
        <details className="open:basis-full">
          <summary className="inline-flex min-h-10 cursor-pointer list-none items-center rounded-full px-2 py-0.5 text-[11px] font-medium text-muted hover:text-ink sm:min-h-0 [&::-webkit-details-marker]:hidden">
            {`+${pluralize(rest.length, "more source")}`}
          </summary>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {rest.map((source, i) => (
              <SourceChip key={`${source.system}:${source.id}:${limit + i}`} source={source} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
