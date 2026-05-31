// Starts email routing on server boot so it works wherever the Next.js
// server runs as a long-lived process (Railway / Render / a plain VM) —
// i.e. anywhere that is NOT Vercel serverless. Three independent paths:
//
//   1. Missive socket bridge        — redundant real-time path alongside the webhook
//   2. Inbox-bus listener           — classify + route within seconds of inbound mail
//   3. In-process poll every 5 min  — safety net for missed events + backlog drain
//
// Why this exists: the schedule in vercel.json only fires on Vercel. On
// Railway nothing ever hit /api/cron/email-intake, so intake silently
// stopped. This module is the host-agnostic scheduler.
//
// Design notes:
//   - Each subsystem is started inside its own try/catch. A failure in the
//     socket bridge must NOT prevent the poll loop from scheduling (and vice
//     versa) — that single-point-of-failure is what previously took the whole
//     pipeline down with no signal.
//   - The poll uses a plain setInterval (no external cron dependency to
//     mis-install). The cadence is a fixed 5 minutes.
//   - A module-level heartbeat is exported so /api/email-intake/status can
//     report whether the scheduler is alive and when it last ran.

import { subscribe, type InboxEvent } from "@/lib/inbox-event-bus";
import { startMissiveSocketBridge } from "@/lib/missive-socket";
import { pollEmailIntake } from "@/lib/email-intake-runner";

const globalKey = "__ddEmailIntakeBootstrap" as const;
type GlobalWithBootstrap = typeof globalThis & { [globalKey]?: boolean };

const EVENT_DEBOUNCE_MS = 3_000;
const POLL_INTERVAL_MS = 5 * 60 * 1_000; // every 5 min — matches vercel.json
const BOOT_CATCHUP_DELAY_MS = 15_000;

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Set<string>();

// In-memory heartbeat. Process-local (one per server instance) — it proves
// the loop in THIS process is alive. Cross-process / historical state lives
// in missive_account_settings.last_polled_at (written by pollEmailIntake).
export interface IntakeHeartbeat {
  startedAt: string | null;
  schedulerActive: boolean;
  schedulerDisabledReason: string | null;
  lastPollStartedAt: string | null;
  lastPollFinishedAt: string | null;
  lastPollOk: boolean | null;
  lastPollSummary: string | null;
  lastPollError: string | null;
  pollCount: number;
  realtimeActive: boolean;
}

const heartbeat: IntakeHeartbeat = {
  startedAt: null,
  schedulerActive: false,
  schedulerDisabledReason: null,
  lastPollStartedAt: null,
  lastPollFinishedAt: null,
  lastPollOk: null,
  lastPollSummary: null,
  lastPollError: null,
  pollCount: 0,
  realtimeActive: false
};

export function getIntakeHeartbeat(): IntakeHeartbeat {
  return { ...heartbeat };
}

function scheduleRealtimeIntake(event: InboxEvent): void {
  if (event.event !== "message:new") return;
  if (!event.account_id || !event.thread_id) return;

  const threadId = event.thread_id;
  const accountId = event.account_id;

  const existing = debounceTimers.get(threadId);
  if (existing) clearTimeout(existing);

  debounceTimers.set(
    threadId,
    setTimeout(() => {
      debounceTimers.delete(threadId);
      void runRealtimeIntake(accountId, threadId);
    }, EVENT_DEBOUNCE_MS)
  );
}

async function runRealtimeIntake(accountId: string, threadId: string): Promise<void> {
  if (inFlight.has(threadId)) return;
  inFlight.add(threadId);
  try {
    const { processThreadForAutoIntake } = await import("@/lib/email-intake-runner");
    const outcome = await processThreadForAutoIntake({
      accountId,
      threadId,
      source: "event"
    });
    if (outcome.result === "ok") {
      console.log(
        `[email-intake] event routed thread=${threadId} task=${outcome.taskId} via=${outcome.routedVia}`
      );
    } else if (outcome.result === "error") {
      console.warn(`[email-intake] event failed thread=${threadId}:`, outcome.error);
    }
  } catch (err) {
    console.error(`[email-intake] event threw thread=${threadId}:`, err);
  } finally {
    inFlight.delete(threadId);
  }
}

// Guards against overlapping polls within this process if a run ever takes
// longer than the interval. Cross-process duplicate work is prevented by the
// email_intake_log dedupe inside pollEmailIntake.
let pollRunning = false;

async function runScheduledPoll(trigger: "interval" | "boot-catchup"): Promise<void> {
  if (pollRunning) {
    console.log(`[email-intake] poll (${trigger}) skipped — previous run still in flight`);
    return;
  }
  pollRunning = true;
  heartbeat.lastPollStartedAt = new Date().toISOString();
  try {
    const result = await pollEmailIntake();
    heartbeat.lastPollOk = true;
    heartbeat.lastPollError = null;
    heartbeat.lastPollSummary =
      `accounts=${result.accounts} inspected=${result.inspected} ` +
      `processed=${result.processed} skipped=${result.skipped} errors=${result.errors}`;
    console.log(`[email-intake] poll (${trigger}) complete ${heartbeat.lastPollSummary}`);
  } catch (err) {
    heartbeat.lastPollOk = false;
    heartbeat.lastPollError = err instanceof Error ? err.message : String(err);
    console.error(`[email-intake] poll (${trigger}) failed:`, err);
  } finally {
    heartbeat.lastPollFinishedAt = new Date().toISOString();
    heartbeat.pollCount += 1;
    pollRunning = false;
  }
}

// Vercel Cron owns the poll on Vercel deploys; an explicit opt-out is also
// supported. Everywhere else (Railway / self-hosted) the in-process loop runs.
function schedulerDisabledReason(): string | null {
  if (process.env.EMAIL_INTAKE_INTERNAL_CRON === "false") {
    return "EMAIL_INTAKE_INTERNAL_CRON=false";
  }
  if (process.env.VERCEL === "1") {
    return "running on Vercel (vercel.json cron owns the poll)";
  }
  return null;
}

export function bootstrapEmailIntake(): void {
  const g = globalThis as GlobalWithBootstrap;
  if (g[globalKey]) return;
  g[globalKey] = true;

  heartbeat.startedAt = new Date().toISOString();

  // (1) + (2) Real-time path. Isolated so a socket/bus failure can't stop
  // the poll loop below from being scheduled.
  try {
    startMissiveSocketBridge();
    subscribe(scheduleRealtimeIntake);
    heartbeat.realtimeActive = true;
    console.log("[email-intake] real-time listener active (webhook + socket → classify → route)");
  } catch (err) {
    heartbeat.realtimeActive = false;
    console.error("[email-intake] failed to start real-time listener:", err);
  }

  // (3) Poll loop. Isolated for the same reason.
  try {
    const disabled = schedulerDisabledReason();
    if (disabled) {
      heartbeat.schedulerActive = false;
      heartbeat.schedulerDisabledReason = disabled;
      console.log(`[email-intake] internal poll loop disabled — ${disabled}`);
    } else {
      setInterval(() => {
        void runScheduledPoll("interval");
      }, POLL_INTERVAL_MS);
      heartbeat.schedulerActive = true;
      heartbeat.schedulerDisabledReason = null;
      console.log("[email-intake] internal poll loop scheduled (every 5 min)");
      // Catch up on anything that arrived while the server was down.
      setTimeout(() => {
        void runScheduledPoll("boot-catchup");
      }, BOOT_CATCHUP_DELAY_MS);
    }
  } catch (err) {
    heartbeat.schedulerActive = false;
    console.error("[email-intake] failed to schedule internal poll loop:", err);
  }
}
