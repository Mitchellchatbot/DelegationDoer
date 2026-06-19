"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ClipboardCheck, AlertTriangle, Activity, CalendarClock,
  Mail, Video, Inbox, Hourglass, CheckCircle2
} from "lucide-react";
import type { TodaysFocus } from "@/lib/home-data";
import { HEALTH_META } from "@/lib/client-health";
import { cn } from "@/lib/utils";

// "Today's Focus" — the leader/head triage strip on /home, sitting just
// under the hero greeting. Compact tiles that roll up the day's priorities
// into one number each:
//   - Approvals waiting  = email drafts + meeting action-items + routing
//   - Overdue tasks      = past-due + stalled (deduped)
//   - Clients at-risk    = clients whose email tone is slipping
//   - Upcoming meetings  = next 7 days of client meetings (Google Calendar)
//
// Every tile is a flip card: a count by default, flipping on hover/focus to
// reveal the detail behind the number. The reverse is a frosted glass panel
// whose rows cascade in as the card turns. The first three counts come from
// server props; the meetings tile is fetched client-side so it never adds a
// Google round-trip to the server render. Tiles at zero (or a disconnected
// calendar) are dropped; when everything's clear we show a quiet success line.

type Tone = "rose" | "amber" | "indigo" | "emerald";

// Front icon chip (soft tint).
const TONE: Record<Tone, string> = {
  rose:    "bg-rose-50 text-rose-600",
  amber:   "bg-amber-50 text-amber-600",
  indigo:  "bg-indigo-50 text-indigo-600",
  emerald: "bg-emerald-50 text-emerald-600"
};
// Back-face row icon + value accents.
const TONE_ICON: Record<Tone, string> = {
  rose: "text-rose-500", amber: "text-amber-500", indigo: "text-indigo-500", emerald: "text-emerald-500"
};
const TONE_VALUE: Record<Tone, string> = {
  rose: "text-rose-700", amber: "text-amber-700", indigo: "text-indigo-700", emerald: "text-emerald-700"
};
// Frosted-glass back panel: a soft tone→white gradient + inset ring, keyed
// by the same tone. Mirrors the gradient/blur idiom used elsewhere on /home.
const TONE_BACK_GLASS: Record<Tone, string> = {
  rose:    "from-rose-50/80 via-white/70 to-white/60 ring-rose-200/50",
  amber:   "from-amber-50/80 via-white/70 to-white/60 ring-amber-200/50",
  indigo:  "from-indigo-50/80 via-white/70 to-white/60 ring-indigo-200/50",
  emerald: "from-emerald-50/80 via-white/70 to-white/60 ring-emerald-200/50"
};

interface MeetingLite {
  startISO: string;
  clientName: string | null;
  summary: string;
  hangoutLink: string | null;
}

export interface AtRiskClient { name: string; label: "at_risk" | "shaky" }

interface Tile {
  key: string;
  count: number;
  label: string;
  sub: string;
  href: string;
  icon: React.ReactNode;
  tone: Tone;
  // Inner content of each back-face row; FlipTile lays them out + animates.
  backRows: React.ReactNode[];
}

