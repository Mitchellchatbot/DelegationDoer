import "server-only";

import type { ExecUsage } from "@/lib/exec/llm/models";
import { contentProblems, type ExecContentBlock, type ExecToolUseBlock } from "@/lib/exec/llm/request";

// Our own accumulator for raw Messages API stream events.
//
// SDK 0.32.1's MessageStream (`client.messages.stream()`) silently drops
// thinking_delta and signature_delta, and a thinking block without its
// signature can't be sent back inside a tool loop. So exec never uses
// MessageStream: client.ts iterates the raw events of
// `messages.create({ stream: true })` (0.32.1's Stream yields each event's JSON
// untouched) and this module assembles them.
//
// What it guarantees:
// - thinking text and signatures, and redacted_thinking data, are kept exactly
//   as sent, so the content can be replayed verbatim within a tool loop;
// - blocks of a type we don't model are kept raw (and replayed raw);
// - nothing it can't apply is dropped quietly: unknown deltas and events are
//   counted in `unknownDeltas`, unparseable tool input is listed in
//   `toolInputErrors`, and isReplayable() is false for such a message;
// - a stream that ends without message_stop is an error, never a short answer.

export type ExecStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal"
  | "model_context_window_exceeded"
  | (string & {});

/** Set on refusals: `category` (cyber, bio, …) is informational and may be null. */
export interface ExecStopDetails {
  type?: string;
  category?: string | null;
  explanation?: string | null;
  [field: string]: unknown;
}

export interface ExecMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ExecContentBlock[];
  stop_reason: ExecStopReason | null;
  stop_sequence: string | null;
  stop_details: ExecStopDetails | null;
  usage: ExecUsage;
  /** With the thinking-binding beta: thinking blocks the API dropped or let through. */
  input_transformations?: unknown[];
  /**
   * Stream indices of tool-use blocks whose input JSON didn't parse to an
   * object; their `input` is `{}`. Never sent to the API.
   */
  toolInputErrors: number[];
  /**
   * Events and deltas this accumulator couldn't apply (unknown type, or a delta
   * that doesn't fit its block). Non-zero means the content may not be what the
   * model sent: don't replay it. Never sent to the API.
   */
  unknownDeltas: number;
}

/** The response broke the Messages API protocol (malformed event or body, or the stream ended early). */
export class LlmProtocolError extends Error {
  /** Whatever had arrived, for usage accounting. */
  readonly partial: ExecMessage | null;
  constructor(message: string, partial: ExecMessage | null) {
    super(message);
    this.name = "LlmProtocolError";
    this.partial = partial;
  }
}

/** An `error` event mid-stream (overloaded_error, api_error, …). */
export class StreamEventError extends Error {
  /** The API error type, e.g. "overloaded_error". */
  readonly errorType: string;
  readonly partial: ExecMessage | null;
  constructor(errorType: string, message: string, partial: ExecMessage | null) {
    super(`stream error event (${errorType}): ${message}`);
    this.name = "StreamEventError";
    this.errorType = errorType;
    this.partial = partial;
  }
}

export interface StreamAccumulatorOptions {
  /**
   * Each text_delta, after it has been applied. Thrown errors propagate to
   * push(). A returned promise is ignored, so an async sink must handle its own
   * rejections (callModel's onTextDelta does that for you).
   */
  onTextDelta?: (text: string, blockIndex: number) => void;
  onBlockStart?: (block: ExecContentBlock, index: number) => void;
}

