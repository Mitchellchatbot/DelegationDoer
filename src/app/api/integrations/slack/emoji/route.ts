import { NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { listCustomEmojis } from "@/lib/slack";

export const dynamic = "force-dynamic";

// GET /api/integrations/slack/emoji — returns the workspace's custom
// emojis as { emojis: [{ name, url }] }. Used by the status-emoji
// picker (to render the palette) and by PersonAvatar (to resolve
// ":shortcode:" status values into image URLs for display).
//
// Cached in module scope for an hour — emoji.list is small (~few KB)
// but Slack rate-limits it under tier 2, and the data rarely changes.

interface CacheEntry {
  emojis: { name: string; url: string }[];
  fetchedAt: number;
}
const CACHE_TTL_MS = 60 * 60 * 1000;
let cache: CacheEntry | null = null;
let pending: Promise<CacheEntry> | null = null;

async function fetchAndCache(): Promise<CacheEntry> {
  if (pending) return pending;
  pending = (async () => {
    const map = await listCustomEmojis();
    const emojis = Object.entries(map)
      .map(([name, url]) => ({ name, url }))
      .sort((a, b) => a.name.localeCompare(b.name));
    cache = { emojis, fetchedAt: Date.now() };
    return cache;
  })();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}

export async function GET() {
  try {
    await requireCurrentUserId();
    if (!process.env.SLACK_BOT_TOKEN) {
      return NextResponse.json({ emojis: [], note: "SLACK_BOT_TOKEN not configured" });
    }
    if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
      return NextResponse.json({ emojis: cache.emojis });
    }
    const fresh = await fetchAndCache();
    return NextResponse.json({ emojis: fresh.emojis });
  } catch (err) {
    return NextResponse.json(
      { emojis: [], error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 }
    );
  }
}
