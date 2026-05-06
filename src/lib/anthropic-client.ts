import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicKey } from "./anthropic-key";

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

// Model IDs in one place so they're easy to bump.
export const MODELS = {
  chat: "claude-sonnet-4-6" as const,
  classify: "claude-haiku-4-5-20251001" as const
};
