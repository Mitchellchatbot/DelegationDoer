"use client";

import Link from "next/link";
import { Sparkles, ArrowRight } from "lucide-react";
import { Tooltip } from "@/components/Tooltip";

export interface HomeSeoBriefRow {
  clientId: string;
  clientName: string;
  brief: string;             // truncated server-side to ~280 chars
  updatedAt: string | null;  // ISO
}

// /home card showing every active SEO brief leadership has set, for
// users in dep_seo. Each row is a tappable preview that opens the
// client detail page. Hidden when there are no briefs (no point in
// rendering "no briefs yet" for a feature most teams won't use).
export function HomeSeoBriefs({ rows }: { rows: HomeSeoBriefRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="rounded-2xl border border-emerald-200/60 bg-gradient-to-br from-emerald-50/70 via-white to-white shadow-soft overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-emerald-100/60">
        <div className="text-[13px] font-semibold inline-flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-emerald-600" />
          SEO briefs from leadership
          <Tooltip label="Clients where leadership has set a brief — what services or focus areas they want the SEO team prioritizing.">
            <span className="text-[11px] text-ink/55 font-normal tabular-nums">
              · {rows.length}
            </span>
          </Tooltip>
        </div>
        <Link
          href="/clients"
          className="text-[11px] font-medium text-emerald-700 hover:text-emerald-800 inline-flex items-center gap-0.5 hover:underline"
        >
          All clients <ArrowRight className="w-3 h-3" />
        </Link>
      </header>
      <ul className="divide-y divide-emerald-100/60 max-h-[420px] overflow-y-auto">
        {rows.map((r) => (
          <li key={r.clientId}>
            <Link
              href={`/clients/${encodeURIComponent(r.clientId)}`}
              className="block px-4 py-3 hover:bg-emerald-50/40 transition-colors"
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="text-[13px] font-semibold text-ink truncate">
                  {r.clientName}
                </div>
                {r.updatedAt && (
                  <div className="text-[10px] text-ink/55 tabular-nums shrink-0">
                    {new Date(r.updatedAt).toLocaleDateString(undefined, {
                      month: "short", day: "numeric"
                    })}
                  </div>
                )}
              </div>
              {/* Server truncated to ~280 chars; line-clamp keeps row
                  height tight while preserving line breaks the leader
                  typed. */}
              <div className="text-[12px] text-ink/70 leading-snug whitespace-pre-line line-clamp-3 mt-1">
                {r.brief}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
