// Starts the #email-notifs Slack notifier on server boot.
//
// Same host-agnostic scheduler pattern as email-notifications-bootstrap: the
// app runs on Railway, where the crons declared in vercel.json never fire, so
// anything scheduled has to be an in-process interval registered from
// instrumentation.ts.
//
// Two paths into the channel:
//   1. Real-time: inbox-event-bus → notifyClientEmailToSlack. The bus is fed
//      by BOTH the HMAC webhook and the socket.io bridge, and their shared
//      30s message_id dedupe means the bus sees each message once — so one
//      subscription covers both delivery paths without doubling posts.
//   2. Safety net: a 5-minute poll, for a window where both real-time paths
//      were down at once (missiveclone redeploy, socket reconnect storm).
//
// Cross-process dedupe is the claim table, not this file — see the header of
// client-email-slack.ts.

import { subscribe, type InboxEvent } from "@/lib/inbox-event-bus";
import { startMissiveSocketBridge } from "@/lib/missive-socket";
import { notifyClientEmailToSlack, pollClientEmailSlack } from "@/lib/client-email-slack";

const globalKey = "__ddClientEmailSlackBootstrap" as const;
const stateKey = "__ddClientEmailSlackState" as const;

export interface ClientEmailSlackState {
  bootedAt: number;
  busSubscribed: boolean;
  pollScheduled: boolean;
  lastPostedAt: number | null;
  lastPostedClient: string | null;
  lastPostedSubject: string | null;
  postedTotal: number;
  lastSkipReason: string | null;
  lastPollAt: number | null;
  lastPollThreadsExamined: number;
  lastPollPosted: number;
  lastPollErrors: number;
  lastError: string | null;
}

type GlobalWithBootstrap = typeof globalThis & {
  [globalKey]?: boolean;
  [stateKey]?: ClientEmailSlackState;
};

const POLL_INTERVAL_MS = 5 * 60 * 1000;

// Read-only snapshot for the debug endpoint. null means the bootstrap never
// ran, which is itself the diagnosis (code not deployed, or
// instrumentation.ts didn't fire).
export function getClientEmailSlackState(): ClientEmailSlackState | null {
  const g = globalThis as GlobalWithBootstrap;
  return g[stateKey] ?? null;
}

export function bootstrapClientEmailSlack(): void {
  const g = globalThis as GlobalWithBootstrap;
  if (g[globalKey]) return;
  g[globalKey] = true;
  const state: ClientEmailSlackState = {
    bootedAt: Date.now(),
    busSubscribed: false,
    pollScheduled: false,
    lastPostedAt: null,
    lastPostedClient: null,
    lastPostedSubject: null,
    postedTotal: 0,
    lastSkipReason: null,
    lastPollAt: null,
    lastPollThreadsExamined: 0,
    lastPollPosted: 0,
    lastPollErrors: 0,
    lastError: null
  };
  g[stateKey] = state;

  // 1. Socket bridge (idempotent — the intake and notification bootstraps
  //    call this too; repeated calls are no-ops).
  try {
    startMissiveSocketBridge();
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : "socket start failed";
    console.error("[client-email-slack-boot] socket bridge start failed:", err);
  }

  // 2. Real-time bus subscription.
  try {
    subscribe((event: InboxEvent) => {
      void notifyClientEmailToSlack(event)
        .then((outcome) => {
          if (outcome.status === "posted") {
            state.lastPostedAt = Date.now();
            state.lastPostedClient = outcome.clientName ?? null;
            state.lastPostedSubject = outcome.subject ?? null;
            state.postedTotal += 1;
            console.log("[client-email-slack] posted", {
              client: outcome.clientName,
              from: outcome.fromEmail,
              thread: outcome.threadId
            });
          } else if (outcome.status === "error") {
            state.lastError = String(outcome.reason ?? "post failed");
          } else {
            state.lastSkipReason = String(outcome.reason ?? "skipped");
          }
        })
        .catch((err) => {
          state.lastError = err instanceof Error ? err.message : "notify threw";
          console.error("[client-email-slack] notify threw:", err);
        });
    });
    state.busSubscribed = true;
    console.log("[client-email-slack-boot] bus subscription registered");
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : "bus subscribe failed";
    console.error("[client-email-slack-boot] bus subscription failed:", err);
  }

  // 3. Safety-net poll. Same 15s/60s/180s early burst as the notification
  //    bootstrap so a deploy starts covering gaps without waiting 5 minutes.
  try {
    const runOnce = async () => {
      try {
        const r = await pollClientEmailSlack();
        state.lastPollAt = Date.now();
        state.lastPollThreadsExamined = r.threadsExamined;
        state.lastPollPosted = r.posted;
        state.lastPollErrors = r.errors;
        if (r.posted > 0 || r.errors > 0) {
          console.log("[client-email-slack-boot] poll", {
            threadsExamined: r.threadsExamined,
            posted: r.posted,
            errors: r.errors
          });
        }
      } catch (err) {
        state.lastError = err instanceof Error ? err.message : "poll fatal";
        console.error("[client-email-slack-boot] poll fatal:", err);
      }
    };
    setInterval(runOnce, POLL_INTERVAL_MS);
    setTimeout(runOnce, 15_000);
    setTimeout(runOnce, 60_000);
    setTimeout(runOnce, 180_000);
    state.pollScheduled = true;
    console.log("[client-email-slack-boot] safety-net poll scheduled (5m)");
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : "poll schedule failed";
    console.error("[client-email-slack-boot] poll schedule failed:", err);
  }
}
