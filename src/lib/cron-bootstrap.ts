// Starts the remaining vercel.json cron jobs as in-process interval loops on
// boot, so they run wherever the Next.js server is a long-lived process
// (Railway / Render / a plain VM) — anywhere that is NOT Vercel serverless.
//
// Same reason email-intake-bootstrap / task-archive-bootstrap exist: the
// schedule in vercel.json only fires on Vercel. On Railway nothing ever hit
// these four cron paths, so the jobs silently never ran:
//
//   inactivity        — flag stale tasks            (hourly)
//   eod-recap         — 7pm NY daily Slack recap    (hourly tick; NY-hour guarded)
//   birthday-sync     — mirror birthdays to GCal    (daily)
//   scheduled-emails  — dispatch due scheduled mail (every minute)
//
// These four are homogeneous "interval → run a function" jobs, so rather than
// copy email-intake-bootstrap four times they share one tiny scheduler here.
// The per-job design still mirrors the existing bootstraps exactly:
//   - globalThis singleton guard so a double-import (dev HMR, multiple
//     entrypoints) can't schedule the loops twice.
//   - Each job is started, AND each tick runs, inside its own try/catch. One
//     job failing to schedule — or throwing on a tick — must never stop the
//     others. That single-point-of-failure is the whole reason this exists.
//   - Stands down on Vercel (VERCEL=1) so the vercel.json cron owns the job
//     and the two never double-run; a per-job opt-out env is also supported.
//   - Plain setInterval (no external cron dependency to mis-install).
//   - A boot-catchup run shortly after start so a fresh deploy doesn't wait a
//     full interval for the first run.
//   - A per-job in-memory heartbeat is exported so /api/cron/status can report
//     whether each loop is alive and what its last run did.
//
// Every job's underlying runner is idempotent (claim-before-send, "not yet
// flagged" filters, same-day dedupe), so overlapping ticks, restarts, or a
// Vercel cron firing alongside this loop never create duplicate work.
//
// exec-worker and exec-scheduler drive the Executive AI Assistant's job queue
// (src/lib/exec). They have no vercel.json entry; /api/cron/exec-tick is
// their external-cron path. Both tick often and sit idle (or off behind
// EXEC_ENABLED) most of the time, so they're `quiet`.

import { runInactivitySweep } from "@/lib/inactivity-runner";
import { runEodRecap } from "@/lib/eod-recap-runner";
import { runDailyBriefing } from "@/lib/daily-briefing-runner";
import { runClientsEmailedPush } from "@/lib/clients-emailed-push-runner";
import { runScheduledEmails } from "@/lib/scheduled-emails-runner";
import { syncBirthdaysForAllOwners } from "@/lib/birthday-calendar-sync";
import { runOutboundSequences } from "@/lib/outbound-sequence-runner";
import { syncWebsiteBuildStatuses } from "@/lib/website-builder-integration";
import { runSupportInboxPoll } from "@/lib/support-inbox-poller";

const globalKey = "__ddCronBootstrap" as const;
const stateKey = "__ddCronHeartbeats" as const;
// P9 F19: the loops' timer handles (so a shutdown can stop them), the stopped flag, and the drain handler's install guard.
const timersKey = "__ddCronTimers" as const;
const stoppedKey = "__ddCronStopped" as const;
const drainKey = "__ddCronDrainInstalled" as const;
// P9 F19: src/lib/exec/jobs.ts's EXEC_DRAINING_KEY. A literal here: this file is in the instrumentation hook's Edge build,
// so it reaches exec code only through a lazy import inside a NEXT_RUNTIME === "nodejs" branch (see the exec loops).
const execDrainingKey = "__ddExecDraining" as const;

const MINUTE = 60 * 1_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface CronHeartbeat {
  name: string;
  intervalMs: number;
  startedAt: string | null;
  schedulerActive: boolean;
  disabledReason: string | null;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastRunOk: boolean | null;
  lastRunSummary: string | null;
  lastRunError: string | null;
  runCount: number;
}

