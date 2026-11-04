import { describe, expect, it, vi } from "vitest";

import { ExecRequestShapeError, assertExecRequestShape, type ExecMessageParam } from "@/lib/exec/llm/request";
import {
  LlmProtocolError,
  StreamAccumulator,
  StreamEventError,
  accumulateStream,
  isReplayable,
  messageFromResponse,
  messageText,
  toolUses,
  type ExecMessage
} from "@/lib/exec/llm/stream";

// ---------------------------------------------------------------------------
// Fixture builders (shapes as the API streams them)
// ---------------------------------------------------------------------------

const START_USAGE = {
  input_tokens: 25,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  service_tier: "standard"
};

function messageStart(usage: Record<string, unknown> = START_USAGE, extra: Record<string, unknown> = {}) {
  return {
    type: "message_start",
    message: {
      id: "msg_01",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
      ...extra
    }
  };
}
const blockStart = (index: number, content_block: Record<string, unknown>) => ({ type: "content_block_start", index, content_block });
const delta = (index: number, d: Record<string, unknown>) => ({ type: "content_block_delta", index, delta: d });
const blockStop = (index: number) => ({ type: "content_block_stop", index });
const messageDelta = (
  stop_reason: string,
  usage: Record<string, unknown> = { output_tokens: 42 },
  extra: Record<string, unknown> = {}
) => ({ type: "message_delta", delta: { stop_reason, stop_sequence: null, ...extra }, usage });
const MESSAGE_STOP = { type: "message_stop" };
const PING = { type: "ping" };

async function* from(events: unknown[]): AsyncGenerator<unknown> {
  for (const e of events) yield e;
}

// A realistic signature: long, base64 with +, / and = that must survive byte-for-byte.
const SIGNATURE =
  "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds+/w==ErUBCkYIBRgCIkBX7xZPjmOnQRZp1yi4i2vZ8bD/9cAL" +
  "m4q0Xp8hYwRk1KqZ9zrkzK5ynjPc+MKLlCwWZ4Jx==";

function textOnly(): unknown[] {
  return [
    messageStart(),
    blockStart(0, { type: "text", text: "" }),
    PING,
    delta(0, { type: "text_delta", text: "Hello" }),
    delta(0, { type: "text_delta", text: ", Mitchell." }),
    blockStop(0),
    messageDelta("end_turn", { output_tokens: 7 }),
    MESSAGE_STOP
  ];
}

function thinkingToolLoop(): unknown[] {
  return [
    messageStart(),
    blockStart(0, { type: "thinking", thinking: "", signature: "" }),
    delta(0, { type: "thinking_delta", thinking: "Need Tokyo's time; " }),
    delta(0, { type: "thinking_delta", thinking: "call the tool." }),
    delta(0, { type: "signature_delta", signature: SIGNATURE }),
    blockStop(0),
    blockStart(1, { type: "text", text: "" }),
    delta(1, { type: "text_delta", text: "Checking." }),
    blockStop(1),
    blockStart(2, { type: "tool_use", id: "toolu_01", name: "get_local_time", input: {} }),
    // Split mid-key, mid-value and inside a \u escape: only the concatenation is valid JSON.
    delta(2, { type: "input_json_delta", partial_json: "" }),
    delta(2, { type: "input_json_delta", partial_json: '{"time' }),
    delta(2, { type: "input_json_delta", partial_json: 'zone": "Asia/To' }),
    delta(2, { type: "input_json_delta", partial_json: 'kyo", "note": "\\u00' }),
    delta(2, { type: "input_json_delta", partial_json: 'e9"}' }),
    blockStop(2),
    messageDelta("tool_use", { output_tokens: 88 }),
    MESSAGE_STOP
  ];
}

// ---------------------------------------------------------------------------

