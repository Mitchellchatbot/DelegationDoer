import type { ChatSseEvent } from "@/lib/exec/chat/view-types";

// The chat stream's parser (P5b contract §3.19.4; Area E): the bytes of
// POST /api/exec/chat, decoded to text, in whatever chunks the network hands
// them over, to ChatSseEvent values. Pure and client-safe (boundary B4).
//
// The SSE framing (WHATWG "server-sent events", the parts the route uses):
// lines end in "\n", "\r\n" or "\r"; a blank line ends an event; "event:"
// names it and every "data:" line adds one line to its data; a line that
// starts with ":" is a comment (the route's heartbeat). One space after the
// colon is dropped. A chunk may end anywhere, even between "\r" and "\n" or
// inside a multi-byte character (the caller's TextDecoder handles that), so
// the parser only acts on complete lines. An event still open when the
// stream ends is dropped, as the standard says.
//
// What it hands on is checked: an unknown event name, data that isn't JSON,
// or JSON that doesn't have the event's shape is dropped and counted, never
// passed to the reducer.

export interface SseParser {
  /** Feed the next decoded chunk. */
  push(chunk: string): void;
  /** The stream ended: drop whatever event is still open. */
  end(): void;
  /** Events dropped so far: unknown names, bad JSON, wrong shape (counts only). */
  dropped(): number;
}

const STATUSES: ReadonlySet<string> = new Set(["running", "complete", "aborted", "refused", "failed", "capped"]);
const TOOL_STATES: ReadonlySet<string> = new Set(["running", "done", "error", "skipped"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isRound = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The event if `name` and `data` have one of ChatSseEvent's shapes, else null. */
export function toChatSseEvent(name: string, data: unknown): ChatSseEvent | null {
  if (!isObject(data)) return null;
  switch (name) {
    case "hello":
      return isString(data.turnId) && isString(data.conversationId) && isString(data.messageId) && typeof data.created === "boolean"
        ? { event: "hello", data: { turnId: data.turnId, conversationId: data.conversationId, messageId: data.messageId, created: data.created } }
        : null;
    case "text":
      return isRound(data.round) && isString(data.delta) ? { event: "text", data: { round: data.round, delta: data.delta } } : null;
    case "tool":
      return isRound(data.round) && isString(data.callId) && isString(data.name) && isString(data.label) && isString(data.state) && TOOL_STATES.has(data.state)
        ? {
            event: "tool",
            data: { round: data.round, callId: data.callId, name: data.name, label: data.label, state: data.state as "running" | "done" | "error" | "skipped" }
          }
        : null;
    case "retract":
      return { event: "retract", data: {} };
    case "done": {
      const d = data;
      const ok =
        isString(d.messageId) &&
        isString(d.conversationId) &&
        isString(d.turnId) &&
        isString(d.conversationTitle) &&
        isString(d.status) &&
        STATUSES.has(d.status) &&
        (d.statusReason === null || isString(d.statusReason)) &&
        isString(d.answer) &&
        isString(d.recommendations) &&
        Array.isArray(d.sources) &&
        Array.isArray(d.cards) &&
        typeof d.saved === "boolean";
      return ok ? ({ event: "done", data: d } as unknown as ChatSseEvent) : null;
    }
    case "error":
      return { event: "error", data: { code: "internal" } };
    default:
      return null;
  }
}

export function createSseParser(onEvent: (e: ChatSseEvent) => void): SseParser {
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];
  let hasData = false;
  let dropped = 0;

  const dispatch = () => {
    const name = eventName;
    const raw = dataLines.join("\n");
    const had = hasData;
    eventName = "";
    dataLines = [];
    hasData = false;
    if (!had && name === "") return;
    if (!had) {
      dropped += 1;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      dropped += 1;
      return;
    }
    const event = toChatSseEvent(name, parsed);
    if (event === null) {
      dropped += 1;
      return;
    }
    onEvent(event);
  };

  const line = (text: string) => {
    if (text === "") {
      dispatch();
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") {
      dataLines.push(value);
      hasData = true;
    }
    // id, retry and unknown fields are ignored.
  };

  return {
    push(chunk: string) {
      if (typeof chunk !== "string" || chunk.length === 0) return;
      buffer += chunk;
      let start = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const ch = buffer.charCodeAt(i);
        if (ch === 10) {
          line(buffer.slice(start, i));
          start = i + 1;
        } else if (ch === 13) {
          // "\r" at the very end may be the first half of "\r\n": wait for the next chunk.
          if (i === buffer.length - 1) break;
          line(buffer.slice(start, i));
          if (buffer.charCodeAt(i + 1) === 10) i += 1;
          start = i + 1;
        }
      }
      buffer = buffer.slice(start);
    },
    end() {
      // A lone "\r" held back at the end closes its line; an open event is dropped.
      if (buffer.endsWith("\r")) line(buffer.slice(0, -1));
      buffer = "";
      if (hasData || eventName !== "") dropped += 1;
      eventName = "";
      dataLines = [];
      hasData = false;
    },
    dropped: () => dropped
  };
}
