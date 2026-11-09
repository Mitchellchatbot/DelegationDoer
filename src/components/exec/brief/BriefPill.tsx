import Link from "next/link";
import type { BriefPillView } from "@/lib/exec/brief-view";
import { cn } from "@/lib/utils";

// The header's brief pill (P8 contract §3.17.3, C42): "Brief 8:02 AM EST · live", next to "Private". The words come from
// brief-view.ts (BRIEF_COPY.pill); the tone says whether the morning went as planned. A server component: no hooks.

const TONE: Readonly<Record<BriefPillView["state"], string>> = {
  delivered: "border-emerald-200 bg-emerald-50 text-emerald-800",
  page_only: "border-slate-200 bg-slate-50 text-slate-700",
  building: "border-indigo-200 bg-indigo-50 text-indigo-800",
  built: "border-indigo-200 bg-indigo-50 text-indigo-800",
  delivering: "border-indigo-200 bg-indigo-50 text-indigo-800",
  delivery_unknown: "border-amber-200 bg-amber-50 text-amber-800",
  failed: "border-rose-200 bg-rose-50 text-rose-700",
  none: "border-slate-200 bg-white text-slate-600",
  off: "border-slate-200 bg-white text-slate-500",
  not_installed: "border-slate-200 bg-white text-slate-500"
};

export function BriefPill({ pill }: { pill: BriefPillView }) {
  return (
    <Link
      href="/executive/brief"
      prefetch={false}
      data-brief-pill={pill.state}
      className={cn(
        "inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold tabular-nums leading-4 transition-colors hover:border-slate-300",
        TONE[pill.state] ?? TONE.none
      )}
    >
      <span className="truncate">{pill.label}</span>
    </Link>
  );
}
