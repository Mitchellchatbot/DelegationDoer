"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  TOUCHPOINT_META, computeTouchpointLabel, daysSince,
  effectiveTouchpoint, type TouchpointLabel
} from "@/lib/client-touchpoint";

// Shape needed for the widget — a slim subset of Client so callers
// can pass either full Client objects or a trimmed list from an API.
export interface FollowUpClient {
  id: string;
  name: string;
  lastOutboundEmailAt: string | null;
  touchpointOverrideLabel: TouchpointLabel | null;
  touchpointSummary: string | null;
  contactName: string | null;
}

// Compact "Clients needing follow-up" widget. Picks every client
// whose effective touchpoint is red or yellow and shows the most
// urgent ones first. Designed to drop into a dashboard layout or
// a sidebar; the full list lives at /clients?filter=red.
export function ClientFollowUpWidget({
  clients,
  limit = 6,
  showHeader = true
}: {
  clients: FollowUpClient[];
  limit?: number;
  showHeader?: boolean;
}) {
  // Decorate + filter to only needs-attention rows.
  const decorated = clients
    .map((c) => {
      const { label, isOverride } = effectiveTouchpoint(
        c.touchpointOverrideLabel,
        c.lastOutboundEmailAt
      );
      return {
        ...c,
        label,
        isOverride,
        days: daysSince(c.lastOutboundEmailAt)
      };
    })
    .filter((c) => c.label !== "green")
    // Red before yellow; within each band, oldest contact first.
    .sort((a, b) => {
      const rank = (l: TouchpointLabel) => (l === "red" ? 0 : l === "yellow" ? 1 : 2);
      const r = rank(a.label) - rank(b.label);
      if (r !== 0) return r;
      const ad = a.lastOutboundEmailAt ? new Date(a.lastOutboundEmailAt).getTime() : 0;
      const bd = b.lastOutboundEmailAt ? new Date(b.lastOutboundEmailAt).getTime() : 0;
      return ad - bd;
    });

  const items = decorated.slice(0, limit);
  const overflow = Math.max(0, decorated.length - limit);
  const redCount = decorated.filter((c) => c.label === "red").length;
  const yellowCount = decorated.filter((c) => c.label === "yellow").length;

  return (
    <section className="rounded-2xl border border-white/60 shadow-soft bg-gradient-to-br from-rose-50/60 via-amber-50/40 to-white p-4 space-y-3">
      {showHeader && (
        <header className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
            <div className="text-sm font-semibold">Needs follow-up</div>
            <div className="text-[11px] text-ink/55">
              {redCount > 0 && (
                <span className="inline-flex items-center gap-1 mr-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                  {redCount} red
                </span>
              )}
              {yellowCount > 0 && (
                <span className="inline-flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                  {yellowCount} yellow
                </span>
              )}
            </div>
          </div>
          <Link
            href="/clients"
            className="text-[11px] text-accent hover:underline inline-flex items-center gap-1"
          >
            All clients <ArrowRight className="w-3 h-3" />
          </Link>
        </header>
      )}

      {items.length === 0 ? (
        <div className="rounded-xl bg-white/70 border border-emerald-200/50 p-3 text-[12px] text-emerald-700 inline-flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          Every client got an email in the last 3 days.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {items.map((c) => {
            const meta = TOUCHPOINT_META[c.label];
            return (
              <li key={c.id}>
                <Link
                  href={`/clients/${encodeURIComponent(c.id)}`}
                  className="group flex items-center gap-2.5 p-2.5 rounded-xl bg-white/85 border border-white/70 hover:border-accent/30 hover:shadow-soft transition-all"
                >
                  <span className={cn("w-2 h-2 rounded-full shrink-0", meta.dot)} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium truncate group-hover:text-accent">
                      {c.name}
                    </div>
                    <div className="text-[10px] text-ink/55 truncate">
                      {c.days === null
                        ? "Never emailed via DelegationDoer"
                        : c.days === 0
                          ? "Last email today"
                          : c.days === 1
                            ? "Last email 1 day ago"
                            : `Last email ${c.days} days ago`}
                      {c.touchpointSummary && ` · ${c.touchpointSummary}`}
                    </div>
                  </div>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium shrink-0",
                      meta.bg, meta.text, meta.border
                    )}
                  >
                    <Send className="w-2.5 h-2.5" />
                    {meta.label}
                  </span>
                </Link>
              </li>
            );
          })}
          {overflow > 0 && (
            <li className="text-[11px] text-ink/55 px-2 pt-1">
              + {overflow} more {overflow === 1 ? "client" : "clients"} need attention.{" "}
              <Link href="/clients" className="text-accent hover:underline">
                View all →
              </Link>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
