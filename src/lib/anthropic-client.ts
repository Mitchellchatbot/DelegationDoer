import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicKey, resetAnthropicKeyCache } from "./anthropic-key";

let client: Anthropic | null = null;
let pending: Promise<Anthropic> | null = null;

export async function getAnthropic(): Promise<Anthropic> {
  if (client) return client;
  if (pending) return pending;
  pending = (async () => {
    const apiKey = await getAnthropicKey();
    client = new Anthropic({ apiKey });
    return client;
  })();
  try {
    return await pending;
  } catch (err) {
    pending = null;
    throw err;
  }
}

// Drop the cached client AND its cached API key so the next getAnthropic()
// rebuilds from a freshly-read key. Call this after an auth (401) failure —
// the client caches the key it was built with, so resetting the key cache
// alone isn't enough; the stale client has to go too. Because both caches
// are module-global, one caller resetting after a 401 heals every Claude
// surface (chat, classify, drafts, scoring) on its next call.
export function resetAnthropic(): void {
  client = null;
  pending = null;
  resetAnthropicKeyCache();
}

// Model IDs in one place so they're easy to bump.
export const MODELS = {
  chat: "claude-sonnet-4-6" as const,
  classify: "claude-haiku-4-5-20251001" as const
};