type RawBlock = { type: string; [field: string]: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isIndex(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

// Blocks whose input arrives as input_json_delta: tool_use, server_tool_use,
// mcp_tool_use.
function takesInputJson(block: RawBlock): boolean {
  return block.type.endsWith("tool_use") && isRecord(block.input);
}

// A shallow copy (the event object is never aliased) with the fields our known
// types promise filled in. Present values are kept exactly.
function normalizeBlock(raw: Record<string, unknown> & { type: string }): RawBlock {
  const b: RawBlock = { ...raw };
  if (b.type === "text" && typeof b.text !== "string") b.text = "";
  if (b.type === "thinking") {
    if (typeof b.thinking !== "string") b.thinking = "";
    if (typeof b.signature !== "string") b.signature = "";
  }
  if (b.type === "tool_use" && !isRecord(b.input)) b.input = {};
  return b;
}

function hasType(v: unknown): v is Record<string, unknown> & { type: string } {
  return isRecord(v) && typeof v.type === "string";
}

interface MessageMeta {
  id: string;
  model: string;
  stop_reason: ExecStopReason | null;
  stop_sequence: string | null;
  stop_details: ExecStopDetails | null;
  input_transformations?: unknown[];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export class StreamAccumulator {
  private readonly opts: StreamAccumulatorOptions;
  private meta: MessageMeta = { id: "", model: "", stop_reason: null, stop_sequence: null, stop_details: null };
  private usage: ExecUsage = {};
  private readonly blocks: (RawBlock | undefined)[] = [];
  /** partial_json collected per block index, parsed at content_block_stop. */
  private readonly inputJson = new Map<number, string>();
  private readonly inputErrors: number[] = [];
  private unknown = 0;
  private sawStart = false;
  private sawStop = false;

  constructor(opts: StreamAccumulatorOptions = {}) {
    this.opts = opts;
  }

  /** message_start arrived (so input usage is known). */
  get started(): boolean {
    return this.sawStart;
  }

  /** message_stop arrived. */
  get complete(): boolean {
    return this.sawStop;
  }

  /** A snapshot of the message so far. Blocks still streaming are shown as they stand. */
  get message(): ExecMessage {
    return {
      id: this.meta.id,
      type: "message",
      role: "assistant",
      model: this.meta.model,
      // normalizeBlock gave every known type its fields; unknown types are
      // ExecOtherBlock by definition.
      content: this.blocks.filter((b): b is RawBlock => b !== undefined) as ExecContentBlock[],
      stop_reason: this.meta.stop_reason,
      stop_sequence: this.meta.stop_sequence,
      stop_details: this.meta.stop_details,
      usage: { ...this.usage },
      ...(this.meta.input_transformations ? { input_transformations: [...this.meta.input_transformations] } : {}),
      toolInputErrors: [...this.inputErrors],
      unknownDeltas: this.unknown
    };
  }

  push(event: unknown): void {
    if (!hasType(event)) throw new LlmProtocolError("stream event is not an object with a type", this.snapshot());
    if (this.sawStop && event.type !== "ping") {
      // Nothing may follow message_stop; if something does, don't trust the message.
      this.unknown++;
      return;
    }
    switch (event.type) {
      case "message_start":
        return this.onMessageStart(event);
      case "content_block_start":
        return this.onBlockStart(event);
      case "content_block_delta":
        return this.onDelta(event);
      case "content_block_stop":
        return this.onBlockStop(event);
      case "message_delta":
        return this.onMessageDelta(event);
      case "message_stop":
        this.sawStop = true;
        return;
      case "ping":
        return;
      case "error": {
        const e = isRecord(event.error) ? event.error : {};
        throw new StreamEventError(
          typeof e.type === "string" ? e.type : "unknown_error",
          typeof e.message === "string" ? e.message : "no message",
          this.snapshot()
        );
      }
      default:
        this.unknown++;
    }
  }

  /** The finished message. Throws LlmProtocolError if message_start or message_stop never came. */
  finish(): ExecMessage {
    if (!this.sawStart) throw new LlmProtocolError("stream ended before message_start", null);
    if (!this.sawStop) throw new LlmProtocolError("stream ended before message_stop", this.message);
    // A tool block that never got its content_block_stop still gets its input parsed.
    for (const index of [...this.inputJson.keys()]) this.finalizeInput(index);
    return this.message;
  }

  private snapshot(): ExecMessage | null {
    return this.sawStart ? this.message : null;
  }

  private onMessageStart(event: Record<string, unknown>): void {
    if (this.sawStart) {
      this.unknown++;
      return;
    }
    const m = isRecord(event.message) ? event.message : {};
    this.meta = {
      id: str(m.id),
      model: str(m.model),
      stop_reason: strOrNull(m.stop_reason),
      stop_sequence: strOrNull(m.stop_sequence),
      stop_details: isRecord(m.stop_details) ? { ...m.stop_details } : null,
      ...(Array.isArray(m.input_transformations) ? { input_transformations: [...m.input_transformations] } : {})
    };
    this.usage = isRecord(m.usage) ? { ...m.usage } : {};
    // Always [] today; kept rather than ignored in case the API ever seeds it.
    if (Array.isArray(m.content)) {
      m.content.forEach((b, i) => {
        if (hasType(b)) this.blocks[i] = normalizeBlock(b);
        else this.unknown++;
      });
    }
    this.sawStart = true;
  }

  private onBlockStart(event: Record<string, unknown>): void {
    const index = event.index;
    if (!isIndex(index) || !hasType(event.content_block)) {
      this.unknown++;
      return;
    }
    const block = normalizeBlock(event.content_block);
    this.blocks[index] = block;
    this.opts.onBlockStart?.(block as ExecContentBlock, index);
  }

  private onDelta(event: Record<string, unknown>): void {
    const index = event.index;
    const block = isIndex(index) ? this.blocks[index] : undefined;
    const delta = event.delta;
    if (!block || !isIndex(index) || !hasType(delta)) {
      this.unknown++;
      return;
    }
    switch (delta.type) {
      case "text_delta":
        if (block.type === "text" && typeof block.text === "string" && typeof delta.text === "string") {
          block.text = block.text + delta.text;
          this.opts.onTextDelta?.(delta.text, index);
          return;
        }
        break;
      case "thinking_delta":
        if (block.type === "thinking" && typeof block.thinking === "string" && typeof delta.thinking === "string") {
          block.thinking = block.thinking + delta.thinking;
          return;
        }
        break;
      case "signature_delta":
        // The signature arrives whole in one delta just before the block
        // stops; both official SDKs assign it, and so do we.
        if (block.type === "thinking" && typeof delta.signature === "string") {
          block.signature = delta.signature;
          return;
        }
        break;
      case "input_json_delta":
        if (takesInputJson(block) && typeof delta.partial_json === "string") {
          this.inputJson.set(index, (this.inputJson.get(index) ?? "") + delta.partial_json);
          return;
        }
        break;
      case "citations_delta":
        if (block.type === "text" && delta.citation !== undefined) {
          const list = Array.isArray(block.citations) ? block.citations : [];
          block.citations = [...list, delta.citation];
          return;
        }
        break;
    }
    this.unknown++;
  }

  private onBlockStop(event: Record<string, unknown>): void {
    const index = event.index;
    if (!isIndex(index) || !this.blocks[index]) {
      this.unknown++;
      return;
    }
    this.finalizeInput(index);
  }

  private finalizeInput(index: number): void {
    const json = this.inputJson.get(index);
    const block = this.blocks[index];
    if (json === undefined || !block) return;
    this.inputJson.delete(index);
    if (json.trim() === "") {
      block.input = {};
      return;
    }
    try {
      const parsed: unknown = JSON.parse(json);
      if (isRecord(parsed)) {
        block.input = parsed;
        return;
      }
    } catch {
      // Recorded below; the caller decides (a strict tool should never get here).
    }
    block.input = {};
    this.inputErrors.push(index);
  }

  private onMessageDelta(event: Record<string, unknown>): void {
    const d = isRecord(event.delta) ? event.delta : {};
    if ("stop_reason" in d) this.meta.stop_reason = strOrNull(d.stop_reason);
    if ("stop_sequence" in d) this.meta.stop_sequence = strOrNull(d.stop_sequence);
    if ("stop_details" in d) this.meta.stop_details = isRecord(d.stop_details) ? { ...d.stop_details } : null;
    // After a mid-stream server-side fallback the final message_delta repeats it.
    const transformations = d.input_transformations ?? event.input_transformations;
    if (Array.isArray(transformations)) this.meta.input_transformations = [...transformations];
    // message_delta usage is cumulative: a present value replaces the one from
    // message_start; an absent or null one leaves it alone.
    if (isRecord(event.usage)) {
      for (const [key, value] of Object.entries(event.usage)) {
        if (value !== null && value !== undefined) this.usage[key] = value;
      }
    }
  }
}

/** Assemble a whole stream. Throws StreamEventError on an `error` event, LlmProtocolError if it ends early. */
export async function accumulateStream(
  events: AsyncIterable<unknown>,
  opts?: StreamAccumulatorOptions
): Promise<ExecMessage> {
  const acc = new StreamAccumulator(opts);
  for await (const event of events) acc.push(event);
  return acc.finish();
}

/** A non-streamed response body (`stream: false`) in the same shape the accumulator produces. */
export function messageFromResponse(body: unknown): ExecMessage {
  if (!isRecord(body) || body.type !== "message" || !Array.isArray(body.content)) {
    throw new LlmProtocolError("response body is not a Messages API message", null);
  }
  let unknown = 0;
  const content: RawBlock[] = [];
  for (const b of body.content) {
    if (hasType(b)) content.push(normalizeBlock(b));
    else unknown++;
  }
  return {
    id: str(body.id),
    type: "message",
    role: "assistant",
    model: str(body.model),
    content: content as ExecContentBlock[],
    stop_reason: strOrNull(body.stop_reason),
    stop_sequence: strOrNull(body.stop_sequence),
    stop_details: isRecord(body.stop_details) ? { ...body.stop_details } : null,
    usage: isRecord(body.usage) ? { ...body.usage } : {},
    ...(Array.isArray(body.input_transformations) ? { input_transformations: [...body.input_transformations] } : {}),
    toolInputErrors: [],
    unknownDeltas: unknown
  };
}

/**
 * Safe to send back verbatim as an assistant turn: it finished, nothing in it
 * went unapplied, every tool input parsed, it isn't a refusal (whose partial
 * output must be discarded, not continued), and its content passes the very
 * check the request guard runs on an assistant turn (not empty, every thinking
 * block signed, no empty text). So a reply this accepts can't make the next
 * round fail on ExecRequestShapeError; false means fall back to a text-only
 * replay.
 */
export function isReplayable(message: ExecMessage): boolean {
  return (
    message.stop_reason !== null &&
    message.stop_reason !== "refusal" &&
    message.unknownDeltas === 0 &&
    message.toolInputErrors.length === 0 &&
    contentProblems(message.content, "assistant").length === 0
  );
}

/** The visible answer: every text block, in order. */
export function messageText(message: ExecMessage): string {
  let out = "";
  for (const block of message.content) {
    if (block.type === "text" && typeof block.text === "string") out += block.text;
  }
  return out;
}

/** The client tool calls the model asked for, in order. */
export function toolUses(message: ExecMessage): ExecToolUseBlock[] {
  const out: ExecToolUseBlock[] = [];
  for (const block of message.content) {
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string" && isRecord(block.input)) {
      out.push(block as ExecToolUseBlock);
    }
  }
  return out;
}
