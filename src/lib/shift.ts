// Per-user shift detection used by both the EOD reminder widget and
// the new SOD welcome flow. Anchors all time math to the user's
// `workTimezone` so a worker in PKT and a leader in EST both see
// shift windows that match their local clock.
//
// Defaults — when a user has no `weeklySchedule` or no entry for the
// current weekday — fall through to America/New_York 9:00–18:00, which
// is the office default per the SOD spec.

import type { User } from "@/lib/types";

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
// `at` defaults to now; pass an explicit instant to look at another
// moment (e.g. "yesterday" for overnight-shift resolution).
export function nowInTz(tz: string, at: Date = new Date()): NowInTz {
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
    fmt.formatToParts(at).map((p) => [p.type, p.value])
  );
  const weekday = (parts.weekday ?? "Mon").toLowerCase().slice(0, 3) as DayKey;
  let hh = parseInt(parts.hour ?? "0", 10);
  if (hh === 24) hh = 0; // Intl edge case: midnight can format as "24"
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
  crossesMidnight: boolean; // end ≤ start, e.g. 19:00 → 03:00
  isDefault: boolean;     // true when we fell back from user.weeklySchedule
}

interface ScheduleBlock { start: string; end: string }

// Parse a {start,end} schedule block into a window with minute offsets,
// flagging overnight (end ≤ start) blocks. Returns null when either
// time is unparseable.
function windowFromBlock(block: ScheduleBlock | null | undefined): Omit<ShiftWindow, "isDefault"> | null {
  if (!block) return null;
  const start = parseHHMM(block.start);
  const end = parseHHMM(block.end);
  if (!start || !end) return null;
  const startMinutes = start.hh * 60 + start.mm;
  const endMinutes = end.hh * 60 + end.mm;
  return {
    start: block.start,
    end: block.end,
    startMinutes,
    endMinutes,
    crossesMidnight: endMinutes <= startMinutes
  };
}

// Resolve today's shift window for the user. Returns null when the
// user has an explicit schedule and today is marked off (no row for
// this weekday). When the schedule is missing entirely we synthesise
// a 9–6 NY-time window so SOD still fires on a sensible default.
export function todayShiftWindow(
  user: Pick<User, "weeklySchedule" | "workTimezone">,
  now: NowInTz
): ShiftWindow | null {
  if (user.weeklySchedule && Object.keys(user.weeklySchedule).length > 0) {
    const win = windowFromBlock(user.weeklySchedule[now.dayKey]);
    if (!win) return null;
    return { ...win, isDefault: false };
  }
  // No schedule on file — use the office default (never overnight).
  const win = windowFromBlock({ start: DEFAULT_SHIFT_START, end: DEFAULT_SHIFT_END })!;
  return { ...win, isDefault: true };
}

export interface ResolvedShift {
  // YYYY-MM-DD of the shift's START day, in the worker's timezone. For an
  // overnight shift this stays pinned to the evening it began even after
  // midnight, so a once-per-shift key (SOD note_date) never splits in two.
  shiftDate: string;
  start: string;
  end: string;
  startMinutes: number;
  endMinutes: number;
  crossesMidnight: boolean;
  withinShift: boolean;  // now ∈ [start, end), wrap-aware
  isDefault: boolean;
  reason: string;
}

// Resolve the shift that the instant `at` belongs to for this user,
// correctly handling overnight (cross-midnight) schedules.
//
// Three cases, checked in order:
//   1. After midnight, still inside *yesterday's* overnight shift
//      (e.g. 01:00 on a 19:00→03:00 block) → that shift, dated yesterday.
//   2. Today has a shift → today's shift. For an overnight block only the
//      evening portion [start, midnight) counts as "today"; the morning
//      portion is reached via case 1 on the following calendar day.
//   3. Today is off and we're not in yesterday's tail → null.
//
// Returns null only for "off / no shift right now".
export function resolveShift(
  user: Pick<User, "weeklySchedule" | "workTimezone">,
  at: Date = new Date()
): ResolvedShift | null {
  const tz = user.workTimezone || DEFAULT_TZ;
  const sched = user.weeklySchedule ?? {};
  const hasCustom = Object.keys(sched).length > 0;
  const now = nowInTz(tz, at);
  const nowMin = now.hh * 60 + now.mm;

  if (!hasCustom) {
    const win = windowFromBlock({ start: DEFAULT_SHIFT_START, end: DEFAULT_SHIFT_END })!;
    const within = nowMin >= win.startMinutes && nowMin < win.endMinutes;
    return {
      shiftDate: now.ymd,
      ...win,
      withinShift: within,
      isDefault: true,
      reason: within ? "in shift" : nowMin < win.startMinutes ? "pre-shift" : "after shift"
    };
  }

  // Case 1: morning tail of yesterday's overnight shift.
  const yest = nowInTz(tz, new Date(at.getTime() - 86_400_000));
  const yWin = windowFromBlock(sched[yest.dayKey]);
  if (yWin && yWin.crossesMidnight && nowMin < yWin.endMinutes) {
    return {
      shiftDate: yest.ymd,
      ...yWin,
      withinShift: true,
      isDefault: false,
      reason: "in shift (overnight, after midnight)"
    };
  }

  // Case 2 / 3: today's shift, or off.
  const tWin = windowFromBlock(sched[now.dayKey]);
  if (!tWin) {
    return null;
  }
  const within = tWin.crossesMidnight
    ? nowMin >= tWin.startMinutes // evening portion; morning handled by case 1 next day
    : nowMin >= tWin.startMinutes && nowMin < tWin.endMinutes;
  return {
    shiftDate: now.ymd,
    ...tWin,
    withinShift: within,
    isDefault: false,
    reason: within
      ? tWin.crossesMidnight ? "in shift (overnight, before midnight)" : "in shift"
      : nowMin < tWin.startMinutes ? "pre-shift" : "after shift"
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
  const shift = resolveShift(user);
  if (!shift) return { withinShift: false, reason: "day off" };
  return {
    shiftDate: shift.shiftDate,
    withinShift: shift.withinShift,
    shiftStart: shift.start,
    shiftEnd: shift.end,
    reason: shift.reason
  };
}
