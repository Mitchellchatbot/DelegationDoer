import { NextRequest } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { getUserById } from "@/lib/server-data";
import { visibleAccountIdsFor } from "@/lib/inbox-access";
import { subscribe, type InboxEvent } from "@/lib/inbox-event-bus";
import { startMissiveSocketBridge } from "@/lib/missive-socket";

export const dynamic = "force-dynamic";
// Node runtime — the in-process event bus is a singleton owned by this
// Node worker, so the stream and its publishers have to share the same
// process. Edge runtime would isolate them and the stream would never
// fire.
export const runtime = "nodejs";

// GET /api/inbox-events
//   Per-user Server-Sent Events stream. Subscribes to the in-process
//   inbox bus, filters events to accounts the caller can see, and
//   streams `data: {...}\n\n` chunks back to the browser. Keepalive
//   pings every 25 s keep proxy timeouts from killing the long-lived
//   connection.
//
//   Used by the Sidebar (refresh badge counts) and InboxThreadsClient
//   (surgical refresh of the visible thread list) to react to inbound
//   email pushed from missiveclone within ~1 s instead of waiting for
//   the next REST poll.

const KEEPALIVE_INTERVAL_MS = 25_000;

export async function GET(req: NextRequest) {
  // Lazy-init the missiveclone socket bridge on the first SSE
  // subscription. Idempotent — repeated calls are no-ops, and the
  // singleton lives in globalThis so dev-mode hot reloads don't
  // multiply connections.
  startMissiveSocketBridge();

  let userId: string;
  try {
    userId = await requireCurrentUserId();
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  const me = await getUserById(userId);
  if (!me) return new Response("unauthorized", { status: 401 });

  const visible = await visibleAccountIdsFor(me);
  // null means "leader / admin / sees everything"; we let every event
  // through. For everyone else we filter to their assigned + space-
  // granted account set.

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      function send(event: string, data: unknown) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      }
      // Initial hello — useful for the client to know the stream is
      // alive without waiting for the first real event.
      send("hello", { ts: Date.now() });

      const unsubscribe = subscribe((e: InboxEvent) => {
        if (visible !== null && !visible.has(e.account_id)) return;
        send("inbox", e);
      });

      const keepalive = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`)); }
        catch { closed = true; }
      }, KEEPALIVE_INTERVAL_MS);

      function close() {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      }

      // Tear down when the client disconnects. AbortSignal fires when
      // the request is cancelled (tab closed, browser navigated, etc.)
      // — without this the listener leaks until process restart.
      req.signal.addEventListener("abort", close);
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      // Disable buffering on Nginx-style proxies (Railway uses one).
      // Without this the events queue up until the proxy decides to
      // flush, which can be minutes.
      "X-Accel-Buffering": "no"
    }
  });
}
