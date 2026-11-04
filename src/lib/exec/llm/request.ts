import "server-only";

import type { Effort, ExecLlmFeature } from "@/lib/exec/types";
import { EXEC_MODELS, FEATURE_EFFORT, FEATURE_MAX_TOKENS, type ExecModelId } from "@/lib/exec/llm/models";

// The only builder of exec model requests, plus the guard every request passes
// before it is sent.
//
// The SDK is pinned at 0.32.1, whose types predate everything the 5.5 models
// need (output_config, adaptive thinking, strict tools), so the request and
// content types are local to exec code and cast once, in client.ts.
//
// The 5.5 models reject — with a 400 — several shapes older code used freely:
// temperature/top_p/top_k, thinking budgets or disabled thinking, a forced
// tool_choice, and an assistant prefill. assertExecRequestShape refuses them,
// along with the 400s exec could otherwise walk into (blank text, a replayed
// thinking block that lost its signature), before any tokens are spent, so a
// bad request fails in tests, not in prod.

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface ExecCacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

export interface ExecTextBlock {
  type: "text";
  text: string;
  /** Present when the request enabled citations on a document. Replayed as-is. */
  citations?: unknown[] | null;
}

/**
 * The signature is opaque and bound to this conversation's prefix. Inside one
 * tool loop the block must go back to the API byte-for-byte, so nothing in exec
 * ever edits one. With the default `display: "omitted"` the thinking text is
 * empty; the signature still isn't.
 */
export interface ExecThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface ExecRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export interface ExecToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * A block type this layer doesn't model (server tool use and results, future
 * types). Kept exactly as the API sent it and replayed verbatim.
 */
export interface ExecOtherBlock {
  type: string;
  [field: string]: unknown;
}

/** A content block as the API returns it. */
export type ExecContentBlock =
  | ExecTextBlock
  | ExecThinkingBlock
  | ExecRedactedThinkingBlock
  | ExecToolUseBlock
  | ExecOtherBlock;

export interface ExecTextBlockParam extends ExecTextBlock {
  cache_control?: ExecCacheControl;
}

export interface ExecImageBlockParam {
  type: "image";
  source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
  cache_control?: ExecCacheControl;
}

export interface ExecDocumentBlockParam {
  type: "document";
  source: Record<string, unknown>;
  title?: string;
  context?: string;
  citations?: { enabled: boolean };
  cache_control?: ExecCacheControl;
}

export interface ExecToolResultBlockParam {
  type: "tool_result";
  tool_use_id: string;
  content?: string | Array<ExecTextBlockParam | ExecImageBlockParam>;
  is_error?: boolean;
  cache_control?: ExecCacheControl;
}

/** Anything that may appear in a request message. Returned blocks are valid params as they are. */
export type ExecContentBlockParam =
  | ExecTextBlockParam
  | ExecImageBlockParam
  | ExecDocumentBlockParam
  | ExecToolResultBlockParam
  | ExecContentBlock;

export interface ExecMessageParam {
  role: "user" | "assistant";
  content: string | ExecContentBlockParam[];
}

export interface ExecSystemBlock {
  type: "text";
  text: string;
  cache_control?: ExecCacheControl;
}

// ---------------------------------------------------------------------------
// Tools, thinking, output
// ---------------------------------------------------------------------------

export interface ExecToolInputSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  /** Strict tools need this on EVERY object in the schema, not just the root. */
  additionalProperties: false;
  [keyword: string]: unknown;
}

/**
 * Exec tools are always strict, so `tool_use.input` is guaranteed to match the
 * schema — that guarantee is what replaces the forced tool_choice the 5.5
 * models reject.
 */
export interface ExecToolDef {
  name: string;
  description: string;
  input_schema: ExecToolInputSchema;
  strict: true;
  cache_control?: ExecCacheControl;
}

export type ThinkingBindingBehavior = "error" | "drop_block";

export interface ExecThinkingParam {
  type: "adaptive";
  display?: "summarized" | "omitted";
  /** Needs the THINKING_BINDING_BETA header; client.ts adds it automatically. */
  block_binding?: { prefix_mismatch_behavior: ThinkingBindingBehavior };
}

export interface ExecOutputConfig {
  effort: Effort;
  format?: { type: "json_schema"; schema: Record<string, unknown> };
}

/** A complete Messages API request body, minus `stream` (callModel sets it). */
export interface ExecRequestParams {
  model: ExecModelId;
  max_tokens: number;
  system?: ExecSystemBlock[];
  messages: ExecMessageParam[];
  tools?: ExecToolDef[];
  tool_choice?: { type: "auto"; disable_parallel_tool_use?: boolean };
  thinking?: ExecThinkingParam;
  output_config: ExecOutputConfig;
}

