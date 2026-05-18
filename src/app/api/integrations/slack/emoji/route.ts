import { NextRequest, NextResponse } from "next/server";
import { requireCurrentUserId } from "@/lib/session";
import { listCustomEmojis } from "@/lib/slack";

export const dynamic = "force-dynamic";

// GET /api/integrations/slack/emoji — returns the workspace's custom
// emojis as { emojis: [{ name, url }] }. Used by the status-emoji
// picker (to render the palette) and by PersonAvatar (to resolve
// ":shortcode:" status values into image URLs for display).
//
// Cached in module scope for 5 minutes — emoji.list is small (~few
// KB) but Slack rate-limits it under tier 2, so we don't want to hit
// it every request. 5 min is short enough that a freshly-uploaded
// emoji shows up almost immediately, and the `?refresh=1` query
// param lets the picker's manual refresh button force a fresh pull
// when the user knows they just uploaded one.

interface CacheEntry {
  emojis: { name: string; url: string }[];
  fetchedAt: number;
}
const CACHE_TTL_MS = 5 * 60 * 1000;
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

export async function GET(req: NextRequest) {
  try {
    await requireCurrentUserId();
    if (!process.env.SLACK_BOT_TOKEN) {
      return NextResponse.json({ emojis: [], note: "SLACK_BOT_TOKEN not configured" });
    }
    // ?refresh=1 lets the picker's manual refresh button (or any
    // caller who knows the cache is stale) bypass the cache and
    // pull a fresh copy from Slack. Repopulates the shared cache as
    // a side effect, so the next caller also sees the fresh data.
    const wantsFresh = req.nextUrl.searchParams.get("refresh") === "1";
    if (!wantsFresh && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
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