type Heartbeats = Record<string, CronHeartbeat>;

interface CronTimer {
  kind: "interval" | "timeout";
  handle: ReturnType<typeof setInterval>;
}

type GlobalWithBootstrap = typeof globalThis & {
  [globalKey]?: boolean;
  [stateKey]?: Heartbeats;
  [timersKey]?: CronTimer[];
  [stoppedKey]?: boolean;
  [drainKey]?: boolean;
  [execDrainingKey]?: boolean;
};

// Each job: a label, its cadence, a short delay before the boot-catchup run,
// an opt-out env var, and a runner that resolves to a one-line summary string
// for the heartbeat/logs.
interface CronJob {
  name: string;
  intervalMs: number;
  bootCatchupDelayMs: number;
  disableEnv: string;
  /**
   * Don't log ticks whose summary is "idle" or "disabled". For loops that tick
   * every few seconds and usually have nothing to do, where a line per tick
   * would bury everything else in the log. Failures always log.
   */
  quiet?: boolean;
  /**
   * /api/cron/status is readable by every signed-in user. For a loop whose
   * counts would reveal one person's activity (the owner-only Executive AI
   * Assistant: a claim per question he asks), the shared heartbeat keeps only
   * "disabled" or "ok", and a failure as a generic line. The full summary and
   * error still go to the server log.
   */
  privateSummary?: boolean;
  run: () => Promise<string>;
}

const QUIET_SUMMARIES: ReadonlySet<string> = new Set(["idle", "disabled"]);
const PRIVATE_FAILURE = "failed (details in the server log)";

