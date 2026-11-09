import "server-only";

import { isExecEnabled } from "@/lib/exec/access";
import { enqueueJob, isValidJobKind, reapExpiredLeases } from "@/lib/exec/jobs";
import { listEnabledPrincipals, loadSettings } from "@/lib/exec/principal";
import { intervalBucket, isLocalTimeReached, isoWeekKey, localDateString, localTimeToUtc, parseLocalTime, zonedParts } from "@/lib/exec/time";
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
//
// P8 (contract §3.6): a work may name its own zone (the morning brief's works
// use the brief zone) and declare companions enqueued in the same tick (the
// brief's watchdog, C3). A second registry holds SYSTEM work (principal_id
// null, M10/C18: the daily purge at 03:30 UTC, the 15-minute reaper alert),
// keyed `${kind}:system:…`; it runs every tick before the principals are
// listed, so it needs no enabled principal. A kind lives in one registry only.

export type Cadence =
  /** Every `minutes`, in fixed buckets counted from the Unix epoch (unaffected by DST). */
  | { kind: "interval"; minutes: number }
  /** Once per local day, from `at(settings)` ("HH:MM") until local midnight. */
  | { kind: "daily"; at: (s: ExecSettings) => string }
  /** Once per ISO week, on `isoWeekday` (1 = Monday … 7 = Sunday) from `at` until local midnight. */
  | { kind: "weekly"; isoWeekday: number; at: string };

/** P8 (contract §3.6; stage-0 seed): what a payload or companion function is told about the due work. */
export interface ScheduleContext {
  now: Date; settings: ExecSettings; zone: string;
  /** daily/weekly: the due local date in zone; interval: null. */
  localDate: string | null;
  /** daily: localTimeToUtc(localDate, at(settings), zone); else null. */
  dueAt: Date | null;
  dueKey: string;
}
/** P8 (C3): a job enqueued in the same tick as its work (key `${kind}:${principalId}:${ctx.localDate}`). */
export interface ScheduledCompanion { kind: string; lane: JobLane; runAfter: Date; payload: Record<string, unknown>; maxAttempts: number }

export interface ScheduledWork {
  /** The job kind enqueued. One schedule per kind. */
  kind: string;
  lane: JobLane;
  cadence: Cadence;
  /** Gate on the principal's settings (e.g. brief_enabled). Absent = always on. */
  enabled?: (s: ExecSettings) => boolean;
  /** Job payload: references only (see enqueueJob). Absent = {}. ctx is new (P8); a one-argument function still type-checks. */
  payload?: (p: ExecPrincipal, ctx: ScheduleContext) => Record<string, unknown>;
  /** P8: the zone a daily/weekly cadence is evaluated in. Default (p) => p.timezone. */
  zone?: (p: ExecPrincipal) => string;
  /** P8 (C3): jobs enqueued in the same tick, every tick the work is due (their keys dedupe): key `${c.kind}:${p.id}:${ctx.localDate}`.
   *  Only daily and weekly cadences may declare companions (registration throws otherwise). */
  companions?: (p: ExecPrincipal, ctx: ScheduleContext) => readonly ScheduledCompanion[];
  maxAttempts?: number;
  /**
   * P4 (contract §3.15 Y4): a second, asynchronous gate evaluated after
   * `enabled` and a non-null dedupe key, e.g. "a draft row is due". `false`
   * skips this tick; a throw is counted as an error, logged, and enqueues
   * nothing. Absent = always due.
   */
  when?: (principal: ExecPrincipal, settings: ExecSettings, now: Date) => Promise<boolean>;
}

export interface SchedulerTickResult {
  principals: number;
  enqueued: number;
  reaped: number;
  /** P8 (§3.6): system jobs (principal_id null) this tick enqueued; absent when none was (so a P2a-era tick reads as before). */
  system?: number;
  /** "disabled", "idle" (nothing enqueued, reaped or failed), or the counts. */
  summary: string;
}

const STATE_KEY = "__ddExecScheduledWork";
const SYSTEM_STATE_KEY = "__ddExecSystemScheduledWork";

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

/** P8 (§3.6): the system registry, on globalThis for the same reason. */
function systemRegistry(): Map<string, SystemScheduledWork> {
  const existing: unknown = Reflect.get(globalThis, SYSTEM_STATE_KEY);
  if (existing instanceof Map) return existing;
  const fresh = new Map<string, SystemScheduledWork>();
  Reflect.set(globalThis, SYSTEM_STATE_KEY, fresh);
  return fresh;
}

