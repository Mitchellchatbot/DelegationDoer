import "server-only";

import type { Effort, ExecLlmFeature } from "@/lib/exec/types";

// Models, effort, output caps and prices for the assistant's model calls.
//
// Exec keeps its own model map so the shared MODELS constant in
// anthropic-client.ts (used by the other AI call sites) stays untouched. Opus
// 5.5 does the work a person reads (chat, drafts, the brief); Haiku 5.5 does
// the high-volume sorting (triage, digests) and the voice profile, whose
// answer is six style enums and one short phrase (P4 C35: Haiku, effort low,
// 4 000 tokens).
//
// Prices are list prices per million tokens from the Claude API reference. They
// feed exec_ai_usage.cost_usd and so the daily cost cap, which is why an
// unknown model is priced as Opus: over-counting trips the cap early,
// under-counting would let spend run past it.

export const OPUS_MODEL = "claude-opus-5-5";
export const HAIKU_MODEL = "claude-haiku-5-5";
export type ExecModelId = typeof OPUS_MODEL | typeof HAIKU_MODEL;

export const EXEC_MODELS: Readonly<Record<ExecLlmFeature, ExecModelId>> = Object.freeze({
  chat: OPUS_MODEL,
  draft: OPUS_MODEL,
  brief: OPUS_MODEL,
  voice: HAIKU_MODEL,
  spike: OPUS_MODEL,
  triage: HAIKU_MODEL,
  digest: HAIKU_MODEL,
  // P5a (contract §3.12.1): DD text triage.
  ddtext: HAIKU_MODEL
});

// Set explicitly on every request: both 5.5 models default to "medium", and a
// default that moves under us would silently change cost and quality.
export const FEATURE_EFFORT: Readonly<Record<ExecLlmFeature, Effort>> = Object.freeze({
  triage: "low",
  digest: "low",
  spike: "low",
  chat: "medium",
  draft: "medium",
  voice: "low",
  ddtext: "low",
  brief: "high"
});

// Output ceilings, not spend: a call bills only what it generates. Thinking is
// always on for the 5.5 models and counts toward max_tokens, so a tight cap
// cuts an answer off mid-sentence (stop_reason "max_tokens") on a heavy day.
// That matters most for the brief, at effort "high" over a whole day of work.
// The streamed features (chat, draft, brief) get room; the daily cost cap is
// what bounds money. The voice profile is a handful of enums, so it gets the
// sorting features' cap (C35).
export const FEATURE_MAX_TOKENS: Readonly<Record<ExecLlmFeature, number>> = Object.freeze({
  chat: 16000,
  draft: 16000,
  brief: 32000,
  voice: 4000,
  triage: 4000,
  digest: 4000,
  spike: 4000,
  ddtext: 4000
});

/** USD per million tokens. */
export interface TokenRates {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute TTL write — the TTL `{ type: "ephemeral" }` gets. */
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface PriceCard {
  base: TokenRates;
  /**
   * Haiku 5.5 has a second rate card: once the prompt is longer than
   * `aboveTokens`, the WHOLE request (output and cache included) bills at
   * `rates`. Opus 5.5 has one card at every length.
   */
  longPrompt?: { aboveTokens: number; rates: TokenRates };
}

export const PRICING: Readonly<Record<ExecModelId, PriceCard>> = Object.freeze({
  [OPUS_MODEL]: {
    base: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 }
  },
  // Cache reads are 0.1x input, 5-minute writes 1.25x, 1-hour writes 2x.
  [HAIKU_MODEL]: {
    base: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
    longPrompt: {
      aboveTokens: 100_000,
      rates: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 }
    }
  }
});

/**
 * Haiku inputs are chunked to stay at or under this many (estimated) tokens,
 * leaving headroom under the 100K line where the 5x rate card starts.
 */
export const HAIKU_MAX_PROMPT_TOKENS = 90_000;

/**
 * Token usage as the API reports it (message_start + message_delta merged, or
 * a non-streamed message's `usage`). Every field is optional because the shape
 * has grown over time; unknown fields (service_tier, server_tool_use, …) ride
 * along untouched.
 */
export interface ExecUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
  [field: string]: unknown;
}

function tokens(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

export function isPricedModel(model: string): model is ExecModelId {
  return Object.prototype.hasOwnProperty.call(PRICING, model);
}

/**
 * Cache-write tokens split by TTL. `cache_creation_input_tokens` is the total;
 * `cache_creation` (when present) splits it. Anything the split doesn't account
 * for is priced at the 5-minute rate — the only TTL exec requests use.
 */
export function cacheWriteSplit(usage: ExecUsage | null | undefined): { total: number; fiveMinute: number; oneHour: number } {
  const u = usage ?? {};
  const split = u.cache_creation ?? null;
  const oneHour = tokens(split?.ephemeral_1h_input_tokens);
  const fiveMinuteReported = tokens(split?.ephemeral_5m_input_tokens);
  // Trust the larger of the two views so a missing total can't hide a split write.
  const total = Math.max(tokens(u.cache_creation_input_tokens), oneHour + fiveMinuteReported);
  return { total, fiveMinute: total - oneHour, oneHour };
}

/** Every token of the prompt, cached or not — what Haiku's rate card is chosen by. */
export function promptTokens(usage: ExecUsage | null | undefined): number {
  const u = usage ?? {};
  return tokens(u.input_tokens) + tokens(u.cache_read_input_tokens) + cacheWriteSplit(u).total;
}

const warnedUnknownModels = new Set<string>();

/** Test seam: forget which unknown models were already warned about. */
export function __resetPricingWarningsForTests(): void {
  warnedUnknownModels.clear();
}

function priceCard(model: string): PriceCard {
  if (isPricedModel(model)) return PRICING[model];
  if (!warnedUnknownModels.has(model)) {
    warnedUnknownModels.add(model);
    console.warn(`[exec-llm] no price for model "${model}"; pricing it as ${OPUS_MODEL} so the cost cap errs high`);
  }
  return PRICING[OPUS_MODEL];
}

/** List-price cost in USD of one call's usage. Never negative; malformed counts count as 0. */
export function costUsd(model: string, usage: ExecUsage | null | undefined): number {
  const u = usage ?? {};
  const card = priceCard(model);
  const rates =
    card.longPrompt && promptTokens(u) > card.longPrompt.aboveTokens ? card.longPrompt.rates : card.base;
  const writes = cacheWriteSplit(u);
  const perMillion =
    tokens(u.input_tokens) * rates.input +
    tokens(u.output_tokens) * rates.output +
    tokens(u.cache_read_input_tokens) * rates.cacheRead +
    writes.fiveMinute * rates.cacheWrite5m +
    writes.oneHour * rates.cacheWrite1h;
  return perMillion / 1_000_000;
}

// Deliberately high. Typical English prose runs ~3.3–3.5 characters per token
// on the current tokenizer, code and URLs are denser, and non-Latin scripts
// and emoji can cost a token or more per character. Under-counting is the
// expensive mistake: it would let a "90K" Haiku chunk cross the 100K line into
// the 5x rate card. So: one token per 3 ASCII characters, plus one per
// non-ASCII code point.
const ASCII_CHARS_PER_TOKEN = 3;

/** Conservative token estimate for budgeting and chunking. Use count_tokens when precision matters. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) ascii++;
    // A low surrogate is the second half of a code point already counted.
    else if (code < 0xdc00 || code > 0xdfff) other++;
  }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN) + other;
}
