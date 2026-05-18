"use client";

// Shared client-side cache for the workspace's Slack custom emojis
// ({:shortcode: → image URL} map). Fetched lazily on first call to
// useSlackCustomEmojis(), then shared across every component that
// asks for it. Refreshed in the background every 10 min so newly-
// uploaded emojis show up without a hard refresh.
//
// The cache is module-scoped so it survives mount/unmount of
// individual components — every avatar in the app benefits from a
// single fetch.

import { useEffect, useState } from "react";

interface EmojiMap { [name: string]: string }

const REFRESH_MS = 10 * 60 * 1000;
let cache: EmojiMap | null = null;
let pending: Promise<EmojiMap> | null = null;
let fetchedAt = 0;
// Each subscribed hook keeps a setter; we fan-out updates so already-
// mounted avatars re-render when the map first arrives.
const subscribers = new Set<(m: EmojiMap) => void>();

async function fetchOnce(): Promise<EmojiMap> {
  if (pending) return pending;
  pending = (async () => {
    try {
      const res = await fetch("/api/integrations/slack/emoji", { cache: "no-store" });
      const data = await res.json();
      const next: EmojiMap = {};
      for (const e of (data?.emojis ?? []) as Array<{ name: string; url: string }>) {
        next[e.name] = e.url;
      }
      cache = next;
      fetchedAt = Date.now();
      subscribers.forEach((cb) => cb(next));
      return next;
    } catch {
      // Network error — fall back to empty map so shortcodes render
      // as their literal text rather than blank. Will retry on the
      // next subscriber.
      const empty: EmojiMap = {};
      cache = empty;
      fetchedAt = Date.now();
      return empty;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

export function useSlackCustomEmojis(): EmojiMap {
  const [map, setMap] = useState<EmojiMap>(() => cache ?? {});

  useEffect(() => {
    subscribers.add(setMap);
    // Kick off the first fetch — or a refresh if cache is stale.
    if (!cache || Date.now() - fetchedAt > REFRESH_MS) {
      void fetchOnce();
    }
    return () => {
      subscribers.delete(setMap);
    };
  }, []);

  return map;
}

// Pure helper for non-React callers (or for components that already
// have the map from useSlackCustomEmojis).
export function resolveEmoji(value: string | null | undefined, map: EmojiMap): string | null {
  if (!value) return null;
  // ":foo:" → look up "foo" in the map; otherwise pass through.
  const m = /^:([a-z0-9_+-]+):$/i.exec(value);
  if (m) {
    const url = map[m[1]];
    return url ?? value; // fall back to raw shortcode if not found
  }
  return value;
}
