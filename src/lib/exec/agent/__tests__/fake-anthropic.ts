// Test support for Area C's loop tests (P5b contract §5 tests 40-59): fake model
// output two ways, and nothing else (no network, no key, no real data).
//
//   1. Raw Messages API stream events, as the API sends them, for the REAL
//      callModel (tests 40-41, 55-56): the builders are copied from P2a's
//      llm/stream.test.ts (messageStart, blockStart, delta, blockStop,
//      messageDelta, MESSAGE_STOP) and llm/client.test.ts (withResponse,
//      fakeClient), and turnEvents() assembles one assistant message.
//   2. A scripted callModel (every other loop test): each call takes the next
//      step, streams its text through onTextDelta, and returns a
//      CallModelResult. Requests are captured as deep copies, so later rounds
//      can't change what an earlier call was sent.
//
// This file imports types only (and vitest), so a vi.mock factory may load it.

import { vi, type Mock } from "vitest";

import type { CallModelInput, CallModelResult } from "@/lib/exec/llm/client";
import type { ExecContentBlock, ExecRequestParams } from "@/lib/exec/llm/request";
import type { ExecMessage } from "@/lib/exec/llm/stream";

// ---------------------------------------------------------------------------
// 1. Stream events (copied from P2a's stream.test.ts / client.test.ts)
// ---------------------------------------------------------------------------

// A realistic signature: long, base64 with +, / and = that must survive byte-for-byte.
export const SIGNATURE =
  "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds+/w==ErUBCkYIBRgCIkBX7xZPjmOnQRZp1yi4i2vZ8bD/9cAL" +
  "m4q0Xp8hYwRk1KqZ9zrkzK5ynjPc+MKLlCwWZ4Jx==";

export const START_USAGE = {
  input_tokens: 25,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  service_tier: "standard"
};

export function messageStart(usage: Record<string, unknown> = START_USAGE, extra: Record<string, unknown> = {}) {
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
export const blockStart = (index: number, content_block: Record<string, unknown>) => ({ type: "content_block_start", index, content_block });
export const delta = (index: number, d: Record<string, unknown>) => ({ type: "content_block_delta", index, delta: d });
export const blockStop = (index: number) => ({ type: "content_block_stop", index });
export const messageDelta = (
  stop_reason: string,
  usage: Record<string, unknown> = { output_tokens: 42 },
  extra: Record<string, unknown> = {}
) => ({ type: "message_delta", delta: { stop_reason, stop_sequence: null, ...extra }, usage });
export const MESSAGE_STOP = { type: "message_stop" };

export async function* iterate(list: unknown[]): AsyncGenerator<unknown> {
  for (const e of list) yield e;
}

/** What 0.32.1's APIPromise offers: withResponse() → { data, response }. */
export function withResponse(data: unknown, requestId: string | null = "req_fake") {
  return {
    withResponse: async () => ({ data, response: { headers: new Headers(requestId ? { "request-id": requestId } : {}) } })
  };
}

export interface FakeToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TurnSpec {
  /** Text deltas of one text block (omitted when empty). */
  text?: string[];
  tools?: FakeToolUse[];
  /** Default: tool_use when tools are present, else end_turn. */
  stopReason?: string;
  /** A thinking block (empty text, as display "omitted" streams it) with SIGNATURE. Default true. */
  thinking?: boolean;
  outputTokens?: number;
  stopDetails?: Record<string, unknown>;
}

/** The raw events of one assistant message: [thinking], [text], [tool_use…], message_delta, message_stop. */
export function turnEvents(spec: TurnSpec): unknown[] {
  const events: unknown[] = [messageStart()];
  let index = 0;
  if (spec.thinking !== false) {
    events.push(blockStart(index, { type: "thinking", thinking: "", signature: "" }));
    events.push(delta(index, { type: "signature_delta", signature: SIGNATURE }));
    events.push(blockStop(index));
    index++;
  }
  if (spec.text && spec.text.length > 0) {
    events.push(blockStart(index, { type: "text", text: "" }));
    for (const t of spec.text) events.push(delta(index, { type: "text_delta", text: t }));
    events.push(blockStop(index));
    index++;
  }
  for (const tool of spec.tools ?? []) {
    events.push(blockStart(index, { type: "tool_use", id: tool.id, name: tool.name, input: {} }));
    const json = JSON.stringify(tool.input);
    const mid = Math.floor(json.length / 2);
    events.push(delta(index, { type: "input_json_delta", partial_json: json.slice(0, mid) }));
    events.push(delta(index, { type: "input_json_delta", partial_json: json.slice(mid) }));
    events.push(blockStop(index));
    index++;
  }
  const stop = spec.stopReason ?? ((spec.tools?.length ?? 0) > 0 ? "tool_use" : "end_turn");
  events.push(messageDelta(stop, { output_tokens: spec.outputTokens ?? 42 }, spec.stopDetails ? { stop_details: spec.stopDetails } : {}));
  events.push(MESSAGE_STOP);
  return events;
}

/** A fake SDK client whose messages.create streams the next script entry (and records every body it was sent). */
export function fakeAnthropicClient(scripts: unknown[][]) {
  let i = 0;
  const bodies: Record<string, unknown>[] = [];
  const options: Record<string, unknown>[] = [];
  const create = vi.fn((body: Record<string, unknown>, opts: Record<string, unknown>) => {
    bodies.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
    options.push(opts);
    const events = scripts[Math.min(i, scripts.length - 1)];
    i++;
    return withResponse(iterate(events));
  });
  return { client: { messages: { create } }, create, bodies, options };
}

// ---------------------------------------------------------------------------
// 2. A scripted callModel
// ---------------------------------------------------------------------------

export interface MessageSpec {
  text?: string[];
  tools?: FakeToolUse[];
  stopReason?: string;
  /** Extra content blocks appended after the text (e.g. an empty text block). */
  extraBlocks?: ExecContentBlock[];
  thinking?: boolean;
  costUsd?: number;
  usage?: Record<string, unknown>;
  refused?: boolean;
  truncated?: boolean;
  stopDetails?: Record<string, unknown> | null;
  unknownDeltas?: number;
  toolInputErrors?: number[];
  inputTransformations?: unknown[];
  model?: string;
}

export type Step =
  | ({ kind?: "message" } & MessageSpec)
  /** Throws this error (after streaming `text`, if any). */
  | { kind: "throw"; error: unknown; text?: string[] }
  /** Streams `text`, then waits until the call's signal aborts and rejects with its reason (as callModel does). */
  | { kind: "hang"; text?: string[] }
  /** Full control. */
  | { kind: "fn"; run: (input: CallModelInput) => Promise<CallModelResult> };

/** An ExecMessage as the accumulator assembles it. */
export function fakeMessage(spec: MessageSpec): ExecMessage {
  const content: ExecContentBlock[] = [];
  if (spec.thinking !== false) content.push({ type: "thinking", thinking: "", signature: SIGNATURE });
  const text = (spec.text ?? []).join("");
  if (spec.text && spec.text.length > 0) content.push({ type: "text", text });
  for (const b of spec.extraBlocks ?? []) content.push(b);
  for (const t of spec.tools ?? []) content.push({ type: "tool_use", id: t.id, name: t.name, input: t.input });
  const stop = spec.stopReason ?? (spec.refused ? "refusal" : (spec.tools?.length ?? 0) > 0 ? "tool_use" : "end_turn");
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: spec.model ?? "claude-opus-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: spec.stopDetails ?? null,
    usage: spec.usage ?? { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 20 },
    ...(spec.inputTransformations ? { input_transformations: spec.inputTransformations } : {}),
    toolInputErrors: spec.toolInputErrors ?? [],
    unknownDeltas: spec.unknownDeltas ?? 0
  };
}

