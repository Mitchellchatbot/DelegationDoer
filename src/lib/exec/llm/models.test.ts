import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EXEC_MODELS,
  FEATURE_EFFORT,
  FEATURE_MAX_TOKENS,
  HAIKU_MAX_PROMPT_TOKENS,
  HAIKU_MODEL,
  OPUS_MODEL,
  PRICING,
  __resetPricingWarningsForTests,
  cacheWriteSplit,
  costUsd,
  estimateTokens,
  isPricedModel,
  promptTokens
} from "@/lib/exec/llm/models";

afterEach(() => {
  __resetPricingWarningsForTests();
});

describe("feature tables", () => {
  it("maps every feature to the contracted model, effort and output cap", () => {
    expect(EXEC_MODELS).toEqual({
      chat: "claude-opus-5-5",
      draft: "claude-opus-5-5",
      brief: "claude-opus-5-5",
      voice: "claude-haiku-5-5",
      spike: "claude-opus-5-5",
      triage: "claude-haiku-5-5",
      digest: "claude-haiku-5-5",
      ddtext: "claude-haiku-5-5",
      // P7a stage -1 (contract §3.20.1): Slack triage.
      slack_triage: "claude-haiku-5-5",
      // P8 stage 0 (contract §3.21.1, p8-bindings.md): the brief's check-in notes.
      checkin: "claude-opus-5-5"
    });
    expect(FEATURE_EFFORT).toEqual({
      triage: "low",
      digest: "low",
      spike: "low",
      chat: "medium",
      draft: "medium",
      voice: "low",
      ddtext: "low",
      slack_triage: "low",
      brief: "high",
      checkin: "medium"
    });
    expect(FEATURE_MAX_TOKENS).toEqual({
      chat: 16000,
      draft: 16000,
      brief: 32000,
      voice: 4000,
      triage: 4000,
      digest: 4000,
      spike: 4000,
      ddtext: 4000,
      slack_triage: 4000,
      checkin: 4000
    });
    expect(HAIKU_MAX_PROMPT_TOKENS).toBe(90_000);
  });

  // P5a test 64 (§3.12.1): every feature has all three, and DD text triage is Haiku, effort low, 4,000 tokens.
  it("gives every feature a model, an effort and an output cap; ddtext is Haiku / low / 4000", () => {
    const features = Object.keys(EXEC_MODELS).sort();
    expect(Object.keys(FEATURE_EFFORT).sort()).toEqual(features);
    expect(Object.keys(FEATURE_MAX_TOKENS).sort()).toEqual(features);
    for (const f of features as (keyof typeof EXEC_MODELS)[]) {
      expect(isPricedModel(EXEC_MODELS[f])).toBe(true);
      expect(["low", "medium", "high", "xhigh", "max"]).toContain(FEATURE_EFFORT[f]);
      expect(Number.isSafeInteger(FEATURE_MAX_TOKENS[f]) && FEATURE_MAX_TOKENS[f] > 0).toBe(true);
    }
    expect(features).toContain("ddtext");
    expect([EXEC_MODELS.ddtext, FEATURE_EFFORT.ddtext, FEATURE_MAX_TOKENS.ddtext]).toEqual([HAIKU_MODEL, "low", 4000]);
  });

  it("is frozen, so no caller can repoint a feature at runtime", () => {
    expect(Object.isFrozen(EXEC_MODELS)).toBe(true);
    expect(Object.isFrozen(FEATURE_EFFORT)).toBe(true);
    expect(Object.isFrozen(FEATURE_MAX_TOKENS)).toBe(true);
    expect(Object.isFrozen(PRICING)).toBe(true);
  });

  it("carries the list prices from the API reference", () => {
    expect(PRICING[OPUS_MODEL]).toEqual({
      base: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 }
    });
    const haiku = PRICING[HAIKU_MODEL];
    expect(haiku.base.input).toBe(0.1);
    expect(haiku.base.output).toBe(0.5);
    expect(haiku.longPrompt?.aboveTokens).toBe(100_000);
    expect(haiku.longPrompt?.rates.input).toBe(0.5);
    expect(haiku.longPrompt?.rates.output).toBe(2.5);
    // Cache multipliers: read 0.1x, 5-minute write 1.25x, 1-hour write 2x — on both cards.
    for (const r of [haiku.base, haiku.longPrompt!.rates]) {
      expect(r.cacheRead).toBeCloseTo(r.input * 0.1, 12);
      expect(r.cacheWrite5m).toBeCloseTo(r.input * 1.25, 12);
      expect(r.cacheWrite1h).toBeCloseTo(r.input * 2, 12);
    }
  });

  it("knows which models it can price, ignoring prototype keys", () => {
    expect(isPricedModel(OPUS_MODEL)).toBe(true);
    expect(isPricedModel(HAIKU_MODEL)).toBe(true);
    expect(isPricedModel("claude-opus-5")).toBe(false);
    expect(isPricedModel("constructor")).toBe(false);
    expect(isPricedModel("toString")).toBe(false);
  });
});

