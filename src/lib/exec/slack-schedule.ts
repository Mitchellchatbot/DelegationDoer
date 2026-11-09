import { SLACK_READ_LIMITS } from "@/lib/exec/slack-read-types";
import { parseLocalTime, zonedParts } from "@/lib/exec/time";

// P7a sweep work window and due rule (P7a contract §3.4, N6, C14; Area B;
// pure). The sweep handler's due rule, not a scheduler cadence: the sweep is
// registered every 30 minutes and runs a bucket when it falls inside his work
// window, on every sixth bucket outside it (every 3 h), and always when
// enqueued on demand (P8's "right before the brief"). The window is his
// users.weekly_schedule (DD's editor: day key → { start, end } "HH:MM" or
// null) when it holds any usable day, else Monday–Friday 08:00–19:00, always
// in principal.timezone (zonedParts follows the tz database across DST).

export type WeeklySchedule = Partial<Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", { start: string; end: string } | null>>;

type DayKey = keyof WeeklySchedule;
/** ISO weekday (1 = Monday … 7 = Sunday) → the schedule's day key. */
const DAY_KEYS: readonly DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

interface Span { start: number; end: number }

/** A day's usable span in minutes, or null (missing, null, malformed, or zero-length). */
function spanOf(schedule: WeeklySchedule, day: DayKey): Span | null {
  const entry = (schedule as Record<string, unknown>)[day];
  if (entry === null || typeof entry !== "object") return null;
  const { start, end } = entry as { start?: unknown; end?: unknown };
  if (typeof start !== "string" || typeof end !== "string") return null;
  const s = parseLocalTime(start);
  const e = parseLocalTime(end);
  if (s === null || e === null || s === e) return null;
  return { start: s, end: e };
}

/** Non-empty schedule: inside today's {start,end} in tz, or inside yesterday's overnight tail (end < start: [00:00, end) today).
 *  Empty schedule ({} or every day null-free missing): Monday–Friday 08:00–19:00 in tz. Malformed "HH:MM" entries are skipped. */
export function isInWorkWindow(now: Date, tz: string, schedule: WeeklySchedule): boolean {
  const parts = zonedParts(now, tz);
  const minutes = parts.hour * 60 + parts.minute;
  const sched: WeeklySchedule = schedule !== null && typeof schedule === "object" ? schedule : {};
  const spans = DAY_KEYS.map((d) => spanOf(sched, d));
  if (spans.every((s) => s === null)) {
    const start = parseLocalTime(SLACK_READ_LIMITS.workDayStart) ?? 480;
    const end = parseLocalTime(SLACK_READ_LIMITS.workDayEnd) ?? 1140;
    return parts.weekday >= 1 && parts.weekday <= 5 && minutes >= start && minutes < end;
  }
  const today = spans[parts.weekday - 1];
  if (today !== null) {
    // An overnight shift (end < start) covers [start, 24:00) today; a day shift covers [start, end).
    if (today.start < today.end ? minutes >= today.start && minutes < today.end : minutes >= today.start) return true;
  }
  const yesterday = spans[(parts.weekday + 5) % 7];
  return yesterday !== null && yesterday.end < yesterday.start && minutes < yesterday.end;
}

/** forced → true; inWindow → true; else bucket % SLACK_READ_LIMITS.offWindowEvery === 0. */
export function sweepBucketDue(bucket: number, inWindow: boolean, forced: boolean): boolean {
  if (forced || inWindow) return true;
  if (typeof bucket !== "number" || !Number.isSafeInteger(bucket) || bucket < 0) return false;
  return bucket % SLACK_READ_LIMITS.offWindowEvery === 0;
}

const DEDUPE_BUCKET_RE = /^[^:\s]+:[^:\s]+:i([0-9]{1,15})$/;

/** The bucket index from a scheduler key "<kind>:<principal>:i<bucket>" (scheduler.ts:130-136); null when not one. */
export function bucketFromDedupeKey(key: string | null): number | null {
  if (typeof key !== "string") return null;
  const m = DEDUPE_BUCKET_RE.exec(key);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}
