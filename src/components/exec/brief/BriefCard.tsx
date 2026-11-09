import Link from "next/link";
import { ArrowRight, CircleSlash, Sparkles } from "lucide-react";
import { BRIEF_COPY } from "@/lib/exec/brief-copy";
import type { BriefCardView } from "@/lib/exec/brief-view";
import { formatInZone } from "@/lib/exec/format";
import { safeLink } from "@/lib/exec/safe-markdown";
import { cn } from "@/lib/utils";
import { BriefPill } from "./BriefPill";

// The Overview's brief card (P8 contract §3.17.2, C41): it takes TodayGlance's slot when today's brief exists (or, before
// today's brief time, yesterday's). Dark like TodayGlance. The headline, his top 3 (a withheld entry reads "[Removed: …]"
// with no link) and the brief's status line, all screened at render by brief-view.ts (C31); every string renders as React
// text. A server component: no hooks.

export function BriefCard({ view, tz, now }: { view: BriefCardView; tz: string; now: string }) {
  return (
    <section aria-labelledby="exec-brief-card-title" data-brief-card={view.localDate} className="rounded-2xl bg-slate-900 p-5 text-white shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id="exec-brief-card-title" className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          {BRIEF_COPY.pageTitle} · {formatInZone(view.localDate, tz, "date", now)}
        </h2>
        <BriefPill pill={view.pill} />
      </div>
      {/* P8 fixer ui-6: the card's headline and top 3 are model-written (or deterministic): say which, as the page does. */}
      {typeof view.modeLine === "string" && view.modeLine.length > 0 && (
        <p data-brief-mode={view.mode ?? "none"} className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-slate-400">
          {view.mode === "ai" ? <Sparkles className="h-3.5 w-3.5" aria-hidden /> : <CircleSlash className="h-3.5 w-3.5" aria-hidden />}
          {view.modeLine}
        </p>
      )}
      {view.headline !== null && (
        <p data-brief-headline className="mt-3 break-words text-[16px] font-semibold leading-snug text-white sm:text-[17px]">
          {view.headline}
        </p>
      )}
      {view.top3.length > 0 && (
        <div className="mt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{BRIEF_COPY.top3Title}</h3>
          <ol className="mt-2 space-y-2">
            {view.top3.map((t, i) => {
              const link = t.withheld ? null : safeLink(t.href);
              return (
                <li key={i} data-brief-top={t.withheld ? "withheld" : "shown"} className="flex items-baseline gap-2.5 text-[14px] leading-relaxed">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/10 text-[11px] font-semibold tabular-nums text-slate-200">
                    {i + 1}
                  </span>
                  <span className="min-w-0 break-words">
                    {link ? (
                      link.external ? (
                        <a href={link.href} target="_blank" rel="noopener noreferrer" className="font-medium text-white underline decoration-white/30 underline-offset-2 hover:decoration-white">
                          {t.title}
                        </a>
                      ) : (
                        <Link href={link.href} prefetch={false} className="font-medium text-white underline decoration-white/30 underline-offset-2 hover:decoration-white">
                          {t.title}
                        </Link>
                      )
                    ) : (
                      <span className={cn("font-medium", t.withheld ? "italic text-slate-400" : "text-slate-100")}>{t.title}</span>
                    )}
                    {t.next !== null && (
                      <span data-brief-next className="block text-[12.5px] text-slate-300">
                        <span className="font-semibold text-indigo-200">{BRIEF_COPY.suggested}: </span>
                        {t.next}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <p className="min-w-0 break-words text-[12px] text-slate-400">{view.statusLine}</p>
        <Link
          href="/executive/brief"
          prefetch={false}
          className="inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1 text-[12px] font-semibold text-white transition-colors hover:bg-white/20"
        >
          {BRIEF_COPY.openBrief}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
    </section>
  );
}