const JOBS: CronJob[] = [
  {
    name: "inactivity",
    intervalMs: HOUR, // matches vercel.json "0 * * * *"
    bootCatchupDelayMs: 30_000,
    disableEnv: "INACTIVITY_INTERNAL_CRON",
    run: async () => {
      const r = await runInactivitySweep();
      return `flagged=${r.flagged}`;
    }
  },
  {
    name: "eod-recap",
    // vercel.json fires at 23:00 + 00:00 UTC to straddle DST; the runner's
    // NY-hour guard means only the tick that lands in the 7pm NY hour posts,
    // so an hourly cadence is enough to hit that window exactly once a day.
    intervalMs: HOUR,
    bootCatchupDelayMs: 45_000,
    disableEnv: "EOD_RECAP_INTERNAL_CRON",
    run: async () => {
      const o = await runEodRecap();
      if (!o.ok) return `reason=${o.reason}`;
      return "posted" in o ? `posted=${o.posted}` : `skipped=${o.skipped}`;
    }
  },
  {
    name: "daily-briefing",
    // vercel.json fires at 12:00 + 13:00 UTC to straddle DST; the runner
    // delivers at the first hourly tick from 8am NY onward and dedupes to one
    // send per day, so a missed/late tick or a deploy restart never skips a day.
    intervalMs: HOUR,
    bootCatchupDelayMs: 55_000,
    disableEnv: "DAILY_BRIEFING_INTERNAL_CRON",
    run: async () => {
      const o = await runDailyBriefing();
      if (!o.ok) return `reason=${o.reason}`;
      if ("delivered" in o) return `delivered brief=${o.briefId} msgs=${o.messages} tasks=${o.activeTasks} inbox=${o.inboxThreads}`;
      return "skipped" in o ? `skipped=${o.skipped}` : "dry-run";
    }
  },
  {
    name: "clients-emailed-push",
    // vercel.json fires at 23:00 + 00:00 UTC to straddle DST; the runner's 7pm
    // guard means only the tick that lands in the 7pm NY hour DMs Sam &
    // Mitchell, so an hourly cadence hits that window exactly once a day. The
    // runner folds the week's roll-up into Friday's DM on its own.
    intervalMs: HOUR,
    bootCatchupDelayMs: 50_000,
    disableEnv: "CLIENTS_EMAILED_PUSH_INTERNAL_CRON",
    run: async () => {
      const o = await runClientsEmailedPush();
      if (!o.ok) return `reason=${o.reason}`;
      if ("posted" in o) {
        const week = o.weekClients === null ? "" : ` week=${o.weekClients}`;
        return `posted=${o.posted} clients=${o.clients}${week}`;
      }
      // The scheduled path never passes dryRun, so only the skip shape is left.
      return "skipped" in o ? `skipped=${o.skipped}` : "dry-run";
    }
  },
  {
    name: "birthday-sync",
    intervalMs: DAY, // matches vercel.json "0 7 * * *"
    bootCatchupDelayMs: 60_000,
    disableEnv: "BIRTHDAY_SYNC_INTERNAL_CRON",
    run: async () => {
      const r = await syncBirthdaysForAllOwners();
      return `owners=${r.owners} created=${r.created} updated=${r.updated} deleted=${r.deleted}`;
    }
  },
  {
    name: "scheduled-emails",
    intervalMs: MINUTE, // matches vercel.json "* * * * *"
    bootCatchupDelayMs: 20_000,
    disableEnv: "SCHEDULED_EMAILS_INTERNAL_CRON",
    run: async () => {
      const r = await runScheduledEmails();
      return (
        `replies sent=${r.replies.sent}/${r.replies.considered} ` +
        `drafts sent=${r.drafts.sent}/${r.drafts.considered}`
      );
    }
  },
  {
    name: "outbound-sequences",
    intervalMs: MINUTE, // matches vercel.json "* * * * *"
    bootCatchupDelayMs: 25_000,
    disableEnv: "OUTBOUND_SEQUENCES_INTERNAL_CRON",
    run: async () => {
      const r = await runOutboundSequences();
      return `sent=${r.sent}/${r.considered} failed=${r.failed}`;
    }
  },
  {
    name: "outbound-website-builds",
    intervalMs: MINUTE, // matches vercel.json "* * * * *"
    bootCatchupDelayMs: 30_000,
    disableEnv: "OUTBOUND_WEBSITE_BUILDS_INTERNAL_CRON",
    run: async () => {
      const r = await syncWebsiteBuildStatuses();
      return (
        `scanned=${r.scanned} updated=${r.updated} ` +
        `deployed=${r.deployed} completed=${r.completed} ` +
        `errors=${r.errors.length}`
      );
    }
  },
  {
    // Backstop for the real-time Blooio inbound-SMS webhook. Sweeps the Blooio
    // API for inbound texts a missed webhook dropped; idempotent via the
    // support_messages UNIQUE constraint, so it never double-processes.
    //
    // Inert while inbound capture is off (lib/blooio.ts isBlooioInboundEnabled),
    // which is the current state — the runner returns immediately and this logs
    // skipped=inbound-disabled each tick. Setting
    // SUPPORT_INBOX_POLL_INTERNAL_CRON=false stops the tick entirely; it is
    // belt-and-braces, since the runner guard already holds without it.
    name: "support-inbox-poll",
    intervalMs: MINUTE,
    bootCatchupDelayMs: 35_000,
    disableEnv: "SUPPORT_INBOX_POLL_INTERNAL_CRON",
    run: async () => {
      const r = await runSupportInboxPoll();
      if (r.skipped) return `skipped=${r.skipped}`;
      return `scanned=${r.scanned} ingested=${r.ingested} classified=${r.classified} reconciled=${r.reconciled}`;
    }
  },
  {
    // Executive AI Assistant worker: claims due exec_jobs rows into this
    // process's free lane slots and starts them without waiting, so a long
    // brief never holds the tick open (or trips the overlap guard). Enqueuing
    // interactive work also kicks the queue in-process; this loop is the
    // backstop. Returns "disabled" until EXEC_ENABLED=true.
    //
    // The exec layer is imported lazily, inside a compile-time branch. Next
    // also builds the instrumentation hook (which imports this file) for the
    // Edge runtime, where webpack drops a `process.env.NEXT_RUNTIME ===
    // "nodejs"` branch, so the Node-only exec modules (node:crypto, node:os)
    // never enter that bundle. An early return wouldn't be pruned. Loading it
    // lazily also means an exec module that fails to load fails only these
    // two jobs' ticks, not the import of this file and every loop above.
    name: "exec-worker",
    intervalMs: 10_000,
    bootCatchupDelayMs: 40_000,
    disableEnv: "EXEC_WORKER_INTERNAL_CRON",
    quiet: true,
    privateSummary: true,
    run: async () => {
      if (process.env.NEXT_RUNTIME === "nodejs") {
        const { runExecWorkerTick } = await import("@/lib/exec/runtime");
        return runExecWorkerTick();
      }
      return "disabled";
    }
  },
  {
    // Executive AI Assistant scheduler: reaps expired job leases, then
    // enqueues each enabled principal's due work under a time-bucket dedupe
    // key (DST-safe, in the principal's zone), so overlapping ticks or two
    // processes never double-enqueue. Same lazy, Node-only import as above.
    name: "exec-scheduler",
    intervalMs: MINUTE,
    bootCatchupDelayMs: 65_000,
    disableEnv: "EXEC_SCHEDULER_INTERNAL_CRON",
    quiet: true,
    privateSummary: true,
    run: async () => {
      if (process.env.NEXT_RUNTIME === "nodejs") {
        const { runExecSchedulerTick } = await import("@/lib/exec/runtime");
        return runExecSchedulerTick();
      }
      return "disabled";
    }
  }
];

