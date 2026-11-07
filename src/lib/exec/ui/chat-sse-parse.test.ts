import { describe, expect, it } from "vitest";
import { createSseParser, toChatSseEvent } from "@/lib/exec/chat/sse-parse";
import type { ChatSseEvent } from "@/lib/exec/chat/view-types";
import { done } from "../__tests__/chat-ui-fixtures";

// P5b contract §5 test 97 (Area E, §3.19.4): frames split across chunks, CRLF,
// comments (the heartbeat), unknown events and bad JSON.

function collect() {
  const events: ChatSseEvent[] = [];
  const parser = createSseParser((e) => events.push(e));
  return { events, parser };
}

const frame = (name: string, data: unknown, eol = "\n") => `event: ${name}${eol}data: ${JSON.stringify(data)}${eol}${eol}`;
const HELLO = { turnId: "et_1", conversationId: "ecv_" + "a".repeat(32), messageId: "em_1", created: true };

describe("createSseParser (test 97)", () => {
  it("parses the route's frames in order: hello, text, tool, retract, done, error", () => {
    const { events, parser } = collect();
    parser.push(
      frame("hello", HELLO) +
        frame("text", { round: 1, delta: "Hi" }) +
        frame("tool", { round: 1, callId: "c1", name: "get_overview", label: "Checking the company overview", state: "running" }) +
        frame("retract", {}) +
        frame("done", done()) +
        frame("error", { code: "internal" })
    );
    expect(events.map((e) => e.event)).toEqual(["hello", "text", "tool", "retract", "done", "error"]);
    expect(events[0]).toEqual({ event: "hello", data: HELLO });
    expect(events[1]).toEqual({ event: "text", data: { round: 1, delta: "Hi" } });
    expect(events[4]).toEqual({ event: "done", data: done() });
    expect(events[5]).toEqual({ event: "error", data: { code: "internal" } });
    expect(parser.dropped()).toBe(0);
  });

  it("joins a frame split across chunks anywhere, including inside the JSON and between \\r and \\n", () => {
    const bytes = frame("text", { round: 2, delta: "split across chunks" }, "\r\n") + frame("text", { round: 2, delta: "!" }, "\r\n");
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const { events, parser } = collect();
      parser.push(bytes.slice(0, cut));
      parser.push(bytes.slice(cut));
      expect(events.map((e) => (e.event === "text" ? e.data.delta : e.event)), `cut ${cut}`).toEqual(["split across chunks", "!"]);
    }
    // One character at a time.
    const { events, parser } = collect();
    for (const ch of bytes) parser.push(ch);
    expect(events).toHaveLength(2);
  });

  it("accepts \\n, \\r\\n and a lone \\r as line ends", () => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      const { events, parser } = collect();
      parser.push(frame("text", { round: 1, delta: "x" }, eol));
      parser.end();
      expect(events, JSON.stringify(eol)).toEqual([{ event: "text", data: { round: 1, delta: "x" } }]);
    }
  });

  it("joins multi-line data with \\n and drops one space after the colon", () => {
    const { events, parser } = collect();
    parser.push('event: text\ndata: {"round": 1,\ndata:"delta": "a b"}\n\n');
    expect(events).toEqual([{ event: "text", data: { round: 1, delta: "a b" } }]);
  });

  it("ignores comment lines (the heartbeat), id and retry fields", () => {
    const { events, parser } = collect();
    parser.push(": ping 1793000000000\n\n");
    parser.push("id: 7\nretry: 1000\n" + frame("text", { round: 1, delta: "ok" }));
    parser.push(": ping 1793000015000\n\n");
    expect(events).toEqual([{ event: "text", data: { round: 1, delta: "ok" } }]);
    expect(parser.dropped()).toBe(0);
  });

  it("drops and counts unknown event names, unnamed events, bad JSON and wrong shapes", () => {
    const { events, parser } = collect();
    parser.push(frame("surprise", { a: 1 }));
    parser.push(`data: ${JSON.stringify({ round: 1, delta: "no name" })}\n\n`);
    parser.push("event: text\ndata: {not json\n\n");
    parser.push(frame("text", { round: "1", delta: "x" }));
    parser.push(frame("tool", { round: 1, callId: "c", name: "n", label: "l", state: "exploded" }));
    parser.push(frame("done", { messageId: "m" }));
    parser.push(frame("hello", { turnId: "t" }));
    parser.push("event: text\n\n");
    expect(events).toEqual([]);
    expect(parser.dropped()).toBe(8);
    // And the stream goes on.
    parser.push(frame("text", { round: 1, delta: "still fine" }));
    expect(events).toHaveLength(1);
  });

  it("end() drops an event the stream left open, as the standard says", () => {
    const { events, parser } = collect();
    parser.push('event: done\ndata: {"messageId"');
    parser.end();
    expect(events).toEqual([]);
    expect(parser.dropped()).toBe(1);
  });

  it("toChatSseEvent: error never carries a message; retract carries nothing", () => {
    expect(toChatSseEvent("error", { code: "internal", message: "secret" })).toEqual({ event: "error", data: { code: "internal" } });
    expect(toChatSseEvent("retract", { anything: 1 })).toEqual({ event: "retract", data: {} });
    expect(toChatSseEvent("text", null)).toBeNull();
  });
});
