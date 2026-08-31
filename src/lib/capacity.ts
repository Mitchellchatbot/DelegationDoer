import type { Task, User } from "./types";
import { dayKeyInTz, hoursForDay } from "./work-hours";

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
// Effective hours-per-day for the load math. When the user has a
// weekly_schedule set, this returns the hours configured for *today*
// in their timezone (off days → 0, short days → fewer hours). When
// the schedule is empty, falls back to user.dailyCapacity on
// weekdays and 0 on weekends, mirroring the "Same every weekday"
// default in the editor.
//
// Floors the result at 1 so a Sunday-off user doesn't divide-by-zero
// when generating pct numbers. For "is this person working today?"
// callers should branch on the raw hours via hoursForDay() instead.
function effectiveCapacityForToday(user: User, now: Date = new Date()): number {
  const dayKey = dayKeyInTz(now, user.workTimezone ?? null);
  const raw = hoursForDay({
    dayKey,
    dailyCapacity: user.dailyCapacity,
    weeklySchedule: user.weeklySchedule
  });
  return Math.max(1, raw);
}

export function userCapacity(
  user: User,
  openTasks: Task[],
  hoursOnShiftToday: number = 0
): CapacityInfo {
  const mine = openTasks.filter(
    (t) => t.assigneeId === user.id && t.status !== "done" && t.status !== "waiting_on_client"
  );
  // NOTE: unclaimed work queued to this user's department is deliberately NOT
  // counted here. Nobody has started it, so folding it into personal load
  // would push every member of a busy team past overBuffer at once — and
  // lib/delegation.ts filters out anyone over that line, so the ranker would
  // stop routing work to the very team that has a backlog. A surface that
  // wants to show "your team also has N hours waiting" should compute it
  // there, against a task list and a roster that actually carry department
  // membership (getAllUsersLight, which feeds the routing paths, does not).
  // Today's hours, schedule-aware. The pct/load bars now shrink when
  // a teammate is on a short day, so a 3h Wednesday with 3h of work
  // reads as 100% even though the flat dailyCapacity column is 8h.
  const dailyCapacity = effectiveCapacityForToday(user);
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
  // Walk the user's actual schedule forward day-by-day instead of
  // assuming every future day is dailyCapacity. Off days don't burn
  // estimate; short days only burn what they hold.
  const remainingToday =
    capInfo.hoursOnShiftToday > 0 ? capInfo.workdayRemaining : capInfo.available;
  if (estimateHours <= remainingToday) return 1;

  const user = capInfo.user;
  let remaining = estimateHours - remainingToday;
  let days = 1;
  const cursor = new Date();
  // Cap at ~12 weeks so a misconfigured 0-hours schedule can't infinite-loop.
  for (let i = 0; i < 84 && remaining > 0; i++) {
    cursor.setDate(cursor.getDate() + 1);
    const dayKey = dayKeyInTz(cursor, user.workTimezone ?? null);
    const hours = hoursForDay({
      dayKey,
      dailyCapacity: user.dailyCapacity,
      weeklySchedule: user.weeklySchedule
    });
    days += 1;
    if (hours <= 0) continue; // off day — doesn't reduce remaining
    remaining -= hours;
  }
  // +1 buffer day so the user has slack.
  return days + 1;
}

// Compute an absolute deadline ISO string by walking the assignee's
// schedule day-by-day. Reserves the estimated hours across actual
// working days (skipping days the user is off, using each day's real
// hours), then adds a 4h buffer.
//
// For estimate ≤ today's hours we stay in the original "double the
// estimate + 1h buffer, minimum 2h" model — it's a small task; same-day
// turnaround should track the work, not the schedule.
export function deadlineFromEstimate(
  estimateHours: number,
  user: Pick<User, "dailyCapacity" | "weeklySchedule" | "workTimezone">,
  fromMs: number = Date.now()
): string {
  const cursor = new Date(fromMs);
  const todayKey = dayKeyInTz(cursor, user.workTimezone ?? null);
  const todayHours = hoursForDay({
    dayKey: todayKey,
    dailyCapacity: user.dailyCapacity,
    weeklySchedule: user.weeklySchedule
  });

  if (estimateHours <= Math.max(1, todayHours)) {
    const elapsedHours = Math.max(2, estimateHours * 2 + 1);
    return new Date(fromMs + elapsedHours * 3_600_000).toISOString();
  }

  // Multi-day: subtract today's remaining first (assume the task
  // begins immediately), then walk forward.
  let remaining = estimateHours - Math.max(0, todayHours);
  let elapsedDays = 0;
  for (let i = 0; i < 84 && remaining > 0; i++) {
    cursor.setDate(cursor.getDate() + 1);
    elapsedDays += 1;
    const dayKey = dayKeyInTz(cursor, user.workTimezone ?? null);
    const hours = hoursForDay({
      dayKey,
      dailyCapacity: user.dailyCapacity,
      weeklySchedule: user.weeklySchedule
    });
    if (hours <= 0) continue;
    remaining -= hours;
  }
  // 4h buffer added to the elapsed days for slack.
  const elapsedHours = (elapsedDays + 1) * 24 + 4;
  return new Date(fromMs + elapsedHours * 3_600_000).toISOString();
}