/** Beta that unlocks `thinking.block_binding` (the 400 without it: "Extra inputs are not permitted"). */
export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

/** Beta headers a request body can't be sent without. */
export function requiredBetas(params: Pick<ExecRequestParams, "thinking">): string[] {
  return params.thinking?.block_binding ? [THINKING_BINDING_BETA] : [];
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface BuildExecRequestInput {
  feature: ExecLlmFeature;
  /**
   * Keep it static for the whole session: per-turn context (time, date) goes in
   * the user message, or every turn rewrites the cache and invalidates replayed
   * thinking.
   */
  system: string | { type: "text"; text: string }[];
  messages: ExecMessageParam[];
  tools?: ExecToolDef[];
  /** JSON Schema for structured output (output_config.format). */
  outputSchema?: Record<string, unknown>;
  maxTokens?: number;
  effort?: Effort;
  /** Mark the last system block for prompt caching. Default: on for chat/draft/brief/voice. */
  cacheSystem?: boolean;
  /** Sets thinking.block_binding.prefix_mismatch_behavior (and so needs the binding beta). */
  thinkingBinding?: ThinkingBindingBehavior;
}

// Features whose system prompt is long-lived and re-sent within minutes (a chat
// session, a drafting loop). Triage and digests cache nothing by default: a
// write costs 1.25x and their prompts may be under the 512-token minimum.
const CACHE_SYSTEM_BY_DEFAULT: ReadonlySet<ExecLlmFeature> = new Set<ExecLlmFeature>(["chat", "draft", "brief", "voice"]);

/** A string with no non-whitespace character in it (so "" too). */
function isBlank(v: unknown): boolean {
  return typeof v === "string" && v.trim() === "";
}

function systemBlocks(system: BuildExecRequestInput["system"], cache: boolean): ExecSystemBlock[] {
  // Empty or whitespace-only text blocks are a 400 ("text content blocks must
  // be non-empty" / "must contain non-whitespace text"), so they're dropped
  // rather than sent, and the cache marker can't land on one. Real text is kept
  // byte-for-byte: it is the cached prefix.
  const blocks: ExecSystemBlock[] = (typeof system === "string" ? [{ type: "text", text: system }] : system)
    .filter((b) => !isBlank(b.text))
    .map((b) => ({ type: "text", text: b.text }));
  // Only the last block carries the breakpoint: tools render before system, so
  // that one marker caches tools + system together.
  if (cache && blocks.length > 0) {
    const last = blocks.length - 1;
    blocks[last] = { ...blocks[last], cache_control: { type: "ephemeral" } };
  }
  return blocks;
}

/**
 * Build an exec request. The result is guaranteed to pass
 * assertExecRequestShape (it is checked before returning), so a builder call
 * that would produce a request the API rejects throws ExecRequestShapeError.
 */
export function buildExecRequest(input: BuildExecRequestInput): ExecRequestParams {
  const { feature } = input;
  const system = systemBlocks(input.system, input.cacheSystem ?? CACHE_SYSTEM_BY_DEFAULT.has(feature));
  const tools = input.tools && input.tools.length > 0 ? [...input.tools] : undefined;

  const params: ExecRequestParams = {
    model: EXEC_MODELS[feature],
    max_tokens: input.maxTokens ?? FEATURE_MAX_TOKENS[feature],
    ...(system.length > 0 ? { system } : {}),
    // A copy, so a caller appending to its own history can't change a built request.
    messages: [...input.messages],
    ...(tools ? { tools, tool_choice: { type: "auto" as const } } : {}),
    thinking: {
      type: "adaptive",
      ...(input.thinkingBinding ? { block_binding: { prefix_mismatch_behavior: input.thinkingBinding } } : {})
    },
    output_config: {
      effort: input.effort ?? FEATURE_EFFORT[feature],
      ...(input.outputSchema ? { format: { type: "json_schema" as const, schema: input.outputSchema } } : {})
    }
  };
  assertExecRequestShape(params);
  return params;
}

// ---------------------------------------------------------------------------
// Shape guard
// ---------------------------------------------------------------------------

/** A request the 5.5 models would 400 on (or exec doesn't allow). Never retry it. */
export class ExecRequestShapeError extends Error {
  /** Read by the job runner's classifier: retrying an invalid request can't succeed. */
  readonly errorClass = "fatal" as const;
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`exec request rejected before sending: ${problems.join("; ")}`);
    this.name = "ExecRequestShapeError";
    this.problems = problems;
  }
}

