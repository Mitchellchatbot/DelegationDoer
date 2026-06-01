// Runs the auto-archive sweep on a long-lived (non-Vercel) host. Same reason
// email-intake-bootstrap exists: the schedule in vercel.json only fires on
// Vercel, so on Railway nothing ever hit /api/cron/archive-done and done tasks
// never auto-archived. This is the host-agnostic scheduler for that sweep.
//
// Design mirrors email-intake-bootstrap:
//   - Global guard so a double-import (dev HMR, multiple entrypoints) can't
//     schedule the loop twice.
//   - Stands down on Vercel (VERCEL=1) so the vercel.json cron owns the sweep
//     and the two never double-run; an explicit opt-out env is also supported.
//   - Plain setInterval (no external cron dependency to mis-install). The
//     archive rule is age-based ("done > 7 days ago"), so the exact wall-clock
//     run time doesn't matter — a daily-ish cadence is enough.
//   - A boot-catchup run shortly after start, so a fresh deploy drains the
//     backlog promptly instead of waiting a full day for the first interval.
import { runArchiveSweep } from "@/lib/task-archive-runner";

const globalKey = "__ddArchiveBootstrap" as const;
type GlobalWithBootstrap = typeof globalThis & { [globalKey]?: boolean };

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1_000; // daily — matches vercel.json "0 2 * * *"
const BOOT_CATCHUP_DELAY_MS = 30_000;

// Guards against overlapping sweeps within this process if a run ever takes
// longer than expected. Cross-process duplicate work is harmless: the sweep is
// idempotent (already-archived rows are filtered out by `archived_at is null`).
let sweepRunning = false;

async function runSweep(trigger: "interval" | "boot-catchup"): Promise<void> {
  if (sweepRunning) {
    console.log(`[task-archive] sweep (${trigger}) skipped — previous run still in flight`);
    return;
  }
  sweepRunning = true;
  try {
    const result = await runArchiveSweep();
    console.log(`[task-archive] sweep (${trigger}) complete — archived=${result.count} cutoff=${result.cutoff}`);
  } catch (err) {
    console.error(`[task-archive] sweep (${trigger}) failed:`, err);
  } finally {
    sweepRunning = false;
  }
}

// Vercel Cron owns the sweep on Vercel deploys; an explicit opt-out is also
// supported. Everywhere else (Railway / self-hosted) the in-process loop runs.
function schedulerDisabledReason(): string | null {
  if (process.env.ARCHIVE_INTERNAL_CRON === "false") {
    return "ARCHIVE_INTERNAL_CRON=false";
  }
  if (process.env.VERCEL === "1") {
    return "running on Vercel (vercel.json cron owns the sweep)";
  }
  return null;
}

export function bootstrapTaskArchive(): void {
  const g = globalThis as GlobalWithBootstrap;
  if (g[globalKey]) return;
  g[globalKey] = true;

  try {
    const disabled = schedulerDisabledReason();
    if (disabled) {
      console.log(`[task-archive] internal sweep loop disabled — ${disabled}`);
      return;
    }
    setInterval(() => {
      void runSweep("interval");
    }, SWEEP_INTERVAL_MS);
    console.log("[task-archive] internal sweep loop scheduled (daily)");
    // Drain whatever aged past the cutoff while the server was down / since
    // the last deploy.
    setTimeout(() => {
      void runSweep("boot-catchup");
    }, BOOT_CATCHUP_DELAY_MS);
  } catch (err) {
    console.error("[task-archive] failed to schedule internal sweep loop:", err);
  }
}
