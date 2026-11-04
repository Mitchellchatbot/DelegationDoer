import "server-only";

import { isExecEnabled } from "@/lib/exec/access";
import { enqueueJob, isValidJobKind, reapExpiredLeases } from "@/lib/exec/jobs";
import { listEnabledPrincipals, loadSettings } from "@/lib/exec/principal";
import { intervalBucket, isLocalTimeReached, isoWeekKey, localDateString, parseLocalTime, zonedParts } from "@/lib/exec/time";
import type { ExecPrincipal, ExecSettings, JobLane } from "@/lib/exec/types";

// Per-principal recurring work for the assistant (plan §7).
//
// Each tick (exec-scheduler, every 60 s) decides, per enabled principal and
// per registered piece of work, whether that work is due, and enqueues it with
// a time-bucket dedupe key. The key is what makes this safe: two processes
// ticking at once (an overlapping deploy) or a tick repeated after a restart
// produce the same key, and exec_jobs.dedupe_key is unique, so the work runs
// once per bucket.
//
// "Due" is evaluated in the principal's own IANA zone (principal.timezone),
// never the server's. Railway runs UTC, and an 08:00 brief must stay at 08:00
// across DST changes.
//
// Daily and weekly work catch up: once the local time has passed, every tick
// for the rest of that local day still finds it due (the key dedupes), so a
// deploy or an outage over the scheduled minute doesn't skip a day.
//
// The registry lives on globalThis for the same reason as the job registry in
// jobs.ts: Next can load this module more than once per process.

export type Cadence =
  /** Every `minutes`, in fixed buckets counted from the Unix epoch (unaffected by DST). */
  | { kind: "interval"; minutes: number }
  /** Once per local day, from `at(settings)` ("HH:MM") until local midnight. */
  | { kind: "daily"; at: (s: ExecSettings) => string }
  /** Once per ISO week, on `isoWeekday` (1 = Monday … 7 = Sunday) from `at` until local midnight. */
  | { kind: "weekly"; isoWeekday: number; at: string };

export interface ScheduledWork {
  /** The job kind enqueued. One schedule per kind. */
  kind: string;
  lane: JobLane;
  cadence: Cadence;
  /** Gate on the principal's settings (e.g. brief_enabled). Absent = always on. */
  enabled?: (s: ExecSettings) => boolean;
  /** Job payload: references only (see enqueueJob). Absent = {}. */
  payload?: (p: ExecPrincipal) => Record<string, unknown>;
  maxAttempts?: number;
}

export interface SchedulerTickResult {
  principals: number;
  enqueued: number;
  reaped: number;
  /** "disabled", "idle" (nothing enqueued, reaped or failed), or the counts. */
  summary: string;
}

const STATE_KEY = "__ddExecScheduledWork";

// On globalThis, like the job handler registry, so a module that is evaluated
// twice (dev reloads, separate route bundles) still shares one registry.
// Reflect reads it without casting globalThis.
function registry(): Map<string, ScheduledWork> {
  const existing: unknown = Reflect.get(globalThis, STATE_KEY);
  if (existing instanceof Map) return existing;
  const fresh = new Map<string, ScheduledWork>();
  Reflect.set(globalThis, STATE_KEY, fresh);
  return fresh;
}

