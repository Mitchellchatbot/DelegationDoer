"use client";

import Link from "next/link";
import { HeartPulse, ArrowRight } from "lucide-react";
import { Tooltip } from "@/components/Tooltip";
import { HEALTH_META } from "@/lib/client-health";
import type { ClientSentimentHealthRow } from "@/lib/home-data";
import { cn } from "@/lib/utils";

// /home card: top clients by sentiment-based health (median email
// satisfaction). Distinct from the touchpoint dashboard — this is the
// "how are recent conversations *reading*" view, not "how long since
// we emailed". Hidden when there's no scored data yet so we don't
// render an empty card on fresh accounts.
export function HomeTopClientsByHealth({ rows }: { rows: ClientSentimentHealthRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="rounded-2xl border border-rose-200/50 bg-gradient-to-br from-rose-50/60 via-white to-white shadow-soft overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-rose-100/60">
        <div className="text-[13px] font-semibold inline-flex items-center gap-2">
          <HeartPulse className="w-4 h-4 text-rose-500" />
          Top clients by health
          <Tooltip label="Ranked by the median satisfaction score of recent emails. Reflects conversation tone, not how recently we replied.">
            <span className="text-[11px] text-ink/55 font-normal tabular-nums">
              · {rows.length}
            </span>
          </Tooltip>
        </div>
        <Link
          href="/clients"
          className="text-[11px] font-medium text-rose-700 hover:text-rose-800 inline-flex items-center gap-0.5 hover:underline"
        >
          All clients <ArrowRight className="w-3 h-3" />
        </Link>
      </header>
      <ul className="divide-y divide-rose-100/50">
        {rows.map((r, i) => {
          const meta = HEALTH_META[r.label];
          return (
            <li key={r.id}>
              <Link
                href={`/clients/${encodeURIComponent(r.id)}`}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-rose-50/40 transition-colors"
              >
                <span className="text-[11px] tabular-nums text-ink/45 font-semibold w-5 shrink-0">
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
                    meta.bg, meta.text, meta.border
                  )}
                >
                  <span className={cn("w-1.5 h-1.5 rounded-full", meta.dot)} />
                  {meta.label}
                </span>
                <span className="text-[11px] tabular-nums font-semibold text-ink/70 w-8 text-right shrink-0">
                  {r.score}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