export function HomeTodaysFocus({
  focus, atRiskList
}: {
  focus: TodaysFocus;
  atRiskList: AtRiskClient[];
}) {
  // Meetings tile is client-fetched. null = still loading / unavailable;
  // [] = connected but nothing (tile hidden, same as a zero count).
  const [meetings, setMeetings] = useState<MeetingLite[] | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/calendar/meetings?days=7", { cache: "no-store" });
        const data = await res.json();
        if (!alive) return;
        setMeetings(res.ok ? ((data.meetings ?? []) as MeetingLite[]) : []);
      } catch {
        if (alive) setMeetings([]);
      }
    })();
    return () => { alive = false; };
  }, []);

  // One reduced-motion listener for the whole strip (passed to each tile).
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const countTiles: Tile[] = [
    {
      key: "approvals",
      count: focus.approvals + focus.meetings + focus.unassigned,
      label: "Approvals waiting",
      sub: "to review & send",
      href: "/approvals",
      icon: <ClipboardCheck className="w-4 h-4" />,
      tone: "indigo",
      backRows: ledgerRows("indigo", [
        { n: focus.approvals, label: "Emails", icon: <Mail className="w-3.5 h-3.5" /> },
        { n: focus.meetings, label: "Meetings", icon: <Video className="w-3.5 h-3.5" /> },
        { n: focus.unassigned, label: "Routing", icon: <Inbox className="w-3.5 h-3.5" /> }
      ])
    },
    {
      key: "overdue",
      // Deduped count on the front; back shows the overlapping components.
      count: focus.overdueOrStalled,
      label: "Overdue tasks",
      sub: "incl. stalled",
      href: "/tasks",
      icon: <AlertTriangle className="w-4 h-4" />,
      tone: "amber",
      backRows: ledgerRows("amber", [
        { n: focus.overdue, label: "Overdue", icon: <AlertTriangle className="w-3.5 h-3.5" /> },
        { n: focus.stalled, label: "Stalled 7+ days", icon: <Hourglass className="w-3.5 h-3.5" /> }
      ])
    },
    {
      key: "clients",
      count: focus.atRiskClients,
      label: "Clients at-risk",
      sub: "tone slipping",
      href: "/clients",
      icon: <Activity className="w-4 h-4" />,
      tone: "rose",
      backRows: clientRows(atRiskList)
    }
  ];

  const visible = countTiles.filter((t) => t.count > 0);
  const hasMeetings = !!meetings && meetings.length > 0;

  if (visible.length === 0 && !hasMeetings) {
    return (
      <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft px-4 py-3">
        <div className="text-[12px] text-ink/55 inline-flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          All clear — nothing needs your attention right now.
        </div>
      </section>
    );
  }

  // Meetings tile appended after Clients at-risk once loaded.
  const all: Tile[] = hasMeetings
    ? [...visible, {
        key: "meetings",
        count: meetings!.length,
        label: "Upcoming meetings",
        sub: "next 7 days",
        href: "/schedule",
        icon: <CalendarClock className="w-4 h-4" />,
        tone: "emerald" as Tone,
        backRows: meetingRows(meetings!)
      }]
    : visible;

  return (
    <section className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-2">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {all.map((t) => (
          <FlipTile key={t.key} tile={t} reduceMotion={reduceMotion} />
        ))}
      </div>
    </section>
  );
}

