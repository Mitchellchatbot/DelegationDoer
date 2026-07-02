import Anthropic, { ClientOptions } from "@anthropic-ai/sdk";
import { getAnthropicKey, resetAnthropicKeyCache } from "./anthropic-key";

let client: Anthropic | null = null;
let pending: Promise<Anthropic> | null = null;

// The @anthropic-ai/sdk (v0.32.1) ships its own bundled `node-fetch`, and on
// Railway's Node runtime that transport premature-closes while reading the
// api.anthropic.com response body — every Anthropic call fails with
// "Invalid response body while trying to fetch ...: Premature close",
// regardless of payload size or streaming. Verified inside the production
// container: node-fetch fails 100%, while Node's built-in fetch (undici) with
// the same key on the same container/network succeeds 100% (single, parallel,
// and streaming). Handing the SDK the platform fetch makes it use undici.
// The SDK types `fetch` against node-fetch's signature; the platform fetch is
// runtime-compatible but nominally different, hence the cast.
const nativeFetch = ((input: unknown, init?: unknown) =>
  (globalThis.fetch as (i: unknown, n?: unknown) => Promise<Response>)(
    input,
    init
  )) as unknown as ClientOptions["fetch"];

export async function getAnthropic(): Promise<Anthropic> {
  if (client) return client;
  if (pending) return pending;
  pending = (async () => {
    const apiKey = await getAnthropicKey();
    client = new Anthropic({ apiKey, fetch: nativeFetch });
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
