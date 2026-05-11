import type { Task, User } from "./types";

export interface CapacityInfo {
  user: User;
  // Hours of remaining work assigned, capped at the user's daily capacity
  // so all displays stay bounded at 100%. Overflow surfaces as
  // `backlogHours`.
  usedHours: number;
  // Daily-capacity-minus-used (legacy semantics: how much of a full
  // workday's worth of commitments remains). Still useful for "how
  // overbooked is this person" comparisons.
  available: number;
  pct: number; // 0..1
  // Overflow beyond `dailyCapacity` when commitments outstrip a day's
  // capacity — 0 when at-or-under.
  backlogHours: number;
  overBuffer: boolean; // > 85%
  overSoft: boolean; // > 80%
  // -------- workday-remaining model --------
  // Hours already clocked today (sum of all segments today, including the
  // live-running one). 0 when no time entries exist yet.
  hoursOnShiftToday: number;
  // How many hours of the workday are still available — i.e. dailyCapacity
  // minus what's already been worked. This is the *truth* number for "can
  // this person take on more today?"; the old `available` was a
  // commitments-based estimate.
  workdayRemaining: number;
  // workdayRemaining minus the remaining task estimates. Negative ⇒ the
  // person can't realistically finish all assigned work today even if they
  // stop everything else; positive ⇒ slack.
  realAvailable: number;
}

// userCapacity — `hoursOnShiftToday` is optional so legacy callers keep
// working. Pass it (from `getHoursOnShiftToday(userId)` server-side or
// `/api/clock` client-side) to get the workday-remaining numbers populated.
export function userCapacity(
  user: User,
  openTasks: Task[],
  hoursOnShiftToday: number = 0
): CapacityInfo {
  const mine = openTasks.filter(
    (t) => t.assigneeId === user.id && t.status !== "done" && t.status !== "waiting_on_client"
  );
  const dailyCapacity = Math.max(1, user.dailyCapacity);
  const rawUsedHours = mine.reduce(
    (s, t) => s + Math.max(0, t.estimatedHours - t.actualHours),
    0
  );
  const usedHours = Math.min(rawUsedHours, dailyCapacity);
  const backlogHours = Math.max(0, rawUsedHours - dailyCapacity);
  const pct = usedHours / dailyCapacity;
  const workdayRemaining = Math.max(0, dailyCapacity - Math.max(0, hoursOnShiftToday));
  return {
    user,
    usedHours,
    available: Math.max(0, dailyCapacity - usedHours),
    pct,
    backlogHours,
    overSoft: pct >= 0.8,
    overBuffer: pct >= 0.85,
    hoursOnShiftToday: Math.max(0, hoursOnShiftToday),
    workdayRemaining,
    realAvailable: workdayRemaining - rawUsedHours
  };
}

export function etaDays(estimateHours: number, capInfo: CapacityInfo): number {
  // Prefer the workday-remaining number when it's been populated; falls
  // back to commitment-based "available" otherwise. This is what lets ETAs
  // shorten as the day goes on once time is logged.
  const remainingToday =
    capInfo.hoursOnShiftToday > 0 ? capInfo.workdayRemaining : capInfo.available;
  if (estimateHours <= remainingToday) return 1;
  const after = estimateHours - remainingToday;
  const fullDays = Math.ceil(after / Math.max(1, capInfo.user.dailyCapacity));
  return 1 + fullDays + 1;
}

// Compute an absolute deadline ISO string from a work-hours estimate plus the
// assignee's daily capacity. Two regimes:
//   - estimate ≤ daily capacity: tight, proportional to the estimate.
//     2 × estimate + 1h buffer, minimum 2h.
//   - estimate > daily capacity: spread over multiple days.
//     (estimate / capacity) days × 24h elapsed + 4h buffer.
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
