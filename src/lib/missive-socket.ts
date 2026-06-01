import { io, type Socket } from "socket.io-client";
import { publish, type InboxEvent } from "@/lib/inbox-event-bus";

// Bridge between missiveclone's socket.io server and DD's in-process
// inbox-event-bus. Connect once per Node process, listen on the
// workspace room for the same events the missiveclone frontend gets
// (`message:new`, `thread:updated`), and republish them locally so the
// existing SSE stream + badge cache busters react in real time.
//
// Why this exists alongside the HMAC webhook (/api/missive-webhook):
//   - Redundancy. If one path is briefly down (socket reconnecting,
//     webhook 404 during a deploy) the other still delivers.
//   - The socket gives us thread:updated (read-state / status changes)
//     events that the webhook doesn't bother POSTing.
//   - It's how missiveclone's own frontend has always done it, so we
//     inherit whatever guarantees that path already provides.
//
// Idempotency: bus subscribers (SSE refresh, badge cache bust) are
// safe to fire twice for the same event. We still dedupe by
// message_id inside a short window to avoid sending two SSE pushes
// for one email when both socket and webhook arrive.

const MISSIVE_API_URL = process.env.MISSIVE_API_URL;
const MISSIVE_API_TOKEN = process.env.MISSIVE_API_TOKEN;

let socket: Socket | null = null;
let initialized = false;

// Per-message dedup: a Set of recently-seen message ids, periodically
// trimmed. 30s window is plenty since the worst-case gap between a
// socket event and a webhook event is far smaller than that.
const seenMessageIds = new Map<string, number>();
const DEDUP_WINDOW_MS = 30_000;

function seenRecently(messageId: string): boolean {
  const now = Date.now();
  // Cheap trim — only runs occasionally, costs O(size) but the cap
  // means size stays small in practice.
  if (seenMessageIds.size > 256) {
    for (const [id, ts] of seenMessageIds) {
      if (now - ts > DEDUP_WINDOW_MS) seenMessageIds.delete(id);
    }
  }
  const last = seenMessageIds.get(messageId);
  if (last && now - last < DEDUP_WINDOW_MS) return true;
  seenMessageIds.set(messageId, now);
  return false;
}

// Public dedup so the webhook receiver can consult the same map. If
// the socket already delivered this message_id in the last 30s, the
// webhook treats it as redundant and skips republishing.
export function isDuplicateMessage(messageId: string | undefined | null): boolean {
  if (!messageId) return false;
  return seenRecently(messageId);
}

// Lazily start the socket bridge on first call. Idempotent — repeated
// calls return immediately once the connection has been opened.
//
// Module-scoped singleton lives in `globalThis` so Next.js dev-mode
// hot reload doesn't open a fresh socket on every recompile (each new
// module instance would leak its predecessor's socket).
const globalKey = "__ddMissiveSocket" as const;
type GlobalWithSocket = typeof globalThis & {
  [globalKey]?: { socket: Socket | null; initialized: boolean };
};
const g = globalThis as GlobalWithSocket;

// Read-only snapshot of the socket's current state. Used by the debug
// endpoint so the user can verify connectivity without trusting that
// Railway's log viewer is keeping up.
let lastConnectError: { at: number; message: string } | null = null;
let lastDisconnectReason: { at: number; reason: string } | null = null;
let connectAttempts = 0;
let successfulConnects = 0;

export function getMissiveSocketStatus(): {
  initialized: boolean;
  connected: boolean;
  socketId: string | null;
  url: string | null;
  connectAttempts: number;
  successfulConnects: number;
  lastConnectError: { at: number; message: string } | null;
  lastDisconnectReason: { at: number; reason: string } | null;
} {
  return {
    initialized,
    connected: socket?.connected === true,
    socketId: socket?.id ?? null,
    url: MISSIVE_API_URL ?? null,
    connectAttempts,
    successfulConnects,
    lastConnectError,
    lastDisconnectReason
  };
}

export function startMissiveSocketBridge(): void {
  if (g[globalKey]?.initialized) {
    socket = g[globalKey]!.socket;
    initialized = true;
    return;
  }
  if (initialized) return;
  if (!MISSIVE_API_URL || !MISSIVE_API_TOKEN) {
    // Missing config is normal in CI / local dev — log once and skip.
    console.warn("[missive-socket] MISSIVE_API_URL or MISSIVE_API_TOKEN not set; live socket bridge disabled");
    initialized = true;
    g[globalKey] = { socket: null, initialized: true };
    return;
  }
  initialized = true;
  console.log("[missive-socket] connecting to", MISSIVE_API_URL);

  socket = io(MISSIVE_API_URL, {
    auth: { token: MISSIVE_API_TOKEN },
    // missiveclone's auth payload includes workspace_id, so the server
    // joins us into the right room automatically; no explicit join.
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 30_000,
    timeout: 20_000
  });

  socket.on("connect", () => {
    successfulConnects += 1;
    lastConnectError = null;
    console.log("[missive-socket] connected as", socket?.id);
  });
  socket.on("disconnect", (reason) => {
    lastDisconnectReason = { at: Date.now(), reason: String(reason) };
    console.warn("[missive-socket] disconnected:", reason);
  });
  socket.on("connect_error", (err) => {
    connectAttempts += 1;
    const message = err && err.message ? err.message : String(err);
    lastConnectError = { at: Date.now(), message };
    // Logged but not fatal — socket.io auto-reconnects.
    console.warn("[missive-socket] connect error:", message);
  });

  // Same event names missiveclone's frontend listens to. Payload
  // shapes mirror what emitToWorkspace sends from ingestMessage —
  // missiveclone was updated alongside this bridge to include
  // account_id so DD's per-user SSE filter can scope events to a
  // worker's visible accounts.
  socket.on("message:new", (payload: { thread_id?: string; message_id?: string; account_id?: string }) => {
    if (!payload?.thread_id || !payload?.account_id) return;
    if (payload.message_id && seenRecently(payload.message_id)) return;
    const event: InboxEvent = {
      event: "message:new",
      account_id: payload.account_id,
      thread_id: payload.thread_id,
      message_id: payload.message_id,
      ts: Date.now()
    };
    publish(event);
  });

  socket.on("thread:updated", (payload: { thread_id?: string; account_id?: string }) => {
    if (!payload?.thread_id || !payload?.account_id) return;
    publish({
      event: "thread:updated",
      account_id: payload.account_id,
      thread_id: payload.thread_id,
      ts: Date.now()
    });
  });

  g[globalKey] = { socket, initialized: true };
}
