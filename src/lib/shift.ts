// Per-user shift detection used by both the EOD reminder widget and
// the new SOD welcome flow. Anchors all time math to the user's
// `workTimezone` so a worker in PKT and a leader in EST both see
// shift windows that match their local clock.
//
// Defaults — when a user has no `weeklySchedule` or no entry for the
// current weekday — fall through to America/New_York 9:00–18:00, which
// is the office default per the SOD spec.

import type { User } from "@/lib/types";
import { tzOffsetMinutes } from "@/lib/work-hours";

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayKey = typeof DAY_KEYS[number];

export const DEFAULT_TZ = "America/New_York";
export const DEFAULT_SHIFT_START = "09:00";
export const DEFAULT_SHIFT_END = "18:00";

export interface NowInTz {
  hh: number;
  mm: number;
  dayKey: DayKey;
  ymd: string; // YYYY-MM-DD in the supplied timezone
}

// Pulls wall-clock time + local calendar-date for an IANA timezone.
// Server runtimes are UTC so we can't trust new Date().getHours().
export function nowInTz(tz: string): NowInTz {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  const weekday = (parts.weekday ?? "Mon").toLowerCase().slice(0, 3) as DayKey;
  const hh = parseInt(parts.hour ?? "0", 10);
  const mm = parseInt(parts.minute ?? "0", 10);
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  return { hh, mm, dayKey: weekday, ymd };
}

export function parseHHMM(value: string | undefined | null): { hh: number; mm: number } | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return { hh, mm };
}

export interface ShiftWindow {
  start: string;          // "HH:MM"
  end: string;            // "HH:MM"
  startMinutes: number;
  endMinutes: number;
  isDefault: boolean;     // true when we fell back from user.weeklySchedule
}

// Resolve today's shift window for the user. Returns null when the
// user has an explicit schedule and today is marked off (no row for
// this weekday). When the schedule is missing entirely we synthesise
// a 9–6 NY-time window so SOD still fires on a sensible default.
export function todayShiftWindow(
  user: Pick<User, "weeklySchedule" | "workTimezone">,
  now: NowInTz
): ShiftWindow | null {
  const todays = (user.weeklySchedule ?? {})[now.dayKey];
  if (user.weeklySchedule && Object.keys(user.weeklySchedule).length > 0) {
    if (!todays) return null;
    const start = parseHHMM(todays.start);
    const end = parseHHMM(todays.end);
    if (!start || !end) return null;
    return {
      start: todays.start,
      end: todays.end,
      startMinutes: start.hh * 60 + start.mm,
      endMinutes: end.hh * 60 + end.mm,
      isDefault: false
    };
  }
  // No schedule on file — use the office default.
  const start = parseHHMM(DEFAULT_SHIFT_START)!;
  const end = parseHHMM(DEFAULT_SHIFT_END)!;
  return {
    start: DEFAULT_SHIFT_START,
    end: DEFAULT_SHIFT_END,
    startMinutes: start.hh * 60 + start.mm,
    endMinutes: end.hh * 60 + end.mm,
    isDefault: true
  };
}

export interface SodSignal {
  // Identifies the shift day; used as a uniqueness key for the SOD
  // record so the welcome modal only fires once per shift.
  shiftDate: string;     // YYYY-MM-DD in user's local TZ
  withinShift: boolean;  // now >= shiftStart (and ≤ shiftEnd + grace)
  shiftStart: string;
  shiftEnd: string;
  reason: string;        // human-readable trace for /debug pages
}

