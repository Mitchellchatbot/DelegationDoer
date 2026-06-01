"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Activity, FileText, ArrowRightLeft, Hourglass, AlertTriangle,
  Sparkles, ClipboardCheck, Send, CheckCircle2, Plus, Inbox, UserPlus,
  Layers, Bell
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/Tooltip";

export type PulseKind =
  | "seo_report"
  | "handoff"
  | "stalled"
  | "site_alert"
  | "approval_pending"
  | "approval_sent"
  | "task_completed"
  | "new_task"
  | "routing_review"
  | "client_added";

export interface PulseEvent {
  id: string;
  kind: PulseKind;
  title: string;
  detail: string | null;
  href: string;
  at: string; // ISO
}

// Per-kind visual meta. Tone classes line up with the chip color so
// each event reads as one "color of urgency" at a glance.
const KIND_META: Record<PulseKind, {
  label: string;
  Icon: typeof Sparkles;
  tone: { bg: string; text: string; ring: string };
  tip: string;
  category: "task" | "approval" | "alert" | "client";
}> = {
  seo_report: {
    label: "SEO report",
    Icon: FileText,
    tone: { bg: "bg-violet-50", text: "text-violet-700", ring: "ring-violet-200/60" },
    tip: "A new SEO report request was opened.",
    category: "task"
  },
  handoff: {
    label: "Handoff",
    Icon: ArrowRightLeft,
    tone: { bg: "bg-amber-50", text: "text-amber-700", ring: "ring-amber-200/60" },
    tip: "Someone handed a task off to a different assignee.",
    category: "task"
  },
  stalled: {
    label: "Stalled",
    Icon: Hourglass,
    tone: { bg: "bg-slate-100", text: "text-slate-700", ring: "ring-slate-200/60" },
    tip: "Assigned task with no activity in the last week.",
    category: "task"
  },
  new_task: {
    label: "New task",
    Icon: Plus,
    tone: { bg: "bg-blue-50", text: "text-blue-700", ring: "ring-blue-200/60" },
    tip: "Newly created high or critical priority task.",
    category: "task"
  },
  task_completed: {
    label: "Completed",
    Icon: CheckCircle2,
    tone: { bg: "bg-emerald-50", text: "text-emerald-700", ring: "ring-emerald-200/60" },
    tip: "Task shipped in the last 48 hours.",
    category: "task"
  },
  approval_pending: {
    label: "Awaits approval",
    Icon: ClipboardCheck,
    tone: { bg: "bg-rose-50", text: "text-rose-700", ring: "ring-rose-200/60" },
    tip: "Outbound email draft waiting on an approver.",
    category: "approval"
  },
  approval_sent: {
    label: "Sent",
    Icon: Send,
    tone: { bg: "bg-emerald-50", text: "text-emerald-700", ring: "ring-emerald-200/60" },
    tip: "Email draft was approved and sent.",
    category: "approval"
  },
  routing_review: {
    label: "Routing review",
    Icon: Inbox,
    tone: { bg: "bg-indigo-50", text: "text-indigo-700", ring: "ring-indigo-200/60" },
    tip: "AI-routed task awaiting a human to confirm the routing.",
    category: "approval"
  },
  site_alert: {
    label: "Site health",
    Icon: AlertTriangle,
    tone: { bg: "bg-rose-50", text: "text-rose-700", ring: "ring-rose-200/60" },
    tip: "A client site scored below the configured threshold.",
    category: "alert"
  },
  client_added: {
    label: "New client",
    Icon: UserPlus,
    tone: { bg: "bg-fuchsia-50", text: "text-fuchsia-700", ring: "ring-fuchsia-200/60" },
    tip: "A new client folder was created in the last week.",
    category: "client"
  }
};

const CATEGORIES: Array<{ id: "all" | "task" | "approval" | "alert" | "client"; label: string; Icon: typeof Layers }> = [
  { id: "all",      label: "All",       Icon: Layers },
  { id: "task",     label: "Tasks",     Icon: FileText },
  { id: "approval", label: "Approvals", Icon: ClipboardCheck },
  { id: "alert",    label: "Alerts",    Icon: AlertTriangle },
  { id: "client",   label: "Clients",   Icon: UserPlus }
];

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  const days = Math.floor(diffSec / 86400);
  if (days < 30) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Group events into bands the leader scans top-down.
function bandFor(iso: string): "Today" | "Yesterday" | "This week" | "Earlier" {
  const then = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const startOfWeekAgo = startOfToday - 6 * 86_400_000;
  const ts = then.getTime();
  if (ts >= startOfToday) return "Today";
  if (ts >= startOfYesterday) return "Yesterday";
  if (ts >= startOfWeekAgo) return "This week";
  return "Earlier";
}

const SEEN_KEY = "home:pulse:seen-cursor:v1";