/** Test seam: forget every registered schedule (the P8 system schedule too). */
export function __resetSchedulerForTests(): void {
  registry().clear();
  systemRegistry().clear();
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

/**
 * Register recurring work. Throws on a duplicate kind (in this registry or the P8 system registry), a malformed cadence,
 * or companions on an interval cadence (P8 C3: a companion is keyed by the due local date, which an interval has none of).
 */
export function registerScheduledWork(work: ScheduledWork): void {
  // Checked here, not first at enqueue time, so a bad kind fails registration
  // instead of every scheduler tick.
  if (!isValidJobKind(work?.kind)) throw new Error(`scheduled work: invalid job kind ${JSON.stringify(work?.kind)}`);
  if (work.lane !== "interactive" && work.lane !== "bulk") {
    throw new Error(`scheduled work ${work.kind}: unknown lane ${String(work.lane)}`);
  }
  validateCadence(work.kind, work.cadence);
  if (work.companions !== undefined) {
    if (typeof work.companions !== "function") throw new Error(`scheduled work ${work.kind}: companions must be a function`);
    if (work.cadence.kind === "interval") throw new Error(`scheduled work ${work.kind}: only a daily or weekly cadence may declare companions`);
  }
  if (work.zone !== undefined && typeof work.zone !== "function") throw new Error(`scheduled work ${work.kind}: zone must be a function`);
  const reg = registry();
  if (reg.has(work.kind)) throw new Error(`scheduled work already registered for kind "${work.kind}"`);
  if (systemRegistry().has(work.kind)) throw new Error(`scheduled work: kind "${work.kind}" is registered as system work`);
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
  // P8 (§3.6): a work's own zone (the brief's works pass p => p.briefTimezone); default principal.timezone, unchanged.
  const tz = work.zone?.(principal) ?? principal.timezone;
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

/** P8 (§3.6): the context a due work's payload (and companions) get. Pure. */
function scheduleContext(work: ScheduledWork, principal: ExecPrincipal, settings: ExecSettings, now: Date, dueKey: string): ScheduleContext {
  const zone = work.zone?.(principal) ?? principal.timezone;
  const cadence = work.cadence;
  const localDate = cadence.kind === "interval" ? null : localDateString(now, zone);
  const dueAt = cadence.kind === "daily" && localDate !== null ? localTimeToUtc(localDate, cadence.at(settings), zone) : null;
  return { now, settings, zone, localDate, dueAt, dueKey };
}

// ---------------------------------------------------------------------------
// P8 (contract §3.6, M10, C17, C18): system work (principal_id null), e.g. the daily purge and the reaper alerts. Its
// deletes and reads are principal-agnostic, so it runs whether or not any principal is enabled; like everything here, only
// while EXEC_ENABLED=true.
// ---------------------------------------------------------------------------

export interface SystemScheduleContext { now: Date; utcDate: string; dueKey: string }
export interface SystemScheduledWork {
  kind: string; lane: JobLane;
  cadence: { kind: "interval"; minutes: number } | { kind: "daily"; atUtc: string };
  payload?: (ctx: SystemScheduleContext) => Record<string, unknown>;
  maxAttempts?: number;
}

function validateSystemCadence(kind: string, cadence: SystemScheduledWork["cadence"]): void {
  switch (cadence?.kind) {
    case "interval":
      if (!Number.isInteger(cadence.minutes) || cadence.minutes < 1) throw new Error(`system work ${kind}: interval minutes must be a positive integer`);
      return;
    case "daily":
      if (typeof cadence.atUtc !== "string" || parseLocalTime(cadence.atUtc) === null) throw new Error(`system work ${kind}: daily atUtc must be "HH:MM"`);
      return;
    default:
      throw new Error(`system work ${kind}: unknown cadence ${JSON.stringify(cadence)}`);
  }
}

/** Throws on a kind registered in either registry, a bad kind, lane or cadence. Registry on globalThis ("__ddExecSystemScheduledWork"). */
export function registerSystemScheduledWork(work: SystemScheduledWork): void {
  if (!isValidJobKind(work?.kind)) throw new Error(`system work: invalid job kind ${JSON.stringify(work?.kind)}`);
  if (work.lane !== "interactive" && work.lane !== "bulk") throw new Error(`system work ${work.kind}: unknown lane ${String(work.lane)}`);
  validateSystemCadence(work.kind, work.cadence);
  if (work.payload !== undefined && typeof work.payload !== "function") throw new Error(`system work ${work.kind}: payload must be a function`);
  const reg = systemRegistry();
  if (reg.has(work.kind)) throw new Error(`system work already registered for kind "${work.kind}"`);
  if (registry().has(work.kind)) throw new Error(`system work: kind "${work.kind}" is registered as per-principal work`);
  reg.set(work.kind, work);
}
export function getSystemScheduledWork(kind: string): SystemScheduledWork | undefined {
  return systemRegistry().get(kind);
}
/** Every registered system schedule, in registration order. */
export function listSystemScheduledWork(): readonly SystemScheduledWork[] {
  return [...systemRegistry().values()];
}
/** interval → `${kind}:system:i${bucket}`; daily → `${kind}:system:${UTC YYYY-MM-DD}` once the UTC time reaches atUtc. Pure. */
export function dueSystemDedupeKey(work: SystemScheduledWork, now: Date): string | null {
  const prefix = `${work.kind}:system`;
  const cadence = work.cadence;
  switch (cadence.kind) {
    case "interval":
      return `${prefix}:i${intervalBucket(now, cadence.minutes)}`;
    case "daily":
      return isLocalTimeReached(now, "UTC", cadence.atUtc) ? `${prefix}:${localDateString(now, "UTC")}` : null;
    default:
      return null;
  }
}
export function __resetSystemSchedulerForTests(): void {
  systemRegistry().clear();
}

/** The system pass: every due system work, principal_id null. Failures are counted and logged by kind, never fatal. */
async function runSystemWork(now: Date): Promise<{ enqueued: number; errors: number }> {
  let enqueued = 0;
  let errors = 0;
  for (const work of listSystemScheduledWork()) {
    try {
      const dueKey = dueSystemDedupeKey(work, now);
      if (!dueKey) continue;
      const ctx: SystemScheduleContext = { now, utcDate: localDateString(now, "UTC"), dueKey };
      const r = await enqueueJob({
        kind: work.kind,
        lane: work.lane,
        principalId: null,
        payload: work.payload ? work.payload(ctx) : {},
        dedupeKey: dueKey,
        maxAttempts: work.maxAttempts
      });
      if (r.enqueued) enqueued += 1;
    } catch (err) {
      errors += 1;
      console.error(`[exec-scheduler] system work ${work.kind} failed: ${errMessage(err)}`);
    }
  }
  return { enqueued, errors };
}

/**
 * P8 (C3): a due work's companions, each keyed `${kind}:${principalId}:${ctx.localDate}`, every tick the work is due (the key
 * dedupes, so the first runAfter stands). Returns how many were newly enqueued; a failure is counted and the rest still run.
 */
async function enqueueCompanions(work: ScheduledWork, principal: ExecPrincipal, ctx: ScheduleContext): Promise<{ enqueued: number; errors: number }> {
  if (!work.companions || ctx.localDate === null) return { enqueued: 0, errors: 0 };
  let enqueued = 0;
  let errors = 0;
  for (const c of work.companions(principal, ctx)) {
    try {
      const r = await enqueueJob({
        kind: c.kind,
        lane: c.lane,
        principalId: principal.id,
        payload: c.payload,
        dedupeKey: `${c.kind}:${principal.id}:${ctx.localDate}`,
        runAfter: c.runAfter,
        maxAttempts: c.maxAttempts
      });
      if (r.enqueued) enqueued += 1;
    } catch (err) {
      errors += 1;
      console.error(`[exec-scheduler] ${c.kind} (companion of ${work.kind}) for principal ${principal.id} failed: ${errMessage(err)}`);
    }
  }
  return { enqueued, errors };
}

/**
 * One scheduler pass: requeue expired leases, enqueue every due system work (P8), then every due piece of work for every
 * enabled principal, each with its companions (P8 C3).
 *
 * A failure for one principal or one piece of work is logged and counted, and
 * the rest still run. Only a failure to list the principals (the database is
 * unreachable) throws, so the cron loop records the tick as failed; the system
 * work has run by then (M10: the purge needs no principal).
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

  const systemPass = await runSystemWork(now);
  const system = systemPass.enqueued;
  errors += systemPass.errors;

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
        // Y4: the asynchronous gate; a throw lands in the catch below (counted, logged, nothing enqueued).
        if (work.when && !(await work.when(principal, settings, now))) continue;
        const ctx = scheduleContext(work, principal, settings, now, dedupeKey);
        const r = await enqueueJob({
          kind: work.kind,
          lane: work.lane,
          principalId: principal.id,
          payload: work.payload ? work.payload(principal, ctx) : {},
          dedupeKey,
          maxAttempts: work.maxAttempts
        });
        if (r.enqueued) enqueued += 1;
        // P8 (C3): due → its companions too, whether this tick enqueued the work or found it already there.
        const companions = await enqueueCompanions(work, principal, ctx);
        enqueued += companions.enqueued;
        errors += companions.errors;
      } catch (err) {
        errors += 1;
        console.error(`[exec-scheduler] ${work.kind} for principal ${principal.id} failed: ${errMessage(err)}`);
      }
    }
  }

  // "idle" keeps the 60 s loop quiet in the logs (cron-bootstrap's quiet flag)
  // when nothing happened; anything else is worth a line.
  const summary =
    enqueued === 0 && reaped === 0 && errors === 0 && system === 0
      ? "idle"
      : `principals=${principals.length} enqueued=${enqueued} reaped=${reaped}${system > 0 ? ` system=${system}` : ""}${errors > 0 ? ` errors=${errors}` : ""}`;
  return { principals: principals.length, enqueued, reaped, ...(system > 0 ? { system } : {}), summary };
}