describe("cacheWriteSplit / promptTokens", () => {
  it("prices a write with no TTL split at the 5-minute rate", () => {
    expect(cacheWriteSplit({ cache_creation_input_tokens: 3000 })).toEqual({ total: 3000, fiveMinute: 3000, oneHour: 0 });
  });

  it("uses the TTL split when present", () => {
    expect(
      cacheWriteSplit({
        cache_creation_input_tokens: 3000,
        cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 }
      })
    ).toEqual({ total: 3000, fiveMinute: 1000, oneHour: 2000 });
  });

  it("puts tokens the split doesn't account for on the 5-minute rate", () => {
    expect(
      cacheWriteSplit({ cache_creation_input_tokens: 3000, cache_creation: { ephemeral_1h_input_tokens: 2000 } })
    ).toEqual({ total: 3000, fiveMinute: 1000, oneHour: 2000 });
  });

  it("trusts a split larger than a missing or smaller total", () => {
    expect(
      cacheWriteSplit({ cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 50 } })
    ).toEqual({ total: 150, fiveMinute: 100, oneHour: 50 });
    expect(
      cacheWriteSplit({ cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 50 } })
    ).toEqual({ total: 50, fiveMinute: 0, oneHour: 50 });
  });

  it("counts every prompt token: input + cache read + cache write", () => {
    expect(
      promptTokens({ input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 999 })
    ).toBe(60);
    expect(promptTokens(null)).toBe(0);
  });
});

describe("costUsd", () => {
  it("prices plain Opus input and output", () => {
    // 1000 * $4/M + 500 * $20/M
    expect(costUsd(OPUS_MODEL, { input_tokens: 1000, output_tokens: 500 })).toBeCloseTo(0.004 + 0.01, 12);
  });

  it("prices Opus cache reads and both write TTLs", () => {
    const cost = costUsd(OPUS_MODEL, {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 20_000,
      cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 }
    });
    // 1000*4 + 500*20 + 20000*0.2 + 1000*5 + 2000*8 = 39000 per million
    expect(cost).toBeCloseTo(0.039, 12);
  });

  it("prices an un-split Opus cache write at the 5-minute rate", () => {
    expect(costUsd(OPUS_MODEL, { cache_creation_input_tokens: 3000 })).toBeCloseTo(0.015, 12);
  });

  it("prices Haiku on the base card at or under 100K prompt tokens", () => {
    expect(costUsd(HAIKU_MODEL, { input_tokens: 10_000, output_tokens: 1000 })).toBeCloseTo(0.001 + 0.0005, 12);
    // Exactly 100K is still the base card ("100K tokens or fewer").
    expect(costUsd(HAIKU_MODEL, { input_tokens: 100_000, output_tokens: 1000 })).toBeCloseTo(0.01 + 0.0005, 12);
  });

  it("moves the WHOLE Haiku request to the long-prompt card past 100K prompt tokens", () => {
    // 100,001 input: input and output both at the higher rates.
    expect(costUsd(HAIKU_MODEL, { input_tokens: 100_001, output_tokens: 1000 })).toBeCloseTo(
      (100_001 * 0.5 + 1000 * 2.5) / 1e6,
      12
    );
  });

  it("chooses the Haiku card by input + cache read + cache write, not input alone", () => {
    const usage = {
      input_tokens: 10_000,
      output_tokens: 1000,
      cache_read_input_tokens: 85_000,
      cache_creation_input_tokens: 6000,
      cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 2000 }
    };
    // 101K prompt tokens → long card: 10000*0.5 + 1000*2.5 + 85000*0.05 + 4000*0.625 + 2000*1
    expect(costUsd(HAIKU_MODEL, usage)).toBeCloseTo((5000 + 2500 + 4250 + 2500 + 2000) / 1e6, 12);
    // The same call with a smaller cache read stays on the base card.
    expect(costUsd(HAIKU_MODEL, { ...usage, cache_read_input_tokens: 80_000 })).toBeCloseTo(
      (10_000 * 0.1 + 1000 * 0.5 + 80_000 * 0.01 + 4000 * 0.125 + 2000 * 0.2) / 1e6,
      12
    );
  });

  it("prices an unknown model as Opus and warns once per model", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const usage = { input_tokens: 1000, output_tokens: 500 };
    expect(costUsd("claude-mystery-9", usage)).toBeCloseTo(costUsd(OPUS_MODEL, usage), 12);
    expect(costUsd("claude-mystery-9", usage)).toBeCloseTo(costUsd(OPUS_MODEL, usage), 12);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("claude-mystery-9");
    costUsd("claude-other-model", usage);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("treats missing, negative, NaN and non-numeric counts as zero", () => {
    expect(costUsd(OPUS_MODEL, null)).toBe(0);
    expect(costUsd(OPUS_MODEL, undefined)).toBe(0);
    expect(costUsd(OPUS_MODEL, {})).toBe(0);
    expect(
      costUsd(OPUS_MODEL, {
        input_tokens: -5,
        output_tokens: Number.NaN,
        cache_read_input_tokens: Number.POSITIVE_INFINITY,
        cache_creation_input_tokens: null,
        cache_creation: null
      })
    ).toBe(0);
    expect(costUsd(OPUS_MODEL, { input_tokens: "1000" as unknown as number })).toBe(0);
  });
});

describe("estimateTokens", () => {
  it("is zero for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("counts one token per 3 ASCII characters, rounding up", () => {
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("x".repeat(300))).toBe(100);
  });

  it("is never below the chars/3.5 rule of thumb for ASCII", () => {
    for (const n of [1, 7, 35, 350, 3501, 90_000]) {
      expect(estimateTokens("a".repeat(n))).toBeGreaterThanOrEqual(Math.ceil(n / 3.5));
    }
  });

  it("counts each non-ASCII code point as a token, an emoji (surrogate pair) once", () => {
    expect(estimateTokens("é")).toBe(1);
    expect(estimateTokens("日本語")).toBe(3);
    expect(estimateTokens("😀")).toBe(1);
    // "h","i"," "," "," ","o","k" are ASCII (7 → 3 tokens); the emoji and the dash add one each.
    expect(estimateTokens("hi 😀 — ok")).toBe(Math.ceil(7 / 3) + 2);
  });
});
