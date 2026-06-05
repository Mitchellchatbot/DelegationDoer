"use client";

import Link from "next/link";
import { Activity, ArrowRight, CheckCircle2 } from "lucide-react";
import { Tooltip } from "@/components/Tooltip";
import { HEALTH_META } from "@/lib/client-health";
import type { ClientSentimentHealthRow } from "@/lib/home-data";
import { cn } from "@/lib/utils";

// Hero card on /home for every role: the 10 sites that need attention
// most, ranked by sentiment-based health (median email satisfaction).
// Different from the touchpoint dashboard — this is "how is the
// conversation reading", not "how long since we replied".
//
// Visual goal: calm and scannable, not alarming. The default palette
// is neutral slate, with each row's health pill carrying the only
// color signal. Empty state ("all clear") is a quiet success message
// rather than a hidden card so the dashboard's anchor doesn't move.

export function HomeClientHealthTable({ rows }: { rows: ClientSentimentHealthRow[] }) {
  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <div className="text-[13px] font-semibold inline-flex items-center gap-2">
          <Activity className="w-4 h-4 text-slate-500" />
          Sites needing attention
          <Tooltip label="Bottom 10 active clients by median email satisfaction. Reflects conversation tone in recent emails, not how recently we replied.">
            <span className="text-[11px] text-ink/55 font-normal tabular-nums">
              · {rows.length}
            </span>
          </Tooltip>
        </div>
        <Link
          href="/clients"
          className="text-[11px] font-medium text-accent hover:underline inline-flex items-center gap-0.5"
        >
          All clients <ArrowRight className="w-3 h-3" />
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-[12px] text-ink/55 inline-flex items-center justify-center gap-1.5 w-full">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          All clear — nothing reading as at-risk right now.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((r, i) => {
            const meta = HEALTH_META[r.label];
            return (
              <li key={r.id}>
                <Link
                  href={`/clients/${encodeURIComponent(r.id)}`}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50/70 transition-colors"
                >
                  <span className="text-[11px] tabular-nums text-ink/45 font-semibold w-5 shrink-0 text-right">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-ink truncate">
                      {r.name}
                    </div>
                    {r.summary && (
                      <div className="text-[11px] text-ink/55 truncate">
                        {r.summary}
                      </div>
                    )}
                  </div>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border shrink-0",
                      meta.bg, meta.text, meta.border,
                      r.overridden && "ring-1 ring-inset ring-ink/25"
                    )}
                    title={r.overridden ? "Health set by hand by a leader" : undefined}
                  >
                    <span className={cn("w-1.5 h-1.5 rounded-full", meta.dot)} />
                    {meta.label}
                  </span>
                  <span
                    className="text-[11px] tabular-nums font-semibold text-ink/70 w-8 text-right shrink-0"
                    title={r.score === null ? "Set manually — no satisfaction score yet" : `${r.sampleSize} scored emails`}
                  >
                    {r.score ?? "—"}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
