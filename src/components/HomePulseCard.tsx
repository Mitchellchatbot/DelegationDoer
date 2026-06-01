"use client";

import Link from "next/link";
import {
  Activity, FileText, ArrowRightLeft, Hourglass, AlertTriangle,
  Sparkles
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/Tooltip";

export type PulseKind = "seo_report" | "handoff" | "stalled" | "site_alert";
export interface PulseEvent {
  id: string;
  kind: PulseKind;
  title: string;
  detail: string | null;
  href: string;
  at: string; // ISO
}

// Single feed card surfacing dynamic agency-level events the leader
// hadn't asked for explicitly: a fresh SEO report request, a task
// handoff, a stalled assignment, a low site-health alert. Each row is
// a small pill + line of text + relative time — no chunky chrome, so
// six events sit in roughly the same vertical space as one of the
// dashboard's other cards.
//
// Hides itself entirely when the feed is empty — a leader without
// noise shouldn't see "nothing happening" copy taking screen space.

const KIND_META: Record<PulseKind, {
  label: string;
  Icon: typeof Sparkles;
  tone: { bg: string; text: string; ring: string };
  tip: string;
}> = {
  seo_report: {
    label: "SEO report",
    Icon: FileText,
    tone: {
      bg: "bg-violet-50",
      text: "text-violet-700",
      ring: "ring-violet-200/60"
    },
    tip: "A new SEO report request was opened. Tagged tasks land in routing review unless rules pick a writer."
  },
  handoff: {
    label: "Handoff",
    Icon: ArrowRightLeft,
    tone: {
      bg: "bg-amber-50",
      text: "text-amber-700",
      ring: "ring-amber-200/60"
    },
    tip: "Someone handed a task off to a different assignee — pay attention if it's the same task bouncing twice."
  },
  stalled: {
    label: "Stalled",
    Icon: Hourglass,
    tone: {
      bg: "bg-slate-50",
      text: "text-slate-700",
      ring: "ring-slate-200/60"
    },
    tip: "Active task with no activity in the last week. The owner may need a nudge or unblocking."
  },
  site_alert: {
    label: "Site health",
    Icon: AlertTriangle,
    tone: {
      bg: "bg-rose-50",
      text: "text-rose-700",
      ring: "ring-rose-200/60"
    },
    tip: "A client site scored below the configured threshold. The Website team gets an auto-task on these."
  }
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  const days = Math.floor(diffSec / 86400);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function HomePulseCard({ events }: { events: PulseEvent[] }) {
  if (events.length === 0) return null;
  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-slate-100 shrink-0">
        <div className="text-[13px] font-semibold inline-flex items-center gap-2">
          <Activity className="w-4 h-4 text-indigo-500" />
          What's moving
          <Tooltip label="Dynamic feed of agency events: new SEO reports, task handoffs, stalled work, low site-health alerts. Quiet days = quiet card.">
            <span className="text-[11px] text-ink/55 font-normal tabular-nums">
              · {events.length}
            </span>
          </Tooltip>
        </div>
      </header>
      <ul className="divide-y divide-slate-100 max-h-[420px] overflow-y-auto">
        {events.map((e) => {
          const meta = KIND_META[e.kind];
          const Icon = meta.Icon;
          return (
            <li key={e.id}>
              <Tooltip label={meta.tip} side="left">
                <Link
                  href={e.href}
                  className="flex items-start gap-2.5 px-4 py-2 hover:bg-slate-50 transition-colors"
                >
                  <span
                    className={cn(
                      "shrink-0 w-7 h-7 rounded-lg grid place-items-center ring-1 mt-0.5",
                      meta.tone.bg, meta.tone.text, meta.tone.ring
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span
                        className={cn(
                          "shrink-0 text-[9.5px] uppercase tracking-[0.08em] font-semibold",
                          meta.tone.text
                        )}
                      >
                        {meta.label}
                      </span>
                      <span className="text-[10.5px] text-ink/50 tabular-nums shrink-0">
                        {relativeTime(e.at)}
                      </span>
                    </div>
                    <div className="text-[12.5px] font-medium text-ink truncate mt-0.5">
                      {e.title}
                    </div>
                    {e.detail && (
                      <div className="text-[11px] text-ink/55 truncate">
                        {e.detail}
                      </div>
                    )}
                  </div>
                </Link>
              </Tooltip>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
