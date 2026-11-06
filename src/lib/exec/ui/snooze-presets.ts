import { tzOffsetMinutes, zonedParts } from "@/lib/exec/time";

// The snooze menu's presets (P5a contract C4): "3 hours", "Tomorrow 8:00",
// "Monday 8:00" and "In a week, 8:00", computed in the browser at click time,
// in his zone. Pure and client-safe (time.ts is Intl only), so the feed's
// client component builds them from the clock it has when he opens the menu.
//
// C4's bounds hold for every preset handed out: later than now + 60 s and no
// later than now + 90 days (the route checks them again). Wall-clock 8:00 is
// resolved through the zone's offset at that instant, so a preset across a
// DST change still lands on 8:00 local, not 7:00 or 9:00.

export type SnoozePresetKey = "3h" | "tomorrow" | "monday" | "week";

export interface SnoozePreset {
  key: SnoozePresetKey;
  label: string;
  /** ISO instant (toISOString form). */
  until: string;
}

const FALLBACK_TZ = "America/New_York";
const MIN_AHEAD_MS = 60_000;
const MAX_AHEAD_MS = 90 * 24 * 3_600_000;
const MORNING_HOUR = 8;

function usableZone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0);
    return tz;
  } catch {
    return FALLBACK_TZ;
  }
}

/** The local calendar date `days` after the local date of `now` in `tz`, plus its ISO weekday. */
function localDatePlus(now: Date, tz: string, days: number): { year: number; month: number; day: number; weekday: number } {
  const p = zonedParts(now, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  const weekday = ((p.weekday - 1 + days) % 7 + 7) % 7 + 1;
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday };
}

/** The UTC instant of wall-clock `hour`:00 on a local date in `tz` (offset re-read at the guess, as startOfLocalDayUtc does). */
export function localWallTimeUtc(date: { year: number; month: number; day: number }, hour: number, tz: string): Date {
  const wallAsUtc = Date.UTC(date.year, date.month - 1, date.day, hour, 0, 0);
  let guess = wallAsUtc - tzOffsetMinutes(new Date(wallAsUtc), tz) * 60_000;
  guess = wallAsUtc - tzOffsetMinutes(new Date(guess), tz) * 60_000;
  return new Date(guess);
}

/**
 * The four presets for `now` in `tz` (an unknown zone uses America/New_York):
 *   3 hours          now + 3 h
 *   Tomorrow 8:00    the next local day at 8:00
 *   Monday 8:00      the next Monday after today at 8:00 (on a Monday: the one a week on)
 *   In a week, 8:00  the local date 7 days on, at 8:00
 * A preset that would fall outside C4's bounds is left out.
 */
export function snoozePresets(now: Date, tz: string): SnoozePreset[] {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return [];
  const zone = usableZone(tz);
  const today = zonedParts(now, zone);
  const daysToMonday = ((1 - today.weekday + 7) % 7) || 7;
  const at8 = (days: number) => localWallTimeUtc(localDatePlus(now, zone, days), MORNING_HOUR, zone);
  const candidates: { key: SnoozePresetKey; label: string; at: Date }[] = [
    { key: "3h", label: "3 hours", at: new Date(now.getTime() + 3 * 3_600_000) },
    { key: "tomorrow", label: "Tomorrow 8:00", at: at8(1) },
    { key: "monday", label: "Monday 8:00", at: at8(daysToMonday) },
    { key: "week", label: "In a week, 8:00", at: at8(7) }
  ];
  const nowMs = now.getTime();
  return candidates
    .filter((c) => c.at.getTime() > nowMs + MIN_AHEAD_MS && c.at.getTime() <= nowMs + MAX_AHEAD_MS)
    .map((c) => ({ key: c.key, label: c.label, until: c.at.toISOString() }));
}
