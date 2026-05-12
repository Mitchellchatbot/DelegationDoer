"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

// Org-wide presence cache. Mounted once at the (main) layout so any
// avatar in the app can read the freshest presence + status emoji for
// any user without each component running its own fetch + poll.

export type Presence = "available" | "focus" | "eating" | "away" | null;

export interface PresenceEntry {
  presence: Presence;
  statusEmoji: string | null;
  // Carry-along fields so consumers can avoid a second lookup just for
  // the name or avatar (e.g. when rendering a tooltip).
  name: string;
  avatarUrl: string | null;
}

interface PresenceContextValue {
  byId: Map<string, PresenceEntry>;
  // Current Employee of the Month — userId, or null when no one's
  // crowned for the current calendar month. Drives the crown overlay
  // on every PersonAvatar in the app.
  eomUserId: string | null;
  refresh: () => Promise<void>;
  loaded: boolean;
}

const PresenceContext = createContext<PresenceContextValue | null>(null);

export function PresenceProvider({ children }: { children: React.ReactNode }) {
  const [byId, setById] = useState<Map<string, PresenceEntry>>(new Map());
  const [eomUserId, setEomUserId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Track whether a load is already in flight so the visibility listener +
  // interval don't double up.
  const inflightRef = useRef(false);

  async function refresh() {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      // Fan out both reads — they're independent. EOM rarely changes,
      // so this is mostly for the avatar-crown overlay to stay live
      // after a Leader crowns someone.
      const [usersRes, eomRes] = await Promise.all([
        fetch("/api/users", { cache: "no-store" }),
        fetch("/api/eom", { cache: "no-store" })
      ]);
      if (usersRes.ok) {
        const data = await usersRes.json();
        const next = new Map<string, PresenceEntry>();
        for (const u of (data.users ?? []) as {
          id: string;
          name: string;
          avatarUrl: string | null;
          presence: Presence;
          statusEmoji: string | null;
        }[]) {
          next.set(u.id, {
            presence: u.presence,
            statusEmoji: u.statusEmoji,
            name: u.name,
            avatarUrl: u.avatarUrl
          });
        }
        setById(next);
      }
      if (eomRes.ok) {
        const data = await eomRes.json();
        setEomUserId(data.eom?.userId ?? null);
      }
      setLoaded(true);
    } catch { /* ignore */ } finally {
      inflightRef.current = false;
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 15_000);
    const onVis = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const value = useMemo<PresenceContextValue>(
    () => ({ byId, eomUserId, refresh, loaded }),
    [byId, eomUserId, loaded]
  );
  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

// Read the current EOM userId from anywhere in the tree. Returns null
// when no one's crowned (or the provider isn't mounted yet).
export function useEomUserId(): string | null {
  const ctx = useContext(PresenceContext);
  return ctx?.eomUserId ?? null;
}

// Read presence + emoji for a single user. Returns null when the
// provider hasn't loaded yet OR the user isn't in the cache.
export function usePresence(userId: string | null | undefined): PresenceEntry | null {
  const ctx = useContext(PresenceContext);
  if (!ctx || !userId) return null;
  return ctx.byId.get(userId) ?? null;
}

// Force a refresh from anywhere (useful after a presence/emoji write so
// the rest of the app reflects the new value before the next poll).
export function useRefreshPresence() {
  const ctx = useContext(PresenceContext);
  return ctx?.refresh ?? (async () => {});
}
