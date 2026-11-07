// Test support for Area B (P5b chat tools): one helper for vi.mock factories.
// Every function export of the real module becomes a bare vi.fn(); classes
// (the error types the executor maps with instanceof) and constants stay real,
// and `keep` names pure functions to keep real too (the screens, the bucket
// rule). Use it as
//   vi.mock("@/lib/exec/sources/dd", async (orig) => (await import("./__tests__/b-stub")).stubModule(await orig()));
// This file imports nothing it mocks, so a factory can load it safely.

import { vi } from "vitest";

const isClass = (v: unknown) => typeof v === "function" && /^class[\s{]/.test(Function.prototype.toString.call(v));

export function stubModule<T extends object>(real: T, keep: readonly string[] = []): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(real as Record<string, unknown>)) {
    out[key] = typeof value === "function" && !isClass(value) && !keep.includes(key) ? vi.fn() : value;
  }
  return out as T;
}

/** The real module with only `names` replaced by bare vi.fn()s (for modules whose pure helpers call each other). */
export function stubOnly<T extends object>(real: T, names: readonly string[]): T {
  const out: Record<string, unknown> = { ...(real as Record<string, unknown>) };
  for (const name of names) {
    if (typeof out[name] !== "function") throw new Error(`stubOnly: ${name} is not a function export`);
    out[name] = vi.fn();
  }
  return out as T;
}
