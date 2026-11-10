import Link from "next/link";
import type { BriefPillView } from "@/lib/exec/brief-view";
import { cn } from "@/lib/utils";

// The header's brief pill (P8 contract §3.17.3, C42): "Brief 8:02 AM EST · live", next to "Private". The words come from
// brief-view.ts (BRIEF_COPY.pill); the tone says whether the morning went as planned. A server component: no hooks.

export const TONE: Readonly<Record<BriefPillView["state"], string>> = {
  delivered: "border-emerald-200 bg-emerald-50 text-emerald-800",
  page_only: "border-slate-200 bg-slate-50 text-slate-700",
  building: "border-indigo-200 bg-indigo-50 text-indigo-800",
  built: "border-indigo-200 bg-indigo-50 text-indigo-800",
  delivering: "border-indigo-200 bg-indigo-50 text-indigo-800",
  delivery_unknown: "border-amber-200 bg-amber-50 text-amber-800",
  failed: "border-rose-200 bg-rose-50 text-rose-700",
  none: "border-slate-200 bg-white text-slate-600",
  off: "border-slate-200 bg-white text-slate-500",
  not_installed: "border-slate-200 bg-white text-slate-500",
  // P9 F31 (seed S1): the brief was due over 45 minutes ago and hasn't started: amber, like delivery_unknown.
  late: "border-amber-200 bg-amber-50 text-amber-800"
};

export function BriefPill({ pill }: { pill: BriefPillView }) {
  return (
    <Link
      href="/executive/brief"
      prefetch={false}
      data-brief-pill={pill.state}
      className={cn(
        // P9 F25: a 40 px tap target below sm (it was about 22 px); unchanged from sm up.
        "inline-flex min-h-10 max-w-full items-center rounded-full border px-3 py-0.5 text-[11px] font-semibold tabular-nums leading-4 transition-colors hover:border-slate-300 sm:min-h-0 sm:px-2 sm:text-[10.5px]",
        TONE[pill.state] ?? TONE.none
      )}
    >
      <span className="truncate">{pill.label}</span>
    </Link>
  );
}
