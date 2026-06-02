"use client";

import Link from "next/link";
import { Hourglass, ArrowRight } from "lucide-react";
import { Tooltip } from "@/components/Tooltip";

// At-a-glance stalled-work tile on the leader home: a single big stat
// for "what's stuck" so the dashboard surfaces the work that needs a
// nudge. Previously paired with a posts-per-client bar chart in a
// two-up strip; the chart was retired, so this now stands on its own
// as a full-width card consistent with the rest of the stacked /home
// surface.

export function HomeChartsRow({
  stalledCount
}: {
  stalledCount: number;
}) {
  return (
    <section className="rounded-2xl border border-slate-200/70 bg-gradient-to-br from-slate-50 via-white to-white shadow-soft overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <div className="text-[13px] font-semibold inline-flex items-center gap-2">
          <Hourglass className="w-4 h-4 text-slate-500" />
          Stalled work
        </div>
        <Link
          href="/tasks/board"
          className="text-[11px] font-medium text-accent inline-flex items-center gap-0.5 hover:underline"
        >
          Board <ArrowRight className="w-3 h-3" />
        </Link>
      </header>
      <div className="flex items-center justify-between gap-4 px-6 py-5">
        <div className="flex items-baseline gap-3">
          <div className="text-5xl font-bold text-slate-800 tabular-nums leading-none">
            {stalledCount}
          </div>
          <div className="text-[12px] text-ink/60 max-w-[16rem]">
            assigned tasks with no activity in 7+ days
          </div>
        </div>
        <Tooltip label="Each row in this count appears individually under What's moving → Tasks → Stalled.">
          <Link
            href="/tasks/board?filter=stalled"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
          >
            See the list <ArrowRight className="w-3 h-3" />
          </Link>
        </Tooltip>
      </div>
    </section>
  );
}
