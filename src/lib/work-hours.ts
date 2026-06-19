// Convert a "HH:MM in some IANA timezone" → a moment in absolute UTC →
// formatted in the viewer's local timezone. Lets a 7–2 Karachi
// schedule display as 10pm–5am to an EST viewer without needing
// date-fns-tz or any other dep.

// Get the UTC offset (in minutes) for a given IANA timezone at a
// specific moment. Handles DST automatically because it asks Intl
// what the offset is *at that instant*. e.g. "America/New_York"
// returns -300 in summer (EDT) and -240 isn't right — wait, -300 in
// winter, -240 in summer. Correct.
function tzOffsetMinutes(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0; // Intl edge case: midnight shows as "24"
  const asLocalMs = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    hour,
    Number(get("minute")),
    Number(get("second"))
  );
  return Math.round((asLocalMs - date.getTime()) / 60_000);
}

// "HH:MM in sourceTz, today" → absolute UTC Date. Today is "now in
// sourceTz" so cross-midnight conversion lands on the right side.
function hhmmInTzToUtc(hhmm: string, tz: string, anchor = new Date()): Date | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const h = Math.max(0, Math.min(23, Number(match[1])));
  const m = Math.max(0, Math.min(59, Number(match[2])));
  // Use the date components of "anchor as observed in sourceTz".
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(anchor);
  const get = (t: string) => Number(dateParts.find((p) => p.type === t)?.value ?? "0");
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  // Pretend the requested HH:MM is in UTC; then subtract the source
  // timezone's offset at that moment to get the real UTC instant.
  const naive = new Date(Date.UTC(y, mo - 1, d, h, m, 0));
  const offset = tzOffsetMinutes(naive, tz);
  return new Date(naive.getTime() - offset * 60_000);
}

// Format a Date for display as "h:mm AM/PM" in a given timezone.
export function formatHHMMInViewerTz(
  hhmm: string,
  sourceTz: string,
  viewerTz?: string
): string {
  const utc = hhmmInTzToUtc(hhmm, sourceTz);
  if (!utc) return hhmm;
  const tz = viewerTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return utc.toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit"
  });
}

// Short timezone abbreviation for the viewer's tz, e.g. "EST", "PKT".
// Used to clarify which local zone a converted time is in.
export function viewerTzAbbrev(viewerTz?: string): string {
  const tz = viewerTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "short"
  }).formatToParts(new Date());
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}

// Friendly label for a user's own work hours, e.g. "Asia/Karachi" →
// "Karachi". Falls back to the raw tz name when there's no city.
export function tzShortLabel(tz: string): string {
  if (!tz) return "";
  const slash = tz.lastIndexOf("/");
  return slash >= 0 ? tz.slice(slash + 1).replace(/_/g, " ") : tz;
}

// Try to guess the user's timezone. Browser-side this is always
// available; server-side it falls back to UTC.
export function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// Three-letter day key used by user.weeklySchedule.
export type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

// Map JS Date.getDay() (0=Sun..6=Sat) to our schedule key.
const DAY_BY_WEEKDAY: DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Return which DayKey it is right now in the user's working timezone.
// Falls back to UTC. Computing day-of-week in tz is needed because a
// user in Karachi at 1am Saturday is still on "Saturday" — server's
// UTC clock would say Friday and call them on for work.
export function dayKeyInTz(date: Date, tz: string | null | undefined): DayKey {
  const zone = tz ?? "UTC";
  try {
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short"
    }).format(date);
    // "Mon", "Tue", … → lower-case our 3-letter key.
    const k = weekday.slice(0, 3).toLowerCase() as DayKey;
    if (DAY_BY_WEEKDAY.includes(k)) return k;
  } catch {
    /* fall through to local */
  }
  return DAY_BY_WEEKDAY[date.getDay()];
}

// Hours scheduled for a given day. Reads weeklySchedule first; if the
// schedule is empty (default state), falls back to dailyCapacity for
// Mon–Fri and 0 for weekends — mirroring the "Same every weekday" mode.
// Returns 0 for off days so callers can reason about "this person isn't
// working today" without a special case.
export function hoursForDay(args: {
  dayKey: DayKey;
  dailyCapacity: number;
  weeklySchedule?: Partial<Record<DayKey, { start: string; end: string } | null>>;
}): number {
  const sched = args.weeklySchedule ?? {};
  const hasCustom = Object.keys(sched).length > 0;
  if (hasCustom) {
    const block = sched[args.dayKey];
    if (!block) return 0;
    return hoursBetween(block.start, block.end);
  }
  // Default: weekdays use dailyCapacity, weekends off.
  if (args.dayKey === "sat" || args.dayKey === "sun") return 0;
  return Math.max(0, args.dailyCapacity || 0);
}