describe("accumulateStream", () => {
  it("assembles a text-only answer and reports each delta with its block index", async () => {
    const onTextDelta = vi.fn();
    const onBlockStart = vi.fn();
    const m = await accumulateStream(from(textOnly()), { onTextDelta, onBlockStart });
    expect(m.id).toBe("msg_01");
    expect(m.model).toBe("claude-opus-5-5");
    expect(m.role).toBe("assistant");
    expect(m.content).toEqual([{ type: "text", text: "Hello, Mitchell." }]);
    expect(m.stop_reason).toBe("end_turn");
    expect(m.stop_sequence).toBeNull();
    expect(m.stop_details).toBeNull();
    expect(m.unknownDeltas).toBe(0);
    expect(m.toolInputErrors).toEqual([]);
    expect(onTextDelta.mock.calls).toEqual([
      ["Hello", 0],
      [", Mitchell.", 0]
    ]);
    expect(onBlockStart).toHaveBeenCalledTimes(1);
    expect(onBlockStart.mock.calls[0][1]).toBe(0);
    expect(messageText(m)).toBe("Hello, Mitchell.");
    expect(isReplayable(m)).toBe(true);
  });

  it("keeps thinking text and the signature exactly, then text, then parsed tool input", async () => {
    const m = await accumulateStream(from(thinkingToolLoop()));
    expect(m.content).toEqual([
      { type: "thinking", thinking: "Need Tokyo's time; call the tool.", signature: SIGNATURE },
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "toolu_01", name: "get_local_time", input: { timezone: "Asia/Tokyo", note: "é" } }
    ]);
    expect((m.content[0] as { signature: string }).signature).toBe(SIGNATURE);
    expect(m.stop_reason).toBe("tool_use");
    expect(toolUses(m)).toEqual([{ type: "tool_use", id: "toolu_01", name: "get_local_time", input: { timezone: "Asia/Tokyo", note: "é" } }]);
    expect(isReplayable(m)).toBe(true);
  });

  it("produces content that replays verbatim into a valid round-2 request", async () => {
    const m = await accumulateStream(from(thinkingToolLoop()));
    const messages: ExecMessageParam[] = [
      { role: "user", content: "What time is it in Tokyo?" },
      { role: "assistant", content: m.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "09:00" }] }
    ];
    expect(() =>
      assertExecRequestShape({
        model: "claude-opus-5-5",
        max_tokens: 1000,
        messages,
        thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } },
        output_config: { effort: "low" }
      })
    ).not.toThrow();
    // Nothing of ours leaked onto the blocks themselves (the API would reject extra fields).
    expect(JSON.stringify(m.content)).not.toMatch(/toolInputErrors|unknownDeltas|partial_json/);
  });

  it("keeps an empty-text thinking block (display omitted) with its signature", async () => {
    const m = await accumulateStream(
      from([
        messageStart(),
        blockStart(0, { type: "thinking", thinking: "", signature: "" }),
        delta(0, { type: "signature_delta", signature: SIGNATURE }),
        blockStop(0),
        blockStart(1, { type: "text", text: "" }),
        delta(1, { type: "text_delta", text: "Done." }),
        blockStop(1),
        messageDelta("end_turn"),
        MESSAGE_STOP
      ])
    );
    expect(m.content[0]).toEqual({ type: "thinking", thinking: "", signature: SIGNATURE });
  });

  it("keeps redacted_thinking data as sent", async () => {
    const m = await accumulateStream(
      from([
        messageStart(),
        blockStart(0, { type: "redacted_thinking", data: "EmwKAhgBEgy3va3pzix/LafPsn4aDFIT2Xlxh0L5L8rLVyIwxtE3rAFBa8cr3qpP" }),
        blockStop(0),
        blockStart(1, { type: "text", text: "ok" }),
        blockStop(1),
        messageDelta("end_turn"),
        MESSAGE_STOP
      ])
    );
    expect(m.content).toEqual([
      { type: "redacted_thinking", data: "EmwKAhgBEgy3va3pzix/LafPsn4aDFIT2Xlxh0L5L8rLVyIwxtE3rAFBa8cr3qpP" },
      { type: "text", text: "ok" }
    ]);
  });

  it("gives a tool call with no input deltas (or only empty ones) an empty object", async () => {
    const m = await accumulateStream(
      from([
        messageStart(),
        blockStart(0, { type: "tool_use", id: "toolu_a", name: "list_tasks", input: {} }),
        blockStop(0),
        blockStart(1, { type: "tool_use", id: "toolu_b", name: "list_tasks", input: {} }),
        delta(1, { type: "input_json_delta", partial_json: "" }),
        delta(1, { type: "input_json_delta", partial_json: "  " }),
        blockStop(1),
        messageDelta("tool_use"),
        MESSAGE_STOP
      ])
    );
    expect(toolUses(m).map((t) => t.input)).toEqual([{}, {}]);
    expect(m.toolInputErrors).toEqual([]);
  });

  it("records unparseable or non-object tool input by index, leaving input {}", async () => {
    const m = await accumulateStream(
      from([
        messageStart(),
        blockStart(0, { type: "text", text: "" }),
        blockStop(0),
        blockStart(1, { type: "tool_use", id: "toolu_a", name: "get_local_time", input: {} }),
        delta(1, { type: "input_json_delta", partial_json: '{"timezone": "Asia/Tok' }),
        blockStop(1),
        blockStart(2, { type: "tool_use", id: "toolu_b", name: "get_local_time", input: {} }),
        delta(2, { type: "input_json_delta", partial_json: '["not", "an", "object"]' }),
        blockStop(2),
        messageDelta("tool_use"),
        MESSAGE_STOP
      ])
    );
    expect(m.toolInputErrors).toEqual([1, 2]);
    expect(toolUses(m).map((t) => t.input)).toEqual([{}, {}]);
    expect(isReplayable(m)).toBe(false);
  });

  it("parses input for a tool block whose content_block_stop never came", async () => {
    const m = await accumulateStream(
      from([
        messageStart(),
        blockStart(0, { type: "tool_use", id: "toolu_a", name: "get_local_time", input: {} }),
        delta(0, { type: "input_json_delta", partial_json: '{"timezone":"UTC"}' }),
        messageDelta("tool_use"),
        MESSAGE_STOP
      ])
    );
    expect(toolUses(m)[0].input).toEqual({ timezone: "UTC" });
  });

  it("appends citations_delta to the text block's citations", async () => {
    const c1 = { type: "char_location", cited_text: "Invoice due Friday", document_index: 0, start_char_index: 0, end_char_index: 18 };
    const c2 = { type: "char_location", cited_text: "Net 30", document_index: 0, start_char_index: 40, end_char_index: 46 };
    const m = await accumulateStream(
      from([
        messageStart(),
        blockStart(0, { type: "text", text: "", citations: [] }),
        delta(0, { type: "citations_delta", citation: c1 }),
        delta(0, { type: "text_delta", text: "Due Friday" }),
        blockStop(0),
        blockStart(1, { type: "text", text: "" }),
        delta(1, { type: "citations_delta", citation: c2 }),
        delta(1, { type: "text_delta", text: ", net 30." }),
        blockStop(1),
        messageDelta("end_turn"),
        MESSAGE_STOP
      ])
    );
    expect(m.content).toEqual([
      { type: "text", text: "Due Friday", citations: [c1] },
      { type: "text", text: ", net 30.", citations: [c2] }
    ]);
    expect(m.unknownDeltas).toBe(0);
  });

  it("keeps unknown block types raw, and fills server tool input from its deltas", async () => {
    const searchResult = {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: [{ type: "web_search_result", url: "https://example.com", title: "Example", encrypted_content: "abc" }]
    };
    const m = await accumulateStream(
      from([
        messageStart(),
        blockStart(0, { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} }),
        delta(0, { type: "input_json_delta", partial_json: '{"query":"scaledai"}' }),
        blockStop(0),
        blockStart(1, searchResult),
        blockStop(1),
        blockStart(2, { type: "future_block_kind", payload: { nested: [1, 2, 3] }, flag: true }),
        blockStop(2),
        messageDelta("end_turn"),
        MESSAGE_STOP
      ])
    );
    expect(m.content).toEqual([
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "scaledai" } },
      searchResult,
      { type: "future_block_kind", payload: { nested: [1, 2, 3] }, flag: true }
    ]);
    expect(m.unknownDeltas).toBe(0);
    // Server tool calls are not client tool calls.
    expect(toolUses(m)).toEqual([]);
  });

  it("never aliases the event objects it was given", async () => {
    const block = { type: "text", text: "" };
    const m = await accumulateStream(
      from([messageStart(), blockStart(0, block), delta(0, { type: "text_delta", text: "x" }), blockStop(0), messageDelta("end_turn"), MESSAGE_STOP])
    );
    expect(block.text).toBe("");
    expect(m.content[0]).toEqual({ type: "text", text: "x" });
  });

  it("counts an unknown delta type and makes the message non-replayable", async () => {
    const m = await accumulateStream(
      from([
        messageStart(),
        blockStart(0, { type: "text", text: "" }),
        delta(0, { type: "text_delta", text: "a" }),
        delta(0, { type: "sparkle_delta", sparkle: "*" }),
        blockStop(0),
        messageDelta("end_turn"),
        MESSAGE_STOP
      ])
    );
    expect(m.unknownDeltas).toBe(1);
    expect(m.content).toEqual([{ type: "text", text: "a" }]);
    expect(isReplayable(m)).toBe(false);
  });

  it("counts deltas that don't fit their block, or point at no block", async () => {
    const m = await accumulateStream(
      from([
        messageStart(),
        blockStart(0, { type: "text", text: "" }),
        delta(0, { type: "thinking_delta", thinking: "x" }), // wrong block type
        delta(0, { type: "signature_delta", signature: "s" }), // wrong block type
        delta(0, { type: "input_json_delta", partial_json: "{}" }), // text takes no input
        delta(0, { type: "text_delta", text: 5 }), // wrong payload type
        delta(7, { type: "text_delta", text: "y" }), // no block 7
        delta(-1, { type: "text_delta", text: "y" }), // not an index
        delta(0, { text: "no type" }), // delta without a type
        { type: "content_block_delta", index: 0 }, // no delta at all
        blockStart(1, { type: "thinking", thinking: "", signature: "" }),
        delta(1, { type: "citations_delta", citation: {} }), // thinking takes no citations
        blockStop(1),
        blockStop(0),
        messageDelta("end_turn"),
        MESSAGE_STOP
      ])
    );
    expect(m.unknownDeltas).toBe(9);
    expect(m.content[0]).toEqual({ type: "text", text: "" });
  });

  it("counts unknown events, malformed block starts and stray stops", async () => {
    const m = await accumulateStream(
      from([
        messageStart(),
        { type: "message_progress", pct: 50 },
        { type: "content_block_start", index: 0 }, // no content_block
        { type: "content_block_start", index: "0", content_block: { type: "text", text: "" } },
        blockStop(3), // nothing at 3
        messageStart(), // a second message_start
        blockStart(0, { type: "text", text: "ok" }),
        blockStop(0),
        messageDelta("end_turn"),
        MESSAGE_STOP,
        delta(0, { type: "text_delta", text: "after the end" }),
        PING // a ping after the end is harmless
      ])
    );
    expect(m.unknownDeltas).toBe(6);
    expect(m.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("throws StreamEventError with the API error type and the partial message on an error event", async () => {
    const events = [
      messageStart(),
      blockStart(0, { type: "text", text: "" }),
      delta(0, { type: "text_delta", text: "Half an ans" }),
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }
    ];
    const err = await accumulateStream(from(events)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamEventError);
    const e = err as StreamEventError;
    expect(e.errorType).toBe("overloaded_error");
    expect(e.message).toContain("Overloaded");
    expect(e.partial?.content).toEqual([{ type: "text", text: "Half an ans" }]);
    expect(e.partial?.usage.input_tokens).toBe(25);
  });

  it("throws StreamEventError with no partial when the error comes first", async () => {
    const err = await accumulateStream(from([{ type: "error", error: "garbled" }])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamEventError);
    expect((err as StreamEventError).errorType).toBe("unknown_error");
    expect((err as StreamEventError).partial).toBeNull();
  });

  it("surfaces a refusal and its stop_details", async () => {
    const m = await accumulateStream(
      from([
        messageStart(),
        blockStart(0, { type: "text", text: "" }),
        delta(0, { type: "text_delta", text: "Part of an answ" }),
        blockStop(0),
        messageDelta("refusal", { output_tokens: 5 }, { stop_details: { type: "refusal", category: "cyber", explanation: null } }),
        MESSAGE_STOP
      ])
    );
    expect(m.stop_reason).toBe("refusal");
    expect(m.stop_details).toEqual({ type: "refusal", category: "cyber", explanation: null });
    // A refusal's partial output is discarded, never continued.
    expect(isReplayable(m)).toBe(false);
  });

  it("merges usage: message_delta values replace message_start's, nulls don't", async () => {
    const m = await accumulateStream(
      from([
        messageStart({
          input_tokens: 1200,
          output_tokens: 1,
          cache_read_input_tokens: 9000,
          cache_creation_input_tokens: 300,
          cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 },
          service_tier: "standard"
        }),
        blockStart(0, { type: "text", text: "" }),
        blockStop(0),
        messageDelta("end_turn", {
          output_tokens: 512,
          input_tokens: null,
          cache_read_input_tokens: 9100,
          server_tool_use: { web_search_requests: 1 }
        }),
        MESSAGE_STOP
      ])
    );
    expect(m.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 512,
      cache_read_input_tokens: 9100,
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 },
      service_tier: "standard",
      server_tool_use: { web_search_requests: 1 }
    });
  });

  it("keeps input_transformations from message_start, replaced by a later message_delta", async () => {
    const first = [{ type: "thinking_dropped", reason: "model_binding_mismatch", path: "messages.1.content.0" }];
    const later = [{ type: "thinking_dropped", reason: "prefix_binding_mismatch", path: "messages.3.content.0" }];
    const m1 = await accumulateStream(
      from([messageStart(START_USAGE, { input_transformations: first }), messageDelta("end_turn"), MESSAGE_STOP])
    );
    expect(m1.input_transformations).toEqual(first);
    const m2 = await accumulateStream(
      from([
        messageStart(START_USAGE, { input_transformations: [] }),
        messageDelta("end_turn", { output_tokens: 1 }, { input_transformations: later }),
        MESSAGE_STOP
      ])
    );
    expect(m2.input_transformations).toEqual(later);
    const m3 = await accumulateStream(from(textOnly()));
    expect(m3).not.toHaveProperty("input_transformations");
  });

  it("refuses a stream that ends before message_stop, attaching what arrived", async () => {
    const events = textOnly().filter((e) => (e as { type: string }).type !== "message_stop");
    const err = await accumulateStream(from(events)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProtocolError);
    expect((err as LlmProtocolError).message).toContain("message_stop");
    expect((err as LlmProtocolError).partial?.content).toEqual([{ type: "text", text: "Hello, Mitchell." }]);
  });

  it("refuses a stream with no message_start", async () => {
    const events = textOnly().filter((e) => (e as { type: string }).type !== "message_start");
    const err = await accumulateStream(from(events)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProtocolError);
    expect((err as LlmProtocolError).message).toContain("message_start");
    expect((err as LlmProtocolError).partial).toBeNull();
  });

  it("refuses an empty stream", async () => {
    await expect(accumulateStream(from([]))).rejects.toBeInstanceOf(LlmProtocolError);
  });

  it.each([null, "event: ping", 42, ["message_stop"], { no: "type" }])("throws on a malformed event: %j", async (bad) => {
    await expect(accumulateStream(from([messageStart(), bad]))).rejects.toBeInstanceOf(LlmProtocolError);
  });

  it("propagates an error thrown by onTextDelta after applying the delta", () => {
    const acc = new StreamAccumulator({
      onTextDelta: () => {
        throw new Error("sink closed");
      }
    });
    acc.push(messageStart());
    acc.push(blockStart(0, { type: "text", text: "" }));
    expect(() => acc.push(delta(0, { type: "text_delta", text: "x" }))).toThrow("sink closed");
    expect(acc.message.content).toEqual([{ type: "text", text: "x" }]);
  });

  it("exposes progress: started, complete and a live snapshot", () => {
    const acc = new StreamAccumulator();
    expect(acc.started).toBe(false);
    expect(acc.complete).toBe(false);
    acc.push(messageStart());
    acc.push(blockStart(0, { type: "text", text: "" }));
    acc.push(delta(0, { type: "text_delta", text: "so far" }));
    expect(acc.started).toBe(true);
    expect(acc.complete).toBe(false);
    expect(acc.message.content).toEqual([{ type: "text", text: "so far" }]);
    expect(acc.message.stop_reason).toBeNull();
    expect(isReplayable(acc.message)).toBe(false);
    expect(() => acc.finish()).toThrow(LlmProtocolError);
    acc.push(blockStop(0));
    acc.push(messageDelta("end_turn"));
    acc.push(MESSAGE_STOP);
    expect(acc.complete).toBe(true);
    expect(acc.finish().stop_reason).toBe("end_turn");
  });

  it("normalises known blocks that arrive without their fields", async () => {
    const m = await accumulateStream(
      from([
        messageStart(),
        blockStart(0, { type: "text" }),
        delta(0, { type: "text_delta", text: "a" }),
        blockStart(1, { type: "thinking" }),
        delta(1, { type: "signature_delta", signature: SIGNATURE }),
        blockStart(2, { type: "tool_use", id: "toolu_x", name: "t" }),
        delta(2, { type: "input_json_delta", partial_json: '{"a":1}' }),
        blockStop(0),
        blockStop(1),
        blockStop(2),
        messageDelta("tool_use"),
        MESSAGE_STOP
      ])
    );
    expect(m.content).toEqual([
      { type: "text", text: "a" },
      { type: "thinking", thinking: "", signature: SIGNATURE },
      { type: "tool_use", id: "toolu_x", name: "t", input: { a: 1 } }
    ]);
  });

  it("tolerates a message_start with no message, and a message_delta with no delta", async () => {
    const m = await accumulateStream(
      from([
        { type: "message_start" },
        blockStart(0, { type: "text", text: "x" }),
        blockStop(0),
        { type: "message_delta", usage: { output_tokens: 3 } },
        MESSAGE_STOP
      ])
    );
    expect(m).toMatchObject({ id: "", model: "", stop_reason: null, usage: { output_tokens: 3 }, unknownDeltas: 0 });
    expect(m.content).toEqual([{ type: "text", text: "x" }]);
  });

  it("keeps stop_details given at message_start and transformations given on the message_delta event", async () => {
    const transformations = [{ type: "thinking_dropped", reason: "model_binding_mismatch" }];
    const m = await accumulateStream(
      from([
        messageStart(START_USAGE, { stop_details: { type: "refusal", category: null } }),
        { type: "message_delta", delta: { stop_reason: "refusal" }, input_transformations: transformations, usage: {} },
        MESSAGE_STOP
      ])
    );
    expect(m.stop_details).toEqual({ type: "refusal", category: null });
    expect(m.input_transformations).toEqual(transformations);
    expect(m.stop_sequence).toBeNull();
  });

  it("seeds blocks a message_start might carry, counting junk among them", async () => {
    const m = await accumulateStream(
      from([
        messageStart(START_USAGE, { content: [{ type: "text", text: "seeded" }, "junk"] }),
        messageDelta("end_turn"),
        MESSAGE_STOP
      ])
    );
    expect(m.content).toEqual([{ type: "text", text: "seeded" }]);
    expect(m.unknownDeltas).toBe(1);
  });
});

