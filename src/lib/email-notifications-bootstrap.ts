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
type GlobalWithBootstrap = typeof globalThis & { [globalKey]?: boolean };

const POLL_INTERVAL_MS = 5 * 60 * 1000;

export function bootstrapEmailNotifications(): void {
  const g = globalThis as GlobalWithBootstrap;
  if (g[globalKey]) return;
  g[globalKey] = true;

  // 1. Make sure the socket bridge is alive (idempotent — email-intake
  //    bootstrap also calls this, but multiple calls are no-ops).
  try {
    startMissiveSocketBridge();
  } catch (err) {
    console.error("[email-notif-boot] socket bridge start failed:", err);
  }

  // 2. Subscribe to the bus. Every inbox event published by either the
  //    socket bridge or the (now-deprecated) missive webhook triggers a
  //    fan-out write per opted-in user.
  try {
    subscribe((event: InboxEvent) => {
      void fanOutInboxEvent(event)
        .then((rows) => {
          if (rows > 0) {
            console.log("[email-notif-boot] live fanout", {
              event: event.event,
              account_id: event.account_id,
              rows
            });
          }
        })
        .catch((err) => {
          console.error("[email-notif-boot] fanout error:", err);
        });
    });
    console.log("[email-notif-boot] bus subscription registered");
  } catch (err) {
    console.error("[email-notif-boot] bus subscription failed:", err);
  }

  // 3. Safety-net poll every 5 minutes. Runs alongside the socket so a
  //    transient disconnect doesn't silently lose messages.
  try {
    const runOnce = async () => {
      try {
        const r = await pollEmailNotifications();
        if (r.rowsWritten > 0 || r.errors.length > 0) {
          console.log("[email-notif-boot] poll", r);
        }
      } catch (err) {
        console.error("[email-notif-boot] poll fatal:", err);
      }
    };
    setInterval(runOnce, POLL_INTERVAL_MS);
    // Kick the first run shortly after boot — covers anything that
    // landed while the process was restarting.
    setTimeout(runOnce, 15_000);
    console.log("[email-notif-boot] safety-net poll scheduled (5m)");
  } catch (err) {
    console.error("[email-notif-boot] poll schedule failed:", err);
  }
}
