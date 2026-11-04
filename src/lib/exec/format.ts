// Display strings for the exec UI (pure, no I/O, safe in client bundles).
//
// The page computes every string on the server, in the principal's zone, from
// one `now` it hands down. Nothing here reads the runtime's zone or clock:
// Railway runs UTC, so a server-local date is tomorrow's after 8 pm ET, and a
// browser formatting the same instant in its own zone would disagree with the
// server's HTML.

export type ZoneFormat = "date" | "datetime" | "time";

/** Stands in for a value that's missing or unreadable. Never a zero. */
export const MISSING = "—";

// The zone principal.ts falls back to. Intl throws a RangeError on a zone it
// doesn't know, and a formatter must never take the page down, so an unknown
// zone formats in this one. Times carry "EST"/"EDT", which says so.
const FALLBACK_TZ = "America/New_York";

// "YYYY-MM-DD" with nothing after it is a calendar date (a due date, an EOD
// note day), not an instant. new Date() would read it as UTC midnight, which
// is the evening before in every US zone.
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string, mode: ZoneFormat, withYear: boolean): Intl.DateTimeFormat {
  const key = `${tz}|${mode}|${withYear ? "y" : ""}`;
  let f = formatters.get(key);
  if (!f) {
    const options: Intl.DateTimeFormatOptions = { timeZone: tz };
    if (mode !== "time") {
      options.month = "short";
      options.day = "numeric";
      if (withYear) options.year = "numeric";
    }
    if (mode !== "date") {
      options.hour = "numeric";
      options.minute = "2-digit";
      options.timeZoneName = "short";
    }
    f = new Intl.DateTimeFormat("en-US", options);
    formatters.set(key, f);
  }
  return f;
}

function safeFormatter(tz: string, mode: ZoneFormat, withYear: boolean): Intl.DateTimeFormat {
  try {
    return formatter(tz, mode, withYear);
  } catch {
    return formatter(FALLBACK_TZ, mode, withYear);
  }
}

function localYear(date: Date, tz: string): string {
  return safeFormatter(tz, "date", true)
    .formatToParts(date)
    .find((p) => p.type === "year")?.value ?? "";
}

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * An instant as the principal reads it: "Nov 4" (date), "Nov 4, 8:02 AM EST"
 * (datetime) or "8:02 AM EST" (time), in `tz`. Never throws; missing or
 * unreadable input gives "—".
 *
 * Pass `now` (the page's) to add the year to a date outside the current one:
 * without it, a task due last December reads as "Dec 15" and looks upcoming.
 *
 * A bare "YYYY-MM-DD" is formatted as that calendar date, whatever the zone.
 * It has no time of day, so "time" gives "—" and "datetime" the date alone.
 */
export function formatInZone(
  iso: string | null | undefined,
  tz: string,
  mode: ZoneFormat = "datetime",
  now?: Date | string
): string {
  if (typeof iso !== "string" || iso === "") return MISSING;
  const nowDate = toDate(now);

  const ymd = DATE_ONLY.exec(iso);
  if (ymd) {
    if (mode === "time") return MISSING;
    const [year, month, day] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    // Date.UTC rolls "2026-02-30" over into March; that string isn't a date.
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      return MISSING;
    }
    const withYear = nowDate !== null && localYear(nowDate, tz) !== String(year);
    return safeFormatter("UTC", "date", withYear).format(date);
  }

  const date = toDate(iso);
  if (!date) return MISSING;
  const withYear = mode !== "time" && nowDate !== null && localYear(nowDate, tz) !== localYear(date, tz);
  return safeFormatter(tz, mode, withYear).format(date);
}

/**
 * How long ago `fromIso` was at `now`: "just now", "5 min", "3 h" or "4 d".
 * The bare duration, so a caller never builds "just now ago". A timestamp
 * slightly in the future (clock skew between Postgres and this server) reads
 * as "just now". Missing or unreadable input gives "—".
 */
export function ageLabel(fromIso: string | null | undefined, now: Date | string): string {
  const from = toDate(fromIso);
  const to = toDate(now);
  if (!from || !to) return MISSING;
  const minutes = Math.floor((to.getTime() - from.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** "1,204", or "—" for null and non-finite input. A fraction keeps one decimal rather than rounding to a different count. */
export function formatCount(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return MISSING;
  return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

/** "1 task", "3 tasks", "2 people" (with `plural`). The count is formatted by formatCount. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : plural}`;
}
