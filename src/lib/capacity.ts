import type { Task, User } from "./types";

export interface CapacityInfo {
  user: User;
  usedHours: number;
  available: number;
  pct: number; // 0..1
  overBuffer: boolean; // > 85%
  overSoft: boolean; // > 80%
}

export function userCapacity(user: User, openTasks: Task[]): CapacityInfo {
  const mine = openTasks.filter(
    (t) => t.assigneeId === user.id && t.status !== "done" && t.status !== "waiting_on_client"
  );
  const usedHours = mine.reduce((s, t) => s + Math.max(0, t.estimatedHours - t.actualHours), 0);
  const pct = Math.min(2, usedHours / Math.max(1, user.dailyCapacity));
  return {
    user,
    usedHours,
    available: Math.max(0, user.dailyCapacity - usedHours),
    pct,
    overSoft: pct >= 0.8,
    overBuffer: pct >= 0.85
  };
}

export function etaDays(estimateHours: number, capInfo: CapacityInfo): number {
  const remainingToday = capInfo.available;
  if (estimateHours <= remainingToday) return 1; // today + buffer
  const after = estimateHours - remainingToday;
  const fullDays = Math.ceil(after / Math.max(1, capInfo.user.dailyCapacity));
  return 1 + fullDays + 1; // start day + work days + 1 buffer day
}

// Compute an absolute deadline ISO string from a work-hours estimate plus the
// assignee's daily capacity. Two regimes:
//   - estimate ≤ daily capacity: tight, proportional to the estimate.
//     2 × estimate + 1h buffer, minimum 2h. (A 2h task gets ~5h of runway.)
//   - estimate > daily capacity: spread over multiple days, accounting for
//     the fact that a person can't actually work 24h straight.
//     (estimate / capacity) days × 24h elapsed + 4h buffer.
//     (A 16h task with 8h/day capacity gets ~52h ≈ 2 days + buffer.)
//
// Stored as UTC timestamptz; viewers in other timezones see the same absolute
// moment shifted to their own wall clock.
export function deadlineFromEstimate(
  estimateHours: number,
  dailyCapacity: number = 8,
  fromMs: number = Date.now()
): string {
  const cap = Math.max(1, dailyCapacity);
  let elapsedHours: number;
  if (estimateHours <= cap) {
    elapsedHours = Math.max(2, estimateHours * 2 + 1);
  } else {
    elapsedHours = (estimateHours / cap) * 24 + 4;
  }
  return new Date(fromMs + elapsedHours * 3_600_000).toISOString();
}
