"use client";

import { useState } from "react";
import { Clock, Lock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useClock } from "./ClockContext";
import { useCurrentUser } from "@/lib/user-context";

// Wraps a task surface (My Tasks / Board / etc.) with a clock-in gate.
// People who need to clock in (workers + dept_heads, NOT leaders or
// stealth admins) can't see the children until they've started a
// shift via the topbar / widget / this CTA.
//
// Leaders + admins pass through transparently — they manage the team
// and don't have a personal clock to honor.

export function ClockGate({
  children,
  fallbackSubtitle
}: {
  children: React.ReactNode;
  // Optional override on the gated-state subtitle so each surface can
  // explain *what's behind* the lock ("Clock in to see your tasks",
  // "Clock in to add a new task", etc.).
  fallbackSubtitle?: string;
}) {
  const me = useCurrentUser();
  const { clock, toggleShift } = useClock();
  const [busy, setBusy] = useState(false);

  // Who needs the gate?
  //   - Leaders never (they're managers, not on a clock)
  //   - Stealth admins never (same — they're building / overseeing)
  //   - Clock-disabled (salaried/on-call) users never — they have no
  //     clock UI to satisfy the gate with
  //   - Everyone else gets gated until they've clocked in
  const exempt = me.role === "leader" || me.isAdmin === true || me.clockEnabled === false;
  if (exempt || clock.open) return <>{children}</>;

  async function clockIn() {
    if (busy) return;
    setBusy(true);
    try {
      await toggleShift();
      toast.success("Clocked in — have a good day");
    } catch {
      toast.error("Couldn't clock in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-10 max-w-xl mx-auto mt-6 text-center space-y-4">
      <div className="w-14 h-14 rounded-2xl bg-amber-100 text-amber-700 grid place-items-center mx-auto">
        <Lock className="w-7 h-7" />
      </div>
      <div className="space-y-1">
        <h2 className="text-xl font-semibold text-ink">Clock in to start your day</h2>
        <p className="text-sm text-ink/65 max-w-sm mx-auto">
          {fallbackSubtitle ?? "Your tasks unlock once you've clocked in. Tap below to start the shift; you can clock out from the topbar or widget anytime."}
        </p>
      </div>
      <button
        type="button"
        onClick={clockIn}
        disabled={busy}
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold text-white shadow-[0_8px_18px_-6px_rgba(16,185,129,0.55)] transition-all hover:-translate-y-0.5 active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0"
        style={{ background: "linear-gradient(135deg, #10b981 0%, #059669 100%)" }}
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Clock className="w-4 h-4" />}
        {busy ? "Clocking in…" : "Clock in"}
      </button>
    </div>
  );
}

// Quick read-only check — used by surfaces that want to enable/disable
// a button without showing the full gate UI (e.g. the topbar "New
// task" button). Returns true when this caller must clock in first.
export function useNeedsClockIn(): boolean {
  const me = useCurrentUser();
  const { clock } = useClock();
  const exempt = me.role === "leader" || me.isAdmin === true || me.clockEnabled === false;
  if (exempt) return false;
  return !clock.open;
}