/** Test seam: forget every registered schedule. */
export function __resetSchedulerForTests(): void {
  registry().clear();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function validateCadence(kind: string, cadence: Cadence): void {
  switch (cadence?.kind) {
    case "interval":
      if (!Number.isInteger(cadence.minutes) || cadence.minutes < 1) {
        throw new Error(`scheduled work ${kind}: interval minutes must be a positive integer`);
      }
      return;
    case "daily":
      if (typeof cadence.at !== "function") throw new Error(`scheduled work ${kind}: daily cadence needs an at(settings) function`);
      return;
    case "weekly":
      if (!Number.isInteger(cadence.isoWeekday) || cadence.isoWeekday < 1 || cadence.isoWeekday > 7) {
        throw new Error(`scheduled work ${kind}: isoWeekday must be 1 (Monday) to 7 (Sunday)`);
      }
      if (parseLocalTime(cadence.at) === null) throw new Error(`scheduled work ${kind}: weekly at must be "HH:MM"`);
      return;
    default:
      throw new Error(`scheduled work ${kind}: unknown cadence ${JSON.stringify(cadence)}`);
  }
}

/** Register recurring work. Throws on a duplicate kind or a malformed cadence. */
export function registerScheduledWork(work: ScheduledWork): void {
  // Checked here, not first at enqueue time, so a bad kind fails registration
  // instead of every scheduler tick.
  if (!isValidJobKind(work?.kind)) throw new Error(`scheduled work: invalid job kind ${JSON.stringify(work?.kind)}`);
  if (work.lane !== "interactive" && work.lane !== "bulk") {
    throw new Error(`scheduled work ${work.kind}: unknown lane ${String(work.lane)}`);
  }
  validateCadence(work.kind, work.cadence);
  const reg = registry();
  if (reg.has(work.kind)) throw new Error(`scheduled work already registered for kind "${work.kind}"`);
  reg.set(work.kind, work);
}

export function getScheduledWork(kind: string): ScheduledWork | undefined {
  return registry().get(kind);
}

/** Every registered schedule, in registration order. */
export function listScheduledWork(): readonly ScheduledWork[] {
  return [...registry().values()];
}

/**
 * The dedupe key for `work` if it is due at `now` for this principal, else null.
 *   interval → always due:  `${kind}:${principalId}:i${bucket}`
 *   daily    → due once the local time reaches at(settings):  `${kind}:${principalId}:${YYYY-MM-DD}`
 *   weekly   → due on isoWeekday once the local time reaches at:  `${kind}:${principalId}:${YYYY-Www}`
 * A malformed "HH:MM" is never due. Pure: no I/O.
 */
export function dueDedupeKey(work: ScheduledWork, principal: ExecPrincipal, settings: ExecSettings, now: Date): string | null {
  const tz = principal.timezone;
  const prefix = `${work.kind}:${principal.id}`;
  const cadence = work.cadence;
  switch (cadence.kind) {
    case "interval":
      return `${prefix}:i${intervalBucket(now, cadence.minutes)}`;
    case "daily":
      return isLocalTimeReached(now, tz, cadence.at(settings)) ? `${prefix}:${localDateString(now, tz)}` : null;
    case "weekly":
      return zonedParts(now, tz).weekday === cadence.isoWeekday && isLocalTimeReached(now, tz, cadence.at)
        ? `${prefix}:${isoWeekKey(now, tz)}`
        : null;
  }
}

/**
 * One scheduler pass: requeue expired leases, then enqueue every due piece of
 * work for every enabled principal.
 *
 * A failure for one principal or one piece of work is logged and counted, and
 * the rest still run. Only a failure to list the principals (the database is
 * unreachable) throws, so the cron loop records the tick as failed.
 */
export async function runSchedulerTick(now: Date = new Date()): Promise<SchedulerTickResult> {
  if (!isExecEnabled()) return { principals: 0, enqueued: 0, reaped: 0, summary: "disabled" };

  let errors = 0;
  let reaped = 0;
  try {
    reaped = await reapExpiredLeases();
  } catch (err) {
    errors += 1;
    console.error(`[exec-scheduler] could not reap expired leases: ${errMessage(err)}`);
  }

  const principals = await listEnabledPrincipals();
  const works = listScheduledWork();
  let enqueued = 0;

  for (const principal of principals) {
    let settings: ExecSettings;
    try {
      settings = await loadSettings(principal.id);
    } catch (err) {
      errors += 1;
      console.error(`[exec-scheduler] principal ${principal.id}: could not load settings, skipping this tick: ${errMessage(err)}`);
      continue;
    }

    for (const work of works) {
      try {
        if (work.enabled && !work.enabled(settings)) continue;
        const dedupeKey = dueDedupeKey(work, principal, settings, now);
        if (!dedupeKey) continue;
        const r = await enqueueJob({
          kind: work.kind,
          lane: work.lane,
          principalId: principal.id,
          payload: work.payload ? work.payload(principal) : {},
          dedupeKey,
          maxAttempts: work.maxAttempts
        });
        if (r.enqueued) enqueued += 1;
      } catch (err) {
        errors += 1;
        console.error(`[exec-scheduler] ${work.kind} for principal ${principal.id} failed: ${errMessage(err)}`);
      }
    }
  }

  // "idle" keeps the 60 s loop quiet in the logs (cron-bootstrap's quiet flag)
  // when nothing happened; anything else is worth a line.
  const summary =
    enqueued === 0 && reaped === 0 && errors === 0
      ? "idle"
      : `principals=${principals.length} enqueued=${enqueued} reaped=${reaped}${errors > 0 ? ` errors=${errors}` : ""}`;
  return { principals: principals.length, enqueued, reaped, summary };
}