// Read-only snapshot for /api/cron/status. Returns {} before the bootstrap has
// run — that itself is diagnostic (new code not deployed, or instrumentation
// didn't fire).
export function getCronHeartbeats(): CronHeartbeat[] {
  const g = globalThis as GlobalWithBootstrap;
  return Object.values(g[stateKey] ?? {});
}

// Vercel Cron owns these jobs on Vercel deploys; a per-job opt-out is also
// supported. Everywhere else (Railway / self-hosted) the in-process loop runs.
function disabledReason(job: CronJob): string | null {
  if (process.env[job.disableEnv] === "false") {
    return `${job.disableEnv}=false`;
  }
  if (process.env.VERCEL === "1") {
    return "running on Vercel (vercel.json cron owns this job)";
  }
  return null;
}

// Seconds below a minute: rounding a 10 s loop to minutes printed "every 0 min".
function describeInterval(ms: number): string {
  return ms < MINUTE ? `${Math.round(ms / 1_000)} s` : `${Math.round(ms / MINUTE)} min`;
}

function scheduleJob(job: CronJob, heartbeats: Heartbeats): void {
  const hb: CronHeartbeat = {
    name: job.name,
    intervalMs: job.intervalMs,
    startedAt: new Date().toISOString(),
    schedulerActive: false,
    disabledReason: null,
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
    lastRunOk: null,
    lastRunSummary: null,
    lastRunError: null,
    runCount: 0
  };
  heartbeats[job.name] = hb;

  // Per-job overlap guard: if a run is still in flight when the next tick
  // fires (or the boot-catchup overlaps the first interval) we skip rather
  // than stack runs. Cross-process duplicate work is handled by each runner's
  // own idempotency.
  let running = false;
  const g = globalThis as GlobalWithBootstrap;
  const runOnce = async (trigger: "interval" | "boot-catchup"): Promise<void> => {
    // P9 F19: after stopScheduledCrons (SIGTERM) no tick starts, even one whose timer had already fired.
    if (g[stoppedKey]) return;
    if (running) {
      console.log(`[cron:${job.name}] (${trigger}) skipped — previous run still in flight`);
      return;
    }
    running = true;
    hb.lastRunStartedAt = new Date().toISOString();
    try {
      const summary = await job.run();
      hb.lastRunOk = true;
      hb.lastRunError = null;
      hb.lastRunSummary = job.privateSummary && summary !== "disabled" ? "ok" : summary;
      if (!(job.quiet && QUIET_SUMMARIES.has(summary))) {
        console.log(`[cron:${job.name}] (${trigger}) complete — ${summary}`);
      }
    } catch (err) {
      hb.lastRunOk = false;
      hb.lastRunError = job.privateSummary ? PRIVATE_FAILURE : err instanceof Error ? err.message : String(err);
      console.error(`[cron:${job.name}] (${trigger}) failed:`, err);
    } finally {
      hb.lastRunFinishedAt = new Date().toISOString();
      hb.runCount += 1;
      running = false;
    }
  };

  const disabled = disabledReason(job);
  if (disabled) {
    hb.schedulerActive = false;
    hb.disabledReason = disabled;
    console.log(`[cron:${job.name}] internal loop disabled — ${disabled}`);
    return;
  }

  const timers = (g[timersKey] ??= []);
  timers.push({ kind: "interval", handle: setInterval(() => void runOnce("interval"), job.intervalMs) });
  hb.schedulerActive = true;
  hb.disabledReason = null;
  console.log(`[cron:${job.name}] internal loop scheduled (every ${describeInterval(job.intervalMs)})`);
  // Drain whatever came due while the server was down / since the last deploy.
  timers.push({ kind: "timeout", handle: setTimeout(() => void runOnce("boot-catchup"), job.bootCatchupDelayMs) });
}