describe("messageFromResponse", () => {
  const body = {
    id: "msg_02",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [
      { type: "thinking", thinking: "", signature: SIGNATURE },
      { type: "text", text: '{"urgency":"high"}' }
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 300, output_tokens: 20 }
  };

  it("maps a non-streamed message to the accumulator's shape", () => {
    const m: ExecMessage = messageFromResponse(body);
    expect(m).toEqual({
      id: "msg_02",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: body.content,
      stop_reason: "end_turn",
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 300, output_tokens: 20 },
      toolInputErrors: [],
      unknownDeltas: 0
    });
    expect(messageText(m)).toBe('{"urgency":"high"}');
    expect(isReplayable(m)).toBe(true);
  });

  it("keeps stop_details and input_transformations, and counts junk blocks", () => {
    const m = messageFromResponse({
      ...body,
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: null },
      input_transformations: [],
      content: [...body.content, 7]
    });
    expect(m.stop_details).toEqual({ type: "refusal", category: null });
    expect(m.input_transformations).toEqual([]);
    expect(m.unknownDeltas).toBe(1);
    expect(m.content).toHaveLength(2);
  });

  it.each([null, "text", { type: "error", error: {} }, { type: "message" }, { type: "message", content: "x" }])(
    "throws LlmProtocolError on a body that isn't a message: %j",
    (bad) => {
      expect(() => messageFromResponse(bad)).toThrow(LlmProtocolError);
    }
  );
});

