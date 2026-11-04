import Link from "next/link";
import type { FactBasis } from "@/lib/exec/attention-types";
import { MISSING, formatCount } from "@/lib/exec/format";
import { safeLink } from "@/lib/exec/safe-markdown";
import { cn } from "@/lib/utils";
import { BasisLabel } from "./BasisLabel";
import { SPARK_COLOR, Sparkline } from "./Sparkline";

// A number tile (OutboundMetaDashboard's MetricCard and FunnelCell, server
// rendered). The real value is in the HTML: no count-up from 0 like
// StatCard, which reads as a false value before its script runs. An unknown
// value is "—", never 0.

export type StatTint = keyof typeof SPARK_COLOR;

// Literal class strings: Tailwind only emits classes it can read in source.
const TINT: Readonly<Record<StatTint, string>> = {
  indigo: "border-indigo-100 bg-indigo-50/60",
  emerald: "border-emerald-100 bg-emerald-50/60",
  teal: "border-teal-100 bg-teal-50/60",
  violet: "border-violet-100 bg-violet-50/60",
  amber: "border-amber-100 bg-amber-50/60",
  rose: "border-rose-100 bg-rose-50/60",
  sky: "border-sky-100 bg-sky-50/60",
  slate: "border-slate-200 bg-white"
};

const TONE = { good: "text-emerald-600", bad: "text-rose-600", warn: "text-amber-600", flat: "text-muted" } as const;

export type StatTone = keyof typeof TONE;

export function StatTile({
  label,
  value,
  sub,
  basis,
  delta,
  tint = "slate",
  series,
  seriesLabel,
  href
}: {
  label: string;
  /** null = unknown, shown as "—". Numbers go through formatCount; strings show as given ("6.5 h"). */
  value: number | string | null;
  /** One line under the value, e.g. "includes 4 auto-archived". */
  sub?: string;
  basis?: FactBasis;
  delta?: { text: string; tone: StatTone } | null;
  tint?: StatTint;
  /** Oldest first. Drawn only with two or more points. */
  series?: readonly number[];
  seriesLabel?: string;
  /** A DD page to open. Anything that isn't a DD path is ignored. */
  href?: string;
}) {
  const shown = typeof value === "number" ? formatCount(value) : value === null || value === "" ? MISSING : value;
  const link = href ? safeLink(href) : null;
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
        {basis && <BasisLabel basis={basis} />}
      </div>
      <div className="mt-2 text-[26px] font-bold leading-none tabular-nums text-ink">{shown}</div>
      {sub && <div className="mt-1 text-[11px] text-muted">{sub}</div>}
      {delta && <div className={cn("mt-1 text-[11px] font-medium", TONE[delta.tone])}>{delta.text}</div>}
      {series && <Sparkline data={series} color={SPARK_COLOR[tint]} label={seriesLabel} />}
    </>
  );
  const tileClass = cn("block min-w-0 rounded-2xl border p-4 shadow-soft", TINT[tint]);
  if (link && !link.external) {
    return (
      <Link href={link.href} prefetch={false} className={cn(tileClass, "transition-shadow hover:shadow-lift")}>
        {body}
      </Link>
    );
  }
  return <div className={tileClass}>{body}</div>;
}
