"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { SodFlow } from "@/components/SodFlow";

// Mounts the SOD flow whenever the user is eligible — within their
// shift window, and hasn't yet filed SOD for today. Re-checks on every
// pathname change so that dismissing the modal re-pops it on the next
// navigation (per spec: a worker shouldn't be able to skip the SOD
// indefinitely just by clicking X).
//
// Suppressed on /updates/sod itself — that page renders the same flow
// with its own "Start your day" button, so popping on top would be
// confusing.
export function SodGate() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [dismissedAt, setDismissedAt] = useState<number>(0);

  useEffect(() => {
    // Don't auto-pop on the SOD page itself.
    if (pathname?.startsWith("/updates/sod")) return;
    // A 30-second cooldown after dismissal prevents the modal from
    // popping immediately when the user navigates right after closing
    // it. They'll still see it again on the next navigation past 30s,
    // which matches the "re-pop until submitted" spec without being
    // hostile to a quick "let me grab something real fast" closure.
    if (Date.now() - dismissedAt < 30_000) return;

    let cancelled = false;
    fetch("/api/sod/today", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        if (d.eligible) setOpen(true);
      })
      .catch(() => { /* silent — fallback to manual entry */ });
    return () => { cancelled = true; };
  }, [pathname, dismissedAt]);

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
