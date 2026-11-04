// Time-zone math for the assistant (pure, no I/O).
//
// Everything that is "per day" or "at 08:00" is evaluated in the principal's
// IANA zone, never the server's (Railway runs UTC). Built on Intl only, so it
// follows the runtime's tz database across DST changes.

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short"
    });
    partsFormatterCache.set(tz, f);
  }
  return f;
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
  /** ISO weekday: 1 = Monday … 7 = Sunday */
  weekday: number;
}

/** Wall-clock fields of `date` in `tz`. */
export function zonedParts(date: Date, tz: string): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAY[out.weekday] ?? 1
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "YYYY-MM-DD" of `date` in `tz`. */
export function localDateString(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** Minutes since local midnight of `date` in `tz` (0–1439). */
export function localMinutes(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  return p.hour * 60 + p.minute;
}

/** "HH:MM" → minutes, or null when malformed. */
export function parseLocalTime(hhmm: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** True once the local wall clock in `tz` has reached `hhmm` today. */
export function isLocalTimeReached(date: Date, tz: string, hhmm: string): boolean {
  const target = parseLocalTime(hhmm);
  if (target === null) return false;
  return localMinutes(date, tz) >= target;
}

/** Offset of `tz` from UTC at instant `date`, in minutes (e.g. -300 for EST). */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const secondsTruncated = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - secondsTruncated) / 60_000);
}

/**
 * The UTC instant of local midnight (00:00) on the local date that contains
 * `date` in `tz`. DST-safe: the offset is re-read at the candidate instant.
 */
export function startOfLocalDayUtc(date: Date, tz: string): Date {
  const p = zonedParts(date, tz);
  const wallMidnightAsUtc = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  // First guess with today's offset, then correct with the offset at the guess
  // (they differ only when a DST change happens between midnight and now).
  let guess = wallMidnightAsUtc - tzOffsetMinutes(date, tz) * 60_000;
  guess = wallMidnightAsUtc - tzOffsetMinutes(new Date(guess), tz) * 60_000;
  return new Date(guess);
}

/** ISO-8601 week key of `date` in `tz`, e.g. "2026-W45". */
export function isoWeekKey(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  // Work on the local calendar date as if it were UTC (pure date math).
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dayNum = p.weekday; // 1..7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday of this ISO week
  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${pad(week)}`;
}

/** Fixed-width time bucket number for interval work: floor(epochMinutes / minutes). */
export function intervalBucket(date: Date, minutes: number): number {
  const m = Math.max(1, Math.floor(minutes));
  return Math.floor(date.getTime() / 60_000 / m);
}
