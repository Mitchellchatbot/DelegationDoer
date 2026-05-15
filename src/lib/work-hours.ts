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

// HH:MM end - HH:MM start. Treats end < start (overnight) as zero
// rather than negative — the editor doesn't allow it and we don't
// want a stray entry to skew capacity.
function hoursBetween(start: string, end: string): number {
  const a = hmToMinutes(start);
  const b = hmToMinutes(end);
  if (a == null || b == null) return 0;
  if (b <= a) return 0;
  return (b - a) / 60;
}

function hmToMinutes(s: string): number | null {
  const m = /^([0-2]?\d):([0-5]\d)$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23) return null;
  return h * 60 + mm;
}
