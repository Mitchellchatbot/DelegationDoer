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

import { runInactivitySweep } from "@/lib/inactivity-runner";
import { runEodRecap } from "@/lib/eod-recap-runner";
import { runClientsEmailedPush } from "@/lib/clients-emailed-push-runner";
import { runScheduledEmails } from "@/lib/scheduled-emails-runner";
import { syncBirthdaysForAllOwners } from "@/lib/birthday-calendar-sync";
import { runOutboundSequences } from "@/lib/outbound-sequence-runner";
import { syncWebsiteBuildStatuses } from "@/lib/website-builder-integration";
import { runSupportInboxPoll } from "@/lib/support-inbox-poller";

const globalKey = "__ddCronBootstrap" as const;
const stateKey = "__ddCronHeartbeats" as const;

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

type GlobalWithBootstrap = typeof globalThis & {
  [globalKey]?: boolean;
  [stateKey]?: Heartbeats;
};

// Each job: a label, its cadence, a short delay before the boot-catchup run,
// an opt-out env var, and a runner that resolves to a one-line summary string
// for the heartbeat/logs.
interface CronJob {
  name: string;
  intervalMs: number;
  bootCatchupDelayMs: number;
  disableEnv: string;
  run: () => Promise<string>;
}

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
      if (!("posted" in o)) return `skipped=${o.skipped}`;
      const week = o.weekClients === null ? "" : ` week=${o.weekClients}`;
      return `posted=${o.posted} clients=${o.clients}${week}`;
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
    name: "support-inbox-poll",
    intervalMs: MINUTE,
    bootCatchupDelayMs: 35_000,
    disableEnv: "SUPPORT_INBOX_POLL_INTERNAL_CRON",
    run: async () => {
      const r = await runSupportInboxPoll();
      return `scanned=${r.scanned} ingested=${r.ingested} classified=${r.classified} reconciled=${r.reconciled}`;
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
  const runOnce = async (trigger: "interval" | "boot-catchup"): Promise<void> => {
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
      hb.lastRunSummary = summary;
      console.log(`[cron:${job.name}] (${trigger}) complete — ${summary}`);
    } catch (err) {
      hb.lastRunOk = false;
      hb.lastRunError = err instanceof Error ? err.message : String(err);
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

  setInterval(() => void runOnce("interval"), job.intervalMs);
  hb.schedulerActive = true;
  hb.disabledReason = null;
  console.log(`[cron:${job.name}] internal loop scheduled (every ${Math.round(job.intervalMs / MINUTE)} min)`);
  // Drain whatever came due while the server was down / since the last deploy.
  setTimeout(() => void runOnce("boot-catchup"), job.bootCatchupDelayMs);
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