function abortReason(signal: AbortSignal): unknown {
  const r: unknown = signal.reason;
  return r instanceof Error ? r : new DOMException("This operation was aborted", "AbortError");
}

export interface ScriptedModel {
  callModel: Mock<(input: CallModelInput) => Promise<CallModelResult>>;
  /** Deep copies of every request, in call order. */
  requests: ExecRequestParams[];
  /** The signal each call was given. */
  signals: AbortSignal[];
}

/** callModel that plays `steps` in order (the last one repeats). */
export function scriptedModel(steps: readonly Step[] | ((call: number) => Step)): ScriptedModel {
  const requests: ExecRequestParams[] = [];
  const signals: AbortSignal[] = [];
  const stepAt = (n: number): Step => (typeof steps === "function" ? steps(n) : steps[Math.min(n - 1, steps.length - 1)]);
  const callModel = vi.fn(async (input: CallModelInput): Promise<CallModelResult> => {
    requests.push(JSON.parse(JSON.stringify(input.request)) as ExecRequestParams);
    const signal = input.signal as AbortSignal;
    signals.push(signal);
    const step = stepAt(requests.length);
    const stream = (parts: string[] | undefined) => {
      for (const t of parts ?? []) input.onTextDelta?.(t, 1);
    };
    if (signal?.aborted) throw abortReason(signal);
    if (step.kind === "fn") return step.run(input);
    if (step.kind === "throw") {
      stream(step.text);
      throw step.error;
    }
    if (step.kind === "hang") {
      stream(step.text);
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw abortReason(signal);
    }
    stream(step.text);
    const message = fakeMessage(step);
    return {
      message,
      refused: step.refused === true || message.stop_reason === "refusal",
      truncated: step.truncated === true || message.stop_reason === "max_tokens",
      costUsd: step.costUsd ?? 0.01,
      latencyMs: 1,
      requestId: "req_fake"
    };
  });
  return { callModel, requests, signals };
}

/** A tool_use spec. */
export const use = (id: string, name: string, input: Record<string, unknown> = {}): FakeToolUse => ({ id, name, input });