const SAMPLING_KEYS = ["temperature", "top_p", "top_k", "budget_tokens"] as const;
const EFFORTS: ReadonlySet<string> = new Set<Effort>(["low", "medium", "high", "xhigh", "max"]);
const BINDING_BEHAVIORS: ReadonlySet<string> = new Set<ThinkingBindingBehavior>(["error", "drop_block"]);
const EXEC_MODEL_IDS: ReadonlySet<string> = new Set<string>(Object.values(EXEC_MODELS));
const MAX_OUTPUT_TOKENS = 128_000;
const MAX_SCHEMA_DEPTH = 32;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function samplingKeysIn(obj: Record<string, unknown>, where: string, problems: string[]): void {
  for (const key of SAMPLING_KEYS) {
    if (obj[key] !== undefined) problems.push(`${where}${key} is not allowed (400 on the 5.5 models)`);
  }
}

// Strict tools and json_schema output both require additionalProperties:false
// on every object node; a nested object without it is a 400 at request time.
function openObjectNodes(schema: unknown, path: string, out: string[], depth = 0): void {
  if (!isRecord(schema) || depth > MAX_SCHEMA_DEPTH) return;
  const type = schema.type;
  const isObject =
    type === "object" || (Array.isArray(type) && type.includes("object")) || isRecord(schema.properties);
  if (isObject && schema.additionalProperties !== false) out.push(path);

  for (const key of ["properties", "$defs", "definitions"]) {
    const map = schema[key];
    if (isRecord(map)) {
      for (const [name, sub] of Object.entries(map)) openObjectNodes(sub, `${path}.${key}.${name}`, out, depth + 1);
    }
  }
  for (const key of ["items", "anyOf", "allOf", "oneOf", "prefixItems"]) {
    const sub = schema[key];
    if (Array.isArray(sub)) sub.forEach((s, i) => openObjectNodes(s, `${path}.${key}[${i}]`, out, depth + 1));
    else openObjectNodes(sub, `${path}.${key}`, out, depth + 1);
  }
}

function checkThinking(thinking: unknown, problems: string[]): void {
  if (thinking === undefined) return;
  if (!isRecord(thinking)) {
    problems.push("thinking must be an object");
    return;
  }
  if (thinking.type !== "adaptive") {
    problems.push(`thinking.type must be "adaptive" (got ${JSON.stringify(thinking.type)}; disabled/enabled 400 on the 5.5 models)`);
  }
  samplingKeysIn(thinking, "thinking.", problems);
  if (thinking.block_binding !== undefined) {
    const b = thinking.block_binding;
    if (!isRecord(b) || typeof b.prefix_mismatch_behavior !== "string" || !BINDING_BEHAVIORS.has(b.prefix_mismatch_behavior)) {
      problems.push('thinking.block_binding.prefix_mismatch_behavior must be "error" or "drop_block"');
    }
  }
}

function checkSystem(system: unknown, problems: string[]): void {
  if (system === undefined) return;
  if (typeof system === "string") {
    if (isBlank(system)) problems.push("system has no non-whitespace text");
    return;
  }
  if (!Array.isArray(system)) {
    problems.push("system must be a string or an array of text blocks");
    return;
  }
  system.forEach((b, i) => {
    if (!isRecord(b) || b.type !== "text" || typeof b.text !== "string" || isBlank(b.text)) {
      problems.push(`system[${i}] must be a text block with non-whitespace text`);
    }
  });
}

/**
 * Why the API would refuse `content` as one turn's content, as paths relative
 * to the turn ("content[2] is …"); [] when nothing is wrong. The guard runs it
 * on every turn and stream.ts's isReplayable on every model reply, so a reply
 * judged replayable can't then be refused on the next round of a tool loop.
 *
 * Text must be non-empty everywhere. Whitespace-only text is refused in string
 * content and in user turns (exec writes those, so a blank one is our bug: an
 * email with an empty body, say), but let through in an assistant turn's
 * blocks: those are the API's own output and go back verbatim.
 */
