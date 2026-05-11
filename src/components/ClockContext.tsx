"use client";

// Shared client-side clock state for the main web app. Mirrors the
// ClockProvider in the widget (src/app/widget/page.tsx) but lives in a
// component file so it can wrap layout-level children. Both write to the
// same /api/clock endpoint, so the widget and the website stay in sync
// across polls and broadcasts.

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { toast } from "sonner";

interface OpenSegment {
  id: string;
  startedAt: string;
  taskId: string | null;
}

export interface ClockState {
  open: OpenSegment | null;
  todayMs: number;
  dailyCapacityHours: number;
  workdayRemainingMs: number;
  hoursByTask: Record<string, number>;
}

export interface ClockApi {
  clock: ClockState;
  refresh: () => Promise<void>;
  toggleShift: () => Promise<void>;
  startTask: (taskId: string) => Promise<void>;
  stopTask: (taskId: string) => Promise<void>;
  // Increments every second while a shift is open so consumers can
  // re-render the live timer.
  tick: number;
}

const ClockContext = createContext<ClockApi | null>(null);

const DEFAULT_STATE: ClockState = {
  open: null,
  todayMs: 0,
  dailyCapacityHours: 8,
  workdayRemainingMs: 8 * 3_600_000,
  hoursByTask: {}
};

export function ClockProvider({ children }: { children: React.ReactNode }) {
  const [clock, setClock] = useState<ClockState>(DEFAULT_STATE);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/clock", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setClock({
        open: data.open ?? null,
        todayMs: Number(data.todayMs ?? 0),
        dailyCapacityHours: Number(data.dailyCapacityHours ?? 8),
        workdayRemainingMs: Number(data.workdayRemainingMs ?? 0),
        hoursByTask: (data.hoursByTask as Record<string, number>) ?? {}
      });
    } catch { /* ignore — next poll will retry */ }
  }, []);

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 15_000);
    return () => clearInterval(poll);
  }, [refresh]);

  useEffect(() => {
    if (!clock.open) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [clock.open]);

  const toggleShift = useCallback(async () => {
    const prev = clock;
    const isOn = Boolean(prev.open);
    setClock((c) => ({
      ...c,
      open: isOn
        ? null
        : { id: `tmp_${Date.now().toString(36)}`, startedAt: new Date().toISOString(), taskId: null }
    }));
    try {
      const res = await fetch("/api/clock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: isOn ? "out" : "in" })
      });
      if (!res.ok) throw new Error(`failed (${res.status})`);
      await refresh();
    } catch {
      setClock(prev);
      toast.error("Clock toggle failed");
    }
  }, [clock, refresh]);

  const startTask = useCallback(async (taskId: string) => {
    const prev = clock;
    setClock((c) => ({
      ...c,
      open: { id: `tmp_${Date.now().toString(36)}`, startedAt: new Date().toISOString(), taskId }
    }));
    try {
      const res = await fetch(`/api/tasks/${taskId}/timer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" })
      });
      if (!res.ok) throw new Error(`failed (${res.status})`);
      await refresh();
    } catch {
      setClock(prev);
      toast.error("Couldn't start timer");
    }
  }, [clock, refresh]);

  const stopTask = useCallback(async (taskId: string) => {
    const prev = clock;
    setClock((c) => ({
      ...c,
      open: c.open && c.open.taskId === taskId
        ? { id: c.open.id, startedAt: new Date().toISOString(), taskId: null }
        : c.open
    }));
    try {
      const res = await fetch(`/api/tasks/${taskId}/timer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" })
      });
      if (!res.ok) throw new Error(`failed (${res.status})`);
      await refresh();
    } catch {
      setClock(prev);
      toast.error("Couldn't stop timer");
    }
  }, [clock, refresh]);

  return (
    <ClockContext.Provider value={{ clock, refresh, toggleShift, startTask, stopTask, tick }}>
      {children}
    </ClockContext.Provider>
  );
}

export function useClock(): ClockApi {
  const v = useContext(ClockContext);
  if (!v) throw new Error("useClock used outside <ClockProvider>");
  return v;
}
