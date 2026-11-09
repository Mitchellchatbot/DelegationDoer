import { BRIEF_LIMITS } from "@/lib/exec/brief-types";
import type { BriefOwnershipFacts, BriefOwnershipVerdict } from "@/lib/exec/brief-types";
import { addLocalDays, endOfLocalDateUtc, localTimeToUtc } from "@/lib/exec/time";

// P8 ownership (contract §3.3.1, M1, C2-C4, C28; Area B; pure, B-P8-5): the predicate over M1's seven facts, the brief's
// scheduled instant, the catch-up cutoff, the watchdog's run time and the TTLs. Imports only exec types and time.ts.
//
// Every fact is read as "exactly true": a missing or malformed fact counts as false, so an incomplete read can only move
// the verdict toward legacy or page-only, never toward the assistant DMing (§0.3 rule 6).

const verdict = (owner: BriefOwnershipVerdict["owner"], reason: BriefOwnershipVerdict["reason"]): BriefOwnershipVerdict =>
  Object.freeze({ owner, reason });

/** M1's table, first matching row wins (§1.1 M1). Total: every one of the 128 inputs maps to exactly one verdict. */
export function briefOwnership(f: BriefOwnershipFacts): BriefOwnershipVerdict {
  const yes = (v: unknown): boolean => v === true;
  if (!yes(f?.execEnabled)) return verdict("legacy", "exec_disabled");
  if (!yes(f.tablesReady)) return verdict("legacy", "not_installed");
  if (yes(f.execDeliveredToday)) return verdict("exec", "exec_delivered");
  if (!yes(f.briefEnabled)) return verdict("legacy", "brief_off");
  if (yes(f.legacyDeliveredToday)) return verdict("exec_page_only", "legacy_delivered");
  if (!yes(f.supersede)) return verdict("exec_page_only", "not_superseding");
  if (!yes(f.installationActive)) return verdict("exec_page_only", "no_installation");
  return verdict("exec", "owns");
}

/** Legacy runs iff this is true (M1). */
export function legacyMayRun(v: BriefOwnershipVerdict): boolean {            // v.owner !== "exec"
  return v?.owner !== "exec";
}

/** brief_local_time on localDate in tz (time.ts localTimeToUtc). */
export function scheduledInstant(localDate: string, hhmm: string, tz: string): Date {
  return localTimeToUtc(localDate, hhmm, tz);
}

/** C4: max(localTimeToUtc(localDate, "12:00", tz), scheduledAt + 4 h). */
export function catchUpCutoff(localDate: string, scheduledAt: Date, tz: string): Date {
  const floor = localTimeToUtc(localDate, BRIEF_LIMITS.cutoffFloorLocal, tz).getTime();
  const after = scheduledAt.getTime() + BRIEF_LIMITS.cutoffAfterMs;
  if (!Number.isFinite(after)) throw new RangeError("catchUpCutoff: scheduledAt is not a valid date");
  return new Date(Math.max(floor, after));
}

/** now < catchUpCutoff(...) and now < endOfLocalDateUtc(localDate, tz). Fails closed: anything malformed → false. */
export function mayDmAt(now: Date, localDate: string, scheduledAt: Date, tz: string): boolean {
  try {
    const t = now.getTime();
    if (!Number.isFinite(t)) return false;
    return t < catchUpCutoff(localDate, scheduledAt, tz).getTime() && t < endOfLocalDateUtc(localDate, tz).getTime();
  } catch {
    return false;
  }
}

/** C3. max(scheduledAt, now) + 45 min. */
export function watchdogRunAfter(scheduledAt: Date, now: Date): Date {
  const at = Math.max(scheduledAt.getTime(), now.getTime());
  if (!Number.isFinite(at)) throw new RangeError("watchdogRunAfter: expected valid dates");
  return new Date(at + BRIEF_LIMITS.watchdogDelayMs);
}

/**
 * C28. content: the end of localDate in tz + 30 days; row: that end + 180 days. Counted in calendar days in the brief zone
 * (the end of localDate + N), so each expiry is a local midnight whatever DST does in between.
 */
export function briefExpiries(localDate: string, tz: string): { contentExpiresAt: Date; expiresAt: Date } {
  return {
    contentExpiresAt: endOfLocalDateUtc(addLocalDays(localDate, BRIEF_LIMITS.contentTtlDays), tz),
    expiresAt: endOfLocalDateUtc(addLocalDays(localDate, BRIEF_LIMITS.rowTtlDays), tz)
  };
}
