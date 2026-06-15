"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { SodFlow } from "@/components/SodFlow";
import { useClock } from "@/components/ClockContext";

// Mounts the SOD flow whenever the user is eligible — within their
// shift window, and hasn't yet filed SOD for today. Re-checks on every
// pathname change so that dismissing the modal re-pops it on the next
// navigation (per spec: a worker shouldn't be able to skip the SOD
// indefinitely just by clicking X), and immediately when the user
// clocks in (a strong "I'm starting my day" signal).
//
// Suppressed on /sod itself (and the legacy /updates/sod redirect path)
// — that page renders the same flow with its own "Start your day"
// button, so popping on top would be confusing.
export function SodGate() {
  const pathname = usePathname();
  const { clock } = useClock();
  const [open, setOpen] = useState(false);
  const [dismissedAt, setDismissedAt] = useState<number>(0);
  // Tracks the previous clock state so we can detect a fresh clock-in
  // (a false -> true transition) versus merely being already on shift.
  const prevClockedIn = useRef(false);

  useEffect(() => {
    const clockedIn = !!clock.open;
    const justClockedIn = clockedIn && !prevClockedIn.current;
    prevClockedIn.current = clockedIn;

    // Don't auto-pop on the SOD page itself. Both the canonical /sod
    // route and the legacy /updates/sod redirect path are guarded so
    // the modal doesn't briefly flash during the bounce.
    if (pathname?.startsWith("/sod") || pathname?.startsWith("/updates/sod")) return;
    // A 30-second cooldown after dismissal prevents the modal from
    // popping immediately when the user navigates right after closing
    // it. They'll still see it again on the next navigation past 30s,
    // which matches the "re-pop until submitted" spec without being
    // hostile to a quick "let me grab something real fast" closure.
    // A fresh clock-in bypasses the cooldown: starting the shift is an
    // explicit intent to begin the day, so SOD should pop right then.
    if (!justClockedIn && Date.now() - dismissedAt < 30_000) return;

    let cancelled = false;
    fetch("/api/sod/today", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        // Hold off while first-run profile onboarding is still open — the
        // two modals stack and deadlock (the onboarding Radix dialog locks
        // pointer events on this overlay). SOD pops once they're onboarded.
        if (d.eligible && !d.onboardingPending) setOpen(true);
      })
      .catch(() => { /* silent — fallback to manual entry */ });
    return () => { cancelled = true; };
  }, [pathname, dismissedAt, clock.open]);

  return (
    <SodFlow
      open={open}
      onClose={() => {
        setOpen(false);
        setDismissedAt(Date.now());
      }}
      onComplete={() => {
        // Server-side state will now report alreadySubmitted=true, so
        // the next mount/pathname check won't re-pop.
        setOpen(false);
      }}
    />
  );
}
