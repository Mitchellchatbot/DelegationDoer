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
  refresh: () => Promise<void>;
  loaded: boolean;
}

const PresenceContext = createContext<PresenceContextValue | null>(null);

export function PresenceProvider({ children }: { children: React.ReactNode }) {
  const [byId, setById] = useState<Map<string, PresenceEntry>>(new Map());
  const [loaded, setLoaded] = useState(false);
  // Track whether a load is already in flight so the visibility listener +
  // interval don't double up.
  const inflightRef = useRef(false);

  async function refresh() {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const res = await fetch("/api/users", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
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

  const value = useMemo<PresenceContextValue>(() => ({ byId, refresh, loaded }), [byId, loaded]);
  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
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
