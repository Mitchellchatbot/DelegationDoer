import { afterEach, describe, expect, it, vi } from "vitest";

import { createSseStream, sseFrame, sseHeartbeat, SSE_HEADERS, SSE_HEARTBEAT_MS, type SseWriter } from "@/lib/exec/chat/sse-server";
import type { ChatSseEvent } from "@/lib/exec/chat/view-types";

// The chat route's SSE writer (P5b contract §3.16.1, B5; tests 79 and 81's writer half): exact frames, the comment
// heartbeat under fake timers, and the closed guard (no throw from a write after a close or a disconnect).

const decoder = new TextDecoder();

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += decoder.decode(value, { stream: true });
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sseFrame / sseHeartbeat", () => {
  it("writes event + one data line of JSON + a blank line", () => {
    const e: ChatSseEvent = { event: "text", data: { round: 2, delta: "line one\nline two\r\n: not a comment\n\nevent: done" } };
    const frame = sseFrame(e);
    expect(frame).toBe(`event: text\ndata: ${JSON.stringify(e.data)}\n\n`);
    // The text can't split the frame: exactly one blank line, at the end, and two lines before it.
    expect(frame!.split("\n")).toHaveLength(4);
    expect(frame!.indexOf("\n\n")).toBe(frame!.length - 2);
    expect(frame!.includes("\r")).toBe(false);
    expect(JSON.parse(frame!.split("\n")[1].slice("data: ".length))).toEqual(e.data);
  });

  it("every event name of the protocol, and nothing else", () => {
    expect(sseFrame({ event: "retract", data: {} })).toBe("event: retract\ndata: {}\n\n");
    expect(sseFrame({ event: "error", data: { code: "internal" } })).toBe('event: error\ndata: {"code":"internal"}\n\n');
    expect(sseFrame({ event: "evil\ndata: x", data: {} } as unknown as ChatSseEvent)).toBeNull();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(sseFrame({ event: "done", data: cyclic } as unknown as ChatSseEvent)).toBeNull();
  });

  it("the heartbeat is a comment with the epoch ms", () => {
    expect(sseHeartbeat(1_762_527_600_123.7)).toBe(": ping 1762527600123\n\n");
    expect(sseHeartbeat(Number.NaN)).toBe(": ping 0\n\n");
  });

  it("the inbox-events header set", () => {
    expect(SSE_HEADERS).toEqual({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    expect(Object.isFrozen(SSE_HEADERS)).toBe(true);
    expect(SSE_HEARTBEAT_MS).toBe(15_000);
  });
});

describe("createSseStream", () => {
  it("start writes at once; close ends the stream; writes after close return false and never throw", async () => {
    let writer: SseWriter | null = null;
    const stream = createSseStream({
      heartbeatMs: 0,
      start: (w) => {
        writer = w;
        expect(w.send({ event: "hello", data: { turnId: "t", conversationId: "c", messageId: "m", created: true } })).toBe(true);
        w.close();
        expect(w.closed).toBe(true);
        expect(w.send({ event: "retract", data: {} })).toBe(false);
        w.close();
      }
    });
    expect(await readAll(stream)).toBe('event: hello\ndata: {"turnId":"t","conversationId":"c","messageId":"m","created":true}\n\n');
    expect(() => writer!.send({ event: "retract", data: {} })).not.toThrow();
  });

  it("a heartbeat every 15 s under fake timers, stopped by close", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-11-07T15:00:00.000Z"));
    let writer: SseWriter | null = null;
    const stream = createSseStream({ start: (w) => void (writer = w) });
    const reader = stream.getReader();
    await vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_MS - 1);
    writer!.send({ event: "retract", data: {} });
    expect(decoder.decode((await reader.read()).value)).toBe("event: retract\ndata: {}\n\n");
    await vi.advanceTimersByTimeAsync(1);
    expect(decoder.decode((await reader.read()).value)).toBe(`: ping ${Date.parse("2026-11-07T15:00:15.000Z")}\n\n`);
    await vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_MS);
    expect(decoder.decode((await reader.read()).value)).toBe(`: ping ${Date.parse("2026-11-07T15:00:30.000Z")}\n\n`);
    writer!.close();
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a cancel (the client left) stops the heartbeat, calls onCancel once, and later writes are dropped quietly", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    let writer: SseWriter | null = null;
    const onCancel = vi.fn(() => {
      throw new Error("ignored");
    });
    const stream = createSseStream({ onCancel, start: (w) => void (writer = w) });
    const reader = stream.getReader();
    await reader.cancel();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(writer!.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(writer!.send({ event: "text", data: { round: 1, delta: "late" } })).toBe(false);
    expect(() => writer!.close()).not.toThrow();
  });

  it("a start that throws ends the stream instead of erroring it", async () => {
    const stream = createSseStream({
      heartbeatMs: 0,
      start: (w) => {
        w.send({ event: "retract", data: {} });
        throw new Error("boom");
      }
    });
    expect(await readAll(stream)).toBe("event: retract\ndata: {}\n\n");
  });
});
