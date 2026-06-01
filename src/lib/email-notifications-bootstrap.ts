// Starts the email-notifications fan-out on server boot.
//
// Same host-agnostic scheduler pattern as email-intake-bootstrap. Two
// independent paths into email_notifications:
//
//   1. Real-time:  socket-bridge → inbox-event-bus → fanOutInboxEvent.
//      Fires within ~1s of an inbound message landing in missiveclone.
//      Replaces the missive-webhook path (which kept silently failing
//      on config drift) — the socket bridge maintains an outbound
//      WebSocket from DD to missiveclone, so there's no inbound URL
//      missiveclone has to know about.
//   2. Safety net: an in-process poll every 5 minutes. Catches any
//      messages that landed while the socket was briefly disconnected
//      (network blip, missiveclone redeploy, etc.).
//
// Subsystems boot inside independent try/catches so a failure in one
// can't kill the others. Idempotent — `register()` may be called more
// than once (HMR in dev) and we guard with a globalThis singleton.

import { subscribe, type InboxEvent } from "@/lib/inbox-event-bus";
import { startMissiveSocketBridge } from "@/lib/missive-socket";
import { fanOutInboxEvent } from "@/lib/email-notifications";
import { pollEmailNotifications } from "@/lib/email-notifications-poller";

const globalKey = "__ddEmailNotifBootstrap" as const;
const stateKey = "__ddEmailNotifState" as const;

interface BootstrapState {
  bootedAt: number;
  busSubscribed: boolean;
  pollScheduled: boolean;
  lastLiveFanoutAt: number | null;
  lastLiveFanoutEvent: string | null;
  lastLiveFanoutAccountId: string | null;
  lastLiveFanoutRows: number | null;
  liveFanoutTotal: number;
  lastPollAt: number | null;
  lastPollAccountsScanned: number;
  lastPollRowsWritten: number;
  lastPollErrors: number;
  lastError: string | null;
}

type GlobalWithBootstrap = typeof globalThis & {
  [globalKey]?: boolean;
  [stateKey]?: BootstrapState;
};

const POLL_INTERVAL_MS = 5 * 60 * 1000;

// Read-only snapshot for the debug endpoint. Returns null when the
// bootstrap hasn't run yet — that itself is diagnostic (the new code
// either hasn't deployed or instrumentation.ts didn't fire).
export function getEmailNotifBootstrapState(): BootstrapState | null {
  const g = globalThis as GlobalWithBootstrap;
  return g[stateKey] ?? null;
}

export function bootstrapEmailNotifications(): void {
  const g = globalThis as GlobalWithBootstrap;
  if (g[globalKey]) return;
  g[globalKey] = true;
  const state: BootstrapState = {
    bootedAt: Date.now(),
    busSubscribed: false,
    pollScheduled: false,
    lastLiveFanoutAt: null,
    lastLiveFanoutEvent: null,
    lastLiveFanoutAccountId: null,
    lastLiveFanoutRows: null,
    liveFanoutTotal: 0,
    lastPollAt: null,
    lastPollAccountsScanned: 0,
    lastPollRowsWritten: 0,
    lastPollErrors: 0,
    lastError: null
  };
  g[stateKey] = state;

  // 1. Make sure the socket bridge is alive (idempotent — email-intake
  //    bootstrap also calls this, but multiple calls are no-ops).
  try {
    startMissiveSocketBridge();
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : "socket start failed";
    console.error("[email-notif-boot] socket bridge start failed:", err);
  }

  // 2. Subscribe to the bus. Every inbox event published by either the
  //    socket bridge or the (now-deprecated) missive webhook triggers a
  //    fan-out write per opted-in user.
  try {
    subscribe((event: InboxEvent) => {
      void fanOutInboxEvent(event)
        .then((rows) => {
          state.lastLiveFanoutAt = Date.now();
          state.lastLiveFanoutEvent = event.event;
          state.lastLiveFanoutAccountId = event.account_id;
          state.lastLiveFanoutRows = rows;
          state.liveFanoutTotal += rows;
          if (rows > 0) {
            console.log("[email-notif-boot] live fanout", {
              event: event.event,
              account_id: event.account_id,
              rows
            });
          }
        })
        .catch((err) => {
          state.lastError = err instanceof Error ? err.message : "fanout error";
          console.error("[email-notif-boot] fanout error:", err);
        });
    });
    state.busSubscribed = true;
    console.log("[email-notif-boot] bus subscription registered");
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : "bus subscribe failed";
    console.error("[email-notif-boot] bus subscription failed:", err);
  }

  // 3. Safety-net poll every 5 minutes. Runs alongside the socket so a
  //    transient disconnect doesn't silently lose messages.
  try {
    const runOnce = async () => {
      try {
        const r = await pollEmailNotifications();
        state.lastPollAt = Date.now();
        state.lastPollAccountsScanned = r.accountsScanned;
        state.lastPollRowsWritten = r.rowsWritten;
        state.lastPollErrors = r.errors.length;
        if (r.rowsWritten > 0 || r.errors.length > 0) {
          console.log("[email-notif-boot] poll", r);
        }
      } catch (err) {
        state.lastError = err instanceof Error ? err.message : "poll fatal";
        console.error("[email-notif-boot] poll fatal:", err);
      }
    };
    setInterval(runOnce, POLL_INTERVAL_MS);
    // Burst of three quick early polls after boot (15s, 60s, 180s) so
    // we don't have to wait the full 5min interval to start writing
    // rows after a deploy or first opt-in.
    setTimeout(runOnce, 15_000);
    setTimeout(runOnce, 60_000);
    setTimeout(runOnce, 180_000);
    state.pollScheduled = true;
    console.log("[email-notif-boot] safety-net poll scheduled (5m)");
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : "poll schedule failed";
    console.error("[email-notif-boot] poll schedule failed:", err);
  }
}