export function contentProblems(content: unknown, role: "user" | "assistant"): string[] {
  if (typeof content === "string") {
    if (content === "") return ["content is empty"];
    return isBlank(content) ? ["content is only whitespace"] : [];
  }
  if (!Array.isArray(content)) return ["content must be a string or an array of blocks"];
  if (content.length === 0) return ["content is empty"];
  const problems: string[] = [];
  content.forEach((b, j) => {
    const at = `content[${j}]`;
    if (!isRecord(b) || typeof b.type !== "string") {
      problems.push(`${at} is not a content block`);
      return;
    }
    switch (b.type) {
      case "text":
        if (typeof b.text !== "string" || b.text === "") problems.push(`${at} is a text block without text`);
        else if (role === "user" && isBlank(b.text)) problems.push(`${at} is a text block with only whitespace`);
        return;
      case "thinking":
        // A thinking block with no signature is exactly what a lossy stream
        // reader produces (SDK 0.32.1's MessageStream drops signatures); the
        // API rejects it.
        if (typeof b.signature !== "string" || b.signature === "") problems.push(`${at} is a thinking block without a signature`);
        return;
      case "redacted_thinking":
        if (typeof b.data !== "string" || b.data === "") problems.push(`${at} is a redacted_thinking block without its data`);
        return;
    }
  });
  return problems;
}

function checkMessages(messages: unknown, problems: string[]): void {
  if (!Array.isArray(messages) || messages.length === 0) {
    problems.push("messages must be a non-empty array");
    return;
  }
  messages.forEach((m, i) => {
    if (!isRecord(m) || (m.role !== "user" && m.role !== "assistant")) {
      problems.push(`messages[${i}].role must be "user" or "assistant"`);
      return;
    }
    for (const problem of contentProblems(m.content, m.role)) problems.push(`messages[${i}].${problem}`);
  });
  const first = messages[0];
  if (isRecord(first) && first.role !== "user") problems.push("the first message must be from the user");
  const last = messages[messages.length - 1];
  if (isRecord(last) && last.role !== "user") {
    problems.push("the last message must be from the user (assistant prefill 400s on the 5.5 models)");
  }
}

function checkTools(tools: unknown, problems: string[]): void {
  if (tools === undefined) return;
  if (!Array.isArray(tools)) {
    problems.push("tools must be an array");
    return;
  }
  tools.forEach((t, i) => {
    const name = isRecord(t) && typeof t.name === "string" ? t.name : `#${i}`;
    if (!isRecord(t)) {
      problems.push(`tools[${i}] must be an object`);
      return;
    }
    if (t.strict !== true) problems.push(`tool ${name} must set strict: true`);
    const schema = t.input_schema;
    if (!isRecord(schema) || schema.type !== "object") {
      problems.push(`tool ${name} input_schema must be an object schema`);
      return;
    }
    const open: string[] = [];
    openObjectNodes(schema, "input_schema", open);
    for (const path of open) problems.push(`tool ${name} ${path} must set additionalProperties: false`);
  });
}

function checkOutputConfig(outputConfig: unknown, problems: string[]): void {
  if (outputConfig === undefined) return;
  if (!isRecord(outputConfig)) {
    problems.push("output_config must be an object");
    return;
  }
  if (outputConfig.effort !== undefined && (typeof outputConfig.effort !== "string" || !EFFORTS.has(outputConfig.effort))) {
    problems.push(`output_config.effort ${JSON.stringify(outputConfig.effort)} is not an effort level`);
  }
  const format = outputConfig.format;
  if (format === undefined) return;
  if (!isRecord(format) || format.type !== "json_schema" || !isRecord(format.schema)) {
    problems.push('output_config.format must be { type: "json_schema", schema: {...} }');
    return;
  }
  const open: string[] = [];
  openObjectNodes(format.schema, "output_config.format.schema", open);
  for (const path of open) problems.push(`${path} must set additionalProperties: false`);
}

/**
 * Throws ExecRequestShapeError (listing every problem found) when `params`
 * would be rejected by the 5.5 models or breaks exec's own rules. Runs on every
 * request in callModel, whoever built it.
 */
export function assertExecRequestShape(params: unknown): void {
  if (!isRecord(params)) throw new ExecRequestShapeError(["request must be an object"]);
  const problems: string[] = [];

  if (typeof params.model !== "string" || !EXEC_MODEL_IDS.has(params.model)) {
    problems.push(`model ${JSON.stringify(params.model)} is not an exec model`);
  }
  const maxTokens = params.max_tokens;
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_OUTPUT_TOKENS) {
    problems.push(`max_tokens must be an integer from 1 to ${MAX_OUTPUT_TOKENS}`);
  }
  samplingKeysIn(params, "", problems);
  checkThinking(params.thinking, problems);
  if (params.tool_choice !== undefined && (!isRecord(params.tool_choice) || params.tool_choice.type !== "auto")) {
    problems.push('tool_choice must be { type: "auto" } (forced tool use 400s on the 5.5 models)');
  }
  checkSystem(params.system, problems);
  checkMessages(params.messages, problems);
  checkTools(params.tools, problems);
  checkOutputConfig(params.output_config, problems);

  if (problems.length > 0) throw new ExecRequestShapeError(problems);
}