// Should the user be nudged to do their SOD right now? Centralises the
// "is this a new shift" rule used by /api/sod/today and the welcome
// modal layout gate.
//
// Rule:
//   - If today is a day off (explicit schedule, no row) → no nudge.
//   - If now is before shift start → no nudge (it's pre-shift).
//   - Otherwise → eligible (caller still checks whether they already
//     submitted today via sod_notes).
export function sodSignalFor(
  user: Pick<User, "weeklySchedule" | "workTimezone">
): SodSignal | { withinShift: false; reason: string } {
  const tz = user.workTimezone || DEFAULT_TZ;
  const now = nowInTz(tz);
  const win = todayShiftWindow(user, now);
  if (!win) return { withinShift: false, reason: "day off" };
  const nowMin = now.hh * 60 + now.mm;
  const within = nowMin >= win.startMinutes;
  return {
    shiftDate: now.ymd,
    withinShift: within,
    shiftStart: win.start,
    shiftEnd: win.end,
    reason: within ? "in shift" : "pre-shift"
  };
}

// ── The EOD calendar day ────────────────────────────────────────────
//
// The EOD day boundary is midnight America/New_York for EVERY user,
// regardless of where they work. Deliberately NOT per-user tz (the way
// SOD is above): an EOD filed at 11:30pm ET by a worker in Karachi and
// the leader's digest that reads it have to agree on which day it was,
// and a shared Slack recap can only have one "today".
//
// Before this existed, every EOD read and write derived its date from
// new Date().toISOString().slice(0, 10) — the UTC date. 00:00 UTC is
// 8pm EDT / 7pm EST, so from ~8pm ET the /eod page flipped to
// tomorrow, "submitted today" reset to false, and that evening's
// submission landed on TOMORROW's row — silently overwriting it the
// next morning, since the row id and the (user_id, note_date) key
// moved together and no duplicate-key error ever fired. Workers read
// that as "EOD closes at 9pm". There was never a cutoff.
export const EOD_TZ = DEFAULT_TZ; // "America/New_York"

// YYYY-MM-DD for an instant as observed in `tz`. Assembled from
// formatToParts rather than a locale that happens to emit ISO order,
// so it can't drift with the runtime's ICU data.
export function ymdInTz(at: Date, tz: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Today's EOD calendar date. THE single source of truth for "which day
// is this EOD for" — used on both the server and the client so the two
// can't disagree.
export function eodToday(at: Date = new Date()): string {
  return ymdInTz(at, EOD_TZ);
}

// Absolute UTC instant of 00:00 wall-clock on `ymd` in `tz`.
// DST-correct: New York midnight is 04:00Z (EDT) or 05:00Z (EST)
// depending on the date, and both US transitions happen at 2am, so
// midnight itself is never the skipped/repeated hour. Guess with the
// naive offset, then re-resolve at the candidate instant — the second
// pass is what makes it right across a transition, where the naive
// guess (which lands in the *previous* evening) can read the other
// side's offset.
function zonedDayStart(ymd: string, tz: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0);
  const pass1 = naive - tzOffsetMinutes(new Date(naive), tz) * 60_000;
  const pass2 = naive - tzOffsetMinutes(new Date(pass1), tz) * 60_000;
  return new Date(pass2);
}

// YYYY-MM-DD + n days as pure calendar arithmetic (no timezone
// involved). Use this to walk EOD dates — going through Date/ms
// arithmetic instead re-introduces the offset bugs this module exists
// to avoid, and silently skips or repeats a day across a DST change.
export function addDaysToYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// Half-open [start, end) UTC instants covering the ET calendar day
// `ymd`. Bounds the timestamptz range queries (tasks.completed_at,
// time_entries.started_at) so they agree with the note_date equality
// lookups they're joined against.
//
// Takes a ymd STRING, never a Date, on purpose: new Date("2026-08-14")
// is midnight *UTC*, whose ET date is Aug 13 — passing Dates around is
// exactly how the off-by-one this fixes got in.
//
// Spans 23h on spring-forward and 25h on fall-back. That's correct —
// those days really are that long.
export function eodDayRange(ymd: string): { startIso: string; endIso: string } {
  return {
    startIso: zonedDayStart(ymd, EOD_TZ).toISOString(),
    endIso: zonedDayStart(addDaysToYmd(ymd, 1), EOD_TZ).toISOString()
  };
}