// Generic flip card: count on the front, the detail rows on a frosted-glass
// reverse. Flips on hover and keyboard focus; the whole tile links to its
// page. The 3D + the staggered row reveal are inline-styled (the strip uses
// no arbitrary CSS-property utilities) so it's self-contained and robust.
function FlipTile({ tile, reduceMotion }: { tile: Tile; reduceMotion: boolean }) {
  const [flipped, setFlipped] = useState(false);
  return (
    <Link
      href={tile.href}
      onMouseEnter={() => setFlipped(true)}
      onMouseLeave={() => setFlipped(false)}
      onFocus={() => setFlipped(true)}
      onBlur={() => setFlipped(false)}
      style={{ perspective: 800 }}
      className="block rounded-xl"
    >
      <div
        style={{
          position: "relative",
          transformStyle: "preserve-3d",
          transition: reduceMotion ? undefined : "transform .42s cubic-bezier(.2,.7,.2,1)",
          transform: flipped ? "rotateY(180deg)" : undefined
        }}
      >
        {/* FRONT — count; in normal flow so it sets the cell height. */}
        <div
          style={{ backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden" }}
          className="rounded-xl border border-slate-200/60 px-3 py-2.5 flex flex-col"
        >
          <div className="flex items-center justify-between">
            <span className={cn("w-7 h-7 rounded-lg grid place-items-center shrink-0", TONE[tile.tone])}>
              {tile.icon}
            </span>
            <span className="text-[20px] font-bold tabular-nums text-ink leading-none">
              {tile.count}
            </span>
          </div>
          <div className="text-[12px] font-semibold text-ink leading-tight mt-2 truncate">
            {tile.label}
          </div>
          <div className="text-[10px] text-ink/45 leading-tight truncate">
            {tile.sub}
          </div>
        </div>

        {/* BACK — frosted glass panel; rows cascade in as the card turns. */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            transform: "rotateY(180deg)",
            backfaceVisibility: "hidden",
            WebkitBackfaceVisibility: "hidden"
          }}
          className={cn(
            "rounded-xl px-2.5 py-2 overflow-hidden flex flex-col justify-center gap-1",
            "bg-gradient-to-br backdrop-blur-sm ring-1 ring-inset shadow-soft",
            TONE_BACK_GLASS[tile.tone]
          )}
        >
          {tile.backRows.map((row, i) => (
            <div
              key={i}
              className="flex items-center gap-2 leading-tight"
              style={
                reduceMotion
                  ? undefined
                  : {
                      opacity: flipped ? 1 : 0,
                      transform: flipped ? "translateY(0)" : "translateY(4px)",
                      transition: "opacity .28s ease, transform .28s ease",
                      transitionDelay: flipped ? `${80 + i * 45}ms` : "0ms"
                    }
              }
            >
              {row}
            </div>
          ))}
        </div>
      </div>
    </Link>
  );
}

// ── back-face row builders (return the inner content of each row) ─────────

// Metric breakdown: tone icon + label + right-aligned value. Drops zeros.
function ledgerRows(
  tone: Tone,
  items: Array<{ n: number; label: string; icon: React.ReactNode }>
): React.ReactNode[] {
  return items
    .filter((it) => it.n > 0)
    .map((it) => (
      <>
        <span className={cn("shrink-0", TONE_ICON[tone])}>{it.icon}</span>
        <span className="text-[10.5px] font-medium text-ink/70 truncate flex-1 min-w-0">{it.label}</span>
        <span className={cn("text-[12px] font-bold tabular-nums shrink-0", TONE_VALUE[tone])}>{it.n}</span>
      </>
    ));
}

// At-risk client names + the app's standard health pill. Capped at 3 lines.
function clientRows(list: AtRiskClient[]): React.ReactNode[] {
  const cap = list.length > 3 ? 2 : 3;
  const shown = list.slice(0, cap);
  const extra = list.length - shown.length;
  const rows: React.ReactNode[] = shown.map((c) => {
    const meta = HEALTH_META[c.label];
    return (
      <>
        <span className="text-[11px] font-medium text-ink/80 truncate flex-1 min-w-0">{c.name}</span>
        <span className={cn(
          "shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[8.5px] font-semibold border",
          meta.bg, meta.text, meta.border
        )}>
          <span className={cn("w-1 h-1 rounded-full", meta.dot)} />
          {meta.label}
        </span>
      </>
    );
  });
  if (extra > 0) rows.push(<span className="text-[9px] text-ink/40 font-medium">+{extra} more</span>);
  return rows;
}

// Upcoming meetings: leading icon (Video for a Meet link, else
// CalendarClock) + client + a trailing emerald time pill — mirrors the
// ledger leading-icon and the client trailing-pill patterns. Capped at 3.
function meetingRows(meetings: MeetingLite[]): React.ReactNode[] {
  const cap = meetings.length > 3 ? 2 : 3;
  const shown = meetings.slice(0, cap);
  const extra = meetings.length - shown.length;
  const rows: React.ReactNode[] = shown.map((m) => {
    const Icon = m.hangoutLink ? Video : CalendarClock;
    return (
      <>
        <span className="shrink-0 text-emerald-500"><Icon className="w-3.5 h-3.5" /></span>
        <span className="text-[10.5px] font-medium text-ink/80 truncate flex-1 min-w-0">
          {m.clientName ?? m.summary}
        </span>
        <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full text-[8.5px] font-semibold tabular-nums bg-emerald-50 text-emerald-700 border border-emerald-200">
          {fmtWhenShort(m.startISO)}
        </span>
      </>
    );
  });
  if (extra > 0) rows.push(<span className="text-[9px] text-ink/40 font-medium">+{extra} more</span>);
  return rows;
}

// Compact "Today 3p" / "Wed 9:30a" label for the cramped back face.
function fmtWhenShort(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
  const day =
    dayDiff === 0 ? "Today" :
    dayDiff === 1 ? "Tmrw" :
    d.toLocaleDateString(undefined, { weekday: "short" });
  const h = d.getHours();
  const m = d.getMinutes();
  const ap = h < 12 ? "a" : "p";
  const disp = h % 12 === 0 ? 12 : h % 12;
  const time = m === 0 ? `${disp}${ap}` : `${disp}:${String(m).padStart(2, "0")}${ap}`;
  return `${day} ${time}`;
}