export function HomePulseCard({ events }: { events: PulseEvent[] }) {
  // Filter state — category-level cut.
  const [filter, setFilter] = useState<typeof CATEGORIES[number]["id"]>("all");

  // "New since you last visited" indicator. We persist the most-recent
  // event timestamp the user saw; anything after it gets a small unread
  // dot. Cursor updates on mount (so opening the dashboard clears the
  // unread state). No backend write — purely per-browser.
  const [seenCursor, setSeenCursor] = useState<number>(0);
  useEffect(() => {
    const stored = (() => {
      try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; }
    })();
    setSeenCursor(stored);
    // Cursor: latest event timestamp at mount. On unmount we don't
    // persist — we persist immediately so a tab refresh feels right.
    const latest = events[0] ? new Date(events[0].at).getTime() : 0;
    if (latest > stored) {
      try { localStorage.setItem(SEEN_KEY, String(latest)); } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    if (filter === "all") return events;
    return events.filter((e) => KIND_META[e.kind].category === filter);
  }, [events, filter]);

  // Counts per category for the filter chips.
  const countByCategory = useMemo(() => {
    const c: Record<string, number> = { all: events.length, task: 0, approval: 0, alert: 0, client: 0 };
    for (const e of events) c[KIND_META[e.kind].category] += 1;
    return c;
  }, [events]);

  // Group filtered events into bands. Keeps relative ordering inside
  // each band intact (already sorted DESC by server).
  const grouped = useMemo(() => {
    const bands: Array<{ label: string; rows: PulseEvent[] }> = [
      { label: "Today",      rows: [] },
      { label: "Yesterday",  rows: [] },
      { label: "This week",  rows: [] },
      { label: "Earlier",    rows: [] }
    ];
    for (const e of filtered) {
      const b = bandFor(e.at);
      const idx = bands.findIndex((x) => x.label === b);
      if (idx >= 0) bands[idx].rows.push(e);
    }
    return bands.filter((b) => b.rows.length > 0);
  }, [filtered]);

  if (events.length === 0) return null;

  const newCount = events.filter((e) => new Date(e.at).getTime() > seenCursor).length;

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden flex flex-col">
      <header className="flex items-center justify-between gap-2 px-4 py-3 border-b border-slate-100 shrink-0 flex-wrap">
        <div className="text-[13px] font-semibold inline-flex items-center gap-2">
          <Bell className="w-4 h-4 text-indigo-500" />
          What's moving
          {newCount > 0 && (
            <Tooltip label={`${newCount} new since your last visit.`}>
              <span className="inline-flex items-center justify-center text-[10px] font-semibold tabular-nums px-1.5 h-4 rounded-full bg-accent text-white">
                {newCount > 99 ? "99+" : newCount} new
              </span>
            </Tooltip>
          )}
        </div>
        {/* Filter chips — same shape as the EmailApprovalsTab filter pill */}
        <div className="inline-flex items-center rounded-xl border border-slate-200/70 bg-white p-0.5">
          {CATEGORIES.map((c) => {
            const Icon = c.Icon;
            const active = filter === c.id;
            const count = countByCategory[c.id];
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setFilter(c.id)}
                disabled={count === 0 && c.id !== "all"}
                className={cn(
                  "px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors inline-flex items-center gap-1",
                  active ? "bg-accent/10 text-accent" : "text-ink/55 hover:text-ink",
                  count === 0 && c.id !== "all" && "opacity-40 cursor-not-allowed hover:text-ink/55"
                )}
              >
                <Icon className="w-3 h-3" />
                {c.label}
                <span className="text-[10px] opacity-70 tabular-nums">{count}</span>
              </button>
            );
          })}
        </div>
      </header>

      {filtered.length === 0 ? (
        <div className="px-4 py-8 text-center text-[12px] text-ink/55">
          Nothing in this category right now.
        </div>
      ) : (
        <div className="max-h-[520px] overflow-y-auto">
          {grouped.map((band, gi) => (
            <div key={band.label}>
              {/* Sticky band header — keeps temporal context as the
                  feed scrolls. Subtle so it doesn't fight the rows. */}
              <div
                className={cn(
                  "sticky top-0 z-10 bg-white/95 backdrop-blur-sm px-4 py-1.5 text-[9.5px] uppercase tracking-[0.12em] font-semibold text-ink/45",
                  gi > 0 && "border-t border-slate-100"
                )}
              >
                {band.label}
                <span className="text-ink/35 ml-1 tabular-nums normal-case tracking-normal">· {band.rows.length}</span>
              </div>
              <ul className="divide-y divide-slate-100">
                {band.rows.map((e) => {
                  const meta = KIND_META[e.kind];
                  const Icon = meta.Icon;
                  const isNew = new Date(e.at).getTime() > seenCursor;
                  return (
                    <li key={e.id}>
                      <Tooltip label={meta.tip} side="left">
                        <Link
                          href={e.href}
                          className="flex items-start gap-2.5 px-4 py-2 hover:bg-slate-50 transition-colors group"
                        >
                          {/* Icon tile */}
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
                              <span className="text-[10.5px] text-ink/45 tabular-nums shrink-0">
                                {relativeTime(e.at)} ago
                              </span>
                              {isNew && (
                                <span
                                  className="shrink-0 inline-block w-1.5 h-1.5 rounded-full bg-accent"
                                  aria-label="new"
                                />
                              )}
                            </div>
                            <div className="text-[12.5px] font-medium text-ink truncate mt-0.5 group-hover:text-accent transition-colors">
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
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