/**
 * P9 F19: stops every loop this bootstrap started, for a shutdown: their timers are cleared and no tick starts from now on
 * (one already running finishes). Each active heartbeat shows schedulerActive false with `reason`. Idempotent; returns how
 * many timers it cleared.
 */
export function stopScheduledCrons(reason: string): number {
  const g = globalThis as GlobalWithBootstrap;
  g[stoppedKey] = true;
  const timers = (g[timersKey] ?? []).splice(0);
  for (const t of timers) {
    if (t.kind === "interval") clearInterval(t.handle);
    else clearTimeout(t.handle);
  }
  for (const hb of Object.values(g[stateKey] ?? {})) {
    if (!hb.schedulerActive) continue;
    hb.schedulerActive = false;
    hb.disabledReason = reason;
  }
  return timers.length;
}

/**
 * P9 F19 (L5): how long the SIGTERM handler waits for in-flight exec runs, in ms: RAILWAY_DEPLOYMENT_DRAINING_SECONDS
 * x 1000 - 5000 (Railway sends SIGKILL that many seconds after SIGTERM; 5 s are left to exit), clamped to 0..110 000.
 * Unset, blank or not a number: 0. Pure.
 */
export function drainWaitMs(raw: string | undefined): number {
  const text = typeof raw === "string" ? raw.trim() : "";
  const seconds = text.length > 0 ? Number(text) : Number.NaN;
  if (!Number.isFinite(seconds)) return 0;
  return Math.min(110_000, Math.max(0, Math.floor(seconds * 1_000 - 5_000)));
}

export interface ShutdownDrainOptions {
  /** Default: process.exit (Node only). */
  exit?: (code: number) => void;
  /** Default: src/lib/exec/jobs.ts's inFlightCount, loaded lazily on Node (0 when it can't be loaded). */
  inFlight?: () => number | Promise<number>;
  /** How often the wait re-counts, default 250 ms. */
  pollMs?: number;
}

/** "next-exits": Next's own handler closes the server and exits (this never calls exit). "exited": this called exit(0). */
export type ShutdownOutcome = "next-exits" | "exited";

/**
 * P9 F19 (L5, AM-P9-23): the SIGTERM handler's body. Always: the exec draining flag is set (a worker pass claims nothing,
 * a kick is a no-op, the exec scheduler idles) and every loop here stops. Who exits then follows Next 14.2's own test, the
 * truthiness of NEXT_MANUAL_SIG_HANDLE (start-server.js registers its SIGINT / SIGTERM handlers only when it is empty):
 *   - unset or empty: Next's handler closes the server and exits; this returns "next-exits" and never calls exit, so DD
 *     shuts down as before (inert);
 *   - "true": Next registered no handler; this waits for the in-flight exec runs, at most
 *     drainWaitMs(RAILWAY_DEPLOYMENT_DRAINING_SECONDS), then exits 0;
 *   - any other non-empty value ("1", "yes"): Next registered no handler either, so this exits 0 at once (no wait), and
 *     the process never hangs until Railway's SIGKILL.
 * Logs counts only.
 */
