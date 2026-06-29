// Per-user shift detection used by both the EOD reminder widget and
// the new SOD welcome flow. Anchors all time math to the user's
// `workTimezone` so a worker in PKT and a leader in EST both see
// shift windows that match their local clock.
//
// Defaults — when a user has no `weeklySchedule` or no entry for the
// current weekday — fall through to America/New_York 9:00–18:00, which
// is the office default per the SOD spec.

import type { User } from "@/lib/types";

export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
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
