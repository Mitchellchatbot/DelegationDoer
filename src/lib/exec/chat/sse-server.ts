import type { ChatSseEvent } from "@/lib/exec/chat/view-types";

// The chat route's Server-Sent Events writer (P5b contract §3.16.1, B5; Area D).
// Pure and client-safe (boundary B4: chat/** imports chat/** and types only),
// though only the route uses it: frames, the heartbeat and the closed guard.
//
//   * A frame is `event: <name>\ndata: <JSON>\n\n`. JSON.stringify escapes
//     every control character, so a data line can't hold a raw line break and
//     a frame can't be split or forged by the text it carries.
//   * The heartbeat is an SSE comment, `: ping <epoch ms>\n\n`, every 15 s, so
//     a proxy sees bytes while the model thinks; the parser ignores it.
//   * Writes after the stream closed, or after the client went away (enqueue
//     then throws), are dropped: they return false and never throw, so the
//     turn behind the stream runs to its end and is stored either way.
//
// The writer never logs and never sees an error's text.

/** B5: a comment heartbeat every 15 s. */
export const SSE_HEARTBEAT_MS = 15_000;

/** The inbox-events header set (src/app/api/inbox-events/route.ts), except Cache-Control: these bodies carry his whole
 *  answer, so it keeps next.config's /api/exec/* "private, no-store" (security-4); no-store doesn't affect streaming and
 *  no-transform still stops proxy buffering and compression. next.config's other /api/exec/* headers are added by Next. */
export const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "private, no-store, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no"
});

const EVENT_NAMES: ReadonlySet<string> = new Set(["hello", "text", "tool", "retract", "done", "error"]);

/** One frame's text, or null when the event can't be written whole (an unknown name, data JSON can't hold). */
export function sseFrame(e: ChatSseEvent): string | null {
  if (!e || typeof e.event !== "string" || !EVENT_NAMES.has(e.event)) return null;
  let json: string | undefined;
  try {
    json = JSON.stringify(e.data);
  } catch {
    return null;
  }
  if (typeof json !== "string") return null;
  return `event: ${e.event}\ndata: ${json}\n\n`;
}

/** The heartbeat comment: `: ping <epoch ms>\n\n`. */
export function sseHeartbeat(nowMs: number): string {
  const ms = Number.isFinite(nowMs) ? Math.floor(nowMs) : 0;
  return `: ping ${ms}\n\n`;
}

export interface SseWriter {
  /** Writes one frame. False, and no throw, once the stream is closed or the client has gone. */
  send(e: ChatSseEvent): boolean;
  /** Stops the heartbeat and ends the stream. Idempotent. */
  close(): void;
  readonly closed: boolean;
}

export interface SseStreamOptions {
  /** Default SSE_HEARTBEAT_MS; 0 or less turns the heartbeat off. */
  heartbeatMs?: number;
  /** The heartbeat's clock (tests). */
  nowMs?: () => number;
  /** The reader went away (a disconnect or a cancel). Called once; a throw is ignored. */
  onCancel?: () => void;
  /** Called synchronously from the stream's start with its writer: the first write goes out at once. */
  start: (writer: SseWriter) => void;
}

/** A byte stream of SSE frames: start() writes, the heartbeat runs until close() or a cancel. */
export function createSseStream(opts: SseStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const heartbeatMs = opts.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const nowMs = opts.nowMs ?? (() => Date.now());
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stopHeartbeat = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const write = (chunk: string): boolean => {
    if (closed || controller === null) return false;
    try {
      controller.enqueue(encoder.encode(chunk));
      return true;
    } catch {
      // The client went away: enqueue on a cancelled stream throws (inbox-events' closed flag).
      closed = true;
      stopHeartbeat();
      return false;
    }
  };
  const writer: SseWriter = {
    send(e) {
      const frame = sseFrame(e);
      return frame === null ? false : write(frame);
    },
    close() {
      if (closed) return;
      closed = true;
      stopHeartbeat();
      try {
        controller?.close();
      } catch {
        // already closed or errored
      }
    },
    get closed() {
      return closed;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (heartbeatMs > 0) timer = setInterval(() => void write(sseHeartbeat(nowMs())), heartbeatMs);
      try {
        opts.start(writer);
      } catch {
        // start's own failure must not error the stream: it ends it.
        writer.close();
      }
    },
    cancel() {
      if (!closed) {
        closed = true;
        stopHeartbeat();
      }
      try {
        opts.onCancel?.();
      } catch {
        // a cancel hook that throws changes nothing
      }
    }
  });
}