export async function drainForShutdown(opts: ShutdownDrainOptions = {}): Promise<ShutdownOutcome> {
  const g = globalThis as GlobalWithBootstrap;
  g[execDrainingKey] = true;
  const cleared = stopScheduledCrons("shutting down (SIGTERM)");
  const manual = process.env.NEXT_MANUAL_SIG_HANDLE;
  if (!manual) {
    console.log(`[cron] SIGTERM: ${cleared} loop timers stopped, exec jobs draining; Next's own handler exits`);
    return "next-exits";
  }
  const waitMs = manual === "true" ? drainWaitMs(process.env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS) : 0;
  const left = waitMs > 0 ? await waitForExecRuns(waitMs, opts) : 0;
  console.log(`[cron] SIGTERM: ${cleared} loop timers stopped, exec jobs drained (${left} still running); exiting`);
  (opts.exit ?? exitProcess)(0);
  return "exited";
}

/** process.exit, on Node only (a compile-time branch: the Edge build of this file never names it). */
function exitProcess(code: number): void {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    process.exit(code);
  }
}

/** Polls the in-flight count until it is 0 or `waitMs` passed; returns what was still running (0 = all done). */
async function waitForExecRuns(waitMs: number, opts: ShutdownDrainOptions): Promise<number> {
  const count = opts.inFlight ?? (await execInFlightCounter());
  const pollMs = opts.pollMs !== undefined && opts.pollMs > 0 ? opts.pollMs : 250;
  const deadline = Date.now() + waitMs;
  for (;;) {
    let n: number;
    try {
      n = await count();
    } catch {
      return 0;
    }
    if (!(n > 0)) return 0;
    const left = deadline - Date.now();
    if (left <= 0) return n;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, left)));
  }
}

/** jobs.ts's inFlightCount, loaded lazily inside the Node-only branch (as the exec loops load the runtime). */
async function execInFlightCounter(): Promise<() => number> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { inFlightCount } = await import("@/lib/exec/jobs");
      return inFlightCount;
    } catch (err) {
      console.error(`[cron] SIGTERM: the exec job module did not load (${err instanceof Error ? err.name : "error"}); not waiting`);
    }
  }
  return () => 0;
}

/**
 * P9 F19: registers the SIGTERM handler (drainForShutdown) once per process; src/instrumentation.ts calls it on the
 * Node.js runtime. process.once: a second SIGTERM finds no listener here and gets Node's default (exit) unless Next's
 * own handler is there. Returns whether it registered now.
 */
export function installShutdownDrain(): boolean {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const g = globalThis as GlobalWithBootstrap;
    if (g[drainKey]) return false;
    g[drainKey] = true;
    process.once("SIGTERM", () => {
      drainForShutdown().catch((err: unknown) => {
        console.error(`[cron] SIGTERM drain failed (${err instanceof Error ? err.name : "error"})`);
        // With manual signal handling nobody else exits: do it here rather than hang until SIGKILL.
        if (process.env.NEXT_MANUAL_SIG_HANDLE) exitProcess(0);
      });
    });
    return true;
  }
  return false;
}

export function bootstrapScheduledCrons(): void {
  const g = globalThis as GlobalWithBootstrap;
  if (g[globalKey]) return;
  g[globalKey] = true;

  const heartbeats: Heartbeats = {};
  g[stateKey] = heartbeats;

  for (const job of JOBS) {
    // Scheduling one job must never throw out of the loop and abort the rest.
    try {
      scheduleJob(job, heartbeats);
    } catch (err) {
      console.error(`[cron:${job.name}] failed to schedule internal loop:`, err);
    }
  }
}
