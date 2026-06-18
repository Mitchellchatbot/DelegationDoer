"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays, CalendarClock, ChevronLeft, ChevronRight, Loader2, Plus, ExternalLink, Video
} from "lucide-react";
import { PageHero } from "@/components/PageHero";
import { MeetingPrepPanel } from "@/components/MeetingPrepPanel";
import { cn } from "@/lib/utils";

interface CalendarEvent {
  id: string;
  summary: string;
  description: string | null;
  htmlLink: string;
  start: { dateTime: string | null; date: string | null };
  end:   { dateTime: string | null; date: string | null };
}

// Week-view schedule. Pulls events from /api/calendar/events for the
// active week, lays them out as positioned blocks in a 7-day grid
// with an hourly time axis. Tasks assigned with a due date appear
// here too because they're mirrored to the user's calendar by
// task-calendar-sync.
//
// Day starts Monday. Time grid runs 7am – 10pm (15h tall). An "all
// day" rail above the grid catches events without a dateTime.
const FIRST_HOUR = 7;
const LAST_HOUR = 22;
const HOURS = LAST_HOUR - FIRST_HOUR;          // 15
const HOUR_PX = 56;

export default function SchedulePage() {
  // Anchor = the Monday of the currently-viewed week.
  const [anchor, setAnchor] = useState<Date>(() => mondayOf(new Date()));
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notConnected, setNotConnected] = useState(false);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [creatingFor, setCreatingFor] = useState<{ dayIdx: number; hour: number } | null>(null);
  // Upcoming meetings (next 7 days), lifted here so both the Upcoming-meetings
  // and Meeting-prep panels share one fetch.
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);

  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => addDays(anchor, i));
  }, [anchor]);

  async function load() {
    try {
      setError(null);
      const days = 7;
      const res = await fetch(
        `/api/calendar/events?days=${days}&_=${anchor.getTime()}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (!res.ok) {
        // Token expired / revoked — was connected, needs to re-auth.
        if (data?.needsReconnect) {
          setNeedsReconnect(true);
          setEvents([]);
          return;
        }
        // Never connected.
        if (data?.connected === false) {
          setNotConnected(true);
          setEvents([]);
          return;
        }
        setError(data?.error ?? `failed (${res.status})`);
        setEvents([]);
        return;
      }
      setNotConnected(false);
      setNeedsReconnect(false);
      setEvents(data.events ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [anchor]);

  // Fetch upcoming meetings once the calendar is confirmed connected. The
  // window is "next 7 days from now" regardless of the week being viewed, so
  // this never refetches on week navigation.
  const meetingsReady = events !== null && !notConnected && !needsReconnect;
  useEffect(() => {
    if (!meetingsReady) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/calendar/meetings?days=7", { cache: "no-store" });
        const data = await res.json();
        if (!alive) return;
        setMeetings(res.ok ? ((data.meetings ?? []) as Meeting[]) : []);
      } catch {
        if (alive) setMeetings([]);
      }
    })();
    return () => { alive = false; };
  }, [meetingsReady]);

  function goPrev() { setAnchor(addDays(anchor, -7)); }
  function goNext() { setAnchor(addDays(anchor, 7)); }
  function goToday() { setAnchor(mondayOf(new Date())); }

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <PageHero
        eyebrow="Schedule"
        headline={["Your ", { accent: "week" }]}
        subtitle="Google Calendar events + any DelegationDoer task you're on the hook for. Tasks land here automatically once you connect Google in Settings."
        icon={<CalendarDays />}
        iconTone="indigo"
        trailing={
          <div className="flex items-center gap-1.5">
            <button
              onClick={goPrev}
              className="w-8 h-8 inline-grid place-items-center rounded-full border border-slate-200 bg-white hover:bg-slate-50 transition-colors"
              title="Previous week"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={goToday}
              className="px-3 py-1.5 rounded-full text-xs font-medium border border-slate-200 bg-white hover:bg-slate-50 transition-colors"
            >
              Today
            </button>
            <button
              onClick={goNext}
              className="w-8 h-8 inline-grid place-items-center rounded-full border border-slate-200 bg-white hover:bg-slate-50 transition-colors"
              title="Next week"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        }
      />

      <div className="text-sm text-ink/70 font-medium">
        Week of {weekDays[0].toLocaleDateString(undefined, { month: "long", day: "numeric" })} —{" "}
        {weekDays[6].toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}
      </div>

      {notConnected && (
        <div className="rounded-2xl border border-blue-200/70 bg-blue-50/40 p-5 text-sm">
          <div className="font-semibold text-ink mb-1">Connect Google Calendar</div>
          <div className="text-ink/65 mb-3">
            Tasks you're assigned with a due date will show up here automatically once you connect.
          </div>
          <a
            href="/settings"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white bg-accent hover:bg-accent/90"
          >
            Go to Settings →
          </a>
        </div>
      )}

      {needsReconnect && (
        <div className="rounded-2xl border border-amber-200/70 bg-amber-50/50 p-5 text-sm">
          <div className="font-semibold text-ink mb-1">Google Calendar connection expired</div>
          <div className="text-ink/65 mb-3">
            We couldn't refresh your Google access. Reconnect to keep your week in sync.
          </div>
          <a
            href="/settings"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-white bg-accent hover:bg-accent/90"
          >
            Reconnect in Settings →
          </a>
        </div>
      )}

      {error && (
        <div className="rounded-2xl border border-urgent/30 bg-urgent/5 p-4 text-sm text-urgent">
          {error}
        </div>
      )}

      {!notConnected && !needsReconnect && events === null && !error && (
        <div className="rounded-2xl border border-slate-200/70 bg-white p-8 text-center text-sm text-ink/55 inline-flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading week…
        </div>
      )}

      {!notConnected && !needsReconnect && events !== null && (
        // Two equal columns on lg+: the week grid (min-w-0 lets it reflow
        // narrower) on the left and the Upcoming-meetings panel on the right,
        // each ~50%. Below lg they stack, grid then meetings.
        <div className="lg:grid lg:gap-5 lg:grid-cols-2 space-y-4 lg:space-y-0">
          <div className="min-w-0">
            <WeekGrid
              weekDays={weekDays}
              events={events}
              onSlotClick={(dayIdx, hour) => setCreatingFor({ dayIdx, hour })}
            />
          </div>
          <aside>
            <div className="sticky top-4 space-y-3">
              <div className="space-y-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-ink/55 inline-flex items-center gap-1.5">
                  <CalendarClock className="w-3.5 h-3.5" /> Upcoming meetings
                </div>
                <MeetingsPanel meetings={meetings} />
              </div>
              <MeetingPrepPanel meetings={meetings} />
            </div>
          </aside>
        </div>
      )}

      {creatingFor && (
        <CreateEventDialog
          day={weekDays[creatingFor.dayIdx]}
          hour={creatingFor.hour}
          onClose={() => setCreatingFor(null)}
          onCreated={() => {
            setCreatingFor(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// Right-rail panel listing the signed-in user's upcoming meetings for the
// next 7 days (client-matched, capped). The fetch lives in SchedulePage and
// is passed in as a prop so the Meeting-prep panel below shares the same
// data. Deliberately "next 7 days from now" regardless of the week being
// viewed — matches the Home "Upcoming meetings" tile that links here.
interface Meeting {
  id: string;
  summary: string;
  startISO: string;
  htmlLink: string;
  hangoutLink: string | null;
  clientId: string | null;
  clientName: string | null;
  guest: string | null;
}

function MeetingsPanel({ meetings }: { meetings: Meeting[] | null }) {
  // null = still loading; [] = connected but nothing upcoming.
  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white shadow-soft p-3">
      {meetings === null ? (
        <div className="text-sm text-ink/55 inline-flex items-center gap-2 px-1 py-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : meetings.length === 0 ? (
        <div className="text-[12px] text-ink/55 px-1 py-2">
          No meetings in the next 7 days.
        </div>
      ) : (
        <div className="space-y-1.5">
          {meetings.map((m) => (
            <a
              key={m.id}
              href={m.htmlLink}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-lg border border-slate-200/70 px-2.5 py-2 hover:bg-slate-50 transition-colors"
            >
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-semibold tabular-nums text-accent shrink-0">
                  {fmtWhen(m.startISO)}
                </span>
                {m.hangoutLink && <Video className="w-3 h-3 text-emerald-600 shrink-0" />}
              </div>
              <div className="text-[12px] font-medium text-ink leading-tight mt-0.5 truncate">
                {m.clientName ?? m.summary}
              </div>
              {m.guest && (
                <div className="text-[10px] text-ink/50 leading-tight truncate">{m.guest}</div>
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function WeekGrid({
  weekDays, events, onSlotClick
}: {
  weekDays: Date[];
  events: CalendarEvent[];
  onSlotClick: (dayIdx: number, hour: number) => void;
}) {
  const todayKey = ymd(new Date());
  const allDay = events.filter((e) => !e.start.dateTime && !!e.start.date);

  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white shadow-soft overflow-hidden">
      <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-slate-200/70">
        <div />
        {weekDays.map((d) => {
          const isToday = ymd(d) === todayKey;
          return (
            <div
              key={d.toISOString()}
              className={cn(
                "px-2 py-2 text-center border-l border-slate-100",
                isToday && "bg-blue-50/60"
              )}
            >
              <div className="text-[10px] uppercase tracking-wide text-ink/55 font-semibold">
                {d.toLocaleDateString(undefined, { weekday: "short" })}
              </div>
              <div className={cn(
                "text-lg font-bold tabular-nums mt-0.5",
                isToday ? "text-accent" : "text-ink"
              )}>
                {d.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      {allDay.length > 0 && (
        <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-slate-200/70 bg-slate-50/40">
          <div className="px-1 py-1 text-[9px] uppercase tracking-wide text-ink/45 font-semibold text-right pt-2">
            all day
          </div>
          {weekDays.map((d, dayIdx) => {
            const key = ymd(d);
            const here = allDay.filter((e) => (e.start.date ?? "").slice(0, 10) === key);
            return (
              <div key={dayIdx} className="px-1 py-1 border-l border-slate-100 min-h-[28px] space-y-0.5">
                {here.map((e) => (
                  <a
                    key={e.id}
                    href={e.htmlLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 border border-indigo-200/60 hover:bg-indigo-200/60 truncate"
                    title={e.summary}
                  >
                    {e.summary}
                  </a>
                ))}
              </div>
            );
          })}
        </div>
      )}

      <div
        className="relative grid grid-cols-[60px_repeat(7,1fr)]"
        style={{ height: `${HOURS * HOUR_PX}px` }}
      >
        <div className="relative">
          {Array.from({ length: HOURS }, (_, i) => {
            const hour = FIRST_HOUR + i;
            return (
              <div
                key={hour}
                className="absolute right-2 -translate-y-1/2 text-[10px] text-ink/45 tabular-nums"
                style={{ top: `${i * HOUR_PX}px` }}
              >
                {fmtHour(hour)}
              </div>
            );
          })}
        </div>
        {weekDays.map((d, dayIdx) => {
          const isToday = ymd(d) === todayKey;
          const dayEvents = events.filter((e) => {
            if (!e.start.dateTime) return false;
            const start = new Date(e.start.dateTime);
            return ymd(start) === ymd(d);
          });
          return (
            <div
              key={dayIdx}
              className={cn(
                "relative border-l border-slate-100",
                isToday && "bg-blue-50/30"
              )}
            >
              {Array.from({ length: HOURS }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => onSlotClick(dayIdx, FIRST_HOUR + i)}
                  className="absolute inset-x-0 border-t border-slate-100 hover:bg-blue-50/50 transition-colors group"
                  style={{ top: `${i * HOUR_PX}px`, height: `${HOUR_PX}px` }}
                  title={`New event at ${fmtHour(FIRST_HOUR + i)}`}
                >
                  <Plus className="w-3 h-3 text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity absolute top-1 left-1" />
                </button>
              ))}
              {isToday && <NowLine />}
              {dayEvents.map((e) => (
                <EventBlock key={e.id} event={e} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EventBlock({ event }: { event: CalendarEvent }) {
  if (!event.start.dateTime || !event.end.dateTime) return null;
  const start = new Date(event.start.dateTime);
  const end = new Date(event.end.dateTime);
  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin = end.getHours() * 60 + end.getMinutes();
  const firstMin = FIRST_HOUR * 60;
  const lastMin = LAST_HOUR * 60;
  // Clip events that fall outside the visible window.
  const topMin = Math.max(firstMin, startMin);
  const botMin = Math.min(lastMin, endMin);
  if (botMin <= topMin) return null;
  const top = ((topMin - firstMin) / 60) * HOUR_PX;
  const height = Math.max(20, ((botMin - topMin) / 60) * HOUR_PX);

  // Tasks-as-events get a different tint than first-class calendar
  // events. We tagged them with a 📝 prefix in task-calendar-sync.
  const isTask = event.summary.startsWith("📝");

  return (
    <a
      href={event.htmlLink}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "absolute inset-x-0.5 z-10 rounded-md px-1.5 py-1 text-[11px] overflow-hidden shadow-sm border transition-all hover:z-20 hover:shadow-md",
        isTask
          ? "bg-fuchsia-100 border-fuchsia-300/70 text-fuchsia-800 hover:bg-fuchsia-200/80"
          : "bg-blue-100 border-blue-300/70 text-blue-800 hover:bg-blue-200/80"
      )}
      style={{ top: `${top}px`, height: `${height}px` }}
      title={`${event.summary} · ${fmtTime(start)} – ${fmtTime(end)}`}
    >
      <div className="font-semibold leading-tight truncate">{event.summary}</div>
      {height > 36 && (
        <div className="text-[10px] opacity-75 leading-tight">
          {fmtTime(start)} – {fmtTime(end)}
        </div>
      )}
    </a>
  );
}

function NowLine() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const now = new Date();
  const min = now.getHours() * 60 + now.getMinutes();
  if (min < FIRST_HOUR * 60 || min > LAST_HOUR * 60) return null;
  const top = ((min - FIRST_HOUR * 60) / 60) * HOUR_PX;
  return (
    <div
      aria-hidden
      className="absolute left-0 right-0 z-20 pointer-events-none"
      style={{ top: `${top}px` }}
    >
      <div className="h-px bg-rose-500" />
      <div className="absolute -left-1 -top-[3.5px] w-2 h-2 rounded-full bg-rose-500" />
    </div>
  );
}

function CreateEventDialog({
  day, hour, onClose, onCreated
}: {
  day: Date;
  hour: number;
  onClose: () => void;
  onCreated: () => void;
}) {
  const startISO = useMemo(() => {
    const d = new Date(day);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  }, [day, hour]);
  const [summary, setSummary] = useState("");
  const [durationMin, setDurationMin] = useState(60);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!summary.trim()) {
      setErr("title required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const endISO = new Date(
        new Date(startISO).getTime() + durationMin * 60_000
      ).toISOString();
      const res = await fetch("/api/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: summary.trim(),
          startISO,
          endISO,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `failed (${res.status})`);
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "couldn't create");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/40 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[420px] max-w-full rounded-2xl border border-slate-200 bg-white shadow-[0_30px_60px_-20px_rgba(15,23,42,0.45)]">
        <div className="px-5 py-4 border-b border-slate-100">
          <div className="text-sm font-semibold inline-flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-accent" />
            New event
          </div>
          <div className="text-[11px] text-ink/55 mt-0.5">
            {day.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
            {" · "}
            {fmtHour(hour)}
          </div>
        </div>
        <div className="p-5 space-y-3">
          <input
            autoFocus
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="What's this about?"
            className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30 focus:border-accent/40"
          />
          <label className="block text-[11px] uppercase tracking-wide text-ink/55 font-semibold">
            Duration
          </label>
          <select
            value={durationMin}
            onChange={(e) => setDurationMin(Number(e.target.value))}
            className="w-full px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-sm outline-none focus:bg-white focus:ring-2 focus:ring-accent/30 focus:border-accent/40"
          >
            <option value={15}>15 minutes</option>
            <option value={30}>30 minutes</option>
            <option value={60}>1 hour</option>
            <option value={90}>1.5 hours</option>
            <option value={120}>2 hours</option>
          </select>
          {err && <div className="text-[12px] text-rose-700">{err}</div>}
        </div>
        <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-end gap-2 bg-slate-50/50">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 rounded-full text-xs font-medium text-ink/70 hover:text-ink hover:bg-white transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold text-white bg-accent hover:bg-accent/90 disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ExternalLink className="w-3.5 h-3.5" />}
            {busy ? "Creating…" : "Add to calendar"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- date helpers ----

function mondayOf(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const dow = x.getDay(); // 0=Sun..6=Sat
  const diff = (dow === 0 ? -6 : 1 - dow);
  x.setDate(x.getDate() + diff);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function pad(n: number): string { return String(n).padStart(2, "0"); }
function fmtHour(h: number): string {
  const ampm = h < 12 ? "am" : "pm";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}${ampm}`;
}
function fmtTime(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h < 12 ? "am" : "pm";
  const display = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${display}${ampm}` : `${display}:${pad(m)}${ampm}`;
}
// Compact "Today · 3pm" / "Tmrw · 9:30am" / "Wed · 9am" label for the
// upcoming-meetings rail.
function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
  const day =
    dayDiff === 0 ? "Today" :
    dayDiff === 1 ? "Tmrw" :
    d.toLocaleDateString(undefined, { weekday: "short" });
  return `${day} · ${fmtTime(d)}`;
}