// HH:MM end - HH:MM start. When end is at or before start the block is an
// overnight shift that wraps past midnight (e.g. 19:00–03:00 = 8h), so we
// add a day's worth of minutes. end === start is treated as a misconfigured
// zero-length block rather than a 24h shift.
function hoursBetween(start: string, end: string): number {
  const a = hmToMinutes(start);
  const b = hmToMinutes(end);
  if (a == null || b == null) return 0;
  if (b === a) return 0;
  const span = b > a ? b - a : b + 1440 - a; // wrap past midnight for overnight shifts
  return span / 60;
}

function hmToMinutes(s: string): number | null {
  const m = /^([0-2]?\d):([0-5]\d)$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23) return null;
  return h * 60 + mm;
}

// Current minutes-since-midnight in the given IANA timezone. Server
// runtimes are UTC, so we ask Intl what wall-clock time the user sees
// rather than trusting new Date().getHours().
function minutesOfDayInTz(date: Date, tz: string | null | undefined): number {
  const zone = tz ?? "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(date);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
    let hh = get("hour");
    if (hh === 24) hh = 0; // Intl edge case: midnight can show as "24"
    return hh * 60 + get("minute");
  } catch {
    return date.getHours() * 60 + date.getMinutes();
  }
}

// The schedule block on file for a given day, unifying both editor modes:
// an explicit weekly_schedule wins; otherwise the flat work_hours_start/end
// columns apply Mon–Fri ("Same every weekday") with weekends off. Returns
// null when there's no block to read (day off, or no explicit hours set).
// NOTE: only used to *detect* an overnight shift; the hours themselves come
// from hoursForDay() so flat-mode semantics (Mon–Fri → dailyCapacity even
// when no start/end is on file) are preserved exactly.
function blockForDay(
  dayKey: DayKey,
  args: {
    weeklySchedule?: Partial<Record<DayKey, { start: string; end: string } | null>>;
    flatStart?: string | null;
    flatEnd?: string | null;
  }
): { start: string; end: string } | null {
  const sched = args.weeklySchedule ?? {};
  if (Object.keys(sched).length > 0) {
    return sched[dayKey] ?? null;
  }
  if (dayKey === "sat" || dayKey === "sun") return null;
  if (args.flatStart && args.flatEnd) {
    return { start: args.flatStart, end: args.flatEnd };
  }
  return null;
}

// If the given day's shift wraps past midnight (end < start), return its
// end time in minutes-of-day; otherwise null. Used to recognise that we're
// in the early-morning tail of a shift that started the night before.
function overnightEndMinutes(
  dayKey: DayKey,
  args: {
    weeklySchedule?: Partial<Record<DayKey, { start: string; end: string } | null>>;
    flatStart?: string | null;
    flatEnd?: string | null;
  }
): number | null {
  const block = blockForDay(dayKey, args);
  if (!block) return null;
  const s = hmToMinutes(block.start);
  const e = hmToMinutes(block.end);
  if (s == null || e == null || e >= s) return null; // not overnight
  return e;
}

// Scheduled hours for the shift currently in effect, anchored to the user's
// timezone and overnight-aware. The post-midnight tail of an overnight
// shift (e.g. 12–3 AM Saturday for a 7 PM–3 AM Fri shift) belongs to the
// day the shift *started*, not the current calendar day — so plain
// dayKeyInTz()/hoursForDay() would wrongly report an off day.
//
// Behaviour is identical to hoursForDay(dayKeyInTz(now)) for every user
// EXCEPT one who is currently inside the post-midnight tail of an overnight
// shift; only then do we credit yesterday's hours instead of today's.
// Used by /api/clock for the "Workday remaining" bar.
export function scheduledHoursForActiveShift(args: {
  now: Date;
  tz: string | null | undefined;
  dailyCapacity: number;
  weeklySchedule?: Partial<Record<DayKey, { start: string; end: string } | null>>;
  flatStart?: string | null; // work_hours_start (used when weeklySchedule is empty)
  flatEnd?: string | null; // work_hours_end
}): number {
  const todayKey = dayKeyInTz(args.now, args.tz);
  const prevKey = DAY_BY_WEEKDAY[(DAY_BY_WEEKDAY.indexOf(todayKey) + 6) % 7];

  // In yesterday's overnight tail? (before yesterday's shift end time today)
  const yEnd = overnightEndMinutes(prevKey, args);
  if (yEnd != null && minutesOfDayInTz(args.now, args.tz) < yEnd) {
    return hoursForDay({
      dayKey: prevKey,
      dailyCapacity: args.dailyCapacity,
      weeklySchedule: args.weeklySchedule
    });
  }
  return hoursForDay({
    dayKey: todayKey,
    dailyCapacity: args.dailyCapacity,
    weeklySchedule: args.weeklySchedule
  });
}