/** The next tool-loop round with `m` replayed verbatim, as a caller would build it. */
function roundTwo(m: ExecMessage): Record<string, unknown> {
  const call = toolUses(m)[0];
  return {
    model: "claude-opus-5-5",
    max_tokens: 1000,
    messages: [
      { role: "user", content: "What time is it in Tokyo?" },
      { role: "assistant", content: m.content },
      { role: "user", content: call ? [{ type: "tool_result", tool_use_id: call.id, content: "09:00" }] : "Go on." }
    ],
    thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } },
    output_config: { effort: "low" }
  };
}

describe("helpers", () => {
  it("isReplayable needs a finished, fully applied, non-refused message", () => {
    const base = messageFromResponse({ type: "message", content: [{ type: "text", text: "x" }], stop_reason: "end_turn" });
    expect(isReplayable(base)).toBe(true);
    expect(isReplayable({ ...base, stop_reason: null })).toBe(false);
    expect(isReplayable({ ...base, stop_reason: "refusal" })).toBe(false);
    expect(isReplayable({ ...base, unknownDeltas: 1 })).toBe(false);
    expect(isReplayable({ ...base, toolInputErrors: [0] })).toBe(false);
  });

  // isReplayable is what a tool loop asks before replaying a reply verbatim
  // (the fallback is a text-only replay). If it said yes to content the guard
  // then refuses, the job would die on a fatal ExecRequestShapeError instead.
  it.each([
    ["an unsigned thinking block", [{ type: "thinking", thinking: "x" }]],
    ["a thinking block with an empty signature", [{ type: "thinking", thinking: "x", signature: "" }]],
    ["a redacted_thinking block without its data", [{ type: "redacted_thinking" }]],
    ["a redacted_thinking block with empty data", [{ type: "redacted_thinking", data: "" }]],
    ["an empty text block", [{ type: "text", text: "" }]],
    ["a text block without text", [{ type: "text" }]]
  ])("isReplayable refuses a non-streamed reply with %s, as the guard would", (_label, blocks) => {
    const toolUse = { type: "tool_use", id: "toolu_01", name: "get_local_time", input: { timezone: "UTC" } };
    const m = messageFromResponse({ type: "message", stop_reason: "tool_use", content: [...blocks, toolUse] });
    expect(m.unknownDeltas).toBe(0);
    expect(isReplayable(m)).toBe(false);
    expect(() => assertExecRequestShape(roundTwo(m))).toThrow(ExecRequestShapeError);
  });

  it("isReplayable refuses a reply with no content at all (an empty assistant turn is a 400)", () => {
    const m = messageFromResponse({ type: "message", stop_reason: "end_turn", content: [] });
    expect(isReplayable(m)).toBe(false);
    expect(() => assertExecRequestShape(roundTwo(m))).toThrow(/messages\[1\]\.content is empty/);
  });

  it("isReplayable refuses a streamed reply whose thinking block never got its signature_delta", async () => {
    const m = await accumulateStream(
      from([
        messageStart(),
        blockStart(0, { type: "thinking", thinking: "", signature: "" }),
        delta(0, { type: "thinking_delta", thinking: "Need the tool." }),
        blockStop(0),
        blockStart(1, { type: "tool_use", id: "toolu_01", name: "get_local_time", input: {} }),
        delta(1, { type: "input_json_delta", partial_json: '{"timezone":"UTC"}' }),
        blockStop(1),
        messageDelta("tool_use"),
        MESSAGE_STOP
      ])
    );
    // Nothing went unapplied: the only problem is the missing signature.
    expect(m.unknownDeltas).toBe(0);
    expect(m.toolInputErrors).toEqual([]);
    expect(isReplayable(m)).toBe(false);
    expect(() => assertExecRequestShape(roundTwo(m))).toThrow(/messages\[1\]\.content\[0\] is a thinking block without a signature/);
  });

  it("every reply isReplayable accepts goes into a request the guard accepts", async () => {
    const replies: ExecMessage[] = [
      await accumulateStream(from(textOnly())),
      await accumulateStream(from(thinkingToolLoop())),
      messageFromResponse({
        type: "message",
        stop_reason: "tool_use",
        content: [
          { type: "redacted_thinking", data: "EmwKAhgBEgy3va3pzix" },
          // Whitespace-only text is the API's own output here and goes back
          // verbatim; only empty text is refused in an assistant turn.
          { type: "text", text: "\n\n" },
          { type: "tool_use", id: "toolu_02", name: "get_local_time", input: { timezone: "UTC" } }
        ]
      }),
      // Cut off: replayable (then continued with a user turn), just not finished.
      messageFromResponse({ type: "message", stop_reason: "max_tokens", content: [{ type: "text", text: "The first thr" }] })
    ];
    for (const m of replies) {
      expect(isReplayable(m)).toBe(true);
      expect(() => assertExecRequestShape(roundTwo(m))).not.toThrow();
    }
  });

  it("toolUses skips malformed tool_use blocks", () => {
    const m = messageFromResponse({
      type: "message",
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "a", name: "t", input: {} },
        { type: "tool_use", id: 5, name: "t", input: {} },
        { type: "tool_use", id: "c", input: {} }
      ]
    });
    expect(toolUses(m).map((t) => t.id)).toEqual(["a"]);
  });
});
