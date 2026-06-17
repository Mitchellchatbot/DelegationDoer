"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ClipboardCheck, AlertTriangle, Activity, CalendarClock, Video, CheckCircle2 } from "lucide-react";
import type { TodaysFocus } from "@/lib/home-data";
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
// reveal the detail behind the number (Approvals → emails/meetings/routing;
// Overdue → overdue/stalled; Clients → the at-risk client names; Meetings →
// the meeting list). Clicking a tile opens the relevant page. The first
// three counts come from server props; the meetings tile is fetched
// client-side so it never adds a Google round-trip to the server render.
// Tiles at zero (or a disconnected calendar) are dropped; when everything's
// clear we show a quiet success line.

type Tone = "rose" | "amber" | "indigo" | "emerald";

const TONE: Record<Tone, string> = {
  rose:    "bg-rose-50 text-rose-600",
  amber:   "bg-amber-50 text-amber-600",
  indigo:  "bg-indigo-50 text-indigo-600",
  emerald: "bg-emerald-50 text-emerald-600"
};
// Accent text for back-face values.
const TONE_TEXT: Record<Tone, string> = {
  rose:    "text-rose-600",
  amber:   "text-amber-600",
  indigo:  "text-indigo-600",
  emerald: "text-emerald-700"
};
// Tint for the back panel, keyed by the same tone.
const TONE_BACK: Record<Tone, string> = {
  rose:    "border-rose-200/60 bg-rose-50/40",
  amber:   "border-amber-200/60 bg-amber-50/40",
  indigo:  "border-indigo-200/60 bg-indigo-50/40",
  emerald: "border-emerald-200/70 bg-emerald-50/40"
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
  back: React.ReactNode;
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
      back: countRows([
        [focus.approvals, "Emails"],
        [focus.meetings, "Meetings"],
        [focus.unassigned, "Routing"]
      ], "indigo")
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
      back: countRows([
        [focus.overdue, "Overdue"],
        [focus.stalled, "Stalled 7+ days"]
      ], "amber")
    },
    {
      key: "clients",
      count: focus.atRiskClients,
      label: "Clients at-risk",
      sub: "tone slipping",
      href: "/clients",
      icon: <Activity className="w-4 h-4" />,
      tone: "rose",
      back: clientRows(atRiskList)
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
        back: meetingRows(meetings!)
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

// Generic flip card: count on the front, `tile.back` on the reverse. Flips
// on hover and keyboard focus; the whole tile links to its page. The 3D is
// inline-styled (the rest of the strip uses no arbitrary CSS-property
// utilities) so it's self-contained and robust.
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
          transition: reduceMotion ? undefined : "transform .35s ease",
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

        {/* BACK — the detail, overlaid on the front's footprint. */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            transform: "rotateY(180deg)",
            backfaceVisibility: "hidden",
            WebkitBackfaceVisibility: "hidden"
          }}
          className={cn(
            "rounded-xl border px-2.5 py-2 overflow-hidden flex flex-col justify-center gap-0.5",
            TONE_BACK[tile.tone]
          )}
        >
          {tile.back}
        </div>
      </div>
    </Link>
  );
}

// ── back-face row builders ──────────────────────────────────────────────

// Breakdown rows: a tone-colored count + a muted label, dropping zeros.
function countRows(parts: Array<[number, string]>, tone: Tone) {
  const items = parts.filter(([n]) => n > 0);
  return (
    <>
      {items.map(([n, label]) => (
        <div key={label} className="flex items-center gap-2 leading-tight">
          <span className={cn("text-[11px] font-bold tabular-nums w-5 text-right shrink-0", TONE_TEXT[tone])}>
            {n}
          </span>
          <span className="text-[10px] text-ink/70 truncate">{label}</span>
        </div>
      ))}
    </>
  );
}

const CLIENT_CHIP: Record<AtRiskClient["label"], string> = {
  at_risk: "bg-rose-50 text-rose-600 border-rose-200/70",
  shaky:   "bg-amber-50 text-amber-600 border-amber-200/70"
};
const CLIENT_CHIP_LABEL: Record<AtRiskClient["label"], string> = {
  at_risk: "at-risk",
  shaky:   "shaky"
};

// At-risk client names + a small label chip. Capped at 3 lines.
function clientRows(list: AtRiskClient[]) {
  const cap = list.length > 3 ? 2 : 3;
  const shown = list.slice(0, cap);
  const extra = list.length - shown.length;
  return (
    <>
      {shown.map((c, i) => (
        <div key={i} className="flex items-center gap-1.5 leading-tight">
          <span className="text-[10px] text-ink/75 truncate flex-1 min-w-0">{c.name}</span>
          <span className={cn("text-[8.5px] font-semibold px-1 py-px rounded border shrink-0", CLIENT_CHIP[c.label])}>
            {CLIENT_CHIP_LABEL[c.label]}
          </span>
        </div>
      ))}
      {extra > 0 && <div className="text-[9px] text-ink/45 leading-tight">+{extra} more</div>}
    </>
  );
}

// Upcoming meetings: time + client + a Meet dot. Capped at 3 lines.
function meetingRows(meetings: MeetingLite[]) {
  const cap = meetings.length > 3 ? 2 : 3;
  const shown = meetings.slice(0, cap);
  const extra = meetings.length - shown.length;
  return (
    <>
      {shown.map((m, i) => (
        <div key={i} className="flex items-center gap-1.5 leading-tight">
          <span className="text-[10px] font-semibold tabular-nums text-emerald-700 shrink-0">
            {fmtWhenShort(m.startISO)}
          </span>
          <span className="text-[10px] text-ink/70 truncate flex-1 min-w-0">
            {m.clientName ?? m.summary}
          </span>
          {m.hangoutLink && <Video className="w-2.5 h-2.5 text-emerald-600 shrink-0" />}
        </div>
      ))}
      {extra > 0 && <div className="text-[9px] text-ink/45 leading-tight">+{extra} more</div>}
    </>
  );
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
